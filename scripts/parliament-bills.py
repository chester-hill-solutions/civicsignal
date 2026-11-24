#!/usr/bin/env python3
"""Acquire the bilingual LEGISinfo bills catalogue for a Parliament session.

Source of truth: Parliament of Canada LEGISinfo's official language-specific
JSON exports, cross-checked against the session result count on each catalogue
page. Record URLs point back to each language's official bill detail page.
"""
import argparse
from datetime import datetime, timezone
import json
import re
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


from lib.parliament_intake import archive_inventory, save_atomic


BASE = "https://www.parl.ca/legisinfo"
LANGUAGES = {
    "en": {"path": "en/bills", "detail": "en/bill"},
    "fr": {"path": "fr/projets-de-loi", "detail": "fr/projet-de-loi"},
}
FIELD_SUFFIX = {"en": "En", "fr": "Fr"}
RESULTS = re.compile(
    r"(?:Results|Résultats)\s*([\d,]+)\s*[-–]\s*([\d,]+)\s*(?:of|sur|de)\s*([\d,]+)",
    re.IGNORECASE,
)
FIRST_READING_FIELDS = (
    "PassedHouseFirstReadingDateTime",
    "PassedSenateFirstReadingDateTime",
)


def fetch(url):
    """Fetch an official LEGISinfo resource with bounded retries."""
    last_error = None
    for attempt in range(4):
        try:
            request = Request(url, headers={"User-Agent": "CivicSignal Parliament bills intake/1.0"})
            with urlopen(request, timeout=45) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status} from {url}")
                return response.read()
        except (OSError, URLError, RuntimeError) as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(attempt + 1)
    raise RuntimeError(f"Official source fetch failed after retries: {url}: {last_error}")


def _count(value):
    return int(value.replace(",", ""))


def page_total(session, language, fetcher=None):
    page_url = f"{BASE}/{LANGUAGES[language]['path']}"
    html = (fetcher or fetch)(page_url).decode("utf-8-sig", errors="replace")
    match = RESULTS.search(html)
    if not match:
        raise ValueError(f"Could not read the official result total from {page_url}")
    first, last, total = map(_count, match.groups())
    if first != 1 or last < first or total < last:
        raise ValueError(f"Invalid or incomplete official result range in {page_url}: {match.group(0)}")
    return total


def validate_inventory_rows(session, language, data, source_url="official export"):
    if not isinstance(data, list) or not data:
        raise ValueError(f"Official export is empty or not a JSON array: {source_url}")

    expected_parliament, expected_session = map(int, session.split("-"))
    seen = set()
    bill_ids = set()
    for item in data:
        if not isinstance(item, dict):
            raise ValueError(f"Non-object row in official export {source_url}")
        if (item.get("ParliamentNumber"), item.get("SessionNumber")) != (expected_parliament, expected_session):
            raise ValueError(f"Unexpected session row in official export {source_url}")
        if type(item.get("Id")) is not int or item["Id"] <= 0:
            raise ValueError(f"Invalid official bill ID in {source_url}")
        number = item.get("NumberCode")
        if not isinstance(number, str) or not re.fullmatch(r"[CS]-\d+", number, re.IGNORECASE):
            raise ValueError(f"Invalid bill number in official export {source_url}: {number!r}")
        key = number.lower()
        if key in seen:
            raise ValueError(f"Duplicate bill number in official export {source_url}: {number}")
        if item["Id"] in bill_ids:
            raise ValueError(f"Duplicate official bill ID in {source_url}")
        bill_ids.add(item["Id"])
        seen.add(key)
        for field in (f"LongTitle{FIELD_SUFFIX[language]}", f"StatusName{FIELD_SUFFIX[language]}"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError(f"Missing {field} for {number} in {source_url}")
    return data


def source_inventory(session, language, fetcher=None):
    export_url = f"{BASE}/{LANGUAGES[language]['path']}/json"
    try:
        data = json.loads((fetcher or fetch)(export_url).decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid JSON from official export {export_url}: {exc}") from exc
    return validate_inventory_rows(session, language, data, export_url)


def first_reading_date(item):
    """Return the UTC calendar date of the official first-reading timestamp."""
    values = []
    for field in FIRST_READING_FIELDS:
        value = item.get(field)
        if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", value):
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            values.append(timestamp.astimezone(timezone.utc).date().isoformat())
    return min(values) if values else None


def build_records(session, inventories):
    by_language = {}
    for language, inventory in inventories.items():
        by_language[language] = {item["NumberCode"].lower(): item for item in inventory}
    if not by_language["en"] or set(by_language["en"]) != set(by_language["fr"]):
        raise ValueError("English and French LEGISinfo exports have different bill inventories")

    records = []
    for language in ("en", "fr"):
        detail_path = LANGUAGES[language]["detail"]
        for key in sorted(by_language[language], key=lambda value: (value[0], int(value[2:]))):
            item = by_language[language][key]
            title = item[f"LongTitle{FIELD_SUFFIX[language]}"].strip()
            summary = item[f"StatusName{FIELD_SUFFIX[language]}"].strip() or title
            fact_fields = ("Id", "StatusNameEn", "StatusNameFr", "LongTitleEn", "LongTitleFr", *FIRST_READING_FIELDS)
            if any(item.get(field) != by_language["en"][key].get(field) for field in fact_fields):
                raise ValueError(f"Conflicting bilingual bill metadata for {key}")
            records.append({
                "key": key,
                "language": language,
                "title": title,
                "summary": summary,
                "details": {"kind": "bill", "legisInfoId": item["Id"], "status": summary},
                "date": first_reading_date(item),
                "url": f"{BASE}/{detail_path}/{session}/{key}",
            })
    identities = [(row["key"], row["language"]) for row in records]
    if len(identities) != len(set(identities)):
        raise ValueError("Duplicate bill/language record in constructed catalogue")
    return records


def acquire(session, fetcher=None):
    if not re.fullmatch(r"\d+-\d+", session):
        raise ValueError(f"Invalid session identifier: {session!r}")
    inventories = {language: source_inventory(session, language, fetcher) for language in LANGUAGES}
    totals = {language: page_total(session, language, fetcher) for language in LANGUAGES}
    lengths = {language: len(inventory) for language, inventory in inventories.items()}
    if totals != lengths:
        raise ValueError(f"Catalogue page totals do not match complete JSON exports: pages={totals}, exports={lengths}")
    records = build_records(session, inventories)
    if len(records) != 2 * totals["en"]:
        raise ValueError("Bilingual catalogue is incomplete")
    return {
        "session": session,
        "collection": "bills",
        "observedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True, help="Parliament session identifier, for example 45-1")
    parser.add_argument("--output", required=True, help="Output JSON path")
    args = parser.parse_args()
    payload = archive_inventory(args.output, args.session, acquire, fetch)
    counts = {language: sum(row["language"] == language for row in payload["records"]) for language in LANGUAGES}
    print(f"Wrote {len(payload['records'])} records for {args.session} to {args.output} ({counts})")


if __name__ == "__main__":
    main()
