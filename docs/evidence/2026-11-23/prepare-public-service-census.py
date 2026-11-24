"""Validate the dated handover inputs or print the initial federal census as CSV."""

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
FAMILIES = (
    "mandates", "delivery", "management", "advice",
    "research", "regulation", "resources", "assurance",
)


def read_csv(name):
    with (HERE / name).open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def check(condition, message):
    if not condition:
        raise ValueError(message)


def https_link(value):
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.hostname)


def load_handover():
    roster = read_csv("federal-public-service-roster.csv")
    series = read_csv("federal-public-service-sources.csv")
    packet = json.loads((HERE / "federal-public-service-cases.json").read_text(encoding="utf-8"))
    cases = packet["cases"]

    counts = Counter(row["schedule"] for row in roster)
    check(counts == {"I": 23, "IV": 61, "V": 26}, "Dated schedule totals differ")
    groups = defaultdict(list)
    for schedule, count in counts.items():
        rows = [row for row in roster if row["schedule"] == schedule]
        ordinals = [int(row["schedule_ordinal"]) for row in rows]
        check(ordinals == list(range(1, count + 1)), f"Invalid order in schedule {schedule}")
        for row in rows:
            check(row["source_current_to"] == "2026-10-29", "Unexpected consolidation date")
            check(https_link(row["schedule_url"]), "Missing schedule citation")
            key = (schedule, row["legal_name_en"], row["legal_name_fr"])
            check(all(key), "Missing legal name or schedule")
            groups[key].append(row)
    duplicates = [rows for rows in groups.values() if len(rows) > 1]
    check(len(duplicates) == 1, "Review grouping before preparing this census")
    duplicate = duplicates[0]
    check(len(duplicate) == 2 and duplicate[0]["legal_name_en"] == "Canada Border Services Agency",
          "Unexpected duplicate in the schedule")
    check(len({row["entry_annotation"] for row in duplicate if row["entry_annotation"]}) == 2,
          "Missing CBSA annotations")
    check(sum(bool(row["tbs_table_name_en"]) for row in roster) == 41, "Check TBS name comparison")
    roster_by_entry = {(row["schedule"], row["schedule_ordinal"]): row for row in roster}
    linked = {key for key, row in roster_by_entry.items() if row["tbs_table_name_en"]}
    mappings = read_csv("federal-public-service-publisher-names.csv")
    mapped = set()
    for row in mappings:
        entry = (row["schedule"], row["schedule_ordinal"])
        check(roster_by_entry[entry]["legal_name_en"] == row["legal_name_en"], "Crosswalk name mismatch")
        check(row["psc_published_name_en"] and https_link(row["evidence_url"]), "Missing name evidence")
        mapped.add(entry)
        if row["tbs_name_via_psc"]:
            linked.add(entry)
    check((len(mappings), len(mapped), len(linked)) == (89, 88, 78), "Check publisher name mappings")

    series_by_key = {row["series_key"]: row for row in series}
    check(len(series_by_key) == len(series) == 18, "Check source keys and dated series count")
    check({row["family"] for row in series} == set(FAMILIES) | {"all"}, "Missing source family")
    for row in series:
        check(https_link(row["entry_url"]), f"Missing entry URL for {row['series_key']}")
        check(not row["companion_url"] or https_link(row["companion_url"]), "Invalid companion URL")
    check(len({case["id"] for case in cases}) == len(cases) == 10, "Check acceptance case IDs")
    check({case["family"] for case in cases} == set(FAMILIES), "Missing family in acceptance cases")
    for case in cases:
        check(case["series"] in series_by_key and series_by_key[case["series"]]["family"] == case["family"],
              f"Unmatched series for {case['id']}")
        check(set(case["query"]) == {"en", "fr"} and all(case["query"].values()), "Missing bilingual query")
        check(case["required"] and case["reject"] and case["sources"] and all(map(https_link, case["sources"])),
              f"Missing acceptance evidence for {case['id']}")
    evidence = defaultdict(list)
    by_id = {case["id"]: case for case in cases}
    for publisher in packet["observed_publisher_records"]:
        name = publisher["legal_name_en"]
        check(sum(key[1] == name for key in groups) == 1, f"Unresolved publisher {name}")
        check(https_link(publisher["identity_evidence"]), "Missing publisher identity evidence")
        for case_id in publisher["case_ids"]:
            case = by_id[case_id]
            evidence[name, case["family"]].append(case)
    return groups, len(series), len(cases), evidence, packet["observed"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", action="store_true", help="write the discovery worksheet to stdout")
    args = parser.parse_args()
    groups, series_count, case_count, evidence, observed = load_handover()
    if not args.matrix:
        print(f"{len(groups)} provisional names, {len(groups) * len(FAMILIES)} census cells, "
              f"{len(evidence)} cells with evidence, {series_count} source seeds, {case_count} bilingual cases")
        return
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(("schedule", "entry_ordinals", "legal_name_en", "legal_name_fr", "family",
                     "disposition", "evidence_url", "checked_on", "series_keys", "notes"))
    for (schedule, english, french), rows in groups.items():
        ordinals = ",".join(row["schedule_ordinal"] for row in rows)
        for family in FAMILIES:
            examples = evidence.get((english, family), [])
            urls = " | ".join(dict.fromkeys(url for case in examples for url in case["sources"]))
            series = ",".join(sorted({case["series"] for case in examples}))
            writer.writerow((schedule, ordinals, english, french, family,
                             "series-found" if examples else "unexamined", urls,
                             observed if examples else "", series,
                             "Publisher record located; discovery remains open." if examples else ""))


if __name__ == "__main__":
    main()
