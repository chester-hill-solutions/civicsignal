from importlib import import_module
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
policies = import_module("federal-policy-editions")


class FederalPolicyEditionTests(unittest.TestCase):
    def test_non_pdf_capture_distinguishes_an_explicit_archive_notice_from_other_html(self):
        url = "https://publications.gc.ca/collections/guide.pdf"
        notice = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(url, safe="")
        link = f'<a href="{url}">Continue to publication</a>'.encode()
        with tempfile.TemporaryDirectory() as directory, patch.object(policies.pdf, "fetch_pdf") as fetch:
            for body, final_url, expected in [(link, notice, True), (b"Temporarily unavailable", url, False)]:
                fetch.return_value = body, final_url, 200, "text/html"
                failure = policies.capture(Path(directory), url)
                self.assertEqual(failure["status"], "failed")
                self.assertEqual(failure["publicationNotice"], expected)
                self.assertEqual(failure["responseSha256"], hashlib.sha256(body).hexdigest())
                self.assertEqual(failure["finalUrl"], final_url)

    def test_checklist_join_requires_one_registered_policy_and_one_pdf_in_the_same_record(self):
        policy = "https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=123"
        pdf = "https://publications.gc.ca/collections/test.pdf"
        record = {"languageCodes": ["eng"], "fingerprint": "f"*64, "seenInIssues": ["2026-01"],
                  "publicationStatements": [{"function": "publication", "dates": ["2026"]},
                                             {"function": "copyright-notice", "dates": ["2025"]}]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inventory = root / "inventory.json"
            inventory.write_text(json.dumps({"records": [{"policy_id": "123", "language": "en", "label": "Policy"}]}))
            (root / "dist").mkdir()
            (root / "dist/receipt.json").write_text(json.dumps({"inventory": {"path": str(inventory),
                "sha256": hashlib.sha256(inventory.read_bytes()).hexdigest()}}))
            path = root / "catalogue.sqlite"
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE publication(identity); INSERT INTO publication VALUES ('fixture');"
                                 "CREATE TABLE records(source,id,title,metadata);")
                cases = [("valid", [policy, pdf]), ("split", [policy]), ("split", [pdf]),
                         ("two policies", [policy, policy+"4", pdf]), ("two PDFs", [policy, pdf, pdf.replace("test", "next")]),
                         ("unregistered", [policy+"4", pdf])]
                for identifier, urls in cases:
                    meta = {**record, "publicationLinks": [{"urls": [url]} for url in urls]}
                    db.execute("INSERT INTO records VALUES ('weekly-checklists',?,'Policy',?)", (identifier, json.dumps(meta)))
            _, candidates = policies.candidates(path, root)
            self.assertEqual([(row["catalogueId"], row["datesIssued"], row["catalogueLanguages"],
                               row["checklistRecordSha256"]) for row in candidates], [("valid", ["2026"], ["eng"], "f"*64)])

    def test_reads_only_explicit_policy_ids_and_government_catalogue_pdfs(self):
        url = "https://publications.gc.ca/collections/collection_2021/sct-tbs/example-fra.pdf"
        policy = "http://www.tbs-sct.gc.ca/pol/doc-fra.aspx?id=1234"
        urls = [policy, url, "https://foreign.example/collections/other.pdf",
                "https://www.tbs-sct.gc.ca/pol/doc-eng.aspx?id=word", policy + "&id=999"]
        self.assertEqual(policies.catalogue_links({"links": [{"url": u} for u in urls]}),
                         ({("1234", "fr"): policy}, {url: url}))
        self.assertEqual(policies.catalogue_links({"publicationLinks": [{"urls": [u]} for u in urls]}),
                         ({("1234", "fr"): policy}, {url: url}))

    def test_ambiguous_policy_ids_cannot_qualify_by_title(self):
        body_text = policies.normalize("Introduction — DIRECTIVE SUR LES COMMUNICATIONS")
        row = {"language": "fr", "catalogueTitle": "Directive sur les communications", "multiplePolicyIds": False, "catalogueLanguages": ["fre"]}
        self.assertTrue(policies.matches_title(row, body_text))
        self.assertFalse(policies.matches_title({**row, "multiplePolicyIds": True}, body_text))
        self.assertFalse(policies.matches_title({**row, "catalogueLanguages": ["eng"]}, body_text))

    def test_printed_register_title_requires_the_whole_passage_and_correct_language(self):
        row = {"catalogueTitle": "Guideline on on Self-Insurance", "indexEntries": [{"label": "Self-Insurance, Guideline on"}],
               "language": "en", "catalogueLanguages": ["eng"], "multiplePolicyIds": False, "titleCheck": "review"}
        passage = {"text": "Guideline on Self-Insurance", "page": 4}
        identity = policies.edition_identity(row, [passage])
        self.assertEqual((identity["method"], identity["page"]), ("printed-register-title", 4))
        self.assertFalse(policies.edition_identity(row, [{**passage, "text": "See " + passage["text"]}])["verified"])
        self.assertFalse(policies.edition_identity({**row, "language": "fr"}, [passage])["verified"])

    def test_layout_verification_accepts_only_the_complete_first_line_on_a_page(self):
        row = {"language": "en", "catalogueLanguages": ["eng"], "multiplePolicyIds": False, "catalogueTitle": "Internal Services Guideline"}
        doc = {"object": "test", "bodySha256": "a"*64, "bodyBytes": 10}
        review = {"verified": False, "method": "review"}
        with patch.object(policies.pdf, "read_gzip", return_value=b"%PDF-test"), patch.object(policies.pdf, "pdf_text") as text:
            text.return_value = ("Introduction\nSee Internal Services Guideline\fInternal Services Guideline\n1. Introduction", 2)
            self.assertEqual(policies.verify_printed_heading(Path("."), doc, row, review)["page"], 2)
            text.return_value = ("See Internal Services Guideline\nInternal Services Guideline", 1)
            self.assertEqual(policies.verify_printed_heading(Path("."), doc, row, review), review)

    def test_retry_keeps_a_dated_copy_and_records_the_new_failure(self):
        url = "https://publications.gc.ca/collections/guidance.pdf"
        row = {"url": url, "policyId": "1234", "language": "en", "catalogueId": "9.2",
               "catalogueTitle": "Management directive", "multiplePolicyIds": False, "catalogueLanguages": ["eng"]}
        original = b"%PDF-test"
        passages = [{"page": 1, "citation_url": url + "#page=1", "text": "Management Directive"}]
        with tempfile.TemporaryDirectory() as tmp, patch.object(policies, "candidates",
                return_value=({"registeredLanguageIds": 2}, [row])), patch.object(policies, "extract_passages", return_value=passages):
            root = Path(tmp)
            with patch.object(policies.pdf, "fetch_pdf", return_value=(original, url, 200, "application/pdf")):
                first = policies.refresh(root, root, root, 1)
            with patch.object(policies.pdf, "fetch_pdf", side_effect=OSError("publisher unavailable")):
                second = policies.refresh(root, root, root, 1)
            current = policies.load_report(root)["targets"][url]
            old = policies.load_report(root, first["reportSha256"])["targets"][url]
            self.assertEqual(second["summary"]["latestFetch"], {"failed": 1})
            self.assertEqual(current["document"], old["document"])
            self.assertEqual(policies.read_passages(root, current["document"], replay=True), passages)
