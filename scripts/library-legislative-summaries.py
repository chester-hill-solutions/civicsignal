#!/usr/bin/env python3
"""Archive the Library of Parliament's published 45-1 legislative summary inventory."""
import argparse
from datetime import date, datetime, timezone
from functools import partial
from hashlib import sha256
import json
from pathlib import Path
import re
from shutil import which
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lib.html_tree import cls, tree
from lib.library_summary_documents import (
    CATALOGUE_PATHS, LIBRARY_HOST, SESSION, acquire_documents, fetch_pdf, pdf_identity, summary_identity,
)
from lib.parliament_intake import archive_inventory


COLLECTION = "legislative-summaries"
ORIGIN = f"https://{LIBRARY_HOST}"
CATALOGUES = {language: urlsplit(ORIGIN + path) for language, path in CATALOGUE_PATHS.items()}
BILL_DETAIL = {
    "en": "https://www.parl.ca/legisinfo/en/bill",
    "fr": "https://www.parl.ca/legisinfo/fr/projet-de-loi",
}
BILL_NUMBER = re.compile(r"[CS]-[1-9][0-9]*", re.I)
TITLE_BILL = re.compile(r"\b(?:Bill|projet de loi)\s+([CS])[\-‑–]([1-9][0-9]*)\b", re.I)
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 100


