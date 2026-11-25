#!/usr/bin/env python3
"""Capture and query the public Open Government Portal's registered disclosure collections."""
import argparse
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from lib.committee_files import official
from lib.parliament_intake import atomic_write, save_atomic

ROOT = Path("data/corpus/federal-disclosures")
API = "https://open.canada.ca/data/api/action/package_search"
COLLECTIONS = ("aia", "transition", "transition_deputy", "parliament_committee", "parliament_committee_deputy")


def capture_page(root, url):
    request = Request(url, headers={"User-Agent": "CivicSignal public catalogue intake"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=40) as response:
                if response.geturl() != url or response.status != 200:
                    raise ValueError("Unexpected federal catalogue response")
                body = response.read(8 * 1024**2 + 1)
            break
        except HTTPError as error:
            error.close()
            if attempt == 2 or error.code not in (408, 429, 500, 502, 503, 504):
                raise
        except (URLError, TimeoutError, ConnectionError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)
    if len(body) > 8 * 1024**2:
        raise ValueError("Federal catalogue page exceeds 8 MiB")
    sha = hashlib.sha256(body).hexdigest()
    archive = root / "objects" / (sha + ".json.gz")
    if not archive.exists():
        atomic_write(archive, gzip.compress(body, mtime=0))
    if hashlib.sha256(gzip.decompress(archive.read_bytes())).hexdigest() != sha:
        raise ValueError("Published catalogue page checksum differs")
    doc = json.loads(body)
    if doc.get("success") is not True:
        raise ValueError("Publisher rejected the collection query")
    return doc["result"], sha


def collect(root, collection, fetch=capture_page):
    records, pages = [], []
    total = None
    previous_id = ""
    while total is None or len(records) < total:
        url = API + "?" + urlencode({"fq": "collection:" + collection, "sort": "id asc", "rows": 50, "start": len(records)})
        page, sha = fetch(root, url)
        total = page["count"] if total is None else total
        if total != page["count"] or total <= 0 or not page["results"]:
            raise ValueError("Federal disclosure count changed or page is unexpectedly empty")
        for entry in page["results"]:
            identity = entry["id"]
            if entry["collection"] != collection or identity <= previous_id:
                raise ValueError("Mismatched collection or unstable catalogue ordering")
            previous_id = identity
            titles = entry["title_translated"]
            resources = entry.get("resources", [])
            if not any(titles.values()) or not entry["organization"]["name"]:
                raise ValueError("Federal disclosure is missing its title or publishing institution")
            records.append((collection, identity, entry["organization"]["name"], titles.get("en"), titles.get("fr"),
                            json.dumps([{"id": r["id"], "url": r["url"], "languages": r.get("language"),
                                         "format": r.get("format")} for r in resources]), sha))
        pages.append({"url": url, "sha256": sha, "records": len(page["results"])})
    if len(records) != total:
        raise ValueError("Federal disclosure record count differs from publisher total")
    return records, pages


def refresh(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        observed = datetime.now(timezone.utc).isoformat()
        rows, sources = [], {}
        for collection in COLLECTIONS:
            records, pages = collect(root, collection)
            sources[collection] = {"records": len(records), "pages": pages}
            rows.extend(records)
        receipt = {"observedAt": observed, "collections": sources, "records": len(rows)}
        with sqlite3.connect(root / "catalogue.sqlite") as db:
            db.execute("""CREATE TABLE IF NOT EXISTS disclosures(collection TEXT,id TEXT,issuer TEXT,
                       title_en TEXT,title_fr TEXT,resources TEXT,page_sha256 TEXT,PRIMARY KEY (collection,id))""")
            db.execute("CREATE TABLE IF NOT EXISTS generations(observed_at TEXT PRIMARY KEY,receipt TEXT NOT NULL)")
            db.execute("DELETE FROM disclosures")
            db.executemany("INSERT INTO disclosures VALUES(?,?,?,?,?,?,?)", rows)
            db.execute("INSERT INTO generations VALUES(?,?)", (observed, json.dumps(receipt)))
        save_atomic(root / "receipt.json", receipt)
        print(json.dumps({k: v["records"] for k,v in sources.items()}))


def link_status(url):
    # CKAN can publish external or relative resource locators. Keep its original value for provenance.
    try:
        if official(url):
            return "published-government-https-link"
        target = urlsplit(url)
        if target.scheme in ("http", "https") and target.hostname:
            return "other-published-link"
    except (TypeError, ValueError):
        pass
    return "no-absolute-web-link"


def lookup(root, identity):
    with sqlite3.connect((root / "catalogue.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM disclosures WHERE id=?", (identity,)).fetchone()
    if row is None:
        raise ValueError("No published disclosure matches this ID")
    record = dict(row)
    record["resources"] = [{**r, "linkStatus": link_status(r.get("url"))} for r in json.loads(record["resources"])]
    record["citationUrl"] = "https://open.canada.ca/data/en/dataset/" + record["id"]
    return record


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=ROOT)
    p.add_argument("--lookup", metavar="DATASET_ID")
    args = p.parse_args()
    if args.lookup:
        print(json.dumps(lookup(args.root, args.lookup), ensure_ascii=False))
    else:
        refresh(args.root)
