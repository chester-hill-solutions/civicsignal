import sys
import unittest
from io import BytesIO
from pathlib import Path
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lib.committee_submissions import classify_extraction, extract_submission


def package(files):
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return output.getvalue()


class CommitteeSubmissionTests(unittest.TestCase):
    def test_html_extraction_keeps_section_location_and_unknown_author_fields(self):
        passages = extract_submission(
            b"<html><body><h2>Recommendations</h2><p>Fund clean water.</p><p>Publish results.</p></body></html>",
            "https://example.ca/brief.html", "text/html")
        self.assertEqual([item["text"] for item in passages], ["Fund clean water.", "Publish results."])
        self.assertEqual(passages[0]["location"], "section:Recommendations")
        self.assertIsNone(passages[0]["speaker"])
        self.assertIsNone(passages[0]["affiliation"])

    def test_text_has_searchable_sections_and_unsupported_is_empty(self):
        passages = extract_submission(b"First paragraph\n\nSecond paragraph", "brief.txt", "text/plain")
        self.assertEqual(len(passages), 2)
        self.assertEqual(passages[1]["location"], "section:2")
        self.assertEqual(extract_submission(b"image data", "scan.bin", "application/octet-stream"), [])

    def test_pdf_without_pdf_bytes_is_unsearchable(self):
        with self.assertRaisesRegex(ValueError, "no PDF signature"):
            extract_submission(b"not a pdf", "brief.pdf", "application/pdf")
        self.assertEqual(classify_extraction(None, "brief.pdf", "application/pdf"), "unavailable")
        self.assertEqual(classify_extraction(b"file bytes", "brief.bin", "application/octet-stream"), "unsupported")
        self.assertEqual(classify_extraction(b"%PDF-1.7", "brief.pdf", "application/pdf", []), "image_only")

    def test_docx_extracts_paragraphs_and_table_cells_with_stable_locations(self):
        document = """<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>Written testimony</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Funding</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Recommend clean water.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>Closing evidence.</w:t></w:r></w:p>
        </w:body></w:document>"""
        body = package({"word/document.xml": document})
        passages = extract_submission(body, "https://senate.example/brief.docx",
                                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertEqual([p["text"] for p in passages], [
            "Written testimony", "Funding", "Recommend clean water.", "Closing evidence."])
        self.assertEqual([p["location"] for p in passages], [
            "paragraph:1", "table:1,row:1,cell:1,paragraph:1", "table:1,row:1,cell:2,paragraph:1", "paragraph:2"])
        self.assertEqual(classify_extraction(body, "brief.docx", "application/zip", passages), "searchable")
        self.assertIsNone(passages[0]["speaker"])
        self.assertIsNone(passages[0]["affiliation"])

    def test_xlsx_extracts_shared_and_inline_cells_with_sheet_and_row_locations(self):
        workbook = """<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
          <sheet name="Submissions" sheetId="1" r:id="rId1"/></sheets></workbook>"""
        rels = """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>"""
        strings = """<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <si><t>Organization</t></si><si><r><t>Example</t></r><r><t> Nation</t></r></si></sst>"""
        sheet = """<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Position</t></is></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>
        </sheetData></worksheet>"""
        body = package({"xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": rels,
                        "xl/sharedStrings.xml": strings, "xl/worksheets/sheet1.xml": sheet})
        passages = extract_submission(body, "https://senate.example/brief.xlsx",
                                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertEqual(passages, [
            {"text": "A1: Organization | B1: Position", "location": "sheet:Submissions,row:1",
             "speaker": None, "affiliation": None},
            {"text": "A2: Example Nation | B2: 42", "location": "sheet:Submissions,row:2",
             "speaker": None, "affiliation": None},
        ])

    def test_ooxml_limits_and_legacy_binary_status_are_explicit(self):
        from lib import committee_submissions as module
        body = package({"word/document.xml": "<w:document/>"})
        previous_limit = module.MAX_OOXML_XML_BYTES
        module.MAX_OOXML_XML_BYTES = 5
        try:
            with self.assertRaisesRegex(ValueError, "expanded-size limit"):
                extract_submission(body, "brief.docx", "application/zip")
        finally:
            module.MAX_OOXML_XML_BYTES = previous_limit
        previous_total = module.MAX_OOXML_EXPANDED_BYTES
        module.MAX_OOXML_EXPANDED_BYTES = 10
        try:
            with self.assertRaisesRegex(ValueError, "total expanded-size limit"):
                extract_submission(package({"word/document.xml": "123456", "other.xml": "123456"}),
                                   "brief.docx", "application/zip")
        finally:
            module.MAX_OOXML_EXPANDED_BYTES = previous_total
        legacy = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy"
        self.assertEqual(extract_submission(legacy, "brief.doc", "application/msword"), [])
        self.assertEqual(classify_extraction(legacy, "brief.doc", "application/msword"), "unsupported")
        with self.assertRaisesRegex(ValueError, "readable OOXML ZIP"):
            extract_submission(b"not a zip", "brief.docx", "application/zip")


if __name__ == "__main__":
    unittest.main()
