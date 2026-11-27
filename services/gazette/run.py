"""Refresh current Gazette issues and annual coverage against one private snapshot."""
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import ROOT, Archive, command, run, serve  # noqa: E402

PREFIX = "weekly/gazette"
WORKSPACE = Path("/gazette")
INTAKE = str(ROOT / "scripts/gazette-local.ts")


def store_status(database):
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("The Gazette store failed SQLite verification.")
        regular = dict(db.execute("SELECT part, count(*) FROM gazette_editions GROUP BY part"))
        extras = dict(db.execute("SELECT part, count(*) FROM gazette_extra_editions GROUP BY part"))
        journal = db.execute("SELECT journal_id FROM source_feed_identity").fetchone()
        feed = {lang: {"count": count, "highWater": high} for lang, count, high in db.execute(
            "SELECT language, count(*), max(seq) FROM source_feed_events WHERE source='gazette' GROUP BY language")}
    if not journal or set(feed) != {"en", "fr"}:
        raise ValueError("The Gazette change journal is incomplete.")
    return {"journal": journal[0], "regularLanguageEditions": regular, "extraLanguageEditions": extras, "feed": feed}


def check_serving(database, receipt, name, expected, env_var, pattern):
    result_path = WORKSPACE / f"{name}-vitest.json"
    command("bun", "run", "test", "test/endpoints.test.ts", "-t", pattern,
            "--reporter=json", f"--outputFile={result_path}",
            env={**os.environ, "CIVICSIGNAL_GAZETTE_SQLITE": str(database), env_var: str(receipt)}, timeout=180)
    result = json.loads(result_path.read_bytes())
    if result["numPassedTests"] != expected or result["numFailedTests"] != 0:
        raise ValueError(f"The Gazette {name} serving verification did not pass every selected test.")
    return expected


def current(archive, database, cutoff):
    result = json.loads(command("bun", INTAKE, "sync-current", str(database), cutoff, cwd=archive))
    receipt = Path(result["receiptPath"])
    checked = check_serving(database, receipt, "current", 1, "CIVICSIGNAL_GAZETTE_RECEIPT",
                            "reads the current bilingual records through the acquired Gazette database")
    return {"complete": result["complete"], "servingTestsPassed": checked,
            "receipt": str(receipt.relative_to(archive)), "editions": result["editions"]}


def annual(archive, database, cutoff):
    completed = run("bun", INTAKE, "sync-year-catchup", str(database), cutoff[:4], cutoff, cwd=archive, accepted=(0, 1))
    if not completed.stdout.strip() and completed.returncode:
        raise ValueError(completed.stderr.strip()[-2200:])
    result = json.loads(completed.stdout)
    receipt = Path(result["receiptPath"])
    counts = result["counts"]
    checked = 0
    if result["complete"] or counts["archiveVerifiedPairs"] + counts["newlyVerifiedIssues"]:
        checked = check_serving(database, receipt, "annual", 2, "CIVICSIGNAL_GAZETTE_CATCHUP_RECEIPT",
                                "serves a cited record from each verified annual Gazette edition|"
                                "serves separately numbered bilingual extras through search and exact lookup")
    return {"complete": completed.returncode == 0 and result["complete"], "servingTestsPassed": checked,
            "receipt": str(receipt.relative_to(archive)), "counts": counts}


def refresh(request):
    storage = Archive("http://archive.gazette.internal/", WORKSPACE, PREFIX)
    storage.restore(request["inputState"])
    archive = WORKSPACE / "archive"
    database = archive / "gazette-preview.sqlite"
    cutoff = dt.datetime.fromtimestamp(request["scheduledTime"] / 1000, ZoneInfo("America/Toronto")).date().isoformat()
    before = store_status(database)
    report = {"cutoff": cutoff, "before": before}
    for phase in (current, annual):
        try:
            report[phase.__name__] = phase(archive, database, cutoff)
        except Exception as error:
            report[phase.__name__] = {"complete": False, "reason": str(error)[-2200:]}
    report["after"] = after = store_status(database)
    if before["journal"] != after["journal"] or any(
            after["feed"][lang][field] < before["feed"][lang][field]
            for lang in ("en", "fr") for field in ("count", "highWater")):
        raise ValueError("The Gazette refresh regressed the change journal.")
    reference = storage.document("reports", report)
    incomplete = [name for name in ("current", "annual") if not report[name]["complete"]]
    if incomplete:
        return {"status": "failed", "report": reference, "reason": "Incomplete Gazette phase: " + ", ".join(incomplete)}
    return {"state": storage.snapshot(), "report": reference}


def identity(request):
    return f"gazette-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    serve(refresh, identity)
