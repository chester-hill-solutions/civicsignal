#!/usr/bin/env python3
"""Acquire the latest bilingual Government of Canada Publications acquisitions list."""

import argparse
from datetime import date, datetime, timezone
from html.parser import HTMLParser
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
import zipfile
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_ROOT = Path("data/corpus/federal-publication-checklists")
DEFAULT_BASE_ROOT = Path("data/corpus/federal-publications")
BASE_DATE = date(2025, 11, 20)
BASE_DATASET_ID = "30f7114d-4b3f-4201-8dc7-0d71eb769617"
HOST = "publications.gc.ca"
INDEX_URLS = {
    "en": f"https://{HOST}/site/eng/weeklyAcquisitionList/lists.html?sy={{year}}",
    "fr": f"https://{HOST}/site/fra/listeAcquisitionHebdomadaire/listes.html?sy={{year}}",
}
ROUTES = {
    "en": re.compile(r"^/site/eng/weeklyAcquisitionList/list/(\d{4})/(\d{2}-\d{2})/(\d{8}-\d{8})\.(html|xml|mrc)$"),
    "fr": re.compile(r"^/site/fra/listeAcquisitionHebdomadaire/liste/(\d{4})/(\d{2}-\d{2})/(\d{8}-\d{8})\.(html|xml|mrc)$"),
}
MAX_INDEX_BYTES = 2 * 1024 * 1024
MAX_ISSUE_HTML_BYTES = 4 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_GENERATION_BYTES = 192 * 1024 * 1024
RESERVE_BYTES = 128 * 1024 * 1024
MAX_NEW_ISSUES_PER_RUN = 60
BASE_ID_INDEX_SCHEMA = "mods-record-identifier-v2"
BILINGUAL_RECORD_SCHEMA = "paired-marc-v4"
RELATED_TAGS = ("775", "791", "792", "794", "795")
NS = "{http://www.loc.gov/MARC21/slim}"


class OfficialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname != HOST:
            raise ValueError("Official publication source redirected outside publications.gc.ca")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self._href = None
        self._text = []
        self.page_text = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        self.page_text.append(data)
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join(" ".join(self._text).split())))
            self._href = None
            self._text = []


MONTHS = {
    "january": 1, "janvier": 1, "february": 2, "février": 2, "fevrier": 2,
    "march": 3, "mars": 3, "april": 4, "avril": 4, "may": 5, "mai": 5,
    "june": 6, "juin": 6, "july": 7, "juillet": 7, "august": 8, "août": 8, "aout": 8,
    "september": 9, "septembre": 9, "october": 10, "octobre": 10,
    "november": 11, "novembre": 11, "december": 12, "décembre": 12, "decembre": 12,
}


def _issue_heading_mentions(parser: LinkParser):
    text = " ".join(parser.page_text)
    found = {}
    pattern = re.compile(r"(?:Weekly Acquisitions List|Liste hebdomadaire des acquisitions)\s+(\d{2})-(\d{2})\s*\(([^)]+)\)", re.I)
    for match in pattern.finditer(text):
        yy, week, raw_date = match.groups()
        english = re.search(r"([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),?\s+(\d{4})", raw_date)
        french = re.search(r"(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})", raw_date)
        try:
            if english:
                month, day, year = english.groups()
            elif french:
                day, month, year = french.groups()
            else:
                continue
            end = date(int(year), MONTHS[month.lower()], int(day))
        except (ValueError, KeyError):
            continue
        if end.year == (2000 + int(yy)):
            key = f"{end.year}-{yy}-{week}"
            found[key] = {"key": key, "year": end.year, "issue": f"{yy}-{week}",
                          "dateStart": None, "dateEnd": end.isoformat(), "viewUrl": None,
                          "xmlUrl": None, "availableFormats": [], "missingFormats": ["html", "mrc", "xml"],
                          "missingIssueSpan": True}
    return found


def source_issues(index_body: bytes, language: str, cutoff: date = BASE_DATE):
    """Return all dated issue links at or after the bibliography cutoff."""
    if language not in ROUTES:
        raise ValueError(f"Unsupported source language: {language}")
    parser = LinkParser()
    parser.feed(index_body.decode("utf-8", "strict"))
    grouped = {}
    for href, label in parser.links:
        absolute = urljoin(INDEX_URLS[language], href)
        parsed = urlsplit(absolute)
        match = ROUTES[language].fullmatch(parsed.path)
        if not match or parsed.scheme != "https" or parsed.hostname != HOST:
            continue
        year, issue, span, extension = match.groups()
        key = year, issue, span
        links = grouped.setdefault(key, {})
        if extension in links and links[extension] != absolute:
            raise ValueError(f"Conflicting publisher links for {language} issue {issue}: {extension}")
        links[extension] = absolute
    candidates = []
    for (year, issue, span), links in grouped.items():
        if links:
            start, end = span.split("-")
            # Validate the publisher's issue period independently of its label.
            start_date = date(int(start[:4]), int(start[4:6]), int(start[6:8]))
            end_date = date(int(end[:4]), int(end[4:6]), int(end[6:8]))
            if start_date > end_date or str(end_date.year) != year:
                raise ValueError(f"Invalid publisher issue date span: {span}")
            entry = {
                "key": f"{year}-{issue}",
                "year": int(year), "issue": issue, "dateStart": start_date.isoformat(),
                "dateEnd": end_date.isoformat(), "viewUrl": links.get("html"), "xmlUrl": links.get("xml"),
                "availableFormats": sorted(links), "missingFormats": sorted({"html", "xml", "mrc"} - set(links)),
            }
            if end_date >= cutoff:
                candidates.append(entry)
    mentions = _issue_heading_mentions(parser)
    for row in candidates:
        mention = mentions.get(row["key"])
        if mention and row["dateEnd"] != mention["dateEnd"]:
            row["sourceIdentityGap"] = f"Publisher heading date {mention['dateEnd']} conflicts with linked route date {row['dateEnd']}"
    present = {row["key"] for row in candidates}
    candidates.extend(row for key, row in mentions.items()
                      if key not in present and date.fromisoformat(row["dateEnd"]) >= cutoff)
    if not candidates:
        raise ValueError(f"No acquisitions issues at or after {cutoff.isoformat()} were found on the {language} index")
    candidates.sort(key=lambda item: (item["dateStart"] or item["dateEnd"], item["key"]))
    return candidates


def validate_issue_html(body: bytes, language: str, issue: dict):
    decoded = body.decode("utf-8", "strict")
    title = f"{issue['year'] % 100:02d}-{int(issue['issue'].split('-')[1]):02d}"
    language_phrase = "Weekly Acquisitions List" if language == "en" else "Liste hebdomadaire des acquisitions"
    if language_phrase not in decoded or title not in decoded:
        raise ValueError(f"The {language} view page did not identify issue {issue['issue']}")


def _field_text(field):
    return " ".join("".join(part.itertext()).strip() for part in field.findall(NS + "subfield") if "".join(part.itertext()).strip())


def _raw_subfields(field):
    return [{"code": sub.attrib.get("code", ""),
             "value": " ".join("".join(sub.itertext()).split())}
            for sub in field.findall(NS + "subfield")]


