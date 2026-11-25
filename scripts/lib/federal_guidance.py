"""Bounded bilingual inventory of Treasury Board and IRCC guidance indexes."""
from __future__ import annotations

from datetime import datetime, timezone
from collections import Counter
import fcntl
from hashlib import sha256
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from urllib.parse import parse_qs, urljoin, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import committee_files

REGISTER = Path(__file__).resolve().parents[2] / "docs/evidence/2026-11-23/federal-public-service-sources.csv"
SOURCE_CACHE = Path(__file__).resolve().parents[2] / "data/corpus/federal-source-inventory"
DEFAULT_ROOT = Path("data/corpus/federal-guidance")

TB_LANDING = {
    "en": "https://www.tbs-sct.canada.ca/pol/index-eng.aspx",
    "fr": "https://www.tbs-sct.canada.ca/pol/index-fra.aspx",
}
IRCC_LANDING = {
    "en": "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/operational-bulletins-manuals.html",
    "fr": "https://www.canada.ca/fr/immigration-refugies-citoyennete/organisation/publications-guides/bulletins-guides-operationnels.html",
}
TB_PATHS = {
    ("current", "en"): "a-z-eng.aspx",
    ("inactive", "en"): "arch-eng.aspx",
    ("current", "fr"): "a-z-fra.aspx",
    ("inactive", "fr"): "arch-fra.aspx",
}
EXPECTED_TB = {f"https://www.tbs-sct.canada.ca/pol/{path}" for path in TB_PATHS.values()}


class Anchors(HTMLParser):
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.current = None
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.current = {"href": dict(attrs).get("href"), "text": []}

    def handle_data(self, data):
        if self.current is not None:
            self.current["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            href = self.current["href"]
            if href:
                target = urljoin(self.base_url, href)
                if urlsplit(target).scheme == "https":
                    self.links.append({"url": target, "label": " ".join("".join(self.current["text"]).split())})
            self.current = None


class TableInventory(HTMLParser):
    """Keep table row cells, headings, and linked citations from source indexes."""
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.headings = []
        self.heading_text = None
        self.table = 0
        self.table_caption = None
        self.caption_text = None
        self.row = None
        self.cell = None
        self.anchor = None
        self.rows = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"h1", "h2", "h3", "h4"}:
            self.heading_text = [tag, []]
        elif tag == "table":
            self.table += 1
            self.table_caption = None
        elif tag == "caption":
            self.caption_text = []
        elif tag == "tr" and self.table:
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = {"text": [], "links": []}
        elif tag == "a" and self.cell is not None and attrs.get("href"):
            self.anchor = {"url": urljoin(self.base_url, attrs["href"]), "label": []}
        if tag == "br" and self.cell is not None:
            self.cell["text"].append(" ")

    def handle_data(self, data):
        if self.heading_text is not None:
            self.heading_text[1].append(data)
        if self.caption_text is not None:
            self.caption_text.append(data)
        if self.cell is not None:
            self.cell["text"].append(data)
        if self.anchor is not None:
            self.anchor["label"].append(data)

    def handle_endtag(self, tag):
        if tag in {"h1", "h2", "h3", "h4"} and self.heading_text is not None:
            level, parts = self.heading_text
            text = " ".join("".join(parts).split())
            if text:
                self.headings.append({"level": level, "text": text})
            self.heading_text = None
        elif tag == "caption" and self.caption_text is not None:
            self.table_caption = " ".join("".join(self.caption_text).split())
            self.caption_text = None
        elif tag == "a" and self.anchor is not None:
            label = " ".join("".join(self.anchor["label"]).split())
            link = {"url": self.anchor["url"], "label": label}
            self.cell["links"].append(link)
            self.anchor = None
        elif tag in {"td", "th"} and self.cell is not None:
            self.cell["text"] = " ".join("".join(self.cell["text"]).split())
            self.row.append(self.cell)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            cells = self.row
            if cells and any(c["text"] or c["links"] for c in cells):
                self.rows.append({
                    "section": self.headings[-1] if self.headings else None,
                    "table_caption": self.table_caption,
                    "cells": [c["text"] for c in cells],
                    "text": " | ".join(c["text"] for c in cells if c["text"]),
                    "links": [link for c in cells for link in c["links"]],
                })
            self.row = None
        elif tag == "table" and self.table:
            self.table -= 1


