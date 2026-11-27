"""Rebuild and verify a private committee preview from retained official originals."""
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import ROOT, Archive, command, serve  # noqa: E402
sys.path.insert(0, str(ROOT / "scripts"))
from lib.committee_files import read_object  # noqa: E402

PREFIX = "weekly/committee-replay"
GATEWAY = "http://archive.committee-replay.internal/"
WORKSPACE = Path("/committee-replay")
SOURCE_DIR = Path("archive/committees")
RESULT_DIR = Path("result/archive")
D1_PATH = Path("v3/d1/miniflare-D1DatabaseObject/serving.sqlite")
SESSION = "45-1"
GIB = 1024**3
MAX_INPUT_BYTES = 10 * GIB
MAX_INPUT_FILES = 80_000
MIGRATION = ROOT / "preview/committees/migrations/0001_committee_preview.sql"


def check_input(corpus):
    size = count = 0
    for path in corpus.rglob("*"):
        if path.is_symlink():
            raise ValueError("The committee replay archive must not contain symbolic links.")
        if path.is_file():
            size += path.stat().st_size
            count += 1
            if size > MAX_INPUT_BYTES or count > MAX_INPUT_FILES:
                raise ValueError("The committee replay archive exceeds its file or byte limit.")
    return {"files": count, "bytes": size}


def corpus_status(corpus):
    archive = json.loads((corpus / "catalogue.json").read_bytes())
    if archive.get("completed") is not True or archive["session"] != SESSION:
        raise ValueError("The committee replay requires a completed session 45-1 catalogue.")
    if not (corpus / "publication-parts.json").is_file():
        raise ValueError("The committee replay requires the retained publication parts.")
    source = (corpus / "committee.sqlite").resolve(strict=True)
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as db:
        snapshot = db.execute("SELECT cutoff FROM cc_snapshot WHERE session=?", (SESSION,)).fetchone()
        languages = dict(db.execute("SELECT language,count(*) FROM cc_records WHERE session=? GROUP BY language", (SESSION,)))
        tables = {table: db.execute(f"SELECT count(*) FROM {table} WHERE session=?", (SESSION,)).fetchone()[0]
                  for table in ("cc_links", "cc_passages", "cc_changes", "cc_link_changes")}
    if snapshot != (archive["observedAt"],) or set(languages) != {"en", "fr"} or not all(tables.values()):
        raise ValueError("The retained committee SQLite source and catalogue disagree or have incomplete coverage.")
    return {"session": SESSION, "cutoff": snapshot[0], "recordsByLanguage": languages, **tables}


def verify_originals(corpus):
    receipt = command("python3", "-B", str(ROOT / "scripts/committee-download.py"), "--root", str(corpus),
                      "--verify-only", timeout=3600).strip()
    label = "Verified original objects: "
    if not receipt.startswith(label) or not receipt[len(label):].isdigit() or int(receipt[len(label):]) <= 0:
        raise ValueError("The original committee archive did not return a positive verification count.")
    return int(receipt[len(label):])


def pin_publication_parts(corpus, cutoff):
    parts = json.loads((corpus / "publication-parts.json").read_bytes())
    if parts["session"] != SESSION or parts["cutoff"] != cutoff or not parts["sourceDigests"]:
        raise ValueError("The retained publication-parts edition does not match the committee catalogue.")
    restored = []
    with closing(sqlite3.connect(corpus / "downloads.sqlite")) as db, db:
        for url, archived in sorted(parts["sourceDigests"].items()):
            row = db.execute("SELECT digest,media FROM files WHERE url=?", (url,)).fetchone()
            if not row or not re.fullmatch("[0-9a-f]{64}", archived):
                raise ValueError(f"The historical committee page is absent from the download index: {url}")
            current, media = row
            if current == archived:
                continue
            if not media or "html" not in media:
                raise ValueError(f"The archived committee page has no HTML download index entry: {url}")
            # The saved publication parts pin the exact older original. Do not attach the newer fetch metadata to it.
            body = read_object(corpus, archived)
            db.execute("UPDATE files SET digest=?,size=?,error=NULL,checked=NULL,final_url=NULL WHERE url=?",
                       (archived, len(body), url))
            restored.append({"url": url, "archivedSha256": archived, "downloadIndexSha256": current})
    return {"pages": len(parts["sourceDigests"]), "restored": restored}


