from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("institution_coverage", scripts / "federal-institution-coverage.py")
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class InstitutionCoverageTests(unittest.TestCase):
    def test_partial_report_links_keep_issuer_ambiguity_and_generation_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            corpus = Path(temporary)
            root = corpus / "departmental-report-editions"
            (root / "generations").mkdir(parents=True)
            report = {"runId": "first", "status": "partial", "observedAt": "2026-11-25T00:00:00Z",
                      "reportLinks": [{"issuer_label": name, "family": "departmental-plans"}
                                      for name in ("Known", "Ambiguous")]}
            body = json.dumps(report).encode()
            path = root / "generations/first.json"
            path.write_bytes(body)
            pointer = {"runId": "first", "status": "partial", "reportPath": "generations/first.json",
                       "reportSha256": hashlib.sha256(body).hexdigest(), "reportBytes": len(body)}
            (root / "latest-attempt.json").write_text(json.dumps(pointer))
            counts, summary = coverage.report_links_by_institution(corpus, {"known": {"one"}, "ambiguous": {"one", "two"}})
            self.assertEqual(counts, {"one": {"departmental-plans": 1}})
            self.assertEqual(summary["unresolvedBySeries"], {"departmental-plans": 1})
            self.assertEqual(summary["acquisitionStatus"], "partial")
            path.write_bytes(body + b" ")
            with self.assertRaisesRegex(ValueError, "published receipt"):
                coverage.report_links_by_institution(corpus, {})

    def test_family_counts_distinguish_assessments_from_briefing_packages(self):
        inputs = {"disclosure-aia": {"series": "federal-disclosures"},
                  "disclosure-transition": {"series": "federal-disclosures"},
                  "canadabuys-award-notices": {"series": "federal-procurement"},
                  "eccc-audit": {"series": "eccc-audit"}}
        register = {key: {"family": family} for key, family in (
            ("algorithmic-assessments", "management"), ("briefing-packages", "advice"),
            ("procurement", "resources"), ("eccc-audit", "assurance"))}
        coverage.classify_sources(inputs, register)
        self.assertEqual([source["family"] for source in inputs.values()], ["management", "advice", "resources", "assurance"])

    def test_contracting_labels_require_published_name_and_same_language_abbreviation(self):
        row = {"Legal title": "Department of Works", "Appellation légale": "Ministère des Travaux",
               "Applied title": "Works Canada", "Titre d'usage": "Travaux Canada",
               "Abbreviation": "WC", "Abréviation": "TC"}
        aliases = defaultdict(set, {"department of works": {"works"}})
        coverage.register_published_titles(row, aliases)
        self.assertEqual(aliases["department of works (wc)"], {"works"})
        self.assertEqual(aliases["travaux canada - tc"], {"works"})
        self.assertNotIn("department of works (tc)", aliases)
        self.assertNotIn("wc", aliases)
        self.assertNotIn("department of works (other)", aliases)

        ambiguous = defaultdict(set, {"department of works": {"works"}, "ministère des travaux": {"other"}})
        coverage.register_published_titles(row, ambiguous)
        self.assertNotIn("department of works (wc)", ambiguous)
