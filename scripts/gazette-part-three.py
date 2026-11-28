#!/usr/bin/env python3
"""Archive the newest bilingual Canada Gazette Part III issue and its Act citations."""

import argparse
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lib.html_tree import tree
from lib.parliament_intake import archive_inventory


COLLECTION = "gazette-part-three"
GAZETTE = "https://gazette.gc.ca"
GAZETTE_PATTERN = re.escape(GAZETTE)
JUSTICE = "laws-lois.justice.gc.ca"
LANGUAGES = {"en": "eng", "fr": "fra"}
PART = {"en": "Part III", "fr": "Partie III"}
CATALOGUE = {lang: f"{GAZETTE}/rp-pr/publications-{code}.html" for lang, code in LANGUAGES.items()}
ANNUAL_PATH = {"en": "/eng/AnnualStatutes/", "fr": "/fra/LoisAnnuelles/"}
CITATION = {"en": r"S\.C\.\s+(\d{4}),\s+c\.\s*([1-9]\d*)",
            "fr": r"L\.C\.\s+(\d{4}),\s+ch\.\s*([1-9]\d*)"}
EN_MONTHS = "January February March April May June July August September October November December".split()
FR_MONTHS = "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split()
MAX_HTML_BYTES = 2 * 1024**2
MAX_PDF_BYTES = 24 * 1024**2
MAX_COVER_BYTES = 256 * 1024
MAX_CHAPTERS = 500


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def volume_identity(url, language):
    return re.fullmatch(rf"{GAZETTE_PATTERN}/rp-pr/p3/(\d{{4}})/index-{LANGUAGES[language]}\.html", url)


def pdf_identity(url):
    return re.fullmatch(rf"{GAZETTE_PATTERN}/rp-pr/p3/(\d{{4}})/g3-(\d{{3}})(\d{{2}})\.pdf", url)


def source_kind(url):
    if url in CATALOGUE.values() or any(volume_identity(url, language) for language in LANGUAGES):
        return "text/html", MAX_HTML_BYTES
    if pdf_identity(url):
        return "application/pdf", MAX_PDF_BYTES
    raise ValueError(f"Unrecognized Canada Gazette Part III source URL: {url}")


def fetch_url(url):
    media, limit = source_kind(url)
    request = Request(url, headers={"Accept": media, "User-Agent": "CivicSignal Canada Gazette intake/1.0"})
    with build_opener(NoRedirect()).open(request, timeout=30) as response:
        if response.status != 200 or response.headers.get_content_type() != media:
            raise ValueError(f"Unexpected Canada Gazette response from {url}")
        body = response.read(limit + 1)
    if not 0 < len(body) <= limit:
        raise ValueError(f"Canada Gazette response exceeds its size bound or is empty: {url}")
    return body


def main_content(body, language):
    if not 0 < len(body) <= MAX_HTML_BYTES:
        raise ValueError("Canada Gazette HTML is empty or exceeds its size bound")
    root = tree(body.decode("utf-8-sig"))
    html = root.find(lambda node: node.tag == "html")
    main = root.find(lambda node: node.tag == "main")
    if not html or html.attrs.get("lang", "").split("-", 1)[0] != language or not main:
        raise ValueError(f"Missing {language} Canada Gazette publication content")
    return main


def find_links(node):
    return node.findall(lambda item: item.tag == "a" and item.attrs.get("href"))


def latest_volume(body, language):
    main = main_content(body, language)
    marker = main.find(lambda node: node.tag == "h2" and node.attrs.get("id") == "a3")
    if marker is None or marker.text() != PART[language] or marker.parent.parent.tag != "details":
        raise ValueError(f"Missing Part III publication catalogue in {language}")
    volumes = {}
    for link in find_links(marker.parent.parent):
        url = urljoin(CATALOGUE[language], link.attrs["href"])
        match = volume_identity(url, language)
        label = re.fullmatch(rf"(\d{{4}})\s*:.*\b{PART[language]}\b\s*:\s*Volume\s+([1-9]\d*)",
                             link.text(), re.I)
        if match is None or label is None or label[1] != match[1]:
            raise ValueError(f"Invalid Part III volume link: {url}")
        year, volume = int(label[1]), int(label[2])
        if year in volumes:
            raise ValueError(f"Duplicate Canada Gazette Part III volume for {year}")
        volumes[year] = volume, url
    if not volumes:
        raise ValueError(f"No Part III volumes in the {language} catalogue")
    year = max(volumes)
    volume, url = volumes[year]
    return year, volume, url


