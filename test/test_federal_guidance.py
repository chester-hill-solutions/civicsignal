import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.federal_guidance import parse_ircc, parse_tbs


class FederalGuidanceTests(unittest.TestCase):
    def test_tbs_entries_preserve_id_label_language_and_page_status(self):
        body = b"""<html><body><h1>Inactive policy instruments</h1>
        <a href="doc-eng.aspx?id=12345">Example Directive</a></body></html>"""
        rows = parse_tbs(body, "https://www.tbs-sct.canada.ca/pol/arch-eng.aspx", "inactive", "en")
        self.assertEqual(rows, [{
            "policy_id": "12345", "label": "Example Directive", "status": "inactive",
            "language": "en", "source_index": "https://www.tbs-sct.canada.ca/pol/arch-eng.aspx",
            "citation_url": "https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=12345",
        }])

    def test_ircc_row_keeps_heading_cutoff_text_and_pdf_citations(self):
        body = """<html><body><h2>Overseas Processing (OP)</h2><table>
        <caption>Operational manuals</caption><tr>
        <td>OP 8</td><td><a href="/content/dam/ircc/op08-eng.pdf">Entrepreneur and Self-Employed (PDF, 488.13 KB)</a>
        <p>All applications in the self-employed persons class received on or before May 2, 2017, must be processed using OP 8.</p>
        <a href="/en/program-instructions.html">SE PDIs</a></td>
        </tr></table></body></html>""".encode()
        url = "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/index.html"
        rows = parse_ircc(body, url, "en")
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["kind"], "combined")
        self.assertIn("manual-or-guidance-pdf", row["kinds"])
        self.assertIn("program-guidance-or-other-index-entry", row["kinds"])
        self.assertEqual(row["section"], {"level": "h2", "text": "Overseas Processing (OP)"})
        self.assertIn("received on or before May 2, 2017", row["nearby_text"])
        self.assertEqual(row["citations"][0]["url"], "https://www.canada.ca/content/dam/ircc/op08-eng.pdf")
        self.assertIn("488.13 KB", row["citations"][0]["label"])


if __name__ == "__main__":
    unittest.main()
