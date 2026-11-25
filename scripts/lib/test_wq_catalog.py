import concurrent.futures
import json
import sys
import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from scripts.lib.wq_catalog import (BASE, EN_LIST, FR_LIST, OUT, clean_question_text, main,
                                    process_detail, reusable_detail, resumable_checkpoint, tree)


class TreeTextOrderTests(unittest.TestCase):
    def test_preserves_text_before_inside_and_after_inline_markup(self):
        root = tree("<p>before <em>inside</em> after <strong>last</strong> tail</p>")
        paragraph = root.find(lambda node: node.tag == "p")
        self.assertEqual(paragraph.text(), "before inside after last tail")

    def test_removes_only_trailing_publisher_controls(self):
        cleaned, removed = clean_question_text("Real question? Show more Show less", "en")
        self.assertEqual(cleaned, "Real question?")
        self.assertTrue(removed)

    def test_removes_french_controls_and_keeps_question_words(self):
        cleaned, removed = clean_question_text("Question sur le voir plus tard. Voir plus Voir moins", "fr")
        self.assertEqual(cleaned, "Question sur le voir plus tard.")
        self.assertTrue(removed)

    def test_force_recheck_fetches_same_status_for_late_response_metadata(self):
        listing = {"sourceId": 7, "status": "answered", "statusLabel": "Answered",
                   "askedBy": {"personId": 3}, "dateAsked": "May 1, 2025", "responseDue": None, "topics": []}
        current = {**listing, "text": "Current question"}
        previous = {**current, "responses": [{"id": "old-response", "type": "viewer",
                    "responseId": "old-response", "url": "https://example.test/response"}],
                    "responseInventoryChecked": True, "detailFetchedAt": "2026-11-23T00:00:00+00:00"}
        self.assertIsNotNone(reusable_detail(current, previous))
        self.assertIsNone(reusable_detail(current, previous, force=True))

    def test_refreshes_listing_topics_without_refetching_unchanged_detail(self):
        current = {"sourceId": 9, "status": "answered", "statusLabel": "Answered",
                   "askedBy": {"personId": 3}, "dateAsked": "May 1, 2025", "responseDue": None,
                   "topics": ["Current topic"], "text": "Current question"}
        previous = {**current, "topics": ["Detail topic"], "responses": [],
                    "responseInventoryChecked": True, "detailFetchedAt": "2026-11-23T00:00:00+00:00"}
        reused = reusable_detail(current, previous)
        self.assertIsNotNone(reused)
        self.assertEqual(reused["topics"], ["Current topic"])


class ResumeCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.complete = {"observedAt": "2026-11-25T05:00:00+00:00"}
        self.records = [self.record("en"), self.record("fr")]
        self.partial = {
            "observedAt": "2026-11-25T08:00:00+00:00",
            "source": EN_LIST,
            "method": {"type": "official-rendered-pages", "englishList": EN_LIST,
                       "frenchList": FR_LIST, "paginationParameter": "page", "pageSize": 20,
                       "detailRoutes": {"en": BASE + "/written-questions/45-1/q-{number}",
                                        "fr": BASE + "/questions-ecrites/45-1/q-{number}"}},
            "sessions": [{"id": "45-1", "questionCount": 1, "pages": 1}],
            "totals": {"complete": False, "officialReported": 1, "pages": 1,
                       "enumeratedEn": 1, "enumeratedFr": 1},
            "paginationCheck": {"enListingReportedTotal": 1, "frListingReportedTotal": 1,
                                "enLastPageReportedTotal": 1, "frLastPageReportedTotal": 1,
                                "visitedPagesEn": [1], "visitedPagesFr": [1],
                                "missingFromEn": [], "missingFromFr": [],
                                "duplicateNumbersEn": [], "duplicateNumbersFr": []},
            "records": self.records,
        }

    @staticmethod
    def record(language):
        return {"language": language, "number": 12, "sourceId": 991, "status": "answered",
                "statusLabel": "Answered", "askedBy": {"personId": 8}, "dateAsked": "May 1, 2026",
                "responseDue": None, "text": "Question", "responses": [],
                "responseInventoryChecked": True, "detailFetchedAt": "2026-11-25T07:00:00+00:00"}

    def attest(self, partial=None, records=None):
        return resumable_checkpoint(partial or self.partial, records or self.records,
                                    self.complete, 1, 1,
                                    datetime(2026, 11, 25, 9, tzinfo=timezone.utc).timestamp())

    def test_reuses_only_fresh_successful_details_from_legacy_checkpoint(self):
        reusable, proof = self.attest()
        self.assertEqual(set(reusable), {("en", 12), ("fr", 12)})
        self.assertEqual(proof["checkpointSuccessfulDetails"], 2)
        self.assertEqual(proof["legacyProvenance"], {"runId": None, "recheckMode": None, "modeRecorded": False})
        self.assertTrue(proof["compatibleSourceListings"])

    def test_rejects_checkpoint_with_recorded_nonrecheck_mode(self):
        partial = json.loads(json.dumps(self.partial))
        partial["acquisition"] = {"runId": "test-run", "mode": "incremental", "recheckDetails": False}
        with self.assertRaisesRegex(ValueError, "full detail-recheck mode"):
            self.attest(partial)

    def test_rejects_changed_source_listing_metadata(self):
        changed = [dict(record) for record in self.records]
        changed[0] = {**changed[0], "dateAsked": "May 2, 2026"}
        with self.assertRaisesRegex(ValueError, "metadata differs from the current source listings"):
            self.attest(records=changed)

    def test_skips_failed_or_nonfresh_details_instead_of_reusing(self):
        partial = json.loads(json.dumps(self.partial))
        partial["records"][0]["fetchError"] = "timeout"
        partial["records"][1]["detailFetchedAt"] = "2026-11-25T04:59:59+00:00"
        reusable, proof = self.attest(partial)
        self.assertEqual(set(reusable), set())
        self.assertEqual(proof["checkpointSuccessfulDetails"], 0)

    def test_incomplete_cli_exits_nonzero(self):
        with patch.object(sys, "argv", ["wq_catalog.py"]), \
             patch("scripts.lib.wq_catalog.scrape", return_value={"totals": {"complete": False}}):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)

    def test_complete_default_cli_returns_success(self):
        with patch.object(sys, "argv", ["wq_catalog.py"]), \
             patch("scripts.lib.wq_catalog.scrape", return_value={"totals": {"complete": True}}) as scrape:
            main()
        scrape.assert_called_once_with(OUT, None, 4, 40, False, False, None)

    def test_max_pages_partial_remains_nonzero_and_passes_limit(self):
        with patch.object(sys, "argv", ["wq_catalog.py", "--max-pages", "1"]), \
             patch("scripts.lib.wq_catalog.scrape", return_value={"totals": {"complete": False}}) as scrape:
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)
        scrape.assert_called_once_with(OUT, 1, 4, 40, False, False, None)

    def test_detail_worker_mutates_copy_while_checkpoint_source_remains_serializable(self):
        source = {"language": "en", "number": 12, "metadata": {"listing": "source"}}
        started = threading.Event()
        release = threading.Event()

        def mutate(worker_record):
            self.assertIsNot(worker_record, source)
            started.set()
            self.assertTrue(release.wait(timeout=2))
            worker_record["detailOnly"] = True
            worker_record["metadata"]["worker"] = "updated"
            return worker_record

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(process_detail, source, mutate)
            self.assertTrue(started.wait(timeout=2))
            self.assertEqual(json.loads(json.dumps(source)),
                             {"language": "en", "number": 12, "metadata": {"listing": "source"}})
            release.set()
            completed = future.result(timeout=2)

        self.assertTrue(completed["detailOnly"])
        self.assertEqual(completed["metadata"]["worker"], "updated")
        self.assertEqual(source["metadata"], {"listing": "source"})


if __name__ == "__main__":
    unittest.main()
