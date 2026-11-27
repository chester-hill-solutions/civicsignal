"""Focused tests for the local weekly refresh supervisor."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/refresh-weekly.py"
SPEC = importlib.util.spec_from_file_location("refresh_weekly", SCRIPT)
weekly = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = weekly
SPEC.loader.exec_module(weekly)


class WeeklyRefreshTests(unittest.TestCase):
    def test_catalog_has_expected_weekly_collections(self):
        self.assertEqual(weekly.RUN_ORDER, ("committees",))
        self.assertEqual({step.name for step in weekly.STEPS}, set(weekly.RUN_ORDER))
        retired = {"official-titles", "service-inventory", "federal-institution-coverage", "hansard-house", "hansard-senate",
                   "gazette", "gazette-year", "ati-summaries", "grant-awards", "briefing-notes", "federal-procurement",
                   "federal-disclosures", "federal-discovery", "federal-guidance", "federal-publications",
                   "federal-publication-checklists", "federal-policy-editions", "departmental-report-html", "parliament",
                   "statutes-local", "consultation-notices", "written-questions", "geds", "eccc",
                   "departmental-report-documents", "federal-report-directories", "departmental-report-editions",
                   "federal-regulatory-plans"}
        self.assertTrue(retired.isdisjoint(weekly.RUN_ORDER))
        commands = (cmd.argv if isinstance(cmd, weekly.Command) else cmd for step in weekly.STEPS for cmd in step.commands)
        self.assertTrue(all(retired.isdisjoint(command) for command in commands))
        committees = next(step for step in weekly.STEPS if step.name == "committees")
        self.assertTrue(committees.shared_committee_lock)
        self.assertIn(("python3", "-B", "scripts/committee-corpus.py"), committees.commands)
        self.assertIn(("python3", "-B", "scripts/committee-download.py", "--verify-only"), committees.commands)

    def test_large_steps_are_gated_by_live_free_space(self):
        committees = next(step for step in weekly.STEPS if step.name == "committees")
        with patch.object(weekly, "_free_bytes", return_value=weekly.COMMITTEE_MIN_FREE_BYTES - 1), patch.object(weekly, "_run_command") as run:
            result = weekly._run_step(committees)
        self.assertTrue(result["skipped"])
        self.assertFalse(result["ok"])
        self.assertIn("insufficient disk headroom", result["error"])
        run.assert_not_called()

    def test_command_failure_stops_only_its_source_step(self):
        step = weekly.Step("fixture", (("first",), ("second",)), 10, "fixture")
        result = {"commands": []}
        outcomes = iter([
            {"ok": False, "exitCode": 7, "command": ["first"]},
        ])
        with patch.object(weekly, "_run_command", side_effect=lambda *_: next(outcomes)):
            weekly._run_commands(step, result)
        self.assertEqual(len(result["commands"]), 1)
        self.assertEqual(result["error"], "command exited with status 7")

    def test_operator_replays_its_partial_generation_and_stops_on_an_invalid_id(self):
        step = weekly.Step("fixture", (("publisher", "refresh"), ("publisher", "replay", "@receipt-run-id@")),
                           10, "fixture", verify_partial=True)
        for run_id, expected_calls in [("abc123", 2), ("../older", 1), ("", 1)]:
            result = {"commands": []}
            with patch.object(weekly, "_run_command", side_effect=[
                    {"ok": False, "exitCode": 2, "stdout": json.dumps({"runId": run_id, "status": "partial"})},
                    {"ok": True}]) as run:
                weekly._run_commands(step, result)
            self.assertIn("error", result)
            self.assertEqual(run.call_count, expected_calls)
            if expected_calls == 2:
                self.assertEqual(run.call_args.args[0][-2:], ("replay", run_id))

    def test_only_selects_one_named_step_and_rejects_unknown(self):
        self.assertEqual(weekly.parse_args(["--only", "committees"]).only, ["committees"])
        with self.assertRaises(SystemExit) as raised:
            weekly.parse_args(["--only", "no-such-source"])
        self.assertEqual(raised.exception.code, 2)

    def test_scheduled_committee_catalogue_starts_fresh_and_operator_can_resume(self):
        self.assertNotIn("--resume", weekly._committee_commands()[0])
        self.assertIn("--resume", weekly._committee_commands(resume_catalogue=True)[0])
        args = weekly.parse_args(["--only", "committees", "--resume-committee-catalogue"])
        self.assertTrue(args.resume_committee_catalogue)
        with self.assertRaises(SystemExit):
            weekly.parse_args(["--resume-committee-catalogue"])

    def test_shared_committee_lock_is_nonblocking_and_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / "dist/refresh/committee-publication.lock"
            with patch.object(weekly, "ROOT", root):
                with weekly.exclusive_lock(lock):
                    with self.assertRaisesRegex(RuntimeError, "another refresh holds"):
                        with weekly.exclusive_lock(lock):
                            self.fail("nested committee lock unexpectedly acquired")

    def test_verification_requires_a_passed_test(self):
        self.assert_exact_verification_result(passed=1, expected=1, ok=True)
        self.assert_exact_verification_result(passed=0, expected=1, ok=False)

    def assert_exact_verification_result(self, passed, expected, ok, failed=0, stdout=None):
        report = {
            "success": failed == 0,
            "numPassedTests": passed,
            "numFailedTests": failed,
            "numPendingTests": max(0, expected - passed),
            "testResults": [{"assertionResults": [{"fullName": "intentionally large result", "status": "passed"} for _ in range(passed)]}],
        }
        body = json.dumps(report) if stdout is None else stdout
        completed = type("Completed", (), {"returncode": 0, "stdout": body, "stderr": "$ vitest run --reporter=json"})()
        command = weekly.Command(("bun", "run", "test"), verification=True, expected_passed_tests=expected)
        with patch.object(weekly.subprocess, "run", return_value=completed) as run:
            result = weekly._run_command(command, 10)
        self.assertIn("--reporter=json", run.call_args.args[0])
        self.assertEqual(result["ok"], ok)
        if "passedTests" in result:
            self.assertEqual(result["passedTests"], passed)
        self.assertEqual(result.get("expectedPassedTests"), expected)
        self.assertNotIn("assertionResults", result["stdout"])
        return result

    def test_verification_rejects_too_few_passes_even_when_another_case_is_skipped(self):
        result = self.assert_exact_verification_result(passed=1, expected=2, ok=False)
        self.assertIn("expected exactly 2 passed tests, observed 1", result["error"])

    def test_selection_rejects_a_skipped_matching_test_and_allows_unselected_skips(self):
        report = {"success": True, "numPassedTests": 1, "numFailedTests": 0,
                  "testResults": [{"assertionResults": [{"fullName": "selected edition", "status": "passed"},
                                                        {"fullName": "other edition", "status": "skipped"}]}]}
        outcome = {"ok": True}
        weekly._verify_vitest_result(outcome, json.dumps(report), 1, "selected")
        self.assertTrue(outcome["ok"])
        weekly._verify_vitest_result(outcome, json.dumps(report), 1, "edition")
        self.assertFalse(outcome["ok"])

    def test_verification_rejects_too_many_passes(self):
        result = self.assert_exact_verification_result(passed=3, expected=2, ok=False)
        self.assertIn("expected exactly 2 passed tests, observed 3", result["error"])

    def test_verification_rejects_empty_selection(self):
        result = self.assert_exact_verification_result(passed=0, expected=1, ok=False)
        self.assertIn("expected exactly 1 passed tests, observed 0", result["error"])

    def test_verification_rejects_malformed_vitest_json(self):
        result = self.assert_exact_verification_result(passed=0, expected=1, ok=False, stdout="{broken json")
        self.assertNotIn("passedTests", result)
        self.assertEqual(result["error"], "Vitest JSON report is missing or malformed")

    def test_verification_rejects_structured_report_missing_required_counts(self):
        result = self.assert_exact_verification_result(
            passed=0, expected=1, ok=False, stdout=json.dumps({"numPassedTests": 1}),
        )
        self.assertNotIn("passedTests", result)
        self.assertEqual(result["error"], "Vitest JSON report is missing valid success and test counts")

    def test_scheduled_committee_requires_one_worker_check(self):
        checks = [command.expected_passed_tests for command in weekly._committee_commands()
                  if isinstance(command, weekly.Command) and command.verification]
        self.assertEqual(checks, [1])

    def test_full_report_pointer_tracks_success_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            with patch.object(weekly, "REPORTS", reports):
                weekly._publish_report({"ok": True, "scope": "full", "result": "first"})
                weekly._publish_report({"ok": False, "scope": "full", "result": "later failure"})
            self.assertEqual((reports / "latest-full.json").read_text(), '{\n  "ok": false,\n  "scope": "full",\n  "result": "later failure"\n}\n')
            self.assertEqual(__import__("json").loads((reports / "latest-successful-full.json").read_text())["result"], "first")

    def test_successful_source_with_incomplete_document_coverage_keeps_its_observed_counts(self):
        result = {"name": "eccc", "ok": True, "commands": [
            {"stdout": "Fetching sources"},
            {"stdout": '{"documents_seen":246,"documents_extracted":234,"passages":64174}'},
            {"verification": True, "stdout": "Vitest reported 2 passed and 0 failed."}]}
        self.assertEqual(weekly.source_coverage(result),
                         {"documents_seen": 246, "documents_extracted": 234, "passages": 64174})

    def test_status_keeps_retries_and_full_attempts_distinct_after_adding_a_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp)
            def save(minute, scope, ok):
                ended = f"2026-11-25T05:{minute}:00.000000Z"
                name = ended.replace(":", "-") + ".json"
                (reports / name).write_text(json.dumps({"scope": scope, "finishedAt": ended, "ok": ok,
                                                       "steps": [{"name": "source", "ok": ok}]}))
            save("00", "full", False)
            save("01", "partial", True)
            status = weekly.weekly_status(reports, ("source", "new"))
            self.assertEqual(status["latestPerStep"], {"passed": 1, "failed": 0, "unverified": 1})
            self.assertFalse(status["latestFullAttempt"]["ok"])
            self.assertEqual(status["latestFullAttempt"]["missingFromCurrentConfiguration"], ["new"])
            save("02", "partial", False)
            self.assertEqual(weekly.weekly_status(reports, ("source",))["sources"]["source"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
