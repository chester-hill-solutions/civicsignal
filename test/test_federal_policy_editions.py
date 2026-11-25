from importlib import import_module
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
policies = import_module("federal-policy-editions")


class FederalPolicyEditionTests(unittest.TestCase):
    def test_requires_an_explicit_registered_policy_id_and_government_catalogue_pdf(self):
        url = "https://publications.gc.ca/collections/collection_2021/sct-tbs/example-fra.pdf"
        policy = "http://www.tbs-sct.gc.ca/pol/doc-fra.aspx?id=1234"
        register = {("1234", "fr"): []}
        urls = [policy, url, "https://foreign.example/collections/other.pdf",
                "https://www.tbs-sct.gc.ca/pol/doc-eng.aspx?id=1234", policy + "&id=999"]
        self.assertEqual(policies.catalogue_links({"links": [{"url": u} for u in urls]}, register),
                         ({("1234", "fr"): policy}, {url: url}))

    def test_ambiguous_policy_ids_cannot_qualify_by_title(self):
        body_text = policies.normalize("Introduction — DIRECTIVE SUR LES COMMUNICATIONS")
        row = {"language": "fr", "catalogueTitle": "Directive sur les communications", "multiplePolicyIds": False, "catalogueLanguages": ["fre"]}
        self.assertTrue(policies.matches_title(row, body_text))
        self.assertFalse(policies.matches_title({**row, "multiplePolicyIds": True}, body_text))
        self.assertFalse(policies.matches_title({**row, "catalogueLanguages": ["eng"]}, body_text))

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
