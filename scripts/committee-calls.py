"""Acquire the House committee calls for briefs and record the Senate gap.

The House publishes one page of studies that are currently seeking input and, on
each study page, a participation button with an optional deadline and a block of
submission instructions. This intake archives both editions, writes one `call`
record per study edition to the local committee store, links it to its committee
and study, and writes a receipt. It does not change the corpus cutoff.

The Senate publishes no equivalent structured listing at the pages checked. Each
checked page is archived and its state recorded, so the gap is measured rather
than assumed.
"""

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from lib.committee_calls import (
    PARTICIPATE_INDEX,
    SENATE_CHECKS,
    build_call,
    call_id,
    call_observation_time,
    classify_senate_probe,
    committee_id,
    mark_unlisted,
    parse_call_editions,
    parse_call_indexes,
    study_url,
)
from lib.committee_files import cache_db, capture, read_object
from lib.committee_store import initialize, update, write_link
from lib.wq_catalog import save_atomic

# A Work page repeats a study's URL on a "Participate" button. Older catalogue
# builds used that label as the study title.
ACTION_LABELS = {"participate", "participez"}


def archived(root: Path, cache: sqlite3.Connection, url: str) -> tuple[str | None, dict]:
    """The archived copy of a URL and the cache's own record of the request."""
    row = cache.execute(
        "SELECT digest,error,media,size,checked FROM files WHERE url=?", (url,)
    ).fetchone()
    if not row:
        return None, {"url": url, "state": "not-requested"}
    record = {"url": url, "media": row["media"], "bytes": row["size"], "error": row["error"], "checked": row["checked"]}
    if not row["digest"]:
        return None, {**record, "state": "unavailable"}
    body = read_object(root, row["digest"]).decode("utf-8", "replace")
    return body, {**record, "sha256": row["digest"], "state": "archived"}


