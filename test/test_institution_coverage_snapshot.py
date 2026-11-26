import copy
import gzip
import importlib.util
import io
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "services/institution-coverage/container/snapshot.py"
SPEC = importlib.util.spec_from_file_location("coverage_snapshot", SOURCE)
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)
ROOT = "dist/geds"


class CoverageSnapshot(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.src = self.base / "src"
        self.data = self.src / ROOT
        self.data.mkdir(parents=True)
        self.dest = self.base / "dest"
        self.dest.mkdir()
        self.chunks = {}

    def capture(self):
        return snapshot.capture(self.src, (ROOT,), self.chunks.__setitem__)

    def restore(self, manifest):
        snapshot.restore(self.dest, manifest, self.chunks.__getitem__)

    def test_roundtrip_chunks_links_wal_and_stable_digest(self):
        (self.data / "generations").mkdir()
        (self.data / "generations/data").write_bytes(os.urandom(2048))
        (self.data / "current").symlink_to("generations")
        with sqlite3.connect(self.data / "index.sqlite") as db:
            self.addCleanup(db.close)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE records AS SELECT 137 AS count")
            db.commit()
            with patch.object(snapshot, "CHUNK_SIZE", 400):
                manifest = self.capture()
                self.assertGreater(len(manifest["chunks"]), 3)
                self.assertEqual(manifest, self.capture())
                self.restore(manifest)
        path = self.dest / ROOT
        self.assertEqual((path / "current").readlink(), Path("generations"))
        self.assertEqual((path / "current/data").read_bytes(), (self.data / "current/data").read_bytes())
        self.assertFalse((path / "index.sqlite-shm").exists())
        with sqlite3.connect(path / "index.sqlite") as restored:
            self.addCleanup(restored.close)
            self.assertEqual(restored.execute("SELECT * FROM records").fetchall(), [(137,)])

    def test_fail_closed_then_replace_preexisting_tree(self):
        (self.data / "new").write_text("new")
        old = self.dest / ROOT / "old"
        old.parent.mkdir(parents=True)
        old.write_text("previous")
        manifest = self.capture()
        invalid = copy.deepcopy(manifest)
        invalid["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "aggregate"):
            self.restore(invalid)
        key = manifest["chunks"][0]["key"]
        original = self.chunks[key]
        self.chunks[key] = b"x" + original[1:]
        with self.assertRaisesRegex(ValueError, "chunk"):
            self.restore(manifest)
        self.assertEqual(old.read_text(), "previous")
        self.chunks[key] = original
        self.restore(manifest)
        self.assertFalse(old.exists())
        self.assertEqual((old.parent / "new").read_text(), "new")

    def test_reject_unapproved_root_or_external_symlink(self):
        with self.assertRaisesRegex(ValueError, "root"):
            snapshot.capture(self.src, ["dist"], self.chunks.__setitem__)
        (self.data / "unsafe").symlink_to("../../elsewhere")
        with self.assertRaisesRegex(ValueError, "link"):
            self.capture()
        (self.data / "unsafe").unlink()
        manifest = self.capture()
        (self.dest / "dist").symlink_to(self.src / "dist")
        with self.assertRaisesRegex(ValueError, "root"):
            self.restore(manifest)

    def test_restore_rejects_traversal_special_members_and_external_links(self):
        for name, kind, target in [(ROOT + "/../breakout", tarfile.REGTYPE, ""),
                                   (ROOT + "/hard", tarfile.LNKTYPE, "/tmp/other"),
                                   (ROOT + "/fifo", tarfile.FIFOTYPE, ""),
                                   (ROOT + "/link", tarfile.SYMTYPE, "../../bad")]:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = target
                buf = io.BytesIO()
                with tarfile.open(fileobj=buf, mode="w") as tar:
                    top = tarfile.TarInfo(ROOT)
                    top.type = tarfile.DIRTYPE
                    tar.addfile(top)
                    tar.addfile(member)
                archive = gzip.compress(buf.getvalue())
                checksum = snapshot.digest(archive)
                key = f"{snapshot.PREFIX}/chunks/{checksum}"
                manifest = {"schemaVersion": 1, "roots": [ROOT], "compressedBytes": len(archive),
                            "sha256": checksum, "chunks": [{"key": key, "sha256": checksum, "bytes": len(archive)}]}
                self.chunks[key] = archive
                with self.assertRaises(ValueError):
                    self.restore(manifest)
                self.assertFalse((self.dest / ROOT).exists())

    def test_bootstrap_commits_manifest_only_after_successful_part_uploads(self):
        bootstrap_path = SOURCE.parents[3] / "scripts/bootstrap-institution-coverage.py"
        spec = importlib.util.spec_from_file_location("coverage_bootstrap", bootstrap_path)
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        (self.data / "data").write_bytes(os.urandom(2048))
        writes = []

        def store(key, data, content_type):
            writes.append((key, data, content_type))

        def fail_put(key, data, content_type):
            store(key, data, content_type)
            raise OSError("simulated transport failure")

        with patch.object(bootstrap.snapshot, "DEFAULT_ROOTS", [ROOT]), patch.object(bootstrap.snapshot, "CHUNK_SIZE", 400):
            with self.assertRaisesRegex(OSError, "transport"):
                bootstrap.publish(self.src, 2, fail_put)
            self.assertTrue(writes)
            self.assertTrue(all("/chunks/" in key for key, _, _ in writes))
            writes.clear()
            ref = bootstrap.publish(self.src, 2, store)
        self.assertEqual(writes[-1][0], ref["key"])
        self.assertEqual(writes[-1][2], "application/json")
        self.assertEqual(ref["sha256"], snapshot.digest(writes[-1][1]))
        self.assertEqual(ref["bytes"], len(writes[-1][1]))

    def test_mutated_input_prevents_manifest_publication(self):
        path = self.data / "changing"
        path.write_bytes(os.urandom(32 * 1024))

        def mutate(key, data):
            self.chunks[key] = data
            if path.stat().st_size != 0:
                path.write_bytes(b"")

        with patch.object(snapshot, "CHUNK_SIZE", 100):
            with self.assertRaises((OSError, ValueError)):
                snapshot.capture(self.src, [ROOT], mutate)


if __name__ == "__main__":
    unittest.main()
