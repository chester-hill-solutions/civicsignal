"""Bounded bilingual inventory of Treasury Board and IRCC guidance indexes."""
from __future__ import annotations

from datetime import datetime, timezone
from collections import Counter
import gzip
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
from urllib.parse import parse_qs, urldefrag, urljoin, urlsplit

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
MAX_IRCC_JSON_BYTES = 4 * 1024 * 1024
MAX_ARCHIVED_SOURCE_BYTES = 8 * 1024 * 1024
IRCC_JSON_TABLES = {"pdi-table": ("pdi", "data"), "pdu-table": ("pdu", "pdu")}


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


class JsonDataTables(HTMLParser):
    """Read official JSON data URLs directly from the archived IRCC landing page."""
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.heading = None
        self.heading_text = None
        self.tables = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"h1", "h2", "h3", "h4"}:
            self.heading_text = [tag, []]
        if tag == "table" and attrs.get("data-wb-json"):
            try:
                config = json.loads(attrs["data-wb-json"])
            except json.JSONDecodeError as error:
                raise ValueError("IRCC data-wb-json table has invalid JSON configuration") from error
            raw_url = config.get("url") if isinstance(config, dict) else None
            if not isinstance(raw_url, str) or not raw_url:
                raise ValueError("IRCC data-wb-json table lacks its data URL")
            self.tables.append({"tableId": attrs.get("id"), "url": urljoin(self.base_url, raw_url),
                                "heading": self.heading, "config": config})

    def handle_data(self, data):
        if self.heading_text is not None:
            self.heading_text[1].append(data)

    def handle_endtag(self, tag):
        if tag in {"h1", "h2", "h3", "h4"} and self.heading_text is not None:
            level, parts = self.heading_text
            text = " ".join("".join(parts).split())
            self.heading = {"level": level, "text": text} if text else self.heading
            self.heading_text = None


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
        links = [link for link in source_row["links"] if not _template_value(link["label"])
                 and urldefrag(link["url"])[0] != urldefrag(url)[0]
                 and committee_files.official(link["url"])]
        if not links:
            continue
        text = source_row["text"]
        if _template_value(text):
            continue
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
    return rows


def _template_value(value) -> bool:
    return isinstance(value, str) and bool(re.search(r"\[\[[^\]]+\]\]", value))


