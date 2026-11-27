#!/usr/bin/env python3
"""Seed the private Cloudflare Gazette archive. Stdout is the manifest reference."""
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
PREFIX = "weekly/gazette"
SPEC = importlib.util.spec_from_file_location("coverage_bootstrap", Path(__file__).with_name("bootstrap-institution-coverage.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=REPO)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    present = {} if args.dry_run else bootstrap.existing_chunks(PREFIX)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="gazette-bootstrap-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "archive"
        archive.mkdir()
        original = (args.workspace / "data/corpus/gazette-preview.sqlite").resolve(strict=True)
        with closing(sqlite3.connect(original.as_uri() + "?mode=ro", uri=True)) as local, \
                closing(sqlite3.connect(archive / original.name)) as copy:
            local.backup(copy)
            if copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("Gazette seed SQLite archive failed verification.")
        shutil.copytree(args.workspace / "dist/gazette/backfills", archive / "dist/gazette/backfills")
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=PREFIX)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
