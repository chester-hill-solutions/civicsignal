import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/federal-publication-checklists.py"
SPEC = importlib.util.spec_from_file_location("federal_publication_checklists", SCRIPT)
checklists = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(checklists)

ISSUES = [
    {"year": 2025, "issue": "25-47", "span": "20251117-20251121"},
    {"year": 2026, "issue": "26-01", "span": "20251229-20260102"},
    {"year": 2026, "issue": "26-02", "span": "20260105-20260109"},
]


def route(issue, language):
    code = "eng" if language == "en" else "fra"
    family = ("weeklyAcquisitionList/list" if language == "en"
              else "listeAcquisitionHebdomadaire/liste")
    return f"/site/{code}/{family}/{issue['year']}/{issue['issue']}/{issue['span']}"


def xml_issue(ids=("id-1", "id-2"), bad=False, title_suffix=""):
    root = ET.Element(f"{checklists.NS}collection")
    for identity in ids:
        record = ET.SubElement(root, f"{checklists.NS}record")
        ET.SubElement(record, f"{checklists.NS}controlfield", tag="001").text = identity
        ET.SubElement(record, f"{checklists.NS}controlfield", tag="003").text = "CaOODSP"
        ET.SubElement(record, f"{checklists.NS}controlfield", tag="008").text = " " * 35 + "eng"
        if bad and identity == ids[0]:
            continue
        title = ET.SubElement(record, f"{checklists.NS}datafield", tag="245", ind1="1", ind2="0")
        ET.SubElement(title, f"{checklists.NS}subfield", code="a").text = f"Title for {identity}{title_suffix} /"
        related = ET.SubElement(record, f"{checklists.NS}datafield", tag="775", ind1="0", ind2="8")
        ET.SubElement(related, f"{checklists.NS}subfield", code="t").text = "French counterpart"
        ET.SubElement(related, f"{checklists.NS}subfield", code="w").text = "(CaOODSP)fr-1"
        note = ET.SubElement(record, f"{checklists.NS}datafield", tag="590", ind1=" ", ind2=" ")
        ET.SubElement(note, f"{checklists.NS}subfield", code="a").text = "Checklist 25-47"
        issuer = ET.SubElement(record, f"{checklists.NS}datafield", tag="110", ind1="2", ind2=" ")
        ET.SubElement(issuer, f"{checklists.NS}subfield", code="a").text = "Office A"
        ET.SubElement(issuer, f"{checklists.NS}subfield", code="e").text = "issuing body"
        publisher = ET.SubElement(record, f"{checklists.NS}datafield", tag="710", ind1="2", ind2=" ")
        ET.SubElement(publisher, f"{checklists.NS}subfield", code="a").text = "Publisher A"
        ET.SubElement(publisher, f"{checklists.NS}subfield", code="e").text = "publisher"
        author = ET.SubElement(record, f"{checklists.NS}datafield", tag="710", ind1="2", ind2=" ")
        ET.SubElement(author, f"{checklists.NS}subfield", code="a").text = "Author A"
        ET.SubElement(author, f"{checklists.NS}subfield", code="e").text = "author"
        old_imprint = ET.SubElement(record, f"{checklists.NS}datafield", tag="260", ind1=" ", ind2=" ")
        ET.SubElement(old_imprint, f"{checklists.NS}subfield", code="b").text = "Ambiguous imprint"
        ET.SubElement(old_imprint, f"{checklists.NS}subfield", code="c").text = "1999"
        publication = ET.SubElement(record, f"{checklists.NS}datafield", tag="264", ind1=" ", ind2="1")
        ET.SubElement(publication, f"{checklists.NS}subfield", code="b").text = "Publisher A"
        ET.SubElement(publication, f"{checklists.NS}subfield", code="c").text = "2000"
        distribution = ET.SubElement(record, f"{checklists.NS}datafield", tag="264", ind1=" ", ind2="2")
        ET.SubElement(distribution, f"{checklists.NS}subfield", code="b").text = "Distributor A"
        production = ET.SubElement(record, f"{checklists.NS}datafield", tag="264", ind1=" ", ind2="0")
        ET.SubElement(production, f"{checklists.NS}subfield", code="b").text = "Producer A"
        link = ET.SubElement(record, f"{checklists.NS}datafield", tag="856", ind1="4", ind2="0")
        ET.SubElement(link, f"{checklists.NS}subfield", code="q").text = "PDF"
        ET.SubElement(link, f"{checklists.NS}subfield", code="y").text = "Full text"
        ET.SubElement(link, f"{checklists.NS}subfield", code="u").text = "https://publications.gc.ca/example.pdf"
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def fixture_inputs(root, *, missing_xml=None, missing_language=None, bad_latest=False,
                   latest_title_suffix="", french_title_suffix="", latest_french_ids=None):
    root.mkdir(parents=True, exist_ok=True)
    for year in (2025, 2026):
        year_issues = [issue for issue in ISSUES if issue["year"] == year]
        for language in ("en", "fr"):
            links = []
            for issue in year_issues:
                if issue["issue"] == missing_language and language == "fr":
                    continue
                stem = route(issue, language)
                links.extend([f'<a href="{stem}.html">View</a>', f'<a href="{stem}.mrc">MARC21</a>'])
                if issue["issue"] != missing_xml:
                    links.append(f'<a href="{stem}.xml">XML</a>')
            (root / f"index-{year}-{language}.html").write_text(
                "<html><body>" + "".join(links) + "</body></html>", encoding="utf-8")
    latest = ISSUES[-1]
    for issue in ISSUES:
        for language in ("en", "fr"):
            ids = ("id-1", "id-2") if language == "en" else (latest_french_ids if issue == latest and latest_french_ids is not None else ("id-2", "id-1"))
            suffix = (latest_title_suffix if language == "en" else french_title_suffix) if issue == latest else ""
            body = xml_issue(ids, bad=bad_latest and issue == latest,
                             title_suffix=suffix)
            (root / f"issue-{issue['year']}-{issue['issue']}-{language}.xml").write_bytes(body)
    for language in ("en", "fr"):
        phrase = "Weekly Acquisitions List" if language == "en" else "Liste hebdomadaire des acquisitions"
        (root / f"issue-{latest['year']}-{latest['issue']}-{language}.html").write_text(
            f"<html><title>{phrase} 26-02</title></html>", encoding="utf-8")


