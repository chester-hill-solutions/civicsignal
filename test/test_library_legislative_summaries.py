"""Check the Library catalogue inventory against representative source pages."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "library-legislative-summaries.py"
SPEC = importlib.util.spec_from_file_location("library_legislative_summaries", SCRIPT)
library = importlib.util.module_from_spec(SPEC)
sys.path.insert(0, str(SCRIPT.parent))
try:
    SPEC.loader.exec_module(library)
finally:
    sys.path.pop(0)


def card(language, bill, pdf=None):
    prefix = library.CATALOGUES[language].path
    suffix = "E" if language == "en" else "F"
    name = "Legislative Summary of Bill" if language == "en" else "Résumé législatif du projet de loi"
    link = f'<a href="{pdf}" type="application/pdf">PDF</a>' if pdf else ""
    return f'''<div class="card-content"><div class="card-header"><h2>
      <a href="{prefix}/451{bill.lower().replace('-', '')}{suffix}">{name} {bill}: <em>Title</em></a>
    </h2></div><div class="card-info">
      <div class="views-field-field-revised-date"><time datetime="2025-06-18T00:00:00Z">2025-06-18</time></div>
      <div class="name-field-parliament-number"><div>45-1</div></div>{link}
    </div></div>'''


def catalogue(language, *cards, following=None, extra=""):
    next_link = f'<a href="{following}" rel="next">Next</a>' if following else ""
    return (f'<html lang="{language}"><main><h1>Catalogue</h1>{"".join(cards)}{next_link}{extra}'
            '</main></html>').encode()


EN_PDF = "/system/files/researchpublications/legislativesummaries/pdf/PV_45-1-C5-E_0.pdf"
FR_PDF = "/sites/default/files/researchpublications/legislativesummaries/pdf/45-1/45-1-c5-f.pdf"
NEXT = "?parliament_session=45-1&amp;page=1"


class LibraryCatalogueTest(unittest.TestCase):
    def test_follows_publisher_pagination_and_keeps_asymmetric_and_missing_links(self):
        bills = {
            ("C-5", "en"): {"legisInfoId": 42, "url": "https://www.parl.ca/legisinfo/en/bill/45-1/c-5"},
            ("C-5", "fr"): {"legisInfoId": 42, "url": "https://www.parl.ca/legisinfo/fr/projet-de-loi/45-1/c-5"},
        }
        pages = {
            library.catalogue_url("en"): catalogue("en", card("en", "C-5", EN_PDF), following=NEXT),
            library.catalogue_url("en") + "&page=1": catalogue(
                "en", card("en", "S-7"),
                extra='<a hreflang="fr" href="/fr/publicationsderecherche/resumeslegislatifs?page=1&amp;parliament_session=45-1">Français</a>',
            ),
            library.catalogue_url("fr"): catalogue("fr", card("fr", "C-5", FR_PDF)),
        }
        inventory = library.collect(library.SESSION, pages.__getitem__, bills)
        records = {(row["billNumber"], row["language"]): row for row in inventory["records"]}
        self.assertEqual(records[("C-5", "en")]["pdfUrl"], library.ORIGIN + EN_PDF)
        self.assertEqual(records[("C-5", "fr")]["pdfUrl"], library.ORIGIN + FR_PDF)
        self.assertEqual(records[("C-5", "en")]["revisionDate"], "2025-06-18")
        self.assertEqual(records[("C-5", "fr")]["legisInfoId"], 42)
        self.assertIsNone(records[("S-7", "en")]["pdfUrl"])
        self.assertEqual(inventory["coverage"]["languageOnly"], {"en": ["S-7"], "fr": []})
        self.assertEqual(inventory["coverage"]["unmatchedBills"], ["S-7"])

    def test_rejects_wrong_bill_or_language_in_the_document_link(self):
        for conflicting in (EN_PDF.replace("C5", "C50"), FR_PDF):
            with self.subTest(url=conflicting), self.assertRaisesRegex(ValueError, "document identity"):
                library.parse_page(catalogue("en", card("en", "C-5", conflicting)), "en", library.catalogue_url("en"))

    def test_rejects_skipped_page_or_dropped_session_filter(self):
        for bad in ("?page=1", "?parliament_session=45-1&amp;page=2", "https://example.net/?parliament_session=45-1&amp;page=1"):
            with self.subTest(link=bad), self.assertRaisesRegex(ValueError, "pagination"):
                library.parse_page(catalogue("en", card("en", "C-5"), following=bad), "en", library.catalogue_url("en"))

    def test_parses_only_positive_bilingual_legisinfo_identities(self):
        records = []
        for lang, route in (("en", "bill"), ("fr", "projet-de-loi")):
            records.append({"key": "c-5", "language": lang, "details": {"legisInfoId": 42},
                            "url": f"https://www.parl.ca/legisinfo/{lang}/{route}/45-1/c-5"})
        packet = {"session": "45-1", "collection": "bills", "records": records}
        self.assertEqual(library.bill_identities(json.dumps(packet).encode())[("C-5", "fr")]["legisInfoId"], 42)
        records[1]["details"]["legisInfoId"] = 43
        with self.assertRaisesRegex(ValueError, "bilingual bill identities"):
            library.bill_identities(json.dumps(packet).encode())
