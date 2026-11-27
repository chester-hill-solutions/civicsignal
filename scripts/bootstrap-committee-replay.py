#!/usr/bin/env python3
"""Seed the committee offline replay archive. Stdout is the R2 manifest reference."""
import argparse
from contextlib import closing
import ctypes
import fcntl
from hashlib import md5
import importlib.util
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services/committee-replay"))
from run import PREFIX, SOURCE_DIR, check_input, corpus_status  # noqa: E402

SPEC = importlib.util.spec_from_file_location("coverage_bootstrap", Path(__file__).with_name("bootstrap-institution-coverage.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def copy_database(original, target):
    with closing(sqlite3.connect(original.resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as local, \
            closing(sqlite3.connect(target)) as copy:
        local.backup(copy)
        copy.execute("PRAGMA journal_mode=DELETE")
        if copy.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError(f"Committee seed database failed SQLite verification: {original.name}")
    source_time = original.stat().st_mtime_ns
    os.utime(target, ns=(source_time, source_time))


def copy_originals(original, target):
    if original.is_symlink() or not original.is_dir():
        raise ValueError("The retained committee originals must be a directory.")
    if sys.platform != "darwin":
        shutil.copytree(original, target, symlinks=True)
        return
    # Clone the APFS tree without copying the 6 GB body data or changing the source inodes.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.clonefile(os.fsencode(original), os.fsencode(target), 0):
        error = ctypes.get_errno()
        raise OSError(error, "Cannot clone committee originals; put TMPDIR on the same APFS volume as the archive", str(original))


def seed(workspace, original_root):
    retained = original_root / "data/corpus/committees"
    corpus = workspace / SOURCE_DIR
    corpus.mkdir(parents=True)
    publication_lock = original_root / "dist/refresh/committee-publication.lock"
    with publication_lock.open("rb") as publish, (retained / "build.lock").open("rb") as build:
        for lock in (publish, build):
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        for name in ("catalogue.json", "publication-parts.json"):
            shutil.copy2(retained / name, corpus / name)
        for name in ("downloads.sqlite", "committee.sqlite"):
            copy_database(retained / name, corpus / name)
        copy_originals(retained / "objects", corpus / "objects")
    catalogue_time = (corpus / "catalogue.json").stat().st_mtime_ns
    for directory in (corpus, corpus.parent):
        os.utime(directory, ns=(catalogue_time, catalogue_time))
    check_input(corpus)
    corpus_status(corpus)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=REPO)
    parser.add_argument("--dry-run", action="store_true", help="Verify and hash the retained inputs without uploading.")
    args = parser.parse_args()
    present = {} if args.dry_run else bootstrap.existing_chunks(PREFIX)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="committee-replay-bootstrap-") as temporary:
        workspace = Path(temporary)
        seed(workspace, args.workspace)
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=PREFIX)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
