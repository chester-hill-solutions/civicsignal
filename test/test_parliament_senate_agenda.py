import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("parliament_senate_agenda", SCRIPTS / "parliament-senate-agenda.py")
agenda = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agenda)
SESSION = "45-1"
PDF = b"%PDF-1.7\n%%EOF\n"


def page(language, title, markup):
    return f'<html lang="{language}"><head><title>{title}</title></head><body>{markup}</body></html>'.encode()


def paths(number, day, language):
    basename = f"{number:03d}op_2026-12-{day:02d}"
    return (f"/{language}/content/sen/chamber/451/orderpaper/{basename}-{language[0]}",
            f"/content/sen/chamber/451/orderpaper/pdf/{basename}.pdf")


def issue_html(language, number, day, motion, pdf_path):
    if language == "en":
        title = f"Order Paper and Notice Paper, Issue {number} (December {day}, 2026)"
        sections = "Notice Paper", "Inquiries", "Written Questions"
        marker, item_text = "No.", "Example text"
        orders, government, other = "Orders of the Day", "Government Business", "Other Business"
        bills, bill, empty = "Bills – Second Reading", "Bill", "Nil"
        future = "For Thursday, December 10, 2026"
    else:
        title = f"Feuilleton et Feuilleton des préavis No. {number} (Le {day} décembre 2026)"
        sections = "Feuilleton des préavis", "Interpellations", "Questions écrites"
        marker, item_text = "N<sup>o</sup>", "Texte d’exemple"
        orders, government, other = "Ordre du jour", "Affaires du gouvernement", "Autres affaires"
        bills, bill, empty = "Projets de loi – Deuxième lecture", "projet de loi", "Aucun"
        future = "Pour le jeudi 10 décembre 2026"
    notice, inquiries, questions = sections
    return page(language, title, f"""
        <a href="{pdf_path}">PDF</a>
        <div id="content-viewer-document">
          <a id="orders"></a><h1>{orders}</h1>
          <h2>{government}</h2><h3>{bills}</h3>
          <p><span class="OrderNumber">{marker} 1.</span></p><p>{bill} S-{number}.</p>
          <h3>Motions</h3>
          <p><span class="OrderNumber">{marker} 3.</span></p><p>{item_text} government.</p>
          <h2>{other}</h2><h3>Motions</h3>
          <p><span class="OrderFutureDate">{future}</span></p>
          <p><span class="OrderNumber">{marker} 3.</span><span class="OrderDays"> (one)</span></p>
          <p>{item_text} other.</p>
          <h3>{inquiries}</h3><p>{empty}</p>
          <a id="notice"></a><h1>{notice}</h1><h2>Motions</h2>
          <p><span class="OrderNumber">{marker} {motion}.</span></p>
          <p>{item_text} <em>one.</em></p><p>{item_text} two.</p>
          <h2>{inquiries}</h2>
          <p><span class="OrderNumber">{marker} 7.</span><span class="OrderDays"> (one)</span></p>
          <p>{item_text}.</p>
          <a id="questions"></a><h2>{questions}</h2>
          <p><span class="OrderNumber">{marker} 7.</span></p><p>{item_text}.</p>
        </div>
    """)


def sources(numbers=(21, 22)):
    pages = {}
    for language in agenda.INDEX:
        links = []
        for day, number in enumerate(numbers, 2):
            issue_path, pdf_path = paths(number, day, language)
            links.append('<a href="' + issue_path.replace("/content/", "\\content\\") + '">Issue</a>')
            pages[agenda.BASE + issue_path] = issue_html(language, number, day, number, pdf_path)
            pages[agenda.BASE + pdf_path] = PDF
        pages[agenda.index_url(SESSION, language)] = page(language, f"Publisher calendar - {SESSION}", "".join(links))
    return pages


