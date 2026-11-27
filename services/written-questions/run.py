"""Refresh a private snapshot of the House written-question archive on Linux."""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import ROOT, Archive, command, serve  # noqa: E402

PREFIX = "weekly/written-questions"
WORKSPACE = Path("/written-questions")
CORPUS_PATH = Path("data/corpus/written-questions")
D1_PATH = Path("v3/d1/miniflare-D1DatabaseObject")
SERVING_NAME = "serving.sqlite"
GIB = 1024**3


def read_json(path):
    return json.loads(path.read_bytes())


def check_ledgers(serving):
    migrations = {
        "d1_migrations": ROOT / "migrations",
        "wq_preview_migrations": ROOT / "preview/written-questions/migrations",
    }
    with closing(sqlite3.connect(serving.resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as db:
        for table, directory in migrations.items():
            expected = {file.name for file in directory.glob("*.sql")}
            installed = {row[0] for row in db.execute(f"SELECT name FROM {table}")}
            if not expected or expected - installed:
                raise ValueError(f"Written-question SQLite needs the migration ledger {table}: {sorted(expected - installed)}")


def archive_coverage(path):
    receipt = read_json(path)
    totals = receipt["catalogue"]
    verified = receipt["objectVerification"]
    if (totals["complete"] is not True or not totals["officialReported"]
            or totals["enumeratedEn"] != totals["officialReported"]
            or totals["enumeratedFr"] != totals["officialReported"]
            or not verified["referenced"] or verified["invalid"]):
        raise ValueError("Written-question archive lacks verified bilingual coverage or source objects.")
    return receipt


def acceptance(serving, coverage, result_path):
    result_path.unlink(missing_ok=True)
    command("bun", "run", "test", "test/endpoints.test.ts", "-t",
            "reads the materialized House session through authenticated HTTP",
            "--reporter=json", f"--outputFile={result_path}",
            env={**os.environ, "CIVICSIGNAL_WRITTEN_QUESTIONS_D1": str(serving),
                 "CIVICSIGNAL_WRITTEN_QUESTIONS_COVERAGE": str(coverage)}, timeout=180)
    result = read_json(result_path)
    if result["numPassedTests"] != 1 or result["numFailedTests"] != 0:
        raise ValueError("The authenticated written-question serving check did not pass.")
    return 1


def refresh(request):
    storage = Archive("http://archive.written-questions.internal/", WORKSPACE, PREFIX)
    archive = WORKSPACE / "archive"
    corpus = archive / CORPUS_PATH
    coverage = corpus / "coverage.json"
    state = archive / "d1"
    serving = state / D1_PATH / SERVING_NAME
    report = {"scheduledTime": request["scheduledTime"]}
    phase = "restore"
    try:
        WORKSPACE.mkdir(exist_ok=True)
        if archive.exists():
            # A restarted container may retain its disposable copy. Restore from the pinned R2 archive.
            shutil.rmtree(archive)
        report["freeBeforeRestore"] = shutil.disk_usage(WORKSPACE).free
        if report["freeBeforeRestore"] < 15 * GIB:
            raise ValueError("Written-question restore requires at least 15 GiB of free workspace.")
        storage.restore(request["inputState"])
        check_ledgers(serving)
        previous = archive_coverage(coverage)
        phase = "catalogue"
        command("python3", "-B", str(ROOT / "scripts/lib/wq_catalog.py"), "--output",
                str(corpus / "catalogue.json"), "--recheck-details", cwd=archive, timeout=2700)
        catalogue = read_json(corpus / "catalogue.json")
        report["catalogue"] = {**catalogue["totals"], "observedAt": catalogue["observedAt"]}
        if report["catalogue"]["observedAt"] <= previous["sourceCutoff"]:
            raise ValueError("The written-question catalogue did not advance its source cutoff.")
        phase = "acquisition"
        command("python3", "-B", str(ROOT / "scripts/written-questions.py"), "--root", str(corpus),
                "--recheck", "--verify-objects", cwd=archive, timeout=7200)
        report["acquisition"] = acquired = archive_coverage(coverage)
        if (acquired["sourceCutoff"] != catalogue["observedAt"]
                or acquired["editionsChecked"] != 2 * acquired["catalogue"]["officialReported"]
                or acquired["journalEvents"] < previous["journalEvents"]):
            raise ValueError("The written-question acquisition did not fully check the current catalogue.")
        previous_gaps = {(gap["number"], gap["language"]) for gap in previous["gaps"]}
        new_gaps = [gap for gap in acquired["gaps"] if (gap["number"], gap["language"]) not in previous_gaps]
        if new_gaps:
            report["newGaps"] = new_gaps
            raise ValueError(f"The official sources introduced {len(new_gaps)} new written-question acquisition gaps.")
        phase = "materialization"
        report["freeBeforeMaterialization"] = shutil.disk_usage(archive).free
        if report["freeBeforeMaterialization"] < max(4 * GIB, 2 * serving.stat().st_size):
            raise ValueError("Written-question materialization lacks free space for SQLite transaction files.")
        report["materialization"] = materialized = json.loads(command(
            "bun", str(ROOT / "scripts/materialize-written-questions.ts"), str(corpus / "questions.sqlite"),
            str(state), cwd=archive, timeout=2700))
        if (materialized["materialized"] is not True or materialized["sourceEquivalent"] is not True
                or materialized["questions"] != 2 * acquired["catalogue"]["officialReported"]):
            raise ValueError("The written-question preview differs from the acquired archive.")
        phase = "serving"
        report["servingTestsPassed"] = acceptance(serving, coverage, WORKSPACE / "written-questions-vitest.json")
        phase = "archive"
        result = storage.snapshot()
        report["complete"] = True
    except Exception as error:
        reason = f"{phase}: {error}"[-2600:]
        report.update({"complete": False, "failedPhase": phase, "reason": reason})
        return {"status": "failed", "reason": reason, "report": storage.document("reports", report)}
    return {"state": result, "report": storage.document("reports", report)}


def identity(request):
    return f"written-questions-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    serve(refresh, identity)
