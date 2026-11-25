import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from xml.sax.saxutils import escape
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/federal-publications.py"
SPEC = importlib.util.spec_from_file_location("federal_publications", SCRIPT)
publications = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(publications)


def marc_record(identifier="pub-1", title="Sample Government Publication", corrupt=False):
    fields = [(b"001", identifier.encode("ascii")), (b"245", b"10\x1fa" + title.encode("ascii") + b" /")]
    directory = bytearray()
    data = bytearray()
    for tag, value in fields:
        field = value + b"\x1e"
        directory.extend(tag + f"{len(field):04d}{len(data):05d}".encode("ascii"))
        data.extend(field)
    base = 24 + len(directory) + 1
    leader = bytearray(b" " * 24)
    leader[5:9] = b"nam "
    leader[9:12] = b"a22"
    leader[12:17] = f"{base:05d}".encode("ascii")
    leader[17:20] = b"450"
    record = leader + directory + b"\x1e" + data + (b"\x00" if corrupt else b"\x1d")
    record[0:5] = f"{len(record):05d}".encode("ascii")
    return bytes(record)


def make_inputs(directory: Path, corrupt_category=None):
    directory.mkdir(parents=True, exist_ok=True)
    for category in publications.EXPECTED:
        title = f"{category.title()} catalogue — édition"
        data = (f'<modsCollection xmlns="http://www.loc.gov/mods/v3"><mods>'
            f'<titleInfo><title>{escape(title)}</title></titleInfo>'
            f'<recordInfo><recordIdentifier source="CaOODSP">{category}-1</recordIdentifier></recordInfo>'
            f'</mods></modsCollection>').encode("utf-8")
        if category == corrupt_category:
            data = (f'<modsCollection xmlns="http://www.loc.gov/mods/v3"><mods>'
                f'<recordInfo><recordIdentifier source="CaOODSP">{category}-1</recordIdentifier></recordInfo>'
                f'</mods></modsCollection>').encode("utf-8")
        with zipfile.ZipFile(directory / f"{category}.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{category}.xml", data)


def inventory_file(path: Path):
    resources = []
    for index, (category, (en, fr)) in enumerate(publications.EXPECTED.items(), start=1):
        file_stem = {"monographs": "monographs-monographs", "series": "series", "periodicals": "periodicals-periodicals"}[category]
        resources.append({"format": "ZIP", "id": f"resource-{index}", "languages": ["en", "fr"],
            "lastModified": "2026-04-13T00:00:00", "titles": {"en": f"{en} (2025-11-20)", "fr": f"{fr} (2025-11-20)"},
            "url": f"https://{publications.OFFICIAL_HOST}/bi1/pub-pub/{file_stem}.zip"})
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE catalogue_observations(series TEXT, endpoint TEXT, observed_at TEXT, sha256 TEXT, url TEXT, inventory TEXT)")
        db.execute("INSERT INTO catalogue_observations VALUES(?,?,?,?,?,?)", ("publications", "entry_url", "2026-11-25T00:00:00Z",
            "fixture", f"https://open.canada.ca/data/api/action/package_show?id={publications.DATASET_ID}",
            json.dumps({"kind": "dataset-resources", "resources": resources})))


