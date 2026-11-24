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
    build_call,
    call_id,
    committee_id,
    parse_participate,
    parse_session,
    parse_study,
    study_url,
)
from lib.committee_files import cache_db, capture, read_object
from lib.committee_store import initialize, update, write_link
from lib.wq_catalog import save_atomic

# The Senate publishes committee briefs but, at these pages, no listing of studies
# that are currently inviting them.
SENATE_CHECKS = {
    "en": [
        "https://sencanada.ca/en/committees/",
        "https://sencanada.ca/en/committees/aefa/",
        "https://sencanada.ca/en/committees/aefa/briefs/45-1",
        "https://sencanada.ca/en/committees/aefa/studiesandbills/45-1",
    ],
    "fr": [
        "https://sencanada.ca/fr/comites/",
        "https://sencanada.ca/fr/comites/aefa/",
        "https://sencanada.ca/fr/comites/aefa/memoires/45-1",
        "https://sencanada.ca/fr/comites/aefa/etudesetprojetsdeloi/45-1",
    ],
}
CALL_MARKERS = ("call for submissions", "call for briefs", "appel de mémoires")
# A Work page repeats a study's URL on a "Participate" button. Older catalogue
# builds used that label as the study title.
ACTION_LABELS = {"participate", "participez"}


def archived(root: Path, cache: sqlite3.Connection, url: str) -> tuple[str | None, dict]:
    """The archived copy of a URL and the cache's own record of the request."""
    row = cache.execute(
        "SELECT digest,error,media,size FROM files WHERE url=?", (url,)
    ).fetchone()
    if not row:
        return None, {"url": url, "state": "not-requested"}
    record = {"url": url, "media": row["media"], "bytes": row["size"], "error": row["error"]}
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


def existing_record(db: sqlite3.Connection, session: str, language: str, record_id: str):
    row = db.execute(
        "SELECT metadata_json FROM cc_records WHERE session=? AND id=? AND language=?",
        (session, record_id, language),
    ).fetchone()
    return {"metadata": json.loads(row["metadata_json"])} if row else None


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
        capture(root, [PARTICIPATE_INDEX["en"], PARTICIPATE_INDEX["fr"]], args.workers, not args.from_cache)
        listings = {}
        discovered = []
        for language in ("en", "fr"):
            body, source = archived(root, cache, PARTICIPATE_INDEX[language])
            if body is None:
                raise RuntimeError(f"the {language} consultation list was not captured")
            studies = parse_participate(body, language)
            if not studies:
                raise RuntimeError(f"no consultations were listed in the {language} edition")
            listings[language] = {"studies": studies, "source": source}
            discovered.extend(
                study_url(study["committee"], study["study_id"], language) for study in studies
            )
        capture(root, sorted(set(discovered)), args.workers, not args.from_cache)

        observed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        # Parse and verify every page before a single record is written.
        editions = []
        sessions = set()
        for language in ("en", "fr"):
            for study in listings[language]["studies"]:
                url = study_url(study["committee"], study["study_id"], language)
                body, source = archived(root, cache, url)
                if body is None:
                    raise RuntimeError(f"{url} was not captured")
                sessions.add(parse_session(body, language))
                editions.append({
                    "language": language,
                    "study": study,
                    "url": url,
                    "source": source,
                    "parsed": parse_study(body, language),
                })
        if sessions != {args.session}:
            raise RuntimeError(
                f"the listed studies belong to {sorted(sessions)}, not session {args.session}"
            )

        database = initialize(sqlite3.connect(args.db))
        database.row_factory = sqlite3.Row
        calls = []
        missing_studies = []
        repaired = []
        try:
            with database:
                for edition in editions:
                    study = edition["study"]
                    language = edition["language"]
                    record = build_call(
                        session=args.session,
                        language=language,
                        committee=study["committee"],
                        study_id=study["study_id"],
                        listed_title=study["title"],
                        observed_at=observed_at,
                        parsed=edition["parsed"],
                        existing=existing_record(
                            database,
                            args.session,
                            language,
                            call_id(study["committee"], study["study_id"]),
                        ),
                    )
                    update(database, record)
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
                        "sourceSha256": edition["source"]["sha256"],
                    })
        finally:
            database.close()

        senate = []
        for language, urls in SENATE_CHECKS.items():
            capture(root, urls, args.workers, not args.from_cache)
            for url in urls:
                body, source = archived(root, cache, url)
                if body is None:
                    senate.append({**source, "chamber": "senate", "language": language,
                                   "listing": "unreadable"})
                    continue
                text = body.casefold()
                senate.append({
                    **source,
                    "chamber": "senate",
                    "language": language,
                    "listing": "call-listing-present"
                    if any(marker in text for marker in CALL_MARKERS)
                    else "no-call-listing-in-archived-html",
                })

        receipt = {
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session": args.session,
            "observedAt": observed_at,
            "sources": [
                {
                    "chamber": "house",
                    "language": language,
                    "url": PARTICIPATE_INDEX[language],
                    "sha256": listings[language]["source"]["sha256"],
                    "studies": len(listings[language]["studies"]),
                }
                for language in ("en", "fr")
            ] + senate,
            "counts": {
                "calls": len(calls),
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
            "calls": calls,
        }
        save_atomic(args.receipt, receipt)
        print(json.dumps(receipt["counts"], ensure_ascii=False))
        print("receipt", args.receipt)
    finally:
        cache.close()


if __name__ == "__main__":
    main()
