import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.committee_store import initialize, mark_snapshot, replace_passages, write_link, write_record


class CommitteeStoreTests(unittest.TestCase):
    def setUp(self):
        self.db = initialize(sqlite3.connect(":memory:"))

    def tearDown(self):
        self.db.close()

    def test_joint_meeting_links_two_studies_to_same_bilingual_file(self):
        write_record(self.db, {"session": "45-1", "id": "meeting-joint-1", "language": "en",
                               "kind": "meeting", "chamber": "joint", "committee_id": "ENVI-FINA",
                               "title": "Joint study", "metadata": {"directory_refs": ["ENVI", "FINA"]}})
        for study in ("study-a", "study-b"):
            write_record(self.db, {"session": "45-1", "id": study, "language": "en", "kind": "study"})
            write_link(self.db, "45-1", "en", study, "brief-7", "includes")
            write_link(self.db, "45-1", "en", study, "brief-7", "includes")
        for language in ("en", "fr"):
            write_record(self.db, {"session": "45-1", "id": "brief-7", "language": language,
                                   "kind": "submission", "object_sha256": "a" * 64})
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_links").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(DISTINCT object_sha256) FROM cc_records").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_records WHERE id='brief-7'").fetchone()[0], 2)

    def test_same_url_changed_bytes_replace_the_record_hash(self):
        record = {"session": "45-1", "id": "brief-7", "language": "en", "kind": "submission",
                  "url": "https://www.ourcommons.ca/brief.pdf", "object_sha256": "a" * 64}
        write_record(self.db, record)
        write_record(self.db, {**record, "object_sha256": "b" * 64})
        self.assertEqual(self.db.execute("SELECT object_sha256 FROM cc_records WHERE id='brief-7'").fetchone()[0],
                         "b" * 64)

    def test_passage_replacement_is_searchable_and_resumes_idempotently(self):
        passages = [{"text": "Freshwater evidence", "location": "page:2", "speaker": "A. Person",
                     "affiliation": "Example Nation"}]
        replace_passages(self.db, "45-1", "en", "brief-7", passages)
        replace_passages(self.db, "45-1", "en", "brief-7", passages)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_passages").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'").fetchone()[0], 1)
        self.assertEqual(tuple(self.db.execute("SELECT location,speaker,affiliation FROM cc_passages").fetchone()),
                         ("page:2", "A. Person", "Example Nation"))
        replace_passages(self.db, "45-1", "en", "brief-7", [{"text": "Replacement evidence"}])
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Replacement'").fetchone()[0], 1)

    def test_simple_writes_remain_in_the_callers_transaction(self):
        self.db.execute("BEGIN")
        write_record(self.db, {"session": "45-1", "id": "rollback-me", "language": "en", "kind": "study"})
        write_link(self.db, "45-1", "en", "p", "c", "related")
        self.db.rollback()
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_records").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM cc_links").fetchone()[0], 0)

    def test_failed_replacement_keeps_previous_passages_for_retry(self):
        replace_passages(self.db, "45-1", "en", "doc", [{"text": "existing"}])
        self.db.execute("CREATE TRIGGER fail_test BEFORE INSERT ON cc_passages WHEN NEW.text='break' "
                        "BEGIN SELECT RAISE(ABORT,'interrupted'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            replace_passages(self.db, "45-1", "en", "doc", [{"text": "break"}])
        self.assertEqual(self.db.execute("SELECT text FROM cc_passages").fetchone()[0], "existing")
        self.db.execute("DROP TRIGGER fail_test")
        replace_passages(self.db, "45-1", "en", "doc", [{"text": "resumed"}])
        self.assertEqual(self.db.execute("SELECT text FROM cc_passages").fetchone()[0], "resumed")

    def test_snapshot_cutoff_is_resumable(self):
        mark_snapshot(self.db, "45-1", "2026-11-23T00:00:00Z")
        mark_snapshot(self.db, "45-1", "2026-11-24T00:00:00Z")
        self.assertEqual(self.db.execute("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").fetchone()[0],
                         "2026-11-24T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
