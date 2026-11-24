"""Atomically refresh the isolated local D1 committee preview from its SQLite source."""

from __future__ import annotations

import argparse
import hashlib
import ctypes
import os
import tempfile
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Iterable


SESSION = "45-1"
TABLES = {
    "cc_records": (
        "session",
        "id",
        "language",
        "kind",
        "chamber",
        "committee_id",
        "title",
        "url",
        "status",
        "metadata_json",
        "object_sha256",
    ),
    "cc_links": ("session", "language", "parent_id", "child_id", "relation"),
    "cc_passages": (
        "session",
        "language",
        "document_id",
        "position",
        "location",
        "text",
        "speaker",
        "affiliation",
    ),
}
KEYS = {
    "cc_records": "session,id,language",
    "cc_links": "session,language,parent_id,child_id,relation",
    "cc_passages": "session,language,document_id,position",
}
INSERTS = {
    name: f"INSERT INTO {name} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})"
    for name, columns in TABLES.items()
}


def database_file(state: Path) -> Path:
    directory = state / "v3/d1/miniflare-D1DatabaseObject"
    if not directory.is_dir():
        raise ValueError(f"Local D1 state is missing: {directory}")
    files = [
        path
        for path in directory.glob("*.sqlite")
        if path.name != "metadata.sqlite" and path.is_file()
    ]
    if len(files) != 1:
        raise ValueError(
            f"Expected one isolated local D1 SQLite database in {directory}; found {len(files)}"
        )
    return files[0]


def connect(
    path: Path, *, readonly: bool = False, timeout: float = 5.0
) -> sqlite3.Connection:
    if readonly:
        db = sqlite3.connect(
            f"file:{path.resolve()}?mode=ro", uri=True, timeout=timeout
        )
    else:
        db = sqlite3.connect(path, timeout=timeout)
    db.row_factory = sqlite3.Row
    db.execute(f"PRAGMA busy_timeout={int(timeout * 1000)}")
    return db


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def _fts_sql(db: sqlite3.Connection) -> str:
    row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cc_fts'"
    ).fetchone()
    if not row or not row["sql"]:
        raise ValueError("committee FTS index is missing")
    return row["sql"].lower().replace("\n", " ")


def _validate_schema(db: sqlite3.Connection, *, label: str) -> None:
    for table, columns in TABLES.items():
        if not set(columns) <= _columns(db, table):
            raise ValueError(f"{label} is missing required {table} columns")
    sql = _fts_sql(db)
    if (
        "using fts5" not in sql
        or "content='cc_passages'" not in sql
        or "text" not in sql
    ):
        raise ValueError(
            f"{label} cc_fts must be external-content FTS5 over cc_passages"
        )
    snapshot = _columns(db, "cc_snapshot")
    if not {"session", "cutoff"} <= snapshot:
        raise ValueError(f"{label} is missing the committee snapshot table")


def _validate_local_migration(db: sqlite3.Connection) -> None:
    ledger = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'"
    ).fetchone()
    if not ledger:
        raise ValueError(
            "local D1 migration ledger is missing; apply preview/committees/migrations first"
        )
    applied = db.execute(
        "SELECT 1 FROM d1_migrations WHERE name='0001_committee_preview.sql'"
    ).fetchone()
    if not applied:
        raise ValueError("local D1 committee preview migration has not been applied")


def _rows(db: sqlite3.Connection, table: str, session: str) -> Iterable[tuple]:
    columns = TABLES[table]
    order = KEYS[table]
    query = f"SELECT {','.join(columns)} FROM {table} WHERE session=? ORDER BY {order}"
    for row in db.execute(query, (session,)):
        yield tuple(row[column] for column in columns)


def _fingerprint_row(hash_state, row: tuple) -> None:
    data = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    hash_state.update(len(data).to_bytes(8, "big"))
    hash_state.update(data)


def table_stats(db: sqlite3.Connection, session: str) -> dict:
    result = {}
    for table in TABLES:
        rows = _rows(db, table, session)
        digest = hashlib.sha256()
        count = chars = 0
        for row in rows:
            count += 1
            if table == "cc_passages":
                chars += len(row[TABLES[table].index("text")])
            _fingerprint_row(digest, row)
        result[table] = {
            "count": count,
            "textCharacters": chars,
            "sha256": digest.hexdigest(),
        }
    snap = db.execute(
        "SELECT cutoff FROM cc_snapshot WHERE session=?", (session,)
    ).fetchone()
    if not snap:
        raise ValueError(
            f"Source has no completed snapshot cutoff for session {session}"
        )
    result["cutoff"] = snap["cutoff"]
    if result["cc_records"]["count"] == 0:
        raise ValueError(f"Source contains no committee records for session {session}")
    return result


