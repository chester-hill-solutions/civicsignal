from hashlib import sha256
import fcntl
from importlib import import_module
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
manuals = import_module("ircc-guidance-documents")


class IrccManualTests(unittest.TestCase):
    def test_failed_repeat_preserves_page_citations_and_old_receipt(self):
        url = "https://www.canada.ca/manual.pdf"
        entries = {("en", url): {"language": "en", "url": url, "scope": "ircc-document", "listings": [{"cells": ["OP 8"]}]}}
        extracted = [{"page": 3, "citation_url": url + "#page=3", "text": "manual content"}]
        source = {"sha256": "a"*64}
        def download(target, _max):
            return b"%PDF-fixture", "application/pdf", target, 12
        def denied(target, _max):
            raise manuals.report_editions.FetchError("HTTP 403", 403)
        with TemporaryDirectory() as tmp, patch.object(manuals, "inventory", return_value=(source, entries)), \
                patch.object(manuals, "pdf_passages", return_value=extracted), \
                patch.object(manuals, "recover_pdu_fallbacks", side_effect=lambda _root, report, _fetch: report):
            root = Path(tmp)
            first = manuals.refresh(root, root, 1, download)
            second = manuals.refresh(root, root, 1, denied)
            self.assertEqual(second["summary"]["verifiedThisRun"], 0)
            self.assertEqual(second["summary"]["availableEditions"], 1)
            old = manuals.load_report(root, first["reportSha256"])["editions"][0]
            latest = manuals.load_report(root)["editions"][0]
            self.assertEqual((old["status"], latest["status"]), ("verified", "failed"))
            self.assertEqual(old["document"], latest["document"])
            self.assertEqual(manuals.check_edition(root, latest["document"], reparse=True), extracted)
            identity = sha256(b"%PDF-fixture").hexdigest()
            manuals.object_path(root, identity, ".pdf").write_bytes(b"different")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                manuals.check_edition(root, latest["document"])

    def test_official_feed_paths_are_departmental_documents(self):
        page = "/fr/immigration-refugies-citoyennete/bulletin.html"
        for prefix in ("", "/content/canadasite", "/canadasite"):
            self.assertTrue(manuals.department_page("https://www.canada.ca" + prefix + page))
        self.assertFalse(manuals.department_page("https://other.example" + page))
        self.assertFalse(manuals.department_page("https://www.canada.ca/fr/autre/rapport"))

    def test_http_success_with_an_html_rejection_cannot_qualify_as_a_manual(self):
        with TemporaryDirectory() as tmp:
            def rejected(url, _max):
                return b"<title>Request Rejected</title>", "text/html", url, 31
            with self.assertRaisesRegex(ValueError, "text/html"):
                manuals.get_document(Path(tmp), "https://www.canada.ca/manual.pdf", rejected)
            with self.assertRaisesRegex(ValueError, "did not return a PDF"):
                manuals.extract_manual(b"<html>unexpected content</html>", "https://www.canada.ca/manual.pdf")

    def test_bulletin_requires_a_language_specific_title_and_citable_content(self):
        url = "https://www.canada.ca/fr/immigration-refugies-citoyennete/bulletin.html"
        sample = b'<html lang="fr"><main><h1>Bulletin 12</h1><h2 id="regle">Conditions</h2><p>Les conditions publiees sont applicables aux dossiers indiques.</p></main></html>'
        title, sections = manuals.extract_page(sample, url, "fr")
        self.assertEqual(title, "Bulletin 12")
        self.assertEqual(sections[-1]["citation_url"], url + "#regle")
        with self.assertRaisesRegex(ValueError, "requested language"):
            manuals.extract_page(sample, url, "en")
        with self.assertRaisesRegex(ValueError, "guidance title"):
            manuals.extract_page(sample.replace(b"Bulletin 12", b"Page introuvable"), url, "fr")

    def test_pdu_recovery_matches_unambiguous_category_and_iso_date_and_archived_hreflang(self):
        english_url = "https://www.canada.ca/en/immigration-refugees-citizenship/updates/interpreter.html"
        french_url = "https://www.canada.ca/fr/immigration-refugies-citoyennete/mises-a-jour/interprete.html"
        category = "canadian-citizenship service-delivery "
        source_index_en = manuals.IRCC_LANDING["en"]
        source_index_fr = manuals.IRCC_LANDING["fr"]
        en_record = {"category": category, "dataOrder": "2021-11-26", "date": "November 26, 2021",
                     "link": english_url, "title": "Interpreter vaccination certification"}
        fr_record = {"category": category.strip(), "dataOrder": "2021-11-26", "date": "26 novembre 2021",
                     "link": french_url, "title": "Formulaire de vaccination des interprètes"}

        def source_row(language, url, record):
            source_data = f"https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdu-{language}.json"
            return {"language": language, "kind": "program-delivery-update", "source_data_url": source_data,
                    "source_index": manuals.IRCC_LANDING[language],
                    "citations": [{"url": url}], "source_data_record": record}

        en_row, fr_row = source_row("en", english_url, en_record), source_row("fr", french_url, fr_record)
        english_html = (f'<html lang="en"><head><meta name="dcterms.issued" content="2021-11-26">'
                        f'<link rel="alternate" hreflang="fr" href="{french_url}"></head><main>'
                        '<h1>Interpreter vaccination certification</h1><p>Publisher English edition and date for the certified vaccination form.</p></main></html>').encode()
        french_html = (b'<html lang="fr"><head><meta name="dcterms.issued" content="2021-11-26"></head><main>'
                       b'<h1>Formulaire de vaccination des interpr\xc3\xa8tes</h1>'
                       b'<p>Document publi\xc3\xa9 pour les interpr\xc3\xa8tes et les contrats de services.</p></main></html>')
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            english_doc = manuals._archive_verified_html(root, english_html, "text/html", english_url,
                                                         en_record["title"], en_record["dataOrder"], "en")
            en_edition = {"language": "en", "url": english_url, "scope": "ircc-document", "status": "verified",
                          "document": english_doc, "listings": [{"dataUrl": en_row["source_data_url"]}]}
            fr_edition = {"language": "fr", "url": french_url, "scope": "ircc-document", "status": "failed",
                          "error": "HTTP 404", "listings": [{"dataUrl": fr_row["source_data_url"]}]}
            report = {"schemaVersion": 2, "sourceInventory": {"path": "unused", "sha256": "x"},
                      "summary": {"listedEditions": 2, "verifiedThisRun": 1, "failedEditions": 1,
                                  "availableEditions": 1, "linkedReferences": 0},
                      "editions": [en_edition, fr_edition]}
            inventory = {"collection": "federal-guidance-indexes"}

            def fetch(url, _maximum):
                self.assertEqual(url, french_url)
                return french_html, "text/html", french_url, len(french_html)

            with patch.object(manuals, "_read_verified_inventory", return_value=inventory), \
                    patch.object(manuals, "_verified_pdu_rows", side_effect=lambda _inv, lang: [en_row if lang == "en" else fr_row]):
                result = manuals.recover_pdu_fallbacks(root, report, fetch, "a" * 64)

            self.assertEqual(result["summary"], {"listedEditions": 2, "verifiedThisRun": 2,
                                                  "failedEditions": 0, "availableEditions": 2,
                                                  "linkedReferences": 0})
            self.assertEqual(fr_edition["status"], "verified")
            self.assertEqual(fr_edition["url"], french_url)
            self.assertEqual(fr_edition["error"], "HTTP 404")
            self.assertEqual(fr_edition["recovery"]["originalError"], "HTTP 404")
            manuals._verify_recovery_evidence(root, result, inventory, fr_edition, [en_row], [fr_row])

            with self.assertRaisesRegex(ValueError, "does not select one English source row"):
                manuals._match_en_pdu(fr_row, [en_row, {**en_row, "source_data_record": {**en_record, "title": "duplicate"}}])

    def test_pdu_recovery_rejects_wrong_date_or_title_and_requires_one_hreflang(self):
        body = (b'<html lang="fr"><head><meta name="dcterms.issued" content="2021-11-26">'
                b'<link rel="alternate" hreflang="fr" href="https://www.canada.ca/fr/one.html">'
                b'<link rel="alternate" hreflang="fr" href="https://www.canada.ca/fr/two.html"></head>'
                b'<main><h1>Document published</h1><p>Published instructions for the official process.</p></main></html>')
        with self.assertRaisesRegex(ValueError, "does not publish the source ISO issue date"):
            manuals._published_evidence(body, "Document published", "2021-11-25", "fr")
        with self.assertRaisesRegex(ValueError, "title does not match"):
            manuals._published_evidence(body, "Another title", "2021-11-26", "fr")
        prefixed = body.replace(b"Document published", b"Program delivery update: Document published")
        self.assertEqual(manuals._published_evidence(prefixed, "Document published", "2021-11-26", "fr")[0],
                         "Program delivery update: Document published")
        oath = (b'<html lang="fr"><head><meta name="dcterms.issued" content="2021-07-08"></head><main>'
                b'<h1>Mise a jour : Le serment de citoyennete a ete mis a jour</h1>'
                b'<p>Le texte officiel indique les consignes applicables au serment de citoyennete.</p></main></html>')
        self.assertIn("serment", manuals._published_evidence(
            oath, "Le serment de citoyenneté a été mis à jourl", "2021-07-08", "fr")[0])
        with self.assertRaisesRegex(ValueError, "one unambiguous"):
            manuals._alternate_french_url(body, "https://www.canada.ca/en/immigration-refugees-citizenship/updates/example.html")

    def test_existing_report_recovery_uses_refresh_lock_and_does_not_move_a_newer_head(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = {"summary": {"verifiedThisRun": 1}, "editions": []}
            newer = {"summary": {"verifiedThisRun": 2}, "editions": []}
            old_raw, newer_raw = manuals.encoded(original), manuals.encoded(newer)
            old_sha, newer_sha = sha256(old_raw).hexdigest(), sha256(newer_raw).hexdigest()
            (root / "reports").mkdir()
            (root / "reports" / f"{old_sha}.json").write_bytes(old_raw)
            (root / "reports" / f"{newer_sha}.json").write_bytes(newer_raw)
            (root / "latest.json").write_bytes(manuals.encoded({"reportSha256": newer_sha}))

            def recover(_root, report, _fetch, parent_sha):
                report["recoveredFromReportSha256"] = parent_sha
                report["summary"]["verifiedThisRun"] = 3
                return report

            with patch.object(manuals, "recover_pdu_fallbacks", side_effect=recover):
                derived = manuals.recover_existing_report(root, old_sha, fetch=lambda *_: None)
            self.assertFalse(derived["latestUpdated"])
            self.assertEqual(json.loads((root / "latest.json").read_bytes())["reportSha256"], newer_sha)
            self.assertEqual(manuals.load_report(root, derived["reportSha256"])["summary"]["verifiedThisRun"], 3)

            with (root / "refresh.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(RuntimeError, "publication lock"):
                    manuals.recover_existing_report(root, old_sha, fetch=lambda *_: None)

    def test_recovery_and_regular_html_capture_share_one_parse_and_archive_path(self):
        url = "https://www.canada.ca/en/immigration-refugees-citizenship/guidance/sample.html"
        body = (b'<html lang="en"><head><meta name="dcterms.issued" content="2026-11-25"></head><main><h1>Sample guidance</h1>'
                b'<p>This official page contains enough published content for a citable passage.</p></main></html>')
        with TemporaryDirectory() as tmp, patch.object(manuals, "extract_page", wraps=manuals.extract_page) as parser:
            root = Path(tmp)
            recovered = manuals._archive_verified_html(root, body, "text/html", url,
                                                        "Sample guidance", "2026-11-25", "en")
            self.assertEqual(parser.call_count, 1)
            parser.reset_mock()
            regular = manuals.get_document(root, url, lambda *_: (body, "text/html", url, len(body)), "en")
            self.assertEqual(parser.call_count, 1)
            self.assertEqual(recovered["sha256"], regular["sha256"])
            self.assertEqual(recovered["passagesSha256"], regular["passagesSha256"])