class NoRedirect(HTTPRedirectHandler):
    """Keep intake on the canonical HTTPS catalogue and its published pages."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url):
    request = Request(url, headers={"User-Agent": "CivicSignal Library of Parliament intake/1.0"})
    with build_opener(NoRedirect()).open(request, timeout=30) as response:
        body = response.read(MAX_PAGE_BYTES + 1)
        if response.status != 200 or response.headers.get_content_type() != "text/html" or len(body) > MAX_PAGE_BYTES:
            raise ValueError(f"Unexpected catalogue response from {url}")
        return body


def catalogue_url(language):
    return f"{CATALOGUES[language].geturl()}?parliament_session={SESSION}"


def page_number(url, language):
    page = urlsplit(url)
    params = parse_qs(page.query, keep_blank_values=True)
    numbers = params.pop("page", ["0"])
    if (page._replace(query="").geturl() != CATALOGUES[language].geturl()
            or params != {"parliament_session": [SESSION]}
            or len(numbers) != 1 or not re.fullmatch(r"0|[1-9][0-9]*", numbers[0])):
        raise ValueError(f"Unexpected Library pagination target: {url}")
    return int(numbers[0])


def parse_card(card, language, source_url):
    candidates, documents = {}, []
    for link in card.findall(lambda node: node.tag == "a" and node.attrs.get("href")):
        url = urljoin(source_url, link.attrs["href"])
        parts = urlsplit(url)
        if (identity := summary_identity(url)) and identity[1] == language:
            candidates[url] = (identity[0], link.text())
        if link.attrs.get("type") == "application/pdf" or "/legislativesummaries/pdf/" in parts.path.lower():
            documents.append((url, pdf_identity(url)))
    sessions = {node.text() for node in card.findall(lambda node: cls(node, "name-field-parliament-number"))}
    if len(candidates) != 1 or sessions != {SESSION}:
        raise ValueError(f"Missing or ambiguous Library bill identity on {source_url}")
    detail_url, (number, title) = next(iter(candidates.items()))
    title_match = TITLE_BILL.search(title)
    if not title_match or "-".join(title_match.groups()).upper() != number:
        raise ValueError(f"Library bill title does not match the summary URL: {detail_url}")
    if len(set(documents)) > 1 or any(identity != (number, language) for _, identity in documents):
        raise ValueError(f"Conflicting Library document identity for {detail_url}")
    dates = {node.attrs.get("datetime")
             for field in card.findall(lambda node: cls(node, "views-field-field-revised-date"))
             for node in field.findall(lambda node: node.tag == "time")}
    if len(dates) > 1 or None in dates:
        raise ValueError(f"Ambiguous Library revision date for {detail_url}")
    revision = date.fromisoformat(next(iter(dates)).split("T", 1)[0]).isoformat() if dates else None
    return {"billNumber": number, "language": language, "title": title, "url": detail_url,
            "revisionDate": revision, "pdfUrl": documents[0][0] if documents else None, "catalogueUrl": source_url}


def parse_page(body, language, source_url):
    root = tree(body.decode("utf-8-sig"))
    html = root.find(lambda node: node.tag == "html")
    main = root.find(lambda node: node.tag == "main")
    cards = main.findall(lambda node: cls(node, "card-content")) if main else []
    if not html or (html.attrs.get("lang") or "").split("-", 1)[0] != language or not cards:
        raise ValueError(f"Missing {language} legislative summary cards on {source_url}")
    current = page_number(source_url, language)
    anchors = main.findall(lambda node: node.tag == "a" and node.attrs.get("href"))
    next_links = {urljoin(source_url, node.attrs["href"]) for node in anchors
                  if "next" in (node.attrs.get("rel") or "").split()}
    if len(next_links) > 1:
        raise ValueError(f"Ambiguous Library pagination on {source_url}")
    following = next(iter(next_links), None)
    if following and page_number(following, language) != current + 1:
        raise ValueError(f"Nonconsecutive Library pagination from {source_url}")
    if not following:
        for node in anchors:
            target = urlsplit(urljoin(source_url, node.attrs["href"]))
            if (target._replace(query="").geturl() == CATALOGUES[language].geturl()
                    and "page" in parse_qs(target.query) and page_number(target.geturl(), language) > current):
                raise ValueError(f"Missing next link in Library pagination on {source_url}")
    return [parse_card(card, language, source_url) for card in cards], following


def bill_identities(body):
    inventory = json.loads(body)
    if inventory.get("collection") != "bills" or inventory.get("session") != SESSION:
        raise ValueError(f"Expected a {SESSION} LEGISinfo bills inventory")
    editions, by_language = {}, {language: {} for language in BILL_DETAIL}
    for row in inventory["records"]:
        code, language = row["key"].upper(), row["language"]
        bill_id = row["details"].get("legisInfoId")
        if (language not in BILL_DETAIL or not BILL_NUMBER.fullmatch(code) or type(bill_id) is not int or bill_id < 1
                or row["url"] != f"{BILL_DETAIL[language]}/{SESSION}/{code.lower()}" or (code, language) in editions):
            raise ValueError(f"Invalid or duplicate LEGISinfo identity: {code} {language}")
        editions[(code, language)] = {"legisInfoId": bill_id, "url": row["url"]}
        by_language[language][code] = bill_id
    if (not editions or by_language["en"] != by_language["fr"]
            or len(set(by_language["en"].values())) != len(by_language["en"])):
        raise ValueError("Conflicting bilingual bill identities in the LEGISinfo inventory")
    return editions


def collect(session, get, bills):
    if session != SESSION:
        raise ValueError(f"Only Library session {SESSION} is configured")
    records, counts, listed = [], {}, {language: set() for language in CATALOGUES}
    for language in CATALOGUES:
        url = catalogue_url(language)
        pages = 0
        for _ in range(MAX_PAGES):
            rows, url = parse_page(get(url), language, url)
            pages += 1
            for row in rows:
                code = row["billNumber"]
                if code in listed[language]:
                    raise ValueError(f"Duplicate Library catalogue edition: {code} {language}")
                listed[language].add(code)
                bill = bills.get((code, language), {})
                records.append(dict(row, legisInfoId=bill.get("legisInfoId"), billUrl=bill.get("url")))
            if not url:
                break
        else:
            raise ValueError(f"Library catalogue exceeded {MAX_PAGES} pages for {language}")
        counts[language] = pages
    return {
        "session": session, "collection": COLLECTION,
        "observedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "records": records,
        "coverage": {
            "basis": "published Library catalogue listings",
            "pages": counts,
            "editions": {language: len(values) for language, values in listed.items()},
            "languageOnly": {"en": sorted(listed["en"] - listed["fr"]), "fr": sorted(listed["fr"] - listed["en"])},
            "unmatchedBills": sorted({row["billNumber"] for row in records if row["legisInfoId"] is None}),
            "missingPdfLinks": [{"billNumber": row["billNumber"], "language": row["language"]}
                                for row in records if not row["pdfUrl"]],
        },
    }


def collect_pinned(session, get, bills, bill_digest, with_pdfs):
    inventory = collect(session, get, bills)
    if with_pdfs:
        acquire_documents(inventory, get)
    return {**inventory, "billInventorySha256": bill_digest}


def fetch_original(url):
    parts = urlsplit(url)
    if parts.path in CATALOGUE_PATHS.values() or summary_identity(url):
        return fetch(url)
    return fetch_pdf(url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bills", required=True, type=Path, help="Reconciled 45-1 LEGISinfo bills inventory JSON")
    parser.add_argument("--output", required=True, type=Path, help="Output inventory JSON path")
    parser.add_argument("--with-pdfs", action="store_true", help="Archive the listed PDFs and verify their printed covers")
    args = parser.parse_args()
    if args.bills.resolve() == args.output.resolve():
        parser.error("The Library output must differ from the input bills inventory")
    if args.with_pdfs and not which("pdftotext"):
        parser.error("--with-pdfs requires Poppler pdftotext")
    bill_bytes = args.bills.read_bytes()
    acquire = partial(collect_pinned, bills=bill_identities(bill_bytes), bill_digest=sha256(bill_bytes).hexdigest(),
                      with_pdfs=args.with_pdfs)
    packet = archive_inventory(args.output, SESSION, acquire, fetch_original if args.with_pdfs else fetch)
    print(f"Wrote {len(packet['records'])} Library catalogue editions for {SESSION} to {args.output}")
    if args.with_pdfs:
        result = packet["documentAcquisition"]
        print(f"Verified {result['verifiedEditions']} PDFs with {result['gapEditions']} document gaps")


if __name__ == "__main__":
    main()
