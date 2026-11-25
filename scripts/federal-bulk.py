#!/usr/bin/env python3
"""Refresh and read official Canadian federal CSV resources located by the source register."""
import argparse
import csv
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request

from lib.committee_files import official

DEFAULT_ROOT = Path("data/corpus/federal-bulk")
INDEX = Path("data/corpus/federal-source-inventory/inventory.sqlite")
SERIES = ("official-titles", "service-inventory", "grant-awards", "ati-summaries")


class PublisherRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        published_path = urlsplit(req.full_url).path.partition("/resource/")[2]
        blob_path = "/opengovprod/resources/" + published_path.replace("/download/", "/", 1)
        publisher_blob = (bool(published_path) and target.scheme == "https" and
                          target.netloc == "opencanada.blob.core.windows.net" and target.path == blob_path)
        if not official(newurl) and not publisher_blob:
            raise ValueError("Resource redirected outside an official publication host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def scan(stream, series, nil=False):
    reader = csv.reader(stream, strict=True)
    fields = next(reader, [])
    if not fields or not all(fields) or len(set(fields)) != len(fields):
        raise ValueError("Missing or duplicate CSV headers")
    required = {"official-titles": {"Legal title", "Appellation légale", "Applied title", "Titre d'usage"},
                "service-inventory": {"service_id", "fiscal_yr", "service_name_en", "service_name_fr"},
                "grant-awards": {"owner_org", "fiscal_year", "quarter"} if nil else {"owner_org", "ref_number", "agreement_value"},
                "ati-summaries": {"owner_org", "year", "month"} if nil else {"owner_org", "request_number", "summary_en", "summary_fr"}}[series]
    if not required.issubset(fields):
        raise ValueError(f"Missing published fields: {sorted(required - set(fields))}")
    rows = 0
    for row in reader:
        if not row:
            continue
        if len(row) != len(fields):
            raise ValueError(f"CSV record {rows + 1} has {len(row)} values for {len(fields)} headers")
        rows += 1
    if not rows and not nil:
        raise ValueError("Published CSV contains no records")
    return fields, rows


def published_resources(series):
    with sqlite3.connect(INDEX.resolve().as_uri() + "?mode=ro", uri=True) as db:
        observation = db.execute("""SELECT observed_at, inventory FROM catalogue_observations
          WHERE series=? AND endpoint='entry_url' ORDER BY observed_at DESC LIMIT 1""", (series,)).fetchone()
    if not observation:
        raise ValueError("Refresh the federal source inventory first")
    resources = [r for r in json.loads(observation[1])["resources"] if r["format"].upper() == "CSV"]
    if not resources or not all(official(r["url"]) for r in resources):
        raise ValueError("Missing official CSV resources")
    return observation[0], resources


def capture(resource, series, root, opener):
    # One archive is written per resource. The stream is bounded by the actual
    # free space even when the publisher omits a length or changes its file.
    request = Request(resource["url"], headers={"Accept-Encoding": "identity", "User-Agent": "CivicSignal public data intake"})
    digest = hashlib.sha256()
    reserve = 64 * 1024 * 1024
    available = shutil.disk_usage(root).free - reserve
    with opener.open(request, timeout=60) as response:
        size = int(response.headers["Content-Length"]) if response.headers.get("Content-Length") else None
        if response.status != 200 or available < 1024 * 1024:
            raise ValueError(f"Cannot stage resource: status {response.status}, free bytes after reserve {available}")
        first = response.read(1024 * 1024)
        if size and size > available and first:
            estimate = size * len(gzip.compress(first, compresslevel=3)) // len(first)
            if estimate > available:
                raise ValueError(f"Estimated compressed CSV needs {estimate} bytes; {available} available after reserve")
        with tempfile.NamedTemporaryFile(dir=root, suffix=".gz") as candidate:
            with gzip.GzipFile(fileobj=candidate, mode="wb", compresslevel=3, mtime=0) as archive:
                total = 0
                data = first
                while data:
                    total += len(data)
                    if shutil.disk_usage(root).free - reserve < len(data):
                        raise ValueError(f"Insufficient space to finish the compressed CSV after {total} source bytes")
                    digest.update(data)
                    archive.write(data)
                    data = response.read(1024 * 1024)
            candidate.flush()
            if size is not None and total != size:
                raise ValueError(f"Incomplete CSV body: got {total} of {size} bytes")
            with gzip.open(candidate.name, "rt", encoding="utf-8-sig", newline="") as stream:
                fields, rows = scan(stream, series, urlsplit(resource["url"]).path.endswith("-nil.csv"))
            hexdigest = digest.hexdigest()
            target = root / "objects" / (hexdigest + ".csv.gz")
            target.parent.mkdir(exist_ok=True)
            try:
                os.link(candidate.name, target)
            except FileExistsError:
                with gzip.open(target, "rb") as existing:
                    if hashlib.file_digest(existing, "sha256").hexdigest() != hexdigest:
                        raise ValueError("Stored CSV checksum mismatch")
        return {**resource, "fields": fields, "rows": rows, "bytes": total, "sha256": hexdigest,
                "finalUrl": urlsplit(response.geturl())._replace(query="", fragment="").geturl(), "lastModified": response.headers.get("Last-Modified")}


def refresh(root, series):
    catalogue_date, resources = published_resources(series)
    opener = build_opener(PublisherRedirect())
    records = [capture(r, series, root, opener) for r in resources]
    with sqlite3.connect(root / "publications.sqlite") as db:
        db.execute("""CREATE TABLE IF NOT EXISTS publications(series TEXT, observed_at TEXT, catalogue_date TEXT,
                    resources TEXT NOT NULL, PRIMARY KEY(series,observed_at))""")
        observed = datetime.now(timezone.utc).isoformat()
        db.execute("INSERT INTO publications VALUES (?,?,?,?)", (series, observed, catalogue_date, json.dumps(records)))
    print(json.dumps({"series": series, "observedAt": observed,
                      "resources": [{"id": r["id"], "rows": r["rows"], "sha256": r["sha256"]} for r in records]}))


def search(root, series, query, limit):
    with sqlite3.connect((root / "publications.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("SELECT resources FROM publications WHERE series=? ORDER BY observed_at DESC LIMIT 1", (series,)).fetchone()
    if not row:
        raise ValueError(f"No published CSV set for {series}")
    count = 0
    for resource in json.loads(row[0]):
        with gzip.open(root / "objects" / (resource["sha256"] + ".csv.gz"), "rt", encoding="utf-8-sig", newline="") as stream:
            for ordinal, record in enumerate(csv.DictReader(stream), start=1):
                if any(query.casefold() in v.casefold() for v in record.values()):
                    print(json.dumps({"url": resource["url"], "sha256": resource["sha256"],
                                      "record": ordinal, "fields": record}, ensure_ascii=False))
                    count += 1
                    if count == limit:
                        return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["refresh", "search"])
    parser.add_argument("series", choices=SERIES)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--query")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    if args.action == "search":
        if not args.query or not 1 <= args.limit <= 100:
            parser.error("Search requires nonempty --query and --limit from 1 to 100")
        search(args.root, args.series, args.query, args.limit)
    else:
        args.root.mkdir(parents=True, exist_ok=True)
        with (args.root / (args.series + ".lock")).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            refresh(args.root, args.series)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, csv.Error) as error:
        sys.exit(str(error))