def act_records(cell, language):
    records = {}
    for link in find_links(cell):
        url = link.attrs["href"]
        parts = urlsplit(url)
        path = re.fullmatch(rf"{ANNUAL_PATH[language]}(\d{{4}})_([1-9]\d*)(?:/|/index\.html)?", parts.path, re.I)
        title = re.fullmatch(rf"(.+)\s+\(({CITATION[language]})\)", link.text(), re.I)
        if (parts.scheme != "https" or parts.netloc != JUSTICE or parts.query or parts.fragment or not path or not title
                or path.groups() != title.groups()[2:]):
            raise ValueError(f"Invalid Justice Laws chapter citation: {url}")
        key = int(path[1]), int(path[2])
        if key in records:
            raise ValueError(f"Duplicate Canada Gazette Part III chapter: {key}")
        records[key] = {"title": title[1], "citation": title[2], "justiceUrl": url}
    if not 0 < len(records) <= MAX_CHAPTERS:
        raise ValueError("Part III issue has an empty or oversized chapter list")
    return records


def volume_issues(body, language, source):
    year, volume, url = source
    main = main_content(body, language)
    heading = main.find(lambda node: node.tag == "h1")
    caption = main.find(lambda node: node.tag == "caption" and node.attrs.get("id") == "a01")
    if (not heading or not re.search(rf"\b{PART[language]}\s*:\s*Volume\s+{volume}$", heading.text(), re.I)
            or not caption or not caption.text().startswith(PART[language]) or caption.parent.tag != "table"):
        raise ValueError(f"Missing official Part III volume {volume} in {language}")
    table_body = caption.parent.find(lambda node: node.tag == "tbody")
    if not table_body:
        raise ValueError(f"Missing Part III issue table in {language}")
    issues = {}
    for row in table_body.children:
        cells = [cell for cell in row.children if cell.tag == "td"]
        if row.tag != "tr" or len(cells) != 3:
            raise ValueError(f"Unrecognized Part III issue row in {language}")
        day = date.fromisoformat(cells[0].attrs["data-order"]).isoformat()
        links = find_links(cells[2])
        pdf_url = urljoin(url, links[0].attrs["href"]) if len(links) == 1 else ""
        pdf = pdf_identity(pdf_url)
        if not pdf or (int(pdf[1]), int(pdf[2])) != (year, volume) or int(pdf[3]) == 0:
            raise ValueError(f"Invalid Part III issue PDF link in {language}: {pdf_url}")
        number = int(pdf[3])
        if number in issues:
            raise ValueError(f"Duplicate Part III issue in {language}: {number}")
        issues[number] = {"date": day, "pdfUrl": pdf_url, "acts": act_records(cells[1], language)}
    if not issues:
        raise ValueError(f"No Part III issues listed for volume {volume} in {language}")
    return issues


def extract_cover(pdf):
    result = subprocess.run(["pdftotext", "-f", "1", "-l", "1", "-layout", "-", "-"], input=pdf,
                            capture_output=True, timeout=30)
    if result.returncode or not 0 < len(result.stdout) <= MAX_COVER_BYTES:
        raise ValueError("The Canada Gazette Part III PDF cover could not be extracted within bounds")
    return result.stdout.decode("utf-8")


def verify_cover(pdf, issue, chapters, *, extract=extract_cover):
    if not 0 < len(pdf) <= MAX_PDF_BYTES or not pdf.startswith(b"%PDF-") or not pdf.rstrip().endswith(b"%%EOF"):
        raise ValueError("The official Part III PDF is empty, truncated, or exceeds its size bound")
    text = " ".join(unicodedata.normalize("NFKC", extract(pdf)).replace("\ufeff", " ").casefold().split())
    day = date.fromisoformat(issue["publicationDate"])
    english = f"{EN_MONTHS[day.month - 1]} {day.day}, {day.year}".lower()
    french = rf"\b{day.day}(?:er)? {FR_MONTHS[day.month - 1]} {day.year}\b"
    volumes = set(re.findall(r"\bvol\.\s+(\d+)\b", text))
    if (volumes != {str(issue["volume"])} or "part iii" not in text or "partie iii" not in text
            or english not in text or not re.search(french, text)):
        raise ValueError("The bilingual Part III PDF cover disagrees about the volume or publication date")
    en_year = re.search(r"\bstatutes of canada,\s+(\d{4})\b", text)
    fr_year = re.search(r"\blois du canada\s*\((\d{4})\)", text)
    en_range = re.search(r"\bchapters?\s+([1-9]\d*)(?:\s+to\s+([1-9]\d*))?\b", text)
    fr_range = re.search(r"\bchapitres?\s+([1-9]\d*)(?:\s+à\s+([1-9]\d*))?\b", text)
    if not (en_year and fr_year and en_range and fr_range):
        raise ValueError("The bilingual Part III PDF cover omits the statute year or chapter range")
    starts = {int(en_range[1]), int(fr_range[1])}
    stops = {int(en_range[2] or en_range[1]), int(fr_range[2] or fr_range[1])}
    first, last = min(starts), max(stops)
    if (en_year[1] != fr_year[1] or len(starts) != 1 or len(stops) != 1 or not 0 <= last - first < MAX_CHAPTERS
            or chapters != {(int(en_year[1]), chapter) for chapter in range(first, last + 1)}):
        raise ValueError("The Part III PDF cover and Justice Laws chapter citations disagree")


