#!/usr/bin/env python3
"""Run the heavier local CivicSignal refreshes with per-source reports.

Run from the repository root:
    python3 -B scripts/refresh-weekly.py [--only NAME]

The operators remain independently resumable. A failed command stops its own
source step while later steps continue. No hosted publication is performed.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import fcntl
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Iterator


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "dist/refresh-weekly"
RUN_LOCK = REPORTS / "run.lock"
COMMITTEE_LOCK = ROOT / "dist/refresh/committee-publication.lock"

# These are observed local working-set sizes plus room for an incoming
# generation and SQLite journals. Requiring headroom avoids beginning a
# multi-gigabyte refresh that cannot safely finish.
GEDS_MIN_FREE_BYTES = 32 * 1024**2
COMMITTEE_MIN_FREE_BYTES = 3 * 1024**3
WRITTEN_QUESTIONS_MIN_FREE_BYTES = 512 * 1024**2
ECCC_MIN_FREE_BYTES = 128 * 1024**2


@dataclass(frozen=True)
class Step:
    name: str
    commands: tuple[tuple[str, ...] | "Command", ...]
    timeout_seconds: int
    description: str
    min_free_bytes: int = 0
    baseline_paths: tuple[str, ...] = ()
    shared_committee_lock: bool = False
    artifacts: tuple[str, ...] = ()
    verify_partial: bool = False


@dataclass(frozen=True)
class Command:
    argv: tuple[str, ...]
    env: tuple[tuple[str, str], ...] = ()
    verification: bool = False
    expected_passed_tests: int = 1


def _committee_commands(resume_catalogue: bool = False) -> tuple[tuple[str, ...] | Command, ...]:
    py = "python3"
    catalogue = (py, "-B", "scripts/committee-catalogue.py", "--refresh-senate-notices")
    if resume_catalogue:
        catalogue += ("--resume",)
    return (
        catalogue,
        (py, "-B", "scripts/committee-download.py", "--refresh", "--reuse-indexed-notice-originals"),
        (py, "-B", "scripts/committee-expand.py", "--refresh-linked-originals"),
        (py, "-B", "scripts/committee-corpus.py"),
        (py, "-B", "scripts/committee-download.py", "--verify-only"),
        (py, "-B", "scripts/materialize-committee-corpus.py", "--clone-local"),
        Command(("bun", "run", "test", "test/endpoints.test.ts", "-t", "traverses real bilingual committee publications with a workspace key"),
                (("CIVICSIGNAL_COMMITTEES_D1", "@d1:.wrangler/committees-45-1"),
                 ("CIVICSIGNAL_COMMITTEES_SOURCE_SQLITE", "data/corpus/committees/committee.sqlite")), verification=True),
    )


STEPS = (
    Step(
        "geds",
        (
            ("bun", "scripts/geds-import.ts", "--download", "--min-new-snapshot-bytes", str(2 * 1024**3), "--db", "dist/geds/geds.sqlite", "--archive", "dist/geds/archive"),
            Command(("bun", "run", "test", "test/endpoints.test.ts", "-t", "resolves one real unit from both published names and cites the imported contact"),
                    (("CIVICSIGNAL_GEDS_SQLITE", "dist/geds/geds.sqlite"),), verification=True),
        ),
        60 * 60,
        "Download, archive and import the current GEDS export.",
        GEDS_MIN_FREE_BYTES,
        baseline_paths=("dist/geds",),
        artifacts=("dist/geds/receipt.json", "dist/geds/geds.sqlite"),
    ),
    Step(
        "eccc",
        (("python3", "-B", "scripts/eccc-intake.py", "--workers", "1"),
         ("python3", "-B", "scripts/eccc-passages.py"),
         Command(("bun", "run", "test", "test/endpoints.test.ts", "-t", "departmental publications through the Worker"),
                 (("CIVICSIGNAL_ECCC_SQLITE", "data/corpus/eccc/serving.sqlite"),), verification=True, expected_passed_tests=2)),
        60 * 60,
        "Refresh ECCC publication indexes and archived originals.",
        ECCC_MIN_FREE_BYTES,
        baseline_paths=("data/corpus/eccc",),
        artifacts=("dist/eccc/inventory.json", "data/corpus/eccc/catalogue.sqlite", "data/corpus/eccc/serving.sqlite"),
    ),
    Step(
        "written-questions",
        (
            ("python3", "-B", "scripts/lib/wq_catalog.py", "--recheck-details"),
            ("python3", "-B", "scripts/written-questions.py", "--recheck", "--verify-objects"),
            ("python3", "-B", "scripts/compact-written-question-objects.py", "--if-supported"),
            ("bun", "scripts/materialize-written-questions.ts", "data/corpus/written-questions/questions.sqlite", ".wrangler/written-questions-final"),
            Command(("bun", "run", "test", "test/endpoints.test.ts", "-t", "reads the materialized House session through authenticated HTTP"),
                    (("CIVICSIGNAL_WRITTEN_QUESTIONS_D1", "@d1:.wrangler/written-questions-final"),), verification=True),
        ),
        3 * 60 * 60,
        "Refresh both 45-1 question listings and recheck existing answer editions and stored objects.",
        WRITTEN_QUESTIONS_MIN_FREE_BYTES,
        baseline_paths=("data/corpus/written-questions",),
        artifacts=("data/corpus/written-questions/catalogue.json", "data/corpus/written-questions/coverage.json"),
    ),
    Step(
        "committees",
        _committee_commands(),
        8 * 60 * 60,
        "Rewalk the full current-session committee corpus and publish a verified local D1 generation.",
        COMMITTEE_MIN_FREE_BYTES,
        baseline_paths=("data/corpus/committees", ".wrangler/committees-45-1"),
        shared_committee_lock=True,
        artifacts=("data/corpus/committees/coverage.json", "data/corpus/committees/committee.sqlite", ".wrangler/committees-45-1"),
    ),
    Step(
        "consultation-notices",
        (("python3", "-B", "scripts/consultation-notices.py", "refresh"),
         Command(("bun", "run", "test", "test/endpoints.test.ts", "-t", "serves archived English and French participation instructions with exact source citations"),
                 (("CIVICSIGNAL_CONSULTATIONS_SQLITE", "data/corpus/consultations/catalogue.sqlite"),
                  ("CIVICSIGNAL_CONSULTATION_NOTICES_SQLITE", "data/corpus/consultations/notice-index.sqlite")), verification=True)),
        2 * 60 * 60,
        "Archive labelled participation sections from current open consultation notices.",
        0,
        baseline_paths=("data/corpus/consultations/notice-index.sqlite", "data/corpus/consultations/notice-objects"),
        artifacts=("data/corpus/consultations/notice-receipts/latest.json", "data/corpus/consultations/notice-index.sqlite"),
        verify_partial=True,
    ),
    Step("federal-report-directories", (("python3", "-B", "scripts/federal-report-directories.py"),), 1800,
         "Refresh institution-linked departmental plan, results, and regulatory directories.",
         artifacts=("data/corpus/federal-report-directories/dist/receipt.json",)),
    Step("departmental-report-editions", (("python3", "-B", "scripts/departmental-report-editions.py", "refresh"),
         ("python3", "-B", "scripts/departmental-report-editions.py", "replay", "@receipt-run-id@")), 3600,
         "Archive the issuer landing pages and identify the published departmental plan and results editions by fiscal year.",
         artifacts=("data/corpus/departmental-report-editions/generations/",), verify_partial=True),
    Step("departmental-report-documents", (("python3", "-B", "scripts/departmental-report-documents.py", "refresh"),
         ("python3", "-B", "scripts/departmental-report-documents.py", "replay", "@receipt-run-id@")), 3600,
         "Archive explicitly linked departmental reports and verify the edition against the document text.",
         artifacts=("data/corpus/departmental-report-documents/latest-attempt.json",), verify_partial=True),
    Step("federal-regulatory-plans", (("python3", "-B", "scripts/federal-regulatory-plans.py", "refresh"),
         ("python3", "-B", "scripts/federal-regulatory-plans.py", "replay", "@receipt-run-id@")), 3600,
         "Verify institutional forward regulatory plan pages and retain publisher-labelled initiatives.",
         artifacts=("data/corpus/federal-regulatory-plans/dist/receipt.json",), verify_partial=True),
    Step("statutes-local", (("bun", "scripts/ingest-statutes.ts", "--corpus", "data/corpus/justice-laws-xml",
          "--out", "dist/statutes-local", "--publish-current"),), 3600,
         "Build and check a bilingual local statutes export from the official Justice Canada checkout.",
         min_free_bytes=2 * 1024**3, artifacts=("dist/statutes-local/current/receipt.json",)),
)

RUN_ORDER = (
    "consultation-notices", "eccc",
    "federal-report-directories", "departmental-report-editions",
    "departmental-report-documents", "federal-regulatory-plans",
    "geds", "statutes-local", "written-questions", "committees",
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="Read the latest dated result per configured step without running a refresh.")
    parser.add_argument("--only", action="append", default=[], metavar="NAME", help=f"run one named step; choices: {', '.join(step.name for step in STEPS)}")
    parser.add_argument("--resume-committee-catalogue", action="store_true",
                        help="Continue an interrupted committee-only catalogue acquisition from its partial checkpoint.")
    args = parser.parse_args(argv)
    if args.status and (args.only or args.resume_committee_catalogue):
        parser.error("--status cannot be combined with refresh options")
    if args.resume_committee_catalogue and args.only != ["committees"]:
        parser.error("--resume-committee-catalogue requires --only committees")
    unknown = sorted(set(args.only) - {step.name for step in STEPS})
    if unknown:
        parser.error(f"unknown step(s): {', '.join(unknown)}")
    return args


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"another refresh holds {path.relative_to(ROOT)}") from error
        yield
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _free_bytes() -> int:
    return shutil.disk_usage(ROOT).free


def _path_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for current, _directories, filenames in os.walk(path):
        for filename in filenames:
            candidate = Path(current) / filename
            try:
                if not candidate.is_symlink():
                    total += candidate.stat().st_size
            except FileNotFoundError:
                continue
    return total


def _local_d1_path(state_directory: str) -> str:
    database_directory = ROOT / state_directory / "v3/d1/miniflare-D1DatabaseObject"
    files = sorted(path for path in database_directory.glob("*.sqlite")
                   if path.name != "metadata.sqlite" and path.is_file())
    if len(files) != 1:
        raise RuntimeError(f"expected one local D1 database under {database_directory}; found {len(files)}")
    return str(files[0].relative_to(ROOT))


def _tail(value: str, limit: int = 5000) -> str:
    return value if len(value) <= limit else "…" + value[-limit:]


def _verify_vitest_result(outcome: dict, stdout: str, expected: int, pattern: str | None = None) -> None:
    outcome["expectedPassedTests"] = expected
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError:
        outcome.update(ok=False, error="Vitest JSON report is missing or malformed")
        return
    if (not isinstance(report, dict) or type(report.get("success")) is not bool
            or type(report.get("numPassedTests")) is not int or type(report.get("numFailedTests")) is not int):
        outcome.update(ok=False, error="Vitest JSON report is missing valid success and test counts")
        return
    suites = report.get("testResults")
    if not isinstance(suites, list) or not all(isinstance(s, dict) and isinstance(s.get("assertionResults"), list) for s in suites):
        outcome.update(ok=False, error="Vitest report is missing its assertion results", stdout="Invalid Vitest suite results.")
        return
    selected = []
    for suite in suites:
        for assertion in suite["assertionResults"]:
            if not isinstance(assertion, dict) or not isinstance(assertion.get("fullName"), str):
                outcome.update(ok=False, error="Vitest assertion is missing its full name", stdout="Invalid Vitest assertion.")
                return
            if pattern is None or re.search(pattern, assertion["fullName"]):
                selected.append(assertion)
    passed, failed = report["numPassedTests"], report["numFailedTests"]
    outcome.update(passedTests=passed, stdout=f"Vitest reported {passed} passed and {failed} failed.")
    if (report["success"] and passed == expected and failed == 0 and len(selected) == expected
            and all(assertion.get("status") == "passed" for assertion in selected)):
        return
    outcome.update(ok=False, error=f"verification expected exactly {expected} passed tests, observed "
                   f"{passed} passed and {failed} failed ({len(selected)} selected)")
    failures = [suite.get("message", "") for suite in suites if suite.get("status") == "failed"]
    if failures:
        outcome["stdout"] = _tail(outcome["stdout"] + "\n" + "\n".join(failures))


def _run_command(command: tuple[str, ...] | Command, timeout_seconds: int) -> dict:
    started = time.monotonic()
    argv = command.argv if isinstance(command, Command) else command
    requested_env = dict(command.env) if isinstance(command, Command) else {}
    command_env: dict[str, str] = {}
    verification = command.verification if isinstance(command, Command) else False
    expected_passed_tests = command.expected_passed_tests if isinstance(command, Command) else 1
    for key, value in requested_env.items():
        if value.startswith("@d1:"):
            value = _local_d1_path(value.removeprefix("@d1:"))
        command_env[key] = value
    resolved_argv = argv
    if verification and "--reporter=json" not in resolved_argv:
        resolved_argv += ("--reporter=json",)
    environment = os.environ.copy()
    environment.update(command_env)
    try:
        result = subprocess.run(
            resolved_argv,
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        outcome = {
            "command": list(resolved_argv),
            "verification": verification,
            "ok": result.returncode == 0,
            "exitCode": result.returncode,
            "durationMs": round((time.monotonic() - started) * 1000),
            "stdout": _tail(result.stdout),
            "stderr": _tail(result.stderr),
        }
        if verification:
            pattern = resolved_argv[resolved_argv.index("-t") + 1] if "-t" in resolved_argv else None
            _verify_vitest_result(outcome, result.stdout, expected_passed_tests, pattern)
        return outcome
    except subprocess.TimeoutExpired as error:
        return {
            "command": list(resolved_argv),
            "verification": verification,
            "ok": False,
            "exitCode": None,
            "durationMs": round((time.monotonic() - started) * 1000),
            "stdout": _tail(error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else error.stdout or ""),
            "stderr": _tail(error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr or ""),
            "error": f"command timed out after {timeout_seconds}s",
        }
    except OSError as error:
        return {
            "command": list(resolved_argv),
            "verification": verification,
            "ok": False,
            "exitCode": None,
            "durationMs": round((time.monotonic() - started) * 1000),
            "stdout": "",
            "stderr": "",
            "error": str(error),
        }


def _run_step(step: Step) -> dict:
    started = time.monotonic()
    available = _free_bytes()
    result = {
        "name": step.name,
        "description": step.description,
        "ok": False,
        "durationMs": 0,
        "disk": {
            "availableBytes": available,
            "requiredBytes": step.min_free_bytes,
            "existingDataBytes": {path: _path_bytes(ROOT / path) for path in step.baseline_paths},
        },
        "commands": [],
        "artifacts": list(step.artifacts),
    }
    if available < step.min_free_bytes:
        result["error"] = f"insufficient disk headroom: {available} bytes free; {step.min_free_bytes} required before this source"
        result["skipped"] = True
        result["durationMs"] = round((time.monotonic() - started) * 1000)
        return result

    if step.name.startswith("hansard-"):
        (ROOT / "dist/hansard").mkdir(parents=True, exist_ok=True)

    try:
        if step.shared_committee_lock:
            with exclusive_lock(COMMITTEE_LOCK):
                _run_commands(step, result)
        else:
            _run_commands(step, result)
    except RuntimeError as error:
        result["error"] = str(error)
    result["ok"] = not result.get("error") and all(command["ok"] for command in result["commands"])
    result["durationMs"] = round((time.monotonic() - started) * 1000)
    return result


def _run_commands(step: Step, result: dict) -> None:
    for command in step.commands:
        if isinstance(command, tuple) and command[-1] == "@receipt-run-id@":
            try:
                run_id = json.loads(result["commands"][-1]["stdout"])["runId"]
                if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,79}", run_id):
                    raise ValueError
            except (KeyError, ValueError, IndexError, TypeError):
                result["error"] = "Acquisition did not identify an immutable report to replay"
                break
            command = (*command[:-1], run_id)
        outcome = _run_command(command, step.timeout_seconds)
        result["commands"].append(outcome)
        if not outcome["ok"]:
            result["error"] = outcome.get("error") or f"command exited with status {outcome['exitCode']}"
            if step.verify_partial and outcome["exitCode"] in (1, 2) and not outcome.get("verification"):
                try:
                    receipt = json.loads(outcome["stdout"])
                except (KeyError, TypeError, ValueError):
                    break
                if not isinstance(receipt, dict):
                    break
                if (outcome["exitCode"] == 2 and isinstance(step.commands[-1], tuple)
                        and step.commands[-1][-1] == "@receipt-run-id@"
                        and command == step.commands[0] and receipt.get("status") in {"pending", "partial"}):
                    continue
                fetched = receipt.get("publishedFetchedEditions")
                if (step.name == "consultation-notices" and receipt.get("scope") == "all-open"
                        and type(fetched) is int and fetched > 0):
                    continue
            break


def _publish_report(document: dict) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S.%fZ")
    dated = REPORTS / f"{stamp}.json"
    encoded = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    def atomic_write(path: Path) -> None:
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        temporary.write_text(encoded, encoding="utf-8")
        os.replace(temporary, path)

    atomic_write(dated)
    atomic_write(REPORTS / "latest.json")
    if document["ok"] and document["scope"] == "full":
        atomic_write(REPORTS / "latest-successful-full.json")
    if document["scope"] == "full":
        atomic_write(REPORTS / "latest-full.json")
    else:
        atomic_write(REPORTS / "latest-partial.json")
    return dated


def source_coverage(result: dict) -> dict:
    """Report only counts emitted by this historical attempt's acquisition commands."""
    name = result["name"]
    fields = {
        "eccc": ("documents_seen", "documents_extracted", "alternate_documents_seen", "alternate_documents_extracted", "passages"),
        "consultation-notices": ("openConsultations", "editions", "publishedFetchedEditions", "publishedArchivedSources", "counts"),
        "federal-guidance": ("listedEditions", "verifiedThisRun", "failedEditions", "linkedReferences", "availableEditions"),
        "federal-policy-editions": ("registeredLanguageIds", "linkedPolicyLanguageIds", "uniquePdfTargets", "latestFetch", "titleChecks", "editionIdentityChecks"),
        "departmental-report-editions": ("issuerLandingPagesExpected", "issuerLandingPagesFetched", "issuerLandingPagesFailed", "issuerLandingPagesSkipped"),
        "departmental-report-documents": ("directLinkCitations", "fetchedTargets", "failedTargets", "verifiedCitations", "reviewCitations"),
        "departmental-report-html": ("candidateCitations", "candidateTargets", "processedTargets", "remainingPending", "targetStatusCounts"),
        "federal-regulatory-plans": ("forwardPlanCandidates", "verifiedPlanEditions", "failedTargets", "namedInitiatives"),
        "gazette-year": ("discoveredIssues", "newlyVerifiedIssues", "archiveVerifiedPairs", "unavailableIssues",
                         "discoveredExtras", "newlyVerifiedExtras", "archiveVerifiedExtras", "unavailableExtras"),
    }
    if name not in fields:
        return {}
    for command in result.get("commands", []):
        if command.get("verification"):
            continue
        try:
            payload = json.loads(command.get("stdout", ""))
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        stats = payload.get("counts") if name == "gazette-year" else payload.get("summary", payload)
        if not isinstance(stats, dict):
            continue
        observed = {key: stats[key] for key in fields[name] if key in stats}
        if observed:
            return observed
    return {}