def _corporate_metadata(fields):
    """Retain MARC corporate names with their explicit relator terms/codes."""
    names, issuing_bodies, publishers = [], [], []
    display_codes = {"a", "b", "c", "d", "f", "g", "k", "l", "n", "p", "t", "u"}
    issuer_roles = {"issuing body", "organisme de publication"}
    publisher_roles = {"publisher", "publishing body", "éditeur", "editeur",
                       "éditeur commercial", "editeur commercial"}
    for tag in ("110", "710"):
        for field in fields.get(tag, []):
            subfields = _raw_subfields(field)
            roles = [item["value"] for item in subfields if item["code"] == "e"]
            role_codes = [item["value"] for item in subfields if item["code"] == "4"]
            label = " ".join(item["value"] for item in subfields
                             if item["code"] in display_codes and item["value"])
            name = {"tag": tag, "ind1": field.attrib.get("ind1", " "),
                    "ind2": field.attrib.get("ind2", " "), "label": label,
                    "roles": roles, "roleCodes": role_codes, "subfields": subfields}
            names.append(name)
            normalized_roles = {value.casefold().strip(" .;,:\t") for value in roles}
            normalized_codes = {value.casefold().strip() for value in role_codes}
            if normalized_roles & issuer_roles:
                issuing_bodies.append({"label": label, "sourceTag": tag,
                                       "roles": roles, "roleCodes": role_codes})
            if normalized_roles & publisher_roles or "pbl" in normalized_codes:
                publishers.append({"name": label, "sourceTag": tag,
                                   "roles": roles, "roleCodes": role_codes})
    return names, issuing_bodies, publishers


def _publication_metadata(fields):
    functions = {"0": "production", "1": "publication", "2": "distribution",
                 "3": "manufacture", "4": "copyright-notice"}
    statements, publishers = [], []
    for tag in ("260", "264"):
        for field in fields.get(tag, []):
            indicator = field.attrib.get("ind2", " ")
            function = "legacy-imprint" if tag == "260" else functions.get(indicator, "unspecified")
            subfields = _raw_subfields(field)
            places = [item["value"] for item in subfields if item["code"] == "a" and item["value"]]
            entities = [item["value"] for item in subfields if item["code"] == "b" and item["value"]]
            dates = [item["value"] for item in subfields if item["code"] == "c" and item["value"]]
            statements.append({"tag": tag, "ind1": field.attrib.get("ind1", " "),
                               "ind2": indicator, "function": function, "places": places,
                               "entities": entities, "dates": dates, "subfields": subfields})
            if tag == "264" and function == "publication":
                publishers.extend({"name": value, "sourceTag": tag, "function": function}
                                  for value in entities)
    return statements, publishers


def _publication_links(fields):
    links = []
    for field in fields.get("856", []):
        subfields = _raw_subfields(field)
        urls = [item["value"] for item in subfields if item["code"] == "u" and item["value"]]
        if urls:
            links.append({"tag": "856", "ind1": field.attrib.get("ind1", " "),
                          "ind2": field.attrib.get("ind2", " "), "urls": urls,
                          "formats": [item["value"] for item in subfields if item["code"] == "q"],
                          "labels": [item["value"] for item in subfields if item["code"] == "y"],
                          "notes": [item["value"] for item in subfields if item["code"] == "z"],
                          "subfields": subfields})
    return links


def parse_marc_xml(body: bytes, language: str, record_schema: str = BILINGUAL_RECORD_SCHEMA):
    """Validate publisher MARC21 XML and return records keyed by catalogue 001."""
    if len(body) > MAX_XML_BYTES:
        raise ValueError(f"The {language} XML issue exceeds the {MAX_XML_BYTES}-byte bound")
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", body, re.I):
        raise ValueError("Publisher XML declarations are not accepted")
    records = {}
    root_seen = False
    try:
        import io
        for event, element in ET.iterparse(io.BytesIO(body), events=("start", "end")):
            if event == "start" and not root_seen:
                root_seen = True
                if element.tag != NS + "collection":
                    raise ValueError("Publisher XML is not a MARC21 slim collection")
            if event != "end" or element.tag != NS + "record":
                continue
            fields = [child for child in element if child.tag in (NS + "controlfield", NS + "datafield")]
            controls = {}
            data = {}
            for field in fields:
                tag = field.attrib.get("tag", "")
                if field.tag == NS + "controlfield":
                    controls.setdefault(tag, []).append("".join(field.itertext()).strip())
                else:
                    data.setdefault(tag, []).append(field)
            ids = controls.get("001", [])
            if len(ids) != 1 or not ids[0] or len(controls.get("003", [])) != 1:
                raise ValueError(f"{language} MARC record requires a single 001 and 003")
            title_fields = data.get("245", [])
            if not title_fields:
                raise ValueError(f"{language} MARC record {ids[0]} has no 245 title")
            title_parts = []
            for field in title_fields:
                for subfield in field.findall(NS + "subfield"):
                    if subfield.attrib.get("code") in {"a", "b", "n", "p"}:
                        value = " ".join("".join(subfield.itertext()).split()).rstrip(" /:,;")
                        if value:
                            title_parts.append(value)
            title = " ".join(title_parts)
            if not title:
                raise ValueError(f"{language} MARC record {ids[0]} has an empty 245 title")
            related = []
            checklist_notes = []
            language_codes = set()
            for field in data.get("041", []):
                language_codes.update(value.lower() for value in _field_text(field).split() if re.fullmatch(r"[a-z]{3}", value.lower()))
            for control in controls.get("008", []):
                if len(control) >= 38 and re.fullmatch(r"[a-z]{3}", control[35:38]):
                    language_codes.add(control[35:38])
            for tag in RELATED_TAGS:
                for field in data.get(tag, []):
                    raw = _field_text(field)
                    related.append({"tag": tag, "text": raw})
            for field in data.get("590", []):
                checklist_notes.append(_field_text(field))
            corporate_names, issuing_bodies, corporate_publishers = _corporate_metadata(data)
            publication_statements, statement_publishers = _publication_metadata(data)
            publication_links = _publication_links(data)
            # Record tails contain publisher pretty-print whitespace between MARC records,
            # not part of the MARC record itself. Exclude it from the current content
            # identity while retaining the old rule to replay older immutable receipts.
            if record_schema in {BILINGUAL_RECORD_SCHEMA, "paired-marc-v3"}:
                element.tail = None
            fingerprint = hashlib.sha256(ET.tostring(element, encoding="utf-8")).hexdigest()
            row = {
                "catalogueId": ids[0], "agencyCode": controls["003"][0], "title": title,
                "languageCodes": sorted(language_codes), "relatedEditionFields": related,
                "checklistNotes590": checklist_notes, "corporateNames": corporate_names,
                "issuingBodies": issuing_bodies,
                "publishers": corporate_publishers + statement_publishers,
                "publicationStatements": publication_statements,
                "publicationLinks": publication_links, "fingerprint": fingerprint,
            }
            if ids[0] in records:
                raise ValueError(f"{language} export repeats MARC 001 {ids[0]}")
            records[ids[0]] = row
            element.clear()
    except ET.ParseError as error:
        raise ValueError(f"Malformed {language} MARC21 XML: {error}") from error
    if not root_seen or not records:
        raise ValueError(f"The {language} MARC21 XML contains no records")
    return records