def collect(_unused, fetch, *, extract=extract_cover):
    volumes = {language: latest_volume(fetch(url), language) for language, url in CATALOGUE.items()}
    year, volume, _ = volumes["en"]
    if volumes["fr"][:2] != (year, volume):
        raise ValueError("English and French Canada Gazette catalogues list a different latest Part III volume")
    issues = {language: volume_issues(fetch(source[2]), language, source) for language, source in volumes.items()}
    en, fr = issues["en"], issues["fr"]
    if ({number: (row["date"], row["pdfUrl"], set(row["acts"])) for number, row in en.items()}
            != {number: (row["date"], row["pdfUrl"], set(row["acts"])) for number, row in fr.items()}):
        raise ValueError("English and French Part III issue dates, PDFs, or chapter citations disagree")
    number, source = max(en.items(), key=lambda item: (item[1]["date"], item[0]))
    issue = {"part": "III", "volume": volume, "number": number, "publicationDate": source["date"],
             "nominalVolumeYear": year, "pdfUrl": source["pdfUrl"],
             "indexUrls": {language: entry[2] for language, entry in volumes.items()}}
    pdf = fetch(issue["pdfUrl"])
    chapters = set(source["acts"])
    verify_cover(pdf, issue, chapters, extract=extract)
    issue["pdfSha256"] = sha256(pdf).hexdigest()
    records = [{"statuteYear": statute_year, "chapter": chapter,
                "editions": {language: issues[language][number]["acts"][(statute_year, chapter)] for language in LANGUAGES}}
               for statute_year, chapter in sorted(chapters)]
    return {"schemaVersion": 1, "collection": COLLECTION,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "issue": issue, "records": records}


def verify_archive(output, *, extract=extract_cover):
    contents = output.read_bytes()
    packet = json.loads(contents)
    root = output.parent / "sources"
    inventory = root / "inventories" / COLLECTION / f"{sha256(contents).hexdigest()}.json"
    if inventory.read_bytes() != contents:
        raise ValueError("Canada Gazette inventory differs from its archived manifest")
    if datetime.fromisoformat(packet["observedAt"]).utcoffset() is None:
        raise ValueError("Canada Gazette observation must have a timezone")
    sources = {row["url"]: row for row in packet["sources"]}
    if len(sources) != len(packet["sources"]):
        raise ValueError("Duplicate archived Part III source URL")

    def replay(url):
        row = sources.pop(url, None)
        _, limit = source_kind(url)
        if not row or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
            raise ValueError(f"Missing archived Part III source reference: {url}")
        key, size = row["sha256"], row["bytes"]
        original = root / "objects" / key[:2] / key
        if type(size) is not int or not 0 < size <= limit or original.stat().st_size != size:
            raise ValueError(f"Invalid archived Part III byte count: {url}")
        body = original.read_bytes()
        if sha256(body).hexdigest() != key:
            raise ValueError(f"Invalid archived Part III source hash: {url}")
        return body

    verified = collect(None, replay, extract=extract)
    verified["observedAt"] = packet["observedAt"]
    if sources or verified != {key: value for key, value in packet.items() if key != "sources"}:
        raise ValueError("Part III manifest differs from a replay of the archived originals")
    return packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--output", type=Path, help="Fetch and archive the newest official issue")
    operation.add_argument("--verify-archive", type=Path, help="Replay a local manifest against its archived originals")
    args = parser.parse_args()
    try:
        if args.verify_archive:
            verified = verify_archive(args.verify_archive)
            print(json.dumps({"issue": verified["issue"], "chapters": len(verified["records"]),
                              "sources": len(verified["sources"])}))
            return
        result = archive_inventory(args.output, None, collect, fetch_url)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        parser.error(str(error))
    print(f"Wrote Part III volume {result['issue']['volume']}, number {result['issue']['number']} "
          f"and {len(result['records'])} bilingual chapter citations to {args.output}")


if __name__ == "__main__":
    main()