def weekly_status(reports: Path, names: tuple[str, ...]) -> dict:
    sources = {name: {"status": "unverified"} for name in names}
    full = None
    for path in sorted(reports.glob("????-??-??T??-??-??.*Z.json")):
        report = json.loads(path.read_bytes())
        reference = {"report": path.name, "finishedAt": report["finishedAt"]}
        for result in report["steps"]:
            if result["name"] in sources:
                checks = [cmd for cmd in result.get("commands", []) if cmd.get("verification")]
                entry = {**reference, "status": "passed" if result["ok"] else "failed"}
                coverage = source_coverage(result)
                if coverage:
                    entry["sourceCoverage"] = coverage
                if checks:
                    entry["workerVerification"] = "passed" if all(cmd["ok"] for cmd in checks) else "failed"
                if result.get("error"):
                    entry["error"] = result["error"]
                sources[result["name"]] = entry
        if report["scope"] == "full":
            observed = {row["name"] for row in report["steps"]}
            full = {**reference, "ok": report["ok"], "configuredAtRun": len(observed),
                    "passed": sum(bool(row["ok"]) for row in report["steps"]),
                    "failed": [row["name"] for row in report["steps"] if not row["ok"]],
                    "missingFromCurrentConfiguration": sorted(set(names) - observed)}
    counts = {status: sum(row["status"] == status for row in sources.values())
              for status in ("passed", "failed", "unverified")}
    return {"configured": len(names), "latestFullAttempt": full, "latestPerStep": counts, "sources": sources}


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.status:
        print(json.dumps(weekly_status(REPORTS, RUN_ORDER), indent=2))
        return 0
    by_name = {step.name: step for step in STEPS}
    selected_names = [name for name in RUN_ORDER if not args.only or name in args.only]
    selected = [by_name[name] for name in selected_names]
    if args.resume_committee_catalogue:
        selected = [replace(by_name["committees"], commands=_committee_commands(resume_catalogue=True))]
    scope = "full" if len(selected) == len(STEPS) else "partial"
    started = datetime.now(timezone.utc)
    try:
        with exclusive_lock(RUN_LOCK):
            results = []
            for step in selected:
                result = _run_step(step)
                results.append(result)
                print(f"{'ok  ' if result['ok'] else 'skip' if result.get('skipped') else 'fail'} {step.name} {result['durationMs']}ms", flush=True)
                if result.get("error"):
                    print(result["error"], file=sys.stderr)
            finished = datetime.now(timezone.utc)
            serving_checks = [
                {"source": result["name"], "command": command["command"], "ok": command["ok"], "exitCode": command["exitCode"]}
                for result in results for command in result["commands"] if command.get("verification")
            ]
            expected_checks = [
                step.name for step in selected
                if any(isinstance(command, Command) and command.verification for command in step.commands)
            ]
            checks_all_passed = len(serving_checks) == len(expected_checks) and all(check["ok"] for check in serving_checks)
            checks_failed = any(not check["ok"] for check in serving_checks)
            document = {
                "startedAt": started.isoformat().replace("+00:00", "Z"),
                "finishedAt": finished.isoformat().replace("+00:00", "Z"),
                "durationMs": round((finished - started).total_seconds() * 1000),
                "scope": scope,
                "selected": [step.name for step in selected],
                "ok": all(result["ok"] for result in results),
                "steps": results,
                "servingVerification": {
                    "status": "failed" if checks_failed else "passed" if expected_checks and checks_all_passed else "partial" if serving_checks else "not-run",
                    "expectedSources": expected_checks,
                    "checks": serving_checks,
                },
            }
            path = _publish_report(document)
            print(json.dumps({"ok": document["ok"], "durationMs": document["durationMs"], "report": str(path.relative_to(ROOT))}))
            return 0 if document["ok"] else 1
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
