"""Edition-scoped local store for the session 45-1 committee preview."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Mapping


MIGRATION = Path(__file__).resolve().parents[2] / "preview/committees/migrations/0001_committee_preview.sql"


def initialize(db: sqlite3.Connection) -> sqlite3.Connection:
    """Create the isolated preview schema on an existing SQLite connection."""
    db.row_factory = sqlite3.Row
    db.executescript(MIGRATION.read_text(encoding="utf-8"))
    return db


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_record(db: sqlite3.Connection, record: Mapping[str, Any]) -> None:
    """Insert or refresh one source record without disturbing linked material."""
    required = ("session", "id", "language", "kind")
    if any(not record.get(name) for name in required):
        raise ValueError("record requires session, id, language and kind")
    language = record["language"]
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    metadata = record.get("metadata", record.get("metadata_json", {}))
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError as exc:
            raise ValueError("metadata_json must be valid JSON") from exc
    db.execute("""INSERT INTO cc_records
          (session,id,language,kind,chamber,committee_id,title,url,status,metadata_json,object_sha256)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(session,id,language) DO UPDATE SET kind=excluded.kind,chamber=excluded.chamber,
          committee_id=excluded.committee_id,title=excluded.title,url=excluded.url,status=excluded.status,
          metadata_json=excluded.metadata_json,object_sha256=excluded.object_sha256""",
          (record["session"], str(record["id"]), language, record["kind"], record.get("chamber"),
           record.get("committee_id"), record.get("title"), record.get("url"), record.get("status"),
           _json(metadata) if not isinstance(metadata, str) else metadata, record.get("object_sha256")))


def write_link(db: sqlite3.Connection, session: str, language: str, parent_id: str,
               child_id: str, relation: str) -> None:
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    db.execute("INSERT OR IGNORE INTO cc_links VALUES (?,?,?,?,?)",
               (session, language, str(parent_id), str(child_id), relation))


def replace_passages(db: sqlite3.Connection, session: str, language: str, document_id: str,
                     passages: Iterable[Mapping[str, Any]]) -> None:
    """Atomically replace passages and their FTS rows; safe to retry after interruption."""
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    normalized = []
    for position, passage in enumerate(passages):
        text = str(passage.get("text") or "").strip()
        if not text:
            continue
        normalized.append((session, language, str(document_id), int(passage.get("position", position)),
                           passage.get("location"), text, passage.get("speaker"), passage.get("affiliation")))
    if len({row[3] for row in normalized}) != len(normalized):
        raise ValueError("passage positions must be unique within a document edition")
    # SAVEPOINT composes with an outer caller transaction and rolls back the
    # passage and index update together if any insert or FTS operation fails.
    db.execute("SAVEPOINT cc_replace_passages")
    try:
        old = db.execute("SELECT rowid,session,language,document_id,position,text FROM cc_passages "
                         "WHERE session=? AND language=? AND document_id=?",
                         (session, language, str(document_id))).fetchall()
        for row in old:
            db.execute("INSERT INTO cc_fts(cc_fts,rowid,session,language,document_id,position,text) "
                       "VALUES('delete',?,?,?,?,?,?)", tuple(row))
        db.execute("DELETE FROM cc_passages WHERE session=? AND language=? AND document_id=?",
                    (session, language, str(document_id)))
        for row in normalized:
            cur = db.execute("INSERT INTO cc_passages VALUES (?,?,?,?,?,?,?,?)", row)
            db.execute("INSERT INTO cc_fts(rowid,session,language,document_id,position,text) VALUES (?,?,?,?,?,?)",
                       (cur.lastrowid, row[0], row[1], row[2], row[3], row[5]))
        db.execute("RELEASE cc_replace_passages")
    except BaseException:
        db.execute("ROLLBACK TO cc_replace_passages")
        db.execute("RELEASE cc_replace_passages")
        raise


def mark_snapshot(db: sqlite3.Connection, session: str, cutoff: str) -> None:
    """Record the cutoff only after the caller's staged batch is complete."""
    db.execute("INSERT INTO cc_snapshot VALUES (?,?) ON CONFLICT(session) DO UPDATE SET cutoff=excluded.cutoff",
               (session, cutoff))

# Fields the publisher refreshes on every visit. They never make a new revision.
# Advisory decoration the publisher serves inconsistently between page variants.
# It is stored as observed but never makes a revision on its own.
VOLATILE_METADATA = {"lastChecked", "directoryCutoffs", "submissionIndex", "observedAt",
                     "firstObservedAt", "listed", "lastListedAt",
                     "contentWarning", "contentWarningText", "pendingDigest",
                     "contentConflict"}


def signature(record: Mapping[str, Any]) -> str:
    """Hash the facts that would matter to a reader, ignoring re-observation stamps."""
    metadata = {
        key: value
        for key, value in (record.get("metadata") or {}).items()
        if key not in VOLATILE_METADATA
    }
    return hashlib.sha256(
        json.dumps(dict(record, metadata=metadata), sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def update(db: sqlite3.Connection, record: Mapping[str, Any]) -> None:
    """Write a record and record a change event only when its published facts differ."""
    key = record["session"], record["id"], record["language"]
    sig = signature(record)
    existing = db.execute(
        "SELECT signature FROM cc_revision WHERE session=? AND id=? AND language=?", key
    ).fetchone()
    if existing and existing[0] == sig:
        if {"lastChecked", "directoryCutoffs", "submissionIndex", "observedAt"} & (
            record.get("metadata") or {}
        ).keys():
            write_record(db, record)
        return
    write_record(db, record)
    db.execute("INSERT OR REPLACE INTO cc_revision VALUES(?,?,?,?)", (*key, sig))
    db.execute(
        "INSERT INTO cc_changes(session,id,language,signature) VALUES(?,?,?,?)",
        (*key, sig),
    )

