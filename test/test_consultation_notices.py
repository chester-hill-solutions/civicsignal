import importlib.util
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("consultation_notices", ROOT / "scripts/consultation-notices.py")
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)


class NoticeParserTests(unittest.TestCase):
    def test_extracts_only_exact_labeled_english_and_french_sections(self):
        html = b"""<h2 id='eligible'>Who can participate?</h2><p>Canadian residents may respond.</p>
        <h2 id='other'>Background</h2><p>This must not be extracted.</p>
        <h3 id='date-limite'>Date limite</h3><p>Submit by June 4.</p>
        <h2 id='soumettre'>Comment soumettre</h2><p>Send the form to the department.</p>
        <h2>Contact</h2><p>Other text.</p>"""
        sections = notices.parse_sections(html)
        self.assertEqual([s["kind"] for s in sections], ["eligibility", "deadline", "submission-instructions"])
        self.assertEqual(sections[0]["heading"], "Who can participate?")
        self.assertEqual(sections[0]["fragment"], "eligible")
        self.assertEqual(sections[0]["text"], "Canadian residents may respond.")
        self.assertEqual(sections[1]["text"], "Submit by June 4.")
        self.assertEqual(sections[2]["text"], "Send the form to the department.")
        self.assertNotIn("Background", json.dumps(sections))
        self.assertEqual(notices.classify_heading("How to submit comments"), "submission-instructions")
        self.assertEqual(notices.classify_heading("Comment déposer des commentaires"), "submission-instructions")

    def test_host_policy_rejects_unrecognized_published_link(self):
        self.assertEqual(notices.local_link({"kind": "missing", "published": None, "url": None})[0], "missing-link")
        status, _, detail = notices.local_link({"kind": "official", "published": "https://example.com/n", "url": "https://example.com/n"})
        self.assertEqual(status, "unrecognized-host")
        self.assertIn("official-host", detail)
        self.assertEqual(notices.local_link({"kind": "official", "published": "S/O", "url": "S/O"})[0], "unrecognized-url")
        self.assertEqual(notices.local_link({"kind": "official", "published": "S/O", "url": "https://S/O"})[0], "unrecognized-url")

    def test_accepts_only_the_exact_agency_linked_engagement_hosts(self):
        for host in ("www.cerdialogue.ca", "dialogueregie.ca", "www.letstalktransportation.ca", "parlonstransport.ca"):
            self.assertTrue(notices.notice_official(f"https://{host}/consultation"))
        for url in (
            "http://www.letstalktransportation.ca/OPP",
            "https://sub.www.cerdialogue.ca/consultation",
            "https://parlonstransport.ca.example.org/PPO",
        ):
            self.assertFalse(notices.notice_official(url))

    def test_unwraps_only_a_single_official_safelinks_destination_without_fetching_wrapper(self):
        safe = "https://can01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.cer-rec.gc.ca%2Fen%2Fconsultation"
        target = "https://www.cer-rec.gc.ca/en/consultation"
        profile = {"kind": "third-party-wrapper", "published": safe, "unwrapped": target, "url": target}
        self.assertEqual(notices.local_link(profile),
                         ("pending", target, None))
        external = safe.replace("https%3A%2F%2Fwww.cer-rec.gc.ca%2Fen%2Fconsultation",
                                "https%3A%2F%2Fexample.org%2Fconsultation")
        self.assertEqual(notices.local_link({"kind": "third-party-wrapper", "published": external,
                                             "url": "https://example.org/consultation"})[0],
                         "unrecognized-link-kind")
        lookalike = safe.replace("can01.safelinks.protection.outlook.com", "can01.safelinks.protection.outlook.com.example.org")
        self.assertEqual(notices.local_link({"kind": "third-party-wrapper", "published": lookalike, "url": lookalike})[0],
                         "unrecognized-link-kind")

    def test_maps_only_the_two_legacy_cta_routes_to_official_current_paths(self):
        pairs = {
            "https://otc-cta.gc.ca/eng/consultation/cpkc-vancouver-logistics-park-consultation":
                "https://otc-cta.gc.ca/eng/cpkc-vancouver-logistics-park-consultation",
            "https://otc-cta.gc.ca/fra/consultation/consultation-sur-parc-logistique-vancouver-cpkc":
                "https://otc-cta.gc.ca/fra/cpkc-vancouver-logistics-park-consultation",
        }
        for old, current in pairs.items():
            self.assertEqual(notices.local_link({"kind": "official", "published": old, "url": old}),
                             ("pending", current, None))
        untouched = "https://otc-cta.gc.ca/eng/consultation/other"
        self.assertEqual(notices.current_publication_url(untouched), untouched)

    def test_splits_only_well_formed_dual_official_profile_urls(self):
        composite = "https://species-registry.canada.ca/index-en.html#/documents/first%20;%20https://species-registry.canada.ca/index-en.html#/documents/second"
        self.assertEqual(notices.split_profile_urls(composite), [
            "https://species-registry.canada.ca/index-en.html#/documents/first",
            "https://species-registry.canada.ca/index-en.html#/documents/second",
        ])
        self.assertEqual(notices.split_profile_urls("https://species-registry.canada.ca/x;a"),
                         ["https://species-registry.canada.ca/x;a"])

    def test_esdc_preview_urls_resolve_only_when_a_public_notice_is_known(self):
        paths = ["/en/employment-social-development/programs/sustainable-development-goals/2026-vnr-consultation.html",
                 "/fr/emploi-developpement-social/programmes/objectifs-durable/2026-consultation-env.html"]
        for path in paths:
            preview = "https://canada-preview.adobecqms.net" + path
            self.assertEqual(notices.local_link({"kind": "official", "published": preview, "url": preview}),
                             ("pending", "https://www.canada.ca" + path, None))
            self.assertEqual(notices.local_link({"kind": "official", "url": preview + "?other"})[0], "unrecognized-host")


