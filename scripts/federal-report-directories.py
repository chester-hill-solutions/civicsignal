#!/usr/bin/env python3
"""Build a small bilingual directory from registered federal report indexes."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import fcntl
from hashlib import sha256
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib import committee_files  # noqa: E402

REGISTER = ROOT / "docs/evidence/2026-11-23/federal-public-service-sources.csv"
DEFAULT_ROOT = ROOT / "data/corpus/federal-report-directories"
SOURCE_CACHE = ROOT / "data/corpus/federal-source-inventory"
FAMILIES = ("departmental-plans", "departmental-results", "regulatory-plans")
MAX_REFRESH_BYTES = 12 * 1024 * 1024
MIN_FREE_BYTES = 64 * 1024 * 1024
MAX_INDEX_BYTES = 2 * 1024 * 1024
GENERIC_LABELS = {
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "français fr", "english en", "top of page", "skip to main content", "archived reports",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normal(value: str) -> str:
    return " ".join((value or "").casefold().replace("’", "'").split())


class PageLinks(HTMLParser):
    """Keep labelled links and their publisher heading/list context."""

    schemes = {"https"}

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.links: list[dict] = []
        self.directory_links: list[dict] = []
        self.main_depth = 0
        self.list_depth = 0
        self.in_directory = False
        self.heading: dict | None = None
        self.current_heading: str | None = None
        self.anchor: dict | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "main" or attrs.get("role") == "main":
            self.main_depth += 1
        if tag == "li":
            self.list_depth += 1
        if tag in {"h1", "h2", "h3", "h4", "h5"}:
            self.heading = {"tag": tag, "parts": []}
        if tag == "a" and attrs.get("href"):
            self.anchor = {"url": urljoin(self.base_url, attrs["href"]), "parts": []}

    def handle_data(self, data):
        if self.heading is not None:
            self.heading["parts"].append(data)
        if self.anchor is not None:
            self.anchor["parts"].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            label = " ".join("".join(self.anchor["parts"]).split())
            url = self.anchor["url"]
            item = {"label": label, "url": url, "heading": self.current_heading}
            if label and urlsplit(url).scheme in self.schemes:
                self.links.append(item)
                if self.in_directory and self.list_depth and normal(label) not in GENERIC_LABELS:
                    self.directory_links.append(item)
            self.anchor = None
        if tag in {"h1", "h2", "h3", "h4", "h5"} and self.heading is not None:
            heading = " ".join("".join(self.heading["parts"]).split())
            level = int(self.heading["tag"][1])
            self.current_heading = heading or self.current_heading
            if normal(heading) in {"list of institutions", "liste des institutions", "liste des organismes"}:
                self.in_directory = True
            elif self.in_directory and level <= 2 and normal(heading) in {
                "related links", "about this page", "about this site", "détails de la page", "à propos de ce site",
            }:
                self.in_directory = False
            self.heading = None
        if tag == "li" and self.list_depth:
            self.list_depth -= 1
        if tag == "main" and self.main_depth:
            self.main_depth -= 1


class RegulatorDirectoryLinks(PageLinks):
    """Only institution links inside the publisher’s alphabetical lists."""

    schemes = {"http", "https"}

    def handle_endtag(self, tag):
        super().handle_endtag(tag)
        if tag in {"h1", "h2", "h3", "h4", "h5", "section", "main"}:
            self.in_directory = tag == "h3" and bool(self.main_depth) and bool(re.fullmatch(
                r"(?:institutions starting with the letter|les institutions débutant par la lettre) [a-z]",
                normal(self.current_heading or "")))


def regulator_directories(root, tbs_pages):
    labels = {"en": "Government-wide regulatory plans and reports",
              "fr": "Plans et rapports prospectifs à l’échelle du gouvernement"}
    urls = {}
    for lang, page in tbs_pages.items():
        parser = PageLinks(page["finalUrl"] or page["url"])
        parser.feed(page["body"].decode("utf-8-sig"))
        links = {item["url"] for item in parser.links
                 if normal(item["label"]) == normal(labels[lang]) and committee_files.official(item["url"])}
        if len(links) != 1:
            raise ValueError(f"Cannot identify one government-wide regulatory index in the {lang} edition")
        urls[lang], = links
    committee_files.capture(root, list(urls.values()), workers=2, refresh=True)
    pages = {lang: cached_page(root, url) for lang, url in urls.items()}
    entries = []
    for lang, page in pages.items():
        parser = RegulatorDirectoryLinks(page["finalUrl"] or page["url"])
        parser.feed(page["body"].decode("utf-8-sig"))
        links = sorted({(item["label"], item["url"]) for item in parser.directory_links})
        if not links:
            raise ValueError(f"The {lang} regulatory directory has no labelled institutional links")
        for label, url in links:
            entries.append({"issuerLabel": label, "language": lang, "url": url,
                            "sourceIndexUrl": page["url"], "sourceIndexSha256": page["sha256"]})
    return pages, entries


def verified_labelled_links(parser: PageLinks) -> list[dict]:
    unique = {}
    for item in parser.directory_links:
        if committee_files.official(item["url"]):
            unique[(item["label"], item["url"])] = item
    return sorted(unique.values(), key=lambda item: (normal(item["label"]), item["url"]))


REG_PLAN_RE = re.compile(r"\bForward Regulatory Plan\s*:?\s*(\d{4})\s*(?:to|[-–—])\s*(\d{4})\b", re.I)
REG_STOCK_RE = re.compile(r"\bRegulatory Stock Review Plan\s*:?\s*(\d{4})\s*(?:to|[-–—])\s*(\d{4})\b", re.I)
REG_PLAN_FR_RE = re.compile(r"\bPlan prospectif de la réglementation\s*:?\s*(?:de\s+)?(\d{4})\s*(?:à|[-–—])\s*(\d{4})\b", re.I)
REG_STOCK_FR_RE = re.compile(r"\bPlan d’examen de l’inventaire des règlements\s*:?\s*(?:de\s+)?(\d{4})\s*(?:à|[-–—])\s*(\d{4})\b", re.I)


def current_regulatory_links(parser: PageLinks, language: str) -> list[dict]:
    patterns = (("forward-regulatory-plan", REG_PLAN_RE if language == "en" else REG_PLAN_FR_RE),
                ("regulatory-stock-review", REG_STOCK_RE if language == "en" else REG_STOCK_FR_RE))
    output = []
    for family, pattern in patterns:
        matches = []
        for item in parser.links:
            match = pattern.search(item["label"])
            if match and committee_files.official(item["url"]):
                matches.append((int(match.group(1)), int(match.group(2)), item))
        if matches:
            start, end, item = max(matches, key=lambda value: (value[0], value[1]))
            output.append({**item, "cycle": f"{start}-{end}", "cycleFamily": family})
    return output


def cached_page(root: Path, url: str) -> dict:
    db = committee_files.cache_db(root)
    try:
        row = db.execute("SELECT * FROM files WHERE url=?", (url,)).fetchone()
        if not row or row["error"] or not row["digest"]:
            raise ValueError(f"No verified archive for {url}: {(row and row['error']) or 'not captured'}")
        if row["size"] > MAX_INDEX_BYTES:
            raise ValueError(f"Index exceeds {MAX_INDEX_BYTES} byte per-page limit: {url}")
        body = committee_files.read_object(root, row["digest"])
        if sha256(body).hexdigest() != row["digest"] or len(body) != row["size"]:
            raise ValueError(f"Index source hash or byte length mismatch: {url}")
        if not committee_files.official(row["final_url"] or url):
            raise ValueError(f"Index resolved outside official publication hosts: {url}")
        return {"url": url, "finalUrl": row["final_url"], "sha256": row["digest"],
                "bytes": row["size"], "observedAt": row["checked"],
                "archive": str(committee_files.object_path(root, row["digest"])), "body": body}
    finally:
        db.close()


def language_url(page: dict) -> str | None:
    parser = PageLinks(page["finalUrl"] or page["url"])
    parser.feed(page["body"].decode("utf-8-sig", errors="replace"))
    return language_url_from_links(parser)


def language_url_from_links(parser: PageLinks) -> str | None:
    for item in parser.links:
        if normal(item["label"]) in {"français fr", "français"} and committee_files.official(item["url"]):
            return item["url"]
        if normal(item["label"]) in {"english en", "english"} and committee_files.official(item["url"]):
            return item["url"]
    return None


def source_ref(page: dict) -> dict:
    return {key: page[key] for key in ("url", "finalUrl", "sha256", "bytes", "archive")}


def _read_register(path: Path) -> dict[str, dict]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = {row["series_key"]: row for row in csv.DictReader(handle)}
    missing = set(FAMILIES) - set(rows)
    if missing:
        raise ValueError("Source register is missing families: " + ", ".join(sorted(missing)))
    for key in FAMILIES:
        if not committee_files.official(rows[key]["entry_url"]):
            raise ValueError(f"Registered index is not an official HTTPS URL: {key}")
    return rows


def _issuer_identity(records: list[dict], roster_path: Path) -> None:
    """Assign safe bilingual groups from published legal-name aliases where available."""
    aliases: dict[str, set[str]] = {}
    try:
        with roster_path.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                identity = f"schedule-{row['schedule']}-ordinal-{row['schedule_ordinal']}"
                for field in ("legal_name_en", "legal_name_fr", "tbs_table_name_en"):
                    if row.get(field):
                        aliases.setdefault(normal(row[field]), set()).add(identity)
        publisher_path = roster_path.with_name("federal-public-service-publisher-names.csv")
        with publisher_path.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                target = aliases.get(normal(row.get("legal_name_en", "")), set())
                for field in ("psc_published_name_en", "tbs_name_via_psc"):
                    if row.get(field) and target:
                        aliases.setdefault(normal(row[field]), set()).update(target)
    except OSError:
        aliases = {}
    for record in records:
        matches = aliases.get(normal(record["issuerLabel"]), set())
        record["issuerKey"] = next(iter(matches)) if len(matches) == 1 else None
        record["issuerAttribution"] = "registered-legal-name-alias" if len(matches) == 1 else "publisher-link-label"
    # The same issuer often publishes its English and French directories on one
    # official host. Use host pairing only when that host appears once per language.
    host_counts: dict[tuple[str, str], int] = {}
    for record in records:
        host = (urlsplit(record["url"]).hostname or "").casefold()
        record["issuerHost"] = host
        key = (host, record["language"])
        host_counts[key] = host_counts.get(key, 0) + 1
    for record in records:
        if record["issuerKey"]:
            continue
        host = record["issuerHost"]
        if host != "www.canada.ca" and all(host_counts.get((host, lang)) == 1 for lang in ("en", "fr")):
            record["issuerKey"] = "official-host:" + host
            record["issuerAttribution"] = "unique-official-publisher-host"
        record.pop("issuerHost", None)


def _pair_bilingual(records: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    label_counts: dict[tuple[str, str], int] = {}
    for record in records:
        key = (normal(record["issuerLabel"]), record["language"])
        label_counts[key] = label_counts.get(key, 0) + 1
    for record in records:
        key = record.get("issuerKey")
        if not key:
            label_key = normal(record["issuerLabel"])
            if all(label_counts.get((label_key, lang)) == 1 for lang in ("en", "fr")):
                key = "label:" + label_key
            else:
                key = "unmatched:" + record["language"] + ":" + sha256(
                    (label_key + "\n" + record["url"]).encode("utf-8")).hexdigest()[:16]
        groups.setdefault(key, []).append(record)
    issuers = []
    for key, entries in sorted(groups.items()):
        by_language: dict[str, list[dict]] = {"en": [], "fr": []}
        for entry in entries:
            by_language[entry["language"]].append(entry)
        issuer_labels = {lang: sorted({item["issuerLabel"] for item in values}) for lang, values in by_language.items()}
        issuers.append({"issuerKey": entries[0].get("issuerKey"), "issuerLabel": issuer_labels,
                        "bilingualMatch": bool(by_language["en"] and by_language["fr"]),
                        "editions": entries})
    return issuers


def cycle_coverage(records: list[dict]) -> dict:
    per_language = {
        lang: {(row["cycleFamily"], row["cycle"]) for row in records if row["language"] == lang}
        for lang in ("en", "fr")
    }
    shared = per_language["en"] & per_language["fr"]
    return {"currentCycles": len(per_language["en"] | per_language["fr"]),
            "bilingualCurrentCycles": len(shared),
            "englishOnlyCycles": [{"family": family, "cycle": cycle} for family, cycle in sorted(per_language["en"] - per_language["fr"])],
            "frenchOnlyCycles": [{"family": family, "cycle": cycle} for family, cycle in sorted(per_language["fr"] - per_language["en"])]}


def build(root: Path = DEFAULT_ROOT, register: Path = REGISTER) -> dict:
    start_bytes = tree_bytes(root)
    free = shutil.disk_usage(root).free
    if free < MAX_REFRESH_BYTES + MIN_FREE_BYTES:
        raise RuntimeError(f"need {MAX_REFRESH_BYTES + MIN_FREE_BYTES} bytes free to keep {MIN_FREE_BYTES} bytes reserved")
    root.mkdir(parents=True, exist_ok=True)
    rows = _read_register(register)
    english_urls = [rows[key]["entry_url"] for key in FAMILIES]
    committee_files.capture(root, english_urls, workers=2, refresh=True)
    english_pages = {key: cached_page(root, rows[key]["entry_url"]) for key in FAMILIES}

    french_urls = {key: language_url(page) for key, page in english_pages.items()}
    for key, url in french_urls.items():
        if not url:
            raise ValueError(f"The registered current {key} index does not link its French edition")
    all_urls = sorted(set(french_urls.values()))
    committee_files.capture(root, all_urls, workers=2, refresh=True)
    french_pages = {key: cached_page(root, french_urls[key]) for key in FAMILIES}

    source_refs = {}
    families = {}
    roster = ROOT / "docs/evidence/2026-11-23/federal-public-service-roster.csv"
    for key in ("departmental-plans", "departmental-results"):
        editions = []
        for lang, page in (("en", english_pages[key]), ("fr", french_pages[key])):
            parser = PageLinks(page["finalUrl"] or page["url"])
            parser.feed(page["body"].decode("utf-8-sig", errors="replace"))
            links = verified_labelled_links(parser)
            if not links:
                raise ValueError(f"No verified labelled issuer links found in {key}/{lang}")
            source = source_ref(page)
            source_refs[f"{key}-{lang}"] = source
            for item in links:
                editions.append({"language": lang, "issuerLabel": item["label"], "indexHeading": item["heading"],
                                 "url": item["url"], "sourceIndexUrl": page["url"],
                                 "sourceIndexSha256": page["sha256"]})
        _issuer_identity(editions, roster)
        issuers = _pair_bilingual(editions)
        counts = {lang: sum(item["language"] == lang for item in editions) for lang in ("en", "fr")}
        families[key] = {"counts": {"linkedIssuersByLanguage": counts,
                                     "uniqueIssuerGroups": len(issuers),
                                     "bilingualIssuerGroups": sum(item["bilingualMatch"] for item in issuers)},
                         "issuers": issuers}

    regulatory_records = []
    cycle_keys = set()
    for lang, page in (("en", english_pages["regulatory-plans"]), ("fr", french_pages["regulatory-plans"])):
        parser = PageLinks(page["finalUrl"] or page["url"])
        parser.feed(page["body"].decode("utf-8-sig", errors="replace"))
        current = current_regulatory_links(parser, lang)
        if not current:
            raise ValueError(f"No current labelled regulatory plan links found in {lang} index")
        source_refs[f"regulatory-plans-{lang}"] = source_ref(page)
        for item in current:
            cycle_keys.add((item["cycleFamily"], item["cycle"]))
            regulatory_records.append({"issuerLabel": "Treasury Board of Canada Secretariat" if lang == "en" else "Secrétariat du Conseil du Trésor du Canada",
                                      "issuerKey": "treasury-board-of-canada-secretariat", "issuerAttribution": "publisher-index-owner",
                                      "language": lang, "cycleFamily": item["cycleFamily"], "cycle": item["cycle"],
                                      "linkLabel": item["label"], "url": item["url"],
                                      "sourceIndexUrl": page["url"], "sourceIndexSha256": page["sha256"]})
    reg_issuers = _pair_bilingual(regulatory_records)
    national_pages, regulator_links = regulator_directories(root, {"en": english_pages["regulatory-plans"],
                                                                   "fr": french_pages["regulatory-plans"]})
    for lang, page in national_pages.items():
        source_refs[f"regulatory-directories-{lang}"] = source_ref(page)
    cycle_summary = cycle_coverage(regulatory_records)
    families["regulatory-plans"] = {"counts": {**cycle_summary,
                                                 "governmentWideDirectoryLinksByLanguage": {
                                                     lang: sum(item["language"] == lang for item in regulator_links)
                                                     for lang in national_pages},
                                                 "linksByLanguage": {lang: sum(r["language"] == lang for r in regulatory_records) for lang in ("en", "fr")},
                                                 "issuerGroups": len(reg_issuers),
                                                 "bilingualIssuerGroups": sum(i["bilingualMatch"] for i in reg_issuers)},
                                    "issuers": reg_issuers,
                                    "institutionDirectoryLinks": regulator_links,
                                    "coverageNote": "Plan cycles refer to TBS. The government-wide directory lists institutional regulatory pages. Each link retains its publisher label and directory citation."}

    inventory = {"collection": "federal-report-directories",
                 "sourceRegisterSha256": sha256(register.read_bytes()).hexdigest(),
                 "sourceArchives": source_refs,
                 "families": families,
                 "scope": "Publisher-labelled issuer index links only. Linked issuer report pages and full plan documents were not fetched."}
    encoded = (json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    digest = sha256(encoded).hexdigest()
    inventories = root / "inventories"
    inventories.mkdir(exist_ok=True)
    inventory_path = inventories / f"{digest}.json"
    if not inventory_path.exists():
        atomic_write(inventory_path, encoded)
    footprint = tree_bytes(root)
    if footprint - start_bytes > MAX_REFRESH_BYTES:
        raise RuntimeError(f"federal report directory capture exceeded {MAX_REFRESH_BYTES} new bytes")
    receipt = {"collection": inventory["collection"], "observedAt": utc_now(),
               "sourceRegisterSha256": inventory["sourceRegisterSha256"], "inventoryPath": os.path.relpath(inventory_path, ROOT),
               "inventorySha256": digest, "inventoryBytes": len(encoded), "corpusBytes": footprint,
               "diskFreeBytesAtStart": free,
               "sourceCaptureTimes": {key: page["observedAt"] for key, page in {
                   **{f"{key}-en": page for key, page in english_pages.items()},
                   **{f"{key}-fr": page for key, page in french_pages.items()},
                   **{f"regulatory-directories-{lang}": page for lang, page in national_pages.items()},
               }.items()},
               "familyCounts": {key: value["counts"] for key, value in families.items()}}
    atomic_write(root / "dist" / "receipt.json", (json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode())
    inventory["receipt"] = receipt
    return inventory


def tree_bytes(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def atomic_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args(argv)
    args.root.mkdir(parents=True, exist_ok=True)
    lock_path = args.root / "run.lock"
    try:
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            inventory = build(args.root)
        receipt_path = args.root / "dist" / "receipt.json"
        print(json.dumps({"receipt": os.path.relpath(receipt_path, ROOT), "families": inventory["receipt"]["familyCounts"],
                          "corpusBytes": inventory["receipt"]["corpusBytes"], "ok": True}, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, RuntimeError, ValueError) as error:
        print(f"federal-report-directories: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
