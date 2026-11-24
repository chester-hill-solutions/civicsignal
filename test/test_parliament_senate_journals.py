import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys_path = str(ROOT / "scripts")
import sys
sys.path.insert(0, sys_path)
SCRIPT = ROOT / "scripts" / "parliament-senate-journals.py"
SPEC = importlib.util.spec_from_file_location("parliament_senate_journals", SCRIPT)
senate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(senate)
FIXTURES = ROOT / "test" / "fixtures" / "senate-journals"


class SenateJournalsTest(unittest.TestCase):
    def test_index_parses_realistic_bilingual_paths_and_dates(self):
        en = senate.parse_index((FIXTURES / "index-en.html").read_bytes(), "en", "45-1")
        fr = senate.parse_index((FIXTURES / "index-fr.html").read_bytes(), "fr", "45-1")
        self.assertEqual(list(en), ["1", "2"])
        self.assertEqual(en["1"]["date"], "2025-05-26")
        self.assertEqual(fr["1"]["url"], "https://sencanada.ca/fr/content/sen/chamber/451/journals/001jr_2025-05-26-f")

    def test_issue_has_searchable_decision_passages_and_official_links(self):
        row = {"key": "1", "language": "en", "date": "2025-05-26",
               "url": "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e"}
        record = senate.parse_issue((FIXTURES / "issue-en.html").read_bytes(), row)
        self.assertEqual(record["details"]["kind"], "senate-journal")
        self.assertEqual(record["details"]["status"], "published")
        self.assertIn("adopted", record["summary"])
        bill_passage = next(p for p in record["details"]["passages"] if "C-1" in p["text"])
        self.assertEqual(bill_passage["links"], [
            {"label": "C-1", "url": "https://sencanada.ca/en/legisinfo/bill/45-1/c-1"}])

    def test_preserves_short_decisions_and_splits_long_source_text_without_loss(self):
        long_text = "Evidence " * 700
        html = (f"<!doctype html><html><head><title>Journals, Issue 1 (May 26, 2025)</title></head><body>"
                f"<div id='content-viewer-document'><h3>Government Bills</h3><p>Agreed.</p>"
                f"<p>{long_text}<a href='http://sencanada.ca/source'>official source</a></p></div></body></html>")
        row = {"key": "1", "language": "en", "date": "2025-05-26",
               "url": "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e"}
        record = senate.parse_issue(html, row)
        passages = record["details"]["passages"]
        self.assertEqual(passages[0]["text"], "Government Bills")
        self.assertEqual(passages[1]["text"], "Agreed.")
        long_passages = [p for p in passages if "Evidence" in p["text"] or "official source" in p["text"]]
        self.assertGreater(len(long_passages), 1)
        self.assertTrue("".join(p["text"] for p in long_passages).startswith("Evidence"))
        self.assertEqual(long_passages[-1]["links"], [{"label": "official source", "url": "http://sencanada.ca/source"}])

    def test_br_separates_senator_names_in_source_text(self):
        html = ("<!doctype html><html><head><title>Journals, Issue 1 (May 26, 2025)</title></head><body>"
                "<div id='content-viewer-document'><p><span class='spanMembersList'>Adler</span>"
                "<span class='spanMembersList'>Al Zaibak</span><br/>Arnold</p></div></body></html>")
        row = {"key": "1", "language": "en", "date": "2025-05-26",
               "url": "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e"}
        record = senate.parse_issue(html, row)
        self.assertEqual(record["details"]["passages"][0]["text"], "Adler Al Zaibak Arnold")

    def test_issue_identity_language_and_date_must_match_index(self):
        row = {"key": "1", "language": "en", "date": "2025-05-26",
               "url": "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e"}
        bad = (FIXTURES / "issue-en.html").read_bytes().replace(b"Issue 1", b"Issue 2")
        with self.assertRaisesRegex(ValueError, "does not identify issue"):
            senate.parse_issue(bad, row)

    def test_collect_makes_explicit_unavailable_entry_from_index_only(self):
        pages = {
            senate.index_url("en", "45-1"): (FIXTURES / "index-en.html").read_bytes(),
            senate.index_url("fr", "45-1"): (FIXTURES / "index-fr.html").read_bytes(),
            "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e": (FIXTURES / "issue-en.html").read_bytes(),
            "https://sencanada.ca/en/content/sen/chamber/451/journals/002jr_2025-05-27-e": (FIXTURES / "issue-en-2.html").read_bytes(),
            "https://sencanada.ca/fr/content/sen/chamber/451/journals/001jr_2025-05-26-f": (FIXTURES / "issue-fr.html").read_bytes(),
        }
        payload = senate.collect("45-1", pages.__getitem__)
        self.assertEqual(len(payload["records"]), 4)
        missing = next(row for row in payload["records"] if row["key"] == "2" and row["language"] == "fr")
        self.assertEqual(missing["details"]["status"], "unavailable")
        self.assertIn("index de session", missing["summary"])
        self.assertEqual(missing["details"]["passages"], [])

    def test_transient_or_parse_failure_does_not_silently_drop_issue(self):
        pages = {
            senate.index_url("en", "45-1"): (FIXTURES / "index-en.html").read_bytes(),
            senate.index_url("fr", "45-1"): (FIXTURES / "index-fr.html").read_bytes(),
        }
        with self.assertRaisesRegex(ValueError, "failed to acquire/parse"):
            senate.collect("45-1", pages.__getitem__)

    def test_archive_inventory_writes_complete_packet_and_source_archive(self):
        pages = {
            senate.index_url("en", "45-1"): (FIXTURES / "index-en.html").read_bytes(),
            senate.index_url("fr", "45-1"): (FIXTURES / "index-fr.html").read_bytes(),
            "https://sencanada.ca/en/content/sen/chamber/451/journals/001jr_2025-05-26-e": (FIXTURES / "issue-en.html").read_bytes(),
            "https://sencanada.ca/en/content/sen/chamber/451/journals/002jr_2025-05-27-e": (FIXTURES / "issue-en-2.html").read_bytes(),
            "https://sencanada.ca/fr/content/sen/chamber/451/journals/001jr_2025-05-26-f": (FIXTURES / "issue-fr.html").read_bytes(),
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "senate-journals.json"
            payload = senate.archive_inventory(output, "45-1", senate.collect, pages.__getitem__)
            self.assertEqual(payload["collection"], "senate-journals")
            self.assertEqual(len(payload["sources"]), 5)
            self.assertEqual(json.loads(output.read_text()), payload)
            self.assertEqual(len(list((output.parent / "sources" / "objects").glob("*/*"))), 5)


if __name__ == "__main__":
    unittest.main()
