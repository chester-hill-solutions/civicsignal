"""Carry an archived House call observation into a later private SQLite preview."""
import argparse
from contextlib import closing
from datetime import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile

from lib.committee_calls import PARTICIPATE_INDEX, call_id, committee_id, parse_call_editions, parse_call_indexes, study_url
from lib.committee_files import read_object
from lib.committee_store import write_link, write_record

SESSION = "45-1"
LANGUAGES = {"en", "fr"}


def instant(value):
    result = datetime.fromisoformat(value)
    if result.utcoffset() is None:
        raise ValueError("Committee evidence timestamps must include an offset.")
    return result


def closed_stamp(path):
    if any(sidecar.is_file() and sidecar.stat().st_size for sidecar in
           (path.with_name(path.name + suffix) for suffix in ("-wal", "-journal"))):
        raise ValueError(f"The committee input must be closed and checkpointed: {path.name}")
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def connect_closed(path):
    path = path.resolve(strict=True)
    closed_stamp(path)
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    return db


def cutoff(db):
    row = db.execute("SELECT cutoff FROM cc_snapshot WHERE session=?", (SESSION,)).fetchone()
    if row is None:
        raise ValueError("The committee input lacks a full-corpus cutoff.")
    return row[0]


def house_calls(db):
    return {(row["id"], row["language"]): dict(row) for row in db.execute(
        "SELECT * FROM cc_records WHERE session=? AND kind='call' AND chamber='house'", (SESSION,))}


def house_links(db):
    return {tuple(row) for row in db.execute("""SELECT l.language,l.parent_id,l.child_id,l.relation
        FROM cc_links l JOIN cc_records c ON (c.session,c.id,c.language)=(l.session,l.child_id,l.language)
        WHERE l.session=? AND c.kind='call' AND c.chamber='house' AND l.relation IN ('publishes','study-call')""", (SESSION,))}


def original_editions(receipt, originals):
    digests = {item["sha256"] for item in receipt["sources"]} | {call["sourceSha256"] for call in receipt["calls"]}
    if not all(re.fullmatch("[a-f0-9]{64}", digest) for digest in digests):
        raise ValueError("The retained receipt contains an invalid original hash.")
    bodies = {digest: read_object(originals, digest) for digest in digests}
    indexes = {item["url"]: bodies[item["sha256"]].decode("utf-8", "replace") for item in receipt["sources"]
               if item["chamber"] == "house" and PARTICIPATE_INDEX.get(item["language"]) == item["url"]}
    listings = parse_call_indexes(indexes)
    studies = {item["citation"]: bodies[item["sourceSha256"]].decode("utf-8", "replace") for item in receipt["calls"]}
    editions = parse_call_editions(SESSION, listings, studies)
    return {(call_id(item["study"]["committee"], item["study"]["study_id"]), item["language"]): item
            for item in editions}, len(bodies)


def retained_overlay(db, receipt, originals):
    if (receipt["session"] != SESSION or not receipt["calls"] or receipt["droppedCalls"]
            or receipt["studiesNotYetInCorpus"]):
        raise ValueError("Carry-forward requires a complete retained House listing with a study for each edition.")
    observed = instant(receipt["observedAt"])
    editions, originals_verified = original_editions(receipt, originals)
    calls = house_calls(db)
    listed = {(item["id"], item["language"]): item for item in receipt["calls"]}
    if len(listed) != len(receipt["calls"]) or calls.keys() != listed.keys() or calls.keys() != editions.keys():
        raise ValueError("The retained House calls, receipt and archived bilingual listings disagree.")
    if calls.keys() != {(call, language) for call, _ in calls for language in LANGUAGES}:
        raise ValueError("Every carried House call must have both language editions.")
    links = set()
    for key, row in calls.items():
        item, edition = listed[key], editions[key]
        metadata = json.loads(row["metadata_json"])
        study = edition["study"]
        committee, study_id = committee_id(study["committee"]), study["study_id"]
        url = study_url(study["committee"], study_id, row["language"])
        if (row["title"] != item["title"] or row["url"] != item["citation"] or row["url"] != url
                or row["committee_id"] != item["committeeId"] or row["committee_id"] != committee
                or item["studyId"] != study_id or metadata["studyId"] != study_id
                or metadata["revision"] != item["revision"] or metadata["deadline"] != item["deadline"]
                or metadata["instructionUrl"] != item["instructionUrl"] or metadata["listed"] is not True
                or metadata["contentWarning"] != item["hasContentWarning"]
                or (metadata["instructions"] is not None) != item["hasInstructions"]
                or instant(metadata["observedAt"]) != observed or instant(metadata["lastListedAt"]) != observed
                or instant(metadata["firstObservedAt"]) > observed):
            raise ValueError(f"The retained row differs from its daily receipt: {key}")
        links.add((key[1], committee, key[0], "publishes"))
        links.add((key[1], f"{committee}-study-{study_id}", key[0], "study-call"))
    if house_links(db) != links:
        raise ValueError("The retained House call links do not match the archived studies and committees.")
    return calls, links, originals_verified


