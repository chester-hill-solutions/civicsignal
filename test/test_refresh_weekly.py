"""Focused tests for the local weekly refresh supervisor."""

import importlib.util
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
        self.assertEqual({step.name for step in weekly.STEPS}, set(weekly.RUN_ORDER))
        self.assertEqual(weekly.RUN_ORDER[0], "federal-discovery")
        self.assertEqual(weekly.RUN_ORDER[1], "federal-guidance")
        guidance = next(step for step in weekly.STEPS if step.name == "federal-guidance")
        self.assertIn(("python3", "-B", "scripts/federal-guidance.py", "--refresh"), guidance.commands)
        self.assertEqual(weekly.RUN_ORDER[2], "consultation-notices")
        notices = next(step for step in weekly.STEPS if step.name == "consultation-notices")
        self.assertIn(("python3", "-B", "scripts/consultation-notices.py", "refresh"), notices.commands)
        committees = next(step for step in weekly.STEPS if step.name == "committees")
        self.assertTrue(committees.shared_committee_lock)
        self.assertIn(("python3", "-B", "scripts/committee-corpus.py"), committees.commands)
        self.assertIn(("python3", "-B", "scripts/committee-download.py", "--verify-only"), committees.commands)

    def test_large_steps_are_gated_by_live_free_space(self):
        geds = next(step for step in weekly.STEPS if step.name == "geds")
        with patch.object(weekly, "_free_bytes", return_value=weekly.GEDS_MIN_FREE_BYTES - 1), patch.object(weekly, "_run_command") as run:
            result = weekly._run_step(geds)
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

    def test_partial_notice_fetch_can_verify_archived_editions_but_still_fails_the_source(self):
        step = next(step for step in weekly.STEPS if step.name == "consultation-notices")
        result = {"commands": []}
        partial = {"ok": False, "exitCode": 1, "stdout": '{"scope":"all-open","publishedFetchedEditions":3}'}
        verified = {"ok": True, "exitCode": 0, "verification": True}
        with patch.object(weekly, "_run_command", side_effect=[partial, verified]):
            weekly._run_commands(step, result)
        self.assertEqual(result["commands"], [partial, verified])
        self.assertIn("error", result)

    def test_only_selects_one_named_step_and_rejects_unknown(self):
        self.assertEqual(weekly.parse_args(["--only", "eccc"]).only, ["eccc"])
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
        completed = type("Completed", (), {"returncode": 0, "stdout": "Tests 0 skipped", "stderr": ""})()
        command = weekly.Command(("bun", "run", "test"), verification=True)
        with patch.object(weekly.subprocess, "run", return_value=completed):
            result = weekly._run_command(command, 10)
        self.assertFalse(result["ok"])
        self.assertIn("no passed tests", result["error"])

    def test_full_report_pointer_tracks_success_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            with patch.object(weekly, "REPORTS", reports):
                weekly._publish_report({"ok": True, "scope": "full", "result": "first"})
                weekly._publish_report({"ok": False, "scope": "full", "result": "later failure"})
            self.assertEqual((reports / "latest-full.json").read_text(), '{\n  "ok": false,\n  "scope": "full",\n  "result": "later failure"\n}\n')
            self.assertEqual(__import__("json").loads((reports / "latest-successful-full.json").read_text())["result"], "first")


if __name__ == "__main__":
    unittest.main()
