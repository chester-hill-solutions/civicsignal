"""Check Gazette phase receipts and the last-good publication boundary."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "services/gazette/run.py"
spec = importlib.util.spec_from_file_location("gazette_refresh", SOURCE)
gazette = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gazette)


class GazetteCloudflareTests(unittest.TestCase):
    def test_partial_annual_refresh_verifies_its_dated_receipt(self):
        archive = Path("/gazette/archive")
        database = archive / "gazette-preview.sqlite"
        receipt = archive / "dist/gazette/backfills/catchups/dated.json"
        counts = {"archiveVerifiedPairs": 69, "newlyVerifiedIssues": 0}
        result = SimpleNamespace(returncode=1, stderr="", stdout=json.dumps({
            "complete": False, "receiptPath": str(receipt), "counts": counts,
        }))
        with patch.object(gazette, "run", return_value=result), patch.object(gazette, "check_serving", return_value=2) as verify:
            outcome = gazette.annual(archive, database, "2026-11-26")
        self.assertEqual(verify.call_args.args[:5], (database, receipt, "annual", 2, "CIVICSIGNAL_GAZETTE_CATCHUP_RECEIPT"))
        self.assertFalse(outcome["complete"])
        self.assertEqual(outcome["servingTestsPassed"], 2)
        self.assertEqual(outcome["counts"], counts)

    def test_annual_refresh_rejects_output_without_a_dated_receipt(self):
        archive = Path("/gazette/archive")
        result = SimpleNamespace(returncode=0, stderr="", stdout='{"counts": {}}')
        with patch.object(gazette, "run", return_value=result), patch.object(gazette, "check_serving") as verify:
            with self.assertRaises(KeyError):
                gazette.annual(archive, archive / "gazette-preview.sqlite", "2026-11-26")
        verify.assert_not_called()

    def test_degraded_phase_records_both_outcomes_and_preserves_last_good_snapshot(self):
        position = {"count": 2, "highWater": 3}
        store = {"journal": "same", "feed": {"en": position, "fr": position}}
        report_ref = {"key": "weekly/gazette/reports/example.json"}
        with patch.object(gazette, "Archive") as archive, patch.object(gazette, "store_status", return_value=store), \
                patch.object(gazette, "current", autospec=True) as current, patch.object(gazette, "annual", autospec=True) as annual:
            current.__name__ = "current"
            annual.__name__ = "annual"
            current.side_effect = ValueError("Part I unavailable")
            annual.return_value = {"complete": True, "servingTestsPassed": 2}
            archive.return_value.document.return_value = report_ref
            with patch.object(gazette, "part_three", return_value={"complete": True}):
                result = gazette.refresh({"inputState": {"key": "seed"}, "scheduledTime": 1795739820000})
        archive.return_value.snapshot.assert_not_called()
        folder, report = archive.return_value.document.call_args.args
        self.assertEqual(folder, "reports")
        self.assertEqual(report["cutoff"], "2026-11-26")
        self.assertEqual(report["current"], {"complete": False, "reason": "Part I unavailable"})
        self.assertTrue(report["annual"]["complete"])
        self.assertEqual(result, {"status": "failed", "report": report_ref, "reason": "Incomplete Gazette phase: current"})

    def test_part_three_failure_keeps_the_regular_archive_publication_eligible(self):
        position = {"count": 2, "highWater": 3}
        store = {"journal": "same", "feed": {"en": position, "fr": position}}
        failure = {"complete": False, "status": "degraded", "reason": "acquire: HTTP 503", "lastVerified": None}
        with patch.object(gazette, "Archive") as archive, patch.object(gazette, "store_status", return_value=store), \
                patch.object(gazette, "current", autospec=True) as current, patch.object(gazette, "annual", autospec=True) as annual, \
                patch.object(gazette, "part_three", return_value=failure):
            current.__name__ = "current"
            annual.__name__ = "annual"
            current.return_value = {"complete": True, "servingTestsPassed": 1}
            annual.return_value = {"complete": True, "servingTestsPassed": 2}
            result = gazette.refresh({"inputState": {"key": "seed"}, "scheduledTime": 1795739820000})
        archive.return_value.snapshot.assert_called_once_with()
        self.assertEqual(result["state"], archive.return_value.snapshot.return_value)
        self.assertEqual(archive.return_value.document.call_args.args[1]["partThree"], failure)

    def test_part_three_older_and_future_issues_preserve_the_last_manifest(self):
        previous = {"manifest": "part-three/latest.json", "issue": {"volume": 48, "number": 1, "publicationDate": "2026-04-10"}}
        cases = ((47, "2025-02-07", "older"), (49, "2026-11-27", "follows the cutoff"))
        for volume, day, message in cases:
            with self.subTest(volume=volume), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "archive"
                last_manifest = archive / gazette.PART_THREE_MANIFEST
                last_manifest.parent.mkdir(parents=True)
                last_manifest.write_bytes(b"previous manifest bytes")
                candidate = {"issue": {"volume": volume, "number": 1, "publicationDate": day}}
                with patch.object(gazette, "command"), \
                        patch.object(gazette, "part_three_publication", side_effect=(previous, candidate)):
                    result = gazette.part_three(archive, "2026-11-26")
                self.assertFalse(result["complete"])
                self.assertIn(message, result["reason"])
                self.assertEqual(result["lastVerified"], previous)
                self.assertEqual(last_manifest.read_bytes(), b"previous manifest bytes")


if __name__ == "__main__":
    unittest.main()
