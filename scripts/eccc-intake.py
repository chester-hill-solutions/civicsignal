#!/usr/bin/env python3
"""Fetch and inventory ECCC departmental publications without extracting text."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import re
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from time import perf_counter
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import committee_files
from lib.eccc_index import LANGUAGES, SERIES, document_id, parse_index, work_id

TOOL_VERSION = "1.0.0"
DEFAULT_ROOT = Path("data/corpus/eccc")
INDEX_URLS = {
    ("eval", "en"): "https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations.html",
    ("eval", "fr"): "https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/evaluations.html",
    ("audit", "en"): "https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits.html",
    ("audit", "fr"): "https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/audits-internes.html",
}
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "preview"
    / "departmental-publications"
    / "migrations"
    / "0001_dp.sql"
)


def _observed_at():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cache_rows(root, urls):
    db = committee_files.cache_db(Path(root))
    try:
        result = {}
        for url in urls:
            row = db.execute("SELECT * FROM files WHERE url=?", (url,)).fetchone()
            if row is not None:
                result[url] = dict(row)
        return result
    finally:
        db.close()


def capture_urls(root, urls, workers=4, refresh=True, from_cache=False, capture_fn=None):
    """Capture URLs and retry transient errors once; cache-only mode never fetches."""
    urls = sorted(set(urls))
    if not urls:
        return {}
    root = Path(root)
    capture_fn = capture_fn or committee_files.capture
    workers = min(max(int(workers), 1), 4)

    if from_cache:
        cached = _cache_rows(root, urls)
        return {
            url: cached.get(
                url,
                {
                    "url": url,
                    "digest": None,
                    "media": None,
                    "size": 0,
                    "error": "URL is not present in the offline cache",
                    "checked": None,
                    "final_url": None,
                },
            )
            for url in urls
        }

    capture_fn(root, urls, workers=workers, refresh=refresh)
    rows = _cache_rows(root, urls)
    retry = [
        url
        for url in urls
        if (row := rows.get(url)) is None
        or (
            row.get("error")
            and row["error"] not in {"HTTP 404", "HTTP 410"}
        )
    ]
    if retry:
        capture_fn(root, retry, workers=workers, refresh=True)
        rows.update(_cache_rows(root, retry))
    return {
        url: rows.get(
            url,
            {
                "url": url,
                "digest": None,
                "media": None,
                "size": 0,
                "error": "capture produced no cache record",
                "checked": None,
                "final_url": None,
            },
        )
        for url in urls
    }


class _AlternatesParser(HTMLParser):
    def __init__(self, document_url):
        super().__init__(convert_charrefs=True)
        self.document_url = document_url
        self.alternates = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        href = attrs.get("href")
        if not href or not attrs.get("hreflang"):
            return
        if tag == "link" and "alternate" not in attrs.get("rel", "").lower().split():
            return
        if tag not in {"link", "a"}:
            return
        self.alternates.add(urljoin(self.document_url, href))


def parse_alternates(html, document_url):
    """Return absolute alternate-language URLs named by an HTML document."""
    parser = _AlternatesParser(document_url)
    parser.feed(html)
    parser.close()
    return parser.alternates


def pair_entries(entries, alternates):
    """Pair only editions linked by explicit hreflang relationships."""
    unique = []
    seen = set()
    duplicated = 0
    for source in entries:
        entry = dict(source)
        entry["links"] = list(source.get("links", []))
        local_id = work_id(entry["series"], entry)
        identity = (entry["series"], entry["language"], local_id)
        if identity in seen:
            duplicated += 1
            continue
        seen.add(identity)
        entry["_local_id"] = local_id
        unique.append(entry)

    edges = []
    for left_index, left in enumerate(unique):
        for right_index in range(left_index + 1, len(unique)):
            right = unique[right_index]
            if (
                left["series"] != right["series"]
                or left["language"] == right["language"]
            ):
                continue
            left_urls = {link["href"] for link in left.get("links", [])}
            right_urls = {link["href"] for link in right.get("links", [])}
            named_by_left = any(
                target in right_urls
                for url in left_urls
                for target in alternates.get(url, ())
            )
            named_by_right = any(
                target in left_urls
                for url in right_urls
                for target in alternates.get(url, ())
            )
            if named_by_left or named_by_right:
                edges.append((left_index, right_index))

    paired = {}
    for left_index, right_index in edges:
        if left_index in paired or right_index in paired:
            continue
        paired[left_index] = right_index
        paired[right_index] = left_index

    works = []
    gaps = []
    consumed = set()
    for index, entry in enumerate(unique):
        if index in consumed:
            continue
        other_index = paired.get(index)
        editions = {entry["language"]: entry}
        if other_index is not None:
            other = unique[other_index]
            editions[other["language"]] = other
            consumed.add(other_index)
        english = editions.get("en")
        canonical = english or entry
        work = {
            "id": work_id(canonical["series"], canonical),
            "series": canonical["series"],
            "editions": editions,
        }
        works.append(work)
        if len(editions) == 1:
            gaps.append(
                {
                    "kind": "pairing",
                    "series": entry["series"],
                    "language": entry["language"],
                    "url": entry.get("index_url"),
                    "work_id": work["id"],
                    "reason": "No explicit language alternate identified",
                }
            )
        consumed.add(index)

    works.sort(key=lambda work: (work["series"], work["id"]))
    return {
        "works": works,
        "gaps": gaps,
        "duplicated_index_appearances": duplicated,
    }


def collect_document_urls(entries):
    return sorted(
        {
            link["href"]
            for entry in entries
            for link in entry.get("links", [])
            if committee_files.fetchable(link.get("href", ""))
        }
    )


def discover_alternates(root, entries, cache_rows):
    alternates = {}
    for entry in entries:
        for link in entry.get("links", []):
            url = link.get("href")
            row = cache_rows.get(url, {})
            digest = row.get("digest")
            if not digest or row.get("error"):
                continue
            media = (row.get("media") or "").lower()
            if not (media.startswith("text/html") or url.lower().split("?", 1)[0].endswith((".html", ".htm"))):
                continue
            try:
                body = committee_files.read_object(Path(root), digest).decode(
                    "utf-8", errors="replace"
                )
            except (OSError, ValueError):
                continue
            targets = parse_alternates(body, url)
            final_url = row.get("final_url")
            alternates[url] = targets
            if final_url:
                alternates[final_url] = targets
    return alternates


VOLATILE_BLOCKS = (
    re.compile(r"<script\b.*?</script>", re.S | re.I),
    re.compile(r"<style\b.*?</style>", re.S | re.I),
    re.compile(r"<!--.*?-->", re.S),
)


def content_digest(root, record):
    """A digest of the published text, ignoring per-request decoration.

    canada.ca injects a fresh analytics script on every response, so raw bytes
    differ on every fetch. Scripts, styles and comments are removed and
    whitespace is collapsed before hashing; other formats keep the byte digest.
    """
    digest = record.get("digest")
    if not digest:
        return None
    if (record.get("media") or "").split(";")[0].strip() != "text/html":
        return digest
    try:
        body = committee_files.read_object(Path(root), digest).decode("utf-8", "replace")
    except (OSError, ValueError):
        return digest
    for pattern in VOLATILE_BLOCKS:
        body = pattern.sub(" ", body)
    return hashlib.sha256(" ".join(body.split()).encode("utf-8")).hexdigest()


def attach_documents(root, works, cache_rows):
    """Attach archival status to every link and return non-official/fetch gaps."""
    gaps = []
    for work in works:
        for edition in work["editions"].values():
            documents = []
            for link in edition.get("links", []):
                url = link["href"]
                official = committee_files.fetchable(url)
                record = cache_rows.get(url, {})
                error = record.get("error")
                digest = record.get("digest")
                if not official:
                    status = "fetch-failed"
                    gaps.append(
                        {
                            "kind": "non-official",
                            "series": edition["series"],
                            "language": edition["language"],
                            "url": url,
                            "reason": "Link is not an official HTTPS Government of Canada URL",
                        }
                    )
                elif error in {"HTTP 404", "HTTP 410"}:
                    status = "unavailable"
                    gaps.append(
                        {
                            "kind": "document",
                            "series": edition["series"],
                            "language": edition["language"],
                            "url": url,
                            "reason": error,
                        }
                    )
                elif error or not digest:
                    status = "fetch-failed"
                    gaps.append(
                        {
                            "kind": "document",
                            "series": edition["series"],
                            "language": edition["language"],
                            "url": url,
                            "reason": error or "No archived response",
                        }
                    )
                else:
                    status = "stored"
                documents.append(
                    {
                        **link,
                        "status": status,
                        "sha256": digest,
                        "content_sha256": content_digest(root, record) if digest else None,
                        "media": record.get("media"),
                        "bytes": record.get("size"),
                        "final_url": record.get("final_url") or url,
                        "fetched_at": record.get("checked"),
                    }
                )
            edition["documents"] = documents
    return gaps


def _gap_id(gap, observed_at):
    identity = "\0".join(
        str(gap.get(key) or "")
        for key in ("kind", "series", "language", "url", "work_id", "reason")
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"gap-{observed_at}-{digest}"


def _insert_change(db, work_id_value, document_id_value, change, observed_at):
    db.execute(
        """INSERT OR IGNORE INTO dp_changes(work_id,document_id,change,observed_at)
        SELECT ?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM dp_changes WHERE work_id IS ? AND document_id IS ?
            AND change=? AND observed_at=?
        )""",
        (
            work_id_value,
            document_id_value,
            change,
            observed_at,
            work_id_value,
            document_id_value,
            change,
            observed_at,
        ),
    )


def _inventory_revision(db):
    facts = {}
    for table, columns in {
        "dp_indexes": "url,series,language,sha256,bytes",
        "dp_works": "id,series,title_en,title_fr,lead_en,lead_fr,revision",
        "dp_editions": "work_id,language,fiscal_year,title,lead,index_url",
        "dp_documents": "id,work_id,language,kind,label,url,final_url,sha256,media,bytes,status",
    }.items():
        facts[table] = [
            list(row)
            for row in db.execute(
                f"SELECT {columns} FROM {table} ORDER BY {columns}"
            )
        ]
    payload = json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _counts(db, observed_at, duplicated_index_appearances=0):
    documents = {
        row["kind"]: {}
        for row in db.execute("SELECT DISTINCT kind FROM dp_documents")
    }
    for row in db.execute(
        "SELECT kind,status,COUNT(*) AS count FROM dp_documents GROUP BY kind,status"
    ):
        documents.setdefault(row["kind"], {})[row["status"]] = row["count"]
    editions = {
        language: count
        for language, count in db.execute(
            "SELECT language,COUNT(*) FROM dp_editions GROUP BY language"
        )
    }
    archived = {}
    for row in db.execute(
        """SELECT sha256,MAX(bytes) AS bytes FROM (
             SELECT sha256,bytes FROM dp_indexes
             UNION ALL
             SELECT sha256,bytes FROM dp_documents
           ) WHERE sha256 IS NOT NULL GROUP BY sha256"""
    ):
        archived[row["sha256"]] = row["bytes"] or 0
    return {
        "indexes": db.execute("SELECT COUNT(*) FROM dp_indexes").fetchone()[0],
        "works": db.execute("SELECT COUNT(*) FROM dp_works").fetchone()[0],
        "editionsByLanguage": editions,
        "documentsByKindAndStatus": documents,
        "archivedBytes": sum(archived.values()),
        "versions": db.execute("SELECT COUNT(*) FROM dp_document_versions").fetchone()[0],
        "changes": {
            row["change"]: row["count"]
            for row in db.execute(
                "SELECT change,COUNT(*) AS count FROM dp_changes WHERE observed_at=? GROUP BY change",
                (observed_at,),
            )
        },
        "gapsByKind": {
            row["kind"]: row["count"]
            for row in db.execute(
                "SELECT kind,COUNT(*) AS count FROM dp_gaps WHERE observed_at=? GROUP BY kind",
                (observed_at,),
            )
        },
        "pairingGaps": db.execute(
            "SELECT COUNT(*) FROM dp_gaps WHERE observed_at=? AND kind='pairing'",
            (observed_at,),
        ).fetchone()[0],
        "duplicatedIndexAppearances": duplicated_index_appearances,
    }


def write_inventory(
    db,
    works,
    observed_at,
    indexes=(),
    gaps=(),
    duplicated_index_appearances=0,
    selected_series=SERIES,
):
    """Atomically write prepared index, work, edition and document facts."""
    if db.in_transaction:
        raise RuntimeError("write_inventory requires a connection outside a transaction")
    db.row_factory = sqlite3.Row
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = db.execute(
            "SELECT cutoff FROM dp_inventory WHERE singleton=1"
        ).fetchone()
        if prior and observed_at < prior["cutoff"]:
            raise ValueError(
                f"Observation {observed_at} is older than stored cutoff {prior['cutoff']}"
            )

        selected_series = tuple(selected_series)
        for item in indexes:
            if not item.get("sha256"):
                continue
            db.execute(
                """INSERT INTO dp_indexes(url,series,language,observed_at,sha256,bytes)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(url) DO UPDATE SET series=excluded.series,
                     language=excluded.language,observed_at=excluded.observed_at,
                     sha256=excluded.sha256,bytes=excluded.bytes""",
                (
                    item["url"],
                    item["series"],
                    item["language"],
                    observed_at,
                    item["sha256"],
                    item["bytes"],
                ),
            )

        current_work_ids = {work["id"] for work in works}
        current_edition_keys = set()
        current_documents = {}

        for work in works:
            titles = {
                language: edition["title"]
                for language, edition in work["editions"].items()
            }
            leads = {
                language: edition.get("lead")
                for language, edition in work["editions"].items()
            }
            previous = db.execute(
                "SELECT * FROM dp_works WHERE id=?", (work["id"],)
            ).fetchone()
            values = (
                work["series"],
                titles.get("en"),
                titles.get("fr"),
                leads.get("en"),
                leads.get("fr"),
            )
            if previous:
                changed = values != tuple(
                    previous[key]
                    for key in ("series", "title_en", "title_fr", "lead_en", "lead_fr")
                )
                revision = previous["revision"] + int(changed)
                first_observed = previous["first_observed_at"]
            else:
                revision = 1
                first_observed = observed_at
            db.execute(
                """INSERT INTO dp_works
                   (id,series,title_en,title_fr,lead_en,lead_fr,first_observed_at,last_observed_at,revision)
                   VALUES(?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET series=excluded.series,
                     title_en=excluded.title_en,title_fr=excluded.title_fr,
                     lead_en=excluded.lead_en,lead_fr=excluded.lead_fr,
                     last_observed_at=excluded.last_observed_at,revision=excluded.revision""",
                (work["id"], *values, first_observed, observed_at, revision),
            )

            for language, edition in work["editions"].items():
                current_edition_keys.add((work["id"], language))
                db.execute(
                    """INSERT INTO dp_editions
                       (work_id,language,fiscal_year,title,lead,index_url,first_observed_at,last_observed_at)
                       VALUES(?,?,?,?,?,?,?,?)
                       ON CONFLICT(work_id,language) DO UPDATE SET
                         fiscal_year=excluded.fiscal_year,title=excluded.title,
                         lead=excluded.lead,index_url=excluded.index_url,
                         last_observed_at=excluded.last_observed_at""",
                    (
                        work["id"],
                        language,
                        edition["fiscal_year"],
                        edition["title"],
                        edition.get("lead"),
                        edition["index_url"],
                        observed_at,
                        observed_at,
                    ),
                )
                for link in edition.get("documents", []):
                    doc_id = document_id(
                        work["id"], language, link["kind"], link["href"]
                    )
                    current_documents[doc_id] = (work, language, edition, link)

        scoped_work_ids = {
            row["id"]
            for row in db.execute(
                "SELECT id FROM dp_works WHERE series IN ("
                + ",".join("?" for _ in selected_series)
                + ")",
                selected_series,
            )
        } if selected_series else set()
        if scoped_work_ids:
            placeholders = ",".join("?" for _ in scoped_work_ids)
            prior_documents = {
                row["id"]: row
                for row in db.execute(
                    f"SELECT * FROM dp_documents WHERE work_id IN ({placeholders})",
                    tuple(scoped_work_ids),
                )
            }
            old_edition_keys = [
                (row["work_id"], row["language"])
                for row in db.execute(
                    f"SELECT work_id,language FROM dp_editions WHERE work_id IN ({placeholders})",
                    tuple(scoped_work_ids),
                )
            ]
            for work_id_value, language in old_edition_keys:
                if (work_id_value, language) not in current_edition_keys:
                    db.execute(
                        "DELETE FROM dp_editions WHERE work_id=? AND language=?",
                        (work_id_value, language),
                    )
            for doc_id, previous in prior_documents.items():
                if doc_id not in current_documents and previous["status"] != "removed":
                    db.execute(
                        "UPDATE dp_documents SET status='removed',last_observed_at=? WHERE id=?",
                        (observed_at, doc_id),
                    )
                    _insert_change(
                        db, previous["work_id"], doc_id, "removed", observed_at
                    )
        else:
            prior_documents = {}

        for doc_id, (work, language, edition, link) in current_documents.items():
            previous = db.execute(
                "SELECT * FROM dp_documents WHERE id=?", (doc_id,)
            ).fetchone()
            status = link.get("status", "fetch-failed")
            digest = link.get("sha256")
            content = link.get("content_sha256") or digest
            values = (
                work["id"],
                language,
                link["kind"],
                link.get("label") or "",
                link["href"],
                link.get("final_url"),
                digest,
                content,
                link.get("media"),
                link.get("bytes"),
                status,
            )
            if previous is None or previous["status"] == "removed":
                _insert_change(db, work["id"], doc_id, "added", observed_at)
            elif (
                previous["content_sha256"]
                and content
                and previous["content_sha256"] != content
                and status == "stored"
            ):
                _insert_change(db, work["id"], doc_id, "changed", observed_at)

            first_observed = (
                previous["first_observed_at"] if previous else observed_at
            )
            db.execute(
                """INSERT INTO dp_documents
                   (id,work_id,language,kind,label,url,final_url,sha256,content_sha256,media,bytes,status,
                    fetched_at,first_observed_at,last_observed_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET work_id=excluded.work_id,
                     language=excluded.language,kind=excluded.kind,label=excluded.label,
                     url=excluded.url,final_url=excluded.final_url,sha256=excluded.sha256,
                     content_sha256=excluded.content_sha256,
                     media=excluded.media,bytes=excluded.bytes,status=excluded.status,
                     fetched_at=excluded.fetched_at,last_observed_at=excluded.last_observed_at""",
                (
                    doc_id,
                    *values,
                    link.get("fetched_at"),
                    first_observed,
                    observed_at,
                ),
            )
            if digest and link.get("bytes") is not None:
                db.execute(
                    """INSERT OR IGNORE INTO dp_document_versions
                       (document_id,content_sha256,sha256,media,bytes,observed_at)
                       VALUES(?,?,?,?,?,?)""",
                    (doc_id, content, digest, link.get("media"), link["bytes"], observed_at),
                )

        # Keep current work and edition rows limited to the selected series.
        if selected_series:
            series_marks = ",".join("?" for _ in selected_series)
            stale_work_ids = [
                row["id"]
                for row in db.execute(
                    f"SELECT id FROM dp_works WHERE series IN ({series_marks})",
                    selected_series,
                )
                if row["id"] not in current_work_ids
            ]
            if stale_work_ids:
                marks = ",".join("?" for _ in stale_work_ids)
                db.execute(f"DELETE FROM dp_editions WHERE work_id IN ({marks})", stale_work_ids)
                db.execute(f"DELETE FROM dp_works WHERE id IN ({marks})", stale_work_ids)

        for gap in gaps:
            db.execute(
                """INSERT OR IGNORE INTO dp_gaps
                   (id,kind,series,language,url,reason,observed_at) VALUES(?,?,?,?,?,?,?)""",
                (
                    _gap_id(gap, observed_at),
                    gap["kind"],
                    gap.get("series"),
                    gap.get("language"),
                    gap.get("url"),
                    gap["reason"],
                    observed_at,
                ),
            )

        revision = _inventory_revision(db)
        counts = _counts(db, observed_at, duplicated_index_appearances)
        counts_json = json.dumps(counts, ensure_ascii=False, sort_keys=True)
        db.execute(
            """INSERT INTO dp_inventory(singleton,cutoff,observed_at,revision,counts_json)
               VALUES(1,?,?,?,?)
               ON CONFLICT(singleton) DO UPDATE SET cutoff=excluded.cutoff,
                 observed_at=excluded.observed_at,revision=excluded.revision,
                 counts_json=excluded.counts_json""",
            (observed_at, observed_at, revision, counts_json),
        )
        db.commit()
        return {"revision": revision, "counts": counts}
    except Exception:
        db.rollback()
        raise


def build_receipt(
    db,
    observed_at,
    duration_ms,
    indexes,
    entries_by_series_language,
    link_appearances,
    counts,
):
    index_hashes = {item["url"]: item.get("sha256") for item in indexes}
    return {
        "toolVersion": TOOL_VERSION,
        "observedAt": observed_at,
        "durationMs": duration_ms,
        "indexes": [
            {
                "url": item["url"],
                "series": item["series"],
                "language": item["language"],
                "sha256": item.get("sha256"),
                "bytes": item.get("bytes"),
                "entries": item.get("entries", 0),
            }
            for item in indexes
        ],
        "indexHashes": index_hashes,
        "entriesBySeriesLanguage": entries_by_series_language,
        "uniqueWorks": counts["works"],
        "editionsByLanguage": counts["editionsByLanguage"],
        "documentsByKindAndStatus": counts["documentsByKindAndStatus"],
        "archivedBytes": counts["archivedBytes"],
        "versions": counts["versions"],
        "changeCounts": counts["changes"],
        "gapsByKind": counts["gapsByKind"],
        "pairingGaps": counts["pairingGaps"],
        "duplicatedIndexAppearances": counts["duplicatedIndexAppearances"],
        "reconciliation": {
            "baselineDate": "2026-11-23",
            "baselineTitleAppearances": 181,
            "baselineLinkAppearances": 316,
            "observedTitleAppearances": sum(
                sum(languages.values())
                for languages in entries_by_series_language.values()
            ),
            "observedLinkAppearances": link_appearances,
            "liveSnapshotAnchors": 318,
            "explanation": (
                "The baseline counted 181 title paragraphs; 155 of them carry links. "
                "The 26 audit paragraphs without links are notes inside a fiscal-year "
                "group, not entries. The 318 anchors include 36 links in those notes; "
                "the intake inventories 282 link appearances."
            ),
        },
    }


def _load_migration(db):
    db.executescript(MIGRATION.read_text(encoding="utf-8"))


def _write_receipt(path, receipt):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        json.dump(receipt, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        temporary = stream.name
    os.replace(temporary, path)


def run_intake(root, db_path, receipt_path, series=SERIES, workers=4, from_cache=False):
    started = perf_counter()
    observed_at = _observed_at()
    series = tuple(series)
    workers = min(max(int(workers), 1), 4)
    root = Path(root)
    selected_indexes = [
        (name, language, url)
        for (name, language), url in INDEX_URLS.items()
        if name in series
    ]
    index_cache = capture_urls(
        root,
        [url for _, _, url in selected_indexes],
        workers=workers,
        refresh=True,
        from_cache=from_cache,
    )

    parsed_entries = []
    indexes = []
    gaps = []
    entries_by_series_language = {}
    index_appearances = {}
    for name, language, url in selected_indexes:
        record = index_cache[url]
        digest = record.get("digest")
        if not digest:
            raise RuntimeError(
                f"Index has no archived copy; inventory was not written: {url}"
            )
        if record.get("error"):
            gaps.append(
                {
                    "kind": "index",
                    "series": name,
                    "language": language,
                    "url": url,
                    "reason": record["error"],
                }
            )
        html = committee_files.read_object(root, digest).decode(
            "utf-8", errors="replace"
        )
        entries = parse_index(html, name, language)
        for entry in entries:
            entry["index_url"] = url
        parsed_entries.extend(entries)
        entries_by_series_language.setdefault(name, {})[language] = len(entries)
        links_count = sum(len(entry["links"]) for entry in entries)
        index_appearances[url] = links_count
        indexes.append(
            {
                "url": url,
                "series": name,
                "language": language,
                "sha256": digest,
                "bytes": record.get("size"),
                "entries": len(entries),
            }
        )
        if not entries:
            gaps.append(
                {
                    "kind": "index",
                    "series": name,
                    "language": language,
                    "url": url,
                    "reason": "Index parsed with no publication entries",
                }
            )

    document_urls = collect_document_urls(parsed_entries)
    document_cache = capture_urls(
        root,
        document_urls,
        workers=workers,
        refresh=True,
        from_cache=from_cache,
    )
    alternates = discover_alternates(root, parsed_entries, document_cache)
    paired = pair_entries(parsed_entries, alternates)
    gaps.extend(paired["gaps"])
    gaps.extend(attach_documents(root, paired["works"], document_cache))

    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        _load_migration(db)
        result = write_inventory(
            db,
            paired["works"],
            observed_at,
            indexes=indexes,
            gaps=gaps,
            duplicated_index_appearances=paired["duplicated_index_appearances"],
            selected_series=series,
        )
        receipt = build_receipt(
            db,
            observed_at,
            round((perf_counter() - started) * 1000),
            indexes,
            entries_by_series_language,
            sum(index_appearances.values()),
            result["counts"],
        )
        _write_receipt(receipt_path, receipt)
        return receipt
    finally:
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--receipt", type=Path, default=Path("dist/eccc/inventory.json"))
    parser.add_argument("--from-cache", action="store_true")
    parser.add_argument("--series", action="append", choices=SERIES)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args(argv)
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    db_path = args.db or args.root / "catalogue.sqlite"
    selected_series = args.series or SERIES
    receipt = run_intake(
        args.root,
        db_path,
        args.receipt,
        series=selected_series,
        workers=args.workers,
        from_cache=args.from_cache,
    )
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
