#!/usr/bin/env python3
"""Match issuers in acquired public-service files to the statutory roster by published names."""
import argparse
import csv
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import unicodedata
from lib.parliament_intake import save_atomic


ROSTER = Path("docs/evidence/2026-11-23")
BULK = Path("data/corpus/federal-bulk")


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
    registered_series = {"briefing-notes": "briefing-titles", "federal-procurement": "procurement"}
    for key, source in provenance.items():
        series = source["series"]
        if series == "federal-disclosures":
            series = "algorithmic-assessments" if key == "disclosure-aia" else "briefing-packages"
        series = registered_series.get(series, series)
        source["registeredSeries"] = series
        source["family"] = register[series]["family"]


def report_links_by_institution(corpus, aliases):
    root = corpus / "departmental-report-editions"
    pointer = json.loads((root / "latest-attempt.json").read_bytes())
    path = root / "generations" / (pointer["runId"] + ".json")
    if path.parent != root / "generations" or str(path.relative_to(root)) != pointer["reportPath"]:
        raise ValueError("Unexpected report edition generation path")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != pointer["reportSha256"] or len(raw) != pointer["reportBytes"]:
        raise ValueError("Departmental report generation differs from the published receipt")
    report = json.loads(raw)
    if report["runId"] != pointer["runId"] or report["status"] != pointer["status"]:
        raise ValueError("Departmental report generation and receipt identity differ")
    counts = defaultdict(Counter)
    unresolved = Counter()
    for link in report["reportLinks"]:
        identities = aliases.get(normal(link["issuer_label"]), set())
        if len(identities) == 1:
            counts[next(iter(identities))][link["family"]] += 1
        else:
            unresolved[link["family"]] += 1
    summary = {"path": str(path), "sha256": pointer["reportSha256"], "runId": report["runId"],
               "acquisitionStatus": report["status"], "observedAt": report["observedAt"],
               "listedLinks": len(report["reportLinks"]), "unresolvedBySeries": dict(unresolved)}
    return counts, summary


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
        provenance["consultations"] = {"series": "consultations", "url": "https://open.canada.ca/static/consultations_open.csv",
                                       "sha256": db.execute("SELECT csv_sha256 FROM consultations_catalogues WHERE source='canada'").fetchone()[0]}
        for facts, in db.execute("SELECT facts_json FROM consultations_records WHERE removed_at IS NULL"):
            institution = json.loads(facts)["institution"]
            count("consultations", [institution["en"], institution["fr"]])
    if include_acquisitions:
        count_acquisitions(BULK.parent, count, provenance)
        count_eccc_index_editions(BULK.parent, count, provenance, register)
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
                        help="Also attribute the current CanadaBuys, disclosure catalogue and ECCC index records.")
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
