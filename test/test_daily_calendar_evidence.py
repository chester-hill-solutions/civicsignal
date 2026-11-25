import importlib.util
import json
from datetime import date
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("calendar_evidence", Path(__file__).resolve().parents[1]
                                               / "scripts/schedule/verify-daily-calendar.py")
calendar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(calendar)


class DailyCalendarEvidenceTests(unittest.TestCase):
    def test_requires_the_scheduled_report_and_all_serving_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "2026-11-25T11-15-04-123Z.json"
            steps = [{"name": name, "ok": True, "serving": {"database": "fixture.sqlite"}}
                     for name in ("consultations", "committee-calls", "funding")]
            report = {"scope": "full", "ok": True, "startedAt": "2026-11-25T11:15:04.123Z",
                      "finishedAt": "2026-11-25T11:16:00Z", "durationMs": 55877, "steps": steps,
                      "workerVerification": {"ok": True, "passedTests": 4}}
            path.write_text(json.dumps(report))
            log = root / "agent.log"
            log.write_text("old\n" + json.dumps({"ok": True, "report": str(path)}) + "\n")
            before = {"label": calendar.LABEL, "calendar": {"Hour": 6, "Minute": 15}, "logInode": 10,
                      "observedAt": "2026-11-25T10:00:00Z", "logBytes": 4, "lastFullStartedAt": "old",
                      "status": {"state": "not running", "runs": "4", "last exit code": "0"}}
            after = {**before, "observedAt": "2026-11-25T11:17:01Z", "logBytes": log.stat().st_size,
                     "lastFullStartedAt": report["startedAt"], "status": {**before["status"], "runs": "5"}}
            def verify():
                return calendar.verify(before, after, log, date(2026, 11, 25), root)
            self.assertEqual(verify()["report"]["file"], path.name)
            report["workerVerification"]["passedTests"] = 3
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "four authenticated"):
                verify()
            report["workerVerification"]["passedTests"] = 4
            after["lastFullStartedAt"] = report["startedAt"] = "2026-11-25T11:02:00Z"
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "scheduled minute"):
                verify()