def new_local_candidate(path):
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as db:
        db.executescript(MIGRATION.read_text())
        with db:
            db.execute("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)")
            db.execute("INSERT INTO d1_migrations(name) VALUES(?)", (MIGRATION.name,))


def acceptance(serving, source, receipt):
    receipt.unlink(missing_ok=True)
    command("bun", "run", "test", "test/endpoints.test.ts", "-t",
            "traverses real bilingual committee publications with a workspace key",
            "--reporter=json", f"--outputFile={receipt}",
            env={**os.environ, "CIVICSIGNAL_COMMITTEES_D1": str(serving),
                 "CIVICSIGNAL_COMMITTEES_SOURCE_SQLITE": str(source)}, timeout=180)
    result = json.loads(receipt.read_bytes())
    if result["numPassedTests"] != 1 or result["numFailedTests"] != 0:
        raise ValueError("The authenticated bilingual committee API check did not pass.")
    return 1


def replay(corpus, output, report):
    report["phase"] = "verify-originals"
    report["input"] = check_input(corpus)
    report["baseline"] = baseline = corpus_status(corpus)
    report["originalsVerified"] = verify_originals(corpus)
    report["phase"] = "pin-publication-parts"
    report["publicationParts"] = pin_publication_parts(corpus, baseline["cutoff"])
    report["phase"] = "rebuild"
    command("python3", "-B", str(ROOT / "scripts/committee-corpus.py"), "--root", str(corpus), "--workers", "2", timeout=7200)
    report["rebuild"] = rebuilt = corpus_status(corpus)
    if (baseline["cutoff"] != rebuilt["cutoff"]
            or any(rebuilt[table] < baseline[table] for table in ("cc_changes", "cc_link_changes"))):
        raise ValueError("The archive replay regressed the committee cutoff or change journal.")
    report["phase"] = "materialize"
    report["freeBeforeMaterialization"] = shutil.disk_usage(corpus).free
    source = corpus / "committee.sqlite"
    if report["freeBeforeMaterialization"] < max(5 * GIB, 2 * source.stat().st_size):
        raise ValueError("The committee replay lacks space for a new preview and SQLite scratch files.")
    state = output / "d1"
    serving = state / D1_PATH
    new_local_candidate(serving)
    report["materialization"] = materialized = json.loads(command(
        "python3", "-B", str(ROOT / "scripts/materialize-committee-corpus.py"),
        "--source", str(source), "--persist-to", str(state), "--timeout-seconds", "30", timeout=7200))
    if (materialized["materialized"] is not True or materialized["sourceEquivalent"] is not True
            or materialized["cutoff"] != rebuilt["cutoff"]):
        raise ValueError("The committee preview is not equivalent to the rebuilt archive.")
    report["phase"] = "authenticate"
    report["servingTestsPassed"] = acceptance(serving, source, output.parent / "committees-vitest.json")
    report["servingBytes"] = serving.stat().st_size


def refresh(request):
    storage = Archive(GATEWAY, WORKSPACE, PREFIX)
    report = {"scheduledTime": request["scheduledTime"], "scope": "offline-replay", "phase": "restore"}
    try:
        WORKSPACE.mkdir(exist_ok=True)
        for path in (WORKSPACE / "archive", WORKSPACE / "result"):
            if path.exists():
                shutil.rmtree(path)
        report["freeBeforeRestore"] = shutil.disk_usage(WORKSPACE).free
        if report["freeBeforeRestore"] < 15 * GIB:
            raise ValueError("The committee replay requires at least 15 GiB free before restore.")
        storage.restore(request["inputState"])
        replay(WORKSPACE / SOURCE_DIR, WORKSPACE / RESULT_DIR, report)
        report["phase"] = "archive-preview"
        report["servingState"] = Archive(GATEWAY, WORKSPACE / "result", PREFIX).snapshot()
        report.update(complete=True, phase="complete")
    except Exception as error:
        reason = f"{report['phase']}: {error}"[-2600:]
        report.update(complete=False, reason=reason)
        return {"status": "failed", "reason": reason, "report": storage.document("reports", report)}
    # Each replay starts from the same immutable acquisition archive. The report pins the distinct verified preview.
    return {"state": request["inputState"], "report": storage.document("reports", report)}


def identity(request):
    return f"committee-replay-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    if sys.argv[1:2] == ["carry-forward"]:
        from carry_forward import main

        main(sys.argv[2:])
    else:
        serve(refresh, identity)
