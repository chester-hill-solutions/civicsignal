import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
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

    def test_exact_french_report_on_plans_title_verifies_plan_family(self):
        text = "Services partagés Canada\n2015-2016\nRapport sur les plans et les priorités\nTable des matières"
        candidate = {"family": "departmental-plans", "language": "fr", "issuerLabel": "Services partagés Canada",
                     "issueYear": "2015-2016", "url": "https://www.canada.ca/report.pdf"}
        assessment = MODULE.assess(text, candidate)
        self.assertEqual(assessment["familyDisposition"], "match")
        self.assertEqual(assessment["languageDisposition"], "match")
        self.assertEqual(assessment["yearDisposition"], "match")
        self.assertEqual(assessment["issuerDisposition"], "named-in-text")
        self.assertEqual(assessment["disposition"], "verified")
        self.assertEqual(MODULE.family_disposition(text, "departmental-results", "fr"), "unresolved")
        historical = MODULE.assess(text, candidate, semantics_version=2)
        self.assertEqual(historical["familyDisposition"], "unresolved")
        self.assertEqual(historical["disposition"], "review")
        # The same phrase in explanatory prose must not turn a results report into a plan.
        old_results = "Agence des douanes et du revenu du Canada\nRapport sur le rendement\n\f" \
            "Le Rapport sur les plans et les priorités fournit des détails sur la planification."
        self.assertEqual(MODULE.family_disposition(old_results, "departmental-plans", "fr"), "unresolved")

    def test_pdf_size_label_uses_printed_filename_year_only_in_new_schema(self):
        url = "https://www.canada.ca/content/dam/canada/military-grievances-external-review/migration/documents/rpp-2015-2016-fra.pdf"
        report = {"issuerPages": [{"family": "departmental-plans", "language": "fr", "issuer_label": "Comité externe d’examen des griefs militaires",
            "reportLinks": [{"link_type": "direct-edition", "url": url, "label": "PDF: 2000KB", "year_label": "2000"}]}]}
        historical = MODULE.collect_candidates(report)[0]
        current = MODULE.collect_candidates(report, use_pdf_filename_for_size_label=True)[0]
        self.assertEqual(historical["issueYear"], "2000")
        self.assertEqual(current["issueYear"], "2015-2016")
        self.assertEqual(MODULE.source_year("PDF: 2000KB", "2000", url,
            use_pdf_filename_for_size_label=True), "2015-2016")
        # A publisher-supplied fiscal range remains authoritative over the filename.
        self.assertEqual(MODULE.source_year("PDF: 2000KB", "2014-2015", url,
            use_pdf_filename_for_size_label=True), "2014-2015")
        no_year_url = "https://www.canada.ca/content/dam/canada/military-grievances-external-review/migration/documents/rpp/appendix-fra.pdf"
        self.assertIsNone(MODULE.source_year("PDF: 2000KB", "2000", no_year_url,
            use_pdf_filename_for_size_label=True))
        # Legacy schemas retain their historical source-label interpretation.
        self.assertEqual(MODULE.source_year("PDF: 2000KB", "2000", no_year_url), "2000")
        no_year_report = {"issuerPages": [{"family": "departmental-plans", "language": "fr",
            "reportLinks": [{"link_type": "direct-edition", "url": no_year_url,
                "label": "PDF: 2000KB", "year_label": "2000"}]}]}
        self.assertEqual(MODULE.collect_candidates(no_year_report)[0]["issueYear"], "2000")
        self.assertIsNone(MODULE.collect_candidates(no_year_report,
            use_pdf_filename_for_size_label=True)[0]["issueYear"])

    def test_public_continue_only_repeats_the_same_publisher_pdf_url(self):
        target = "https://publications.gc.ca/collections/example.pdf"
        body = (f'<a href="{target}">Continue to publication</a>').encode()
        notice = "https://publications.gc.ca/site/archivee-archived.html?url=" + MODULE.quote(target, safe="")
        self.assertEqual(MODULE.public_archive_continue(body, target, notice), target)
        self.assertIsNone(MODULE.public_archive_continue(body, "https://publications.gc.ca/collections/other.pdf", notice))
        self.assertIsNone(MODULE.public_archive_continue(b"Access denied", target, notice))

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

    def test_html_requires_title_or_h1_evidence_not_a_subheading(self):
        candidate = {"family": "departmental-plans", "language": "en", "issuerLabel": "Example Department",
                     "issueYear": "2024-2025", "yearLabel": "2024-2025", "url": "https://www.canada.ca/example",
                     "policyDisposition": "allowed"}
        body = b"""<html lang="en"><title>Annual publications</title><body><main>
        <h1>Publications</h1><h2>Departmental Plan 2024-2025</h2>
        <p>Example Department publishes several reports and plans for the public.</p>
        </main></body></html>"""
        assessment = MODULE.analyze_html(body, [candidate])["citations"][0]
        self.assertEqual(assessment["familyDisposition"], "mismatch")
        self.assertEqual(assessment["yearDisposition"], "mismatch")
        self.assertEqual(assessment["disposition"], "not-report")

    def test_html_parser_recovers_after_unclosed_svg_without_including_hidden_content(self):
        candidate = {"family": "departmental-results", "language": "en", "issuerLabel": "Office of the Information Commissioner of Canada",
                     "issueYear": "2023-2024", "yearLabel": "2023-2024", "url": "https://www.canada.ca/report",
                     "policyDisposition": "allowed"}
        body = b"""<html lang='en'><body><svg><defs><style>.mark { fill:red }</style></defs><path>decorative SVG words</path>
        <div class='page'><nav>navigation words to exclude</nav><main>
        <h1>Departmental Results Report 2023-2024</h1>
        <script>script words should not appear</script><style>hidden style text</style>
        <p>Office of the Information Commissioner of Canada reports on results from 2023 to 2024, including
        the completed activities, performance information, and progress against the commitments described in its plan.</p>
        <svg><foreignObject><div>foreign object content remains hidden</div></foreignObject><path>more decoration</path></svg>
        <p>Visible report text continues after the embedded artwork.</p></main></div></body></html>"""
        parsed = MODULE.analyze_html(body, [candidate])
        assessment = parsed["citations"][0]
        self.assertEqual(assessment["disposition"], "accepted")
        self.assertIn("Departmental Results Report 2023-2024", parsed["h1s"])
        for hidden in ("decorative SVG", "navigation words", "script words", "hidden style", "foreign object content"):
            self.assertNotIn(hidden, parsed["text"])
        self.assertIn("Visible report text continues", parsed["text"])

    def test_html_archive_reassessment_preserves_fetch_time_and_replays(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); edition=base/"edition"; store=base/"store"; edition.mkdir()
            url="https://www.canada.ca/en/example/departmental-results-2023-2024"
            report={"collection":"departmental-report-editions-current","issuerPages":[{
                "family":"departmental-results","language":"en","issuer_label":"Office of the Information Commissioner of Canada",
                "issuer_key":"oic","published_url":"https://www.canada.ca/en/oic/reports",
                "source_index_url":"https://www.canada.ca/directory","source_index_sha256":"index-hash",
                "reportLinks":[{"link_type":"index-link","url":url,"label":"Departmental Results Report 2023-2024",
                    "year_label":"2023-2024","landing_sha256":"landing-hash","evidence":"label"}]}]}
            raw=json.dumps(report,sort_keys=True).encode(); (edition/"current.json").write_bytes(raw)
            (edition/"latest-attempt.json").write_text(json.dumps({"runId":"edition-run","currentReportPath":"current.json",
                "currentReportSha256":hashlib.sha256(raw).hexdigest()}))
            html=b"<html lang='en'><body><svg><path>decoration</path><div><main><h1>Departmental Results Report 2023-2024</h1><p>Office of the Information Commissioner of Canada reports the results for 2023-2024, including completed commitments, service outcomes, and details of the work delivered this year.</p></main></div></body></html>"
            fetched=[]
            def fetch(target): fetched.append(target); return html,target,200,"text/html"
            with mock.patch.object(MODULE,"fetch_html",side_effect=fetch):
                initial=MODULE.html_refresh(store,edition,batch_size=1,fetcher=fetch)
            db=sqlite3.connect(store/"documents.sqlite")
            before=db.execute("SELECT attempted_at FROM html_targets WHERE source_report_sha256=? AND target_url=?",
                (initial["sourceCurrentReportSha256"],url)).fetchone()[0]
            db.close()
            reassessed=MODULE.html_reassess([url],store)
            replay=MODULE.html_replay(reassessed["runId"],store)
            db=sqlite3.connect(store/"documents.sqlite")
            after=db.execute("SELECT attempted_at,status FROM html_targets WHERE source_report_sha256=? AND target_url=?",
                (initial["sourceCurrentReportSha256"],url)).fetchone()
            db.close()
            self.assertEqual(fetched,[url])
            self.assertEqual(before,after[0])
            self.assertEqual(after[1],"fetched")
            self.assertEqual(reassessed["citationDispositionCounts"],{"accepted":1})
            self.assertEqual(replay["reassessment"]["networkAccess"],False)

    def test_html_queue_is_bounded_resumable_and_replayable(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            edition_root, store = base / "edition", base / "documents"
            edition_root.mkdir()
            rows = []
            for language, year, label, url, issuer in [
                ("en", "2024-2025", "Departmental Plan 2024-2025", "https://www.canada.ca/en/example/plan-2024", "Example Department"),
                ("en", "2023-2024", "Departmental Plan 2023-2024", "https://www.canada.ca/en/example/plan-2023", "Example Department"),
                ("fr", "2022-2023", "Plan ministériel 2022 à 2023", "https://www.canada.ca/fr/example/plan-2022", "Ministère Exemple"),
            ]:
                rows.append({"family": "departmental-plans", "language": language, "issuer_label": issuer,
                    "issuer_key": "example-" + language, "published_url": "https://www.canada.ca/directory/" + language,
                    "source_index_url": "https://www.canada.ca/directory", "source_index_sha256": "indexhash",
                    "reportLinks": [{"link_type": "index-link", "url": url, "label": label,
                        "year_label": year, "landing_sha256": "landinghash", "evidence": "label"}]})
            rows[0]["reportLinks"].append({"link_type": "index-link", "url": rows[0]["reportLinks"][0]["url"],
                "label": "Departmental Plan 2024-2025 at a glance", "year_label": "2024-2025",
                "landing_sha256": "landinghash", "evidence": "label"})
            report = {"collection": "departmental-report-editions-current", "issuerPages": rows}
            raw = json.dumps(report, sort_keys=True).encode()
            (edition_root / "current.json").write_bytes(raw)
            digest = hashlib.sha256(raw).hexdigest()
            (edition_root / "latest-attempt.json").write_text(json.dumps({
                "runId": "edition-html", "currentReportPath": "current.json", "currentReportSha256": digest}))
            en_html = b"<html lang='en'><title>Departmental Plan 2024-2025</title><body><main><h1>Departmental Plan 2024-2025</h1><p>Example Department presents this departmental plan for the year 2024-2025, with details and expected outcomes, planned activities, performance indicators, and financial information.</p></main></body></html>"
            fr_html = "<html lang='fr'><title>Plan ministériel 2022 à 2023</title><body><main><h1>Plan ministériel 2022 à 2023</h1><p>Ministère Exemple présente ce plan ministériel pour l'exercice 2022-2023 avec des détails et résultats attendus.</p></main></body></html>".encode()
            urls = [x["reportLinks"][0]["url"] for x in rows]
            calls = []
            def fake_fetch(url):
                calls.append(url)
                if url == urls[0]: return en_html, url, 200, "text/html"
                if url == urls[1]: return b"%PDF-1.7 not html", url, 200, "application/pdf"
                raise MODULE.HtmlFetchError("HTTP 403", 403)
            with mock.patch.object(MODULE, "fetch_html", side_effect=fake_fetch):
                first = MODULE.html_refresh(store, edition_root, batch_size=2,
                    priority_urls=[urls[0], urls[1]], fetcher=fake_fetch)
                self.assertEqual(first["processedTargets"], 2)
                self.assertEqual(first["remainingPending"], 1)
                self.assertEqual(first["targetStatusCounts"]["fetched"], 1)
                self.assertEqual(first["targetStatusCounts"]["wrong-kind"], 1)
                replayed = MODULE.html_replay(first["runId"], store)
                resumed = MODULE.html_refresh(store, edition_root, batch_size=2, fetcher=fake_fetch)
                repeated = MODULE.html_refresh(store, edition_root, batch_size=2, fetcher=fake_fetch)
            self.assertEqual(replayed["candidateTargets"], 3)
            self.assertEqual(replayed["candidateCitations"], 4)
            self.assertEqual(resumed["processedTargets"], 1)
            self.assertEqual(resumed["remainingPending"], 0)
            self.assertEqual(resumed["targetStatusCounts"]["source-refused"], 1)
            self.assertEqual(repeated["processedTargets"], 0)
            self.assertEqual(repeated["remainingPending"], 0)
            self.assertEqual(len(calls), 3)

    def test_html_new_inventory_reuses_recent_evidence_then_rechecks_due_url(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); edition=base/"edition"; store=base/"store"; edition.mkdir()
            url="https://www.canada.ca/en/sample/departmental-plan-2024-2025"
            row={"family":"departmental-plans","language":"en","issuer_label":"Sample Department",
                 "issuer_key":"sample","published_url":"https://www.canada.ca/en/sample/reports",
                 "source_index_url":"https://www.canada.ca/directory","source_index_sha256":"idx1",
                 "reportLinks":[{"link_type":"index-link","url":url,"label":"Departmental Plan 2024-2025",
                     "year_label":"2024-2025","landing_sha256":"land1","evidence":"label"}]}
            def publish(index_hash):
                report={"collection":"departmental-report-editions-current","issuerPages":[{**row,"source_index_sha256":index_hash}]}
                raw=json.dumps(report,sort_keys=True).encode(); (edition/"current.json").write_bytes(raw)
                (edition/"latest-attempt.json").write_text(json.dumps({"runId":"source-"+index_hash,
                    "currentReportPath":"current.json","currentReportSha256":hashlib.sha256(raw).hexdigest()}))
            html=b"<html lang='en'><title>Departmental Plan 2024-2025</title><body><main><h1>Departmental Plan 2024-2025</h1><p>Sample Department describes this departmental plan for 2024-2025, including planned work and results for Canadians.</p></main></body></html>"
            calls=[]
            def fetch(target): calls.append(target); return html,target,200,"text/html"
            publish("idx1")
            first=MODULE.html_refresh(store,edition,batch_size=1,fetcher=fetch)
            self.assertEqual(first["processedTargets"],1)
            self.assertEqual(first["citations"][0]["status"],"accepted")
            publish("idx2")
            carried=MODULE.html_refresh(store,edition,batch_size=1,fetcher=lambda _url: self.fail("recent URL should be carried forward"))
            self.assertEqual(carried["processedTargets"],0)
            self.assertEqual(carried["targetStatusCounts"]["fetched"],1)
            self.assertEqual(carried["byFamilyLanguage"]["departmental-plans/en"]["accepted"],1)
            db=sqlite3.connect(store/"documents.sqlite")
            db.execute("UPDATE html_targets SET attempted_at=? WHERE source_report_sha256=?",(
                (MODULE.dt.datetime.now(MODULE.dt.timezone.utc)-MODULE.dt.timedelta(days=8)).isoformat(timespec="seconds"),
                carried["sourceCurrentReportSha256"]))
            db.commit();db.close()
            due=MODULE.html_refresh(store,edition,batch_size=1,fetcher=fetch)
            self.assertEqual(due["processedTargets"],1)
            self.assertEqual(due["remainingPending"],0)
            self.assertEqual(len(calls),2)
            audit=MODULE.html_audit(store,edition)
            self.assertEqual(audit["candidateTargets"],1)
            self.assertEqual(audit["candidateCitations"],1)
            self.assertEqual(audit["acceptedCitations"],1)
            self.assertEqual(audit["status"],"complete")
            self.assertEqual(audit["replayStatus"],"verified")

    def test_html_new_inventory_reassesses_carried_body_and_updates_readability(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); edition=base/"edition"; store=base/"store"; edition.mkdir()
            url="https://www.canada.ca/en/sample/departmental-plan-2024-2025"
            page={"family":"departmental-plans","language":"en","issuer_label":"Sample Department",
                  "issuer_key":"sample","published_url":"https://www.canada.ca/en/sample/reports",
                  "source_index_url":"https://www.canada.ca/directory","source_index_sha256":"index-one",
                  "reportLinks":[{"link_type":"index-link","url":url,"label":"Departmental Plan 2024-2025",
                      "year_label":"2024-2025","landing_sha256":"landing-hash","evidence":"label"}]}
            def publish(index_hash):
                report={"collection":"departmental-report-editions-current","issuerPages":[{**page,"source_index_sha256":index_hash}]}
                raw=json.dumps(report,sort_keys=True).encode(); (edition/"current.json").write_bytes(raw)
                (edition/"latest-attempt.json").write_text(json.dumps({"runId":"source-"+index_hash,
                    "currentReportPath":"current.json","currentReportSha256":hashlib.sha256(raw).hexdigest()}))
            html=b"<html lang='en'><head><title>Departmental Plan 2024-2025</title></head><body><svg><path>artwork</path><div><main><h1>Departmental Plan 2024-2025</h1><p>Sample Department describes this departmental plan for 2024-2025, including planned activities, expected outcomes, performance measures, and financial information for the coming year.</p></main></div></body></html>"
            publish("index-one")
            with mock.patch.object(MODULE,"analyze_html",side_effect=MODULE.analyze_html_legacy), \
                 mock.patch.object(MODULE,"HTML_PARSER_VERSION",1):
                old=MODULE.html_refresh(store,edition,batch_size=1,fetcher=lambda target:(html,target,200,"text/html"))
            db=sqlite3.connect(store/"documents.sqlite")
            before=db.execute("SELECT status,attempted_at,readable_chars FROM html_targets WHERE source_report_sha256=? AND target_url=?",
                (old["sourceCurrentReportSha256"],url)).fetchone()
            db.close()
            self.assertEqual(before[0],"unreadable")
            self.assertLess(before[2],100)
            publish("index-two")
            new=MODULE.html_refresh(store,edition,batch_size=1,fetcher=lambda _target:self.fail("archived body should be reused"))
            db=sqlite3.connect(store/"documents.sqlite")
            after=db.execute("SELECT status,attempted_at,readable_chars,text_sha256 FROM html_targets WHERE source_report_sha256=? AND target_url=?",
                (new["sourceCurrentReportSha256"],url)).fetchone()
            citation=db.execute("SELECT status FROM html_citations WHERE source_report_sha256=? AND target_url=?",
                (new["sourceCurrentReportSha256"],url)).fetchone()
            db.close()
            self.assertEqual(after[0],"fetched")
            self.assertEqual(after[1],before[1],"publisher fetch time remains the original archive time")
            self.assertGreater(after[2],100)
            self.assertEqual(citation[0],"accepted")
            self.assertEqual(new["targetStatusCounts"]["fetched"],1)
            self.assertEqual(new["byFamilyLanguage"]["departmental-plans/en"]["accepted"],1)


if __name__ == "__main__":
    unittest.main()
