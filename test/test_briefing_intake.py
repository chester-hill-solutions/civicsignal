from pathlib import Path
import json
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib import briefing_intake as intake


MAIN = (
    "tracking_number,title_en,title_fr,originating_sector_en,originating_sector_fr,addressee,date_received,"
    "action_required,additional_information_en,additional_information_fr,owner_org,owner_org_title\n"
    'B-1,"Budget & <policy>","Budget et politique",Finance,Finances,M,2025-01-02,I,,,dept-a,"Department A | Ministère A"\n'
    'B-2,Redacted,Caviardé,Security,Sécurité,D,2025-02-03,S,,,dept-b,"Department B | Ministère B"\n'
).encode()
NIL = (
    "year,month,owner_org,owner_org_title\n"
    '2025,1,dept-c,"Department C | Ministère C"\n'
    '2025,12,dept-c,"Department C | Ministère C"\n'
    '25,7,dept-d,"Department D | Ministère D"\n'
).encode()
SCHEMA = {
    "dataset_type": "briefingt",
    "resources": [{"resource_name": "briefingt", "fields": [{"id": key} for key in intake.MAIN_FIELDS[:10]]}],
}


class BriefingIntakeTests(unittest.TestCase):
    def test_schema_identity_and_real_source_shapes(self):
        self.assertEqual(intake.validate_schema(SCHEMA)["resource_name"], "briefingt")
        with tempfile.TemporaryDirectory() as directory:
            main_path = Path(directory) / "main.csv"
            nil_path = Path(directory) / "nil.csv"
            main_path.write_bytes(MAIN)
            nil_path.write_bytes(NIL)
            main = intake.summarize_csv(main_path, "main")
            nil = intake.summarize_csv(nil_path, "nil")
        self.assertEqual(main["rows"], 2)
        self.assertEqual(main["date_min"], "2025-01-02")
        self.assertEqual(main["date_max"], "2025-02-03")
        self.assertEqual(main["title_en_redacted"], 1)
        self.assertEqual(main["title_fr_redacted"], 1)
        self.assertEqual(main["bilingual_title_rows"], 2)
        self.assertEqual(main["organizations"][0]["owner_org"], "dept-a")
        self.assertEqual(nil["period_rows"], {"2025-01": 1, "2025-12": 1, "2025-07": 1})
        self.assertEqual(nil["year_forms"]["25"], 1)

    def test_rejects_invalid_source_dates_and_schema_identity(self):
        bad = MAIN.replace(b"2025-01-02", b"2025-2-02")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.csv"
            path.write_bytes(bad)
            with self.assertRaisesRegex(ValueError, "invalid date_received"):
                intake.summarize_csv(path, "main")
        with self.assertRaisesRegex(ValueError, "dataset_type"):
            intake.validate_schema({"dataset_type": "other", "resources": []})

    def test_ingest_archives_immutable_sources_and_discloses_text_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            main_path, nil_path, schema_path = root / "main.csv", root / "nil.csv", root / "schema.json"
            main_path.write_bytes(MAIN)
            nil_path.write_bytes(NIL)
            schema_path.write_text(json.dumps(SCHEMA), encoding="utf-8")
            receipt = intake.ingest(main_path, nil_path, schema_path, root)
            self.assertEqual(receipt["main"]["rows"], 2)
            self.assertEqual(receipt["nil"]["reporting_period_rows"], {"2025-01": 1, "2025-12": 1, "2025-07": 1})
            self.assertIn("underlying briefing note texts are not provided", receipt["main"]["public_text"])
            archive_path = Path(receipt["sources"]["main"]["object"])
            self.assertEqual(archive_path.read_bytes(), MAIN)
            self.assertEqual(intake.search_records(archive_path, "BUDGET")[0]["tracking_number"], "B-1")
            self.assertEqual(intake.search_records(archive_path, "Ministère A")[0]["tracking_number"], "B-1")
            replayed = intake.replay(root)
            inventory_hash = replayed["inventory"]["sha256"]
            self.assertEqual(replayed["main"]["rows"], 2)
            self.assertEqual(intake.replay(root)["inventory"]["sha256"], inventory_hash)
            self.assertEqual(archive_path.read_bytes(), MAIN)


if __name__ == "__main__":
    unittest.main()
