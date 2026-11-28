"""Verify the House agenda collector's archive and edition checks."""

from email.message import Message
from functools import partial
from hashlib import sha256
from html import escape
import importlib.util
from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch
from urllib.parse import urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "parliament-house-agenda.py"
SPEC = importlib.util.spec_from_file_location("parliament_house_agenda", SCRIPT)
agenda = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agenda)

SESSION = "45-1"
EN_TOC = agenda.edition_url(SESSION, "175", "en")
FR_TOC = agenda.edition_url(SESSION, "175", "fr")
BILL = ("C-31 — Third reading (deferred recorded division on the amendment)",
        "C-31 — Troisième lecture (vote par appel nominal différé sur l’amendement)")


def page(language, body, *, sitting="175", day="2026-11-30", doc_id="14383628",
         projected=False, view_path=""):
    label = (agenda.PROJECTED_TITLES if projected else agenda.PAPER_TITLES)[language]
    view = f'<a class="user-guide" href="{view_path}?col=2">Bilingual</a>' if view_path else ""
    return f"""<html lang="{language}"><head><title>{escape(label)}</title>
      <meta name="Language" content="{language}"><meta name="Parliament" content="45">
      <meta name="Session" content="1"><meta name="MeetingDate" content="{day}">
      <meta name="DocumentId" content="{doc_id}"><meta name="DocumentTitle" content="{escape(label)} - {sitting}">
      </head><body>{view}<div class="publication-container-content">{body}</div></body></html>""".encode()


def project(language):
    return page(language, f"<table><tr><td>3:00 p.m.</td><td>15 heures</td></tr>"
                f"<tr><td>{BILL[0]}</td><td>{BILL[1]}</td></tr>"
                "<tr><td>C-1 — Unmatched number</td><td>Sans numéro</td></tr></table>",
                sitting="176", day="2026-12-01", doc_id="14389157", projected=True)


def question_rows(language, questions, notice_date):
    path = agenda.QUESTION_PATHS[language]
    tables = ['<table><tr><td><h3 class="NoticePaperRubricTitle">Questions</h3></td></tr></table>']
    for publisher_id, number, anchor in questions:
        tables.append(f'<a name="{anchor}"></a><table><tr><td class="ItemPara">'
                      f'<b><a href="/{path}/{publisher_id}">{number}</a><sup>2</sup></b>'
                      f' — {notice_date} — Member — Question text.</td></tr></table>')
    return "".join(tables)


def add_previous_fixture(pages):
    for language, current_url in zip(agenda.LANGUAGES, (EN_TOC, FR_TOC), strict=True):
        prior_url = agenda.edition_url(SESSION, "174", language)
        current_path = urlsplit(current_url).path
        prior_path = urlsplit(prior_url).path
        previous_link = f'<a id="publication-selector-previous-day" href="{prior_path}">Previous</a>'
        pages[current_url] = pages[current_url].replace(b"<body>", f"<body>{previous_link}".encode())
        pages[prior_url] = (pages[current_url].replace(previous_link.encode(), b"")
                            .replace(current_path.encode(), prior_path.encode())
                            .replace(b"2026-11-30", b"2026-11-27")
                            .replace(b"14383628", b"14375777").replace(b" - 175", b" - 174"))
        day = "November 26, 2026" if language == "en" else "26 novembre 2026"
        repeated_question = ("14382002", "Q-1747", "DOC--17400000-0000-0000-0000-000000000000")
        pages[prior_url + "/page-11"] = page(language, question_rows(language, [repeated_question], day),
                                               sitting="174", day="2026-11-27", doc_id="14375777",
                                               view_path=prior_path + "/page-11")