class RefreshTests(unittest.TestCase):
    def make_catalogue(self, path, revision="rev-1", url="https://www.canada.ca/en/notice.html"):
        db = sqlite3.connect(path)
        db.executescript("""CREATE TABLE consultations_catalogues(source,observed_at,revision);
        CREATE TABLE consultations_records(id,state_at_observation,observed_at,revision,facts_json,removed_at);""")
        observed = "2026-11-24T00:00:00Z"
        db.execute("INSERT INTO consultations_catalogues VALUES('canada',?,?)", (observed, revision))
        facts = {"id":"consult_17", "editions":{
            "en":{"profile":{"kind":"official","published":url,"url":url}},
            "fr":{"profile":{"kind":"missing","published":None,"url":None}},
        }}
        db.execute("INSERT INTO consultations_records VALUES(?,?,?,?,?,NULL)",
                   ("consult_17", "open", observed, revision, json.dumps(facts)))
        db.commit(); db.close()

    def test_refresh_records_missing_and_archives_exact_current_revision(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite"
            self.make_catalogue(catalogue)
            calls = []
            def fake_fetch(url):
                calls.append(url)
                return (b"<h2 id='eligibility'>Eligibility</h2><p>Open to all residents.</p>", "text/html", url)
            with patch.object(notices, "archive_body", return_value=("abc123", "data/corpus/consultations/notice-objects/abc.html.gz")):
                result = notices.refresh(catalogue, store, fetcher=fake_fetch, receipt_root=Path(d)/"receipts")
            self.assertEqual(calls, ["https://www.canada.ca/en/notice.html"])
            self.assertEqual(result["counts"]["fetched"], 1)
            self.assertEqual(result["counts"]["missing-link"], 1)
            response = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(response["catalogueRevision"], "rev-1")
            self.assertEqual(response["sections"][0]["text"], "Open to all residents.")
            gap = notices.query("consult_17", "fr", store=store, catalogue=catalogue)
            self.assertEqual(gap["status"], "missing-link")

    def test_changed_catalogue_revision_fetches_changed_link(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite"
            self.make_catalogue(catalogue)
            seen = []
            with patch.object(notices, "archive_body", return_value=("abc123", "notice-objects/abc.html.gz")):
                notices.refresh(catalogue, store, fetcher=lambda url: (seen.append(url) or b"<h2>Deadline</h2><p>Dec 1</p>", "text/html", url), receipt_root=Path(d)/"receipts")
                db = sqlite3.connect(catalogue)
                db.execute("UPDATE consultations_catalogues SET observed_at=?,revision=?", ("2026-11-25T00:00:00Z", "rev-2"))
                db.execute("UPDATE consultations_records SET observed_at=?,revision=?,facts_json=replace(facts_json, 'https://www.canada.ca/en/notice.html','https://www.canada.ca/en/new.html')",
                           ("2026-11-25T00:00:00Z", "rev-2"))
                db.commit(); db.close()
                notices.refresh(catalogue, store, fetcher=lambda url: (seen.append(url) or b"<h2>Deadline</h2><p>Dec 1</p>", "text/html", url), receipt_root=Path(d)/"receipts")
            self.assertEqual(seen, ["https://www.canada.ca/en/notice.html", "https://www.canada.ca/en/new.html"])
            self.assertEqual(notices.query("consult_17", "en", store=store, catalogue=catalogue)["catalogueRevision"], "rev-2")

    def test_dual_notice_urls_archive_independent_provenance_and_order(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store, receipts = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite", Path(d)/"receipts"
            composite = "https://species-registry.canada.ca/index-en.html#/documents/first%20;%20https://species-registry.canada.ca/index-en.html#/documents/second"
            self.make_catalogue(catalogue, url=composite)
            urls = notices.split_profile_urls(composite)
            bodies = {
                urls[0]: b"<h2 id='deadline'>Deadline</h2><p>Send comments by November 30.</p>",
                urls[1]: b"<h2 id='eligible'>Who may participate?</h2><p>Residents of Waterton Lakes.</p>",
            }
            def fake_fetch(url):
                return bodies[url], "text/html", url
            def fake_archive(body):
                digest = hashlib.sha256(body).hexdigest()
                return digest, f"data/corpus/consultations/notice-objects/{digest}.html.gz"
            with patch.object(notices, "archive_body", side_effect=fake_archive):
                result = notices.refresh(catalogue, store, fetcher=fake_fetch, receipt_root=receipts,
                                         consultation_ids={"consult_17"})
            self.assertEqual(result["counts"]["fetched"], 2)
            self.assertEqual(result["scope"], "selected")
            self.assertEqual(result["selectedConsultationIds"], ["consult_17"])
            query = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(query["status"], "fetched")
            self.assertIsNone(query["bodySha256"], "an edition with two distinct publishers must not claim one source hash")
            self.assertEqual([source["sourceUrl"] for source in query["sources"]], urls)
            self.assertEqual([section["sourceUrl"] for section in query["sections"]], urls)
            self.assertEqual([section["kind"] for section in query["sections"]], ["deadline", "eligibility"])
            self.assertEqual(query["sections"][0]["bodySha256"], query["sources"][0]["bodySha256"])
            old_first_hash = query["sources"][0]["bodySha256"]
            def retry_with_one_failure(url):
                if url == urls[0]:
                    raise OSError("temporary failure")
                return b"<h2 id='eligible'>Who may participate?</h2><p>Updated source.</p>", "text/html", url
            with patch.object(notices, "archive_body", side_effect=fake_archive):
                notices.refresh(catalogue, store, fetcher=retry_with_one_failure, receipt_root=receipts,
                                consultation_ids={"consult_17"})
            retried = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(retried["status"], "fetched")
            self.assertEqual(retried["lastAttemptStatus"], "partial")
            self.assertEqual(retried["sources"][0]["bodySha256"], old_first_hash)
            self.assertEqual(retried["sources"][0]["lastAttemptStatus"], "fetch-error")

    def test_cta_current_route_keeps_catalogue_url_and_archives_current_official_source(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store, receipts = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite", Path(d)/"receipts"
            old = "https://otc-cta.gc.ca/eng/consultation/cpkc-vancouver-logistics-park-consultation"
            current = "https://otc-cta.gc.ca/eng/cpkc-vancouver-logistics-park-consultation"
            self.make_catalogue(catalogue, url=old)
            calls = []
            def fake_fetch(url):
                calls.append(url)
                return b"<h2 id='submit'>How to submit comments</h2><p>Use the official form by December 21.</p>", "text/html", url
            with patch.object(notices, "archive_body", return_value=("c" * 64, "notice-objects/current.html.gz")):
                notices.refresh(catalogue, store, fetcher=fake_fetch, receipt_root=receipts, consultation_ids={"consult_17"})
            result = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(calls, [current])
            self.assertEqual(result["status"], "fetched")
            self.assertEqual(result["sourceUrl"], old)
            self.assertEqual(result["sources"][0]["sourceUrl"], current)
            self.assertEqual(result["sources"][0]["catalogueUrl"], old)
            self.assertEqual(result["sections"][0]["sourceUrl"], current)

    def test_safelinks_wrapper_keeps_original_catalogue_url_and_fetches_official_target(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store, receipts = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite", Path(d)/"receipts"
            original = "https://can01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.cer-rec.gc.ca%2Fen%2Fabout%2Fhow-we-regulate%2F&data=tracking"
            target = "https://www.cer-rec.gc.ca/en/about/how-we-regulate/"
            self.make_catalogue(catalogue, url=original)
            db = sqlite3.connect(catalogue)
            row = db.execute("SELECT facts_json FROM consultations_records WHERE id='consult_17'").fetchone()
            facts = json.loads(row[0])
            facts["editions"]["en"]["profile"]["kind"] = "third-party-wrapper"
            facts["editions"]["en"]["profile"]["unwrapped"] = target
            facts["editions"]["en"]["profile"]["url"] = target
            db.execute("UPDATE consultations_records SET facts_json=? WHERE id='consult_17'", (json.dumps(facts),))
            db.commit()
            db.close()
            calls = []
            def fake_fetch(url):
                calls.append(url)
                return b"<h2 id='eligible'>Who can participate?</h2><p>All stakeholders.</p>", "text/html", url
            with patch.object(notices, "archive_body", return_value=("d" * 64, "notice-objects/cer.html.gz")):
                notices.refresh(catalogue, store, fetcher=fake_fetch, receipt_root=receipts, consultation_ids={"consult_17"})
            result = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(calls, [target])
            self.assertEqual(result["sourceUrl"], original)
            self.assertEqual(result["sources"][0]["sourceUrl"], target)
            self.assertEqual(result["sources"][0]["catalogueUrl"], original)
            self.assertEqual(result["sections"][0]["sourceUrl"], target)

    def test_old_citation_survives_failed_first_fetch_at_new_publisher_route(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store, receipts = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite", Path(d)/"receipts"
            old, current = next(iter(notices.CURRENT_PUBLICATION_URLS.items()))
            self.make_catalogue(catalogue, url=old)
            with patch.dict(notices.CURRENT_PUBLICATION_URLS, clear=True), patch.object(
                    notices, "archive_body", return_value=("d" * 64, "notice-objects/earlier.html.gz")):
                notices.refresh(catalogue, store, fetcher=lambda url: (b"<h2>Eligibility</h2><p>Residents.</p>", "text/html", url),
                                receipt_root=receipts)

            def offline(url):
                self.assertEqual(url, current)
                raise OSError("publisher offline")

            notices.refresh(catalogue, store, fetcher=offline, receipt_root=receipts)
            result = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(result["sources"][0]["bodySha256"], "d" * 64)
            self.assertEqual(result["sections"][0]["sourceUrl"], old)
            self.assertEqual(result["sources"][0]["lastAttemptStatus"], "fetch-error")

    def test_failed_retry_keeps_published_bytes_and_records_attempt_separately(self):
        with tempfile.TemporaryDirectory() as d:
            catalogue, store, receipts = Path(d)/"catalogue.sqlite", Path(d)/"notice.sqlite", Path(d)/"receipts"
            self.make_catalogue(catalogue)
            with patch.object(notices, "archive_body", return_value=("realhash", "notice-objects/realhash.html.gz")):
                notices.refresh(catalogue, store, fetcher=lambda url: (b"<h2>Eligibility</h2><p>Residents.</p>", "text/html", url), receipt_root=receipts)
                notices.refresh(catalogue, store, fetcher=lambda url: (_ for _ in ()).throw(OSError("temporary DNS failure")), receipt_root=receipts)
            result = notices.query("consult_17", "en", store=store, catalogue=catalogue)
            self.assertEqual(result["status"], "fetched")
            self.assertEqual(result["bodySha256"], "realhash")
            self.assertEqual(result["lastAttemptStatus"], "partial")
            self.assertEqual(result["sources"][0]["lastAttemptStatus"], "fetch-error")
            self.assertIn("temporary DNS failure", result["lastAttemptDetail"])
            receipt = json.loads((receipts/"latest.json").read_text())
            self.assertEqual(receipt["publishedFetchedEditions"], 1)
            self.assertEqual(receipt["counts"]["fetch-error"], 1)


if __name__ == "__main__":
    unittest.main()
