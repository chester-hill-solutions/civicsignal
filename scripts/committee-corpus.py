"""Build a resumable local committee research database from the official catalogue and originals."""

import argparse
import fcntl
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3

from lib.committee_files import cache_db, fetch_url, read_object
from lib.committee_inventory import Inventory, SUBMISSIONS
from lib.committee_proceedings import extract_proceedings
from lib.committee_publications import extract_publication
from lib.committee_store import initialize, replace_passages, signature, update, write_record
from lib.committee_submissions import extract_submission, classify_extraction
from lib.wq_catalog import save_atomic


def extractor_version():
    base = Path(__file__).parent / "lib"
    return {
        kind: hashlib.sha256((base / name).read_bytes()).hexdigest()
        for kind, name in [
            ("proceedings", "committee_proceedings.py"),
            ("publication", "committee_publications.py"),
            ("submission", "committee_submissions.py"),
        ]
    }


def parser(row, file):
    if row["kind"] in SUBMISSIONS or file["media"] not in {
        "text/html",
        "application/xhtml+xml",
    }:
        return "submission"
    return "proceedings" if row["kind"] == "evidence" else "publication"


def extract(task):
    root, row, file = task
    body = read_object(root, file["digest"])
    media = file["media"] or ""
    try:
        adapter = parser(row, file)
        if adapter == "submission":
            passages = extract_submission(body, row["url"], media)
            outcome = classify_extraction(body, row["url"], media, passages)
        else:
            read = (
                extract_proceedings if adapter == "proceedings" else extract_publication
            )
            passages = read(body, row["url"], row["language"])
            outcome = "searchable" if passages else "no-published-text-found"
    except (ValueError, RuntimeError) as error:
        return [], str(error)
    return passages, None if passages else outcome


def write_graph(db, inventory):
    rows = [(inventory.session, *e) for e in sorted(inventory.links)]
    # A temporarily unreadable index cannot establish a removal.
    db.execute("CREATE TEMP TABLE incoming_links AS SELECT * FROM cc_links WHERE 0")
    db.executemany("INSERT INTO incoming_links VALUES(?,?,?,?,?)", rows)
    db.execute("""INSERT INTO cc_link_changes(session,language,parent_id,child_id,relation,change)
        SELECT a.*, 'added' FROM (SELECT * FROM incoming_links EXCEPT SELECT * FROM cc_links) a""")
    db.execute("INSERT OR IGNORE INTO cc_links SELECT * FROM incoming_links")
    gaps = {
        inventory.records[lang, cid]["committee_id"]
        for lang, cid in inventory.records
        if inventory.records[lang, cid]["kind"] == "index-gap"
    }
    old = db.execute(
        "SELECT * FROM cc_links WHERE session=? EXCEPT SELECT * FROM incoming_links",
        (inventory.session,),
    )
    removed = []
    for session, lang, parent, child, relation in old:
        row = db.execute(
            "SELECT committee_id FROM cc_records WHERE session=? AND language=? AND id=?",
            (session, lang, parent),
        ).fetchone()
        if row and row[0] not in gaps:
            removed.append((session, lang, parent, child, relation))
    db.executemany(
        "DELETE FROM cc_links WHERE session=? AND language=? AND parent_id=? AND child_id=? AND relation=?",
        removed,
    )
    db.executemany(
        "INSERT INTO cc_link_changes(session,language,parent_id,child_id,relation,change) VALUES(?,?,?,?,?,'removed')",
        removed,
    )
    db.execute("DROP TABLE incoming_links")
    for row in db.execute(
        "SELECT * FROM cc_records WHERE session=? AND status NOT IN ('removed','superseded')",
        (inventory.session,),
    ).fetchall():
        if (row["language"], row["id"]) in inventory.records or row[
            "committee_id"
        ] in gaps:
            continue
        record = dict(row)
        record["metadata"] = json.loads(record.pop("metadata_json"))
        replacements = sorted(
            inventory.by_url.get((row["language"], row["url"]), set()) - {row["id"]}
        )
        if replacements:
            record["status"] = "superseded"
            record["metadata"]["replacementIds"] = replacements
        else:
            record["status"] = "removed"
        update(db, record)
        replace_passages(db, inventory.session, row["language"], row["id"], [])
        db.execute(
            "DELETE FROM cc_extracted WHERE session=? AND id=? AND language=?",
            (inventory.session, row["id"], row["language"]),
        )