def parse_ircc_json_sources(body: bytes, url: str, language: str) -> dict[str, dict]:
    if language not in ("en", "fr"):
        raise ValueError("IRCC JSON source language must be en or fr")
    parser = JsonDataTables(url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    expected = {"pdi-table": ("pdi", "data"), "pdu-table": ("pdu", "pdu")}
    found = {}
    for table in parser.tables:
        table_id = table["tableId"]
        if table_id not in expected:
            continue
        kind, pointer = expected[table_id]
        if table_id in found:
            raise ValueError(f"Duplicate IRCC JSON data table: {table_id}")
        source_url, fragment = urldefrag(table["url"])
        parsed = urlsplit(source_url)
        expected_name = f"{kind}-{language}.json"
        if (parsed.scheme != "https" or parsed.hostname != "www.canada.ca" or parsed.query or
                parsed.path.rsplit("/", 1)[-1].lower() != expected_name or fragment != f"/{pointer}"):
            raise ValueError(f"Unexpected {language} IRCC JSON data source for {table_id}")
        found[table_id] = {"dataset": kind, "language": language, "tableId": table_id,
                           "url": source_url, "pointer": pointer, "fragmentUrl": table["url"],
                           "tableHeading": table["heading"], "configuration": table["config"]}
    if set(found) != set(expected):
        raise ValueError(f"Archived {language} IRCC index lacks the official PDI and PDU JSON data links")
    return found


def parse_ircc_json(body: bytes, source_data_url: str, source_data_sha256: str,
                    source_index: str, source_index_sha256: str, language: str,
                    dataset: str, pointer: str) -> tuple[list[dict], dict]:
    if len(body) > MAX_IRCC_JSON_BYTES or sha256(body).hexdigest() != source_data_sha256:
        raise ValueError("IRCC JSON data failed its byte limit or SHA-256 check")
    document = json.loads(body)
    if not isinstance(document, dict) or not isinstance(document.get(pointer), list):
        raise ValueError(f"IRCC {dataset} source does not contain its published {pointer} array")
    raw_rows = document[pointer]
    expected_fields = {"pdi": ("PageTitle", "Link", "Label", "Date"),
                       "pdu": ("category", "link", "title", "date")}
    required = expected_fields[dataset]
    rows = []
    placeholders = 0
    for source_row in raw_rows:
        if not isinstance(source_row, dict) or any(_template_value(value) for value in source_row.values()):
            placeholders += 1
            continue
        if any(key not in source_row for key in required):
            raise ValueError(f"IRCC {dataset} source row does not match the published schema")
        title_key = "PageTitle" if dataset == "pdi" else "title"
        link_key = "Link" if dataset == "pdi" else "link"
        title = source_row.get(title_key)
        href = source_row.get(link_key)
        if not isinstance(title, str) or not title.strip() or not isinstance(href, str) or href.strip() in ("", "#"):
            placeholders += 1
            continue
        citation_url = urljoin(source_index, href.strip())
        parsed = urlsplit(citation_url)
        target_path = parsed.path.lower()
        if (not committee_files.official(citation_url) or parsed.hostname != "www.canada.ca" or
                not any(marker in target_path for marker in ("/en/immigration-refugees-citizenship/",
                                                              "/fr/immigration-refugies-citoyennete/"))):
            raise ValueError(f"IRCC {dataset} source contains a citation outside official IRCC content")
        citation_language = "en" if "/en/immigration-refugees-citizenship/" in target_path else "fr"
        kind = "program-delivery-instruction" if dataset == "pdi" else "program-delivery-update"
        topic = source_row.get("Label") if dataset == "pdi" else source_row.get("category")
        cells = [str(value).strip() for value in source_row.values() if isinstance(value, (str, int, float))]
        rows.append({"language": language, "kind": kind, "kinds": [kind],
                     "topic": topic, "titles": [title.strip()], "section": {"level": "table", "text": dataset.upper()},
                     "table_caption": "Program Delivery Instructions" if dataset == "pdi" else "Program Delivery Updates",
                     "cells": cells, "citations": [{"url": citation_url, "label": title.strip(),
                                                      "language": citation_language}],
                     "source_index": source_index, "source_index_sha256": source_index_sha256,
                     "source_data_url": source_data_url, "source_data_sha256": source_data_sha256,
                     "source_data_pointer": pointer, "source_data_record": source_row})
    if not rows:
        raise ValueError(f"IRCC {dataset} JSON source has no non-template records")
    return rows, {"rawRows": len(raw_rows), "publishedRecords": len(rows), "excludedTemplateRows": placeholders}


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
                        "checked": row["checked"], "final_url": row["final_url"], "media": row["media"],
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
    data_sources = {}
    data_counts = {}
    for (status, language), url in child_urls.items():
        item = _get_cached(root, url)
        entries = parse_tbs(item["body"], item["final_url"] or url, status, language)
        indexes[f"tbs-{status}-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
        records.extend(entries)

    ircc_pages = {}
    json_specs = {}
    for language, url in IRCC_LANDING.items():
        item = _get_cached(source_root, url)
        index_url = item["final_url"] or url
        entries = parse_ircc(item["body"], index_url, language)
        indexes[f"ircc-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
        records.extend(entries)
        landing[f"ircc-{language}"] = {k: item[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
        ircc_pages[language] = item
        json_specs[language] = parse_ircc_json_sources(item["body"], index_url, language)

    json_urls = sorted({spec["url"] for values in json_specs.values() for spec in values.values()})
    if refresh:
        committee_files.capture(root, json_urls, workers=2, refresh=True)
    for language, specs in json_specs.items():
        index_item = ircc_pages[language]
        index_url = index_item["final_url"] or index_item["url"]
        for spec in sorted(specs.values(), key=lambda value: value["dataset"]):
            source = _get_cached(root, spec["url"])
            if source["media"] != "application/json":
                raise ValueError(f"IRCC {spec['dataset']} source returned {source['media']}")
            if source["bytes"] > MAX_IRCC_JSON_BYTES:
                raise ValueError(f"IRCC {spec['dataset']} source exceeds the JSON byte limit")
            key = f"ircc-json-{spec['dataset']}-{language}"
            data_sources[key] = {k: source[k] for k in ("url", "sha256", "bytes", "checked", "final_url", "archive")}
            parsed, counts = parse_ircc_json(source["body"], source["url"], source["sha256"],
                                             index_url, index_item["sha256"], language,
                                             spec["dataset"], spec["pointer"])
            records.extend(parsed)
            data_counts[key] = counts

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
    ircc_json_records = [r for r in records if "source_data_url" in r]
    ircc_summary = {}
    for language in ("en", "fr"):
        subset = [r for r in ircc_records if r["language"] == language]
        ircc_summary[language] = {
            "linked_table_rows": len(subset),
            "by_kind": {kind: sum(kind in r["kinds"] for r in subset)
                        for kind in sorted({kind for r in subset for kind in r["kinds"]})},
            "op8_rows": [r for r in subset if re.search(r"\bOP\s*8\b", r["nearby_text"], re.I)],
            "structured_data_records": sum(r["language"] == language for r in ircc_json_records),
            "structured_data_by_kind": {kind: sum(r["language"] == language and r["kind"] == kind
                                                   for r in ircc_json_records)
                                         for kind in sorted({r["kind"] for r in ircc_json_records})},
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
        "sources": {**tbs_landing_refs, **{key: value for key, value in landing.items() if key.startswith("ircc-")}, **indexes, **data_sources},
        "tbs": {"indexes": {key: value for key, value in indexes.items() if key.startswith("tbs-")},
                "status_counts_and_language_parity": tb_summary,
                "coverage_note": "Current A–Z and inactive instruments are separate page states. Policy entries contain source IDs, labels, status, and links only; policy document bodies were not fetched."},
        "ircc": {"indexes": {key: value for key, value in indexes.items() if key.startswith("ircc-")},
                 "dataSources": data_sources, "dataSourceCounts": data_counts,
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


def _read_source_archive(source: dict, root: Path, maximum: int = MAX_ARCHIVED_SOURCE_BYTES) -> bytes:
    path = Path(source.get("archive", "")).resolve()
    allowed_roots = (Path(root).resolve(), SOURCE_CACHE.resolve())
    if not path.is_file() or not any(base == path or base in path.parents for base in allowed_roots):
        raise ValueError("Federal guidance source archive path is outside its local caches")
    with gzip.open(path, "rb") as stream:
        body = stream.read(maximum + 1)
    if len(body) > maximum or len(body) != source.get("bytes") or sha256(body).hexdigest() != source.get("sha256"):
        raise ValueError(f"Archived federal guidance source failed byte length or SHA-256: {source.get('url')}")
    return body


def replay(root: Path):
    root = Path(root)
    receipt = json.loads((root / "dist" / "receipt.json").read_text(encoding="utf-8"))
    inventory = receipt.get("inventory", {})
    inventory_path = Path(inventory.get("path", ""))
    raw = inventory_path.read_bytes()
    if sha256(raw).hexdigest() != inventory.get("sha256") or len(raw) != inventory.get("bytes"):
        raise ValueError("Federal guidance immutable inventory checksum mismatch")
    report = json.loads(raw)
    if report.get("collection") != "federal-guidance-indexes":
        raise ValueError("Federal guidance inventory has the wrong collection identity")
    sources = report.get("sources", {})
    archived = {key: _read_source_archive(source, root) for key, source in sources.items()}
    for key, source in sources.items():
        if key.startswith("ircc-json-") and source.get("bytes", 0) > MAX_IRCC_JSON_BYTES:
            raise ValueError(f"Archived {key} exceeds the IRCC JSON byte limit")
    json_sources = {key: source for key, source in sources.items() if key.startswith("ircc-json-")}
    if json_sources:
        expected_keys = {f"ircc-json-{dataset}-{language}" for dataset in ("pdi", "pdu") for language in ("en", "fr")}
        if set(json_sources) != expected_keys:
            raise ValueError("Federal guidance inventory must contain all four archived IRCC JSON sources")
        records = report.get("records", [])
        for language, landing_url in IRCC_LANDING.items():
            landing_key = f"ircc-{language}"
            landing_source = sources.get(landing_key)
            if not landing_source or landing_source.get("url") != landing_url:
                raise ValueError(f"Federal guidance inventory lacks the official {language} IRCC landing page")
            specs = parse_ircc_json_sources(archived[landing_key], landing_source.get("final_url") or landing_url, language)
            for spec in specs.values():
                key = f"ircc-json-{spec['dataset']}-{language}"
                source = sources[key]
                if source.get("url") != spec["url"]:
                    raise ValueError(f"Archived {language} landing page and JSON source URL disagree")
                parsed, _ = parse_ircc_json(archived[key], source["url"], source["sha256"],
                                            landing_source.get("final_url") or landing_url, landing_source["sha256"],
                                            language, spec["dataset"], spec["pointer"])
                recorded = [row for row in records if row.get("source_data_url") == source["url"]]
                if recorded != parsed:
                    raise ValueError(f"Archived {key} records differ from deterministic source replay")
    report["inventory"] = inventory
    return report


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
