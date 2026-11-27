import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/federal-regulatory-plans.py"
SPEC = importlib.util.spec_from_file_location("federal_regulatory_plans", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FederalRegulatoryPlansTests(unittest.TestCase):
    def fixture_roster(self, edition_root: Path) -> str:
        landing = (b"<!doctype html><html><head><title>Example Agency acts and regulations</title></head><body>"
                   b"<a href=\"https://agency.gc.ca/en/forward-regulatory-plan\">Forward Regulatory Plan</a>"
                   b"<a href=\"https://agency.gc.ca/en/forward-regulatory-plan\">Forward Regulatory Plan 2026-2028</a>"
                   b"<a href=\"https://agency.gc.ca/en/stock-review\">Regulatory Stock Review Plan</a>"
                   b"<a href=\"https://www.canada.ca/en/government-wide\">Government-wide Forward Regulatory Plans</a>"
                   b"</body></html>")
        landing_sha = hashlib.sha256(landing).hexdigest()
        object_path = Path("objects") / landing_sha[:2] / f"{landing_sha}.source.gz"
        target = edition_root / object_path
        target.parent.mkdir(parents=True)
        with target.open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as stream:
                stream.write(landing)
        report = {
            "collection": "departmental-report-editions-current",
            "issuerPages": [{
                "family": "regulatory-plans", "issuer_key": "example-agency",
                "issuer_label": "Example Agency", "issuer_attribution": "registered-legal-name-alias",
                "language": "en", "published_url": "https://agency.gc.ca/en/acts-regulations",
                "fetch_url": "https://agency.gc.ca/en/acts-regulations",
                "final_url": "https://agency.gc.ca/en/acts-regulations", "last_attempt_status": "fetched",
                "verified_at": "2026-11-25T00:00:00+00:00", "body_bytes": len(landing),
                "body_sha256": landing_sha, "object_path": object_path.as_posix(),
                "source_index_url": "https://www.canada.ca/en/official-regulatory-directory",
                "source_index_sha256": "a" * 64,
                "discoveryLinks": [
                    {"label": "Forward Regulatory Plan", "heading": "Plans", "url": "https://agency.gc.ca/en/forward-regulatory-plan",
                     "landing_sha256": landing_sha, "link_type": "index-link", "evidence": "publisher-label-or-heading-regulatory-context"},
                    {"label": "Forward Regulatory Plan 2026-2028", "heading": "Plans", "url": "https://agency.gc.ca/en/forward-regulatory-plan",
                     "landing_sha256": landing_sha, "link_type": "index-link", "evidence": "publisher-label-or-heading-regulatory-context"},
                    {"label": "Regulatory Stock Review Plan", "heading": "Plans", "url": "https://agency.gc.ca/en/stock-review",
                     "landing_sha256": landing_sha, "link_type": "index-link", "evidence": "publisher-label-or-heading-regulatory-context"},
                    {"label": "Government-wide Forward Regulatory Plans", "heading": "Plans", "url": "https://www.canada.ca/en/government-wide",
                     "landing_sha256": landing_sha, "link_type": "index-link", "evidence": "publisher-label-or-heading-regulatory-context"},
                ],
            }],
        }
        raw = json.dumps(report, sort_keys=True).encode()
        (edition_root / "current.json").write_bytes(raw)
        pointer = {"currentReportPath": "current.json", "currentReportSha256": hashlib.sha256(raw).hexdigest(),
                   "status": "partial", "runId": "source-run"}
        (edition_root / "latest-attempt.json").write_text(json.dumps(pointer))
        return "https://agency.gc.ca/en/forward-regulatory-plan"

    def test_refresh_confirms_plan_identity_archives_target_and_replay_is_read_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root, edition_root = Path(temp) / "plans", Path(temp) / "editions"
            edition_root.mkdir()
            url = self.fixture_roster(edition_root)
            body = (b"<!doctype html><html><head><title>Forward Regulatory Plan</title></head><body>"
                    b"<h1>Forward Regulatory Plan</h1><h2>Forward Regulatory Plan: 2026 to 2028</h2>"
                    b"<h2>Regulatory initiatives</h2><a href=\"https://agency.gc.ca/en/initiative\">Example emissions regulations</a>"
                    b"</body></html>")
            def fetch(target):
                self.assertEqual(target, url)
                return body, "text/html", target, len(body)

            result = MODULE.refresh(root, edition_root, max_archive_bytes=4 * MODULE.MAX_PAGE_BYTES,
                                    workers=1, fetcher=fetch)
            receipt = json.loads((root / "dist/receipt.json").read_text())
            report = json.loads((root / receipt["reportPath"]).read_text())
            self.assertEqual(result["status"], "complete")
            self.assertEqual(report["summary"]["verifiedPlanEditions"], 1)
            self.assertEqual(report["summary"]["discoveryLinks"], 4)
            self.assertEqual(len(report["planEditions"]), 1)
            edition = report["planEditions"][0]
            self.assertEqual(edition["issuerKey"], "example-agency")
            self.assertEqual(edition["planIdentity"], {"text": "Forward Regulatory Plan", "origin": "page-title"})
            self.assertEqual(edition["planCycles"][0]["cycle"], "2026-2028")
            self.assertEqual(len(edition["discoveryIds"]), 2)
            self.assertEqual(report["relatedInitiatives"][0]["name"], "Example emissions regulations")
            before = hashlib.sha256((root / receipt["reportPath"]).read_bytes()).hexdigest()
            replay = MODULE.replay(root, receipt["runId"])
            after = hashlib.sha256((root / receipt["reportPath"]).read_bytes()).hexdigest()
            self.assertTrue(replay["complete"])
            self.assertEqual(replay["verifiedArchives"], 1)
            self.assertEqual(before, after)

    def test_failure_retains_prior_verified_version_and_unconfirmed_page_is_not_a_plan(self):
        with tempfile.TemporaryDirectory() as temp:
            root, edition_root = Path(temp) / "plans", Path(temp) / "editions"
            edition_root.mkdir()
            url = self.fixture_roster(edition_root)
            verified = b"<html><head><title>Forward Regulatory Plan</title></head><body><h1>Forward Regulatory Plan</h1></body></html>"
            first = MODULE.refresh(root, edition_root, max_archive_bytes=4 * MODULE.MAX_PAGE_BYTES, workers=1,
                                   fetcher=lambda target: (verified, "text/html", target, len(verified)))
            def unavailable(_target):
                raise MODULE._editions.FetchError("publisher page unavailable", 503)
            second = MODULE.refresh(root, edition_root, max_archive_bytes=4 * MODULE.MAX_PAGE_BYTES, workers=1,
                                    fetcher=unavailable)
            latest = json.loads((root / "dist/receipt.json").read_text())
            report = json.loads((root / latest["reportPath"]).read_text())
            self.assertEqual(first["status"], "complete")
            self.assertEqual(second["status"], "partial")
            self.assertEqual(report["planEditions"], [])
            self.assertEqual(report["failures"][0]["failureCode"], "acquisition-failure")
            self.assertEqual(report["failures"][0]["httpStatus"], 503)
            self.assertEqual(len(report["failures"][0]["priorVerifiedVersions"]), 1)

            generic = b"<html><head><title>Government-wide regulatory plans and reports</title></head><body></body></html>"
            classified = MODULE.classify_target(generic, url, "en")
            self.assertFalse(classified["confirmed"])

    def test_https_fallback_is_limited_to_a_connection_reset(self):
        url = "https://agency.gc.ca/en/forward-regulatory-plan"
        curl_response = (b"body", "text/html", url, 4)
        with patch.object(MODULE._editions, "_fetch_with_platform_curl", return_value=curl_response) as curl:
            reset = MODULE._editions.FetchError("[Errno 104] Connection reset by peer")
            with patch.object(MODULE._editions, "fetch_page", side_effect=reset):
                self.assertEqual(MODULE.fetch_plan_page(url), curl_response)
            curl.assert_called_once_with(url, MODULE.MAX_PAGE_BYTES, reset)
            with patch.object(MODULE._editions, "fetch_page", side_effect=MODULE._editions.FetchError("HTTP 403", 403)):
                with self.assertRaisesRegex(MODULE._editions.FetchError, "HTTP 403"):
                    MODULE.fetch_plan_page(url)
            self.assertEqual(curl.call_count, 1)

    def test_target_section_heading_can_confirm_a_plan_but_generic_index_cannot(self):
        section = b"<html><head><title>Acts and Regulations</title></head><body><h1>Acts and Regulations</h1>" \
            b"<h3>Planned or anticipated changes to regulations (Forward Regulatory Plan)</h3></body></html>"
        confirmed = MODULE.classify_target(section, "https://agency.gc.ca/en/acts-regulations", "en")
        self.assertTrue(confirmed["confirmed"])
        self.assertEqual(confirmed["identityEvidence"]["origin"], "heading")
        self.assertFalse(MODULE.classify_target(
            b"<html><head><title>Government-wide regulatory plans and reports</title></head><body></body></html>",
            "https://www.canada.ca/en/regulatory-plans", "en")["confirmed"])

    def test_failed_latest_attempt_uses_only_checksum_verified_issuer_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            edition_root = Path(temp)
            self.fixture_roster(edition_root)
            report = json.loads((edition_root / "current.json").read_bytes())
            page = report["issuerPages"][0]
            page.update(last_attempt_status="failed", last_attempt_at="2026-11-26T20:00:00+00:00")
            discovery, candidates = MODULE.collect_discovery_links(report, edition_root)
            self.assertEqual(len(candidates), 1)
            self.assertEqual(discovery[0]["sourceCarryForward"], {
                "verifiedAt": "2026-11-25T00:00:00+00:00", "latestAttemptAt": "2026-11-26T20:00:00+00:00",
                "latestAttemptStatus": "failed",
            })
            page["discoveryLinks"][0]["landing_sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "not tied to a verified issuer landing page"):
                MODULE.collect_discovery_links(report, edition_root)

    def test_current_snapshot_and_landing_page_hashes_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root, edition_root = Path(temp) / "plans", Path(temp) / "editions"
            edition_root.mkdir()
            self.fixture_roster(edition_root)
            pointer = json.loads((edition_root / "latest-attempt.json").read_text())
            pointer["currentReportSha256"] = "0" * 64
            (edition_root / "latest-attempt.json").write_text(json.dumps(pointer))
            with self.assertRaisesRegex(ValueError, "latest-attempt pointer"):
                MODULE.refresh(root, edition_root, max_archive_bytes=4 * MODULE.MAX_PAGE_BYTES,
                               workers=1, fetcher=lambda _: self.fail("must not fetch"))


if __name__ == "__main__":
    unittest.main()
