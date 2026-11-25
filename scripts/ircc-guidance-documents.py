"""Archive IRCC manuals, bulletins, program instructions and updates from the bilingual publisher indexes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import gzip
from hashlib import sha256
from importlib import import_module
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urldefrag, urljoin, urlsplit

from lib.federal_guidance import (DEFAULT_ROOT as GUIDANCE, IRCC_LANDING, _read_source_archive,
                                  atomic_write, parse_ircc_json, parse_ircc_json_sources)

report_editions = import_module("departmental-report-editions")
text_source = import_module("eccc-passages")
pdf_passages = text_source.pdf_passages
ROOT = Path("data/corpus/ircc-guidance-documents")
PDU_RECOVERY_DATES = {"2021-07-08", "2021-11-26", "2021-11-10", "2025-10-27"}
PDU_EN_BAD_SLUG = "https://www.canada.ca/content/canadasite/en/immigration-refugees-citizenship/corporate/publications-manuals/operational-bulletins-manuals/updates/2025-special-meaures-wildfires.html"
PDU_EN_CORRECT_SLUG = PDU_EN_BAD_SLUG.replace("special-meaures", "special-measures")
PDU_FR_TITLE_CORRECTIONS = {
    ("2021-07-08", "Le serment de citoyenneté a été mis à jourl"):
        "Le serment de citoyenneté a été mis à jour",
}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()


def digest(data):
    return sha256(data).hexdigest()


def verified_file(path, expected):
    data = path.read_bytes()
    if digest(data) != expected:
        raise ValueError(f"Source hash mismatch in {path}")
    return data


def inventory(guidance):
    receipt = json.loads((guidance / "dist/receipt.json").read_bytes())
    info = receipt["inventory"]
    path = Path(info["path"])
    raw = verified_file(path, info["sha256"])
    source = json.loads(raw)
    return {"path": str(path), "sha256": info["sha256"], "observedAt": source["observed_at"]}, listed_editions(source)


def department_page(url, include_cms_paths=True):
    parsed = urlsplit(url)
    path = re.sub(r"^/(?:content/)?canadasite/", "/", parsed.path) if include_cms_paths else parsed.path
    return (parsed.scheme == "https" and parsed.hostname == "www.canada.ca" and
            path.lstrip("/").startswith(("en/immigration-refugees-citizenship/", "fr/immigration-refugies-citoyennete/", "content/dam/ircc/")))


def listed_editions(source, current_paths=True):
    indexes = source["ircc"]["indexes"]
    for language, url in IRCC_LANDING.items():
        item = indexes["ircc-" + language]
        if item["url"] != url:
            raise ValueError(f"Unexpected {language} manual index")
        with gzip.open(item["archive"], "rb") as stream:
            body = stream.read()
        if len(body) != item["bytes"] or digest(body) != item["sha256"]:
            raise ValueError(f"IRCC {language} original index hash mismatch")
    for item in source["sources"].values():
        if "json" in urlsplit(item["url"]).path.lower() and item.get("archive"):
            with gzip.open(item["archive"], "rb") as stream:
                body = stream.read()
            if digest(body) != item["sha256"] or len(body) != item["bytes"]:
                raise ValueError("IRCC instruction data differ from the archived source index")
    editions = {}
    for row in source["records"]:
        lang = row.get("language")
        if row.get("source_index") != IRCC_LANDING.get(lang) or "citations" not in row:
            continue
        for link in row["citations"]:
            url = link["url"]
            # Preserve the distinction between IRCC publications and related sources.
            target_lang = link.get("language", lang)
            if target_lang not in {"en", "fr"}:
                raise ValueError("Unknown IRCC citation language")
            ircc = department_page(url, current_paths)
            edition = editions.setdefault((target_lang, url), {"language": target_lang, "url": url, "listings": [],
                                                        "scope": "ircc-document" if ircc else "linked-reference"})
            listing = {"label": link["label"], "cells": row["cells"], "indexUrl": row["source_index"],
                       "indexSha256": indexes["ircc-" + lang]["sha256"], "kinds": row["kinds"]}
            if row.get("source_data_url"):
                listing.update(indexLanguage=lang, dataUrl=row["source_data_url"], dataSha256=row["source_data_sha256"])
            if listing not in edition["listings"]:
                edition["listings"].append(listing)
    if {lang for lang, url in editions} != {"en", "fr"}:
        raise ValueError("Expected manual links in both official indexes")
    return editions


def object_path(root, identity, ext):
    if not re.fullmatch(r"[0-9a-f]{64}", identity):
        raise ValueError("Invalid manual object hash")
    return root / "objects" / identity[:2] / (identity + ext)


def save_object(root, data, ext):
    identity = digest(data)
    path = object_path(root, identity, ext)
    if not path.exists() or digest(path.read_bytes()) != identity:
        atomic_write(path, data)
    return identity


def extract_manual(body, final_url):
    if not body.startswith(b"%PDF-"):
        raise ValueError("The listed manual did not return a PDF")
    sections = pdf_passages(body, final_url)
    if not sections:
        raise ValueError("The PDF has no extractable page text")
    return sections


def extract_page(body, final_url, language):
    tree = text_source.TreeParser()
    tree.feed(body.decode("utf-8", errors="replace"))
    tree.close()
    html = next((n for n in text_source.walk(tree.root) if n.tag == "html"), None)
    main = text_source.choose_content(tree.root)
    if html is None or html.attrs.get("lang", "").lower().split("-")[0] != language or main.tag not in ("main", "article"):
        raise ValueError("The response has no guidance content in the requested language")
    title = next((text_source.clean(text_source.node_text(n)) for n in text_source.walk(main) if n.tag == "h1"), "")
    if (not title or re.search(r"page not found|page introuvable|request rejected|demande rejetée|access denied",
                               title, re.IGNORECASE)):
        raise ValueError("The response has no published guidance title")
    sections = text_source.html_passages(body, final_url)
    if not any(p["kind"] != "heading" and len(p["text"]) > 40 for p in sections):
        raise ValueError("The IRCC page contains no readable guidance passages")
    return title, sections


def check_edition(root, document, reparse=False):
    kind = document.get("format", "pdf")
    body = verified_file(object_path(root, document["sha256"], "." + kind), document["sha256"])
    compressed = verified_file(object_path(root, document["passagesSha256"], ".json.gz"), document["passagesSha256"])
    sections = json.loads(gzip.decompress(compressed))
    if len(body) != document["bytes"] or len(sections) != document["passages"]:
        raise ValueError("Manual archive counts differ from its receipt")
    if reparse:
        if kind == "html":
            title, derived = extract_page(body, document["finalUrl"], document["language"])
            if title != document["title"]:
                raise ValueError("Archived IRCC title differs from its receipt")
        else:
            derived = extract_manual(body, document["finalUrl"])
        if derived != sections:
            raise ValueError("Guidance passage replay differs from its receipt")
    return sections


def get_document(root, requested_url, fetch, language="en"):
    body, media, final_url, _ = fetch(requested_url, 32 * 1024**2)
    final_url, _ = urldefrag(final_url)
    if urlsplit(requested_url).path.lower().endswith(".pdf"):
        if media not in ("application/pdf", "application/octet-stream"):
            raise ValueError(f"The linked manual returned {media}")
        kind, title, sections = "pdf", None, extract_manual(body, final_url)
    elif media in ("text/html", "application/xhtml+xml"):
        return _archive_html(root, body, media, final_url, language)
    else:
        raise ValueError(f"The listed IRCC page returned {media}")
    extracted = gzip.compress(encoded(sections), compresslevel=3, mtime=0)
    return {"finalUrl": final_url, "sha256": save_object(root, body, "." + kind),
            "passagesSha256": save_object(root, extracted, ".json.gz"), "mediaType": media,
            "format": kind, "title": title, "language": language, "bytes": len(body),
            "passages": len(sections), "pagesWithText": len({s["page"] for s in sections}) if kind == "pdf" else None,
            "verifiedAt": datetime.now(timezone.utc).isoformat()}


class PublisherMetadata(HTMLParser):
    """Capture publisher-declared alternate editions and issue dates."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.french_alternates = []
        self.issued = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and "alternate" in (attrs.get("rel", "").casefold().split()):
            language = attrs.get("hreflang", "").casefold().split("-", 1)[0]
            href = attrs.get("href")
            if language == "fr" and href:
                self.french_alternates.append(href)
        if tag == "meta":
            name = (attrs.get("name") or attrs.get("property") or "").casefold()
            content = attrs.get("content")
            if name in {"dcterms.issued", "datepublished", "article:published_time"} and content:
                self.issued.append(content.strip())


