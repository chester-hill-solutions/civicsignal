import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "parliament-bills.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
SPEC = importlib.util.spec_from_file_location("parliament_bills", SCRIPT)
bills = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bills)


def item(number="C-1", en="An Act", fr="Loi", status_en="Introduced", status_fr="Présenté", **extra):
    record = {
        "NumberCode": number,
        "Id": 27,
        "ParliamentNumber": 45,
        "SessionNumber": 1,
        "LongTitleEn": en,
        "LongTitleFr": fr,
        "StatusNameEn": status_en,
        "StatusNameFr": status_fr,
    }
    record.update(extra)
    return record


class ParliamentBillsTest(unittest.TestCase):
    def test_builds_bilingual_records_with_lowercase_keys_and_official_urls(self):
        record = item(PassedHouseFirstReadingDateTime="2025-06-02T12:00:00-04:00")
        rows = bills.build_records("45-1", {"en": [record], "fr": [record]})
        self.assertEqual([(r["key"], r["language"]) for r in rows], [("c-1", "en"), ("c-1", "fr")])
        self.assertEqual(rows[0]["title"], "An Act")
        self.assertEqual(rows[0]["summary"], "Introduced")
        self.assertEqual(rows[1]["title"], "Loi")
        self.assertEqual(rows[1]["summary"], "Présenté")
        self.assertEqual(rows[0]["date"], "2025-06-02")
        self.assertEqual(rows[0]["url"], "https://www.parl.ca/legisinfo/en/bill/45-1/c-1")
        self.assertEqual(rows[1]["url"], "https://www.parl.ca/legisinfo/fr/projet-de-loi/45-1/c-1")

    def test_date_is_null_when_no_first_reading_date_is_published(self):
        self.assertIsNone(bills.first_reading_date(item()))

    def test_date_uses_utc_calendar_date_for_official_timestamp(self):
        self.assertEqual(
            bills.first_reading_date(item(PassedSenateFirstReadingDateTime="2025-05-26T20:00:00-04:00")),
            "2025-05-27",
        )

    def test_reads_french_catalogue_total(self):
        with patch.object(bills, "fetch", return_value="<span>Résultats 1-60 de 201</span>".encode()):
            self.assertEqual(bills.page_total("45-1", "fr"), 201)

    def test_rejects_duplicate_and_wrong_session_rows(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            bills.validate_inventory_rows("45-1", "en", [item(), item()])

    def test_rejects_mismatched_language_inventories(self):
        with self.assertRaisesRegex(ValueError, "different bill inventories"):
            bills.build_records("45-1", {"en": [item()], "fr": [item("S-1")]})

    def test_rejects_incomplete_export_against_catalogue_result_total(self):
        data = [item()]
        with patch.object(bills, "source_inventory", side_effect=[data, data]), patch.object(
            bills, "page_total", side_effect=[2, 2]
        ):
            with self.assertRaisesRegex(ValueError, "do not match"):
                bills.acquire("45-1")

    def test_rejects_different_cutoffs_even_with_matching_bill_numbers(self):
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            bills.build_records("45-1", {"en": [item()], "fr": [item(status_en="Royal assent")]})
        with self.assertRaisesRegex(ValueError, "Unexpected session"):
            bills.validate_inventory_rows("45-1", "en", [item(SessionNumber=2)])

    def test_atomic_save_writes_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "catalogue.json"
            payload = {"session": "45-1", "collection": "bills", "records": []}
            bills.save_atomic(output, payload)
            self.assertEqual(json.loads(output.read_text()), payload)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
