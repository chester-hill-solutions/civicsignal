"""Materialize pinned Cloudflare discovery observations for the native catalogue consumers."""
from contextlib import closing
import csv
from datetime import datetime, timezone
import gzip
import io
import json
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import unquote, urlsplit

APP = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(APP / "scripts"))
from lib import committee_files  # noqa: E402
from lib.federal_catalogue import describe, source_endpoints  # noqa: E402
from lib.federal_guidance import IRCC_LANDING, TB_LANDING, atomic_write  # noqa: E402
from lib.hosted_federal_bulk import DISCOVERY, csv_identity, require, verified  # noqa: E402

REGISTER = APP / "docs/evidence/2026-11-23/federal-public-service-sources.csv"
DATASETS = {"ati-summaries": "0797e893-751e-4695-8229-a5066e4fe43c", "grant-awards": "432527ab-7aac-45b5-81d6-7597107a7013"}
PUBLICATIONS = "30f7114d-4b3f-4201-8dc7-0d71eb769617"
REPORT_DIRECTORIES = ("departmental-plans", "departmental-results", "regulatory-plans")
DIRECTORY_ORIGINS = "report-directory-origins.json"


def _catalogue_row(read, packet, series, dataset, scheduled):
    url = "https://open.canada.ca/data/api/action/package_show?id=" + dataset
    item, = (e for e in packet["endpoints"] if (e["series"], e["endpoint"]) == (series, "entry_url"))
    require(item["url"] == url, "Unexpected CKAN observation for " + series)
    source, _, normalized = _catalogue_source(read, packet, item, scheduled, dataset)
    observation = (series, "entry_url", source["observedAt"], source["sha256"], url,
                   json.dumps(normalized, ensure_ascii=False, sort_keys=True))
    return observation, normalized


def _catalogue_source(read, packet, item, scheduled, dataset=None):
    url = item["url"]
    source, = (s for s in packet["sources"] if s["url"] == url)
    require(item["ok"] is True and source["status"] == 200 and "failure" not in source,
            "Missing required catalogue observation for " + url)
    final_url = source["finalUrl"]
    final = urlsplit(final_url)
    require(committee_files.official(final_url) and final.port in (None, 443) and not final.fragment,
            "Unexpected catalogue publisher destination for " + url)
    stamp = datetime.fromisoformat(source["observedAt"])
    require(stamp.utcoffset() is not None and stamp >= scheduled, "Catalogue request predates its scheduled occurrence")
    extension = "json" if dataset else "html"
    raw = verified(read, source, f"{DISCOVERY}/sources/{source['sha256']}.{extension}", 4 * 1024 * 1024)
    normalized = describe(raw, final_url, dataset)
    require(normalized == item["inventory"], "Archived catalogue differs from the discovery packet: " + url)
    return source, raw, normalized


def _guidance_sources(read, packet, scheduled):
    urls = set(TB_LANDING.values()) | set(IRCC_LANDING.values())
    items = [item for item in packet["endpoints"] if item["url"] in urls]
    require({item["url"] for item in items} == urls, "Missing IRCC or Treasury Board guidance indexes")
    return [_catalogue_source(read, packet, item, scheduled)[:2] for item in items]


def _report_directory_sources(read, packet, scheduled):
    return {item["series"]: _catalogue_source(read, packet, item, scheduled)[:2]
            for item in packet["endpoints"] if item["series"] in REPORT_DIRECTORIES and item["endpoint"] == "entry_url"}


def _cache_original(cache, source, raw):
    path = committee_files.object_path(cache, source["sha256"])
    if not path.exists():
        atomic_write(path, gzip.compress(raw, mtime=0))
    require(committee_files.read_object(cache, source["sha256"]) == raw, "Cached index differs from the hosted original")


def _write_guidance_cache(cache, guidance):
    rows = []
    for source, raw in guidance:
        _cache_original(cache, source, raw)
        rows.append((source["url"], source["sha256"], "text/html", source["bytes"], None,
                     source["observedAt"], source["finalUrl"]))
    with closing(committee_files.cache_db(cache)) as db:
        committee_files.checkpoint(db, rows)


def _csv_resources(series, dataset, normalized):
    selected = []
    for resource in normalized["resources"]:
        require(isinstance(resource["format"], str), "Missing CKAN resource format")
        if resource["format"].upper() == "CSV":
            identity = csv_identity(dataset, resource)
            filename = unquote(urlsplit(identity["url"]).path.rsplit("/", 1)[-1], errors="strict")
            require(not any(c in filename for c in "/\\?#") and not any(ord(c) < 32 or ord(c) == 127 for c in filename),
                    "Invalid CSV filename")
            selected.append(identity["resourceId"])
    require(selected and len(selected) == len(set(selected)), "Empty or duplicate CSV selection: " + series)
    return selected


