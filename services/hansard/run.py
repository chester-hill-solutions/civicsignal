"""Run the existing chamber intake and serving checks in a private container."""
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, command, serve  # noqa: E402

GATEWAY = "http://archive.hansard.internal/"
WORKSPACE = Path("/hansard")
SESSION = "45-1"


def last_completed_week(milliseconds):
    toronto = dt.datetime.fromtimestamp(milliseconds / 1000, ZoneInfo("America/Toronto")).date()
    sunday = toronto - dt.timedelta(days=toronto.weekday() + 1)
    return sunday - dt.timedelta(days=6), sunday


def store_status(database):
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("The Hansard store failed SQLite verification.")
        journal = db.execute("SELECT journal_id FROM source_feed_identity").fetchone()
        feed = {lang: {"count": count, "highWater": high} for lang, count, high in db.execute(
            "SELECT language, count(*), max(seq) FROM source_feed_events GROUP BY language")}
        speeches = db.execute("SELECT count(*) FROM hansard_speeches").fetchone()[0]
    if not journal or set(feed) != {"en", "fr"} or not speeches:
        raise ValueError("Incomplete Hansard speech store or change journal.")
    return {"journal": journal[0], "feed": feed, "speeches": speeches}


def refresh(request):
    chamber = request["chamber"]
    prefix = f"weekly/hansard/{chamber}"
    storage = Archive(GATEWAY, WORKSPACE, prefix)
    storage.restore(request["inputState"])
    archive = WORKSPACE / "archive"
    database = archive / f"session-{SESSION}.sqlite"
    weekly = archive / "weekly"
    monday, sunday = last_completed_week(request["scheduledTime"])
    capture_out = json.loads(command("bun", "scripts/capture-hansard-week.ts", chamber, SESSION,
                                     str(monday), str(weekly / str(monday))))
    before = store_status(database)
    replay = "replay-week" if chamber == "house" else "replay-senate-week"
    observed = json.loads(command("bun", "scripts/hansard-local.ts", replay, str(database),
                                  str(weekly / str(monday) / "current/week.json")))
    reconciliation = json.loads(command("bun", "scripts/hansard-session-reconcile.ts", chamber, SESSION,
                                        str(database), str(weekly), str(sunday), str(archive / "reconciliation")))
    if not reconciliation["complete"] or not reconciliation["workerChecks"] or observed.get("complete") is False:
        raise ValueError("The restored Hansard session or its authenticated serving checks are incomplete.")
    after = store_status(database)
    if before["journal"] != after["journal"] or any(
            after["feed"][lang][field] < before["feed"][lang][field]
            for lang in ("en", "fr") for field in ("count", "highWater")):
        raise ValueError("The Hansard refresh regressed the change journal.")
    # The existing authenticated integration check pages the real change feed
    # and compares a bilingual search hit with its exact speech lookup.
    serving_file = WORKSPACE / "serving.json"
    command("bun", "run", "test", "test/endpoints.test.ts", "-t",
            f"reads the November 16 week from the acquired {chamber} Hansard",
            "--reporter=json", f"--outputFile={serving_file}",
            env={**os.environ, "CIVICSIGNAL_HANSARD_SQLITE": str(database)}, timeout=180)
    serving = json.loads(serving_file.read_bytes())
    if serving["numPassedTests"] != 1 or serving["numFailedTests"] != 0:
        raise ValueError("The authenticated Hansard search and change-feed check did not pass.")
    report = {
        "session": SESSION, "chamber": chamber, "weekOf": str(monday), "cutoff": str(sunday),
        "capturedEditions": capture_out["editions"], "replayCounts": observed["counts"],
        "counts": reconciliation["counts"], "workerChecks": reconciliation["workerChecks"],
        "verifiedByServingCheck": True, "before": before, "after": after,
    }
    return {"state": storage.snapshot(), "report": storage.document("reports", report)}


def identity(request):
    chamber = request["chamber"]
    if chamber not in ("house", "senate"):
        raise ValueError("invalid chamber")
    return f"hansard-{chamber}-{request['scheduledTime']}", f"weekly/hansard/{chamber}"


if __name__ == "__main__":
    serve(refresh, identity)