def fetch(url: str, limit: int, opener, budget=None):
    if budget is not None and budget["bytes"] >= budget["limit"]:
        raise ValueError("Cumulative public-source transfer limit exceeded")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != HOST:
        raise ValueError(f"Refusing non-publisher URL: {url}")
    req = Request(url, headers={"Accept-Encoding": "identity", "User-Agent": "CivicSignal Government publications checklist intake"})
    with opener.open(req, timeout=40) as response:
        if response.status != 200:
            raise ValueError(f"Publisher returned HTTP {response.status}: {url}")
        length = response.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > limit:
            raise ValueError(f"Publisher response exceeds its {limit}-byte limit: {url}")
        if budget is not None and length and length.isdigit() and int(length) > budget["limit"] - budget["bytes"]:
            raise ValueError("Cumulative public-source transfer limit would be exceeded by this resource")
        chunks = []
        total = 0
        while True:
            remaining = min(limit + 1 - total, budget["limit"] - budget["bytes"] + 1) if budget is not None else limit + 1 - total
            if remaining <= 0:
                raise ValueError("Cumulative public-source transfer limit exceeded")
            block = response.read(min(64 * 1024, remaining))
            if not block:
                break
            total += len(block)
            if total > limit:
                raise ValueError(f"Publisher response exceeds its {limit}-byte limit: {url}")
            if budget is not None:
                budget["bytes"] += len(block)
                if budget["bytes"] > budget["limit"]:
                    raise ValueError("Cumulative public-source transfer limit exceeded")
            chunks.append(block)
        body = b"".join(chunks)
        return body, {"finalUrl": response.geturl(), "fetchedAt": datetime.now(timezone.utc).isoformat(),
                      "contentType": response.headers.get("Content-Type"),
                      "contentLength": int(length) if length and length.isdigit() else None,
                      "etag": response.headers.get("ETag"), "lastModified": response.headers.get("Last-Modified")}