def prepare_bulk_inputs(workspace, object_read, discovery_ref):
    """Verify pinned register inputs before materializing the scratch index and originals."""
    key = discovery_ref["key"]
    match = re.fullmatch(re.escape(DISCOVERY) + r"/runs/(federal-discovery-([1-9]\d{0,12}))[.]json", key)
    require(match is not None, "Expected a dated federal discovery receipt reference")
    receipt = json.loads(verified(object_read, discovery_ref, key, 8192))
    instance, scheduled_ms = match[1], int(match[2])
    scheduled = datetime.fromtimestamp(scheduled_ms / 1000, timezone.utc)
    require(receipt["schemaVersion"] == 1 and receipt["status"] == "complete"
            and receipt["instanceId"] == instance and receipt["scheduledTime"] == scheduled_ms
            and receipt["receiptKey"] == key and datetime.fromisoformat(receipt["observedAt"]) == scheduled,
            "Federal discovery did not complete the requested occurrence")
    ref = receipt["register"]
    register = verified(object_read, ref, f"{DISCOVERY}/registers/{ref['sha256']}.csv", 65536)
    require(register == REGISTER.read_bytes(), "Dated federal register differs from the container's checked register")
    register_rows = list(csv.DictReader(io.StringIO(register.decode("utf-8-sig"), newline="")))
    expected = [(r["series_key"], field, url) for r in register_rows for field, url, _ in source_endpoints(r)]
    ref = receipt["packetRef"]
    packet = json.loads(verified(object_read, ref, f"{DISCOVERY}/inventories/{ref['sha256']}.json", 8 * 1024 * 1024))
    require(packet["schemaVersion"] == 1 and packet["scheduledTime"] == scheduled_ms
            and packet["registerSha256"] == receipt["register"]["sha256"], "Wrong federal discovery packet")
    endpoints = packet["endpoints"]
    sources = packet["sources"]
    require([(e["series"], e["endpoint"], e["url"]) for e in endpoints] == expected and all(e["ok"] is True for e in endpoints),
            "Discovery packet misses a complete registered endpoint")
    urls = sorted({item[2] for item in expected})
    require([s["url"] for s in sources] == urls and all(s["status"] == 200 and "failure" not in s for s in sources),
            "Discovery packet lacks a complete publisher observation")
    counts = {"series": len(register_rows), "endpoints": len(expected), "verified": len(expected), "failed": 0,
              "uniqueUrls": len(urls), "originals": len(urls), "originalBytes": sum(s["bytes"] for s in sources)}
    require(receipt["counts"] == counts, "Discovery receipt counts disagree with its packet")

    prepared = {}
    for series, dataset in DATASETS.items():
        row, inventory = _catalogue_row(object_read, packet, series, dataset, scheduled)
        prepared[series] = row, _csv_resources(series, dataset, inventory)
    publications, _ = _catalogue_row(object_read, packet, "publications", PUBLICATIONS, scheduled)
    guidance = _guidance_sources(object_read, packet, scheduled)
    directories = _report_directory_sources(object_read, packet, scheduled)
    require(set(directories) == set(REPORT_DIRECTORIES), "Missing registered report directory origins")
    path = Path(workspace) / "data/corpus/federal-source-inventory/inventory.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""CREATE TABLE IF NOT EXISTS catalogue_observations(
          series TEXT, endpoint TEXT, observed_at TEXT, sha256 TEXT NOT NULL, url TEXT NOT NULL, inventory TEXT NOT NULL,
          PRIMARY KEY(series,endpoint,observed_at))""")
        for row in [*(row for row, _ in prepared.values()), publications]:
            db.execute("INSERT INTO catalogue_observations(series,endpoint,observed_at,sha256,url,inventory) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(series,endpoint,observed_at) DO NOTHING", row)
            latest = db.execute("SELECT observed_at,sha256,url,inventory FROM catalogue_observations "
                                "WHERE series=? AND endpoint=? ORDER BY observed_at DESC LIMIT 1", row[:2]).fetchone()
            require(latest[:3] == row[2:5] and json.loads(latest[3]) == json.loads(row[5]),
                    "Another observation would be selected by the native operator for " + row[0])
    _write_guidance_cache(path.parent, guidance)
    for source, raw in directories.values():
        _cache_original(path.parent, source, raw)
    origins = {series: {key: source[key] for key in ("key", "url", "finalUrl", "observedAt", "sha256", "bytes")}
               for series, (source, _) in directories.items()}
    manifest = {"schemaVersion": 1, "registerSha256": receipt["register"]["sha256"],
                "discovery": discovery_ref, "origins": origins}
    atomic_write(path.parent / DIRECTORY_ORIGINS, (json.dumps(manifest, sort_keys=True) + "\n").encode())
    return {"instanceId": instance, "discovery": discovery_ref, "packetRef": ref,
            "series": {series: {"observedAt": row[2], "catalogueSha256": row[3], "csvResourceIds": selected}
                       for series, (row, selected) in prepared.items()}, "publicationsCatalogueSha256": publications[3],
            "guidance": {source["url"]: source["sha256"] for source, _ in guidance}, "reportDirectoryOrigins": origins}
