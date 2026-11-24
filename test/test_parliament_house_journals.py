"""Replay and validation tests for the House Journals intake."""
import importlib.util
import json
from datetime import date
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "parliament-house-journals.py"
SPEC = importlib.util.spec_from_file_location("parliament_house_journals", SCRIPT)
journals = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(journals)


def calendar():
    return b"""<!doctype html><html><body><table class="publications-calendar">
      <tr><td class="chamber-meeting"><div class="2026-05-25"></div>
        <a href="/documentviewer/en/45-1/house/sitting-121/hansard" aria-label="May 25, 2026 House sitting day publication">Debates</a></td></tr>
      <tr><td class="chamber-meeting"><div class="2026-05-26"></div>
        <a href="/documentviewer/en/45-1/house/sitting-122/journals" aria-label="May 26, 2026 House sitting day publication">Journals</a></td></tr>
      <tr><td class="chamber-meeting"><div class="2026-11-24"></div>
        <a href="/documentviewer/en/45-1/house/sitting-171/order-notice" aria-label="November 24, 2026 House sitting day publication">Order Paper</a></td></tr>
    </table></body></html>"""


def journal(language="en", sitting="121", title=None, content=None):
    is_fr = language == "fr"
    title = title or (f"Journaux No. {sitting} - 25 mai 2026 (45-1) - Chambre des communes du Canada" if is_fr
                     else f"Journals No. {sitting} - May 25, 2026 (45-1) - House of Commons of Canada")
    if content is None:
        sentence = "La Chambre a adopté la motion." if is_fr else "The House adopted the motion."
        content = f'<p class="Para" lang="{language}">{sentence} Bill <a href="https://www.parl.ca/legisinfo/{language}/bill/45-1/c-1">C-1</a>, Division <a href="/DocumentViewer/{language}/45-1/house/sitting-{sitting}/journals#Division1">No. 1</a>.</p>'
    return f'''<!doctype html><html lang="{language}"><head><title>{title}</title></head><body>
      <section class="page-content"><a name="DOC--123"></a>
      <table class="Item" id="TABLE123"><tr><td class="Para">{content}</td></tr>
      <tr><td><table><tr><td>Nested publication structure</td></tr></table></td></tr>
      <tr><td class="DivisionNumber">(Division No. 1 -- Vote n<sup>o</sup> 1)</td></tr>
      <tr><td class="DivisionHeader" lang="{language}">{'POUR : 3, CONTRE : 2' if is_fr else 'YEAS: 3, NAYS: 2'}</td></tr></table>
      </section></body></html>'''.encode()


