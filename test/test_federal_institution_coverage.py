from collections import defaultdict
import hashlib
import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile


scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("institution_coverage", scripts / "federal-institution-coverage.py")
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class InstitutionCoverageTests(unittest.TestCase):
    def test_publications_count_only_uniquely_identified_explicit_publishers_and_bind_archives(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            corpus = Path(temporary)
            root = corpus / "federal-publications"
            generation = root / "generations" / "sample"
            archive_dir = generation / "archives"
            archive_dir.mkdir(parents=True)
            collection = '''<?xml version="1.0"?><modsCollection xmlns="http://www.loc.gov/mods/v3">
              <mods><recordInfo><recordIdentifier>1</recordIdentifier></recordInfo><originInfo><publisher>Known Agency</publisher></originInfo></mods>
              <mods><recordInfo><recordIdentifier>2</recordIdentifier></recordInfo><originInfo><publisher>Unknown Ministry</publisher></originInfo></mods>
              <mods><recordInfo><recordIdentifier>3</recordIdentifier></recordInfo></mods>
              <mods><originInfo><publisher>Known Agency</publisher></originInfo></mods>
              <mods><recordInfo><recordIdentifier>dup</recordIdentifier></recordInfo><originInfo><publisher>Known Agency</publisher></originInfo></mods>
              <mods><recordInfo><recordIdentifier>dup</recordIdentifier></recordInfo><originInfo><publisher>Unknown Ministry</publisher></originInfo></mods>
            </modsCollection>'''.encode()
            resources = {}
            for category in ("monographs", "periodicals", "series"):
                archive = archive_dir / (category + ".zip")
                with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
                    output.writestr("records.xml", collection)
                raw = archive.read_bytes()
                resources[category] = {"snapshotDate": "2025-11-20", "sha256": hashlib.sha256(raw).hexdigest(),
                    "archiveBytes": len(raw), "recordCount": 6, "id": category, "url": "https://publications.gc.ca/" + category}
            (generation / "receipt.json").write_text(json.dumps({"series": "publications", "snapshotDate": "2025-11-20", "resources": resources}))
            root.mkdir(exist_ok=True)
            (root / "current").symlink_to(Path("generations/sample"))
            values, provenance = defaultdict(int), {}
            def count(source, names, total=1):
                identities = set().union(*(aliases.get(coverage.normal(n), set()) for n in names))
                values[(source, "matched" if len(identities) == 1 else "unattributed")] += total
            aliases = {"known agency": {"one"}}
            with patch.object(coverage, "count_weekly_checklists"):
                coverage.count_publications(corpus, count, provenance, aliases)
            self.assertEqual(values[("publications-monographs", "matched")], 1)
            self.assertEqual(values[("publications-monographs", "unattributed")], 5)
            self.assertEqual(provenance["publications-monographs"]["recordCount"], 6)
            self.assertEqual(provenance["publications-monographs"]["duplicateIdentifierRecords"], 2)
            self.assertEqual(provenance["publications-monographs"]["recordsWithoutUniqueIdentifier"], 1)
            archive = archive_dir / "monographs.zip"
            archive.write_bytes(archive.read_bytes() + b"tamper")
            with self.assertRaisesRegex(ValueError, "archive differs"):
                coverage.count_publications(corpus, self.fail, {}, aliases)

    def test_registered_summary_includes_zero_match_series_and_preserves_unattributed_totals(self):
        register = {"publications": {"family": "all"}, "ircc-guidance": {"family": "delivery"},
                    "policy-suite": {"family": "delivery"}, "zero": {"family": "unused"}}
        provenance = {"publications-series": {"registeredSeries": "publications", "recordType": "MODS record"},
                      "policy-suite": {"registeredSeries": "policy-suite", "recordType": "Verified policy edition"}}
        totals = {"publications-series": {"matched": 7, "unresolved": 3},
                  "policy-suite": {"matched": 0, "unresolved": 11}}
        result = coverage.registered_series_summary(register, provenance, totals)
        self.assertEqual(result["publications"]["matchedRecords"], 7)
        self.assertEqual(result["publications"]["unattributedRecords"], 3)
        self.assertEqual(result["ircc-guidance"], {"family": "delivery", "sourceGroups": [], "matchedRecords": 0, "unattributedRecords": 0})
        self.assertEqual(result["policy-suite"]["sourceGroups"][0]["recordType"], "Verified policy edition")
        self.assertEqual(result["zero"]["matchedRecords"], 0)

    def test_weekly_checklists_count_once_per_metadata_variant_from_264_publication_publisher(self):
        digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
        records = [
            {"catalogueId": "new", "fingerprint": digest("new"), "presentInBaseSnapshot": False,
             "publishers": [{"name": "Known Agency", "sourceTag": "264", "function": "publication"},
                            {"name": "Known Agency FR", "sourceTag": "264", "function": "publication"},
                            {"name": "Distributor", "sourceTag": "264", "function": "distribution"}],
             "publicationStatements": [{"tag": "264", "ind2": "1", "function": "publication"},
                                       {"tag": "264", "ind2": "2", "function": "distribution"}]},
            {"catalogueId": "base", "fingerprint": digest("base"), "presentInBaseSnapshot": True,
             "publishers": [{"name": "Unknown Ministry", "sourceTag": "264", "function": "publication"}],
             "publicationStatements": [{"tag": "264", "ind2": "1", "function": "publication"}]},
            {"catalogueId": "no-publisher", "fingerprint": digest("no-publisher"), "presentInBaseSnapshot": False,
             "publishers": [], "publicationStatements": [{"tag": "264", "ind2": "2", "function": "distribution"}]},
            # An older immutable weekly receipt has no enriched MARC metadata;
            # its cataloging agency is not treated as the publisher.
            {"catalogueId": "old", "fingerprint": digest("old"), "presentInBaseSnapshot": False},
        ]
        known = ("I", "Known Agency", "Agence connue")
        aliases = {"known agency": {known}, "known agency fr": {known}}
        matched, unresolved = [], []
        def count(source, labels, total=1):
            identities = set().union(*(aliases.get(coverage.normal(label), set()) for label in labels))
            (matched if len(identities) == 1 else unresolved).append((source, tuple(labels), total))
        summary = coverage.attribute_weekly_checklist_records(records, {"base"}, count, aliases)
        self.assertEqual(summary["recordVersions"], 4)
        self.assertEqual(summary["overlapWithBaseSnapshot"], 1)
        self.assertEqual(summary["newSinceBaseSnapshot"], 3)
        self.assertEqual(summary["eligible264PublisherVariants"], 2)
        self.assertEqual(summary["variantsWithMultiplePublisherFields"], 1)
        self.assertEqual(summary["variantsWithout264PublicationStatement"], 1)
        self.assertEqual(summary["metadataUnavailableVariants"], 1)
        evidence = {row["label"]: row for row in summary["issuerLabelEvidence"]}
        self.assertEqual(evidence["Known Agency"]["attributedVariants"], 1)
        self.assertEqual(evidence["Known Agency"]["candidateInstitutions"], [
            {"schedule": "I", "legalNameEn": "Known Agency", "legalNameFr": "Agence connue"}])
        self.assertEqual(evidence["Unknown Ministry"]["attributedVariants"], 0)
        self.assertEqual(len(matched), 1)
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(matched[0][2], 1, "bilingual/parallel issuer labels still count the metadata variant once")
        with self.assertRaisesRegex(ValueError, "repeats a metadata variant"):
            coverage.attribute_weekly_checklist_records([records[0], records[0]], set(), count, aliases)

    def test_weekly_attribution_checks_the_current_receipt_and_catalogue_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            corpus = Path(temporary)
            base = corpus / "federal-publications"
            base_gen = base / "generations" / "base"
            (base_gen / "archives").mkdir(parents=True)
            resources = {}
            for category in ("monographs", "periodicals", "series"):
                payload = ("base " + category).encode()
                archive = base_gen / "archives" / (category + ".zip")
                archive.write_bytes(payload)
                resources[category] = {"sha256": hashlib.sha256(payload).hexdigest(), "recordCount": 1,
                    "format": "MODS XML", "finalUrl": "https://publications.gc.ca/" + category}
            (base_gen / "receipt.json").write_text(json.dumps({"series": "publications", "snapshotDate": "2025-11-20",
                "resources": resources}))
            base.mkdir(exist_ok=True)
            (base / "current").symlink_to(Path("generations/base"))
            weeks = corpus / "federal-publication-checklists"
            week_gen = weeks / "runs" / "week"
            week_gen.mkdir(parents=True)
            rows = [
                {"catalogueId": "base-id", "fingerprint": "a" * 64, "title": "Base issue", "presentInBaseSnapshot": True,
                 "publishers": [{"name": "Known Agency", "sourceTag": "264", "function": "publication"}],
                 "publicationStatements": [{"tag": "264", "ind2": "1", "function": "publication"}]},
                {"catalogueId": "new-id", "fingerprint": "b" * 64, "title": "Old metadata", "presentInBaseSnapshot": False},
            ]
            lines = "".join(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows).encode()
            (week_gen / "records.jsonl").write_bytes(lines)
            (week_gen / "receipt.json").write_text(json.dumps({"status": "complete", "baseSnapshotDate": "2025-11-20",
                "aggregateRecordCount": 2, "recordsSha256": hashlib.sha256(lines).hexdigest(),
                "range": {"latestIssue": "2026-26-47"}}))
            weeks.mkdir(exist_ok=True)
            (weeks / "current").symlink_to(Path("runs/week"))
            sources = coverage.PUBLICATION_CATALOGUE.inputs(base, weeks)
            listed = {key: {name: value for name, value in source.items() if name != "path"}
                      for key, source in sources.items()}
            identity = hashlib.sha256(coverage.PUBLICATION_CATALOGUE.json_text(
                [coverage.PUBLICATION_CATALOGUE.SCHEMA, listed]).encode()).hexdigest()
            db_path = corpus / "federal-publication-catalogue/catalogue.sqlite"
            db_path.parent.mkdir(parents=True)
            with sqlite3.connect(db_path) as db:
                db.execute("CREATE TABLE records(source TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, metadata TEXT NOT NULL)")
                db.execute("CREATE TABLE publication(identity TEXT NOT NULL, sources TEXT NOT NULL)")
                db.executemany("INSERT INTO records VALUES (?,?,?,?)", [
                    (category, "base-id", "Base title", "{}") for category in ("monographs", "periodicals", "series")])
                db.executemany("INSERT INTO records VALUES (?,?,?,?)", [
                    ("weekly-checklists", row["catalogueId"], row["title"], coverage.PUBLICATION_CATALOGUE.json_text(row)) for row in rows])
                db.execute("INSERT INTO publication VALUES (?,?)", (identity, coverage.PUBLICATION_CATALOGUE.json_text(listed)))
            matched = []
            provenance = {}
            coverage.count_weekly_checklists(corpus,
                lambda source, names: matched.append((source, names)), provenance,
                {"known agency": {("I", "Known Agency", "Agence connue")}})
            self.assertEqual(matched, [("publications-weekly-checklists", ["Known Agency"])])
            self.assertEqual(provenance["publications-weekly-checklists"]["recordVersions"], 2)
            self.assertEqual(provenance["publications-weekly-checklists"]["overlapWithBaseSnapshot"], 1)
            self.assertEqual(provenance["publications-weekly-checklists"]["metadataUnavailableVariants"], 1)
            self.assertEqual(provenance["publications-weekly-checklists"]["latestIssue"], "2026-26-47")

    def test_directory_attribution_uses_the_published_snapshot_and_parent_department(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            digest = hashlib.sha256(b"archived directory").hexdigest()
            archive_key = "geds/archive/" + digest + "/gedsOpenData.zip"
            original = root / "archive" / archive_key
            original.parent.mkdir(parents=True)
            original.write_bytes(b"archived directory")
            with closing(sqlite3.connect(root / "geds.sqlite")) as db:
                db.executescript("""
                    CREATE TABLE geds_snapshots(seq, snapshot_id, status, organization_count, source_date, source_url, zip_sha256, archive_key);
                    CREATE TABLE geds_organizations(org_id, valid_from_seq, valid_to_seq, department_name_en, department_name_fr);
                    INSERT INTO geds_organizations VALUES ('unit', 1, 2, 'Old', 'Ancien'),
                        ('unit', 2, NULL, 'Current', 'Actuel'), ('new', 3, NULL, 'Future', 'Futur');
                """)
                db.executemany("INSERT INTO geds_snapshots VALUES (?, ?, ?, 1, '2026-10-25', 'https://example.test', ?, ?)",
                               [(2, "current", "published", digest, archive_key), (3, "candidate", "building", digest, archive_key)])
                db.commit()
            rows, sources = [], {}
            coverage.count_geds_organizations(root, lambda key, names, n: rows.append((key, names, n)), sources)
            self.assertEqual(rows, [("geds", ["Current", "Actuel"], 1)])
            self.assertEqual(sources["geds"]["snapshotId"], "current")
            original.write_bytes(b"different")
            with self.assertRaisesRegex(ValueError, "directory archive"):
                coverage.count_geds_organizations(root, self.fail, {})

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
