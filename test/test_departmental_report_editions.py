import errno
import importlib.util
from email.message import Message
from pathlib import Path
import tempfile
import unittest
import json
import urllib.error
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/departmental-report-editions.py"
SPEC = importlib.util.spec_from_file_location("departmental_report_editions", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DepartmentalReportEditionsTests(unittest.TestCase):
    def test_fetch_retries_one_transient_reset_but_does_not_retry_publisher_responses(self):
        class Response:
            status = 200
            def __init__(self):
                self.headers = Message()
                self.headers["Content-Type"] = "text/html"
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def geturl(self):
                return "https://grainscanada.gc.ca/en/about-us/reports/"
            def read(self, size=-1):
                return b"<html><h1>Departmental Plans 2025-2026</h1></html>"

        transport_attempts = []
        class TransientThenSuccess:
            def open(self, _request, timeout):
                transport_attempts.append(timeout)
                if len(transport_attempts) == 1:
                    raise urllib.error.URLError(ConnectionResetError(errno.ECONNRESET, "Connection reset by peer"))
                return Response()

        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=TransientThenSuccess()), \
             mock.patch.object(MODULE.time, "sleep") as sleep:
            body, media, final, size = MODULE.fetch_page("https://grainscanada.gc.ca/en/about-us/reports/")
        self.assertTrue(body.startswith(b"<html>"))
        self.assertEqual((media, final, size), ("text/html", "https://grainscanada.gc.ca/en/about-us/reports/", len(body)))
        self.assertEqual(transport_attempts, [30, 30])
        sleep.assert_called_once_with(0.25)

        forbidden = urllib.error.HTTPError("https://grainscanada.gc.ca/en/about-us/reports/", 403, "Forbidden", {}, None)
        opener = mock.Mock()
        opener.open.side_effect = forbidden
        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(MODULE.FetchError, "HTTP 403"):
                MODULE.fetch_page("https://grainscanada.gc.ca/en/about-us/reports/")
        opener.open.assert_called_once()

    def test_exact_publisher_404_recoveries_are_source_bound_and_reported(self):
        inventory = {
            "families": {
                "departmental-plans": {"issuers": [{"issuerKey": "cnsc", "issuerLabel": {"en": ["Canadian Nuclear Safety Commission"]}, "editions": [{
                    "issuerKey": "cnsc", "issuerLabel": "Canadian Nuclear Safety Commission", "language": "en",
                    "url": "https://www.cnsc-ccsn.gc.ca/eng/resources/publications/reports/rpp/",
                    "sourceIndexUrl": "https://www.canada.ca/en/directory", "sourceIndexSha256": "planhash"}]}]},
                "departmental-results": {"issuers": []},
                "regulatory-plans": {"institutionDirectoryLinks": [
                    {"issuerLabel": "Farm Products Council of Canada", "language": "en",
                     "url": "https://www.canada.ca/en/farm-products-council/corporate/acts-and-regulations.html",
                     "sourceIndexUrl": "https://www.canada.ca/en/regulatory-directory", "sourceIndexSha256": "reghash-en"},
                    {"issuerLabel": "Conseil des produits agricoles du Canada", "language": "fr",
                     "url": "https://www.canada.ca/fr/conseil-produits-agricoles/entreprise/lois-et-reglements.html",
                     "sourceIndexUrl": "https://www.canada.ca/fr/regulatory-directory", "sourceIndexSha256": "reghash-fr"},
                ]},
            },
            "sourceArchives": {
                "departmental-plans-en": {"url": "https://www.canada.ca/en/directory", "sha256": "planhash"},
                "regulatory-directories-en": {"url": "https://www.canada.ca/en/regulatory-directory", "sha256": "reghash-en"},
                "regulatory-directories-fr": {"url": "https://www.canada.ca/fr/regulatory-directory", "sha256": "reghash-fr"},
            },
        }
        pages = MODULE.source_pages(inventory)
        recovered = {page["url"]: page for page in pages if page.get("publisherRecovery")}
        self.assertEqual(len(recovered), 3)
        for original, page in recovered.items():
            self.assertEqual(page["publisherRecovery"]["originalUrl"], original)
            self.assertEqual(page["fetchUrl"], page["publisherRecovery"]["resolvedUrl"])
            self.assertTrue(MODULE.committee_files.official(page["fetchUrl"]))
            self.assertTrue(page["publisherRecovery"]["evidenceUrls"])
        cns = recovered["https://www.cnsc-ccsn.gc.ca/eng/resources/publications/reports/rpp/"]
        self.assertEqual(cns["fetchUrl"], "https://www.cnsc-ccsn.gc.ca/eng/corporate/plans-results/rpp/")
        fpcc = recovered["https://www.canada.ca/en/farm-products-council/corporate/acts-and-regulations.html"]
        self.assertEqual(fpcc["fetchUrl"], "https://www.canada.ca/en/farm-products-council/services/acts-and-regulations.html")
        self.assertNotIn("https://www.asc-csa.gc.ca/eng/publications/rp.asp", recovered)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = MODULE.db_open(root)
            try:
                source_receipt = {"inventoryPath": "inventory.json", "inventorySha256": "inventoryhash"}
                receipt_path = MODULE.ROOT / "receipt.json"
                MODULE._start_generation(db, "recovery-fixture", receipt_path, source_receipt, inventory, pages)
                snapshot = MODULE._snapshot(db, root, "recovery-fixture", receipt_path, source_receipt)
                report_pages = {page["published_url"]: page for page in snapshot["issuerPages"]}
                self.assertEqual(report_pages[cns["url"]]["publisherRecovery"]["originalUrl"], cns["url"])
                self.assertEqual(report_pages[cns["url"]]["publisherRecovery"]["resolvedUrl"], cns["fetchUrl"])
                self.assertEqual(report_pages[fpcc["url"]]["publisherRecovery"]["evidenceUrls"], fpcc["publisherRecovery"]["evidenceUrls"])
            finally:
                db.close()

    def test_only_family_context_and_year_label_are_inventoried(self):
        body = b"""<html><title>Departmental publications</title>
        <h2>Departmental Plans</h2><a href='/reports/departmental-plan-2025-2026.pdf'>2025 to 2026</a>
        <h2>Departmental Results</h2><a href='/reports/results-2024-2025.html'>2024-2025</a>
        <a href='/reports/2023-2024.pdf'>2023-2024</a></html>"""
        parsed = MODULE.extract_report_links(body, "https://www.canada.ca/en/dept/reports.html",
                                             "departmental-plans", "en")
        self.assertEqual(len(parsed["reportLinks"]), 1)
        self.assertEqual(parsed["reportLinks"][0]["yearLabel"], "2025-2026")
        self.assertEqual(parsed["reportLinks"][0]["linkType"], "direct-edition")
        self.assertEqual(len(parsed["ambiguousYearLinks"]), 2)

    def test_multipurpose_page_subheading_is_not_misclassified_as_document(self):
        body = b"""<html><title>Departmental publications</title>
        <h1>Reports</h1><h2>Departmental Results Report 2024-2025</h2>
        <a href='/reports/2024-2025.pdf'>Download</a></html>"""
        parsed = MODULE.extract_report_links(body, "https://www.canada.ca/en/dept/reports.html",
                                             "departmental-results", "en")
        self.assertFalse(any(row["evidence"] == "document-page-title-or-heading" for row in parsed["reportLinks"]))
        self.assertFalse(parsed["reportLinks"])

    def test_report_document_title_is_direct_edition(self):
        body = "<html><title>Rapport sur les résultats ministériels 2023-2024</title></html>".encode()
        parsed = MODULE.extract_report_links(body, "https://www.canada.ca/fr/dept/resultats.html",
                                             "departmental-results", "fr")
        self.assertEqual(parsed["reportLinks"][0]["linkType"], "direct-edition")
        self.assertEqual(parsed["reportLinks"][0]["yearLabel"], "2023-2024")

    def test_regulatory_discoveries_keep_publisher_label_without_cycle_guess(self):
        body = """<html><h2>Forward Regulatory Plan</h2>
        <a href='/acts-regulations/forward-plan.html'>Current and Forward Regulatory Plan</a>
        <a href='/reports/results-2024-2025.pdf'>Departmental Results Report 2024-2025</a></html>""".encode()
        parsed = MODULE.extract_regulatory_links(body, "https://www.canada.ca/en/dept/acts-regulations", "en")
        self.assertEqual(len(parsed["discoveryLinks"]), 1)
        self.assertEqual(parsed["discoveryLinks"][0]["linkType"], "index-link")
        self.assertEqual(parsed["discoveryLinks"][0]["label"], "Current and Forward Regulatory Plan")
        self.assertFalse(parsed["reportLinks"])

    def test_only_listed_gc_http_urls_upgrade_and_exact_listed_hosts_are_allowed(self):
        self.assertEqual(MODULE.acquisition_url("http://www.cbsa-asfc.gc.ca/path"),
                         "https://www.cbsa-asfc.gc.ca/path")
        self.assertEqual(MODULE.acquisition_url("https://www.atlanticpilotage.com/acts-regulations/forward-regulatory-plan/"),
                         "https://www.atlanticpilotage.com/acts-regulations/forward-regulatory-plan/")
        self.assertIsNone(MODULE.acquisition_url("https://web.archive.org/web/20250812/http://www.rcmp-grc.gc.ca/fr/plan-prospectif-de-la-reglementation"))

    def test_multiple_ambiguous_candidates_are_durable_as_one_gap(self):
        body = b"""<html><a href='/a/2024-2025.pdf'>2024-2025</a>
        <a href='/b/2023-2024.pdf'>2023-2024</a></html>"""
        family, language, url = "departmental-plans", "en", "https://www.canada.ca/en/dept/index.html"
        page = {"family": family, "language": language, "url": url, "issuerLabel": "Example Department",
                "issuerKey": "example"}
        fetched = {"status": "fetched", "body": body, "media_type": "text/html", "final_url": url,
                   "bytes": len(body), "detail": None, "http_status": 200}
        extraction = MODULE.extract_report_links(body, url, family, language)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = MODULE.db_open(root)
            try:
                with db:
                    db.execute("INSERT INTO generations(run_id,started_at,status,source_receipt_path,source_inventory_path,source_inventory_sha256,expected_pages) VALUES('fixture','now','running','receipt.json','inventory.json','hash',1)")
                    db.execute("INSERT INTO issuer_pages(run_id,family,issuer_key,issuer_label,language,published_url,source_index_url,source_index_sha256,status) VALUES('fixture',?,?,?,?,?,'https://www.canada.ca/directory','sourcehash','pending')",
                               (family, "example", "Example Department", language, url))
                MODULE._record_result(db, root, "fixture", page, fetched, extraction, "now")
                rows = db.execute("SELECT issue_type,code,candidates_json FROM gaps WHERE run_id='fixture'").fetchall()
                ambiguous = [row for row in rows if row["code"] == "ambiguous-year-link"]
                self.assertEqual(len(ambiguous), 1)
                self.assertEqual(ambiguous[0]["issue_type"], "edition-gap")
                self.assertEqual(len(json.loads(ambiguous[0]["candidates_json"])), 2)
            finally:
                db.close()

    def test_failed_new_attempt_keeps_prior_verified_page(self):
        body = b"<html><h1>Departmental Plans 2024-2025</h1></html>"
        family, language, url = "departmental-plans", "en", "https://www.canada.ca/en/dept/plan.html"
        page = {"family": family, "language": language, "url": url, "issuerLabel": "Example Department",
                "issuerKey": "example", "sourceIndexUrl": "https://www.canada.ca/directory", "sourceIndexSha256": "source"}
        extraction = MODULE.extract_report_links(body, url, family, language)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = MODULE.db_open(root)
            try:
                for run_id, started in (("good", "2026-01-01T00:00:00+00:00"), ("failed", "2026-01-02T00:00:00+00:00")):
                    with db:
                        db.execute("INSERT INTO generations(run_id,started_at,status,source_receipt_path,source_inventory_path,source_inventory_sha256,expected_pages) VALUES(?,?,'running','receipt.json','inventory.json','hash',1)", (run_id, started))
                        db.execute("INSERT INTO issuer_pages(run_id,family,issuer_key,issuer_label,issuer_attribution,language,published_url,source_index_url,source_index_sha256,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')",
                                   (run_id, family, "example", "Example Department", "Example Department", language, url, page["sourceIndexUrl"], "source"))
                fetched = {"status": "fetched", "body": body, "media_type": "text/html", "final_url": url,
                           "bytes": len(body), "detail": None, "http_status": 200}
                MODULE._record_result(db, root, "good", page, fetched, extraction, "2026-01-01T00:00:00+00:00")
                failure = {"status": "failed", "detail": "HTTP 403", "http_status": 403}
                MODULE._record_result(db, root, "failed", page, failure, None, "2026-01-02T00:00:00+00:00")
                current = db.execute("SELECT verified_run_id,verified_at,last_attempt_run_id,last_attempt_status,last_attempt_http_status,last_attempt_detail FROM issuer_page_current").fetchone()
                self.assertEqual(tuple(current), ("good", "2026-01-01T00:00:00+00:00", "failed", "failed", 403, "HTTP 403"))
                with db:
                    db.execute("INSERT INTO generations(run_id,started_at,status,source_receipt_path,source_inventory_path,source_inventory_sha256,expected_pages) VALUES('late','2026-01-01T12:00:00+00:00','running','receipt.json','inventory.json','hash',1)")
                    db.execute("INSERT INTO issuer_pages(run_id,family,issuer_key,issuer_label,issuer_attribution,language,published_url,source_index_url,source_index_sha256,status) VALUES('late',?,?,?,?,?,?,?,?, 'pending')",
                               (family, "example", "Example Department", "Example Department", language, url, page["sourceIndexUrl"], "source"))
                MODULE._record_result(db, root, "late", page, fetched, extraction, "2026-01-03T00:00:00+00:00")
                current = db.execute("SELECT verified_run_id,verified_at,last_attempt_run_id,last_attempt_status,last_attempt_http_status,last_attempt_detail FROM issuer_page_current").fetchone()
                self.assertEqual(tuple(current), ("good", "2026-01-01T00:00:00+00:00", "failed", "failed", 403, "HTTP 403"))
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
