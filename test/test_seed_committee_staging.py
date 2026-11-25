"""Check bulk SQL fidelity, checkpoint safety and destination FTS construction."""

from hashlib import sha256
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = spec_from_file_location(
    "committee_stage_seed", ROOT / "scripts/seed-committee-staging.py"
)
seed = module_from_spec(spec)
spec.loader.exec_module(seed)


class CommitteeSeedTests(unittest.TestCase):
    def test_bounded_insert_roundtrip(self):
        rows = [
            (
                "45-1",
                "fr",
                "Éditeur's; lien\narchive" + str(i),
                "2",
                "https://example.org",
            )
            for i in range(20)
        ]
        db = sqlite3.connect(":memory:")
        db.execute(
            "CREATE TABLE cc_links(session,language,parent_id,child_id,relation)"
        )
        with (
            patch.object(seed, "MAX_STATEMENT_BYTES", 230),
            patch.object(seed, "PILOT_BYTES", 250),
            patch.object(seed, "SHARD_BYTES", 600),
        ):
            shards = list(seed.shards(seed.statements(rows, "cc_links")))
        self.assertGreater(len(shards), 1)
        self.assertLessEqual(len(shards[0][0]), 250)
        self.assertEqual(sum(n for _, n in shards), len(rows))
        for sql, _ in shards:
            self.assertLessEqual(len(sql), 600)
            db.executescript(sql.decode())
        self.assertEqual(
            db.execute("SELECT * FROM cc_links ORDER BY rowid").fetchall(), rows
        )
        db.close()

    def test_truncated_oversize_and_disagreeing_checkpoints(self):
        with self.assertRaises(ValueError):
            seed.literal("sample\0suffix")
        with self.assertRaisesRegex(ValueError, "statement size"):
            list(seed.statements([("a" * 100_000,)], "cc_records"))
        content = b"INSERT INTO t VALUES(1);"
        prior = {
            ("cc_records", 0): {
                "phase": "cc_records",
                "ordinal": 0,
                "rows": 1,
                "digest": sha256(content).hexdigest(),
            }
        }
        seed.write_chunk(None, None, "cc_records", 0, content, 1, prior)
        with self.assertRaisesRegex(RuntimeError, "does not match source"):
            seed.write_chunk(None, None, "cc_records", 0, content, 2, prior)

    def test_fts_shards_use_serving_rowids(self):
        db = sqlite3.connect(":memory:")
        db.executescript(
            (
                ROOT / "preview/committees/migrations/0001_committee_preview.sql"
            ).read_text()
        )
        for i in range(12):
            db.execute(
                "INSERT INTO cc_passages(session,language,document_id,position,text) VALUES('45-1','fr','doc',?,?)",
                (10 + i, "débat" if i % 2 else "dépôt"),
            )
        with patch.object(seed, "FTS_ROWS", 2):
            shards = list(seed.index_shards(12))
        self.assertEqual([n for _, n in shards], [2, 10])
        for sql, _ in shards:
            db.executescript(sql.decode())
        self.assertEqual(
            db.execute(
                "SELECT position FROM cc_fts WHERE cc_fts MATCH 'débat' ORDER BY rowid"
            ).fetchall(),
            [(11,), (13,), (15,), (17,), (19,), (21,)],
        )
        db.execute("INSERT INTO cc_fts(cc_fts,rank) VALUES('integrity-check',1)")
        db.close()

    def test_equal_term_counts_cannot_hide_postings_assigned_to_the_wrong_passage(self):
        schema = (
            ROOT / "preview/committees/migrations/0001_committee_preview.sql"
        ).read_text()
        rows = [
            ("en", "a", "Honourable college"),
            ("en", "b", "college"),
            ("fr", "a", "comité collège"),
            ("fr", "b", "collège"),
        ]
        source, remote = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
        try:
            for db in (source, remote):
                db.row_factory = sqlite3.Row
                db.executescript(schema)
                for lang, doc, text in rows:
                    db.execute(
                        "INSERT INTO cc_passages(session,language,document_id,position,text) VALUES('45-1',?,?,1,?)",
                        (lang, doc, text),
                    )
            for i, (lang, doc, text) in enumerate(rows, 1):
                source.execute(
                    "INSERT INTO cc_fts(rowid,session,language,document_id,position,text) VALUES(?,'45-1',?,?,1,?)",
                    (i, lang, doc, text),
                )
                wrong = {1: 2, 2: 1}.get(i, i)
                remote.execute(
                    "INSERT INTO cc_fts(rowid,session,language,document_id,position,text) VALUES(?,'45-1',?,?,1,?)",
                    (wrong, lang, doc, text),
                )

            def query(sql):
                return [dict(row) for row in remote.execute(sql)]

            def raw(*args):
                return [
                    {
                        "success": True,
                        "results": {
                            "rows": [tuple(row) for row in remote.execute(args[-1])]
                        },
                    }
                ]

            with patch.object(seed, "query", query), patch.object(seed, "cf", raw):
                with self.assertRaisesRegex(ValueError, "different passage keys"):
                    seed.verify_index(source, {"cc_passages": {"count": 4}})
        finally:
            source.close()
            remote.close()


if __name__ == "__main__":
    unittest.main()
