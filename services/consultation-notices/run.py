"""Archive source-cited notices against the pinned Cloudflare consultation catalogue."""
from collections import Counter
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import ROOT, Archive, command, digest, run, serve  # noqa: E402

PREFIX = "weekly/consultation-notices"
WORKSPACE = Path("/consultation-notices")
CATALOGUE_ARCHIVE = "http://inputs.consultation-notices.internal/"
NOTICE_PATH = Path("data/corpus/consultations")
SOURCE_LIMITS = {"csv": 16 * 1024**2, "schema": 512 * 1024}
PARTIAL_CODES = ("fetch-error", "http-error", "archive-budget")
GAP_FIELDS = ("consultationId", "language", "sourceUrl", "outcome", "httpStatus")


def notice_intake(archive):
    spec = importlib.util.spec_from_file_location("consultation_notices", ROOT / "scripts/consultation-notices.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The existing operator records paths relative to its corpus root; keep the
    # same layout in R2 and keep the executable repository outside the snapshot.
    module.ROOT = archive
    module.OBJECTS = archive / NOTICE_PATH / "notice-objects"
    return module


def read_pinned(key, ref, limit):
    expected_size, expected_hash = ref["bytes"], ref["sha256"]
    if type(expected_size) is not int or not 0 < expected_size <= limit or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        raise ValueError("Invalid pinned consultation object reference.")
    with urlopen(CATALOGUE_ARCHIVE + key, timeout=120) as response:
        if response.status != 200 or response.headers.get("Content-Length") != str(expected_size):
            raise ValueError("Stored consultation object has an unexpected size.")
        body = response.read(expected_size + 1)
    if len(body) != expected_size or digest(body) != expected_hash:
        raise ValueError("Stored consultation object failed SHA-256 verification.")
    return body


def materialize(catalogue):
    input_dir = WORKSPACE / "input"
    input_dir.mkdir(exist_ok=True)
    receipt_ref = catalogue["receipt"]
    key = receipt_ref["key"]
    if not re.fullmatch(r"consultations/runs/consultations-[1-9][0-9]{0,15}\.json", key):
        raise ValueError("Invalid pinned consultation receipt path.")
    receipt = json.loads(read_pinned(key, receipt_ref, 16 * 1024))
    expected = {"revision": catalogue["revision"], "observedAt": catalogue["observedAt"], "rows": catalogue["rows"]}
    if any(receipt["published"].get(field) != value for field, value in expected.items()) or receipt["sources"] != catalogue["sources"]:
        raise ValueError("Consultation receipt differs from the pinned catalogue.")
    originals = {}
    for kind, extension in (("csv", "csv"), ("schema", "json")):
        ref = catalogue["sources"][kind]
        key = f"consultations/sources/{ref['sha256']}.{extension}"
        if ref["archivedAs"] != key or ref["sha256"] != catalogue[f"{kind}Sha256"]:
            raise ValueError("Pinned catalogue source differs from the receipt.")
        path = input_dir / f"publisher.{extension}"
        path.write_bytes(read_pinned(key, ref, SOURCE_LIMITS[kind]))
        originals[kind] = path
    database = input_dir / "catalogue.sqlite"
    observed = json.loads(command("bun", str(ROOT / "scripts/materialize-consultations.ts"), "--csv", str(originals["csv"]),
                                  "--schema", str(originals["schema"]), "--db", str(database),
                                  "--observed-at", catalogue["observedAt"], "--receipt", str(input_dir / "materializer.json")))
    if (observed["revision"] != expected["revision"] or observed["observedAt"] != expected["observedAt"]
            or observed["csv"]["rows"] != expected["rows"] or observed["csv"]["sha256"] != catalogue["csvSha256"]
            or observed["schema"]["sha256"] != catalogue["schemaSha256"]):
        raise ValueError("Rematerialized SQLite does not reproduce the pinned hosted catalogue.")
    return database


def verified_archive(module, store):
    with closing(sqlite3.connect(store.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        if [row[0] for row in db.execute("PRAGMA quick_check")] != ["ok"]:
            raise ValueError("The consultation notice index failed SQLite integrity verification.")
        checked = set()
        for row in db.execute("SELECT * FROM notices WHERE status='fetched'"):
            sources = [source for source in module._previous_sources(row) if source.get("bodySha256")]
            if not sources:
                raise ValueError("A fetched consultation notice has no archived original.")
            for source in sources:
                identity = (source["sourceUrl"], source["bodySha256"], source["objectPath"], source["bodyBytes"])
                if identity not in checked:
                    if not module.verified_original(source):
                        raise ValueError(f"Consultation notice original failed verification: {source['bodySha256']}")
                    checked.add(identity)
    return len(checked)


def failures(store, revision, first_attempt):
    with closing(sqlite3.connect(store.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("""SELECT consultation_id AS consultationId, language,
            requested_url AS sourceUrl, outcome, http_status AS httpStatus, detail FROM notice_attempts
            WHERE catalogue_revision=? AND attempt_id>? AND outcome IN ('fetch-error','http-error','archive-budget')
            ORDER BY attempt_id""", (revision, first_attempt))]


def prior_publication(store, receipt_path):
    body = receipt_path.read_bytes()
    receipt = json.loads(body)
    if receipt["scope"] != "all-open":
        raise ValueError("Previous consultation notice receipt must cover all open consultations.")
    revision, observed = receipt["catalogueRevision"], receipt["catalogueObservedAt"]
    with closing(sqlite3.connect(store.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("""SELECT consultation_id, language, status FROM notices
            WHERE catalogue_revision=? AND catalogue_observed_at=?""", (revision, observed)).fetchall()
        covered = {(cid, language) for cid, language, status in rows if status == "fetched"}
        if len(rows) != receipt["editions"] or len(covered) != receipt["publishedFetchedEditions"]:
            raise ValueError("Previous consultation notice receipt differs from its published editions.")
        last_attempt = db.execute("SELECT coalesce(max(attempt_id), 0) FROM notice_attempts").fetchone()[0]
        # Limit prior gaps to the latest attempt for a URL that is still listed
        # as a source in that publication. Superseded links stay in the ledger.
        gaps = db.execute("""WITH latest AS (
              SELECT *, row_number() OVER (PARTITION BY consultation_id, language, requested_url
                  ORDER BY attempt_id DESC) AS rank FROM notice_attempts WHERE catalogue_revision=?
            ) SELECT DISTINCT a.consultation_id, a.language, a.requested_url, a.outcome, a.http_status
              FROM latest a JOIN notices n ON n.consultation_id=a.consultation_id AND n.language=a.language
              JOIN json_each(n.sources_json) source ON json_extract(source.value,'$.sourceUrl')=a.requested_url
              WHERE n.catalogue_revision=? AND n.catalogue_observed_at=? AND a.rank=1
                AND a.outcome IN ('fetch-error','http-error','archive-budget')
                AND json_extract(source.value,'$.lastAttemptAt')=a.attempted_at
                AND json_extract(source.value,'$.lastAttemptStatus')=a.outcome
              ORDER BY a.consultation_id,a.language,a.requested_url""", (revision, revision, observed)).fetchall()
    counts = Counter(gap[3] for gap in gaps)
    if any(counts[outcome] != receipt["counts"].get(outcome, 0) for outcome in PARTIAL_CODES):
        raise ValueError("Previous consultation notice gaps differ from their published receipt.")
    allowed = {gap for gap in gaps if gap[3] != "archive-budget"}
    evidence = {"receiptSha256": digest(body), "catalogueRevision": revision, "catalogueObservedAt": observed,
                "verifiedEditions": len(covered), "knownGaps": [dict(zip(GAP_FIELDS, gap)) for gap in gaps if gap in allowed]}
    return last_attempt, covered, allowed, evidence


def lost_editions(database, store, catalogue, previously_covered):
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        open_ids = {row[0] for row in db.execute("""SELECT id FROM consultations_records
            WHERE removed_at IS NULL AND observed_at=? AND state_at_observation='open'""", (catalogue["observedAt"],))}
    with closing(sqlite3.connect(store.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        current = set(db.execute("""SELECT consultation_id, language FROM notices
            WHERE catalogue_revision=? AND catalogue_observed_at=? AND status='fetched'""",
                                 (catalogue["revision"], catalogue["observedAt"])))
    return [{"consultationId": cid, "language": language}
            for cid, language in sorted(previously_covered - current) if cid in open_ids]


def check_serving(database, store):
    # The serving check resolves archived notice object paths relative to its
    # current directory. Keep it isolated from both the image and the seed.
    workspace = WORKSPACE / "verification"
    workspace.mkdir()
    for name, target in {"data": WORKSPACE / "archive/data", "migrations": ROOT / "migrations", "test": ROOT / "test"}.items():
        (workspace / name).symlink_to(target, target_is_directory=True)
    result_path = workspace / "serving-vitest.json"
    completed = run("node", str(ROOT / "node_modules/vitest/vitest.mjs"), "run", "test/endpoints.test.ts", "-t",
                    "serves archived English and French participation instructions with exact source citations",
                    "--config", str(ROOT / "vitest.config.ts"), "--reporter=json", f"--outputFile={result_path}",
                    cwd=workspace, timeout=180, accepted=(0, 1),
                    env={**os.environ, "CIVICSIGNAL_CONSULTATIONS_SQLITE": str(database),
                         "CIVICSIGNAL_CONSULTATION_NOTICES_SQLITE": str(store)})
    if not result_path.is_file():
        raise ValueError("The authenticated serving test produced no report. " + (completed.stderr or completed.stdout)[-1500:])
    result = json.loads(result_path.read_bytes())
    if completed.returncode or result["numPassedTests"] != 1 or result["numFailedTests"] != 0:
        messages = [message for suite in result["testResults"] for test in suite["assertionResults"]
                    if test["status"] == "failed" for message in test["failureMessages"]]
        raise ValueError("The consultation notices authenticated serving test did not pass. " + "\n".join(messages)[:1500])
    return 1


def refresh(request):
    storage = Archive("http://archive.consultation-notices.internal/", WORKSPACE, PREFIX)
    archive = WORKSPACE / "archive"
    catalogue = request["catalogue"]
    report = {"catalogue": catalogue, "complete": False, "servingTestsPassed": 0}
    try:
        storage.restore(request["inputState"])
        database = materialize(catalogue)
        module = notice_intake(archive)
        corpus = archive / NOTICE_PATH
        store = corpus / "notice-index.sqlite"
        receipts = corpus / "notice-receipts"
        last_attempt, covered, known_gaps, report["baseline"] = prior_publication(store, receipts / "latest.json")
        notices = module.refresh(database, store, receipt_root=receipts)
        report["notices"] = notices
        if (notices["catalogueRevision"] != catalogue["revision"] or notices["catalogueObservedAt"] != catalogue["observedAt"]
                or notices["scope"] != "all-open" or notices["editions"] != 2 * notices["openConsultations"]):
            raise ValueError("Notice acquisition differs from the pinned catalogue.")
        report["failures"] = failures(store, catalogue["revision"], last_attempt)
        if len(report["failures"]) != sum(notices["counts"].get(code, 0) for code in PARTIAL_CODES):
            raise ValueError("Consultation notice failure detail differs from the intake totals.")
        report["novelFailures"] = [failure for failure in report["failures"]
                                   if tuple(failure[field] for field in GAP_FIELDS) not in known_gaps]
        report["regressedEditions"] = lost_editions(database, store, catalogue, covered)
        report["publisherCoverage"] = "degraded" if report["failures"] or report["regressedEditions"] else "complete"
        report["verifiedOriginals"] = verified_archive(module, store)
        report["servingTestsPassed"] = check_serving(database, store)
        state = storage.snapshot()
    except Exception as error:
        reason = str(error)[-2400:]
        report["error"] = reason
        return {"status": "failed", "report": storage.document("reports", report), "reason": reason}
    if report["novelFailures"] or report["regressedEditions"]:
        report["candidateState"] = state
        return {"status": "failed", "report": storage.document("reports", report),
                "reason": "New consultation notice gaps or lost verified editions. The verified head was preserved."}
    report["complete"] = True
    return {"state": state, "report": storage.document("reports", report)}


def identity(request):
    return f"consultation-notices-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    serve(refresh, identity)
