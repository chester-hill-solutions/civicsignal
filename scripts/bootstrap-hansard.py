#!/usr/bin/env python3
"""Seed a private Cloudflare Hansard archive with a verified chamber workspace."""
import argparse
from contextlib import closing
from hashlib import md5
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("coverage_bootstrap", Path(__file__).with_name("bootstrap-institution-coverage.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def prepare(source, workspace, chamber):
    target = workspace / "archive"
    target.mkdir()
    original = (source / "session-45-1.sqlite").resolve(strict=True)
    with closing(sqlite3.connect(original.as_uri() + "?mode=ro", uri=True)) as db, \
            closing(sqlite3.connect(target / "session-45-1.sqlite")) as copy:
        db.backup(copy)
        corpus = "hansard-federal" if chamber == "house" else "hansard-senate"
        with copy:
            copy.execute("DELETE FROM hansard_speeches WHERE corpus_id <> ?", (corpus,))
            copy.execute("DELETE FROM local_hansard_editions WHERE (sitting_id LIKE 'senate:%') <> ?", (chamber == "senate",))
            copy.execute("DELETE FROM source_feed_editions WHERE source <> ?", (chamber,))
            copy.execute("DELETE FROM source_feed_events WHERE source <> ?", (chamber,))
        counts = copy.execute("SELECT (SELECT count(*) FROM hansard_speeches), (SELECT count(*) FROM local_hansard_editions)").fetchone()
        if not all(counts) or copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Hansard seed is empty or failed SQLite verification")
        copy.execute("VACUUM")
        print(f"{chamber} seed has {counts[0]} speeches and {counts[1]} editions", file=sys.stderr)
    shutil.copytree(source / "weekly" / chamber, target / "weekly", symlinks=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chamber", choices=("house", "senate"))
    parser.add_argument("--source", type=Path, default=REPO / "dist/hansard")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    prefix = f"weekly/hansard/{args.chamber}"
    present = {} if args.dry_run else bootstrap.existing_chunks(prefix)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="hansard-bootstrap-") as temporary:
        workspace = Path(temporary)
        prepare(args.source, workspace, args.chamber)
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=prefix)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