class SenateAgendaTest(unittest.TestCase):
    def test_publishes_bilingual_editions_and_observed_notice_difference(self):
        result = agenda.collect(SESSION, sources().__getitem__)
        self.assertEqual(result["session"], SESSION)
        self.assertEqual(result["discoveredIssues"], 2)
        self.assertEqual([(row["issue"], row["language"]) for row in result["records"]],
                         [(21, "en"), (21, "fr"), (22, "en"), (22, "fr")])
        self.assertEqual(result["noticeChanges"], [
            {"previousIssue": 21, "issue": 22, "added": ["motion:22"], "removed": ["motion:21"]},
        ])
        english, french = result["records"][-2:]
        self.assertEqual(french["pdfUrl"], english["pdfUrl"])
        self.assertEqual(english["date"], "2026-12-03")
        self.assertTrue(result["observedAt"].endswith("Z"))
        self.assertEqual(french["items"][0]["paragraphs"], ["Texte d’exemple one.", "Texte d’exemple two."])
        self.assertEqual(french["items"][0]["url"], french["url"] + "#notice")
        self.assertEqual([(item["key"], item["status"]) for item in french["items"]],
                         [("motion:22", "noticed"), ("inquiry:7", "noticed"), ("question:7", "listed")])

    def test_orders_preserve_group_scoped_keys_and_compare_explicit_bill_and_future_dates(self):
        result = agenda.collect(SESSION, sources().__getitem__)
        first, _, english, french = result["records"]
        keys = ["orders:government:bills-second-reading:1", "orders:government:motions:3", "orders:other:motions:3"]
        self.assertEqual([order["key"] for order in english["orders"]], keys)
        self.assertEqual([order["key"] for order in french["orders"]], keys)
        self.assertEqual(first["orders"][0]["billNumbers"], ["S-21"])
        self.assertEqual(english["orders"][0]["billNumbers"], ["S-22"])
        self.assertEqual(french["orders"][0]["heading"], "Projets de loi – Deuxième lecture")
        self.assertEqual(french["orders"][0]["paragraphs"], ["projet de loi S-22."])
        self.assertEqual(english["orderCategories"]["other:inquiries"], "empty")
        self.assertEqual(english["orders"][2]["orderDaysLabel"], "(one)")
        self.assertEqual(english["orders"][2]["futureSittingDate"], "2026-12-10")
        self.assertEqual(french["orders"][2]["futureSittingDate"], "2026-12-10")
        self.assertEqual(french["orders"][2]["futureSittingLabel"], "Pour le jeudi 10 décembre 2026")
        self.assertNotIn("futureSittingDate", french["orders"][1])
        self.assertEqual(french["orders"][2]["status"], "listed")
        self.assertEqual(french["orders"][2]["url"], french["url"] + "#orders")

    def test_records_unlisted_issue_without_comparing_nonconsecutive_editions(self):
        result = agenda.collect(SESSION, sources((1, 3)).__getitem__)
        self.assertEqual(result["unlistedIssueNumbers"], [2])
        self.assertEqual(result["noticeChanges"], [])
        self.assertEqual([row["issue"] for row in result["records"]], [1, 1, 3, 3])

    def test_archive_keeps_last_good_after_incomplete_or_mismatched_source(self):
        pages = sources()
        french_issue = agenda.BASE + paths(22, 3, "fr")[0]
        original = pages[french_issue]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "senate-agenda.json"
            result = agenda.archive_inventory(output, SESSION, agenda.collect, pages.__getitem__)
            self.assertEqual(len(result["sources"]), 8)
            self.assertEqual(json.loads(output.read_text()), result)
            previous = output.read_bytes()
            bad_editions = [
                (original.replace(b'</html>', b''), "Incomplete"),
                (original.replace(b'22.</span>', b'23.</span>'), "mismatched bilingual item"),
                (original.replace(b'No. 22', b'No. 29'), "Wrong title"),
                (original.replace(b'022op_2026-12-03.pdf', b'023op_2026-12-03.pdf'), "Incorrect bilingual Senate agenda PDF"),
                (original.replace(b'S-22.', b'C-22.'), "mismatched bilingual Orders"),
                (original.replace(b'jeudi 10', b'vendredi 11'), "mismatched bilingual Orders"),
                (original.replace(b'jeudi 10', b'lundi 10'), "Invalid future sitting date"),
                (original.replace(b'<h3>Interpellations</h3><p>Aucun</p>', b''), "mismatched bilingual Orders"),
                (original.replace(b'<h3>Interpellations</h3><p>Aucun</p>', b'<h3>Interpellations</h3>'),
                 "Incomplete Senate order categories"),
                (original.replace(b'<p><span class="OrderNumber">N<sup>o</sup> 3.</span></p>',
                                  b'<p><span class="OrderNumber">N<sup>o</sup> 3.</span></p>' * 2, 1),
                 "Conflicting Senate order item"),
                (original.replace(b'<h3>Motions</h3>', b'<h3>New schema</h3>', 1), "Unexpected Senate order category"),
            ]
            for bad, message in bad_editions:
                with self.subTest(message=message):
                    pages[french_issue] = bad
                    with self.assertRaisesRegex(ValueError, message):
                        agenda.archive_inventory(output, SESSION, agenda.collect, pages.__getitem__)
                    self.assertEqual(output.read_bytes(), previous)

    def test_validates_language_index_and_requested_issue(self):
        pages = sources()
        with self.assertRaisesRegex(ValueError, "absent from the official indexes"):
            agenda.collect(SESSION, pages.__getitem__, requested_issues=(24,))
        francais = agenda.index_url(SESSION, "fr")
        pages[francais] = pages[francais].replace(b'022op_2026-12-03-f', b'023op_2026-12-03-f')
        with self.assertRaisesRegex(ValueError, "indexes disagree"):
            agenda.collect(SESSION, pages.__getitem__)

    def test_rejects_cross_publisher_redirect_and_bounds_response(self):
        url = agenda.index_url(SESSION, "en")
        request = agenda.Request(url)
        redirect = agenda.SenateRedirect()
        with self.assertRaisesRegex(ValueError, "Unexpected Senate publication link"):
            redirect.redirect_request(request, None, 302, "Found", {}, "https://outside.example/issue")
        alias = url.replace("sencanada.ca", "www.sencanada.ca") + "/"
        self.assertEqual(redirect.redirect_request(request, None, 302, "Found", {}, alias).full_url, alias)
        with patch.object(agenda, "build_opener") as build_opener:
            response = build_opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.side_effect = bytes
            with self.assertRaisesRegex(ValueError, "response exceeds"):
                agenda.fetch_url(url)
            response.read.assert_called_once_with(8 * 1024 * 1024 + 1)


if __name__ == "__main__":
    unittest.main()