def _search_probe(db: sqlite3.Connection, session: str) -> tuple[str, int]:
    row = db.execute(
        "SELECT text FROM cc_passages WHERE session=? AND text<>'' ORDER BY document_id,position LIMIT 1",
        (session,),
    ).fetchone()
    if not row:
        raise ValueError(f"Source has no searchable passages for session {session}")
    tokens = re.findall(r"[^\W_]{3,}", row["text"], flags=re.UNICODE)
    if not tokens:
        raise ValueError("No safe token was found for the FTS integrity lookup")
    term = tokens[0]
    hits = db.execute(
        "SELECT count(*) FROM cc_fts WHERE cc_fts MATCH ? AND session=?",
        (term, session),
    ).fetchone()[0]
    if not hits:
        raise ValueError("Source committee FTS index did not find its own passage")
    return term, int(hits)


def _delete_old_fts(db: sqlite3.Connection, session: str) -> None:
    rows = db.execute(
        "SELECT rowid,session,language,document_id,position,text FROM cc_passages WHERE session=?",
        (session,),
    )
    for row in rows:
        db.execute(
            "INSERT INTO cc_fts(cc_fts,rowid,session,language,document_id,position,text) "
            "VALUES('delete',?,?,?,?,?,?)",
            tuple(row),
        )


def _delete_candidate(db: sqlite3.Connection, session: str) -> None:
    _delete_old_fts(db, session)
    for table in ("cc_links", "cc_records", "cc_passages", "cc_snapshot"):
        db.execute(f"DELETE FROM {table} WHERE session=?", (session,))


def _copy_table(
    source: sqlite3.Connection, target: sqlite3.Connection, table: str, session: str
) -> None:
    sql = f"SELECT {','.join(TABLES[table])} FROM {table} WHERE session=? ORDER BY {KEYS[table]}"
    cursor = source.execute(sql, (session,))
    while batch := cursor.fetchmany(256):
        if table != "cc_passages":
            target.executemany(INSERTS[table], [tuple(row) for row in batch])
            continue
        for row in batch:
            values = tuple(row)
            cur = target.execute(INSERTS[table], values)
            target.execute(
                "INSERT INTO cc_fts(rowid,session,language,document_id,position,text) VALUES(?,?,?,?,?,?)",
                (cur.lastrowid, values[0], values[1], values[2], values[3], values[5]),
            )


def materialize(
    source_path: Path, target_path: Path, session: str = SESSION, timeout: float = 5.0
) -> dict:
    source = connect(source_path, readonly=True, timeout=timeout)
    target = connect(target_path, timeout=timeout)
    try:
        source.execute("BEGIN")
        _validate_schema(source, label="source")
        _validate_schema(target, label="local D1")
        _validate_local_migration(target)
        expected = table_stats(source, session)
        term, source_hits = _search_probe(source, session)

        # A single SQLite transaction is the generation boundary. Any exception
        # restores the previous candidate, including its passage rows and FTS index.
        target.execute("BEGIN IMMEDIATE")
        try:
            _delete_candidate(target, session)
            for table in TABLES:
                _copy_table(source, target, table, session)
            target.execute(
                "INSERT INTO cc_snapshot(session,cutoff) VALUES(?,?)",
                (session, expected["cutoff"]),
            )

            actual = table_stats(target, session)
            if actual != expected:
                raise ValueError(
                    f"Materialized source count, text length or row hash mismatch: {actual!r} != {expected!r}"
                )
            # Rank=1 asks FTS5 to compare the index with its external content table.
            target.execute(
                "INSERT INTO cc_fts(cc_fts,rank) VALUES('integrity-check',1)"
            )
            target_hits = int(
                target.execute(
                    "SELECT count(*) FROM cc_fts WHERE cc_fts MATCH ? AND session=?",
                    (term, session),
                ).fetchone()[0]
            )
            if target_hits != source_hits:
                raise ValueError(
                    f"FTS lookup mismatch for {term!r}: {source_hits} source hits vs {target_hits} local D1 hits"
                )
            target.execute("COMMIT")
        except BaseException:
            target.execute("ROLLBACK")
            raise
        return {
            "materialized": True,
            "target": "isolated-local-d1",
            "session": session,
            "cutoff": expected["cutoff"],
            "tables": expected,
            "ftsProbe": {"term": term, "hits": source_hits},
            "sourceEquivalent": True,
            "originalObjectBytesCopied": 0,
        }
    finally:
        source.close()
        target.close()


