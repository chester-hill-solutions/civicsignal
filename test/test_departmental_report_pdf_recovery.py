import errno
import hashlib
import importlib.util
import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import sqlite3
import urllib.error
from urllib.parse import quote


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/departmental-report-documents.py"
SPEC = importlib.util.spec_from_file_location("departmental_report_documents_pdf_recovery", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, body, url, media):
        self.body = body
        self.offset = 0
        self.status = 200
        self.headers = Message()
        self.headers["Content-Type"] = media
        self.headers["Content-Length"] = str(len(body))
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self.url

    def read(self, size=-1):
        if size < 0:
            size = len(self.body)
        part = self.body[self.offset:self.offset + size]
        self.offset += len(part)
        return part


class SequencedOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        return self.responses.pop(0)


class DepartmentalReportPdfRecoveryTests(unittest.TestCase):
    def test_registered_cra_alternatives_are_exact_and_keep_the_observed_url(self):
        cases = [
            ("2002-03.pdf", "2002-2003", "Rv1-6-2002-eng.pdf", "cra-index-declared-equivalent-corporate-plan"),
            ("2003-04.pdf", "2003-2004", "Rv1-28-2003-eng.pdf", "official-catalogue-english-rpp-issue"),
        ]
        candidates = []
        for filename, year, expected_file, expected_method in cases:
            original = "https://epe.lac-bac.gc.ca/100/202/301/treasury_board/estimates_report_plans/canada_customs_revenue_agency/" + filename
            report = {"issuerPages": [{"family": "departmental-plans", "language": "en",
                "issuer_label": "Canada Revenue Agency", "issuer_key": "cra", "published_url": "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
                "source_index_url": "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
                "source_index_sha256": "index-hash", "reportLinks": [{"link_type": "direct-edition", "url": original,
                    "label": f"{year} Estimates (PDF)", "year_label": year, "landing_sha256": "landing-hash",
                    "evidence": "family-heading-and-year-link-label"}]}]}
            candidate = MODULE.collect_candidates(report)[0]
            self.assertEqual(candidate["url"], original)
            self.assertEqual(Path(candidate["fetchUrl"]).name, expected_file)
            self.assertEqual(candidate["publisherRecovery"]["method"], expected_method)
            self.assertEqual(candidate["publisherRecovery"]["originalUrl"], original)
            candidates.append(candidate)
        self.assertEqual(candidates[0]["issueYear"], "2002-2003")
        self.assertEqual(candidates[1]["issueYear"], "2003-2004")
        near_match = candidates[0]["url"].replace("2002-03.pdf", "2002-04.pdf")
        self.assertNotIn(near_match, MODULE.PUBLISHER_PDF_RECOVERIES)

    def test_notice_navigation_requires_same_origin_exact_notice_query_and_literal_anchor(self):
        target = "https://publications.gc.ca/collections/collection_2012/arc-cra/Rv1-6-2002-eng.pdf"
        notice = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(target, safe="")
        html = f'<html><a href="{target}">Continue to publication</a></html>'.encode()
        self.assertEqual(MODULE.public_archive_continue(html, target, notice), target)
        self.assertIsNone(MODULE.public_archive_continue(html, target, "https://evil.example/site/archivee-archived.html?url=" + quote(target, safe="")))
        self.assertIsNone(MODULE.public_archive_continue(html, target, notice + "&extra=1"))
        self.assertIsNone(MODULE.public_archive_continue(html.replace(target.encode(), b"https://evil.example/x.pdf"), target, notice))
        self.assertIsNone(MODULE.public_archive_continue(html, target, "https://publications.gc.ca/site/not-archive.html?url=" + quote(target, safe="")))

    def test_fetch_follows_one_publisher_link_with_notice_referer_and_keeps_notice_bytes(self):
        target = "https://publications.gc.ca/collections/collection_2012/arc-cra/Rv1-6-2002-eng.pdf"
        notice_url = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(target, safe="")
        notice_body = f'<html><a href="{target}">Continue to publication</a></html>'.encode()
        pdf_body = b"%PDF-1.7 source"
        opener = SequencedOpener([Response(notice_body, notice_url, "text/html"),
                                 Response(pdf_body, target, "application/pdf")])
        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener) as build:
            result = MODULE.fetch_pdf_with_evidence(target)
        body, final_url, status, media, evidence = result
        self.assertEqual((body, final_url, status, media), (pdf_body, target, 200, "application/pdf"))
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(opener.requests[0].full_url, target)
        self.assertEqual(opener.requests[1].full_url, target)
        self.assertEqual(opener.requests[1].get_header("Referer"), notice_url)
        self.assertEqual(evidence["noticeBody"], notice_body)
        self.assertEqual(evidence["targetUrl"], target)
        self.assertEqual(evidence["noticeSha256"], hashlib.sha256(notice_body).hexdigest())
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(handler, MODULE.urllib.request.HTTPCookieProcessor) for handler in handlers))

    def test_system_trust_curl_fallback_keeps_notice_continuation_same_origin(self):
        target = "https://publications.gc.ca/collections/direct.pdf"
        notice_url = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(target, safe="")
        notice_body = f'<a href="{target}">Continue to publication</a>'.encode()
        pdf_body = b"%PDF-1.7 curl fixture"
        calls = []

        def curl(command, capture_output, text):
            calls.append(command)
            output = Path(command[command.index("--output") + 1])
            requested = command[-1]
            if requested == target and "--referer" not in command:
                output.write_bytes(b"")
                stdout = "302\ntext/html\n" + notice_url
            elif requested == notice_url:
                output.write_bytes(notice_body)
                stdout = "200\ntext/html\n"
            else:
                output.write_bytes(pdf_body)
                stdout = "200\napplication/pdf\n"
            return MODULE.subprocess.CompletedProcess(command, 0, stdout, "")

        with mock.patch.object(MODULE.subprocess, "run", side_effect=curl):
            result = MODULE.fetch_pdf_curl(target, MODULE.ssl.SSLCertVerificationError("fixture"))
        self.assertEqual(result[:4], (pdf_body, target, 200, "application/pdf"))
        self.assertEqual(result[4]["noticeUrl"], notice_url)
        self.assertEqual(len(calls), 3)
        self.assertIn("--cookie-jar", calls[0])
        self.assertIn("--cookie", calls[2])
        self.assertEqual(calls[2][calls[2].index("--referer") + 1], notice_url)

    def test_system_trust_curl_continuation_rejects_cross_origin_redirect(self):
        target = "https://publications.gc.ca/collections/direct.pdf"
        command_seen = []

        def curl(command, capture_output, text):
            command_seen.append(command)
            Path(command[command.index("--output") + 1]).write_bytes(b"")
            return MODULE.subprocess.CompletedProcess(command, 0,
                "302\napplication/pdf\nhttps://www.canada.ca/redirected.pdf", "")

        with mock.patch.object(MODULE.subprocess, "run", side_effect=curl):
            with self.assertRaisesRegex(MODULE.FetchError, "continuation redirect changed publication origin"):
                MODULE.fetch_pdf_curl(target, MODULE.ssl.SSLCertVerificationError("fixture"),
                    referer="https://publications.gc.ca/site/archivee-archived.html?url=x", continued=True)
        self.assertEqual(len(command_seen), 1)

    def test_direct_publication_notice_replays_against_candidate_fetch_url(self):
        target = "https://publications.gc.ca/collections/direct.pdf"
        notice_url = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(target, safe="")
        notice_body = f'<a href="{target}">Continue to publication</a>'.encode()
        opener = SequencedOpener([Response(notice_body, notice_url, "text/html"),
                                 Response(b"%PDF-1.7 direct", target, "application/pdf")])
        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
            body, final, status, media, evidence = MODULE.fetch_pdf_with_evidence(target)
        self.assertEqual((body, final, status, media), (b"%PDF-1.7 direct", target, 200, "application/pdf"))
        self.assertEqual(evidence["targetUrl"], target)
        self.assertEqual(MODULE.collect_candidates({"issuerPages": [{"family": "departmental-plans", "language": "en",
            "reportLinks": [{"link_type": "direct-edition", "url": target, "label": "2024-2025 Plans",
                "year_label": "2024-2025"}]}]})[0]["fetchUrl"], target)

    def test_connection_reset_falls_back_to_trusted_curl_without_weakening_refusal_checks(self):
        target = "https://grainscanada.gc.ca/en/about-us/reports/planning-performance-reporting/report-plans-priorities/2014-2015/pdf/report-plans-priorities-2014-2015.pdf"
        body = b"%PDF-1.7 bounded grain fixture\n%%EOF"
        opener = SequencedOpener([])
        opener.open = mock.Mock(side_effect=urllib.error.URLError(ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")))

        def curl(command, capture_output, text):
            Path(command[command.index("--output") + 1]).write_bytes(body)
            return MODULE.subprocess.CompletedProcess(command, 0, "200\napplication/pdf\n", "")

        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener), \
             mock.patch.object(MODULE.subprocess, "run", side_effect=curl) as curl_run:
            result = MODULE.fetch_pdf_with_evidence(target)
        self.assertEqual(result[:4], (body, target, 200, "application/pdf"))
        self.assertIsNone(result[4])
        curl_args = curl_run.call_args.args[0]
        self.assertIn("=https", curl_args)
        self.assertNotIn("--insecure", curl_args)
        self.assertNotIn("-k", curl_args)

        forbidden = urllib.error.HTTPError(target, 403, "Forbidden", {}, None)
        refused_opener = SequencedOpener([])
        refused_opener.open = mock.Mock(side_effect=forbidden)
        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=refused_opener), \
             mock.patch.object(MODULE.subprocess, "run") as refused_curl:
            with self.assertRaisesRegex(MODULE.FetchError, "HTTP 403"):
                MODULE.fetch_pdf_with_evidence(target)
        refused_opener.open.assert_called_once()
        refused_curl.assert_not_called()

    def test_shared_fetch_pdf_keeps_its_four_value_interface(self):
        target = "https://publications.gc.ca/collections/direct.pdf"
        opener = SequencedOpener([Response(b"%PDF-1.7 source", target, "application/pdf")])
        with mock.patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
            result = MODULE.fetch_pdf(target)
        self.assertEqual(len(result), 4)
        self.assertEqual(result[1:], (target, 200, "application/pdf"))

    def test_refresh_and_replay_archive_both_official_alternates_and_notice_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            editions, store = base / "editions", base / "documents"
            editions.mkdir()
            issuer_page = {"family": "departmental-plans", "language": "en", "issuer_label": "Canada Revenue Agency",
                "issuer_key": "cra", "published_url": "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
                "source_index_url": "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
                "source_index_sha256": "index-hash", "reportLinks": []}
            for year, filename in [("2002-2003", "2002-03.pdf"), ("2003-2004", "2003-04.pdf")]:
                original = "https://epe.lac-bac.gc.ca/100/202/301/treasury_board/estimates_report_plans/canada_customs_revenue_agency/" + filename
                issuer_page["reportLinks"].append({"link_type": "direct-edition", "url": original,
                    "label": f"{year} Estimates (PDF)", "year_label": year, "landing_sha256": "landing-hash",
                    "evidence": "family-heading-and-year-link-label"})
            direct_url = "https://publications.gc.ca/collections/direct-rpp.pdf"
            issuer_page["reportLinks"].append({"link_type": "direct-edition", "url": direct_url,
                "label": "2003-2004 Report on Plans and Priorities (PDF)", "year_label": "2003-2004",
                "landing_sha256": "landing-hash", "evidence": "family-heading-and-year-link-label"})
            report = {"collection": "departmental-report-editions-current", "issuerPages": [issuer_page]}
            raw = json.dumps(report, sort_keys=True).encode()
            (editions / "current.json").write_bytes(raw)
            (editions / "latest-attempt.json").write_text(json.dumps({"runId": "fixture", "currentReportPath": "current.json",
                "currentReportSha256": hashlib.sha256(raw).hexdigest()}))

            def fake_fetch(url):
                self.assertIn(url, {item["resolvedUrl"] for item in MODULE.PUBLISHER_PDF_RECOVERIES.values()} | {direct_url})
                notice_url = "https://publications.gc.ca/site/archivee-archived.html?url=" + quote(url, safe="")
                notice_body = f'<a href="{url}">Continue to publication</a>'.encode()
                return (b"%PDF-1.7 checked fixture", url, 200, "application/pdf", {
                    "noticeUrl": notice_url, "targetUrl": url, "continueHref": url,
                    "noticeSha256": hashlib.sha256(notice_body).hexdigest(), "noticeBytes": len(notice_body),
                    "noticeBody": notice_body})

            text = "Canada Customs and Revenue Agency\n2002-2003 to 2004-2005\n2003-2004 Estimates\nReport on Plans and Priorities\nTable of Contents"
            with mock.patch.object(MODULE, "pdf_text", return_value=(text, 1)):
                result = MODULE.refresh(store, editions, workers=1,
                    max_archive_bytes=2 * MODULE.MAX_DOCUMENT_BYTES, min_free_bytes=0, fetcher=fake_fetch)
                replay = MODULE.replay(result["runId"], store)
            self.assertEqual(result["summary"]["fetchedTargets"], 3)
            self.assertEqual(result["summary"]["verifiedCitations"], 3)
            self.assertEqual(len(replay["documents"]), 3)
            self.assertTrue(all(doc["publisherNotice"]["targetUrl"] == doc["fetch_url"] for doc in replay["documents"]))
            self.assertEqual({c["publisherRecovery"]["issueYear"] for c in replay["citations"] if "publisherRecovery" in c},
                {"2002-2003", "2003-2004"})
            direct_citation = next(c for c in replay["citations"] if c["target_url"] == direct_url)
            self.assertNotIn("publisherRecovery", direct_citation)
            notice_path = store / replay["documents"][0]["publisherNotice"]["archivePath"]
            notice_path.write_bytes(b"tampered publisher notice")
            with self.assertRaisesRegex(OSError, "Not a gzipped file"):
                MODULE.replay(result["runId"], store)

    def test_legacy_failure_replay_works_without_new_sqlite_column_or_recovery_mapping(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            editions, store = base / "editions", base / "documents"
            editions.mkdir()
            original = next(iter(MODULE.PUBLISHER_PDF_RECOVERIES))
            source_report = {"collection": "departmental-report-editions-current", "issuerPages": [{
                "family": "departmental-plans", "language": "en", "issuer_label": "Canada Revenue Agency",
                "issuer_key": "cra", "published_url": "https://www.canada.ca/en/revenue-agency/",
                "source_index_url": "https://www.canada.ca/en/revenue-agency/", "source_index_sha256": "index",
                "reportLinks": [{"link_type": "direct-edition", "url": original, "label": "2002-2003 Estimates PDF",
                    "year_label": "2002-2003", "landing_sha256": "landing", "evidence": "source"}]}]}
            raw = json.dumps(source_report, sort_keys=True).encode()
            (editions / "current.json").write_bytes(raw)
            (editions / "latest-attempt.json").write_text(json.dumps({"runId": "legacy", "currentReportPath": "current.json",
                "currentReportSha256": hashlib.sha256(raw).hexdigest()}))

            def failed_fetch(_url):
                raise MODULE.FetchError("HTTP 404", 404)

            with mock.patch.object(MODULE.shutil, "disk_usage", return_value=type("Usage", (), {"free": 10**12})()):
                result = MODULE.refresh(store, editions, workers=1, max_archive_bytes=0, min_free_bytes=0, fetcher=failed_fetch)
            report_path = store / "generations" / f"{result['runId']}.json"
            legacy_report = json.loads(report_path.read_text())
            legacy_report.pop("schemaVersion", None)
            for citation in legacy_report["citations"]:
                citation.pop("publisherRecovery", None)
            report_path.write_text(json.dumps(legacy_report, sort_keys=True))
            report_sha = hashlib.sha256(report_path.read_bytes()).hexdigest()
            db_path = store / "documents.sqlite"
            with sqlite3.connect(db_path) as db:
                db.execute("UPDATE generations SET report_sha256=? WHERE run_id=?", (report_sha, result["runId"]))
                db.execute("UPDATE documents SET fetch_url=?,publisher_notice_json=NULL WHERE run_id=?", (original, result["runId"]))
                db.execute("ALTER TABLE documents DROP COLUMN publisher_notice_json")
            with mock.patch.object(MODULE, "open_db", wraps=MODULE.open_db) as open_db:
                replay = MODULE.replay(result["runId"], store)
            self.assertEqual(replay["status"], "partial")
            self.assertNotIn("schemaVersion", replay)
            self.assertTrue(open_db.call_args.kwargs["read_only"])


if __name__ == "__main__":
    unittest.main()