def fixture():
    pages = {}
    for language, url in zip(agenda.LANGUAGES, (EN_TOC, FR_TOC), strict=True):
        path = urlsplit(url).path
        order_title, notice_title = agenda.SECTIONS[language]
        toc = (f'<a class="DefaultTableOfContentsSectionLink" href="{path}/page-4">{order_title}</a>'
               f'<a class="DefaultTableOfContentsFile Link" href="{path}/page-4">First subsection</a>'
               f'<a class="DefaultTableOfContentsSectionLink" href="{path}/page-11">{notice_title}</a>')
        pages[url] = page(language, toc)
        pages[agenda.BASE + "/documentviewer/" + agenda.LATEST_PATHS[language]] = pages[url]
        pages[url + "/page-4"] = page(language, f"<h1>{order_title}</h1>", view_path=path + "/page-4")
        day = "November 27, 2026" if language == "en" else "27 novembre 2026"
        questions = [
            ("14382002", "Q-1747", "DOC--17500000-0000-0000-0000-000000000000"),
            ("14384623", "Q-1748", "DOC--461f358d-825c-45d9-87b7-a059a41972f8"),
        ]
        pages[url + "/page-11"] = page(language, f"<h1>{notice_title}</h1>" + question_rows(language, questions, day),
                                         view_path=path + "/page-11")
        pages[agenda.PROJECTED_PATHS[language].format(session=SESSION)] = project(language)
    return pages