class FederalPublications(unittest.TestCase):
    def test_streams_and_publishes_all_three_dated_marc_archives(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inventory = base / "inventory.sqlite"
            inventory_file(inventory)
            inputs = base / "inputs"
            make_inputs(inputs)
            root = base / "corpus"
            publications.refresh(root, inputs, False, inventory)
            current = root / "current"
            self.assertTrue(current.is_symlink())
            receipt = json.loads((current / "receipt.json").read_text())
            self.assertEqual(receipt["snapshotDate"], "2025-11-20")
            self.assertEqual(set(receipt["resources"]), set(publications.EXPECTED))
            for category, item in receipt["resources"].items():
                self.assertEqual(item["recordCount"], 1)
                self.assertEqual(item["samples"][0]["id"], f"{category}-1")
                self.assertEqual(item["samples"][0]["title"], f"{category.title()} catalogue — édition")
                self.assertEqual(item["format"], "MODS XML")
                self.assertEqual(len(item["sha256"]), 64)
                self.assertTrue((current / "archives" / f"{category}.zip").is_file())

    def test_truncated_or_bad_record_does_not_replace_current_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inventory = base / "inventory.sqlite"
            inventory_file(inventory)
            root = base / "corpus"
            good = base / "good"
            make_inputs(good)
            publications.refresh(root, good, False, inventory)
            current_target = (root / "current").readlink()
            bad = base / "bad"
            make_inputs(bad, corrupt_category="series")
            with self.assertRaisesRegex(ValueError, "MODS record"):
                publications.refresh(root, bad, False, inventory)
            self.assertEqual((root / "current").readlink(), current_target)
            generations = list((root / "generations").iterdir())
            self.assertEqual(len(generations), 1)

    def test_rejects_truncated_iso_record_and_reports_duplicate_identifier(self):
        record = marc_record()
        with self.assertRaisesRegex(ValueError, "Truncated"):
            list(publications.iter_records(io.BytesIO(record[:-1])))
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            duplicate = marc_record("same", "One") + marc_record("same", "Two")
            path = base / "duplicate.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("dup.mrc", duplicate)
            with sqlite3.connect(base / "seen.sqlite") as db:
                db.execute("CREATE TABLE seen_ids(category TEXT, identifier TEXT, occurrences INTEGER, PRIMARY KEY(category,identifier))")
                result = publications.validate_zip(path, "monographs", db)
            self.assertEqual(result["recordCount"], 2)
            self.assertEqual(result["duplicateIdentifierCount"], 1)

    def test_does_not_accept_undated_or_incomplete_inventory(self):
        with tempfile.TemporaryDirectory() as temp:
            inventory = Path(temp) / "inventory.sqlite"
            inventory_file(inventory)
            with sqlite3.connect(inventory) as db:
                row = db.execute("SELECT inventory FROM catalogue_observations").fetchone()
                data = json.loads(row[0])
                data["resources"][0]["titles"]["en"] = "Monographs"
                db.execute("UPDATE catalogue_observations SET inventory=?", (json.dumps(data),))
            with self.assertRaisesRegex(ValueError, "bilingual dated ZIP"):
                publications.published_resources(inventory)

    def test_newer_wrong_dataset_observation_fails_without_replacing_current(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inventory = base / "inventory.sqlite"
            inventory_file(inventory)
            inputs = base / "inputs"
            make_inputs(inputs)
            root = base / "corpus"
            publications.refresh(root, inputs, False, inventory)
            prior = (root / "current").readlink()
            with sqlite3.connect(inventory) as db:
                encoded = db.execute("SELECT inventory FROM catalogue_observations").fetchone()[0]
                db.execute("INSERT INTO catalogue_observations VALUES(?,?,?,?,?,?)", ("publications", "entry_url",
                    "2026-11-26T00:00:00Z", "newer", "https://open.canada.ca/data/api/action/package_show?id=wrong-dataset", encoded))
            with self.assertRaisesRegex(ValueError, "registered Open Government dataset"):
                publications.refresh(root, inputs, False, inventory)
            self.assertEqual((root / "current").readlink(), prior)
            self.assertEqual(len(list((root / "generations").iterdir())), 1)

    def test_reuses_identical_publisher_packet_by_hard_link_and_rejects_changed_validator(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "corpus"
            old_generation = root / "generations" / "old"
            archive_dir = old_generation / "archives"
            archive_dir.mkdir(parents=True)
            archive = archive_dir / "monographs.zip"
            archive.write_bytes(b"verified archive")
            sha = __import__("hashlib").sha256(archive.read_bytes()).hexdigest()
            root.mkdir(exist_ok=True)
            (root / "current").symlink_to("generations/old")
            receipt = {"snapshotDate": "2025-11-20", "resources": {"monographs": {
                "id": "resource-1", "url": "https://publisher.example/monographs.zip", "etag": '"etag-1"',
                "lastModified": "Mon, 13 Apr 2026 12:00:00 GMT", "archiveBytes": archive.stat().st_size, "sha256": sha,
                "recordCount": 1, "memberCount": 1, "duplicateIdentifierCount": 0, "format": "MODS XML", "samples": [],
            }}}
            (old_generation / "receipt.json").write_text(json.dumps(receipt))
            resource = {"snapshotDate": "2025-11-20", "id": "resource-1", "url": "https://publisher.example/monographs.zip"}
            target = root / ".stage" / "monographs.zip"
            target.parent.mkdir()
            reused = publications._reuse_existing(root, "monographs", resource,
                (archive.stat().st_size, '"etag-1"', "Mon, 13 Apr 2026 12:00:00 GMT"), target, receipt)
            self.assertTrue(reused and reused["reused"])
            self.assertEqual(os.stat(target).st_ino, os.stat(archive).st_ino)
            changed = target.with_name("changed.zip")
            self.assertIsNone(publications._reuse_existing(root, "monographs", resource,
                (archive.stat().st_size, '"etag-2"', "Mon, 13 Apr 2026 12:00:00 GMT"), changed, receipt))


if __name__ == "__main__":
    unittest.main()
