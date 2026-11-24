import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SCRIPT = ROOT / "scripts" / "parliament-senate-votes.py"
SPEC = importlib.util.spec_from_file_location("parliament_senate_votes", SCRIPT)
senate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(senate)


def page(language="en", vote_id=702799, session="45-1", date="2026-06-18", title=None,
         counts=(58, 9, 1, 68), result=None):
    is_fr = language == "fr"
    title = title or ("Loi de mise en œuvre de la mise à jour économique du printemps 2026" if is_fr
                      else "Spring Economic Update 2026 Implementation Act")
    result = result or (("Adopté" if is_fr else "Adopted"))
    labels = ("Pour", "Contre", "Abstention") if is_fr else ("Yeas", "Nays", "Abstentions")
    path = "/fr/dans-la-chambre/votes/details" if is_fr else "/en/in-the-chamber/votes/details"
    return f"""<!doctype html><html><body>
      <h1>Votes - {session}</h1>
      <table id="votes-table"><thead><tr><th>Date</th><th>Title</th><th>Related Bill</th><th>Result</th></tr></thead>
      <tbody><tr><td><a href="/en/in-the-chamber/journals/">{date}</a></td>
      <td><a href="{path}/{vote_id}/{session}">{title}</a><div>{labels[0]}: {counts[0]} | {labels[1]}: {counts[1]} | {labels[2]}: {counts[2]} | Total: {counts[3]}</div></td>
      <td><a href="https://www.parl.ca/legisinfo">C-30</a></td><td>{result}</td></tr></tbody></table>
    </body></html>""".encode()


class SenateVotesTest(unittest.TestCase):
    def test_parses_official_bilingual_shape_and_numeric_ids(self):
        english = senate.parse_inventory(page(), "en", "45-1")
        french = senate.parse_inventory(page("fr"), "fr", "45-1")
        records = senate.combine_editions(english, french)
        self.assertEqual([record["key"] for record in records], ["702799", "702799"])
        self.assertEqual(records[0]["title"], "Spring Economic Update 2026 Implementation Act")
        self.assertEqual(records[0]["date"], "2026-06-18")
        self.assertEqual(records[0]["url"], "https://sencanada.ca/en/in-the-chamber/votes/details/702799/45-1")
        self.assertEqual(records[0]["details"], {
            "kind": "senate-vote", "result": "Adopted", "yeas": 58, "nays": 9, "abstentions": 1,
        })
        self.assertEqual(records[1]["details"]["result"], "Adopté")

    def test_rejects_truncated_empty_or_non_inventory_page(self):
        for data in (b"", b"<html><body>Votes - 45-1</body></html>"):
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, "contains no|truncated"):
                senate.parse_inventory(data, "en", "45-1")

    def test_rejects_data_row_without_official_detail_link(self):
        malformed = page().replace(b"/votes/details/702799/45-1", b"/votes/other/702799")
        with self.assertRaisesRegex(ValueError, "no vote detail link"):
            senate.parse_inventory(malformed, "en", "45-1")

    def test_rejects_incomplete_or_inconsistent_tallies_and_outcomes(self):
        with self.assertRaisesRegex(ValueError, "incomplete or malformed aggregate tallies"):
            senate.parse_inventory(page().replace(b"Abstentions: 1", b"Abstentions: unknown"), "en", "45-1")
        with self.assertRaisesRegex(ValueError, "do not sum"):
            senate.parse_inventory(page(counts=(58, 9, 1, 69)), "en", "45-1")
        with self.assertRaisesRegex(ValueError, "missing or ambiguous official outcome"):
            senate.parse_inventory(page(result="Pending"), "en", "45-1")

    def test_rejects_bilingual_inventory_tally_and_outcome_drift(self):
        en = senate.parse_inventory(page(), "en", "45-1")
        fr = senate.parse_inventory(page("fr", counts=(59, 9, 1, 69)), "fr", "45-1")
        with self.assertRaisesRegex(ValueError, "different aggregate tallies"):
            senate.combine_editions(en, fr)
        fr = senate.parse_inventory(page("fr", result="Rejeté"), "fr", "45-1")
        with self.assertRaisesRegex(ValueError, "different outcomes"):
            senate.combine_editions(en, fr)
        fr = senate.parse_inventory(page("fr", vote_id=702800), "fr", "45-1")
        with self.assertRaisesRegex(ValueError, "bilingual Senate vote mismatch"):
            senate.combine_editions(en, fr)

    def test_collect_fetches_both_languages_and_preserves_old_file_on_failure(self):
        def fetch(url):
            if "/fr/" in url:
                return page("fr", counts=(57, 9, 1, 67))
            return page()

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "senate-votes.json"
            output.write_text('{"old":true}\n')
            with self.assertRaisesRegex(ValueError, "different aggregate tallies"):
                senate.archive_inventory(output, "45-1", senate.collect, fetch)
            self.assertEqual(json.loads(output.read_text()), {"old": True})
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_atomic_save_writes_complete_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "senate-votes.json"
            payload = {"session": "45-1", "collection": "senate-votes", "records": []}
            senate.save_atomic(output, payload)
            self.assertEqual(json.loads(output.read_text()), payload)

    def test_archive_inventory_persists_both_source_pages_and_checked_packet(self):
        pages = {
            senate.index_url("en", "45-1"): page(),
            senate.index_url("fr", "45-1"): page("fr"),
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "senate-votes.json"
            payload = senate.archive_inventory(output, "45-1", senate.collect, pages.__getitem__)
            self.assertEqual(len(payload["sources"]), 2)
            self.assertEqual(json.loads(output.read_text()), payload)
            self.assertEqual(len(list((output.parent / "sources" / "objects").glob("*/*"))), 2)
            self.assertEqual(len(list((output.parent / "sources" / "inventories" / "senate-votes").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
