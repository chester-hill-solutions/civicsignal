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

    def test_report_attribution_counts_distinct_verified_document_editions(self):
        from unittest.mock import patch
        citation = {"issuer_key": "institution-1", "issuer_label": "Known", "issue_year": "2025-2026",
                    "target_url": "https://www.canada.ca/report.pdf", "language": "en",
                    "disposition": "verified", "family": "departmental-plans"}
        report = {"documents": [{"target_url": citation["target_url"], "body_sha256": "a"*64,
                                  "text_sha256": "b"*64, "readable_chars": 50}],
                  "citations": [citation, citation, {**citation, "language": "fr"},
                                {**citation, "issuer_key": "unverified", "disposition": "review"}]}
        counted = []
        provenance = {}
        with patch.object(coverage, "latest_report_generation", return_value=(report, {"runId": "sample"})):
            coverage.count_report_documents(Path("corpus"), lambda family, labels: counted.append((family, labels)), provenance)
        self.assertEqual(counted, [("departmental-plans", ["Known"])] * 2)
        self.assertEqual(provenance["departmental-plans"]["runId"], "sample")

    def test_html_report_editions_use_verified_snapshot_and_dedupe_shared_urls(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            corpus=Path(temporary); root=corpus/"departmental-report-documents"
            edition=corpus/"departmental-report-editions"; (root/"html-generations").mkdir(parents=True)
            (root/"inputs").mkdir(); edition.mkdir()
            inventory={"collection":"departmental-report-editions-current","issuerPages":[]}
            inventory_raw=json.dumps(inventory,sort_keys=True).encode()
            inventory_sha=hashlib.sha256(inventory_raw).hexdigest()
            (edition/"current.json").write_bytes(inventory_raw)
            (edition/"latest-attempt.json").write_text(json.dumps({"runId":"edition-run","currentReportPath":"current.json","currentReportSha256":inventory_sha}))
            report={"runId":"html-run","status":"partial","observedAt":"2026-11-25T00:00:00Z",
                    "sourceEditionRunId":"edition-run","sourceCurrentReportSha256":inventory_sha}
            raw=json.dumps(report,sort_keys=True).encode(); report_path=root/"html-generations/html-run.json"; report_path.write_bytes(raw)
            (root/"latest-html-attempt.json").write_text(json.dumps({"runId":"html-run","status":"partial",
                "reportPath":"html-generations/html-run.json","reportSha256":hashlib.sha256(raw).hexdigest(),"reportBytes":len(raw)}))
            db=coverage.HTML_DOCUMENTS.open_db(root)
            try:
                good_url="https://www.canada.ca/en/sample/plan-2024-2025"
                bad_url="https://www.canada.ca/en/sample/failed-2024-2025"
                db.execute("insert into html_targets(source_report_sha256,target_url,status,body_sha256,body_bytes,readable_chars) values(?,?,?,?,?,?)",
                    (inventory_sha,good_url,"fetched","a"*64,1000,500))
                db.execute("insert into html_targets(source_report_sha256,target_url,status,detail) values(?,?,?,?)",
                    (inventory_sha,bad_url,"fetch-failed","TLS verification failed"))
                citations=[
                    ("c1",good_url,"Known","accepted"),("c2",good_url,"Known","accepted"),
                    ("c3",good_url,"Ambiguous","accepted"),("c4",good_url,"Known","not-report"),
                    ("c5",bad_url,"Known","fetch-failed")]
                for cid,url,issuer,status in citations:
                    db.execute("""insert into html_citations(source_report_sha256,citation_id,target_url,family,language,issuer_label,landing_url,label,year_label,status)
                        values(?,?,?,?,?,?,?,?,?,?)""",(inventory_sha,cid,url,"departmental-plans","en",issuer,
                        "https://www.canada.ca/en/sample/index","Departmental Plan 2024-2025","2024-2025",status))
                for index,run_id in enumerate(("batch-1","batch-2")):
                    db.execute("""insert into html_runs(run_id,started_at,source_report_run_id,source_report_path,source_report_sha256,input_path,candidate_citations,candidate_targets,batch_limit,status,report_path)
                        values(?,?,?,?,?,?,?,?,?,?,?)""",(run_id,f"2026-11-25T00:0{index}:00Z","edition-run","current.json",inventory_sha,
                        "source.json",5,2,24,"partial","html-generations/html-run.json"))
                db.commit()
            finally: db.close()
            audit={"sourceCurrentReportSha256":inventory_sha,"replayStatus":"verified","queueCompleteness":"drained",
                   "candidateTargets":2,"candidateCitations":5,"acceptedCitations":3,
                   "targetStatusCounts":{"fetched":1,"fetch-failed":1},
                   "citationDispositionCounts":{"accepted":3,"not-report":1,"fetch-failed":1},
                   "replayedBatchRuns":2,"replayedRunIdsSha256":hashlib.sha256(b"batch-1\nbatch-2").hexdigest(),
                   "byFamilyLanguage":{"departmental-plans/en":{"candidates":5,"statuses":{"accepted":3}},
                       "departmental-plans/fr":{"candidates":0,"statuses":{}},
                       "departmental-results/en":{"candidates":0,"statuses":{}},
                       "departmental-results/fr":{"candidates":0,"statuses":{}}}}
            aliases={"known":{("S","Known Institution","Institution connue")},
                     "ambiguous":{("S","Institution A","Institution A FR"),("S","Institution B","Institution B FR")}}
            counted=[]; provenance={}
            with patch.object(coverage.HTML_DOCUMENTS,"html_audit",return_value=audit):
                coverage.count_html_report_documents(corpus,lambda source,names: counted.append((source,names)),provenance,aliases)
            self.assertEqual(counted,[("departmental-report-html-plans",["Known"])] )
            self.assertEqual(provenance["departmental-report-html-plans"]["distinctAcceptedEditions"],1)
            self.assertEqual(provenance["departmental-report-html-plans"]["acceptedCitations"],3)
            self.assertEqual(provenance["departmental-report-html-plans"]["unresolvedAcceptedCitations"],1)
            classified={"departmental-report-html-plans":provenance["departmental-report-html-plans"]}
            coverage.classify_sources(classified,{"departmental-plans":{"family":"planning"}})
            self.assertEqual(classified["departmental-report-html-plans"]["family"],"planning")

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