def _normalize_title(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().casefold()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", folded).split())


def _valid_iso_date(value) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _published_evidence(body: bytes, expected_title: str, expected_date: str, language: str,
                        actual_title: str | None = None) -> tuple[str, str]:
    if not _valid_iso_date(expected_date):
        raise ValueError("PDU recovery source has no valid ISO publication date")
    title = actual_title
    if title is None:
        title, _ = extract_page(body, "https://www.canada.ca/" + ("en/immigration-refugees-citizenship/" if language == "en" else "fr/immigration-refugies-citoyennete/"), language)
    normalized_title = _normalize_title(title)
    normalized_expected = _normalize_title(expected_title)
    title_matches = normalized_title == normalized_expected or normalized_title.endswith(" " + normalized_expected)
    allowed_title = PDU_FR_TITLE_CORRECTIONS.get((expected_date, expected_title))
    normalized_allowed = _normalize_title(allowed_title) if allowed_title else ""
    if not title_matches and not (normalized_allowed and
                                  (normalized_title == normalized_allowed or normalized_title.endswith(" " + normalized_allowed))):
        raise ValueError(f"PDU target title does not match its {language} source row")
    metadata = PublisherMetadata()
    metadata.feed(body.decode("utf-8", errors="replace"))
    if expected_date not in metadata.issued:
        raise ValueError("PDU target does not publish the source ISO issue date")
    return title, expected_date


def _alternate_french_url(body: bytes, english_final_url: str) -> str:
    metadata = PublisherMetadata()
    metadata.feed(body.decode("utf-8", errors="replace"))
    links = {urldefrag(urljoin(english_final_url, href))[0] for href in metadata.french_alternates}
    if len(links) != 1:
        raise ValueError("English PDU page lacks one unambiguous publisher-declared French alternate")
    target = next(iter(links))
    path = re.sub(r"^/(?:content/)?canadasite/", "/", urlsplit(target).path)
    if (not department_page(target) or not path.lstrip("/").startswith("fr/immigration-refugies-citoyennete/")):
        raise ValueError("Publisher French alternate is outside official French IRCC content")
    return target


def _archive_html(root: Path, body: bytes, media: str, final_url: str, language: str,
                  expected_title: str | None = None, expected_date: str | None = None) -> dict:
    final_url, _ = urldefrag(final_url)
    if media not in ("text/html", "application/xhtml+xml"):
        raise ValueError(f"The listed IRCC page returned {media}")
    if not department_page(final_url):
        raise ValueError("Listed IRCC guidance redirects outside the department")
    if language == "fr":
        path = re.sub(r"^/(?:content/)?canadasite/", "/", urlsplit(final_url).path)
        if not path.lstrip("/").startswith("fr/immigration-refugies-citoyennete/"):
            raise ValueError("Listed IRCC guidance resolved outside the French edition")
    title, sections = extract_page(body, final_url, language)
    published_date = None
    if expected_title is not None or expected_date is not None:
        if expected_title is None or expected_date is None:
            raise ValueError("PDU title and publication date must be checked together")
        _, published_date = _published_evidence(body, expected_title, expected_date, language, title)
    passage_bytes = gzip.compress(encoded(sections), compresslevel=3, mtime=0)
    document = {"finalUrl": final_url, "sha256": save_object(root, body, ".html"),
            "passagesSha256": save_object(root, passage_bytes, ".json.gz"),
            "mediaType": media, "format": "html", "title": title, "language": language,
            "bytes": len(body), "passages": len(sections), "pagesWithText": None,
            "verifiedAt": datetime.now(timezone.utc).isoformat()}
    if published_date:
        document["publishedDate"] = published_date
    return document


def _archive_verified_html(root: Path, body: bytes, media: str, final_url: str,
                           expected_title: str, expected_date: str, language: str) -> dict:
    return _archive_html(root, body, media, final_url, language, expected_title, expected_date)


def _read_verified_inventory(report: dict) -> dict:
    reference = report["sourceInventory"]
    raw = verified_file(Path(reference["path"]), reference["sha256"])
    inventory = json.loads(raw)
    if inventory.get("collection") != "federal-guidance-indexes":
        raise ValueError("PDU recovery source inventory has the wrong collection")
    return inventory


def _verified_pdu_rows(inventory: dict, language: str) -> list[dict]:
    landing_key = f"ircc-{language}"
    source_key = f"ircc-json-pdu-{language}"
    landing = inventory.get("sources", {}).get(landing_key)
    source = inventory.get("sources", {}).get(source_key)
    if not landing or not source:
        raise ValueError(f"PDU recovery requires archived {language} landing and JSON sources")
    landing_body = _read_source_archive(landing, GUIDANCE)
    index_url = landing.get("final_url") or landing["url"]
    spec = parse_ircc_json_sources(landing_body, index_url, language)["pdu-table"]
    if source.get("url") != spec["url"]:
        raise ValueError(f"Archived {language} PDU feed is not the one linked by its landing page")
    data = _read_source_archive(source, GUIDANCE)
    rows, _ = parse_ircc_json(data, source["url"], source["sha256"], index_url,
                              landing["sha256"], language, "pdu", "pdu")
    archived_rows = [row for row in inventory.get("records", [])
                     if row.get("source_data_url") == source["url"] and row.get("kind") == "program-delivery-update"]
    if rows != archived_rows:
        raise ValueError(f"Archived {language} PDU rows differ from their official JSON source")
    return rows


def _pdu_data_record(row: dict, language: str) -> dict:
    record = row.get("source_data_record")
    if (not isinstance(record, dict) or row.get("kind") != "program-delivery-update" or
            row.get("language") != language or not isinstance(record.get("category"), str) or
            not isinstance(record.get("title"), str) or not isinstance(record.get("link"), str) or
            not _valid_iso_date(record.get("dataOrder"))):
        raise ValueError("PDU recovery row lacks a verified category, title, link, or ISO date")
    citation = row.get("citations", [{}])[0].get("url")
    if citation != urljoin(row.get("source_index", ""), record["link"]):
        raise ValueError("PDU recovery citation differs from the archived publisher JSON link")
    return record


def _category_key(value: str) -> str:
    return " ".join(value.casefold().split())


def _report_source_row(report: dict, source_row: dict) -> dict:
    target = source_row["citations"][0]["url"]
    language = source_row["language"]
    matches = [row for row in report["editions"]
               if row["language"] == language and row["url"] == target and
               any(listing.get("dataUrl") == source_row.get("source_data_url") for listing in row["listings"])]
    if len(matches) != 1:
        raise ValueError("PDU recovery source does not identify one report edition")
    return matches[0]


def _edition_body(root: Path, edition: dict) -> bytes:
    document = edition.get("document")
    if not document or document.get("format") != "html":
        raise ValueError("Confirmed English PDU source has no archived HTML original")
    check_edition(root, document, reparse=True)
    return verified_file(object_path(root, document["sha256"], ".html"), document["sha256"])


def _match_en_pdu(fr_row: dict, en_rows: list[dict]) -> dict:
    fr = _pdu_data_record(fr_row, "fr")
    key = (_category_key(fr["category"]), fr["dataOrder"])
    matches = [row for row in en_rows
               if (_category_key(_pdu_data_record(row, "en")["category"]),
                   _pdu_data_record(row, "en")["dataOrder"]) == key]
    if len(matches) != 1:
        raise ValueError("French PDU category/date does not select one English source row")
    return matches[0]


def _published_date_for(row: dict, language: str) -> str:
    return _pdu_data_record(row, language)["dataOrder"]


def _check_english_pdu(root: Path, english_row: dict, english_edition: dict) -> tuple[bytes, str, str]:
    record = _pdu_data_record(english_row, "en")
    body = _edition_body(root, english_edition)
    document = english_edition["document"]
    title, date = _published_evidence(body, record["title"], record["dataOrder"], "en", document.get("title"))
    return body, title, date


def recover_pdu_fallbacks(root: Path, report: dict, fetch=report_editions.fetch_page,
                          parent_report_sha256: str | None = None) -> dict:
    """Resolve only four dated publisher-linked French PDU pages and one exact English slug typo."""
    inventory = _read_verified_inventory(report)
    en_rows = _verified_pdu_rows(inventory, "en")
    fr_rows = _verified_pdu_rows(inventory, "fr")
    by_language = {"en": en_rows, "fr": fr_rows}
    rows = {(row["language"], row["url"]): row for row in report["editions"]}
    changed = False

    # One source-index typo has an exact, title/date-verified English correction.
    for en_row in en_rows:
        record = _pdu_data_record(en_row, "en")
        if (record["dataOrder"] != "2025-10-27" or en_row["citations"][0]["url"] != PDU_EN_BAD_SLUG or
                not en_row["source_data_url"].endswith("/pdu-en.json")):
            continue
        edition = _report_source_row(report, en_row)
        if edition.get("recovery"):
            continue
        if edition["status"] != "failed" or edition.get("error") != "HTTP 404":
            raise ValueError("The known 2025 English PDU typo is not preserved as the expected 404")
        try:
            body, media, final_url, count = fetch(PDU_EN_CORRECT_SLUG, 32 * 1024**2)
            if count != len(body):
                raise ValueError("Corrected English PDU length metadata disagrees")
            doc = _archive_verified_html(root, body, media, final_url, record["title"], record["dataOrder"], "en")
            metadata = PublisherMetadata()
            metadata.feed(body.decode("utf-8", errors="replace"))
            french_url = _alternate_french_url(body, doc["finalUrl"])
            edition["recovery"] = {"method": "publisher-corrected-slug", "originalIndexUrl": edition["url"],
                                   "originalError": edition["error"], "correctedUrl": PDU_EN_CORRECT_SLUG,
                                   "sourceDataUrl": en_row["source_data_url"], "category": record["category"],
                                   "publicationDate": record["dataOrder"], "publisherTitle": doc["title"],
                                   "englishBodySha256": doc["sha256"], "hreflangFrUrl": french_url,
                                   "parentReportSha256": parent_report_sha256}
            edition["document"] = doc
            edition["status"] = "verified"
            changed = True
        except (OSError, ValueError, RuntimeError, report_editions.FetchError) as error:
            edition["recoveryAttempt"] = {"method": "publisher-corrected-slug", "url": PDU_EN_CORRECT_SLUG,
                                           "error": str(error)[:1000]}
            changed = True

    for fr_row in fr_rows:
        fr_record = _pdu_data_record(fr_row, "fr")
        if fr_record["dataOrder"] not in PDU_RECOVERY_DATES:
            continue
        fr_edition = _report_source_row(report, fr_row)
        if fr_edition.get("recovery") or fr_edition["status"] != "failed":
            continue
        en_row = _match_en_pdu(fr_row, en_rows)
        en_record = _pdu_data_record(en_row, "en")
        en_edition = _report_source_row(report, en_row)
        en_url = en_row["citations"][0]["url"]
        if en_url == PDU_EN_BAD_SLUG:
            corrected = en_edition.get("recovery", {})
            if (corrected.get("method") != "publisher-corrected-slug" or
                    corrected.get("publicationDate") != fr_record["dataOrder"] or
                    corrected.get("category") is None or
                    _category_key(corrected["category"]) != _category_key(fr_record["category"])):
                continue
            en_body = verified_file(object_path(root, en_edition["document"]["sha256"], ".html"),
                                    en_edition["document"]["sha256"])
            en_title = en_edition["document"]["title"]
            en_date = corrected["publicationDate"]
        else:
            if en_edition["status"] != "verified" or not en_edition.get("document"):
                continue
            try:
                en_body, en_title, en_date = _check_english_pdu(root, en_row, en_edition)
            except (OSError, ValueError, RuntimeError) as error:
                fr_edition["recoveryAttempt"] = {"method": "english-publisher-hreflang",
                                                  "englishSourceUrl": en_url,
                                                  "error": str(error)[:1000]}
                changed = True
                continue
        try:
            alternate = _alternate_french_url(en_body, en_edition["document"]["finalUrl"])
            if not _valid_iso_date(en_date) or en_date != fr_record["dataOrder"]:
                raise ValueError("English/French PDU source dates do not match")
            body, media, final_url, count = fetch(alternate, 32 * 1024**2)
            if count != len(body):
                raise ValueError("French PDU response length metadata disagrees")
            doc = _archive_verified_html(root, body, media, final_url, fr_record["title"], fr_record["dataOrder"], "fr")
            fr_title, fr_date = doc["title"], doc["publishedDate"]
            # The attempted index target and its failure remain explicit in the recovered edition.
            original_error = fr_edition.get("error")
            fr_edition["recovery"] = {"method": "english-publisher-hreflang", "originalIndexUrl": fr_edition["url"],
                                      "originalError": original_error, "sourceDataUrl": fr_row["source_data_url"],
                                      "category": fr_record["category"], "publicationDate": fr_record["dataOrder"],
                                      "englishSourceIndexUrl": en_url, "englishFinalUrl": en_edition["document"]["finalUrl"],
                                      "englishBodySha256": digest(en_body), "englishTitle": en_title,
                                      "hreflangFrUrl": alternate, "verifiedFrenchFinalUrl": doc["finalUrl"],
                                      "frenchTitle": fr_title, "frenchDate": fr_date,
                                      "parentReportSha256": parent_report_sha256}
            fr_edition["document"] = doc
            fr_edition["status"] = "verified"
            changed = True
        except (OSError, ValueError, RuntimeError, report_editions.FetchError) as error:
            fr_edition["recoveryAttempt"] = {"method": "english-publisher-hreflang",
                                              "englishSourceUrl": en_url,
                                              "error": str(error)[:1000]}
            changed = True

    report["schemaVersion"] = max(3, int(report.get("schemaVersion", 1)))
    if changed:
        if parent_report_sha256:
            report["recoveredFromReportSha256"] = parent_report_sha256
        report["completedAt"] = datetime.now(timezone.utc).isoformat()
        summary = report["summary"]
        summary["verifiedThisRun"] = sum(row["status"] == "verified" for row in report["editions"])
        summary["failedEditions"] = sum(row["status"] == "failed" for row in report["editions"])
        summary["availableEditions"] = sum(bool(row.get("document")) for row in report["editions"])
        summary["linkedReferences"] = sum(row["status"] == "linked-reference" for row in report["editions"])
    return report


def recover_existing_report(root: Path, report_sha256: str | None = None,
                            fetch=report_editions.fetch_page) -> dict:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("another IRCC guidance refresh holds the publication lock") from error
        latest_path = root / "latest.json"
        head_sha = json.loads(latest_path.read_bytes())["reportSha256"] if latest_path.exists() else None
        original_sha = report_sha256 or head_sha
        if original_sha is None:
            raise ValueError("No existing IRCC guidance report is available to recover")
        original = load_report(root, original_sha)
        before = encoded(original)
        report = recover_pdu_fallbacks(root, original, fetch, original_sha)
        raw = encoded(report)
        if raw == before:
            return {"reportSha256": original_sha, "summary": original["summary"], "unchanged": True,
                    "latestUpdated": head_sha == original_sha}
        identity = digest(raw)
        atomic_write(root / "reports" / (identity + ".json"), raw)
        latest_updated = head_sha == original_sha
        if latest_updated:
            pointer = {"reportSha256": identity, "summary": report["summary"]}
            atomic_write(latest_path, encoded(pointer))
        return {"reportSha256": identity, "summary": report["summary"], "latestUpdated": latest_updated}


def load_report(root, reference=None):
    if reference is None:
        reference = json.loads((root / "latest.json").read_bytes())["reportSha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", reference):
        raise ValueError("Invalid manual report hash")
    return json.loads(verified_file(root / "reports" / (reference + ".json"), reference))


def refresh(root, guidance, workers, fetch=report_editions.fetch_page):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source, candidate = inventory(guidance)
        previous = {}
        if (root / "latest.json").exists():
            previous = {(row["language"], row["url"]): row["document"] for row in load_report(root)["editions"] if row.get("document")}
        def retrieve(key):
            language, url = key
            if candidate[key]["scope"] == "linked-reference":
                return {"status": "linked-reference"}
            try:
                return {"status": "verified", "document": get_document(root, url, fetch, language)}
            except (OSError, ValueError, RuntimeError, report_editions.FetchError) as error:
                result = {"status": "failed", "error": str(error)}
                if key in previous:
                    check_edition(root, previous[key])
                    result["document"] = previous[key]
                return result
        keys = sorted(candidate)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            editions = [{**candidate[key], **result} for key, result in zip(keys, pool.map(retrieve, keys), strict=True)]
        failures = sum(row["status"] == "failed" for row in editions)
        summary = {"listedEditions": len(editions), "linkedReferences": sum(row["status"] == "linked-reference" for row in editions),
                   "failedEditions": failures, "verifiedThisRun": sum(row["status"] == "verified" for row in editions),
                   "availableEditions": sum(bool(row.get("document")) for row in editions)}
        report = {"schemaVersion": 2, "completedAt": datetime.now(timezone.utc).isoformat(), "sourceInventory": source,
                  "summary": summary, "editions": editions}
        report = recover_pdu_fallbacks(root, report, fetch)
        raw = encoded(report)
        identity = digest(raw)
        atomic_write(root / "reports" / (identity + ".json"), raw)
        pointer = {"reportSha256": identity, "summary": summary}
        atomic_write(root / "latest.json", encoded(pointer))
        return pointer


def _verify_recovery_evidence(root: Path, report: dict, inventory: dict, row: dict,
                             en_rows: list[dict], fr_rows: list[dict]) -> None:
    proof = row.get("recovery")
    if not isinstance(proof, dict) or proof.get("originalIndexUrl") != row["url"] or proof.get("originalError") != row.get("error"):
        raise ValueError("PDU recovery does not preserve the original failed index URL and error")
    if not row.get("document") or row["document"].get("format") != "html":
        raise ValueError("PDU recovery has no verified HTML original")
    if proof.get("method") == "publisher-corrected-slug":
        if (row["language"] != "en" or row["url"] != PDU_EN_BAD_SLUG or
                proof.get("correctedUrl") != PDU_EN_CORRECT_SLUG or proof.get("originalError") != "HTTP 404"):
            raise ValueError("PDU corrected-slug recovery is outside its exact approved source URL")
        source = _source_row_for_report_url(en_rows, row["url"], "en")
        record = _pdu_data_record(source, "en")
        if (record["dataOrder"] != "2025-10-27" or proof.get("sourceDataUrl") != source["source_data_url"] or
                proof.get("publicationDate") != record["dataOrder"] or
                _category_key(str(proof.get("category", ""))) != _category_key(record["category"])):
            raise ValueError("Corrected-slug recovery no longer matches the official PDU category/date")
        body = verified_file(object_path(root, row["document"]["sha256"], ".html"), row["document"]["sha256"])
        if row["document"].get("finalUrl") != proof.get("correctedUrl") and not department_page(row["document"].get("finalUrl", "")):
            raise ValueError("Corrected English PDU target is outside official IRCC content")
        title, _ = _published_evidence(body, record["title"], record["dataOrder"], "en", row["document"].get("title"))
        alternate = _alternate_french_url(body, row["document"]["finalUrl"])
        if (proof.get("englishBodySha256") != row["document"]["sha256"] or
                proof.get("publisherTitle") != title or proof.get("hreflangFrUrl") != alternate):
            raise ValueError("Corrected English PDU replay differs from its publisher evidence")
        return

    if proof.get("method") != "english-publisher-hreflang" or row["language"] != "fr":
        raise ValueError("Unknown IRCC PDU recovery method")
    fr_source = _source_row_for_report_url(fr_rows, row["url"], "fr")
    fr_record = _pdu_data_record(fr_source, "fr")
    en_source = _match_en_pdu(fr_source, en_rows)
    en_record = _pdu_data_record(en_source, "en")
    en_edition = _report_source_row(report, en_source)
    if (fr_record["dataOrder"] not in PDU_RECOVERY_DATES or
            proof.get("sourceDataUrl") != fr_source["source_data_url"] or
            proof.get("publicationDate") != fr_record["dataOrder"] or
            _category_key(str(proof.get("category", ""))) != _category_key(fr_record["category"]) or
            proof.get("englishSourceIndexUrl") != en_source["citations"][0]["url"] or
            proof.get("englishSourceIndexUrl") != en_edition["url"]):
        raise ValueError("French PDU recovery no longer matches its bilingual category/date source rows")
    en_body, en_title, en_date = _check_english_pdu(root, en_source, en_edition)
    if en_date != fr_record["dataOrder"]:
        raise ValueError("English PDU publisher date differs from its French source date")
    alternate = _alternate_french_url(en_body, en_edition["document"]["finalUrl"])
    if proof.get("englishBodySha256") != digest(en_body) or proof.get("englishTitle") != en_title or proof.get("hreflangFrUrl") != alternate:
        raise ValueError("French PDU recovery does not match the archived English alternate link")
    fr_body = verified_file(object_path(root, row["document"]["sha256"], ".html"), row["document"]["sha256"])
    fr_title, fr_date = _published_evidence(fr_body, fr_record["title"], fr_record["dataOrder"], "fr",
                                             row["document"].get("title"))
    if (row["document"].get("language") != "fr" or proof.get("verifiedFrenchFinalUrl") != row["document"].get("finalUrl") or
            proof.get("frenchTitle") != fr_title or proof.get("frenchDate") != fr_date or
            not department_page(row["document"].get("finalUrl", ""))):
        raise ValueError("French PDU recovery replay differs from its archived language/title/date")
    final_path = re.sub(r"^/(?:content/)?canadasite/", "/", urlsplit(row["document"]["finalUrl"]).path)
    if not final_path.lstrip("/").startswith("fr/immigration-refugies-citoyennete/"):
        raise ValueError("Recovered French PDU original is not in French IRCC content")


def _source_row_for_report_url(rows: list[dict], url: str, language: str) -> dict:
    matches = [source for source in rows if source.get("language") == language and source["citations"][0]["url"] == url]
    if len(matches) != 1:
        raise ValueError("Recovery report URL does not identify one source-data row")
    return matches[0]


def replay(root, report):
    inventory_ref = report["sourceInventory"]
    source_inventory = json.loads(verified_file(Path(inventory_ref["path"]), inventory_ref["sha256"]))
    listed = listed_editions(source_inventory, current_paths=report.get("schemaVersion", 1) >= 2)
    recovered_rows = [row for row in report["editions"] if row.get("recovery")]
    if recovered_rows:
        en_rows = _verified_pdu_rows(source_inventory, "en")
        fr_rows = _verified_pdu_rows(source_inventory, "fr")
        parent_sha = report.get("recoveredFromReportSha256")
        parent = load_report(root, parent_sha) if parent_sha else None
        if parent:
            parent_editions = {(row["language"], row["url"]): row for row in parent["editions"]}
            for row in recovered_rows:
                previous = parent_editions.get((row["language"], row["url"]))
                proof = row["recovery"]
                if (not previous or previous.get("status") != "failed" or
                        previous.get("url") != proof.get("originalIndexUrl") or
                        previous.get("error") != proof.get("originalError")):
                    raise ValueError("Recovery report does not retain the exact prior failed index attempt")
        for row in recovered_rows:
            _verify_recovery_evidence(root, report, source_inventory, row, en_rows, fr_rows)
    keys = set()
    for row in report["editions"]:
        key = (row["language"], row["url"])
        if (key in keys or key not in listed or row["listings"] != listed[key]["listings"]
                or row["scope"] != listed[key]["scope"]):
            raise ValueError("Archived edition identity or citation differs from its source inventory")
        keys.add(key)
        if row.get("document"):
            check_edition(root, row["document"], reparse=True)
        elif row["status"] == "verified":
            raise ValueError("Verified guidance edition is missing its original")
    if keys != listed.keys():
        raise ValueError("IRCC archive omits listed editions")
    summary = report["summary"]
    for key, actual in (("listedEditions", len(keys)), ("verifiedThisRun", sum(r["status"] == "verified" for r in report["editions"])),
                        ("availableEditions", sum(bool(r.get("document")) for r in report["editions"])),
                        ("failedEditions", sum(r["status"] == "failed" for r in report["editions"])),
                        ("linkedReferences", sum(r["status"] == "linked-reference" for r in report["editions"]))):
        if actual != summary[key]:
            raise ValueError(f"IRCC archive count differs for {key}")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    sub = parser.add_subparsers(dest="command", required=True)
    acquire = sub.add_parser("refresh")
    acquire.add_argument("--guidance", type=Path, default=GUIDANCE)
    acquire.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    check = sub.add_parser("replay")
    check.add_argument("--report", help="SHA-256 of the dated report; defaults to latest")
    recover = sub.add_parser("recover-pdu-french", help="repair only the dated French PDU links with publisher-linked English originals")
    recover.add_argument("--report", help="SHA-256 of an existing immutable report; defaults to latest")
    lookup = sub.add_parser("lookup")
    lookup.add_argument("--code", required=True, help="Exact manual code, title or other value printed in the source index, e.g. OP 8")
    lookup.add_argument("--language", choices=["en", "fr"], required=True)
    lookup.add_argument("--query", help="Return matching page or section citations from the acquired document")
    lookup.add_argument("--limit", type=int, choices=range(1, 101), default=5)
    args = parser.parse_args()
    if args.command == "refresh":
        result = refresh(args.root, args.guidance, args.workers)
        print(json.dumps(result))
        return 2 if result["summary"]["failedEditions"] else 0
    if args.command == "recover-pdu-french":
        result = recover_existing_report(args.root, args.report)
        print(json.dumps(result))
        return 0
    report = load_report(args.root, getattr(args, "report", None))
    if args.command == "replay":
        print(json.dumps(replay(args.root, report)))
        return 0
    matches = []
    for row in report["editions"]:
        listings = [s for s in row["listings"] if args.code.casefold() in [cell.casefold() for cell in s["cells"]]]
        if row["language"] == args.language and listings:
            passages = check_edition(args.root, row["document"]) if row.get("document") and args.query else []
            matches.append({**row, "listings": listings, "matchingPassages":
                            [p for p in passages if args.query.casefold() in p["text"].casefold()][:args.limit]})
    print(json.dumps(matches, ensure_ascii=False))
    return int(not matches)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"IRCC manuals: {exc}", file=sys.stderr)
        raise SystemExit(1)
