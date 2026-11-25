import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("federal_report_directories", ROOT / "scripts/federal-report-directories.py")
directory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(directory)


class FederalReportDirectoryTests(unittest.TestCase):
    def test_only_verified_labelled_links_inside_institution_directory_are_kept(self):
        html = b"""<nav><a href='/nav'>Navigation label</a></nav><main>
        <h1>Departmental Plans</h1><a href='https://www.canada.ca/en/old'>Old archive</a>
        <h2>List of institutions</h2><ul><li><a href='https://agriculture.canada.ca/en/plan'>Agriculture and Agri-Food Canada</a></li>
        <li><a href='https://example.com/not-official'>Outside issuer</a></li><li><a href='#A'>A</a></li>
        <li><a href='https://www.canada.ca/en/report'>Unlabelled <span></span></a></li></ul>
        <h2>Related links</h2><ul><li><a href='https://www.canada.ca/en/related'>Related page</a></li></ul></main>"""
        parser = directory.PageLinks("https://www.canada.ca/en/index")
        parser.feed(html.decode())
        links = directory.verified_labelled_links(parser)
        self.assertEqual([(item["label"], item["url"]) for item in links], [
            ("Agriculture and Agri-Food Canada", "https://agriculture.canada.ca/en/plan"),
            ("Unlabelled", "https://www.canada.ca/en/report"),
        ])

    def test_french_institution_heading_and_language_selector_are_supported(self):
        html = b"""<main><a href='https://www.canada.ca/en/index'>English en</a>
        <h2>Liste des institutions</h2><ul><li><a href='https://agriculture.canada.ca/fr/plan'>Agriculture et Agroalimentaire Canada</a></li></ul></main>"""
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        self.assertEqual(directory.language_url_from_links(parser), "https://www.canada.ca/en/index")
        self.assertEqual(directory.verified_labelled_links(parser)[0]["label"], "Agriculture et Agroalimentaire Canada")

    def test_localized_footer_heading_ends_the_institution_directory(self):
        html = """<main><h2>Liste des institutions</h2><ul><li><a href='https://agency.gc.ca/fr'>Organisme fédéral</a></li></ul>
        <h2>Détails de la page</h2><ul><li><a href='https://www.canada.ca/fr/services/finance.html'>Argent et finances</a></li></ul></main>""".encode()
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        self.assertEqual([x["label"] for x in directory.verified_labelled_links(parser)], ["Organisme fédéral"])

    def test_current_regulatory_cycles_are_selected_per_family_and_language(self):
        html = b"""<main><a href='https://www.canada.ca/en/old'>Forward Regulatory Plan: 2025 to 2027</a>
        <a href='https://www.canada.ca/en/current'>Forward Regulatory Plan: 2026 to 2028</a>
        <a href='https://www.canada.ca/en/stock'>Regulatory Stock Review Plan: 2026 to 2036</a>
        <a href='http://example.ca/not-https'>Forward Regulatory Plan: 2027 to 2029</a></main>"""
        parser = directory.PageLinks("https://www.canada.ca/en/index")
        parser.feed(html.decode())
        selected = directory.current_regulatory_links(parser, "en")
        self.assertEqual([(item["cycleFamily"], item["cycle"], item["url"]) for item in selected], [
            ("forward-regulatory-plan", "2026-2028", "https://www.canada.ca/en/current"),
            ("regulatory-stock-review", "2026-2036", "https://www.canada.ca/en/stock"),
        ])

    def test_current_french_stock_review_label_is_detected(self):
        html = "<a href='https://www.canada.ca/fr/current'>Plan d’examen de l’inventaire des règlements de 2026 à 2036</a>".encode()
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        selected = directory.current_regulatory_links(parser, "fr")
        self.assertEqual([(item["cycleFamily"], item["cycle"]) for item in selected], [
            ("regulatory-stock-review", "2026-2036")
        ])

    def test_bilingual_grouping_keeps_explicit_edition_links(self):
        entries = [
            {"issuerKey":"roster-I-1", "issuerLabel":"Department A", "language":"en", "url":"https://a/en"},
            {"issuerKey":"roster-I-1", "issuerLabel":"Ministère A", "language":"fr", "url":"https://a/fr"},
        ]
        grouped = directory._pair_bilingual(entries)
        self.assertEqual(len(grouped), 1)
        self.assertTrue(grouped[0]["bilingualMatch"])
        self.assertEqual([edition["url"] for edition in grouped[0]["editions"]], ["https://a/en", "https://a/fr"])

    def test_regulatory_cycle_coverage_exposes_language_mismatch(self):
        summary = directory.cycle_coverage([
            {"language":"en", "cycleFamily":"forward-regulatory-plan", "cycle":"2026-2028"},
            {"language":"fr", "cycleFamily":"forward-regulatory-plan", "cycle":"2026-2028"},
            {"language":"en", "cycleFamily":"regulatory-stock-review", "cycle":"2025-2035"},
            {"language":"fr", "cycleFamily":"regulatory-stock-review", "cycle":"2026-2036"},
        ])
        self.assertEqual(summary["currentCycles"], 3)
        self.assertEqual(summary["bilingualCurrentCycles"], 1)
        self.assertEqual(summary["englishOnlyCycles"], [{"family":"regulatory-stock-review", "cycle":"2025-2035"}])
        self.assertEqual(summary["frenchOnlyCycles"], [{"family":"regulatory-stock-review", "cycle":"2026-2036"}])

    def test_content_source_reference_keeps_hash_without_volatile_capture_time(self):
        source = {"url":"https://www.canada.ca/index", "finalUrl":"https://www.canada.ca/index",
                  "sha256":"digest", "bytes":123, "observedAt":"volatile", "archive":"objects/digest.gz",
                  "body":b"not serialized"}
        self.assertEqual(directory.source_ref(source), {
            "url":"https://www.canada.ca/index", "finalUrl":"https://www.canada.ca/index",
            "sha256":"digest", "bytes":123, "archive":"objects/digest.gz",
        })


if __name__ == "__main__":
    unittest.main()
