#!/usr/bin/env python3
"""Seed the private consultation notices archive. Stdout is the immutable manifest reference."""
import argparse
from contextlib import closing
from hashlib import md5
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load("consultation_notices_runtime", ROOT / "services/consultation-notices/run.py")
bootstrap = load("coverage_bootstrap", ROOT / "scripts/bootstrap-institution-coverage.py")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=ROOT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    present = {} if args.dry_run else bootstrap.existing_chunks(runtime.PREFIX)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="consultation-notices-bootstrap-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "archive"
        source = (args.workspace / runtime.NOTICE_PATH).resolve(strict=True)
        corpus = archive / runtime.NOTICE_PATH
        corpus.mkdir(parents=True)
        original = (source / "notice-index.sqlite").resolve(strict=True)
        with closing(sqlite3.connect(original.as_uri() + "?mode=ro", uri=True)) as local, \
                closing(sqlite3.connect(corpus / original.name)) as copy:
            local.backup(copy)
        for subdirectory in ("notice-objects", "notice-receipts"):
            shutil.copytree(source / subdirectory, corpus / subdirectory)
        verified = runtime.verified_archive(runtime.notice_intake(archive), corpus / original.name)
        if not verified:
            raise ValueError("Consultation notice seed has no verified originals.")
        print(f"Verified {verified} archived consultation notice originals", file=sys.stderr)
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=runtime.PREFIX)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
