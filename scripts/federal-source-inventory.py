#!/usr/bin/env python3
"""Archive the registered public catalogue entry points and inventory their published resource links."""
import argparse
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

from lib import committee_files
from lib.federal_catalogue import describe, source_endpoints

REGISTER = Path(__file__).resolve().parents[1] / "docs/evidence/2026-11-23/federal-public-service-sources.csv"
DEFAULT_ROOT = Path("data/corpus/federal-source-inventory")


def inventory(root, rows, cached):
    root.mkdir(parents=True, exist_ok=True)
    sources = [(r["series_key"], field, url, dataset) for r in rows for field, url, dataset in source_endpoints(r)]
    if not cached:
        committee_files.capture(root, sorted({url for _, _, url, _ in sources}), workers=2, refresh=True)
    cache = committee_files.cache_db(root)
    store = sqlite3.connect(root / "inventory.sqlite")
    store.row_factory = sqlite3.Row
    try:
        store.execute("""CREATE TABLE IF NOT EXISTS catalogue_observations(
          series TEXT, endpoint TEXT, observed_at TEXT, sha256 TEXT NOT NULL, url TEXT NOT NULL, inventory TEXT NOT NULL,
          PRIMARY KEY(series,endpoint,observed_at))""")
        results = []
        for series, field, url, dataset in sources:
            item = {"series": series, "endpoint": field, "url": url}
            try:
                row = cache.execute("SELECT * FROM files WHERE url=?", (url,)).fetchone()
                if not row or row["error"] or not row["digest"]:
                    raise ValueError((row and row["error"]) or "Missing capture")
                document = describe(committee_files.read_object(root, row["digest"]), row["final_url"] or url, dataset)
                encoded = json.dumps(document, ensure_ascii=False, sort_keys=True)
                last = store.execute("""SELECT observed_at,inventory FROM catalogue_observations
                  WHERE series=? AND endpoint=? ORDER BY observed_at DESC LIMIT 1""", (series, field)).fetchone()
                if last and row["checked"] < last["observed_at"]:
                    raise ValueError("Capture predates the published observation")
                store.execute("INSERT OR IGNORE INTO catalogue_observations VALUES(?,?,?,?,?,?)",
                              (series, field, row["checked"], row["digest"], url, encoded))
                item.update(ok=True, kind=document["kind"], entries=len(document.get("resources", document.get("links", []))),
                            observedAt=row["checked"], sha256=row["digest"], changed=not last or last["inventory"] != encoded)
            except (KeyError, ValueError, OSError, TypeError) as err:
                item.update(ok=False, error=str(err))
            results.append(item)
        store.commit()
        return results
    finally:
        cache.close()
        store.close()


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args.add_argument("--only", action="append")
    args.add_argument("--from-cache", action="store_true")
    options = args.parse_args()
    with REGISTER.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    if options.only:
        unknown = set(options.only) - {r["series_key"] for r in rows}
        if unknown:
            args.error(f"Unknown register keys: {sorted(unknown)}")
        rows = [r for r in rows if r["series_key"] in options.only]
    options.root.mkdir(parents=True, exist_ok=True)
    with (options.root / "inventory.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        results = inventory(options.root, rows, options.from_cache)
        now = datetime.now(timezone.utc).isoformat()
        receipt = {"observedAt": now, "stage": "catalogue discovery", "fromCache": options.from_cache,
                   "registerSha256": hashlib.sha256(REGISTER.read_bytes()).hexdigest(), "series": len(rows),
                   "ok": all(r["ok"] for r in results), "endpoints": results}
        path = options.root / "receipts" / (now.replace(":", "-") + ".json")
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"receipt": str(path), "series": len(rows), "endpoints": len(results),
                          "verified": sum(r["ok"] for r in results), "ok": receipt["ok"]}))
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
