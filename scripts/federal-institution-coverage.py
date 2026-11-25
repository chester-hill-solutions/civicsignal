#!/usr/bin/env python3
"""Match issuers in acquired public-service files to the statutory roster by published names."""
import argparse
import csv
import gzip
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import unicodedata
from lib.parliament_intake import save_atomic


ROSTER = Path("docs/evidence/2026-11-23")
BULK = Path("data/corpus/federal-bulk")
_DOCS_SPEC = importlib.util.spec_from_file_location(
    "departmental_report_documents", Path(__file__).resolve().with_name("departmental-report-documents.py"))
HTML_DOCUMENTS = importlib.util.module_from_spec(_DOCS_SPEC)
_DOCS_SPEC.loader.exec_module(HTML_DOCUMENTS)


def normal(value):
    return " ".join(unicodedata.normalize("NFC", value or "").casefold().replace("’", "'").split())


def resources(db, name):
    item = db.execute("SELECT resources FROM publications WHERE series=? ORDER BY observed_at DESC LIMIT 1", (name,)).fetchone()
    if not item or not (published := json.loads(item[0])):
        raise ValueError(f"No acquired resources for {name}")
    return published


def rows(resource):
    with gzip.open(BULK / "objects" / (resource["sha256"] + ".csv.gz"), "rt", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def register_published_titles(row, aliases):
    legal = [row["Legal title"], row["Appellation légale"]]
    identities = set().union(*(aliases.get(normal(name), set()) for name in legal))
    if len(identities) != 1:
        return
    for title, applied, abbreviation in (
        (legal[0], row["Applied title"], row.get("Abbreviation", "").strip()),
        (legal[1], row["Titre d'usage"], row.get("Abréviation", "").strip()),
    ):
        for name in (title.strip(), applied.strip()):
            if not name:
                continue
            aliases[normal(name)].update(identities)
            if abbreviation:
                for label in (f"{name} ({abbreviation})", f"{name} - {abbreviation}"):
                    aliases[normal(label)].update(identities)


def count_eccc_index_editions(corpus, count, provenance, register):
    path = corpus / "eccc/serving.sqlite"
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        observed, revision = db.execute("SELECT observed_at, revision FROM dp_inventory WHERE singleton=1").fetchone()
        for series, key in (("audit", "eccc-audit"), ("eval", "eccc-evaluation")):
            indexes = [{"url": url, "language": lang, "sha256": sha} for url, lang, sha in db.execute(
                "SELECT url, language, sha256 FROM dp_indexes WHERE series=? AND observed_at=? ORDER BY language",
                (series, observed))]
            if {item["url"] for item in indexes} != {register[key]["entry_url"], register[key]["companion_url"]}:
                raise ValueError(f"ECCC serving indexes differ from the registered bilingual sources for {key}")
            editions, = db.execute("""SELECT COUNT(*) FROM dp_editions e
                JOIN dp_indexes i ON i.url=e.index_url AND i.language=e.language
                WHERE i.series=? AND i.observed_at=? AND e.last_observed_at=i.observed_at""",
                (series, observed)).fetchone()
            provenance[key] = {"series": key, "indexes": indexes, "observedAt": observed, "revision": revision,
                               "recordType": "work edition listed in the department's published index"}
            count(key, ["Environment and Climate Change Canada", "Environnement et Changement climatique Canada"], editions)


def classify_sources(provenance, register):
    registered_series = {"briefing-notes": "briefing-titles", "federal-procurement": "procurement",
                         "departmental-report-html-plans": "departmental-plans",
                         "departmental-report-html-results": "departmental-results"}
    for key, source in provenance.items():
        series = source["series"]
        if series == "federal-disclosures":
            series = "algorithmic-assessments" if key == "disclosure-aia" else "briefing-packages"
        series = registered_series.get(series, series)
        source["registeredSeries"] = series
        source["family"] = register[series]["family"]


def latest_report_generation(root, report_dir=Path(".")):
    pointer = json.loads((root / report_dir / "latest-attempt.json").read_bytes())
    directory = root / report_dir / "generations"
    path = directory / (pointer["runId"] + ".json")
    if path.parent != directory or str(path.relative_to(root)) != pointer["reportPath"]:
        raise ValueError(f"Unexpected generation path for {root.name}")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != pointer["reportSha256"] or len(raw) != pointer.get("reportBytes", len(raw)):
        raise ValueError(f"{root.name} generation differs from the published receipt")
    report = json.loads(raw)
    if report["runId"] != pointer["runId"] or report["status"] != pointer["status"]:
        raise ValueError(f"{root.name} generation and receipt identity differ")
    return report, {"path": str(path), "sha256": pointer["reportSha256"], "runId": report["runId"],
                    "acquisitionStatus": report["status"], "observedAt": report["observedAt"]}


def report_links_by_institution(corpus, aliases):
    report, summary = latest_report_generation(corpus / "departmental-report-editions")
    counts = defaultdict(Counter)
    unresolved = Counter()
    for link in report["reportLinks"]:
        identities = aliases.get(normal(link["issuer_label"]), set())
        if len(identities) == 1:
            counts[next(iter(identities))][link["family"]] += 1
        else:
            unresolved[link["family"]] += 1
    summary.update(listedLinks=len(report["reportLinks"]), unresolvedBySeries=dict(unresolved))
    return counts, summary


def count_report_documents(corpus, count, provenance):
    report, evidence = latest_report_generation(corpus / "departmental-report-documents")
    documents = {item["target_url"]: item for item in report["documents"]}
    for family in ("departmental-plans", "departmental-results"):
        provenance[family] = {**evidence, "series": family,
                              "recordType": "distinct verified report edition linked by the issuer"}
    seen = set()
    for citation in report["citations"]:
        if citation["disposition"] != "verified":
            continue
        family = citation["family"]
        document = documents[citation["target_url"]]
        if (family not in ("departmental-plans", "departmental-results") or not document["body_sha256"]
                or not document["text_sha256"] or not document["readable_chars"]):
            raise ValueError("Verified report citation has no corresponding readable document")
        identity = (citation["issuer_key"], family, citation["issue_year"], citation["language"], document["body_sha256"])
        if identity not in seen:
            count(family, [citation["issuer_label"]])
            seen.add(identity)


def count_html_report_documents(corpus, count, provenance, aliases):
    root=corpus/"departmental-report-documents"
    pointer_path=root/"latest-html-attempt.json"
    pointer=json.loads(pointer_path.read_bytes())
    report_dir=root/"html-generations"
    report_path=report_dir/(pointer["runId"]+".json")
    if report_path.parent!=report_dir or str(report_path.relative_to(root))!=pointer["reportPath"]:
        raise ValueError("Unexpected latest HTML report generation path")
    report_raw=report_path.read_bytes()
    if hashlib.sha256(report_raw).hexdigest()!=pointer["reportSha256"] or len(report_raw)!=pointer.get("reportBytes",len(report_raw)):
        raise ValueError("HTML report generation differs from its published receipt")
    receipt=json.loads(report_raw)
    source_sha=receipt.get("sourceCurrentReportSha256")
    if not source_sha or receipt["runId"]!=pointer["runId"]:
        raise ValueError("HTML receipt does not identify its source inventory")
    edition_root=corpus/"departmental-report-editions"
    source_raw,_,current_run=HTML_DOCUMENTS.validate_input(edition_root)
    if hashlib.sha256(source_raw).hexdigest()!=source_sha or current_run!=receipt["sourceEditionRunId"]:
        raise ValueError("HTML acquisition is not bound to the current immutable publisher inventory")
    audit=HTML_DOCUMENTS.html_audit(root,edition_root,source_sha)
    if audit["sourceCurrentReportSha256"]!=source_sha or audit["queueCompleteness"]!="drained" or audit["replayStatus"]!="verified":
        raise ValueError("HTML queue is incomplete or its batch archive replay failed")

    with closing(sqlite3.connect((root/"documents.sqlite").resolve().as_uri()+"?mode=ro",uri=True)) as db:
        db.execute("BEGIN")
        run_ids=[row[0] for row in db.execute("SELECT run_id FROM html_runs WHERE source_report_sha256=? AND report_path IS NOT NULL ORDER BY started_at,run_id",(source_sha,))]
        if hashlib.sha256("\n".join(run_ids).encode()).hexdigest()!=audit["replayedRunIdsSha256"]:
            raise ValueError("HTML queue changed while the coverage snapshot was being read")
        target_counts=dict(db.execute("SELECT status,COUNT(*) FROM html_targets WHERE source_report_sha256=? GROUP BY status",(source_sha,)).fetchall())
        citation_counts=dict(db.execute("SELECT status,COUNT(*) FROM html_citations WHERE source_report_sha256=? GROUP BY status",(source_sha,)).fetchall())
        if target_counts!=audit["targetStatusCounts"] or citation_counts!=audit["citationDispositionCounts"]:
            raise ValueError("HTML queue changed after batch replay; refusing a mixed coverage snapshot")
        accepted=list(db.execute("""SELECT c.target_url,c.family,c.language,c.issuer_label,c.label,c.year_label,
                c.landing_url,c.landing_sha256,c.source_index_url,c.source_index_sha256,
                t.status,t.body_sha256,t.body_bytes,t.readable_chars
            FROM html_citations c JOIN html_targets t
              ON t.source_report_sha256=c.source_report_sha256 AND t.target_url=c.target_url
            WHERE c.source_report_sha256=? AND c.status='accepted'
            ORDER BY c.family,c.language,c.issuer_label,c.target_url,c.citation_id""",(source_sha,)).fetchall())
    if len(accepted)!=audit["acceptedCitations"]:
        raise ValueError("HTML accepted citation count differs from the audited queue")
    evidence_by_family=defaultdict(list)
    unresolved=Counter()
    seen=set()
    distinct_by_family=Counter()
    for row in accepted:
        target_url,family,language,issuer,label,year_label,landing_url,landing_sha,index_url,index_sha,status,body_sha,body_bytes,readable_chars=row
        if family not in ("departmental-plans","departmental-results") or status!="fetched" or not body_sha or not body_bytes or not readable_chars:
            raise ValueError("Accepted HTML citation has no corresponding readable page archive")
        issue_year=HTML_DOCUMENTS.source_year(label,year_label or "")
        identities=aliases.get(normal(issuer),set())
        if len(identities)!=1 or not issue_year:
            unresolved[family]+=1
            continue
        institution=next(iter(identities))
        identity=(institution,family,issue_year,language,body_sha)
        if identity in seen:
            continue
        seen.add(identity)
        key="departmental-report-html-"+family.removeprefix("departmental-")
        count(key,[issuer])
        distinct_by_family[family]+=1
        evidence_by_family[family].append({"issuerLabel":issuer,"language":language,"issueYear":issue_year,
            "url":target_url,"bodySha256":body_sha,"sourceLandingUrl":landing_url,
            "sourceLandingSha256":landing_sha,"sourceIndexUrl":index_url,"sourceIndexSha256":index_sha})
    runlist_sha=audit["replayedRunIdsSha256"]
    for family in ("departmental-plans","departmental-results"):
        key="departmental-report-html-"+family.removeprefix("departmental-")
        family_accepted=sum(audit["byFamilyLanguage"][f"{family}/{lang}"]["statuses"].get("accepted",0) for lang in ("en","fr"))
        provenance[key]={"series":key,"recordType":"accepted year/language/issuer-matched HTML report page edition",
            "receiptPath":str(report_path),"receiptSha256":pointer["reportSha256"],"receiptRunId":pointer["runId"],
            "sourceInventoryPath":str(root/"inputs"/(source_sha+".json")),"sourceInventorySha256":source_sha,
            "sourceInventoryRunId":current_run,"auditBatchCount":audit["replayedBatchRuns"],
            "auditBatchRunListSha256":runlist_sha,"queueCandidateCitations":audit["candidateCitations"],
            "queueCandidateTargets":audit["candidateTargets"],"acceptedCitations":family_accepted,
            "distinctAcceptedEditions":distinct_by_family[family],"unresolvedAcceptedCitations":unresolved[family],
            "dispositions":{language:audit["byFamilyLanguage"][f"{family}/{language}"] for language in ("en","fr")},
            "evidenceDatabase":str(root/"documents.sqlite"),
            "evidenceTables":["html_citations","html_targets","html_run_citations","html_run_targets"],
            "acceptedPageEvidence":evidence_by_family[family],
            "coverageLimit":"Accepted HTML page title/year/language/issuer match; does not establish complete underlying-document text coverage."}


def count_geds_organizations(folder, count, provenance):
    # Attribute units to the department named by GEDS. Identical unit names
    # under different parents do not establish an institutional relationship.
    with closing(sqlite3.connect((folder / "geds.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        snapshot = db.execute("""SELECT * FROM geds_snapshots WHERE status='published'
            ORDER BY seq DESC LIMIT 1""").fetchone()
        if snapshot is None:
            raise ValueError("GEDS has no published directory snapshot")
        seq = snapshot["seq"]
        active = "valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)"
        total, distinct_units = db.execute("SELECT COUNT(*),COUNT(DISTINCT org_id) FROM geds_organizations WHERE " + active,
                                           (seq, seq)).fetchone()
        if total != distinct_units or total != snapshot["organization_count"]:
            raise ValueError("GEDS organization rows differ from the published snapshot")
        key = Path(snapshot["archive_key"])
        source_hash = snapshot["zip_sha256"]
        if (not re.fullmatch(r"[0-9a-f]{64}", source_hash)
                or key.parent != Path("geds/archive") / source_hash or key.suffix not in {".zip", ".csv"}):
            raise ValueError("Unexpected GEDS archive key")
        archive = folder / "archive" / key
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != snapshot["zip_sha256"]:
                raise ValueError("GEDS directory archive differs from the published snapshot")
        rows = db.execute("SELECT department_name_en, department_name_fr, COUNT(*) "
                          "FROM geds_organizations WHERE " + active +
                          " GROUP BY department_name_en, department_name_fr", (seq, seq)).fetchall()
        for en, fr, units in rows:
            count("geds", [en or "", fr or ""], units)
        provenance["geds"] = {"series": "geds", "recordType": "directory organization unit under the published department",
                              "snapshotId": snapshot["snapshot_id"], "sourceDate": snapshot["source_date"],
                              "url": snapshot["source_url"], "sha256": snapshot["zip_sha256"], "archive": str(archive),
                              "organizationUnits": total, "departmentNames": len(rows)}


def count_regulatory_plans(corpus, count, provenance):
    series = "regulatory-plans"
    report, evidence = latest_report_generation(corpus / "federal-regulatory-plans", Path("dist"))
    provenance[series] = {**evidence, "series": series, "recordType": "publisher-confirmed forward regulatory plan edition"}
    editions = set()
    for row in report["planEditions"]:
        if not row.get("sourceBodySha256") or row["editionId"] in editions:
            raise ValueError("Regulatory plan edition is duplicated or missing its source digest")
        editions.add(row["editionId"])
        count(series, [row["issuerLabel"]])


def count_acquisitions(corpus, count, provenance):
    procurement = corpus / "federal-procurement"
    with closing(sqlite3.connect((procurement / "publications.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        publication = db.execute("SELECT fiscal_year, resources_json FROM observations ORDER BY generation DESC LIMIT 1").fetchone()
    if not publication:
        raise ValueError("No acquired CanadaBuys publication")
    fiscal_year, encoded = publication
    published = json.loads(encoded)
    if sorted(item["kind"] for item in published) != ["award-notices", "contract-history"]:
        raise ValueError("Incomplete CanadaBuys publication")
    for item in published:
        key = "canadabuys-" + item["kind"]
        provenance[key] = {"series": "federal-procurement", "url": item["sourceUrl"], "sha256": item["sha256"], "fiscalYear": fiscal_year}
        path = procurement / "objects" / (item["sha256"] + ".csv.gz")
        with gzip.open(path, "rb") as original:
            if hashlib.file_digest(original, "sha256").hexdigest() != item["sha256"]:
                raise ValueError(f"CanadaBuys checksum mismatch for {key}")
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as src:
            observed = 0
            for row in csv.DictReader(src):
                count(key, [row["contractingEntityName-nomEntitContractante-" + lang] for lang in ("eng", "fra")])
                observed += 1
        if observed != item["schema"]["rows"]:
            raise ValueError(f"CanadaBuys row count mismatch for {key}")

    disclosures = corpus / "federal-disclosures"
    with closing(sqlite3.connect((disclosures / "catalogue.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        latest = db.execute("SELECT receipt FROM generations ORDER BY observed_at DESC LIMIT 1").fetchone()
    if not latest:
        raise ValueError("No acquired federal disclosure catalogues")
    receipt = json.loads(latest[0])
    if not receipt["collections"] or sum(item["records"] for item in receipt["collections"].values()) != receipt["records"]:
        raise ValueError("Incomplete federal disclosure generation")
    for collection, item in receipt["collections"].items():
        key = "disclosure-" + collection
        provenance[key] = {"series": "federal-disclosures", "pages": item["pages"]}
        observed = 0
        for page in item["pages"]:
            with gzip.open(disclosures / "objects" / (page["sha256"] + ".json.gz"), "rb") as source:
                body = source.read()
            if hashlib.sha256(body).hexdigest() != page["sha256"]:
                raise ValueError(f"Disclosure page checksum mismatch for {key}")
            records = json.loads(body)["result"]["results"]
            for record in records:
                count(key, record["organization"]["title"].split("|"))
            observed += len(records)
        if observed != item["records"]:
            raise ValueError(f"Disclosure record count mismatch for {key}")


def coverage(include_acquisitions=False):
    with (ROSTER / "federal-public-service-sources.csv").open(newline="") as handle:
        register = {row["series_key"]: row for row in csv.DictReader(handle)}
    with (ROSTER / "federal-public-service-roster.csv").open(newline="") as handle:
        roster = list(csv.DictReader(handle))
    groups = defaultdict(list)
    aliases = defaultdict(set)
    for r in roster:
        identity = r["schedule"], r["legal_name_en"], r["legal_name_fr"]
        groups[identity].append(r["schedule_ordinal"])
        for key in ("legal_name_en", "legal_name_fr", "tbs_table_name_en"):
            if r[key]:
                aliases[normal(r[key])].add(identity)
    with (ROSTER / "federal-public-service-publisher-names.csv").open(newline="") as handle:
        for r in csv.DictReader(handle):
            for label in ("psc_published_name_en", "tbs_name_via_psc"):
                if r[label]:
                    aliases[normal(r[label])].update(aliases[normal(r["legal_name_en"])])

    counts = defaultdict(Counter)
    unmatched = defaultdict(Counter)
    provenance = {}

    def count(source, names, total=1):
        if not total:
            return
        match = set().union(*(aliases.get(normal(n), set()) for n in names))
        if len(match) == 1:
            counts[next(iter(match))][source] += total
        else:
            unmatched[source][" | ".join(names)] += total

    with closing(sqlite3.connect((BULK / "publications.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        for resource in resources(db, "official-titles"):
            provenance[resource["id"]] = {"series": "official-titles", "url": resource["url"], "sha256": resource["sha256"]}
            for r in rows(resource):
                names = [r["Legal title"], r["Appellation légale"]]
                register_published_titles(r, aliases)
                count(resource["id"], names)
        for series in ("service-inventory", "ati-summaries", "grant-awards"):
            for resource in resources(db, series):
                key = resource["id"]
                provenance[key] = {"series": series, "url": resource["url"], "sha256": resource["sha256"]}
                for r in rows(resource):
                    title = r.get("owner_org_title")
                    names = [v.strip() for v in title.split("|")] if title else [r.get("department_name_en", ""), r.get("department_name_fr", "")]
                    count(key, names)

    receipt = json.loads(Path("dist/briefing-notes/receipt.json").read_text())
    for kind in ("main", "nil"):
        source = receipt["sources"][kind]
        key = "briefing-notes-" + kind
        provenance[key] = {"series": "briefing-notes", "url": source["url"], "sha256": source["sha256"]}
        with Path(source["object"]).open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                count(key, [v.strip() for v in row["owner_org_title"].split("|")])

    with closing(sqlite3.connect(Path("data/corpus/consultations/catalogue.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        observed, digest = db.execute("""SELECT observed_at, csv_sha256 FROM consultations_catalogues
            WHERE source='canada' ORDER BY observed_at DESC LIMIT 1""").fetchone()
        provenance["consultations"] = {"series": "consultations", "url": "https://open.canada.ca/static/consultations_open.csv",
                                       "sha256": digest, "observedAt": observed}
        for facts, in db.execute("SELECT facts_json FROM consultations_records WHERE removed_at IS NULL AND observed_at=?", (observed,)):
            institution = json.loads(facts)["institution"]
            count("consultations", [institution["en"], institution["fr"]])
    if include_acquisitions:
        count_acquisitions(BULK.parent, count, provenance)
        count_eccc_index_editions(BULK.parent, count, provenance, register)
        count_report_documents(BULK.parent, count, provenance)
        count_html_report_documents(BULK.parent,count,provenance,aliases)
        count_regulatory_plans(BULK.parent, count, provenance)
        count_geds_organizations(Path("dist/geds"), count, provenance)
    classify_sources(provenance, register)
    families = sorted({source["family"] for source in register.values()} - {"all"})
    link_counts, link_coverage = {}, {}
    if include_acquisitions:
        link_counts, link_coverage = report_links_by_institution(BULK.parent, aliases)
        link_coverage["institutionsWithLinks"] = len(link_counts)
    institutions = []
    for identity, ordinals in groups.items():
        covered = {provenance[source]["family"] for source in counts[identity]}
        institutions.append({"schedule": identity[0], "ordinals": ordinals, "legalNameEn": identity[1],
                             "legalNameFr": identity[2], "publishedRecordCounts": dict(counts[identity]),
                             "familiesWithRecords": sorted(covered),
                             "familiesWithoutAttributedRecords": sorted(set(families) - covered),
                             "publisherReportLinkCounts": dict(link_counts.get(identity, {}))})
    source_totals = {source: {"matched": sum(values[source] for values in counts.values()),
                              "unresolved": sum(unmatched[source].values())} for source in provenance}
    return {"scope": "Match issuer labels to statutory names and published aliases. Procurement uses the contracting entity. Counts describe records in the acquired files.",
            "rosterEntries": len(roster), "provisionalNames": len(institutions),
            "namesWithRecords": sum(bool(row["publishedRecordCounts"]) for row in institutions),
            "sources": provenance, "sourceRecordCounts": source_totals,
            "reportLinkCoverage": link_coverage,
            "institutionsWithAttributedRecordsByFamily": {
                family: sum(family in row["familiesWithRecords"] for row in institutions) for family in families},
            "institutions": institutions, "unresolvedPublisherLabels": dict(unmatched)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-acquisitions", action="store_true",
                        help="Also attribute current acquisition records, ECCC indexes and verified departmental report editions.")
    parser.add_argument("--output", type=Path, help="Atomically publish the complete coverage JSON here.")
    args = parser.parse_args()
    result = coverage(args.include_acquisitions)
    if args.output:
        save_atomic(args.output, result)
        print(json.dumps({"report": str(args.output), "sources": len(result["sources"]),
                          "namesWithRecords": result["namesWithRecords"], "rosterNames": result["provisionalNames"]}))
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
