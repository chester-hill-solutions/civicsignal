"""Refresh current Gazette issues and annual coverage against one private snapshot."""
from contextlib import closing
import datetime as dt
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import ROOT, Archive, command, run, serve  # noqa: E402

PREFIX = "weekly/gazette"
WORKSPACE = Path("/gazette")
INTAKE = str(ROOT / "scripts/gazette-local.ts")
PART_THREE = str(ROOT / "scripts/gazette-part-three.py")
PART_THREE_MANIFEST = "part-three/latest.json"


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


def part_three_publication(manifest):
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("The Part III manifest is missing or is not a regular file.")
    verified = json.loads(command("python3", "-B", PART_THREE, "--verify-archive", str(manifest), timeout=60))
    return {"manifest": PART_THREE_MANIFEST, "manifestSha256": sha256(manifest.read_bytes()).hexdigest(), **verified}


def part_three(archive, cutoff):
    target = archive / PART_THREE_MANIFEST
    previous = None
    stage = "restore"
    try:
        if target.exists():
            previous = part_three_publication(target)
        stage = "acquire"
        with TemporaryDirectory(prefix="gazette-part-three-", dir=archive.parent) as scratch:
            staging = Path(scratch)
            candidate = staging / "candidate" / target.name
            command("python3", "-B", PART_THREE, "--output", str(candidate), timeout=210)
            stage = "verify"
            verified = part_three_publication(candidate)
            issue = verified["issue"]
            if issue["publicationDate"] > cutoff:
                raise ValueError(f"Part III issue publication {issue['publicationDate']} follows the cutoff {cutoff}.")
            if previous:
                prior = previous["issue"]
                if ((issue["volume"], issue["number"]) < (prior["volume"], prior["number"])
                        or issue["publicationDate"] < prior["publicationDate"]):
                    raise ValueError("The publisher returned an older Part III issue.")
                old_packet, new_packet = (json.loads(path.read_bytes()) for path in (target, candidate))
                old_packet.pop("observedAt")
                new_packet.pop("observedAt")
                if old_packet == new_packet:
                    return {"complete": True, "status": "unchanged", "publication": previous}
            stage = "archive"
            # Source files are content-addressed. Publish the manifest only after the
            # retained archive can replay it, leaving the previous manifest intact on failure.
            for source in (candidate.parent / "sources").rglob("*"):
                if not source.is_file():
                    continue
                destination = target.parent / source.relative_to(candidate.parent)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists():
                    source.rename(destination)
            pending = target.with_name(f".{verified['manifestSha256']}.json")
            candidate.replace(pending)
            try:
                if part_three_publication(pending) != verified:
                    raise ValueError("The promoted Part III archive differs from the verified candidate.")
                pending.replace(target)
            finally:
                pending.unlink(missing_ok=True)
            return {"complete": True, "status": "verified", "publication": verified}
    except Exception as error:
        return {"complete": False, "status": "degraded", "reason": f"{stage}: {error}"[-2200:],
                "lastVerified": previous}


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
    report["partThree"] = part_three(archive, cutoff)
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