def _atomic_current(root: Path, generation_name: str):
    tmp = root / f".current-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        os.symlink(generation_name, tmp)
        os.replace(tmp, root / "current")
        _fsync_dir(root)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _fsync_dir(path: Path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_file(path: Path, body: bytes):
    with path.open("xb") as output:
        output.write(body)
        output.flush()
        os.fsync(output.fileno())


def annual_index_url(language: str, year: int):
    return INDEX_URLS[language].format(year=year)


def issue_directory(root: Path, issue: dict):
    number = issue["issue"].split("-")[1]
    return root / "issues" / str(issue["year"]) / f"{issue['year'] % 100:02d}-{number}"


def _issue_version_id(issue: dict, resources: dict):
    identity = {"schema": BILINGUAL_RECORD_SCHEMA, "issue": issue["key"], "dateStart": issue["dateStart"], "dateEnd": issue["dateEnd"],
                "en": {"sha256": resources["en"]["sha256"], "url": resources["en"]["url"]},
                "fr": {"sha256": resources["fr"]["sha256"], "url": resources["fr"]["url"]}}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def reconcile_issue_records(issue: dict, english: dict, french: dict):
    """Deduplicate exact bilingual records and retain localized variants by language."""
    rows = []
    matching = 0
    differing = []
    english_only = sorted(set(english) - set(french))
    french_only = sorted(set(french) - set(english))
    for identifier in sorted(set(english) | set(french)):
        left, right = english.get(identifier), french.get(identifier)
        if left is not None and right is not None and left["fingerprint"] == right["fingerprint"]:
            row = dict(left)
            row["listedIn"] = ["en", "fr"]
            row["citations"] = {"en": issue.get("viewUrl") or issue.get("xmlUrl"),
                                "fr": issue.get("viewUrlFr") or issue.get("xmlUrlFr")}
            rows.append(row)
            matching += 1
        elif left is not None and right is not None:
            differing.append(identifier)
            for language, original in (("en", left), ("fr", right)):
                row = dict(original)
                row.update({"listedIn": [language], "variantLanguage": language,
                            "bilingualMetadataDifference": True,
                            "citations": {language: (issue.get("viewUrl") or issue.get("xmlUrl")) if language == "en"
                                          else (issue.get("viewUrlFr") or issue.get("xmlUrlFr"))}})
                rows.append(row)
        else:
            language, original = ("en", left) if left is not None else ("fr", right)
            row = dict(original)
            row.update({"listedIn": [language], "variantLanguage": language,
                        "bilingualIdMismatch": True,
                        "citations": {language: (issue.get("viewUrl") or issue.get("xmlUrl")) if language == "en"
                                      else (issue.get("viewUrlFr") or issue.get("xmlUrlFr"))}})
            rows.append(row)
    metrics = {"recordsEnglish": len(english), "recordsFrench": len(french),
               "uniqueCatalogueIds": len(set(english) | set(french)),
               "matchingBilingualRecords": matching,
               "bilingualMetadataDifferenceIds": differing,
               "englishOnlyCatalogueIds": english_only, "frenchOnlyCatalogueIds": french_only,
               "duplicateBilingualListingsRemoved": len(english) + len(french) - len(rows),
               "recordVariantsRetained": len(rows)}
    return rows, metrics


def _publish_issue(root: Path, issue: dict, resources: dict, rows: list, fetched_at: str):
    issue_root = issue_directory(root, issue)
    versions = issue_root / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    version_id = _issue_version_id(issue, resources)
    final = versions / version_id
    if not final.exists():
        staging = Path(tempfile.mkdtemp(prefix=".issue-stage-", dir=issue_root))
        try:
            (staging / "archives").mkdir()
            for language in ("en", "fr"):
                _write_file(staging / "archives" / f"{language}.xml", resources[language]["body"])
            with (staging / "records.jsonl").open("x", encoding="utf-8") as output:
                for row in rows:
                    output.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                output.flush()
                os.fsync(output.fileno())
            records_sha = _sha_file(staging / "records.jsonl")
            source_times = [resources[lang].get("fetchedAt") for lang in ("en", "fr") if resources[lang].get("fetchedAt")]
            source_observed = max(source_times) if source_times else None
            issue_age = ((date.fromisoformat(source_observed[:10]) - date.fromisoformat(issue["dateEnd"])).days
                         if source_observed else None)
            receipt = {
                "schemaVersion": 2, "recordSchema": BILINGUAL_RECORD_SCHEMA, "issue": issue, "version": version_id,
                "acquiredLocallyAt": fetched_at, "firstObservedAt": source_observed,
                "sourceObservationAt": source_observed,
                "publicationAgeDaysAtFirstObservation": issue_age,
                "resources": {language: {key: value for key, value in resources[language].items() if key not in {"body", "records"}}
                              for language in ("en", "fr")},
                "recordsSha256": records_sha,
                "counts": {"recordsEnglish": len(resources["en"]["records"]),
                           "recordsFrench": len(resources["fr"]["records"]),
                           **issue.get("bilingualComparison", {"uniqueCatalogueIds": len(rows),
                             "duplicateBilingualListingsRemoved": len(resources["en"]["records"]) + len(resources["fr"]["records"]) - len(rows),
                             "recordVariantsRetained": len(rows)})},
                "coverage": "Bilingual MARC21 XML issue metadata only; role-labelled corporate names, imprint functions, dates, and 856 links are retained. No linked publication full texts fetched.",
            }
            _write_file(staging / "receipt.json", (json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())
            _fsync_dir(staging / "archives")
            _fsync_dir(staging)
            os.replace(staging, final)
            _fsync_dir(versions)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    target = f"versions/{version_id}"
    tmp = issue_root / f".current-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        os.symlink(target, tmp)
        os.replace(tmp, issue_root / "current")
        _fsync_dir(issue_root)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    return version_id, final / "receipt.json"


def _issue_version_index(root: Path):
    result = {}
    issues_root = root / "issues"
    if not issues_root.is_dir():
        return result
    for receipt_path in issues_root.glob("*/**/current/receipt.json"):
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            issue = receipt["issue"]
            if date.fromisoformat(issue["dateEnd"]) >= BASE_DATE:
                result[issue["key"]] = {"issue": issue, "version": receipt["version"],
                                         "receiptPath": receipt_path, "receipt": receipt}
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    return result


def _all_issue_versions(root: Path):
    result = []
    for receipt_path in (root / "issues").glob("*/*/versions/*/receipt.json"):
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            issue = receipt["issue"]
            if date.fromisoformat(issue["dateEnd"]) >= BASE_DATE:
                result.append({"issue": issue, "version": receipt["version"], "receiptPath": receipt_path,
                               "receipt": receipt})
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    return result


def _aggregate_records(root: Path, issue_versions: dict, base_db: Path | None):
    variants = {}
    for info in sorted(issue_versions, key=lambda row: (row["issue"]["dateStart"], row["issue"]["key"], row["version"])):
        records_path = info["receiptPath"].parent / "records.jsonl"
        issue = info["issue"]
        for line in records_path.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            token = record["catalogueId"], record["fingerprint"]
            item = variants.setdefault(token, {**record, "seenInIssues": []})
            item["seenInIssues"].append({"issue": issue["key"], "issueVersion": info["version"],
                                          "dateEnd": issue["dateEnd"], "citations": record["citations"]})
    base_conn = sqlite3.connect(base_db) if base_db else None
    try:
        for item in variants.values():
            if base_conn:
                item["presentInBaseSnapshot"] = base_conn.execute("SELECT 1 FROM ids WHERE id=?", (item["catalogueId"],)).fetchone() is not None
            else:
                item["presentInBaseSnapshot"] = None
    finally:
        if base_conn:
            base_conn.close()
    return sorted(variants.values(), key=lambda row: (row["catalogueId"], row["fingerprint"]))


def _mods_ids(archive_path: Path):
    with zipfile.ZipFile(archive_path) as archive:
        matches = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith(".xml")]
        if len(matches) != 1:
            raise ValueError(f"Base bibliography archive {archive_path.name} must contain one MODS XML file")
        stack = []
        root_element = None
        with archive.open(matches[0]) as stream:
            for event, element in ET.iterparse(stream, events=("start", "end")):
                name = element.tag.rsplit("}", 1)[-1]
                if event == "start":
                    stack.append(element)
                    if root_element is None:
                        root_element = element
                        if name != "modsCollection":
                            raise ValueError(f"Base bibliography archive {archive_path.name} does not contain MODS XML")
                    continue
                if name == "mods" and len(stack) == 2 and stack[0] is root_element:
                    identifiers = []
                    for info in element:
                        if info.tag.rsplit("}", 1)[-1] == "recordInfo":
                            for child in info:
                                if child.tag.rsplit("}", 1)[-1] == "recordIdentifier":
                                    value = "".join(child.itertext()).strip()
                                    if value:
                                        identifiers.append((child.attrib.get("source", ""), value))
                    identifier = next((value for source, value in identifiers if source == "CaOODSP"), None)
                    if identifier is None and identifiers:
                        identifier = identifiers[0][1]
                    if identifier:
                        yield identifier
                    root_element.clear()
                    stack.pop()
                else:
                    stack.pop()


def _ensure_base_index_locked(base_root: Path, root: Path):
    receipt_path = base_root / "current" / "receipt.json"
    if not receipt_path.is_file():
        raise ValueError(f"Dated bibliography base snapshot is missing: {receipt_path}")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("snapshotDate") != BASE_DATE.isoformat() or receipt.get("catalogueDatasetId") != BASE_DATASET_ID:
        raise ValueError(f"Expected registered bibliography dataset {BASE_DATASET_ID} snapshot dated {BASE_DATE.isoformat()}")
    resources = receipt.get("resources", {})
    categories = ("monographs", "series", "periodicals")
    source_hashes = {name: resources.get(name, {}).get("sha256", "") for name in categories}
    signature = hashlib.sha256(("".join(source_hashes[name] for name in categories) + BASE_ID_INDEX_SCHEMA).encode()).hexdigest()
    if any(not resources.get(name, {}).get("sha256") for name in categories):
        raise ValueError("The dated base snapshot lacks one or more publisher archive hashes")
    base_cache = root / "baselines" / signature
    db_path = base_cache / "catalogue_ids.sqlite"
    if db_path.is_file():
        cached_receipt_path = base_cache / "receipt.json"
        try:
            cached = json.loads(cached_receipt_path.read_text(encoding="utf-8"))
            if (cached.get("sourceResourceHashes") == source_hashes
                and cached.get("schema") == BASE_ID_INDEX_SCHEMA
                and _sha_file(db_path) == cached.get("databaseSha256")):
                with sqlite3.connect(db_path) as db:
                    if db.execute("PRAGMA integrity_check").fetchone()[0] == "ok" and db.execute("SELECT count(*) FROM ids").fetchone()[0] == cached.get("uniqueCatalogueIds"):
                        return db_path
        except (OSError, sqlite3.Error, json.JSONDecodeError):
            pass
        raise ValueError("Cached dated bibliography ID index failed its checksum or integrity check")
    base_cache.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".baseline-stage-", dir=base_cache.parent))
    try:
        stage_db = staging / "catalogue_ids.sqlite"
        with sqlite3.connect(stage_db) as db:
            db.execute("CREATE TABLE ids(id TEXT PRIMARY KEY)")
            for category in categories:
                archive_path = base_root / "current" / "archives" / f"{category}.zip"
                expected = resources[category]
                if archive_path.stat().st_size != expected.get("archiveBytes") or _sha_file(archive_path) != expected["sha256"]:
                    raise ValueError(f"Dated base snapshot archive changed: {category}")
                ids = []
                scanned = 0
                for identifier in _mods_ids(archive_path):
                    scanned += 1
                    ids.append((identifier,))
                    if len(ids) >= 5000:
                        db.executemany("INSERT OR IGNORE INTO ids VALUES(?)", ids)
                        ids.clear()
                if ids:
                    db.executemany("INSERT OR IGNORE INTO ids VALUES(?)", ids)
                if scanned != expected.get("recordCount"):
                    raise ValueError(f"Dated base snapshot {category} count changed: saw {scanned}; receipt records {expected.get('recordCount')}")
            total = db.execute("SELECT count(*) FROM ids").fetchone()[0]
        _write_file(staging / "receipt.json", (json.dumps({"snapshotDate": receipt["snapshotDate"],
            "datasetId": receipt.get("catalogueDatasetId"), "schema": BASE_ID_INDEX_SCHEMA,
            "sourceResourceHashes": source_hashes, "databaseSha256": _sha_file(stage_db),
            "uniqueCatalogueIds": total}, sort_keys=True, indent=2) + "\n").encode())
        _fsync_dir(staging)
        os.replace(staging, base_cache)
        _fsync_dir(base_cache.parent)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return db_path