def parse_tbs(body: bytes, url: str, status: str, language: str):
    parser = Anchors(url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    entries = []
    for link in parser.links:
        parsed = urlsplit(link["url"])
        if not re.search(r"(?:^|/)doc-(?:eng|fra)\.aspx$", parsed.path, re.I):
            continue
        policy_id = parse_qs(parsed.query).get("id", [None])[0]
        if not policy_id or not link["label"]:
            continue
        entries.append({"policy_id": policy_id, "label": link["label"], "status": status,
                        "language": language, "source_index": url, "citation_url": link["url"]})
    if not entries:
        raise ValueError(f"No policy document IDs and labels found in {url}")
    return entries


def parse_ircc(body: bytes, url: str, language: str):
    parser = TableInventory(url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    rows = []
    for source_row in parser.rows:
        links = source_row["links"]
        if not links:
            continue
        text = source_row["text"]
        paths = " ".join(link["url"] for link in links)
        kinds = []
        if any(re.search(r"/bulletins?-\d+|/bulletins/", link["url"], re.I) for link in links):
            kinds.append("operational-bulletin")
        if any(re.search(r"\.pdf(?:$|\?)", link["url"], re.I) for link in links):
            kinds.append("manual-or-guidance-pdf")
        if any(not re.search(r"\.pdf(?:$|\?)|/bulletins?-\d+|/bulletins/", link["url"], re.I) for link in links):
            kinds.append("program-guidance-or-other-index-entry")
        kind = kinds[0] if len(kinds) == 1 else "combined"
        rows.append({"language": language, "kind": kind, "kinds": kinds,
                     "topic": source_row["cells"][0] if source_row["cells"] else None,
                     "titles": [link["label"] for link in links if link["label"]],
                     "section": source_row["section"],
                     "table_caption": source_row["table_caption"], "cells": source_row["cells"],
                     "nearby_text": text, "citations": links, "source_index": url})
    if not rows:
        raise ValueError(f"No linked table rows found in IRCC index {url}")
    return rows


def _get_cached(root: Path, url: str, source_root: Path | None = None):
    candidates = [Path(root)]
    if source_root:
        candidates.append(Path(source_root))
    for candidate in candidates:
        db = committee_files.cache_db(candidate)
        try:
            row = db.execute("SELECT * FROM files WHERE url=?", (url,)).fetchone()
            if row and row["digest"] and not row["error"]:
                body = committee_files.read_object(candidate, row["digest"])
                return {"url": url, "sha256": row["digest"], "bytes": row["size"],
                        "checked": row["checked"], "final_url": row["final_url"],
                        "archive": str(committee_files.object_path(candidate, row["digest"])), "body": body}
        finally:
            db.close()
    raise ValueError(f"Official index is not present in local archive: {url}")


def _landing_link(url: str, source_root: Path):
    item = _get_cached(source_root, url)
    anchors = Anchors(item["final_url"] or url)
    anchors.feed(item["body"].decode("utf-8-sig", errors="replace"))
    return item, anchors.links


def atomic_write(path: Path, body: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def build_inventory(root: Path, refresh: bool = True, observed_at: str | None = None):
    root = Path(root)
    source_root = SOURCE_CACHE
    landing = {}
    tb_links = {}
    for language, url in TB_LANDING.items():
        landing[f"tbs-{language}"], links = _landing_link(url, source_root)
        tb_links[language] = links
    child_urls = {}
    for (status, language), relative in TB_PATHS.items():
        target = urljoin(TB_LANDING[language], relative)
        if target not in {item["url"] for item in tb_links[language]}:
            raise ValueError(f"Expected TBS index was not linked by its landing page: {target}")
        child_urls[(status, language)] = target

    root.mkdir(parents=True, exist_ok=True)
    if refresh:
        committee_files.capture(root, sorted(set(child_urls.values())), workers=2, refresh=True)
    indexes = {}
    records = []
    for (status, language), url in child_urls.items():
        item = _get_cached(root, url)
        entries = parse_tbs(item["body"], item["final_url"] or url, status, language)
        indexes[f"tbs-{status}-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
        records.extend(entries)

    for language, url in IRCC_LANDING.items():
        item = _get_cached(source_root, url)
        entries = parse_ircc(item["body"], item["final_url"] or url, language)
        indexes[f"ircc-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
        records.extend(entries)
        landing[f"ircc-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}

    # Summarize TBS language parity without hiding records that occur in only one index.
    tb_maps = {}
    for status in ("current", "inactive"):
        langmaps = {}
        for language in ("en", "fr"):
            langmaps[language] = {r["policy_id"]: r["label"] for r in records
                                  if isinstance(r, dict) and r.get("status") == status and r.get("language") == language}
        tb_maps[status] = langmaps
    tb_summary = {}
    for status, languages in tb_maps.items():
        en_ids, fr_ids = set(languages["en"]), set(languages["fr"])
        tb_summary[status] = {
            "en_unique_policy_ids": len(languages["en"]), "fr_unique_policy_ids": len(languages["fr"]),
            "en_index_entries": sum(r.get("status") == status and r.get("language") == "en" and "policy_id" in r for r in records),
            "fr_index_entries": sum(r.get("status") == status and r.get("language") == "fr" and "policy_id" in r for r in records),
            "shared_policy_ids": len(en_ids & fr_ids),
            "english_only_ids": sorted(en_ids - fr_ids), "french_only_ids": sorted(fr_ids - en_ids),
            "duplicate_policy_id_entries": {
                language: {policy_id: count for policy_id, count in Counter(
                    r["policy_id"] for r in records if r.get("status") == status
                    and r.get("language") == language and "policy_id" in r
                ).items() if count > 1}
                for language in ("en", "fr")
            },
        }
    ircc_records = [r for r in records if "nearby_text" in r]
    ircc_summary = {}
    for language in ("en", "fr"):
        subset = [r for r in ircc_records if r["language"] == language]
        ircc_summary[language] = {
            "linked_table_rows": len(subset),
            "by_kind": {kind: sum(kind in r["kinds"] for r in subset)
                        for kind in sorted({kind for r in subset for kind in r["kinds"]})},
            "op8_rows": [r for r in subset if re.search(r"\bOP\s*8\b", r["nearby_text"], re.I)],
        }
    op8 = {lang: ircc_summary[lang]["op8_rows"] for lang in ("en", "fr")}
    pdfs = {lang: [citation for row in op8[lang] for citation in row["citations"]
                   if urlsplit(citation["url"]).path.lower().endswith(".pdf")]
            for lang in ("en", "fr")}
    pdf_label_variants = {}
    for language, citations in pdfs.items():
        by_url = {}
        for citation in citations:
            by_url.setdefault(citation["url"], set()).add(citation["label"])
        pdf_label_variants[language] = {url: sorted(labels) for url, labels in by_url.items()}
    current_time = observed_at or datetime.now(timezone.utc).isoformat()
    tbs_landing_refs = {key: {k: value[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
                        for key, value in landing.items() if key.startswith("tbs-")}
    report = {
        "collection": "federal-guidance-indexes",
        "observed_at": current_time,
        "source_register_sha256": sha256(REGISTER.read_bytes()).hexdigest(),
        "sources": {**tbs_landing_refs, **{key: value for key, value in landing.items() if key.startswith("ircc-")}, **indexes},
        "tbs": {"indexes": {key: value for key, value in indexes.items() if key.startswith("tbs-")},
                "status_counts_and_language_parity": tb_summary,
                "coverage_note": "Current A–Z and inactive instruments are separate page states. Policy entries contain source IDs, labels, status, and links only; policy document bodies were not fetched."},
        "ircc": {"indexes": {key: value for key, value in indexes.items() if key.startswith("ircc-")},
                 "summary": {lang: {k: v for k, v in values.items() if k != "op8_rows"} for lang, values in ircc_summary.items()},
                 "op8_supporting_pdfs": pdfs,
                 "op8_pdf_label_variants_by_url": pdf_label_variants,
                 "op8_timing": {lang: rows for lang, rows in op8.items()},
                 "op8_timing_limitations": [
                     "The cutoff is stated on the current landing-page snapshot and describes historical applicability; no 2017-era page or PDF revision was acquired.",
                     "The same PDF URLs have differing displayed sizes: English 488.13/489 KB and French 5.81/580 Ko. PDF bodies were not archived, so index size labels are not independently reconciled.",
                 ],
                 "coverage_note": "The indexed landing pages are archived; linked manuals, bulletins, and program instruction bodies were not crawled. The OP 8 timing statements and PDF link labels below are reproduced from the index rows."},
        "records": records,
    }
    inventory_bytes = (json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    digest = sha256(inventory_bytes).hexdigest()
    inventory_path = root / "inventories" / f"{digest}.json"
    if inventory_path.exists() and sha256(inventory_path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"Corrupt immutable inventory: {inventory_path}")
    if not inventory_path.exists():
        atomic_write(inventory_path, inventory_bytes)
    receipt = {key: value for key, value in report.items() if key != "records"}
    receipt["record_count"] = len(records)
    receipt["inventory"] = {"path": str(inventory_path), "sha256": digest, "bytes": len(inventory_bytes)}
    receipt_bytes = (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode()
    atomic_write(root / "dist" / "receipt.json", receipt_bytes)
    report["inventory"] = receipt["inventory"]
    return report


def replay(root: Path):
    receipt = json.loads((Path(root) / "dist" / "receipt.json").read_text(encoding="utf-8"))
    return build_inventory(Path(root), refresh=False, observed_at=receipt.get("observed_at"))


def find_records(root: Path, query: str, limit: int = 20):
    receipt_path = Path(root) / "dist" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    inventory = receipt["inventory"]
    path = Path(inventory["path"])
    body = path.read_bytes()
    if sha256(body).hexdigest() != inventory["sha256"]:
        raise ValueError("Federal guidance inventory checksum mismatch")
    document = json.loads(body)
    needle = query.casefold().strip()
    if not needle:
        raise ValueError("Search query must not be empty")
    results = []
    for record in document.get("records", []):
        haystack = json.dumps(record, ensure_ascii=False).casefold()
        if needle in haystack:
            results.append(record)
            if len(results) >= max(1, limit):
                break
    return results