def verify_parents(base, calls, links):
    for language, parent, child, relation in sorted(links):
        call = calls[child, language]
        kind = "study" if relation == "study-call" else "committee"
        row = base.execute("""SELECT kind,chamber,committee_id,url,status FROM cc_records
            WHERE session=? AND id=? AND language=?""", (SESSION, parent, language)).fetchone()
        if (not row or tuple(row)[:3] != (kind, "house", call["committee_id"])
                or row["status"] in {"removed", "superseded", "unavailable"}
                or (kind == "study" and row["url"] != call["url"])):
            raise ValueError(f"The later corpus lacks the exact {language} House {kind} parent: {parent}")


def apply_overlay(db, calls, links, observed):
    before = house_calls(db)
    if before.keys() - calls.keys():
        raise ValueError("The later corpus contains House call editions outside the retained receipt.")
    study_parents = {(child, language): parent for language, parent, child, relation in links if relation == "study-call"}
    for key, previous in before.items():
        metadata = json.loads(previous["metadata_json"])
        since = instant(metadata["observedAt"])
        # The full rebuild can mark the call as superseded by the same study when it replays the weekly catalogue.
        if previous["status"] == "superseded" and metadata.get("replacementIds") == [study_parents[key]]:
            del metadata["replacementIds"]
        matches = (metadata == json.loads(calls[key]["metadata_json"])
                   and all(previous[field] == calls[key][field] for field in ("url", "committee_id", "title")))
        if since > observed or (since == observed and not matches):
            raise ValueError(f"The later corpus contains a newer or conflicting House call edition: {key}")
    for key, row in calls.items():
        collision = db.execute("SELECT kind,chamber FROM cc_records WHERE session=? AND id=? AND language=?",
                               (SESSION, *key)).fetchone()
        if collision and tuple(collision) != ("call", "house"):
            raise ValueError(f"The later corpus has a non-House-call record at {key}.")
        if before.get(key) != row:
            write_record(db, row)
    old_links = house_links(db)
    added, removed = links - old_links, old_links - links
    for link in sorted(removed):
        db.execute("DELETE FROM cc_links WHERE session=? AND language=? AND parent_id=? AND child_id=? AND relation=?",
                   (SESSION, *link))
    for link in sorted(added):
        write_link(db, SESSION, *link)
    if house_calls(db) != calls or house_links(db) != links:
        raise ValueError("The materialized House overlay differs from the retained records or links.")
    return len(added), len(removed)


def carry_forward(retained, receipt_path, originals, base, output):
    if os.path.lexists(output):
        raise FileExistsError(f"Choose a new path for the shadow committee preview: {output}")
    raw = receipt_path.read_bytes()
    receipt = json.loads(raw)
    retained, base = retained.resolve(strict=True), base.resolve(strict=True)
    inputs = {path: closed_stamp(path) for path in (retained, base)}
    with closing(connect_closed(retained)) as frozen, closing(connect_closed(base)) as later:
        old_cutoff, new_cutoff = cutoff(frozen), cutoff(later)
        if instant(new_cutoff) <= instant(old_cutoff):
            raise ValueError("The shadow preview must have a later full-corpus cutoff.")
        calls, links, verified = retained_overlay(frozen, receipt, originals)
        verify_parents(later, calls, links)
        with tempfile.TemporaryDirectory(prefix="committee-overlay-", dir=output.parent) as temporary:
            candidate = Path(temporary) / "preview.sqlite"
            with closing(sqlite3.connect(candidate)) as db:
                db.row_factory = sqlite3.Row
                later.backup(db)
                db.execute("PRAGMA journal_mode=DELETE")
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    verify_parents(db, calls, links)
                    added, removed = apply_overlay(db, calls, links, instant(receipt["observedAt"]))
                    if cutoff(db) != new_cutoff or db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise ValueError("The shadow preview failed cutoff or SQLite verification.")
            if any(closed_stamp(path) != stamp for path, stamp in inputs.items()):
                raise ValueError("The committee SQLite input changed during carry-forward.")
            os.link(candidate, output)
    return {"session": SESSION, "retainedCutoff": old_cutoff, "cutoff": new_cutoff, "observedAt": receipt["observedAt"],
            "receiptSha256": sha256(raw).hexdigest(), "originalsVerified": verified, "calls": len(calls),
            "links": len(links), "linksAdded": added, "linksRemoved": removed, "output": str(output)}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retained", type=Path, required=True, help="Frozen acquisition SQLite with the daily call overlay.")
    parser.add_argument("--receipt", type=Path, required=True, help="Verified daily call receipt matching the frozen input.")
    parser.add_argument("--originals", type=Path, required=True, help="Frozen corpus directory containing objects/.")
    parser.add_argument("--base", type=Path, required=True, help="Closed private preview at the later weekly cutoff.")
    parser.add_argument("--output", type=Path, required=True, help="New shadow preview SQLite file to create.")
    args = parser.parse_args(argv)
    print(json.dumps(carry_forward(args.retained, args.receipt, args.originals, args.base, args.output)))