def ensure_base_index(base_root: Path, root: Path):
    """Build/validate the dated base ID cache under a process-wide file lock."""
    lock_dir = root / "baselines"
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / ".build.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _ensure_base_index_locked(base_root, root)


def _sha_file(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def select_issue_work(missing_issues: list, latest_key: str, limit: int = MAX_NEW_ISSUES_PER_RUN):
    selected = list(missing_issues[:limit])
    latest = next((row for row in missing_issues if row["key"] == latest_key), None)
    if latest is not None and latest not in selected:
        selected = selected[:max(0, limit - 1)] + [latest]
    return selected


def refresh(root: Path, download_live: bool, input_dir: Path | None = None,
            base_root: Path | None = DEFAULT_BASE_ROOT):
    """Catch up every indexed issue after the dated bulk snapshot and recheck newest."""
    root.mkdir(parents=True, exist_ok=True)
    max_local = MAX_GENERATION_BYTES + RESERVE_BYTES
    free = shutil.disk_usage(root).free
    if free < max_local:
        raise ValueError(f"Checklist backfill requires at least {max_local // (1024 * 1024)} MiB free including reserve; {free // (1024 * 1024)} MiB available")
    if not download_live and input_dir is None:
        raise ValueError("Choose --download for official sources or --input-dir for fixture/archive replay")
    current_year = datetime.now(timezone.utc).year
    years = list(range(BASE_DATE.year, current_year + 1))
    opener = build_opener(OfficialRedirect())
    budget = {"bytes": 0, "limit": MAX_GENERATION_BYTES}
    indexes = {}
    fetched_meta = {}
    for year in years:
        for language in INDEX_URLS:
            name = f"index-{year}-{language}.html"
            url = annual_index_url(language, year)
            if download_live:
                body, metadata = fetch(url, MAX_INDEX_BYTES, opener, budget)
            else:
                path = input_dir / name
                if not path.is_file():
                    raise ValueError(f"Missing annual replay index: {path}")
                body = path.read_bytes()
                if len(body) > MAX_INDEX_BYTES:
                    raise ValueError(f"Replay index exceeds its size limit: {path}")
                metadata = {"finalUrl": url, "fetchedAt": None, "replay": True}
            indexes[year, language] = body
            fetched_meta[name] = (url, body, metadata)
    lists = {}
    for year in years:
        for language in INDEX_URLS:
            issues = source_issues(indexes[year, language], language)
            lists[year, language] = {row["key"]: row for row in issues if row["year"] == year}
    en_map = {key: row for (year, lang), entries in lists.items() if lang == "en" for key, row in entries.items()}
    fr_map = {key: row for (year, lang), entries in lists.items() if lang == "fr" for key, row in entries.items()}
    en_issue_keys = set(en_map)
    fr_issue_keys = set(fr_map)
    issues = []
    for key in sorted(set(en_map) | set(fr_map)):
        left, right = en_map.get(key), fr_map.get(key)
        canonical = dict(left or right)
        canonical["missingLanguages"] = sorted(lang for lang, source in (("en", left), ("fr", right)) if source is None)
        canonical["missingFormatsEn"] = (left or {}).get("missingFormats", ["index-entry"] if left is None else [])
        canonical["missingFormatsFr"] = (right or {}).get("missingFormats", ["index-entry"] if right is None else [])
        identity_gaps = [row["sourceIdentityGap"] for row in (left, right) if row and row.get("sourceIdentityGap")]
        if identity_gaps:
            canonical["sourceIdentityGap"] = "; ".join(identity_gaps)
        if left and right and any(left[name] != right[name] for name in ("dateStart", "dateEnd")):
            canonical["sourceIdentityGap"] = f"Bilingual indexes disagree on date span for {key}"
        canonical["viewUrlFr"] = right.get("viewUrl") if right else None
        canonical["xmlUrlFr"] = right.get("xmlUrl") if right else None
        issues.append(canonical)
    issues.sort(key=lambda row: (row["dateStart"], row["key"]))
    en_map = {row["key"]: row for row in issues}
    cutoff_covered = any(not row.get("missingLanguages") and not row.get("sourceIdentityGap")
                         and row.get("dateStart") and date.fromisoformat(row["dateStart"]) <= BASE_DATE <= date.fromisoformat(row["dateEnd"])
                         for row in issues if row.get("dateEnd"))
    latest = issues[-1]
    base_db = ensure_base_index(base_root, root) if base_root and base_root.exists() else None
    if base_root and not base_root.exists():
        raise ValueError(f"Dated bibliography base snapshot is missing: {base_root}")
    now = datetime.now(timezone.utc)
    issue_observations = []
    failed = []
    deferred = []
    existing = _issue_version_index(root)
    missing_issues = [row for row in issues if row["key"] not in existing
                      or existing[row["key"]]["receipt"].get("recordSchema") != BILINGUAL_RECORD_SCHEMA]
    selected_missing = select_issue_work(missing_issues, latest["key"])
    work_keys = {row["key"] for row in selected_missing}
    for row in missing_issues:
        if row["key"] not in work_keys:
            deferred.append({"issue": row["key"], "dateStart": row["dateStart"], "dateEnd": row["dateEnd"],
                             "status": "deferred-new-work-cap"})
    source_format_gaps = [
        {"issue": row["key"], "language": lang, "missingFormats": row.get(f"missingFormats{lang.title()}", [])}
        for row in issues for lang in ("en", "fr")
        if row.get(f"missingFormats{lang.title()}")
    ]
    for issue in issues:
        key = issue["key"]
        old = existing.get(key)
        if issue.get("sourceIdentityGap"):
            failed.append({"issue": key, "dateStart": issue["dateStart"], "dateEnd": issue["dateEnd"],
                           "error": issue["sourceIdentityGap"]})
            issue_observations.append({"issue": key, "status": "failed-index-identity", "error": issue["sourceIdentityGap"]})
            continue
        if issue.get("missingLanguages"):
            failed.append({"issue": key, "dateStart": issue["dateStart"], "dateEnd": issue["dateEnd"],
                           "error": "Issue is not listed in both language indexes", "missingLanguages": issue["missingLanguages"]})
            issue_observations.append({"issue": key, "status": "failed-index-language-gap", "missingLanguages": issue["missingLanguages"]})
            continue
        if old is not None and key != latest["key"] and old["receipt"].get("recordSchema") == BILINGUAL_RECORD_SCHEMA:
            issue_observations.append({"issue": key, "status": "retained-existing", "version": old["version"],
                                       "sourceObservationAt": old["receipt"].get("firstObservedAt")})
            continue
        if old is None and key not in work_keys and key != latest["key"]:
            issue_observations.append({"issue": key, "status": "pending-new-work-cap"})
            continue
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            if key == latest["key"]:
                budget["limit"] = MAX_GENERATION_BYTES
            else:
                budget["limit"] = MAX_GENERATION_BYTES - (2 * MAX_XML_BYTES + 2 * MAX_ISSUE_HTML_BYTES)
            if "xml" in issue.get("missingFormatsEn", []) or "xml" in issue.get("missingFormatsFr", []):
                raise ValueError(f"The source index omitted the bilingual MARC XML link for issue {key}")
            resource_bodies = {}
            for language in ("en", "fr"):
                url = issue.get("xmlUrl") if language == "en" else issue.get("xmlUrlFr")
                if not url:
                    raise ValueError(f"The {language} MARC XML link is missing for issue {key}")
                name = f"issue-{issue['year']}-{issue['issue']}-{language}.xml"
                if download_live and old is not None and key != latest["key"] and old["receipt"].get("recordSchema") != BILINGUAL_RECORD_SCHEMA:
                    archived = old["receiptPath"].parent / "archives" / f"{language}.xml"
                    previous = old["receipt"]["resources"][language]
                    if not archived.is_file() or _sha_file(archived) != previous.get("sha256"):
                        raise ValueError(f"Archived {language} XML failed checksum verification for schema migration: {key}")
                    body = archived.read_bytes()
                    metadata = {"finalUrl": previous["url"], "fetchedAt": previous.get("fetchedAt"),
                                "etag": previous.get("etag"), "lastModified": previous.get("lastModified"),
                                "contentType": previous.get("contentType"), "contentLength": previous.get("contentLength")}
                elif download_live:
                    body, metadata = fetch(url, MAX_XML_BYTES, opener, budget)
                else:
                    path = input_dir / name
                    if not path.is_file():
                        raise ValueError(f"Missing replay issue source: {path}")
                    body = path.read_bytes()
                    if len(body) > MAX_XML_BYTES:
                        raise ValueError(f"Replay XML exceeds its size limit: {path}")
                    metadata = {"finalUrl": url, "fetchedAt": None, "replay": True}
                parsed = parse_marc_xml(body, language)
                resource_bodies[language] = {"body": body, "url": metadata["finalUrl"],
                    "fetchedAt": metadata.get("fetchedAt"), "bytes": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(), "etag": metadata.get("etag"),
                    "lastModified": metadata.get("lastModified"), "contentType": metadata.get("contentType"),
                    "contentLength": metadata.get("contentLength"), "records": parsed,
                    "replay": bool(metadata.get("replay", False))}
            en_records, fr_records = resource_bodies["en"]["records"], resource_bodies["fr"]["records"]
            rows, bilingual = reconcile_issue_records(issue, en_records, fr_records)
            issue["bilingualComparison"] = bilingual
            if bilingual["englishOnlyCatalogueIds"] or bilingual["frenchOnlyCatalogueIds"]:
                mismatch = {"issue": key, "status": "bilingual-catalogue-id-mismatch",
                    "englishOnlyCatalogueIds": bilingual["englishOnlyCatalogueIds"],
                    "frenchOnlyCatalogueIds": bilingual["frenchOnlyCatalogueIds"]}
                failed.append(mismatch)
            combined = _issue_version_id(issue, resource_bodies)
            if old and old["version"] == combined:
                for language in ("en", "fr"):
                    resource_bodies[language].pop("body", None)
                    resource_bodies[language].pop("records", None)
                issue_observations.append({"issue": key, "status": "unchanged", "version": combined,
                    "checkedAt": checked_at, "sourceObservationAt": old["receipt"].get("firstObservedAt"),
                    "resourceSha256": {lang: resource_bodies[lang]["sha256"] for lang in ("en", "fr")},
                    "bilingualComparison": bilingual})
            else:
                version, receipt_path = _publish_issue(root, issue, resource_bodies, rows, checked_at)
                info = {"issue": issue, "version": version, "receiptPath": receipt_path,
                        "receipt": json.loads(receipt_path.read_text(encoding="utf-8"))}
                existing[key] = info
                issue_observations.append({"issue": key, "status": "acquired" if old is None else "revised",
                    "version": version, "checkedAt": checked_at,
                    "resourceSha256": {lang: resource_bodies[lang]["sha256"] for lang in ("en", "fr")},
                    "bilingualComparison": bilingual})
        except (OSError, ValueError, HTTPError, ET.ParseError) as error:
            failed.append({"issue": key, "dateStart": issue["dateStart"], "dateEnd": issue["dateEnd"], "error": str(error)})
            issue_observations.append({"issue": key, "status": "failed", "checkedAt": checked_at, "error": str(error)})
    latest_views = {}
    for language, url in (("en", latest.get("viewUrl")), ("fr", latest.get("viewUrlFr"))):
        if not url:
            continue
        try:
            if download_live:
                body, metadata = fetch(url, MAX_ISSUE_HTML_BYTES, opener, budget)
            else:
                path = input_dir / f"issue-{latest['year']}-{latest['issue']}-{language}.html"
                if not path.is_file():
                    raise ValueError(f"Missing replay issue view: {path}")
                body = path.read_bytes()
                if len(body) > MAX_ISSUE_HTML_BYTES:
                    raise ValueError(f"Replay issue view exceeds its size limit: {path}")
                metadata = {"finalUrl": url, "fetchedAt": None, "replay": True}
            validate_issue_html(body, language, latest)
            latest_views[language] = {"body": body, "url": metadata["finalUrl"],
                "fetchedAt": metadata.get("fetchedAt"), "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(), "etag": metadata.get("etag"),
                "lastModified": metadata.get("lastModified"), "contentType": metadata.get("contentType"),
                "contentLength": metadata.get("contentLength"), "replay": bool(metadata.get("replay", False))}
        except (OSError, ValueError, HTTPError) as error:
            failed.append({"issue": latest["key"], "language": language, "status": "issue-view-fetch-failed", "error": str(error)})
    all_versions = _issue_version_index(root)
    all_version_history = _all_issue_versions(root)
    # Superseded parsed artifacts remain immutable and replayable, but parser-schema
    # migrations replace their interpretation in the current discovery aggregate.
    aggregate_versions = [item for item in all_version_history
                          if item["receipt"].get("recordSchema") == BILINGUAL_RECORD_SCHEMA]
    records = _aggregate_records(root, aggregate_versions, base_db)
    previous_records = root / "current" / "records.jsonl"
    previous_run_receipt = root / "current" / "receipt.json"
    try:
        previous_run = json.loads(previous_run_receipt.read_text(encoding="utf-8")) if previous_run_receipt.is_file() else None
    except (OSError, json.JSONDecodeError):
        previous_run = None
    schema_recomputed = bool(previous_run and previous_run.get("recordSchema") != BILINGUAL_RECORD_SCHEMA)
    previous_versions = set()
    if previous_records.is_file():
        for line in previous_records.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            previous_versions.add((row.get("catalogueId"), row.get("fingerprint")))
    additions = {(row["catalogueId"], row["fingerprint"]) for row in records} - previous_versions
    ids = {row["catalogueId"] for row in records}
    variants = {}
    for row in records:
        variants.setdefault(row["catalogueId"], set()).add(row["fingerprint"])
    base_presence = {}
    for row in records:
        previous_value = base_presence.get(row["catalogueId"])
        value = row["presentInBaseSnapshot"]
        base_presence[row["catalogueId"]] = value if previous_value is None else previous_value
    latest_info = all_versions.get(latest["key"])
    latest_success = bool(latest_info)
    if latest_success:
        issue_root = issue_directory(root, latest_info["issue"])
        latest_target = issue_root / "versions" / latest_info["version"]
        latest_target_issue = latest["key"]
    else:
        previous_latest = root / "current" / "latest"
        latest_target = previous_latest.resolve() if previous_latest.is_symlink() else None
        try:
            latest_target_issue = json.loads((latest_target / "receipt.json").read_text(encoding="utf-8"))["issue"]["key"] if latest_target else None
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            latest_target_issue = None
    freshness_age = (now.date() - date.fromisoformat(latest["dateEnd"])).days
    freshness = "fresh" if 0 <= freshness_age <= 14 else "future-dated" if freshness_age < 0 else "stale"
    run_id = f"{now.strftime('%Y%m%dT%H%M%S')}-{os.urandom(4).hex()}"
    run_staging = Path(tempfile.mkdtemp(prefix=".run-stage-", dir=root))
    try:
        archives_dir = run_staging / "indexes"
        archives_dir.mkdir()
        index_resources = {}
        for name, (url, body, metadata) in fetched_meta.items():
            _write_file(archives_dir / name, body)
            index_resources[name] = {"url": url, "fetchedAt": metadata.get("fetchedAt"), "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(), "contentType": metadata.get("contentType"),
                "contentLength": metadata.get("contentLength"), "etag": metadata.get("etag"),
                "lastModified": metadata.get("lastModified"), "replay": bool(metadata.get("replay", False))}
        view_dir = run_staging / "latest-views"
        view_dir.mkdir()
        view_resources = {}
        for language, item in latest_views.items():
            _write_file(view_dir / f"{language}.html", item["body"])
            view_resources[language] = {key: value for key, value in item.items() if key != "body"}
        with (run_staging / "records.jsonl").open("x", encoding="utf-8") as output:
            for row in records:
                output.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())
        aggregate_records_sha = _sha_file(run_staging / "records.jsonl")
        observed_keys = set(en_map)
        retained_unindexed = sorted(set(all_versions) - observed_keys)
        base_unique = None
        if base_db:
            with sqlite3.connect(base_db) as db:
                base_unique = db.execute("SELECT count(*) FROM ids").fetchone()[0]
        all_gaps = failed + deferred + [{"status": "missing-source-format", **gap} for gap in source_format_gaps]
        if not cutoff_covered:
            all_gaps.append({"status": "cutoff-span-not-indexed", "baseSnapshotDate": BASE_DATE.isoformat(),
                             "message": "No bilingual weekly issue date range spans the dated bulk base snapshot cutoff."})
        receipt = {
            "schemaVersion": 3, "recordSchema": BILINGUAL_RECORD_SCHEMA,
            "series": "government-publications-weekly-acquisitions-list",
            "publisher": "Public Services and Procurement Canada / Government of Canada Publications",
            "status": "complete" if not all_gaps and latest_success else "partial",
            "attemptedAt": now.isoformat(), "runId": run_id, "baseSnapshotDate": BASE_DATE.isoformat(),
            "indexes": index_resources, "latestViewPages": view_resources,
            "recordsSha256": aggregate_records_sha, "aggregateRecordCount": len(records),
            "range": {"firstIssue": issues[0]["key"], "firstIssueDateEnd": issues[0]["dateEnd"],
                      "latestIssue": latest["key"], "latestIssueDateEnd": latest["dateEnd"],
                      "officialIssuesIndexed": len(issues), "issuesListedEnglish": len(en_issue_keys),
                      "issuesListedFrench": len(fr_issue_keys), "issueVersionsAvailable": len(all_versions),
                      "immutableIssueVersionCount": len(all_version_history),
                      "baseCutoffSpanFound": cutoff_covered,
                      "latestPublishedPointerIssue": latest_target_issue},
            "freshness": {"latestIssueAgeDays": freshness_age, "status": freshness, "policyDays": 14,
                          "sourceIndexFetchedAt": max((item.get("fetchedAt") for item in index_resources.values() if item.get("fetchedAt")), default=None),
                          "meaning": "Publication age uses the latest issue's publisher end date. Replays preserve original source fetch times separately; the run attempt time does not change publication age."},
            "counts": {"uniqueCatalogueIdsInChecklistIssues": len(ids), "distinctChecklistRecordVersions": len(records),
                       "versionsNewSincePreviousRun": None if schema_recomputed else len(additions),
                       "recordVersionsRecomputedForSchemaChange": len(records) if schema_recomputed else 0,
                       "catalogueIdsPresentInBaseSnapshot": sum(1 for value in base_presence.values() if value is True) if base_db else None,
                       "catalogueIdsAbsentFromBaseSnapshot": sum(1 for value in base_presence.values() if value is False) if base_db else None,
                       "baseSnapshotUniqueCatalogueIds": base_unique,
                       "idsWithMultipleMetadataVersions": sum(1 for values in variants.values() if len(values) > 1)},
            "issueObservations": issue_observations,
            "networkBytesDownloaded": budget["bytes"] if download_live else 0,
            "networkByteBudget": MAX_GENERATION_BYTES if download_live else 0,
            "newIssueWorkLimitPerRun": MAX_NEW_ISSUES_PER_RUN,
            "issueVersions": {key: info["version"] for key, info in all_versions.items()},
            "issueVersionHistory": {key: sorted(info["version"] for info in all_version_history if info["issue"]["key"] == key)
                                    for key in sorted({info["issue"]["key"] for info in all_version_history})},
            "gaps": all_gaps,
            "preservedPreviouslyCapturedIssuesNotListedNow": retained_unindexed,
            "coverage": {"issueScope": "Every bilingual issue listed from the issue spanning the November 20, 2025 base cutoff through the current latest year index; latest issue is rechecked each run.",
                         "additiveSemantics": "Issue records and metadata versions are retained additively. Repeated catalogue IDs are deduplicated by ID plus MARC-content fingerprint; differing fingerprints remain separate versions. No deletion or overwrite is inferred.",
                         "publicationBodies": "No linked publication full texts were fetched; the MARC checklist is discovery metadata only.",
                         "publicationMetadataRecordVariants": {"recordVariants": len(records),
                             "withCorporateNames": sum(bool(row["corporateNames"]) for row in records),
                             "withIssuingBodies": sum(bool(row["issuingBodies"]) for row in records),
                             "withPublisherEvidence": sum(bool(row["publishers"]) for row in records),
                             "withPublicationStatements": sum(bool(row["publicationStatements"]) for row in records),
                             "withPublicationLinks856": sum(bool(row["publicationLinks"]) for row in records)},
                         "publisherAttribution": "264 second-indicator 1 publisher subfields and explicitly publisher-role-coded 110/710 entries are retained as publisher evidence. Other 264 functions and 260 imprints remain role-labelled statements, not asserted publishers. Controlfield 003 is the cataloging agency and is never assigned as publisher.",
                         "recordFields": "MARC 001/003 identity, 245 title, 008/041 language, related editions, and 590 notes are retained with 110/710 corporate entries and role terms/codes, all 260/264 statements and functions, and 856 URLs, formats, labels, and notes.",
                         "checklist590FieldsObserved": sum(len(row["checklistNotes590"]) for row in records),
                         "checklist590Gap": "The November 2026 latest issue had no 590 fields; older issue 590 values, when present, are retained in per-issue records."},
        }
        _write_file(run_staging / "receipt.json", (json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())
        _fsync_dir(archives_dir)
        _fsync_dir(view_dir)
        if latest_target:
            final = root / "runs" / run_id
            os.symlink(os.path.relpath(latest_target, final), run_staging / "latest")
        _fsync_dir(run_staging)
        runs = root / "runs"
        runs.mkdir(exist_ok=True)
        final = runs / run_id
        os.replace(run_staging, final)
        _fsync_dir(runs)
        _atomic_current(root, f"runs/{run_id}")
        print(json.dumps({"published": True, "status": receipt["status"], "receipt": str((final / "receipt.json").resolve()),
                          "latestIssue": latest["key"], "freshness": receipt["freshness"],
                          "range": receipt["range"], "counts": receipt["counts"], "gaps": all_gaps}, ensure_ascii=False, indent=2))
        return receipt
    except BaseException:
        shutil.rmtree(run_staging, ignore_errors=True)
        raise


def replay(root: Path):
    """Verify the latest immutable backfill run without replacing source-observation timestamps."""
    receipt_path = root / "current" / "receipt.json"
    if not receipt_path.is_file():
        raise ValueError("No completed or partial backfill run is available to replay")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    expected_pointer_issue = receipt.get("range", {}).get("latestPublishedPointerIssue")
    latest_receipt_path = root / "current" / "latest" / "receipt.json"
    if expected_pointer_issue:
        if not latest_receipt_path.is_file():
            raise ValueError("Published latest issue pointer is missing or broken")
        latest_receipt = json.loads(latest_receipt_path.read_text(encoding="utf-8"))
        if latest_receipt.get("issue", {}).get("key") != expected_pointer_issue:
            raise ValueError("Published latest issue pointer does not match the run receipt")
    for name, expected in receipt.get("indexes", {}).items():
        archive = root / "current" / "indexes" / name
        if not archive.is_file() or _sha_file(archive) != expected["sha256"]:
            raise ValueError(f"Archived publisher index failed checksum verification: {name}")
    verified = 0
    version_history = receipt.get("issueVersionHistory") or {key: [value] for key, value in receipt.get("issueVersions", {}).items()}
    for issue_key, versions in version_history.items():
        year, week = issue_key.split("-", 1)
        for version in versions:
            issue_receipt_path = root / "issues" / year / week / "versions" / version / "receipt.json"
            if not issue_receipt_path.is_file():
                raise ValueError(f"Archived issue version is missing for {issue_key}")
            issue_receipt = json.loads(issue_receipt_path.read_text(encoding="utf-8"))
            if issue_receipt.get("version") != version:
                raise ValueError(f"Archived issue receipt identity mismatch for {issue_key}")
            for language in ("en", "fr"):
                archive = issue_receipt_path.parent / "archives" / f"{language}.xml"
                if not archive.is_file() or _sha_file(archive) != issue_receipt["resources"][language]["sha256"]:
                    raise ValueError(f"Archived issue XML failed checksum verification: {issue_key} {language}")
            records_path = issue_receipt_path.parent / "records.jsonl"
            if not records_path.is_file() or _sha_file(records_path) != issue_receipt.get("recordsSha256"):
                raise ValueError(f"Parsed record artifact failed checksum verification: {issue_key}")
            record_schema = issue_receipt.get("recordSchema", "paired-marc-v2")
            parsed = {lang: parse_marc_xml((issue_receipt_path.parent / "archives" / f"{lang}.xml").read_bytes(), lang, record_schema)
                      for lang in ("en", "fr")}
            rows = [json.loads(line) for line in records_path.read_text(encoding="utf-8").splitlines()]
            if len(rows) != issue_receipt["counts"].get("recordVariantsRetained", issue_receipt["counts"]["uniqueCatalogueIds"]):
                raise ValueError(f"Parsed record count mismatch for issue {issue_key}")
            for row in rows:
                languages = row.get("listedIn", ["en", "fr"])
                if any(parsed[language].get(row["catalogueId"], {}).get("fingerprint") != row["fingerprint"]
                       for language in languages):
                    raise ValueError(f"Parsed record content mismatch for issue {issue_key} ID {row['catalogueId']} ({','.join(languages)})")
            represented = {(row["catalogueId"], row["fingerprint"], language)
                           for row in rows for language in row.get("listedIn", ["en", "fr"])}
            expected = {(identifier, item["fingerprint"], language)
                        for language in ("en", "fr") for identifier, item in parsed[language].items()}
            if represented != expected:
                raise ValueError(f"Parsed record artifact omits or invents a language-specific record for {issue_key}")
            verified += 1
    for language, expected in receipt.get("latestViewPages", {}).items():
        archive = root / "current" / "latest-views" / f"{language}.html"
        if not archive.is_file() or _sha_file(archive) != expected["sha256"]:
            raise ValueError(f"Latest issue view page failed checksum verification: {language}")
    records_path = root / "current" / "records.jsonl"
    if not records_path.is_file() or _sha_file(records_path) != receipt.get("recordsSha256"):
        raise ValueError("Aggregated checklist record artifact failed checksum verification")
    result = {"replayedAt": datetime.now(timezone.utc).isoformat(), "status": receipt["status"],
        "sourceRunAttemptedAt": receipt["attemptedAt"], "latestIssue": receipt["range"]["latestIssue"],
        "freshness": receipt["freshness"], "verifiedIssues": verified, "gaps": receipt.get("gaps", [])}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def inspect(root: Path):
    receipt = root / "current" / "receipt.json"
    if not receipt.is_file():
        raise ValueError(f"No complete issue generation at {root / 'current'}")
    run = json.loads(receipt.read_text(encoding="utf-8"))
    latest_receipt = root / "current" / "latest" / "receipt.json"
    latest = json.loads(latest_receipt.read_text(encoding="utf-8")) if latest_receipt.is_file() else None
    print(json.dumps({"run": run, "publishedLatestIssue": latest}, ensure_ascii=False, indent=2))


def record_failed_attempt(root: Path, error: Exception):
    root.mkdir(parents=True, exist_ok=True)
    attempts = root / "attempts"
    attempts.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc)
    current_receipt = root / "current" / "receipt.json"
    last_good = None
    if current_receipt.is_file():
        try:
            prior = json.loads(current_receipt.read_text(encoding="utf-8"))
            last_good = {"runId": prior.get("runId"), "latestIssue": prior.get("range", {}).get("latestPublishedPointerIssue")}
        except (OSError, json.JSONDecodeError):
            pass
    name = f"{stamp.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}.json"
    content = {"status": "failed-before-publish", "attemptedAt": stamp.isoformat(),
               "error": str(error), "lastGood": last_good}
    _write_file(attempts / name, (json.dumps(content, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())
    _fsync_dir(attempts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("refresh", "inspect", "replay"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--base-root", type=Path, default=DEFAULT_BASE_ROOT)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--download", action="store_true", help="fetch current indexes and any missing/new bilingual issues")
    source.add_argument("--input-dir", type=Path, help="replay fixture inputs named index-YEAR-lang.html and issue-YEAR-YY-WW-lang.xml")
    args = parser.parse_args()
    if args.action == "inspect":
        inspect(args.root)
        return
    if args.action == "replay":
        replay(args.root)
        return
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            receipt = refresh(args.root, args.download, args.input_dir, args.base_root)
        except (ValueError, OSError, HTTPError, ET.ParseError, sqlite3.Error, zipfile.BadZipFile) as error:
            record_failed_attempt(args.root, error)
            raise
        if receipt["status"] != "complete":
            sys.exit(f"Checklist backfill published with {len(receipt['gaps'])} source gaps; inspect {args.root / 'current' / 'receipt.json'}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, HTTPError, ET.ParseError, sqlite3.Error, zipfile.BadZipFile) as error:
        sys.exit(str(error))
