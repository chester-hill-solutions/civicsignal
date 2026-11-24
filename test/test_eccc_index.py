import re
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from scripts.lib.eccc_index import document_id, pair_key, parse_index, work_id


FIXTURES = root / "test" / "fixtures" / "eccc"


def fixture(name, series, language):
    html = (FIXTURES / name).read_text(encoding="utf-8")
    return parse_index(html, series, language)


class ECCCIndex(unittest.TestCase):
    def test_evaluation_fixtures_have_matching_entry_and_year_sequences(self):
        english = fixture("evaluations-en.html", "eval", "en")
        french = fixture("evaluations-fr.html", "eval", "fr")

        def years(entries):
            return [
                tuple(re.findall(r"\d{4}", entry["fiscal_year"]))
                for entry in entries
            ]

        self.assertEqual(len(english), len(french))
        self.assertEqual(years(english), years(french))

    def test_freshwater_entry_preserves_title_and_summary_report_links(self):
        entries = fixture("evaluations-en.html", "eval", "en")
        entry = next(item for item in entries if "Freshwater Quality Science" in item["title"])
        self.assertEqual(entry["title"], "Evaluation of ECCC’s Freshwater Quality Science")
        self.assertIsNone(entry["lead"])
        self.assertEqual(len(entry["links"]), 2)
        self.assertEqual([link["kind"] for link in entry["links"]], ["summary", "report"])

    def test_oceans_protection_plan_retains_external_lead_and_url(self):
        entry = parse_index(
            '<details><summary>2025 to 2026</summary><div>'
            '<p>Horizontal Evaluation of the Oceans Protection Plan '
            '<span class="nowrap">(led by Transport Canada)</span></p>'
            '<ul><li><a href="https://tc.canada.ca/en/example?view=summary">'
            "Evaluation summary</a></li></ul>"
            "</div></details>",
            "eval",
            "en",
        )[0]
        self.assertEqual(entry["title"], "Horizontal Evaluation of the Oceans Protection Plan")
        self.assertEqual(entry["lead"], "Transport Canada")
        external = next(link for link in entry["links"] if "tc.canada.ca" in link["href"])
        self.assertTrue(external["href"].startswith("https://tc.canada.ca/"))
        self.assertEqual(external["href"], "https://tc.canada.ca/en/example?view=summary")
        self.assertEqual(external["path"], "/en/example")

    def test_audit_mrgn_paragraphs_and_one_link_entries_are_parsed(self):
        for filename, language in (("audits-en.html", "en"), ("audits-fr.html", "fr")):
            with self.subTest(language=language):
                entries = fixture(filename, "audit", language)
                self.assertEqual(len(entries), 1)
                self.assertEqual(len(entries[0]["links"]), 1)
                self.assertTrue(entries[0]["title"])

    def test_titles_decode_apostrophes_and_entities(self):
        entry = parse_index(
            '<details><summary>2025 to 2026</summary><div>'
            '<p>Evaluation of ECCC&rsquo;s Science &amp; Data</p>'
            '<ul><li><a href="/report.html">Report</a></li></ul>'
            "</div></details>",
            "eval",
            "en",
        )[0]
        self.assertEqual(entry["title"], "Evaluation of ECCC’s Science & Data")

    def test_work_id_is_stable_series_scoped_and_report_based(self):
        entry = fixture("evaluations-en.html", "eval", "en")[0]
        first = work_id("eval", entry)
        self.assertEqual(first, work_id("eval", entry))
        self.assertNotEqual(first, work_id("audit", entry))
        self.assertEqual(first, "eccc-eval-evaluation-eccc-freshwater-quality-science-report-preliminary-apr-2026")
        with self.assertRaises(ValueError):
            work_id("eval", {"links": []})
        with self.assertRaises(ValueError):
            work_id("eval", {"links": [{"kind": "report", "href": "https://example.ca/---"}]})

    def test_document_id_includes_language_kind_and_url_digest(self):
        args = ("eccc-eval-freshwater", "en", "report", "https://example.ca/report.pdf")
        base = document_id(*args)
        self.assertNotEqual(base, document_id(args[0], "fr", args[2], args[3]))
        self.assertNotEqual(base, document_id(args[0], args[1], "summary", args[3]))
        self.assertNotEqual(base, document_id(args[0], args[1], args[2], "https://example.ca/other.pdf"))
        self.assertRegex(base, r"\.report\.[0-9a-f]{8}$")

    def test_pair_key_folds_accents_punctuation_and_whitespace(self):
        self.assertEqual(
            pair_key({"title": "Évaluation — qualité, de l’eau!  douce"}),
            "evaluation qualite de leau douce",
        )

    def test_details_without_links_returns_no_entries(self):
        self.assertEqual(
            parse_index(
                "<details><summary>2025 to 2026</summary><p>Empty work</p></details>",
                "eval",
                "en",
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
