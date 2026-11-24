import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("funding_nserc", ROOT / "scripts" / "funding-nserc.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NsercCatalogueTest(unittest.TestCase):
    def test_collects_both_editions_and_follows_publisher_translation_links(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        pages = {
            MODULE.INDEXES["en"]: (fixtures / "index-en.html").read_bytes(),
            MODULE.INDEXES["fr"]: (fixtures / "index-fr.html").read_bytes(),
            "https://nserc-crsng.canada.ca/en/funding-opportunity/applied-research-and-development-grants": (fixtures / "detail-en.html").read_bytes(),
            "https://nserc-crsng.canada.ca/fr/possibilite-de-financement/subventions-de-recherche-et-developpement-appliquee": (fixtures / "detail-fr.html").read_bytes(),
        }
        visited = []

        def fetch(url):
            visited.append(url)
            return pages[url]

        packet = MODULE.collect(fetch)
        self.assertEqual(packet["indexes"], MODULE.INDEXES)
        self.assertEqual({r["language"] for r in packet["records"]}, {"en", "fr"})
        self.assertEqual(len(packet["records"]), 2)
        self.assertEqual({r["id"] for r in packet["records"]}, {"nserc-applied-research-and-development-grants"})
        self.assertEqual([r["status"] for r in packet["records"]], ["open", "open"])
        self.assertTrue(all(r["availability"] == "published" for r in packet["records"]))
        for record in packet["records"]:
            fields = {section["field"] for section in record["sections"]}
            self.assertTrue({"overview", "eligibility", "partners", "amount", "deadline", "status"} <= fields)
            self.assertTrue(all(s["url"].startswith("https://nserc-crsng.canada.ca/") for s in record["sections"]))
            self.assertTrue(all(len(s["text"]) < 2_000 for s in record["sections"]))
            self.assertIn(MODULE.INDEXES[record["language"]], {s["url"] for s in record["sections"] if s["field"] == "status"})
        self.assertEqual(packet["gaps"], [])
        self.assertNotIn("Average yearly amount requested", {s["heading"] for r in packet["records"] for s in r["sections"]})
        self.assertEqual(set(visited), set(pages))

    def test_unknown_and_invitation_statuses_are_preserved(self):
        self.assertEqual(MODULE.classify_status("Invitation only"), "invitation-only")
        self.assertEqual(MODULE.classify_status("Sur invitation seulement"), "invitation-only")
        self.assertEqual(MODULE.classify_status("Results posted"), "unknown")
        self.assertEqual(MODULE.classify_heading("Qui peut présenter une demande?"), "eligibility")
        self.assertEqual(MODULE.classify_heading("Pendant combien de temps?"), "other")

    def test_unmatched_translation_is_reported_not_dropped(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        pages = {
            MODULE.INDEXES["en"]: (fixtures / "index-en.html").read_bytes(),
            MODULE.INDEXES["fr"]: b'<div class="view-content">Aucun resultat</div>',
            "https://nserc-crsng.canada.ca/en/funding-opportunity/applied-research-and-development-grants": (fixtures / "detail-en.html").read_bytes(),
        }
        packet = MODULE.collect(lambda url: pages[url])
        self.assertEqual(len(packet["records"]), 1)
        self.assertTrue(any(g["language"] == "fr" and "links to" in g["reason"] for g in packet["gaps"]))
        self.assertTrue(all(g["id"].startswith("nserc-") for g in packet["gaps"]))

    def test_partial_detail_parse_fails_closed(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        pages = {
            MODULE.INDEXES["en"]: (fixtures / "index-en.html").read_bytes(),
            MODULE.INDEXES["fr"]: b'<div class="view-content">Aucun resultat</div>',
            "https://nserc-crsng.canada.ca/en/funding-opportunity/applied-research-and-development-grants": b"<html><p>truncated page</p>",
        }
        with self.assertRaisesRegex(ValueError, "detail page title"):
            MODULE.collect(lambda url: pages[url])

    def test_publisher_reported_total_must_match_parsed_card_count(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        pages = {
            MODULE.INDEXES["en"]: (fixtures / "index-en.html").read_bytes().replace(b"of 1 results", b"of 2 results"),
        }
        with self.assertRaisesRegex(ValueError, r"parsed 1 en records but NSERC reports 2"):
            MODULE.collect(lambda url: pages[url])

    def test_malformed_partial_index_card_fails_closed(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        pages = {MODULE.INDEXES["en"]: (fixtures / "index-en-partial.html").read_bytes()}
        with self.assertRaisesRegex(ValueError, "malformed en funding result card"):
            MODULE.collect(lambda url: pages[url])

    def test_real_archived_french_edition_is_retained_when_peer_is_absent(self):
        fixtures = ROOT / "test" / "fixtures" / "funding" / "nserc"
        current_en = MODULE.BASE + "/en/funding/funding-opportunity?field_program_type_unique%5B891%5D=891"
        archive_fr = MODULE.BASE + "/fr/financement/possibilite-de-financement?field_archived=1&field_program_type_unique%5B891%5D=891"
        french_page = MODULE.BASE + "/fr/possibilite-de-financement/archivee-programme-dinnovation-dans-les-colleges-et-la-communaute"
        english_peer = MODULE.BASE + "/en/funding-opportunity/archived-college-and-community-innovation-program-innovation-links-grants"
        original_indexes = MODULE.INDEXES
        MODULE.INDEXES = {"en": current_en, "fr": archive_fr}
        self.addCleanup(setattr, MODULE, "INDEXES", original_indexes)
        pages = {
            current_en: (fixtures / "index-en-empty.html").read_bytes(),
            archive_fr: (fixtures / "index-fr-archived-one.html").read_bytes(),
            french_page: (fixtures / "archived-innovation-links-fr.html").read_bytes(),
        }
        packet = MODULE.collect(lambda url: pages[url])
        self.assertEqual(len(packet["records"]), 1)
        record = packet["records"][0]
        self.assertEqual(record["language"], "fr")
        self.assertTrue(record["title"].startswith("ARCHIVÉE"))
        self.assertEqual(record["id"], "nserc-archived-college-and-community-innovation-program-innovation-links-grants")
        self.assertEqual(packet["gaps"], [{
            "language": "en", "id": record["id"], "url": english_peer,
            "reason": "NSERC detail page links to this edition’s counterpart, but that counterpart is absent from the independently collected index; the published edition is retained.",
        }])


if __name__ == "__main__":
    unittest.main()
