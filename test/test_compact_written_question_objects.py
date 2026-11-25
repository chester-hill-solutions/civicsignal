import hashlib
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "compact-written-question-objects.py"
SPEC = importlib.util.spec_from_file_location("compact_written_question_objects", SCRIPT)
assert SPEC and SPEC.loader
compact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compact)


def make_html(root: Path, body: bytes, mode: int = 0o640) -> Path:
    objects = root / "objects"
    objects.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(body).hexdigest()
    path = objects / digest
    path.write_bytes(body)
    path.chmod(mode)
    return path


def fake_compressor(state):
    def compress(source: Path, destination: Path, _ditto: str) -> None:
        destination.write_bytes(source.read_bytes())
        destination.chmod(stat.S_IMODE(source.stat().st_mode))
        state["compressed"] = True
    return compress


def fake_compressed(state):
    return lambda _path: state["compressed"]


def fake_allocation(state):
    return lambda _path: 2048 if state["compressed"] else 8192


class CompactWrittenQuestionObjectsTests(unittest.TestCase):
    def temp_root(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return Path(temp.name) / "wq"

    def test_compaction_keeps_bytes_permissions_and_records_savings(self):
        root = self.temp_root()
        body = b"<!doctype html><html><body>Archived reply</body></html>"
        path = make_html(root, body)
        state = {"compressed": False}
        result = compact.compact_root(
            root,
            ditto_path="ditto-fixture",
            platform_name="Darwin",
            compress=fake_compressor(state),
            compressed=fake_compressed(state),
            allocation=fake_allocation(state),
            support_probe=lambda *_args, **_kwargs: None,
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["compacted"], 1)
        self.assertEqual(result["freedBytes"], 6144)
        self.assertEqual(result["sampleAfter"]["sha256"], path.name)
        self.assertEqual(path.read_bytes(), body)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), path.name)

    def test_checksum_mismatch_fails_before_compressor(self):
        root = self.temp_root()
        path = make_html(root, b"<html>original</html>")
        path.write_bytes(b"<html>tampered</html>")
        called = False

        def compressor(*_args):
            nonlocal called
            called = True

        with self.assertRaisesRegex(ValueError, "do not match checksum"):
            compact.compact_one(path, ditto="ditto-fixture", compress=compressor)
        self.assertFalse(called)

    def test_hard_link_is_refused(self):
        root = self.temp_root()
        path = make_html(root, b"<html>original</html>")
        other = path.with_name("linked")
        os.link(path, other)
        with self.assertRaisesRegex(ValueError, "hard-linked"):
            compact.compact_one(path, ditto="ditto-fixture")

    def test_non_html_is_not_sent_to_compressor(self):
        root = self.temp_root()
        path = make_html(root, b"%PDF-1.7\n")

        def reject(*_args):
            self.fail("must not compress PDF")

        result = compact.compact_one(path, ditto="ditto-fixture", compress=reject)
        self.assertEqual(result["status"], "not_html")

    def test_unsupported_platform_skips_only_when_requested(self):
        root = self.temp_root()
        (root / "objects").mkdir(parents=True)
        result = compact.compact_root(root, platform_name="Linux", if_supported=True)
        self.assertEqual(result["status"], "skipped_unsupported")
        with self.assertRaises(compact.UnsupportedCompression):
            compact.compact_root(root, platform_name="Linux")

    def test_limit_and_replay_are_idempotent_for_compressed_inputs(self):
        root = self.temp_root()
        path = make_html(root, b"<html>one</html>")
        state = {"compressed": False}
        kwargs = dict(
            ditto_path="ditto-fixture", platform_name="Darwin",
            compress=fake_compressor(state), compressed=fake_compressed(state), allocation=fake_allocation(state),
            support_probe=lambda *_args, **_kwargs: None,
        )
        first = compact.compact_root(root, limit=1, **kwargs)
        self.assertEqual(first["compacted"], 1)
        second = compact.compact_root(root, **kwargs)
        self.assertEqual(second["compacted"], 0)
        self.assertEqual(second["outcomes"], {"already_compressed": 1})
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), path.name)

    def test_probe_failure_skips_only_with_if_supported(self):
        root = self.temp_root()
        body = b"<html>original</html>"
        path = make_html(root, body)

        def unsupported(*_args, **_kwargs):
            raise compact.UnsupportedCompression("compression flag unavailable")

        result = compact.compact_root(
            root, ditto_path="ditto-fixture", platform_name="Darwin",
            support_probe=unsupported, if_supported=True,
        )
        self.assertEqual(result["status"], "skipped_unsupported")
        self.assertEqual(path.read_bytes(), body)
        with self.assertRaises(compact.UnsupportedCompression):
            compact.compact_root(root, ditto_path="ditto-fixture", platform_name="Darwin", support_probe=unsupported)


if __name__ == "__main__":
    unittest.main()
