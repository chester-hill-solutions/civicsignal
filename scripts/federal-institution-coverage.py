#!/usr/bin/env python3
"""Match issuers in acquired public-service files to the statutory roster by published names."""
import csv
import gzip
import json
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import unicodedata


ROSTER = Path("docs/evidence/2026-11-23")
BULK = Path("data/corpus/federal-bulk")


def normal(value):
    return " ".join(unicodedata.normalize("NFC", value or "").casefold().replace("’", "'").split())


def resources(db, name):
    item = db.execute("SELECT resources FROM publications WHERE series=? ORDER BY observed_at DESC LIMIT 1", (name,)).fetchone()
    return json.loads(item[0]) if item else []


def rows(resource):
    with gzip.open(BULK / "objects" / (resource["sha256"] + ".csv.gz"), "rt", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def coverage():
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
                ids = set().union(*(aliases.get(normal(n), set()) for n in names))
                if len(ids) == 1:
                    for k in ("Applied title", "Titre d'usage"):
                        if r[k]:
                            aliases[normal(r[k])].update(ids)
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
    institutions = [{"schedule": key[0], "ordinals": groups[key], "legalNameEn": key[1], "legalNameFr": key[2],
                     "publishedRecordCounts": dict(counts[key])} for key in groups]
    return {"scope": "Exact-name attribution of records in acquired sources; statutory names may have no matching published label.",
            "rosterEntries": len(roster), "provisionalNames": len(institutions),
            "namesWithRecords": sum(bool(row["publishedRecordCounts"]) for row in institutions),
            "sources": provenance, "institutions": institutions, "unresolvedPublisherLabels": dict(unmatched)}


if __name__ == "__main__":
    json.dump(coverage(), sys.stdout, ensure_ascii=False, indent=2)
    print()
