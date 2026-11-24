import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stderr
from io import StringIO
from pathlib import Path
from stat import S_IMODE

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


def seed_migrated_candidate(path, *, previous_generation=True):
    with closing(initialize(sqlite3.connect(path))) as db, db:
        db.execute("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)")
        db.execute("INSERT INTO d1_migrations(name) VALUES('0001_committee_preview.sql')")
        db.execute("CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB)")
        db.execute("INSERT INTO _cf_METADATA VALUES(1, X'0102')")
        if previous_generation:
            write_record(db, {"session": "45-1", "id": "prior", "language": "en", "kind": "study"})
            replace_passages(db, "45-1", "en", "prior", [{"text": "previous candidate stays on failure"}])
            mark_snapshot(db, "45-1", "2026-11-22T00:00:00Z")


class CommitteeMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source = root / "committee.sqlite"
        self.target = root / "target.sqlite"
        seed_source(self.source)
        seed_migrated_candidate(self.target)

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

    def seed_calls(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            for language, title in (("en", "Watersheds"), ("fr", "Bassins versants")):
                write_record(db, {"session": "45-1", "id": "envi-study-1", "language": language,
                                  "kind": "study", "title": title})
                write_record(db, {"session": "45-1", "id": "envi-call-1", "language": language,
                                  "kind": "call", "title": title, "metadata": {"listed": True}})
                write_link(db, "45-1", language, "envi-study-1", "envi-call-1", "study-call")

    def test_call_overlay_updates_only_scoped_rows_and_repeats_without_writes(self):
        materializer.materialize(self.source, self.target)
        with closing(sqlite3.connect(self.target)) as db, db:
            write_record(db, {"session": "45-1", "id": "envi-study-1", "language": "en",
                              "kind": "study", "title": "Participate"})
            write_record(db, {"session": "45-1", "id": "envi-study-1", "language": "fr",
                              "kind": "study", "title": "Conserver ce titre"})
        self.seed_calls()
        first = materializer.publish_calls(self.source, self.target)
        self.assertEqual((first["calls"], first["rowsWritten"], first["linksAdded"]), (2, 2, 2))
        self.assertEqual(first["studyTitlesRepaired"], 1)

        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("""UPDATE cc_records SET metadata_json='{"listed":false}'
                          WHERE id='envi-call-1' AND language='fr'""")
            db.execute("DELETE FROM cc_links WHERE child_id='envi-call-1' AND language='fr'")
        changed = materializer.publish_calls(self.source, self.target)
        self.assertEqual((changed["rowsWritten"], changed["linksRemoved"]), (1, 1))
        replay = materializer.publish_calls(self.source, self.target)
        self.assertEqual((replay["rowsWritten"], replay["linksAdded"], replay["linksRemoved"]), (0, 0, 0))
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute("SELECT title FROM cc_records WHERE id='envi-study-1' ORDER BY language")
                             .fetchall(), [("Watersheds",), ("Conserver ce titre",)])
            self.assertEqual(db.execute("SELECT metadata_json FROM cc_records WHERE id='envi-call-1' AND language='fr'")
                             .fetchone(), ('{"listed":false}',))
            self.assertEqual(db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'")
                             .fetchone(), (1,))
            self.assertEqual(db.execute("SELECT count(*) FROM d1_migrations").fetchone(), (1,))

    def test_call_overlay_rejects_different_generations_and_rolls_back_writes(self):
        self.seed_calls()
        with self.assertRaisesRegex(ValueError, "matching .* cutoffs"):
            materializer.publish_calls(self.source, self.target)
        with closing(sqlite3.connect(self.target)) as db, db:
            mark_snapshot(db, "45-1", "2026-11-23T20:00:00Z")
            db.execute("""CREATE TRIGGER stop_call BEFORE INSERT ON cc_links
                WHEN NEW.relation='study-call' BEGIN SELECT RAISE(ABORT,'fixture interrupt'); END""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture interrupt"):
            materializer.publish_calls(self.source, self.target)
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM cc_records WHERE kind='call'").fetchone(), (0,))
            self.assertEqual(db.execute("SELECT id FROM cc_records").fetchall(), [("prior",)])

    def test_call_cli_requires_the_unique_documented_local_d1_file(self):
        directory = Path(self.temp.name) / "v3/d1/miniflare-D1DatabaseObject"
        directory.mkdir(parents=True)
        self.target.rename(directory / "different.sqlite")
        args = ["--source", str(self.source), "--persist-to", self.temp.name, "--calls-only"]
        with redirect_stderr(StringIO()) as error:
            self.assertEqual(materializer.main(args), 1)
        self.assertIn("documented local committee D1 binding", error.getvalue())

        (directory / materializer.CALLS_D1_FILE).touch()
        with redirect_stderr(StringIO()) as error:
            self.assertEqual(materializer.main(args), 1)
        self.assertIn("found 2", error.getvalue())

    @unittest.skipUnless(sys.platform == "darwin", "APFS local publication")
    def test_apfs_clone_materializes_a_fresh_migrated_target_and_repeats(self):
        self.target = self.target.with_name("fresh.sqlite")
        seed_migrated_candidate(self.target, previous_generation=False)
        self.source.chmod(0o644)
        self.target.chmod(0o600)
        with closing(sqlite3.connect(self.source)) as source, source:
            source.execute("INSERT INTO cc_revision VALUES('45-1','source','en','source-only')")
        with closing(sqlite3.connect(self.target)) as target, target:
            target.execute("INSERT INTO cc_revision VALUES('45-1','target','en','target-only')")
            target.execute("INSERT INTO d1_migrations(id, name) VALUES(42, 'discarded')")
            target.execute("DELETE FROM d1_migrations WHERE id=42")
        with closing(sqlite3.connect(self.target)) as target:
            expected_schema = target.execute(
                "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"
            ).fetchall()

        first = materializer.clone_local(self.source, self.target, "45-1", 5)
        self.assertEqual(S_IMODE(self.target.stat().st_mode), 0o600)
        second = materializer.clone_local(self.source, self.target, "45-1", 5)
        self.assertEqual(S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertEqual(first, second)
        self.assertEqual(first["method"], "verified-apfs-clone")
        self.assertEqual(first["ftsProbe"]["hits"], 1)
        with closing(sqlite3.connect(self.target)) as target:
            self.assertEqual(target.execute(
                "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"
            ).fetchall(), expected_schema)
            self.assertEqual(target.execute("SELECT signature FROM cc_revision").fetchall(), [("target-only",)])
            self.assertEqual(target.execute("SELECT name FROM d1_migrations").fetchall(), [("0001_committee_preview.sql",)])
            self.assertEqual(target.execute("SELECT name, seq FROM sqlite_sequence").fetchall(), [("d1_migrations", 42)])
            self.assertEqual(target.execute("SELECT value FROM _cf_METADATA").fetchall(), [(b"\x01\x02",)])
            self.assertEqual(target.execute("SELECT cutoff FROM cc_snapshot").fetchone()[0], "2026-11-23T20:00:00Z")
            self.assertEqual(target.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'").fetchone()[0], 1)

    @unittest.skipUnless(sys.platform == "darwin", "APFS local publication")
    def test_apfs_clone_restores_schema_on_legacy_clone_targets(self):
        with closing(sqlite3.connect(self.target)) as db, db:
            for table in ("cc_revision", "cc_changes", "cc_link_changes", "cc_extracted"):
                db.execute(f"DROP TABLE {table}")
        materializer.clone_local(self.source, self.target, "45-1", 5)
        with closing(sqlite3.connect(self.target)) as db:
            for table in ("cc_revision", "cc_changes", "cc_link_changes", "cc_extracted"):
                self.assertEqual(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)

    @unittest.skipUnless(sys.platform == "darwin", "APFS local publication")
    def test_apfs_clone_rejects_unknown_source_tables_and_preserves_previous_generation(self):
        materializer.clone_local(self.source, self.target, "45-1", 5)
        previous = self.target.read_bytes()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE unrelated_source_data(id INTEGER)")
        with self.assertRaisesRegex(ValueError, "Unexpected tables"):
            materializer.clone_local(self.source, self.target, "45-1", 5)
        self.assertEqual(self.target.read_bytes(), previous)
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM cc_passages").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM cc_fts WHERE cc_fts MATCH 'Freshwater'").fetchone()[0], 1)

    @unittest.skipUnless(sys.platform == "darwin", "APFS local publication")
    def test_apfs_clone_rejects_unknown_target_tables_and_versions(self):
        cases = (
            ("CREATE TABLE unrelated_target_data(id INTEGER)", "Unexpected tables"),
            ("INSERT INTO d1_migrations(name) VALUES('0002_future.sql')", "migration version"),
            ("ALTER TABLE cc_revision ADD COLUMN future TEXT", "Unexpected definition for cc_revision"),
        )
        for index, (alteration, reason) in enumerate(cases):
            with self.subTest(reason=reason):
                target = self.target.with_name(f"unknown-{index}.sqlite")
                seed_migrated_candidate(target)
                with closing(sqlite3.connect(target)) as db, db:
                    db.execute(alteration)
                previous = target.read_bytes()
                with self.assertRaisesRegex(ValueError, reason):
                    materializer.clone_local(self.source, target, "45-1", 5)
                self.assertEqual(target.read_bytes(), previous)

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
