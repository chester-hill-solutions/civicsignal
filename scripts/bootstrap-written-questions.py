#!/usr/bin/env python3
"""Seed the private Cloudflare written-question archive. Stdout is the manifest reference."""
import argparse
from contextlib import closing
import fcntl
from hashlib import file_digest, md5
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services/written-questions"))
from run import CORPUS_PATH, D1_PATH, PREFIX, SERVING_NAME, acceptance, archive_coverage, check_ledgers, read_json  # noqa: E402

SPEC = importlib.util.spec_from_file_location("coverage_bootstrap", Path(__file__).with_name("bootstrap-institution-coverage.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def copy_closed_sqlite(source, target):
    source = source.resolve(strict=True)
    before = bootstrap.snapshot.stamp(source.stat())
    if any(source.parent.glob(source.name + "-*")):
        raise ValueError(f"SQLite must have no active journal or sidecars: {source.name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    if before != bootstrap.snapshot.stamp(source.stat()) or any(source.parent.glob(source.name + "-*")):
        raise ValueError(f"SQLite changed during bootstrap: {source.name}")
    with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError(f"SQLite failed bootstrap verification: {source.name}")


def seed(archive, corpus, original):
    target = archive / CORPUS_PATH
    target.mkdir(parents=True)
    with (corpus / "writer.lock").open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        for name in ("catalogue.json", "coverage.json"):
            shutil.copy2(corpus / name, target / name)
        shutil.copytree(corpus / "objects", target / "objects", symlinks=True)
        if (corpus / "checkpoints").is_dir():
            shutil.copytree(corpus / "checkpoints", target / "checkpoints", symlinks=True)
        source = target / "questions.sqlite"
        copy_closed_sqlite(corpus / source.name, source)
        serving = archive / "d1" / D1_PATH / SERVING_NAME
        copy_closed_sqlite(original, serving)
    receipt = archive_coverage(target / "coverage.json")
    if receipt["sourceCutoff"] != read_json(target / "catalogue.json")["observedAt"]:
        raise ValueError("The catalogue and acquisition receipt have different source cutoffs.")
    check_ledgers(serving)
    with source.open("rb") as body:
        digest = file_digest(body, "sha256").hexdigest()
    with closing(sqlite3.connect(serving.as_uri() + "?mode=ro", uri=True)) as db:
        materialized = db.execute("SELECT source_sha256 FROM wq_materialization_state WHERE singleton=1").fetchone()
    if materialized != (digest,):
        raise ValueError("The seed serving database was materialized from a different acquisition SQLite file.")
    acceptance(serving, target / "coverage.json", archive.parent / "written-questions-vitest.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=REPO)
    parser.add_argument("--dry-run", action="store_true", help="Verify the seed and hash locally without uploading.")
    args = parser.parse_args()
    state = args.workspace / ".wrangler/written-questions-final" / D1_PATH
    candidates = [path for path in state.glob("*.sqlite") if path.name != "metadata.sqlite" and path.is_file()]
    if len(candidates) != 1:
        raise ValueError("Expected exactly one isolated written-question serving SQLite file.")
    present = {} if args.dry_run else bootstrap.existing_chunks(PREFIX)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="written-questions-bootstrap-") as temporary:
        workspace = Path(temporary)
        seed(workspace / "archive", args.workspace / CORPUS_PATH, candidates[0])
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=PREFIX)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
