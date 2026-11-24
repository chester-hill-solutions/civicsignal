import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.committee_store import initialize, mark_snapshot, replace_passages, write_link, write_record

SPEC = importlib.util.spec_from_file_location("materialize_committee", ROOT / "scripts/materialize-committee-corpus.py")
materializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materializer)


def seed_source(path):
    db = initialize(sqlite3.connect(path))
    write_record(db, {"session": "45-1", "id": "meeting-1", "language": "en", "kind": "meeting",
                      "chamber": "joint", "committee_id": "ENVI-FINA", "title": "Water meeting",
                      "metadata": {"source": "fixture"}})
    write_record(db, {"session": "45-1", "id": "brief-1", "language": "en", "kind": "submission",
                      "object_sha256": "a" * 64})
    write_record(db, {"session": "45-1", "id": "brief-1", "language": "fr", "kind": "submission",
                      "object_sha256": "a" * 64})
    write_link(db, "45-1", "en", "meeting-1", "brief-1", "includes")
    write_link(db, "45-1", "fr", "meeting-1", "brief-1", "includes")
    replace_passages(db, "45-1", "en", "brief-1", [
        {"text": "Freshwater evidence supports this finding.", "location": "page:1", "speaker": None,
         "affiliation": "Example Nation"},
        {"text": "The committee recommends clean water funding.", "location": "page:2"},
    ])
    replace_passages(db, "45-1", "fr", "brief-1", [
        {"text": "Les données sur l’eau douce appuient cette conclusion.", "location": "page:1"},
    ])
    mark_snapshot(db, "45-1", "2026-11-23T20:00:00Z")
    db.commit()
    db.close()


def seed_old_candidate(path):
    db = initialize(sqlite3.connect(path))
    db.execute("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE)")
    db.execute("INSERT INTO d1_migrations(name) VALUES('0001_committee_preview.sql')")
    write_record(db, {"session": "45-1", "id": "prior", "language": "en", "kind": "study"})
    replace_passages(db, "45-1", "en", "prior", [{"text": "previous candidate stays on failure"}])
    mark_snapshot(db, "45-1", "2026-11-22T00:00:00Z")
    db.commit()
    db.close()


class CommitteeMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source = root / "committee.sqlite"
        self.target = root / "target.sqlite"
        seed_source(self.source)
        seed_old_candidate(self.target)

    def tearDown(self):
        self.temp.cleanup()

    def test_repeated_materialization_has_parity_and_external_fts(self):
        first = materializer.materialize(self.source, self.target)
        second = materializer.materialize(self.source, self.target)
        self.assertEqual(first, second)
        self.assertTrue(first["sourceEquivalent"])
        self.assertEqual(first["tables"]["cc_records"]["count"], 3)
        self.assertEqual(first["tables"]["cc_links"]["count"], 2)
        self.assertEqual(first["tables"]["cc_passages"]["count"], 3)
        self.assertEqual(first["ftsProbe"]["hits"], 1)
        db = sqlite3.connect(self.target)
        self.assertIn("content='cc_passages'", db.execute(
            "SELECT lower(sql) FROM sqlite_master WHERE name='cc_fts'").fetchone()[0])
        self.assertEqual(db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM cc_records WHERE id='prior'").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").fetchone()[0],
                         "2026-11-23T20:00:00Z")
        db.close()

    def test_failure_rolls_back_candidate_and_fts_generation(self):
        db = sqlite3.connect(self.target)
        db.execute("CREATE TRIGGER stop_candidate BEFORE INSERT ON cc_links WHEN NEW.child_id='brief-1' "
                   "BEGIN SELECT RAISE(ABORT,'fixture interrupt'); END")
        db.commit()
        db.close()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture interrupt"):
            materializer.materialize(self.source, self.target)
        db = sqlite3.connect(self.target)
        self.assertEqual(db.execute("SELECT id FROM cc_records WHERE session='45-1'").fetchone()[0], "prior")
        self.assertEqual(db.execute("SELECT text FROM cc_passages WHERE session='45-1'").fetchone()[0],
                         "previous candidate stays on failure")
        self.assertEqual(db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'previous'").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").fetchone()[0],
                         "2026-11-22T00:00:00Z")
        db.close()

    @unittest.skipUnless(sys.platform == "darwin", "APFS local publication")
    def test_apfs_clone_verifies_and_preserves_prior_generation_on_failure(self):
        first = materializer.clone_local(self.source, self.target, "45-1", 5)
        self.assertEqual(first["ftsProbe"]["hits"], 1)
        with sqlite3.connect(self.source) as db:
            db.execute("CREATE TABLE unrelated_source_data(id INTEGER)")
        with self.assertRaisesRegex(ValueError, "Unexpected tables"):
            materializer.clone_local(self.source, self.target, "45-1", 5)
        with sqlite3.connect(self.target) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM cc_passages").fetchone()[0], 3)
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='unrelated_source_data'").fetchone())

    def test_default_d1_locator_requires_single_database(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            folder = state / "v3/d1/miniflare-D1DatabaseObject"
            folder.mkdir(parents=True)
            (folder / "metadata.sqlite").touch()
            with self.assertRaisesRegex(ValueError, "found 0"):
                materializer.database_file(state)
            (folder / "isolated.sqlite").touch()
            self.assertEqual(materializer.database_file(state), folder / "isolated.sqlite")
            (folder / "unexpected.sqlite").touch()
            with self.assertRaisesRegex(ValueError, "found 2"):
                materializer.database_file(state)


if __name__ == "__main__":
    unittest.main()
