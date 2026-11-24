import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.committee_publications import extract_publication, publication_metadata, publication_parts
from lib.committee_files import official


class CommitteePublicationTests(unittest.TestCase):
    def test_house_minutes_and_notice_keep_content_and_source_locations(self):
        minutes = b"""<html><body><nav><p>Site navigation must not leak.</p></nav>
        <div class="publication-container-content"><main class="publication">
          <h1>Minutes of Proceedings</h1><p id="P_12">The committee met on clean water.</p>
          <table><tr><td>Motion</td><td>Adopted unanimously.</td></tr></table>
        </main></div></body></html>"""
        passages = extract_publication(minutes, "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/meeting-2/minutes", "en")
        self.assertEqual([item["text"] for item in passages], [
            "Minutes of Proceedings", "The committee met on clean water.", "Motion Adopted unanimously."])
        self.assertEqual(passages[1]["location"], "anchor:P_12")
        self.assertNotIn("navigation", " ".join(p["text"] for p in passages))
        self.assertIsNone(passages[1]["speaker"])

        notice = b"""<main><h1>Notice of Meeting</h1><div class="notice-of-meeting-details">
          <div class="tv-text-identifier">Organization meeting</div><p class="proceduralItem">The committee meets in camera.</p>
        </div><footer>Footer text</footer></main>"""
        items = extract_publication(notice, "https://sencanada.ca/en/committees/TEST/notice/451/1", "en")
        self.assertEqual([item["text"] for item in items], ["Organization meeting", "The committee meets in camera."])
        self.assertNotIn("Footer", " ".join(p["text"] for p in items))

    def test_senate_minutes_are_supported_but_oral_evidence_is_not(self):
        minutes = b"""<div id="content-viewer-document"><p class="center"><strong>THE SENATE COMMITTEE</strong></p>
          <p class="center"><strong>MINUTES OF PROCEEDINGS</strong></p><p>The committee considered its agenda.</p></div>"""
        result = extract_publication(minutes, "https://sencanada.ca/en/committees/TEST/minutes/451/01mn-1-e", "en")
        self.assertEqual(len(result), 3)
        self.assertIn("MINUTES OF PROCEEDINGS", result[1]["location"])
        evidence = b"""<div id="content-viewer-document"><p class="center">THE SENATE COMMITTEE</p>
          <p class="center">EVIDENCE</p><p>Witness testimony must use the proceedings extractor.</p></div>"""
        self.assertEqual(extract_publication(evidence, "https://sencanada.ca/en/committees/TEST/transcriptsminutes/451", "en"), [])

    def test_inline_report_files_are_found_without_navigation_or_neighbor_reports(self):
        body = b"""<html><body><nav><a href="/navigation.pdf">Navigation PDF</a></nav>
          <div class="publication-container-content"><h1>Annual Report</h1>
            <p>Download <a href="/files/annual-report.pdf">Annual report PDF</a></p>
            <p><a href="/files/chapter-2.pdf">Chapter 2</a></p>
            <p><a href="/files/exhibit-a.docx">Exhibit A</a></p>
            <p>Prior work <a href="/DocumentViewer/en/44-1/TEST/report-7">Previous report</a></p>
            <p>Earlier citation <a href="/files/previous-report.pdf">Previous report</a></p>
            <p><a href="https://outside.example/exhibit-b.pdf">Exhibit B</a></p>
          </div></body></html>"""
        parts = publication_parts(body, "https://www.ourcommons.ca/DocumentViewer/en/45-1/TEST/report-2")
        self.assertEqual(parts, [
            {"url": "https://www.ourcommons.ca/files/annual-report.pdf", "kind": "report_pdf", "title": "Annual report PDF"},
            {"url": "https://www.ourcommons.ca/files/chapter-2.pdf", "kind": "chapter", "title": "Chapter 2"},
            {"url": "https://www.ourcommons.ca/files/exhibit-a.docx", "kind": "exhibit", "title": "Exhibit A"},
        ])

    def test_response_pdf_and_size_or_language_errors(self):
        response = b"""<div id="docContent"><h2>Government Response</h2><p>Read the <a title="Official response PDF"
          href="/files/response.pdf">response document</a>.</p></div>"""
        parts = publication_parts(response, "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/report-1/response-2")
        self.assertEqual(parts[0]["kind"], "document")
        with self.assertRaises(ValueError):
            extract_publication(b"<div id='docContent'>text</div>", "https://example.test/", "xx")
        with self.assertRaisesRegex(ValueError, "byte limit"):
            extract_publication(b"x" * (32 * 1024 * 1024 + 1), "https://www.ourcommons.ca/document", "en")

    def test_source_labeled_metadata_preserves_absence_and_explicit_people(self):
        notice = b"""<html><head><meta name="MeetingDate" content="2026-09-18" /></head><body>
        <div class="publication-container-content"><h1>Notice of Meeting <span class="Amended">Amended</span></h1>
          <div class="Header"><i class="icon-clock"></i>Thursday, September 18, 2026, 9:00 a.m. to 10:00 a.m.
          </div><div class="Header"><i class="icon-lock"></i>In Camera</div>
          <div class="Property">Witnesses</div><div class="OrganizationName">Example Research Institute</div>
          <div class="WitnessListItem"><span id="A_42">&#149;&nbsp;Alex Example, Research Director</span></div>
          <a href="https://senparlvu.parl.gc.ca/harmony/en/powerbrowser/powerbrowserv2?fk=123&globalstreamid=7">Audio only</a>
        </div></body></html>"""
        metadata = publication_metadata(notice, "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/meeting-2/notice", "en")
        self.assertEqual(metadata["dates"], [
            {"label": "MeetingDate", "value": "2026-09-18", "location": "meta:MeetingDate"},
            {"label": "icon-clock", "value": "Thursday, September 18, 2026, 9:00 a.m. to 10:00 a.m.",
             "location": "class:Header"},
        ])
        self.assertEqual(metadata["witnesses"], [
            {"name": "Alex Example, Research Director", "organization": "Example Research Institute", "location": "A_42"},
        ])
        self.assertEqual(metadata["organizations"], ["Example Research Institute"])
        self.assertEqual({item["value"] for item in metadata["status"]}, {"amended", "in-camera"})
        self.assertEqual(metadata["playerUrls"], [
            {"url": "https://senparlvu.parl.gc.ca/harmony/en/powerbrowser/powerbrowserv2?fk=123&globalstreamid=7",
             "label": "Audio only"},
        ])
        self.assertNotIn("offset", " ".join(str(value) for value in metadata.values()).lower())

        empty = publication_metadata(b"<div id='docContent'><p>Ordinary report text.</p></div>",
                                     "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/report-1", "en")
        self.assertEqual(empty, {})

        explicit_status = publication_metadata(
            b"<div id='docContent'><h1>Meeting cancelled</h1><div class='Status'>Public</div></div>",
            "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/meeting-3/notice", "en")
        self.assertEqual({entry["value"] for entry in explicit_status["status"]}, {"cancelled", "public"})

    def test_explicit_report_dates_and_static_section_urls(self):
        body = b"""<main id="sc-main-content"><div class="container">
          <h3 class="text-uppercase right-heading">Report of the committee</h3>
          <div><p>It was presented to the House of Commons on Thursday, October 10, 2024.</p>
            <h2 id="recommendations">Recommendations</h2><p>Recommendation text.</p>
            <p class="Center">Observations to the report</p><p>Observation text.</p>
            <p><a href="/content/sen/committee/451/AEFA/Reports/Report1.pdf">Download report PDF</a></p>
          </div></div><div class="session-dropdown-session">Navigation must not leak.</div></main>"""
        passages = extract_publication(body, "https://sencanada.ca/en/committees/AEFA/Report/147650/45-1", "en")
        self.assertNotIn("Navigation", " ".join(item["text"] for item in passages))
        metadata = publication_metadata(body, "https://sencanada.ca/en/committees/AEFA/Report/147650/45-1", "en")
        self.assertIn({"label": "Presented to the House of Commons", "value": "Thursday, October 10, 2024",
                       "location": "publication-text"}, metadata["dates"])
        parts = publication_parts(body, "https://sencanada.ca/en/committees/AEFA/Report/147650/45-1")
        self.assertEqual(parts, [
            {"url": "https://sencanada.ca/content/sen/committee/451/AEFA/Reports/Report1.pdf",
             "kind": "report_pdf", "title": "Download report PDF"},
            {"url": "https://sencanada.ca/en/committees/AEFA/Report/147650/45-1#recommendations",
             "kind": "recommendations", "title": "Recommendations"},
        ])
        dated = publication_metadata(
            b"<div id='docContent'><p>The government response was tabled on Wednesday, January 12, 2026.</p>"
            b"<p>The study began on October 2, 2025.</p></div>",
            "https://www.ourcommons.ca/DocumentViewer/en/45-1/X/report-1/response-1", "en")
        self.assertEqual(dated["dates"], [
            {"label": "Response date", "value": "Wednesday, January 12, 2026", "location": "publication-text"},
            {"label": "Study date", "value": "October 2, 2025", "location": "publication-text"},
        ])

    def test_publications_archive_gateway_unwraps_only_linked_collections_pdf(self):
        gateway = ("https://publications.gc.ca/site/archivee-archived.html?url="
                   "https%3A%2F%2Fpublications.gc.ca%2Fcollections%2Fcollection_2024%2Facc-vac%2F"
                   "V44-22-2024-eng.pdf")
        body = ("<div class='publication-container-content'><p>According to "
                f"<a href='{gateway}'>Veterans Affairs Canada</a>.</p>"
                "<p><a href='https://publications.gc.ca/site/archivee-archived.html?url="
                "https%3A%2F%2Fevil.example%2Fcollections%2Fbad.pdf'>Untrusted wrapper</a></p></div>").encode()
        parts = publication_parts(body, "https://www.ourcommons.ca/DocumentViewer/en/45-1/OGGO/report-6/")
        self.assertEqual(parts, [{
            "url": "https://publications.gc.ca/collections/collection_2024/acc-vac/V44-22-2024-eng.pdf",
            "kind": "document", "title": "Veterans Affairs Canada",
        }])
        self.assertTrue(official(gateway))
        self.assertTrue(official(parts[0]["url"]))


if __name__ == "__main__":
    unittest.main()