def run(root, workers, catalogue=None):
    source = json.loads((catalogue or root / "catalogue.json").read_text())
    if source.get("completed", source.get("complete")) is False:
        raise ValueError("The catalogue is an unfinished crawl checkpoint.")
    inventory = Inventory(source)
    parts = root / "publication-parts.json"
    cache = cache_db(root)
    files = {r["url"]: dict(r) for r in cache.execute("SELECT * FROM files")}
    cache.close()
    if parts.is_file():
        derived = json.loads(parts.read_text())
        for url, digest in derived.get("sourceDigests", {}).items():
            if files.get(url, {}).get("digest") != digest:
                raise ValueError(
                    "Rebuild publication parts after the changed official page: " + url
                )
        inventory.add_publication_parts(derived)
    db = initialize(sqlite3.connect(root / "committee.sqlite", timeout=60))
    db.executescript("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
    # Each record checkpoints independently. Only a finished graph can be published.
    with db:
        db.execute("DELETE FROM cc_snapshot WHERE session=?", (inventory.session,))
    prior = {
        (r["language"], r["id"]): dict(r)
        for r in db.execute(
            "SELECT * FROM cc_extracted WHERE session=?", (inventory.session,)
        )
    }
    versions = extractor_version()
    work = []
    for key, row in inventory.records.items():
        if key not in inventory.wanted:
            if row["kind"] == "index-gap":
                observed = files.get(fetch_url(row["url"]))
                if observed and observed["error"]:
                    row["metadata"].update(
                        reason=observed["error"], lastChecked=observed["checked"]
                    )
                else:
                    row["metadata"]["lastChecked"] = inventory.cutoff
            update(db, row)
            continue
        url = fetch_url(inventory.wanted[key])
        if "%23" in url and "#" in row["url"] and row["url"] != url:
            row["metadata"]["listedUrl"] = row["url"]
            row["url"] = url
        file = files.get(url)
        if not file or not file["digest"]:
            for alternate in row["metadata"].get("alternateUrls", []):
                mirror = files.get(fetch_url(alternate))
                if mirror and mirror["digest"]:
                    row["metadata"]["listedUrl"] = row["url"]
                    row["url"] = alternate
                    file = mirror
                    break
        if not file or not file["digest"]:
            row["status"] = "unavailable" if file else "pending"
            if file:
                row["metadata"]["reason"] = file["error"]
                row["metadata"]["lastChecked"] = file["checked"]
            update(db, row)
            if key in prior:
                replace_passages(db, row["session"], row["language"], row["id"], [])
                db.execute(
                    "DELETE FROM cc_extracted WHERE session=? AND id=? AND language=?",
                    (row["session"], row["id"], row["language"]),
                )
            continue
        row["object_sha256"] = file["digest"]
        version = versions[parser(row, file)]
        row["metadata"].update(mediaType=file["media"], bytes=file["size"])
        if file["error"]:
            row["metadata"].update(
                refreshError=file["error"], lastChecked=file["checked"]
            )
        if old := prior.get(key):
            if (old["digest"], old["version"]) == (file["digest"], version):
                row["status"] = old["status"]
                if old["reason"]:
                    row["metadata"]["reason"] = old["reason"]
                update(db, row)
                continue
        work.append((root, row, file))
    db.commit()
    print(
        f"Catalogued {len(inventory.records)} editions. Extracting {len(work)} publications.",
        flush=True,
    )
    with ProcessPoolExecutor(max_workers=workers) as pool:
        # Bound queued document bodies/results across supported Python versions.
        for start in range(0, len(work), 32):
            batch = work[start : start + 32]
            for (_, row, file), (passages, reason) in zip(
                batch, pool.map(extract, batch)
            ):
                row["status"] = "searchable" if passages else "stored"
                if reason:
                    row["metadata"]["reason"] = reason
                update(db, row)
                replace_passages(
                    db, row["session"], row["language"], row["id"], passages
                )
                db.execute(
                    "INSERT OR REPLACE INTO cc_extracted VALUES(?,?,?,?,?,?,?)",
                    (
                        row["session"],
                        row["id"],
                        row["language"],
                        file["digest"],
                        versions[parser(row, file)],
                        row["status"],
                        reason,
                    ),
                )
            db.commit()
            if start % 1024 == 0:
                print(
                    "Extracted", min(start + 32, len(work)), "of", len(work), flush=True
                )
    with db:
        write_graph(db, inventory)
        missing_endpoint = db.execute(
            """SELECT l.parent_id, l.child_id FROM cc_links l
               LEFT JOIN cc_records p ON (p.session,p.language,p.id)=(l.session,l.language,l.parent_id)
               LEFT JOIN cc_records c ON (c.session,c.language,c.id)=(l.session,l.language,l.child_id)
               WHERE l.session=? AND (p.id IS NULL OR c.id IS NULL) LIMIT 1""",
            (inventory.session,),
        ).fetchone()
        if missing_endpoint:
            raise ValueError(
                f"Publication relationship has a missing record: {tuple(missing_endpoint)}"
            )
        db.execute(
            "INSERT OR REPLACE INTO cc_snapshot VALUES(?,?)",
            (inventory.session, inventory.cutoff),
        )
    result = dict(
        session=inventory.session,
        cutoff=inventory.cutoff,
        sourceObservations=inventory.source_observations,
        indexGaps=inventory.index_gaps,
        editions=[
            dict(r)
            for r in db.execute(
                "SELECT chamber,committee_id,language,kind,status,count(*) AS count FROM cc_records GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5"
            )
        ],
        passages=db.execute("SELECT count(*) FROM cc_passages").fetchone()[0],
        changes=db.execute("SELECT count(*) FROM cc_changes").fetchone()[0],
        relationshipChanges=db.execute(
            "SELECT count(*) FROM cc_link_changes"
        ).fetchone()[0],
        relationships=db.execute("SELECT count(*) FROM cc_links").fetchone()[0],
    )
    save_atomic(root / "coverage.json", result)
    print(json.dumps({k: v for k, v in result.items() if k != "editions"}), flush=True)
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path("data/corpus/committees"))
    p.add_argument(
        "--catalogue", type=Path, help="Use a specific completed inventory snapshot."
    )
    p.add_argument("--workers", type=int, choices=range(1, 13), default=5)
    args = p.parse_args()
    with (args.root / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(args.root, args.workers, args.catalogue)