def clone_local(
    source_path: Path, target_path: Path, session: str, timeout: float
) -> dict:
    """Publish a verified copy-on-write clone to an offline, dedicated macOS D1 database."""
    if sys.platform != "darwin":
        raise ValueError(
            "APFS cloning requires macOS; use the standard materializer here"
        )
    import fcntl

    with (
        (source_path.parent / "build.lock").open("a") as lock,
        tempfile.TemporaryDirectory(dir=target_path.parent) as directory,
    ):
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tmp = Path(directory) / "candidate"
        source = connect(source_path, timeout=timeout)
        prior = connect(target_path, timeout=timeout)
        try:
            _validate_schema(source, label="source")
            _validate_local_migration(prior)
            _validate_schema(prior, label="local D1")
            if source.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise ValueError("Cannot clone an uncheckpointed source")
            source.execute("BEGIN IMMEDIATE")
            expected = table_stats(source, session)
            term, hits = _search_probe(source, session)
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.clonefile(os.fsencode(source_path), os.fsencode(tmp), 0):
                raise OSError(
                    ctypes.get_errno(),
                    "Unable to clone committee database on this volume",
                )
            source.rollback()
            # Offline swap: request an exclusive lock and drain WAL sidecars before replacing the inode.
            prior.execute("PRAGMA locking_mode=EXCLUSIVE")
            prior.execute("PRAGMA journal_mode=DELETE")
            prior.execute("BEGIN EXCLUSIVE")
            candidate = connect(tmp, timeout=timeout)
            try:
                candidate.execute("PRAGMA journal_mode=DELETE")
                candidate.execute("PRAGMA secure_delete=OFF")
                required = set(TABLES) | {
                    "cc_snapshot",
                    "cc_fts",
                    "cc_fts_data",
                    "cc_fts_idx",
                    "cc_fts_docsize",
                    "cc_fts_config",
                }
                for conn, allowed in [
                    (
                        candidate,
                        required
                        | {
                            "cc_revision",
                            "cc_changes",
                            "cc_link_changes",
                            "cc_extracted",
                        },
                    ),
                    (
                        prior,
                        required | {"d1_migrations", "_cf_METADATA", "sqlite_sequence"},
                    ),
                ]:
                    names = {
                        r[0]
                        for r in conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='table'"
                        )
                    }
                    if names - allowed:
                        raise ValueError(
                            "Unexpected tables in dedicated local committee database: "
                            + str(names - allowed)
                        )
                    if conn.execute(
                        "SELECT 1 FROM cc_records WHERE session<>? LIMIT 1", (session,)
                    ).fetchone():
                        raise ValueError(
                            "Dedicated local candidate contains another session"
                        )
                with candidate:
                    for table in (
                        "cc_revision",
                        "cc_changes",
                        "cc_link_changes",
                        "cc_extracted",
                    ):
                        candidate.execute(f"DROP TABLE IF EXISTS {table}")
                    for table in ("d1_migrations", "_cf_METADATA"):
                        ddl = prior.execute(
                            "SELECT sql FROM sqlite_master WHERE name=?", (table,)
                        ).fetchone()
                        if ddl:
                            candidate.execute(ddl[0])
                            for row in prior.execute(f'SELECT * FROM "{table}"'):
                                candidate.execute(
                                    f'INSERT INTO "{table}" VALUES('
                                    + ",".join("?" for _ in row)
                                    + ")",
                                    tuple(row),
                                )
                    actual = table_stats(candidate, session)
                    if actual != expected or _search_probe(candidate, session) != (
                        term,
                        hits,
                    ):
                        raise ValueError(
                            "Cloned serving tables do not match the source"
                        )
                    candidate.execute(
                        "INSERT INTO cc_fts(cc_fts,rank) VALUES('integrity-check',1)"
                    )
            finally:
                candidate.close()
            os.replace(tmp, target_path)
            return dict(
                materialized=True,
                target="isolated-local-d1",
                method="verified-apfs-clone",
                cutoff=expected["cutoff"],
                tables=expected,
                ftsProbe=dict(term=term, hits=hits),
                objectBytesCopied=0,
            )
        finally:
            prior.close()
            source.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=Path("data/corpus/committees/committee.sqlite")
    )
    parser.add_argument(
        "--persist-to", type=Path, default=Path(".wrangler/committees-45-1")
    )
    parser.add_argument("--session", default=SESSION)
    parser.add_argument("--timeout-seconds", type=float, default=5.0)
    parser.add_argument(
        "--clone-local",
        action="store_true",
        help="Use an APFS copy-on-write clone for an offline local D1 candidate.",
    )
    args = parser.parse_args(argv)
    if args.session != SESSION:
        parser.error(f"this preview materializer is scoped to session {SESSION}")
    if args.timeout_seconds <= 0 or args.timeout_seconds > 60:
        parser.error("--timeout-seconds must be greater than 0 and at most 60")
    if not args.source.is_file():
        parser.error(f"source database not found: {args.source}")
    try:
        target = database_file(args.persist_to)
        build = clone_local if args.clone_local else materialize
        summary = build(args.source, target, args.session, args.timeout_seconds)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"committee materialization failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
