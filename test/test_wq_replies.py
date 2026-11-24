import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.lib.wq_replies import acquire_written_question_replies


class ReplyBytes(bytes):
    def __new__(cls, body: bytes, headers=None, status=200):
        value = super().__new__(cls, body)
        value.headers = headers or {}
        value.status = status
        return value


class WrittenQuestionRepliesTest(unittest.TestCase):
    def test_recent_response_fragments_and_pdf_attachment(self):
        shell_url = "https://www.ourcommons.ca/written-questions/45-1/q-1010/14112405"
        api_base = "https://www.ourcommons.ca/written-questions/45-1/q-1010"
        sections_url = api_base + "/ajax/14112405/sections"
        main_url = api_base + "/ajax/14112405/isc/file-content?part=isc-main"
        tail_url = api_base + "/ajax/14112405/isc/file-content?part=isc-1.2"
        cover_url = api_base + "/ajax/14112405/cov/file-content?part=cov-main"
        attachment_url = "https://www.ourcommons.ca/Content/ParliamentaryBusiness/WrittenQuestions/answer.pdf"
        annex_url = "https://www.ourcommons.ca/Content/ParliamentaryBusiness/WrittenQuestions/annex.html"
        remote_attachment_url = "https://www.canada.ca/content/dam/report.pdf"
        shell = b'<html><div data-government-response-id="14112405"></div></html>'
        sections = b'<div id="government-response-sections-container"><a data-section-code="ISC">Indigenous Services Canada</a><a data-section-code="cov">Cover page</a></div>'
        main = (b'<div>Overview for the response.</div><a href="/Content/ParliamentaryBusiness/WrittenQuestions/answer.pdf">PDF annex</a>'
                b'<a href="/Content/ParliamentaryBusiness/WrittenQuestions/annex.html">HTML annex</a>'
                b'<a href="/written-questions/about">House info link</a>'
                b'<a href="https://otc-cta.gc.ca/eng/publication/annual-report-2023-2024">Citation</a>'
                b'<a href="https://www.canada.ca/en/services.html">Guidance</a>'
                b'<a href="https://www.canada.ca/content/dam/recommendations.pdf">one of the recommendations</a>')
        main = main.replace(b"<a href=\"https://otc", b"<a href=\"https://www.canada.ca/content/dam/report.pdf\">Download annex</a><a href=\"https://otc")
        tail = b'<table><tr><td>Community</td><td>Funding</td></tr><tr><td>Cat Lake</td><td>$4</td></tr></table>'
        cover_html = b'<div>Sessional paper cover</div><img src="/written-questions/images/HoC-Emblem-colour.png">'
        pdf = b"%PDF-1.7\nnot-a-real-pdf"
        calls = []

        def get(url):
            calls.append(url)
            if url == shell_url: return ReplyBytes(shell)
            if url == sections_url: return ReplyBytes(sections)
            if url == main_url: return ReplyBytes(main, {"X-HtmlFragments-Keys": "isc-1.1,isc-1.2"})
            if url == tail_url: return ReplyBytes(tail)
            if url == cover_url: return ReplyBytes(cover_html, {"X-HtmlFragments-Keys": "cov-main"})
            if url == attachment_url: return ReplyBytes(pdf, {"Content-Type": "application/pdf"})
            if url == annex_url: return ReplyBytes(b"<html><body><p>Additional annex detail.</p></body></html>", {"Content-Type": "text/html"})
            if url == remote_attachment_url: return ReplyBytes(pdf, {"Content-Type": "application/pdf"})
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": "Q-1010", "session": "45-1", "language": "en",
                "responses": [{"id": 14112405, "sessionalPaperNumber": "8555-451-1010"}]}, get, Path(temp) / "objects")
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["responses"][0]["availability"], "published_text")
            reply_docs = [doc for doc in result["documents"] if doc["kind"] in ("reply", "cover_page")]
            self.assertEqual(len(reply_docs), 3)
            self.assertIn("Cat Lake", "\n".join(doc["text"] for doc in reply_docs))
            substantive = next(doc for doc in reply_docs if doc["kind"] == "reply")
            self.assertEqual(substantive["fragment_key"], "isc-1.1")
            self.assertIn("?section=isc", substantive["url"])
            self.assertIn("/ajax/", substantive["acquisition_url"])
            cover = next(doc for doc in reply_docs if doc["kind"] == "cover_page")
            self.assertEqual(cover["section_role"], "cover_page")
            attachments = [doc for doc in result["documents"] if doc["kind"] == "attachment"]
            self.assertEqual(len(attachments), 3)
            self.assertEqual({doc["availability"] for doc in attachments}, {"stored", "searchable"})
            self.assertTrue(all((Path(temp) / "objects" / doc["object_sha256"]).exists() for doc in attachments))
            self.assertIn("Additional annex detail.", next(doc["text"] for doc in attachments if doc["url"] == annex_url))
            self.assertNotIn("/written-questions/about", calls)
            self.assertNotIn("https://otc-cta.gc.ca/eng/publication/annual-report-2023-2024", calls)
            self.assertNotIn("https://www.canada.ca/en/services.html", calls)
            self.assertNotIn("https://www.canada.ca/content/dam/recommendations.pdf", calls)
            self.assertIn("https://otc-cta.gc.ca/eng/publication/annual-report-2023-2024", [r["url"] for r in result["references"]])
            self.assertIn("https://www.canada.ca/content/dam/recommendations.pdf", [r["url"] for r in result["documents"][0].get("outbound_references",[]) + result["references"]])
            self.assertEqual(calls[0], shell_url)

    def test_published_response_with_missing_section_manifest_is_a_gap(self):
        shell_url = "https://www.ourcommons.ca/written-questions/42-1/q-1/77001"
        sections_url = "https://www.ourcommons.ca/written-questions/42-1/q-1/ajax/77001/sections"
        shell = b'<html><div data-government-response-id="77001"></div></html>'

        def get(url):
            if url == shell_url: return ReplyBytes(shell)
            if url == sections_url: return ReplyBytes(b"", status=404)
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 1, "session": "42-1", "language": "en",
                "responses": [{"id": "77001"}]}, get, Path(temp) / "objects")
        self.assertIn("response_77001_sections_404", result["errors"])
        self.assertEqual(result["documents"], [])
        self.assertEqual(result["responses"][0]["availability"], "section_list_unavailable")

    def test_host_404_shell_is_never_extracted_as_reply(self):
        def get(_url):
            return ReplyBytes(b"<html><head><title>404 Page Not Found</title></head></html>")

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 9, "session": "44-1", "language": "fr",
                "responses": [{"id": "88000"}]}, get, Path(temp) / "objects")
        self.assertEqual(result["documents"], [])
        self.assertEqual(result["responses"][0]["availability"], "unavailable")

    def test_legacy_sessional_paper_is_preserved_as_archive_reference(self):
        def unexpected(_url, headers=None):
            raise AssertionError("legacy paper references use the archive acquisition path")

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 1, "session": "45-1", "language": "en",
                "responses": [{"type": "sessional_paper", "id": "9056516", "sessionalPaperId": "9056516",
                               "eventId": "9627520", "sessionalPaperNumber": "8555-421-1010",
                               "url": "https://parl-gc.primo.exlibrisgroup.com/discovery/search?query=x"}]},
                               unexpected, Path(temp) / "objects")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["documents"], [])
        self.assertEqual(result["responses"][0]["availability"], "archived_reference")
        self.assertEqual(result["responses"][0]["event_id"], "9627520")

    def test_debates_response_extracts_one_question_and_answer(self):
        url = "https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-21/hansard#:~:text=Question%20No.%203"
        source = (b"<html><body><p>Question No. 2--Previous:</p><p>Old text</p>"
                  b"<p>Question No. 3--Dan Muys:</p><p>Question text only.</p>"
                  b"<p>Mike Kelloway (Parliamentary Secretary):</p><p>Mr. Speaker, answer text.</p>"
                  b"<p>Question No. 4--Next:</p><p>Do not include this response.</p></body></html>")

        def get(request_url, headers=None):
            self.assertEqual(request_url, url.split("#", 1)[0])
            return ReplyBytes(source, {"Content-Type": "text/html"})

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 3, "session": "45-1", "language": "en",
                "responses": [{"id": 13116915, "eventId": 13116915, "type": "debates", "url": url}]},
                get, Path(temp) / "objects")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["responses"][0]["availability"], "published_text")
        self.assertEqual(len(result["documents"]), 1)
        self.assertIn("answer text", result["documents"][0]["text"])
        self.assertNotIn("Question text only", result["documents"][0]["text"])
        self.assertNotIn("Do not include", result["documents"][0]["text"])

    def test_french_hansard_speaker_line_allows_nested_roles(self):
        source = ("<html><body><p>Question no 41 — Luc Berthold:</p><p>Question text.</p>"
                  "<p>L’hon. Buckley Belanger (secrétaire d’État (Développement rural), Lib.):</p>"
                  "<p>Monsieur le Président, réponse en français.</p>"
                  "<p>Question no 42 — Luc Berthold:</p><p>Next answer.</p></body></html>").encode()
        url = "https://www.noscommunes.ca/DocumentViewer/fr/45-1/chambre/seance-21/debats"

        def get(request_url, headers=None):
            self.assertEqual(request_url, url)
            return ReplyBytes(source, {"Content-Type": "text/html"})

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 41, "session": "45-1", "language": "fr",
                "responses": [{"id": 13116958, "type": "debates", "url": url}]}, get, Path(temp) / "objects")
        self.assertEqual(result["errors"], [])
        self.assertIn("L’hon. Buckley Belanger", result["documents"][0]["text"])
        self.assertIn("réponse en français", result["documents"][0]["text"])
        self.assertNotIn("Question text.", result["documents"][0]["text"])
        self.assertNotIn("Next answer", result["documents"][0]["text"])

    def test_one_respondent_404_keeps_multi_section_edition_in_gap(self):
        shell_url = "https://www.ourcommons.ca/written-questions/45-1/q-7/70001"
        api_base = "https://www.ourcommons.ca/written-questions/45-1/q-7"
        sections_url = api_base + "/ajax/70001/sections"
        first_url = api_base + "/ajax/70001/one/file-content?part=one-main"
        second_url = api_base + "/ajax/70001/two/file-content?part=two-main"
        shell = b'<html><div data-government-response-id="70001"></div><meta name="request-verification-token" content="abc"></html>'

        def get(url, headers=None):
            if url == shell_url: return ReplyBytes(shell)
            if url == sections_url: return ReplyBytes(b'<a data-section-code="one">Department One</a><a data-section-code="two">Department Two</a>')
            if url == first_url:
                self.assertEqual(headers, {"RequestVerificationToken": "abc"})
                return ReplyBytes(b"Department One answer.", {"X-HtmlFragments-Keys": "one-main"})
            if url == second_url:
                return ReplyBytes(b"", status=404)
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 7, "session": "45-1", "language": "en",
                "responses": [{"id": 70001}]}, get, Path(temp) / "objects")
        self.assertIn("response_70001_section_two_main_404", result["errors"])
        self.assertEqual(result["responses"][0]["availability"], "published_text")
        self.assertEqual(len(result["documents"]), 1)
        self.assertEqual(result["documents"][0]["respondent"], "Department One")

    def test_relative_workbook_uses_detail_page_base_and_preserves_404_gap(self):
        shell_url = "https://www.ourcommons.ca/written-questions/45-1/q-338/13716811"
        api_base = "https://www.ourcommons.ca/written-questions/45-1/q-338"
        section_url = api_base + "/ajax/13716811/sections"
        fragment_url = api_base + "/ajax/13716811/prairiescan/file-content?part=prairiescan-main"
        workbook = "https://www.ourcommons.ca/written-questions/45-1/TEST%20-%20Q-338%20Excel%20Working%20Document%20(1).xlsx"
        shell = b'<html><div data-government-response-id="13716811"></div><meta name="request-verification-token" content="token"></html>'
        fragment = (b'<div><a href="TEST%20-%20Q-338%20Excel%20Working%20Document%20(1).xlsx">'
                    b'<table><thead><tr><th>Fiscal Year</th></tr></thead><tbody></tbody></table>'
                    b'<div class="spinner-border">Loading...</div></a></div>')

        def get(url, headers=None):
            if url == shell_url: return ReplyBytes(shell)
            if url == section_url: return ReplyBytes(b'<a data-section-code="PrairiesCan">PrairiesCan</a>')
            if url == fragment_url: return ReplyBytes(fragment, {"X-HtmlFragments-Keys": "prairiescan-main"})
            if url == workbook: return ReplyBytes(b"", status=404)
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as temp:
            result = acquire_written_question_replies({"number": 338, "session": "45-1", "language": "en",
                "responses": [{"id": 13716811}]}, get, Path(temp) / "objects")
        attachment = next(doc for doc in result["documents"] if doc["kind"] == "attachment")
        reply = next(doc for doc in result["documents"] if doc["kind"] == "reply")
        self.assertEqual(attachment["url"], workbook)
        self.assertEqual(attachment["title"], "TEST - Q-338 Excel Working Document (1).xlsx")
        self.assertEqual(attachment["availability"], "gap")
        self.assertIn("Fiscal Year", reply["text"])
        self.assertNotIn("Loading", reply["text"])


if __name__ == "__main__":
    unittest.main()
