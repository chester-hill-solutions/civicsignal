import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/departmental-report-documents.py"
SPEC = importlib.util.spec_from_file_location("departmental_report_documents", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DepartmentalReportDocumentsTests(unittest.TestCase):
    def test_candidate_filter_uses_only_explicit_direct_pdf_links(self):
        report = {"issuerPages": [{"family": "departmental-plans", "language": "en",
            "issuer_label": "Example Department", "issuer_key": "example",
            "published_url": "https://www.canada.ca/en/example/plans.html",
            "source_index_url": "https://www.canada.ca/directory", "source_index_sha256": "index-hash",
            "reportLinks": [
                {"link_type": "direct-edition", "url": "https://www.canada.ca/files/plan-2024-2025.pdf",
                 "label": "Departmental Plan 2024-2025", "heading": "Plans", "year_label": "2024-2025",
                 "landing_sha256": "landing-hash", "evidence": "label"},
                {"link_type": "index-link", "url": "https://www.canada.ca/files/plan-2024-2025.pdf",
                 "label": "Departmental Plan 2024-2025", "year_label": "2024-2025"},
                {"link_type": "direct-edition", "url": "https://www.canada.ca/files/plan.html",
                 "label": "Departmental Plan 2024-2025", "year_label": "2024-2025"},
            ]}, {"family": "regulatory-plans", "language": "en", "reportLinks": [
                {"link_type": "direct-edition", "url": "https://www.canada.ca/file.pdf"}]}]}
        candidates = MODULE.collect_candidates(report)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["url"], "https://www.canada.ca/files/plan-2024-2025.pdf")
        self.assertEqual(candidates[0]["sourceIndexSha256"], "index-hash")

    def test_label_dates_and_content_dispositions(self):
        self.assertEqual(MODULE.source_year("Departmental Performance Report from April 2013 to March 2014", "2013"), "2013-2014")
        candidate = {"family": "departmental-plans", "language": "en", "issuerLabel": "Example Department",
                     "issueYear": "2024-2025", "url": "https://www.canada.ca/example.pdf"}
        text = "Example Department\nDepartmental Plan 2024-2025\nTable of Contents"
        self.assertEqual(MODULE.assess(text, candidate)["disposition"], "verified")
        mismatch = MODULE.assess("Example Department\nPlan ministériel 2024-2025\nTable des matières", candidate)
        self.assertEqual(mismatch["languageDisposition"], "mismatch")
        self.assertEqual(mismatch["disposition"], "review")

    def test_public_continue_only_repeats_the_same_publisher_pdf_url(self):
        target = "https://publications.gc.ca/collections/example.pdf"
        body = (f'<a href="{target}">Continue to publication</a>').encode()
        self.assertTrue(MODULE.public_archive_continue(body, target))
        self.assertFalse(MODULE.public_archive_continue(body, "https://publications.gc.ca/collections/other.pdf"))
        self.assertFalse(MODULE.public_archive_continue(b"Access denied", target))

    def test_original_source_urls_with_spaces_get_encoded_only_for_fetch(self):
        original = "https://www.canada.ca/Reports/Annual Plan 2024.pdf"
        report = {"issuerPages": [{"family": "departmental-plans", "language": "en",
            "issuer_label": "Example Department", "published_url": "https://www.canada.ca/index.html",
            "reportLinks": [{"link_type": "direct-edition", "url": original,
                "label": "Departmental Plan 2024", "year_label": "2024", "landing_sha256": "abc"}]}]}
        row = MODULE.collect_candidates(report)[0]
        self.assertEqual(row["url"], original)
        self.assertEqual(row["fetchUrl"], "https://www.canada.ca/Reports/Annual%20Plan%202024.pdf")

    def test_refresh_and_read_only_replay_preserve_source_objects(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            edition_root, store = base / "edition", base / "documents"
            edition_root.mkdir()
            url = "https://www.canada.ca/en/example/departmental-plan-2024-2025.pdf"
            report = {"collection": "departmental-report-editions-current", "issuerPages": [{
                "family": "departmental-plans", "language": "en", "issuer_label": "Example Department",
                "issuer_key": "example", "published_url": "https://www.canada.ca/en/example/plans.html",
                "source_index_url": "https://www.canada.ca/en/directory", "source_index_sha256": "index-hash",
                "reportLinks": [{"link_type": "direct-edition", "url": url,
                    "label": "Departmental Plan 2024-2025", "heading": "Plans", "year_label": "2024-2025",
                    "landing_sha256": "landing-hash", "evidence": "label"}]}]}
            raw = json.dumps(report, sort_keys=True).encode()
            (edition_root / "current.json").write_bytes(raw)
            digest = hashlib.sha256(raw).hexdigest()
            (edition_root / "latest-attempt.json").write_text(json.dumps({
                "runId": "edition-run", "currentReportPath": "current.json", "currentReportSha256": digest}))
            body = b"%PDF-1.7 fixture"
            def fake_fetch(target):
                self.assertEqual(target, url)
                return body, target, 200, "application/pdf"
            text = "Example Department\nDepartmental Plan 2024-2025\nTable of Contents"
            with mock.patch.object(MODULE, "pdf_text", return_value=(text, 1)):
                result = MODULE.refresh(store, edition_root, workers=1, max_archive_bytes=MODULE.MAX_DOCUMENT_BYTES,
                                        min_free_bytes=0, fetcher=fake_fetch)
                run_id = result["runId"]
                db_path = store / "documents.sqlite"
                report_path = store / "generations" / f"{run_id}.json"
                before = hashlib.sha256(db_path.read_bytes()).hexdigest(), hashlib.sha256(report_path.read_bytes()).hexdigest()
                replayed = MODULE.replay(run_id, store)
                after = hashlib.sha256(db_path.read_bytes()).hexdigest(), hashlib.sha256(report_path.read_bytes()).hexdigest()
            self.assertEqual(result["status"], "complete")
            self.assertEqual(replayed["summary"]["verifiedCitations"], 1)
            self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
