import csv
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import shutil
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("federal_procurement", SCRIPTS / "federal-procurement.py")
procurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(procurement)


def row_for(kind):
    required = procurement.AWARD_REQUIRED if kind == "award-notices" else procurement.HISTORY_REQUIRED
    headers = sorted(required)
    values = []
    for name in headers:
        if name == "publicationDate-datePublication":
            values.append("2026-04-02")
        elif name == "contractAwardDate-dateAttributionContrat":
            values.append("2026-04-02")
        elif "title-titre-eng" in name:
            values.append("Example award")
        elif "title-titre-fra" in name:
            values.append("Attribution exemple")
        else:
            values.append("sample")
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(headers)
    writer.writerow(values)
    return stream.getvalue(), headers


class ProcurementTests(unittest.TestCase):
    def test_fiscal_year_boundaries_are_april_to_march(self):
        self.assertEqual(procurement.current_fiscal_year(procurement.date(2026, 3, 31)), "2025-2026")
        self.assertEqual(procurement.current_fiscal_year(procurement.date(2026, 4, 1)), "2026-2027")
        self.assertEqual(procurement.current_fiscal_year(procurement.date(2027, 1, 1)), "2026-2027")

    def test_award_and_contract_history_schemas_remain_distinct(self):
        award, award_headers = row_for("award-notices")
        history, history_headers = row_for("contract-history")
        award_schema = procurement.scan(io.StringIO(award), "award-notices", "2026-2027")
        history_schema = procurement.scan(io.StringIO(history), "contract-history", "2026-2027")
        self.assertIn("awardStatus-attributionStatut-eng", award_schema["headers"])
        self.assertNotIn("contractStatus-statutContrat-eng", award_schema["headers"])
        self.assertIn("contractStatus-statutContrat-eng", history_schema["headers"])
        self.assertIn("numberOfRecords-nombreEnregistrements", history_schema["headers"])
        with self.assertRaisesRegex(ValueError, "schema mismatch"):
            procurement.scan(io.StringIO(award), "contract-history", "2026-2027")
        self.assertEqual(award_schema["rows"], 1)
        self.assertEqual(history_schema["rows"], 1)

    def test_rejects_out_of_fiscal_year_records_and_inconsistent_rows(self):
        award, headers = row_for("award-notices")
        bad_year = award.replace("2026-04-02", "2025-03-31")
        with self.assertRaisesRegex(ValueError, "outside fiscal year"):
            procurement.scan(io.StringIO(bad_year), "award-notices", "2026-2027")
        with self.assertRaisesRegex(ValueError, "columns"):
            procurement.scan(io.StringIO(",".join(headers) + "\nonly-one-value\n"), "award-notices", "2026-2027")

    def test_resolves_only_registered_official_current_year_resource(self):
        resources = [
            {"name_translated": {"en": "Award notices, 2026-2027"}, "format": "CSV",
             "url": "https://canadabuys.canada.ca/opendata/pub/current.csv"},
            {"name_translated": {"en": "Award notices, 2025-2026"}, "format": "CSV",
             "url": "https://canadabuys.canada.ca/opendata/pub/old.csv"},
            {"name_translated": {"en": "Award notices, 2026-2027"}, "format": "PDF",
             "url": "https://canadabuys.canada.ca/opendata/pub/current.pdf"},
        ]
        self.assertEqual(procurement.select_current_resource(resources, "award-notices", "2026-2027")["url"],
                         "https://canadabuys.canada.ca/opendata/pub/current.csv")
        with self.assertRaisesRegex(ValueError, "unverified"):
            procurement.select_current_resource([{**resources[0], "url": "https://example.org/current.csv"}],
                                                "award-notices", "2026-2027")

    def test_streams_hashes_and_compresses_original_export_before_publication(self):
        source, _ = row_for("award-notices")
        payload = source.encode()

        class Response(io.BytesIO):
            status = 200
            headers = {"Last-Modified": "Tue, 24 Nov 2026 10:30:34 GMT"}
            def geturl(self):
                return "https://canadabuys.canada.ca/opendata/pub/current.csv"

        class FakeReader:
            def head(self, _url):
                return {"contentLength": len(payload), "lastModified": "Tue, 24 Nov 2026 10:30:34 GMT"}
            def stream(self, _url):
                return Response(payload)

        with TemporaryDirectory() as tmp:
            result = procurement.stage_resource(FakeReader(), {
                "kind": "award-notices", "sourceUrl": "https://canadabuys.canada.ca/opendata/pub/current.csv",
                "advertisedBytes": len(payload), "estimatedGzipBytes": 1024,
            }, "2026-2027", Path(tmp))
            path = Path(result["stagedPath"])
            with gzip.open(path, "rb") as archived:
                self.assertEqual(archived.read(), payload)
            self.assertEqual(result["sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(result["schema"]["rows"], 1)
            path.unlink()

    def test_space_guard_aborts_before_export_staging_when_reserve_would_be_breached(self):
        source, _ = row_for("award-notices")
        payload = source.encode()

        class Response(io.BytesIO):
            status = 200
            headers = {}
            def geturl(self):
                return "https://canadabuys.canada.ca/opendata/pub/current.csv"

        class FakeReader:
            def head(self, _url):
                return {"contentLength": len(payload), "lastModified": None}
            def stream(self, _url):
                return Response(payload)

        with TemporaryDirectory() as tmp:
            low_space = type("Usage", (), {"free": procurement.RESERVE + len(payload) - 1})()
            with patch.object(procurement.shutil, "disk_usage", return_value=low_space):
                with self.assertRaisesRegex(ValueError, "Insufficient free space"):
                    procurement.stage_resource(FakeReader(), {
                        "kind": "award-notices", "sourceUrl": "https://canadabuys.canada.ca/opendata/pub/current.csv",
                        "advertisedBytes": len(payload), "estimatedGzipBytes": 1024,
                    }, "2026-2027", Path(tmp))
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_failed_second_stage_cannot_publish_a_partial_generation(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            resources = []
            for kind in procurement.KINDS:
                source, _ = row_for(kind)
                payload = source.encode()
                path = root / (kind + ".csv.gz")
                with gzip.open(path, "wb") as archive:
                    archive.write(payload)
                resources.append({"kind": kind, "sourceUrl": f"https://canadabuys.canada.ca/{kind}.csv",
                                  "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
                                  "compressedBytes": path.stat().st_size, "stagedPath": str(path), "schema": {"rows": 1}})
            observation = {"fiscalYear": "2026-2027", "indexes": {}, "excluded": [], "resources": resources}
            procurement.publish(root, observation)
            with sqlite3.connect(root / "publications.sqlite") as db:
                old = db.execute("SELECT generation,resources_json FROM observations").fetchone()
            failed_resources = []
            for index, resource in enumerate(json.loads(old[1])):
                staged = root / f"retry-{index}.csv.gz"
                if index == 0:
                    shutil.copyfile(resource["objectPath"], staged)
                failed_resources.append({**resource, "stagedPath": str(staged if index == 0 else root / "missing.csv.gz")})
            with self.assertRaises(FileNotFoundError):
                procurement.publish(root, {**observation, "resources": failed_resources})
            with sqlite3.connect(root / "publications.sqlite") as db:
                self.assertEqual(db.execute("SELECT generation,resources_json FROM observations").fetchone(), old)


if __name__ == "__main__":
    unittest.main()