class HouseAgendaTest(unittest.TestCase):
    def test_fetch_retries_transient_errors_and_stops_on_a_publisher_denial(self):
        headers = Message()
        headers["Content-Type"] = "text/html"
        headers["Retry-After"] = "2"
        body = MagicMock(status=200, headers=headers)
        body.__enter__.return_value = body
        body.read.return_value = b"<html></html>"
        unavailable = agenda.HTTPError(EN_TOC, 503, "Unavailable", headers, BytesIO())
        denied = agenda.HTTPError(EN_TOC, 403, "Forbidden", headers, BytesIO())
        with patch.object(agenda, "build_opener") as build, patch.object(agenda.time, "sleep") as sleep:
            opener = build.return_value
            opener.open.side_effect = [TimeoutError(), unavailable, body, denied]
            self.assertEqual(agenda.fetch_url(EN_TOC), b"<html></html>")
            self.assertEqual(sleep.call_args_list, [call(0.5), call(2)])
            with self.assertRaisesRegex(agenda.HTTPError, "403"):
                agenda.fetch_url(EN_TOC)
            self.assertEqual(opener.open.call_count, 4)

    def test_latest_archives_bilingual_papers_and_independent_projected_sitting(self):
        pages = fixture()
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "latest.json"
            archive = partial(agenda.archive_inventory, output, SESSION,
                              partial(agenda.collect, sitting=None), pages.__getitem__)
            packet = archive()
            self.assertEqual(packet["collection"], "house-agenda")
            self.assertEqual(len(packet["sources"]), 10)
            self.assertNotIn("writtenQuestionNoticeComparison", packet)
            self.assertEqual([record["key"] for record in packet["records"]], [
                "45-1:175:contents:en", "45-1:175:listed:en:4", "45-1:175:noticed:en:11",
                "45-1:175:contents:fr", "45-1:175:listed:fr:4", "45-1:175:noticed:fr:11",
                "45-1:176:projected:en", "45-1:176:projected:fr",
            ])
            self.assertEqual(packet["records"][1]["title"], "First subsection")
            self.assertEqual(packet["records"][2]["sourceUrl"], EN_TOC + "/page-11")
            for row, text in zip(packet["records"][-2:], BILL, strict=True):
                self.assertEqual(row["date"], "2026-12-01")
                self.assertEqual(row["details"]["billItems"], [{"billNumber": "C-31", "text": text}])
            for source in packet["sources"]:
                digest = source["sha256"]
                archived = output.parent / "sources" / "objects" / digest[:2] / digest
                self.assertEqual(archived.read_bytes(), pages[source["url"]])
                self.assertEqual(sha256(archived.read_bytes()).hexdigest(), digest)
            self.assertEqual(archive()["records"], packet["records"])

    def test_compares_publisher_previous_issue_with_bilingual_stable_question_ids(self):
        pages = fixture()
        add_previous_fixture(pages)
        packet = agenda.collect(SESSION, pages.__getitem__, sitting="175")
        self.assertEqual([item["questionNumber"] for item in packet["records"][2]["details"]["writtenQuestionNotices"]],
                         ["Q-1747", "Q-1748"])
        question = packet["records"][2]["details"]["writtenQuestionNotices"][1]
        self.assertEqual(question["questionUrl"], agenda.BASE + "/written-questions/14384623")
        self.assertEqual(packet["writtenQuestionNoticeComparison"], {
            "previousSitting": "174", "previousSittingDate": "2026-11-27",
            "sitting": "175", "sittingDate": "2026-11-30",
            "newlyNoticed": [{"publisherQuestionId": "14384623", "questionNumber": "Q-1748",
                              "noticeDate": "2026-11-27", "citations": {
                                  "en": EN_TOC + "/page-11#DOC--461f358d-825c-45d9-87b7-a059a41972f8",
                                  "fr": FR_TOC + "/page-11#DOC--461f358d-825c-45d9-87b7-a059a41972f8",
                              }}],
        })

    def test_rejects_notice_date_or_previous_link_disagreement(self):
        pages = fixture()
        french_notice = FR_TOC + "/page-11"
        pages[french_notice] = pages[french_notice].replace(b"27 novembre", b"28 novembre")
        with self.assertRaisesRegex(ValueError, "notices differ across languages"):
            agenda.collect(SESSION, pages.__getitem__, sitting="175")
        pages = fixture()
        add_previous_fixture(pages)
        pages[FR_TOC] = pages[FR_TOC].replace(b"seance-174", b"seance-173")
        with self.assertRaisesRegex(ValueError, "previous edition links disagree"):
            agenda.collect(SESSION, pages.__getitem__, sitting="175")

    def test_incomplete_section_preserves_last_good_manifest(self):
        pages = fixture()
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "latest.json"
            archive = partial(agenda.archive_inventory, output, SESSION,
                              partial(agenda.collect, sitting="175"), pages.__getitem__)
            packet = archive()
            self.assertEqual(len(packet["sources"]), 8)
            good_bytes = output.read_bytes()
            pages[FR_TOC + "/page-11"] = pages[FR_TOC + "/page-4"]
            with self.assertRaisesRegex(ValueError, "section differs"):
                archive()
            self.assertEqual(output.read_bytes(), good_bytes)

    def test_rejects_official_toc_link_outside_the_requested_edition(self):
        pages = fixture()
        pages[EN_TOC] = pages[EN_TOC].replace(b"/sitting-175/", b"/sitting-176/")
        with self.assertRaisesRegex(ValueError, "leaves the official edition"):
            agenda.collect(SESSION, pages.__getitem__, sitting="175")

    def test_rejects_different_bilingual_toc_sections(self):
        pages = fixture()
        pages[FR_TOC] = pages[FR_TOC].replace(b"/page-11", b"/page-12")
        with self.assertRaisesRegex(ValueError, "papers differ across languages"):
            agenda.collect(SESSION, pages.__getitem__, sitting="175")

    def test_rejects_mismatched_latest_alias_and_truncated_projected_page(self):
        pages = fixture()
        french_alias = agenda.BASE + "/documentviewer/" + agenda.LATEST_PATHS["fr"]
        pages[french_alias] = pages[french_alias].replace(b"14383628", b"14383629")
        with self.assertRaisesRegex(ValueError, "aliases disagree"):
            agenda.collect(SESSION, pages.__getitem__, sitting=None)
        projected = agenda.PROJECTED_PATHS["fr"].format(session=SESSION)
        pages[projected] = re.sub(rb"</html>$", b"", pages[projected])
        with self.assertRaisesRegex(ValueError, "empty or incomplete"):
            agenda.collect(SESSION, pages.__getitem__, sitting="175")


if __name__ == "__main__":
    unittest.main()