class PublicationChecklists(unittest.TestCase):
    def test_publisher_fields_keep_marc_roles_indicators_and_publication_links(self):
        row = checklists.parse_marc_xml(xml_issue(("id-1",)), "en")["id-1"]
        self.assertEqual(row["agencyCode"], "CaOODSP")
        self.assertEqual(row["corporateNames"][0]["tag"], "110")
        self.assertEqual(row["corporateNames"][0]["roles"], ["issuing body"])
        self.assertEqual(row["issuingBodies"], [{"label": "Office A", "sourceTag": "110",
                                                   "roles": ["issuing body"], "roleCodes": []}])
        self.assertEqual(row["publishers"], [
            {"name": "Publisher A", "sourceTag": "710", "roles": ["publisher"], "roleCodes": []},
            {"name": "Publisher A", "sourceTag": "264", "function": "publication"},
        ])
        self.assertNotIn("CaOODSP", json.dumps(row["publishers"]))
        self.assertEqual([(x["tag"], x["function"]) for x in row["publicationStatements"]],
                         [("260", "legacy-imprint"), ("264", "publication"),
                          ("264", "distribution"), ("264", "production")])
        self.assertEqual(row["publicationStatements"][0]["entities"], ["Ambiguous imprint"])
        self.assertEqual(row["publicationStatements"][1]["dates"], ["2000"])
        self.assertEqual(row["publicationLinks"][0]["urls"], ["https://publications.gc.ca/example.pdf"])
        self.assertEqual(row["publicationLinks"][0]["formats"], ["PDF"])
        self.assertEqual(row["publicationLinks"][0]["labels"], ["Full text"])

    def test_publishing_metadata_survives_bilingual_archive_aggregation_and_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            root = base / "corpus"
            run = checklists.refresh(root, False, inputs, base_root=None)
            self.assertEqual(run["recordSchema"], "paired-marc-v4")
            self.assertEqual(run["schemaVersion"], 3)
            rows = [json.loads(line) for line in (root / "current" / "records.jsonl").read_text().splitlines()]
            self.assertEqual(rows[0]["corporateNames"][0]["roles"], ["issuing body"])
            self.assertEqual(rows[0]["publicationStatements"][1]["function"], "publication")
            self.assertEqual(rows[0]["publicationLinks"][0]["formats"], ["PDF"])
            self.assertEqual(checklists.replay(root)["verifiedIssues"], 3)

    def test_full_historical_backfill_deduplicates_bilingual_and_repeated_issue_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            root = base / "corpus"
            run = checklists.refresh(root, False, inputs, base_root=None)
            self.assertEqual(run["status"], "complete")
            self.assertEqual(run["range"]["firstIssue"], "2025-25-47")
            self.assertEqual(run["range"]["latestIssue"], "2026-26-02")
            self.assertTrue(run["range"]["baseCutoffSpanFound"])
            self.assertEqual(run["range"]["officialIssuesIndexed"], 3)
            self.assertEqual(run["counts"]["uniqueCatalogueIdsInChecklistIssues"], 2)
            self.assertEqual(run["counts"]["distinctChecklistRecordVersions"], 2)
            self.assertEqual(run["counts"]["versionsNewSincePreviousRun"], 2)
            self.assertEqual(len(run["issueVersions"]), 3)
            latest_receipt = json.loads((root / "current" / "latest" / "receipt.json").read_text())
            self.assertEqual(latest_receipt["issue"]["key"], "2026-26-02")
            records = [json.loads(line) for line in (root / "current" / "records.jsonl").read_text().splitlines()]
            self.assertEqual(records[0]["presentInBaseSnapshot"], None)
            self.assertEqual([item["issue"] for item in records[0]["seenInIssues"]],
                             [f"{x['year']}-{x['issue']}" for x in ISSUES])
            self.assertEqual(checklists.replay(root)["freshness"], run["freshness"])

    def test_latest_repeat_with_unchanged_hashes_rechecks_without_new_version(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            root = base / "corpus"
            first = checklists.refresh(root, False, inputs, base_root=None)
            version = first["issueVersions"]["2026-26-02"]
            versions_path = root / "issues/2026/26-02/versions"
            before = sorted(path.name for path in versions_path.iterdir())
            second = checklists.refresh(root, False, inputs, base_root=None)
            obs = next(row for row in second["issueObservations"] if row["issue"] == "2026-26-02")
            self.assertEqual(obs["status"], "unchanged")
            self.assertEqual(obs["version"], version)
            self.assertEqual(sorted(path.name for path in versions_path.iterdir()), before)
            self.assertEqual(second["counts"]["versionsNewSincePreviousRun"], 0)
            replay = checklists.replay(root)
            self.assertEqual(replay["freshness"], second["freshness"])
            self.assertEqual(replay["sourceRunAttemptedAt"], second["attemptedAt"])

    def test_metadata_revision_is_retained_as_a_second_version(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            root = base / "corpus"
            first = checklists.refresh(root, False, inputs, base_root=None)
            old_latest = first["issueVersions"]["2026-26-02"]
            fixture_inputs(inputs, latest_title_suffix=" updated")
            second = checklists.refresh(root, False, inputs, base_root=None)
            self.assertNotEqual(second["issueVersions"]["2026-26-02"], old_latest)
            self.assertEqual(len(list((root / "issues/2026/26-02/versions").iterdir())), 2)
            self.assertEqual(second["counts"]["idsWithMultipleMetadataVersions"], 2)
            self.assertEqual(second["counts"]["uniqueCatalogueIdsInChecklistIssues"], 2)

    def test_bilingual_metadata_variants_keep_each_language_and_citation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs, french_title_suffix=" (édition française)")
            root = base / "corpus"
            run = checklists.refresh(root, False, inputs, base_root=None)
            self.assertEqual(run["status"], "complete")
            receipt = json.loads((root / "current" / "latest" / "receipt.json").read_text())
            comparison = receipt["counts"]
            self.assertEqual(comparison["bilingualMetadataDifferenceIds"], ["id-1", "id-2"])
            self.assertEqual(comparison["recordVariantsRetained"], 4)
            rows = [json.loads(line) for line in (root / "current" / "latest" / "records.jsonl").read_text().splitlines()]
            self.assertEqual({tuple(row["listedIn"]) for row in rows}, {("en",), ("fr",)})
            self.assertTrue(all(row["citations"].keys() == set(row["listedIn"]) for row in rows))
            self.assertTrue(any("édition française" in row["title"] for row in rows if row["variantLanguage"] == "fr"))
            self.assertEqual(checklists.replay(root)["verifiedIssues"], 3)

    def test_bilingual_catalogue_id_mismatch_is_retained_and_reported_as_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs, latest_french_ids=("id-2",))
            root = base / "corpus"
            run = checklists.refresh(root, False, inputs, base_root=None)
            self.assertEqual(run["status"], "partial")
            self.assertTrue(any(gap.get("status") == "bilingual-catalogue-id-mismatch" for gap in run["gaps"]))
            rows = [json.loads(line) for line in (root / "current" / "latest" / "records.jsonl").read_text().splitlines()]
            self.assertTrue(any(row["catalogueId"] == "id-1" and row.get("bilingualIdMismatch")
                                and row["listedIn"] == ["en"] for row in rows))
            self.assertEqual(checklists.replay(root)["verifiedIssues"], 3)

    def test_missing_xml_format_is_a_gap_and_keeps_issue_in_denominator(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs, missing_xml="25-47")
            run = checklists.refresh(base / "corpus", False, inputs, base_root=None)
            self.assertEqual(run["status"], "partial")
            self.assertEqual(run["range"]["officialIssuesIndexed"], 3)
            self.assertEqual(run["range"]["issuesListedEnglish"], 3)
            self.assertEqual(run["range"]["issuesListedFrench"], 3)
            self.assertTrue(any(gap.get("issue") == "2025-25-47" for gap in run["gaps"]))

    def test_language_index_gap_is_explicit_and_not_dropped(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs, missing_language="26-01")
            run = checklists.refresh(base / "corpus", False, inputs, base_root=None)
            self.assertEqual(run["range"]["issuesListedEnglish"], 3)
            self.assertEqual(run["range"]["issuesListedFrench"], 2)
            self.assertTrue(any(gap.get("issue") == "2026-26-01" and gap.get("missingLanguages") == ["fr"]
                                for gap in run["gaps"]))

    def test_latest_failure_preserves_last_good_latest_pointer_and_run_is_partial(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            root = base / "corpus"
            first = checklists.refresh(root, False, inputs, base_root=None)
            previous_target = (root / "current" / "latest").resolve()
            fixture_inputs(inputs, bad_latest=True)
            second = checklists.refresh(root, False, inputs, base_root=None)
            self.assertEqual(second["status"], "partial")
            self.assertEqual(second["range"]["latestPublishedPointerIssue"], "2026-26-02")
            self.assertEqual((root / "current" / "latest").resolve(), previous_target)
            self.assertEqual(first["issueVersions"]["2026-26-02"], second["issueVersions"]["2026-26-02"])

    def test_missing_cutoff_span_is_a_durable_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            inputs = base / "inputs"
            fixture_inputs(inputs)
            for language in ("en", "fr"):
                path = inputs / f"index-2025-{language}.html"
                path.write_text(path.read_text().replace("25-47/20251117-20251121", "25-48/20251124-20251128"))
            run = checklists.refresh(base / "corpus", False, inputs, base_root=None)
            self.assertFalse(run["range"]["baseCutoffSpanFound"])
            self.assertTrue(any(gap.get("status") == "cutoff-span-not-indexed" for gap in run["gaps"]))

    def test_year_issue_identity_and_cross_year_week_dates(self):
        html = (b'<a href="/site/eng/weeklyAcquisitionList/list/2026/26-01/20251229-20260102.html">View</a>'
                b'<a href="/site/eng/weeklyAcquisitionList/list/2026/26-01/20251229-20260102.mrc">MARC21</a>'
                b'<a href="/site/eng/weeklyAcquisitionList/list/2026/26-01/20251229-20260102.xml">XML</a>')
        issue = checklists.source_issues(html, "en")[0]
        self.assertEqual(issue["key"], "2026-26-01")
        self.assertEqual(issue["dateStart"], "2025-12-29")
        self.assertEqual(issue["dateEnd"], "2026-01-02")

    def test_xml_record_indentation_does_not_create_a_bilingual_metadata_variant(self):
        compact = xml_issue(("id-1",))
        formatted = compact.replace(b"</record><", b"</record>\n  <")
        english = checklists.parse_marc_xml(compact, "en")["id-1"]
        french = checklists.parse_marc_xml(formatted, "fr")["id-1"]
        self.assertEqual(english["fingerprint"], french["fingerprint"])
        legacy_compact = checklists.parse_marc_xml(compact, "en", "paired-marc-v3")["id-1"]
        legacy_formatted = checklists.parse_marc_xml(formatted, "fr", "paired-marc-v3")["id-1"]
        self.assertEqual(legacy_compact["fingerprint"], legacy_formatted["fingerprint"])

    def test_relative_corpus_root_publishes_a_valid_latest_pointer(self):
        with tempfile.TemporaryDirectory() as temp:
            previous_cwd = Path.cwd()
            try:
                os.chdir(temp)
                inputs = Path("inputs")
                fixture_inputs(inputs)
                root = Path("relative-corpus")
                run = checklists.refresh(root, False, inputs, base_root=None)
                self.assertEqual(run["status"], "complete")
                latest_receipt = root / "current" / "latest" / "receipt.json"
                self.assertTrue(latest_receipt.is_file())
                self.assertEqual(json.loads(latest_receipt.read_text())["issue"]["key"], "2026-26-02")
                self.assertEqual(checklists.replay(root)["latestIssue"], "2026-26-02")
            finally:
                os.chdir(previous_cwd)

    def test_new_issue_work_cap_does_not_bound_total_historical_index(self):
        issues = [{"key": f"2026-26-{index:02d}"} for index in range(1, 121)]
        selected = checklists.select_issue_work(issues, issues[-1]["key"])
        self.assertEqual(len(selected), checklists.MAX_NEW_ISSUES_PER_RUN)
        self.assertEqual(selected[-1]["key"], issues[-1]["key"])

    def test_issue_heading_without_download_links_stays_in_issue_denominator(self):
        body = b"<span>Weekly Acquisitions List 25-47 (November 21, 2025)</span>"
        found = checklists.source_issues(body, "en")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["key"], "2025-25-47")
        self.assertEqual(found[0]["missingFormats"], ["html", "mrc", "xml"])
        self.assertTrue(found[0]["missingIssueSpan"])


if __name__ == "__main__":
    unittest.main()