class HouseJournalsTest(unittest.TestCase):
    def test_calendar_reconciles_sitting_ids_and_excludes_future_entries(self):
        rows = journals.parse_calendar(calendar(), "45-1", date(2026, 11, 23))
        self.assertEqual(rows, [
            {"sitting": "121", "date": "2026-05-25"},
            {"sitting": "122", "date": "2026-05-26"},
        ])

    def test_extracts_official_proceeding_paragraph_and_bill_link(self):
        parsed = journals.parse_journal(journal(), "en", "121", "45-1")
        self.assertEqual(parsed["title"], "Journals No. 121 - May 25, 2026 (45-1) - House of Commons of Canada")
        self.assertEqual(parsed["passages"][0], {
            "text": "The House adopted the motion. Bill C-1, Division No. 1.",
            "url": "https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-121/journals#DOC--123",
            "links": [
                {"label": "C-1", "url": "https://www.parl.ca/legisinfo/en/bill/45-1/c-1"},
                {"label": "No. 1", "url": "https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-121/journals#Division1"},
            ],
        })
        self.assertEqual(parsed["passages"][1], {
            "text": "Division No. 1; Vote No. 1. YEAS: 3, NAYS: 2",
            "url": "https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-121/journals#DOC--123",
            "links": [{"label": "Recorded vote 1", "url": "https://www.ourcommons.ca/Members/en/votes/45/1/1"}],
        })
        french = journals.parse_journal(journal("fr"), "fr", "121", "45-1", "2026-05-25")
        self.assertEqual(french["passages"][1]["text"], "Division No. 1; Vote no 1. POUR : 3, CONTRE : 2")
        self.assertEqual(french["passages"][1]["links"][0]["url"], "https://www.ourcommons.ca/deputes/fr/votes/45/1/1")

    def test_collect_emits_both_languages_and_explicit_publisher_gap(self):
        data = {
            journals.calendar_url("45-1"): calendar(),
            ("121", "en"): journal(), ("121", "fr"): journal("fr"),
            ("122", "en"): journal(sitting="122", title="Journals No. 122 - May 26, 2026 (45-1) - House of Commons of Canada"),
        }

        def fetch(url):
            if url == journals.calendar_url("45-1"):
                return data[url]
            sitting = "121" if "sitting-121" in url or "seance-121" in url else "122"
            language = "fr" if "/fr/" in url else "en"
            try:
                return data[(sitting, language)]
            except KeyError as exc:
                raise journals.PublisherGap("official edition returned HTTP 404") from exc

        packet = journals.collect("45-1", fetch, through=date(2026, 11, 23), workers=2)
        self.assertEqual([(r["key"], r["language"]) for r in packet["records"]],
                         [("121", "en"), ("121", "fr"), ("122", "en"), ("122", "fr")])
        self.assertEqual([r["details"]["status"] for r in packet["records"]],
                         ["published", "published", "published", "unavailable"])
        self.assertEqual(packet["records"][3]["details"]["passages"], [])

    def test_rejects_truncated_wrong_language_and_non_journal_pages(self):
        with self.assertRaisesRegex(ValueError, "appears truncated"):
            journals.parse_journal(b"<html><title>Journals No. 1", "en", "1", "45-1")
        with self.assertRaisesRegex(ValueError, "wrong-language"):
            journals.parse_journal(journal("fr"), "en", "121", "45-1")
        wrong_issue = journal(title="Journals No. 122 - May 25, 2026 (45-1) - House of Commons of Canada")
        with self.assertRaisesRegex(ValueError, "does not identify sitting 121"):
            journals.parse_journal(wrong_issue, "en", "121", "45-1", "2026-05-25")
        wrong_date = journal(title="Journals No. 121 - May 26, 2026 (45-1) - House of Commons of Canada")
        with self.assertRaisesRegex(ValueError, "conflicts with calendar date"):
            journals.parse_journal(wrong_date, "en", "121", "45-1", "2026-05-25")
        wrong_session = journal(title="Journals No. 121 - May 25, 2026 (44-1) - House of Commons of Canada")
        with self.assertRaisesRegex(ValueError, "does not identify sitting 121 in session 45-1"):
            journals.parse_journal(wrong_session, "en", "121", "45-1")
        with self.assertRaisesRegex(ValueError, "no proceedings paragraphs"):
            journals.parse_journal(journal(content="<p class=\"Para\"> </p>"), "en", "121", "45-1")

    def test_transient_failure_preserves_previous_packet_and_replay_is_stable(self):
        previous = {"old": True}

        def failing_fetch(_url):
            raise RuntimeError("temporary network failure")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "house-journals.json"
            output.write_text(json.dumps(previous))
            with self.assertRaisesRegex(RuntimeError, "temporary network failure"):
                journals.archive_inventory(output, "45-1", journals.collect, failing_fetch)
            self.assertEqual(json.loads(output.read_text()), previous)
            self.assertEqual(list(Path(directory).rglob("*.tmp")), [])

        data = {journals.calendar_url("45-1"): calendar(),
                "121-en": journal(), "121-fr": journal("fr"),
                "122-en": journal(sitting="122", title="Journals No. 122 - May 26, 2026 (45-1) - House of Commons of Canada")}

        def replay_fetch(url):
            if url == journals.calendar_url("45-1"):
                return data[url]
            sitting = "121" if "121" in url else "122"
            language = "fr" if "/fr/" in url else "en"
            if f"{sitting}-{language}" not in data:
                raise journals.PublisherGap("official edition returned HTTP 404")
            return data[f"{sitting}-{language}"]

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "house-journals.json"
            first = journals.archive_inventory(output, "45-1", journals.collect,
                lambda url: replay_fetch(url))
            # Refreshing inventories should retain the same reconciled record rows.
            second = journals.archive_inventory(output, "45-1", journals.collect,
                lambda url: replay_fetch(url))
            self.assertEqual(first["records"], second["records"])
            self.assertEqual(json.loads(output.read_text())["records"], first["records"])


if __name__ == "__main__":
    unittest.main()