def repair_study_title(database: sqlite3.Connection, session: str, language: str,
                       study_record: str, title: str) -> bool:
    """Replace an action label that an earlier catalogue build stored as a study title."""
    row = database.execute(
        "SELECT * FROM cc_records WHERE session=? AND id=? AND language=? AND kind='study'",
        (session, study_record, language),
    ).fetchone()
    if not row or (row["title"] or "").strip().casefold() not in ACTION_LABELS:
        return False
    update(database, {
        "session": row["session"], "id": row["id"], "language": row["language"],
        "kind": row["kind"], "chamber": row["chamber"], "committee_id": row["committee_id"],
        "title": title, "url": row["url"], "status": row["status"],
        "metadata": json.loads(row["metadata_json"]),
    })
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/corpus/committees"))
    parser.add_argument("--db", type=Path, default=Path("data/corpus/committees/committee.sqlite"))
    parser.add_argument("--session", default="45-1")
    parser.add_argument("--receipt", type=Path, default=Path("dist/committee-calls/receipt.json"))
    parser.add_argument(
        "--from-cache",
        action="store_true",
        help="Reuse archived pages instead of fetching a fresh observation. Off by default: a "
             "cached copy from an earlier corpus build is not today's published call.",
    )
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=2)
    args = parser.parse_args()

    root = args.root.resolve()
    cache = cache_db(root)
    try:
        capture(root, list(PARTICIPATE_INDEX.values()), args.workers, not args.from_cache)
        index_pages = {url: archived(root, cache, url) for url in PARTICIPATE_INDEX.values()}
        listings = parse_call_indexes({url: body for url, (body, _) in index_pages.items()})
        discovered = {
            study_url(study["committee"], study["study_id"], language)
            for language, studies in listings.items() for study in studies
        }
        capture(root, sorted(discovered), args.workers, not args.from_cache)

        study_pages = {url: archived(root, cache, url) for url in discovered}
        editions = parse_call_editions(
            args.session, listings, {url: body for url, (body, _) in study_pages.items()}
        )

        database = initialize(sqlite3.connect(args.db))
        database.row_factory = sqlite3.Row
        calls = []
        missing_studies = []
        repaired = []
        dropped = []
        conflicting = []
        stats = {"added": 0, "changed": 0, "unchanged": 0, "pending": 0}
        try:
            with database:
                database.execute("BEGIN IMMEDIATE")
                prior = {
                    (row["id"], row["language"]): {"metadata": json.loads(row["metadata_json"]), "title": row["title"]}
                    for row in database.execute(
                        "SELECT id,language,metadata_json,title FROM cc_records WHERE session=? AND kind='call'",
                        (args.session,),
                    )
                }
                latest = max((r["metadata"]["observedAt"] for r in prior.values() if r["metadata"].get("observedAt")),
                             key=datetime.fromisoformat, default=None)
                observed_at = call_observation_time(
                    (source for pages in (index_pages, study_pages) for _, source in pages.values()), latest
                )
                present = {
                    (call_id(edition["study"]["committee"], edition["study"]["study_id"]), edition["language"])
                    for edition in editions
                }
                if latest == observed_at:
                    stored = {key for key, row in prior.items() if row["metadata"].get("listed") is not False}
                    if stored != present or any(prior[key]["metadata"].get("observedAt") != latest for key in present):
                        raise ValueError("cached listing differs from the stored observation")
                for edition in editions:
                    study = edition["study"]
                    language = edition["language"]
                    shares_with = edition["shares_with"]
                    record = build_call(
                        session=args.session,
                        language=language,
                        committee=study["committee"],
                        study_id=study["study_id"],
                        listed_title=study["title"],
                        observed_at=observed_at,
                        parsed=edition["parsed"],
                        existing=prior.get((call_id(study["committee"], study["study_id"]), language)),
                        conflict=bool(shares_with),
                    )
                    if shares_with:
                        conflicting.append({"id": record["id"], "language": language,
                                            "sharesWith": shares_with})
                    update(database, record)
                    key = (record["id"], language)
                    before = prior[key]["metadata"] if key in prior else None
                    if before is None:
                        stats["added"] += 1
                    elif record["metadata"]["revision"] > int(before.get("revision") or 0):
                        stats["changed"] += 1
                    else:
                        stats["unchanged"] += 1
                    if record["metadata"].get("pendingDigest"):
                        stats["pending"] += 1
                    write_link(
                        database,
                        args.session,
                        language,
                        committee_id(study["committee"]),
                        record["id"],
                        "publishes",
                    )
                    study_record = f"{committee_id(study['committee'])}-study-{study['study_id']}"
                    if database.execute(
                        "SELECT 1 FROM cc_records WHERE session=? AND id=? AND language=? AND kind='study'",
                        (args.session, study_record, language),
                    ).fetchone():
                        write_link(
                            database, args.session, language, study_record, record["id"], "study-call"
                        )
                        if repair_study_title(database, args.session, language, study_record, study["title"]):
                            repaired.append({"id": study_record, "language": language, "title": study["title"]})
                    else:
                        missing_studies.append({"id": study_record, "language": language})
                    calls.append({
                        "id": record["id"],
                        "language": language,
                        "committeeId": record["committee_id"],
                        "studyId": study["study_id"],
                        "title": record["title"],
                        "citation": record["url"],
                        "instructionUrl": record["metadata"]["instructionUrl"],
                        "deadline": record["metadata"]["deadline"],
                        "hasInstructions": record["metadata"]["instructions"] is not None,
                        "hasContentWarning": record["metadata"]["contentWarning"],
                        "revision": record["metadata"]["revision"],
                        "sourceSha256": study_pages[edition["url"]][1]["sha256"],
                    })
                # A study that left the current list is no longer soliciting briefs.
                dropped = mark_unlisted(database, args.session, present)
        finally:
            database.close()

        senate = []
        for language, urls in SENATE_CHECKS.items():
            capture(root, urls, args.workers, not args.from_cache)
            for url in urls:
                body, source = archived(root, cache, url)
                source.pop("checked", None)
                senate.append({**source, "chamber": "senate", "language": language,
                               "listing": classify_senate_probe(body)})

        receipt = {
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session": args.session,
            "observedAt": observed_at,
            "sources": [
                {
                    "chamber": "house",
                    "language": language,
                    "url": PARTICIPATE_INDEX[language],
                    "sha256": index_pages[PARTICIPATE_INDEX[language]][1]["sha256"],
                    "studies": len(listings[language]),
                }
                for language in ("en", "fr")
            ] + senate,
            "counts": {
                "calls": len(calls),
                "added": stats["added"],
                "changed": stats["changed"],
                "unchanged": stats["unchanged"],
                "dropped": len(dropped),
                "pending": stats["pending"],
                "conflicts": len(conflicting),
                "committees": len({call["committeeId"] for call in calls}),
                "deadlines": sum(1 for call in calls if call["deadline"]),
                "deadlineInstants": sum(
                    1 for call in calls if call["deadline"] and call["deadline"]["instant"]
                ),
                "instructionBlocks": sum(1 for call in calls if call["hasInstructions"]),
                "contentWarnings": sum(1 for call in calls if call["hasContentWarning"]),
            },
            "studiesNotYetInCorpus": missing_studies,
            "studyTitlesRepaired": repaired,
            "droppedCalls": dropped,
            "conflictingCalls": conflicting,
            "calls": calls,
        }
        save_atomic(args.receipt, receipt)
        print(json.dumps(receipt["counts"], ensure_ascii=False))
        print("receipt", args.receipt)
    finally:
        cache.close()


if __name__ == "__main__":
    main()
