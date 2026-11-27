from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hosted_consultation_notices", ROOT / "services/consultation-notices/run.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class HostedNoticePublicationTests(unittest.TestCase):
    previous_revision = "a" * 64
    revision = "b" * 64
    previous_observed_at = "2026-11-25T02:52:26.999Z"
    observed_at = "2026-11-26T15:15:26.953Z"
    known = "https://www.canada.ca/en/known.html"
    superseded = "https://www.canada.ca/en/superseded.html"
    covered = "https://www.canada.ca/en/covered.html"
    closed = "https://www.canada.ca/en/closed.html"

    def setUp(self):
        self.workspace = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(runtime, "WORKSPACE", self.workspace))
        archive = self.workspace / "archive"
        archive.mkdir()
        self.corpus = archive / runtime.NOTICE_PATH
        self.receipts = self.corpus / "notice-receipts"
        self.store = self.corpus / "notice-index.sqlite"
        self.module = runtime.notice_intake(archive)
        previous = self.make_catalogue(self.previous_revision, self.previous_observed_at, [
            ("known", self.known, "open"), ("covered", self.covered, "open"), ("closed", self.closed, "open"),
        ])
        self.module.refresh(previous, self.store, fetcher=self.publisher, receipt_root=self.receipts)
        # This failure never appeared in the previous publication's source list.
        with closing(sqlite3.connect(self.store)) as db, db:
            db.execute("""INSERT INTO notice_attempts(catalogue_revision, consultation_id, language,
                       attempted_at, requested_url, outcome, http_status, detail)
                       VALUES (?, 'known', 'en', ?, ?, 'http-error', 403, 'Superseded')""",
                       (self.previous_revision, self.previous_observed_at, self.superseded))

    def make_catalogue(self, revision, observed, records):
        database = self.workspace / f"{revision}.sqlite"
        with closing(sqlite3.connect(database)) as db, db:
            db.executescript("""CREATE TABLE consultations_catalogues(source, observed_at, revision);
                CREATE TABLE consultations_records(id, state_at_observation, observed_at, revision, facts_json, removed_at);""")
            db.execute("INSERT INTO consultations_catalogues VALUES ('canada', ?, ?)", (observed, revision))
            for cid, url, status in records:
                profiles = {"en": {"profile": {"kind": "official" if url else "missing", "published": url, "url": url}}}
                db.execute("INSERT INTO consultations_records VALUES (?, ?, ?, ?, ?, NULL)",
                           (cid, status, observed, revision, json.dumps({"editions": profiles})))
        return database

    def publisher(self, url, status=403):
        if url in (self.known, self.superseded) and status is not None:
            error = HTTPError(url, status, "Publisher response", None, None)
            error.close()
            raise error
        return b"<h2>How to participate</h2><p>Read the official notice.</p>", "text/html", url

    def candidate(self, known_url=None, covered_url=None, status=403, budget=runtime.SOURCE_LIMITS["csv"]):
        database = self.make_catalogue(self.revision, self.observed_at, [
            ("known", known_url or self.known, "open"), ("covered", covered_url, "open"), ("closed", self.closed, "closed"),
        ])
        intake = self.module.refresh
        archive = Mock()
        archive.snapshot.return_value = {"key": "candidate"}
        archive.document.side_effect = lambda folder, report: json.loads(json.dumps(report))
        with (patch.object(runtime, "Archive", return_value=archive), patch.object(runtime, "materialize", return_value=database),
              patch.object(runtime, "notice_intake", return_value=self.module), patch.object(runtime, "check_serving", return_value=1),
              patch.object(self.module, "refresh", side_effect=lambda *args, **kwargs: intake(
                  *args, fetcher=lambda url: self.publisher(url, status), total_budget=budget, **kwargs))):
            return runtime.refresh({"inputState": {"key": "prior"},
                                    "catalogue": {"revision": self.revision, "observedAt": self.observed_at}})

    def test_known_gap_promotes_verified_archive_and_excludes_closed_editions(self):
        result = self.candidate(covered_url=self.covered)
        self.assertEqual(result["state"], {"key": "candidate"})
        report = result["report"]
        self.assertTrue(report["complete"])
        self.assertEqual(report["publisherCoverage"], "degraded")
        self.assertEqual([gap["sourceUrl"] for gap in report["failures"]], [self.known])
        self.assertEqual([gap["sourceUrl"] for gap in report["baseline"]["knownGaps"]], [self.known])
        self.assertEqual(report["baseline"]["verifiedEditions"], 2)
        self.assertEqual(report["regressedEditions"], [])

    def test_changed_http_status_is_a_new_gap(self):
        result = self.candidate(covered_url=self.covered, status=404)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("state", result)
        self.assertEqual(result["report"]["novelFailures"][0]["httpStatus"], 404)

    def test_superseded_failure_does_not_admit_same_gap_again(self):
        result = self.candidate(known_url=self.superseded, covered_url=self.covered)
        self.assertNotIn("state", result)
        self.assertEqual(result["report"]["novelFailures"][0]["sourceUrl"], self.superseded)

    def test_loss_of_a_still_open_edition_preserves_prior_archive(self):
        result = self.candidate()
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("state", result)
        self.assertEqual(result["report"]["novelFailures"], [])
        self.assertEqual(result["report"]["regressedEditions"], [{"consultationId": "covered", "language": "en"}])

    def test_archive_budget_exhaustion_cannot_promote(self):
        result = self.candidate(covered_url=self.covered, budget=0)
        self.assertNotIn("state", result)
        self.assertTrue(all(gap["outcome"] == "archive-budget" for gap in result["report"]["novelFailures"]))

    def test_recovery_completes_publisher_coverage(self):
        result = self.candidate(covered_url=self.covered, status=None)
        self.assertIn("state", result)
        self.assertEqual(result["report"]["publisherCoverage"], "complete")
        self.assertEqual(result["report"]["failures"], [])


if __name__ == "__main__":
    unittest.main()
