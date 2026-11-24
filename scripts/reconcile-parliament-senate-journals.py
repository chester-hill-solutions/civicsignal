#!/usr/bin/env python3
"""Compare bilingual Senate Journals roll-call tallies with the standing-vote index."""

import argparse
from collections import defaultdict
from datetime import date
import json
from pathlib import Path
import re
import sys

LANGUAGES = ("en", "fr")
START_LABEL = {"en": "YEAS", "fr": "POUR"}
NAY_LABEL = {"en": "NAYS", "fr": "CONTRE"}
ABSTENTION_LABELS = {"ABSTENTION", "ABSTENTIONS"}
COUNT_SUFFIX = re.compile(r"[—–−-]\s*(\d+)\s*$")


def _passage_text(record):
    return [str(passage.get("text", "")).strip() for passage in record.get("details", {}).get("passages", [])]


def _count_after(texts, index):
    for candidate in texts[index + 1:index + 5]:
        if candidate.upper() in (START_LABEL["en"], START_LABEL["fr"], NAY_LABEL["en"], NAY_LABEL["fr"], *ABSTENTION_LABELS):
            break
        if candidate.casefold().strip(" .:;()") in ("nil", "none", "néant", "aucun", "aucune"):
            return 0, candidate
        match = COUNT_SUFFIX.search(candidate)
        if match:
            value = int(match.group(1))
            return value, candidate if value == 0 else None
    return None, None


def _context_before(texts, index):
    for candidate in reversed(texts[max(0, index - 40):index]):
        if (re.search(r"\b(?:senator|sénateur|sénatrice)\b.*\b(?:moved|propose|proposé|proposée)\b", candidate, re.I)
                or re.search(r"\bmotion in amendment of\b.*\bsenator\b|\bmotion d’amendement de\b.*\bsénateur", candidate, re.I)):
            return candidate[:500]
    for candidate in reversed(texts[max(0, index - 40):index]):
        if re.search(r"\b(?:moved|move|proposed|propose|proposé|proposée|motion in amendment|motion d’amendement)\b", candidate, re.I):
            return candidate[:500]
    return ""


def journal_rollcalls(journal_payload):
    """Return localized, ordered aggregate tally blocks and unparseable block notes."""
    events = defaultdict(list)
    unresolved = []
    block_ordinals = defaultdict(int)
    for record in journal_payload.get("records", []):
        language = record.get("language")
        if language not in LANGUAGES or record.get("details", {}).get("status") != "published":
            continue
        texts = _passage_text(record)
        start = START_LABEL[language]
        nay = NAY_LABEL[language]
        i = 0
        while i < len(texts):
            if texts[i].upper() != start:
                i += 1
                continue
            event_key = (language, record["date"])
            block_ordinals[event_key] += 1
            block_ordinal = block_ordinals[event_key]
            yeas, yeas_zero = _count_after(texts, i)
            nay_index = next((j for j in range(i + 1, len(texts)) if texts[j].upper() == nay), None)
            abstention_index = (next((j for j in range(nay_index + 1, len(texts))
                                      if texts[j].upper() in ABSTENTION_LABELS), None)
                                if nay_index is not None else None)
            nays, nays_zero = _count_after(texts, nay_index) if nay_index is not None else (None, None)
            abstentions, abstentions_zero = _count_after(texts, abstention_index) if abstention_index is not None else (None, None)
            if None in (yeas, nays, abstentions):
                unresolved.append({"language": language, "date": record["date"], "issue": record["key"],
                                   "sourceVoteBlockOrdinal": block_ordinal, "citation": record.get("url", ""),
                                   "unknownCountCategories": [name for name, value in
                                                               (("yeas", yeas), ("nays", nays), ("abstentions", abstentions))
                                                               if value is None],
                                   "reason": "roll-call marker block has a missing YEAS/POUR, NAYS/CONTRE, or abstention count"})
            else:
                events[event_key].append({"issue": record["key"], "sourceVoteBlockOrdinal": block_ordinal,
                                          "citation": record.get("url", ""),
                                          "yeas": yeas, "nays": nays, "abstentions": abstentions,
                                          "explicitZeroEvidence": {"yeas": yeas_zero, "nays": nays_zero,
                                                                   "abstentions": abstentions_zero},
                                          "context": _context_before(texts, i)})
            i = (abstention_index + 1) if abstention_index is not None else i + 1
    return events, unresolved


def vote_index_events(vote_payload):
    events = defaultdict(list)
    for record in vote_payload.get("records", []):
        language = record.get("language")
        details = record.get("details", {})
        if language not in LANGUAGES or details.get("kind") != "senate-vote":
            continue
        events[(language, record["date"])].append({"key": str(record["key"]),
                                                     "yeas": details.get("yeas"),
                                                     "nays": details.get("nays"),
                                                     "abstentions": details.get("abstentions")})
    for rows in events.values():
        rows.sort(key=lambda row: int(row["key"]))
    return events


def reconcile(journal_payload, vote_payload, cutoff="2026-06-18", positive_control="2026-06-18"):
    cutoff = date.fromisoformat(cutoff).isoformat()
    positive_control = date.fromisoformat(positive_control).isoformat()
    journal_events, unresolved = journal_rollcalls(journal_payload)
    vote_events = vote_index_events(vote_payload)
    mismatches = []
    matches = defaultdict(int)
    matches_by_date = defaultdict(int)
    all_days = {(language, day) for language, day in journal_events} | {(language, day) for language, day in vote_events}
    for language, day in sorted(all_days):
        journal_rows = journal_events.get((language, day), [])
        vote_rows = vote_events.get((language, day), [])
        journal_remaining = list(journal_rows)
        vote_remaining = list(vote_rows)
        for journal_row in list(journal_remaining):
            match_index = next((i for i, vote_row in enumerate(vote_remaining)
                                if all(journal_row[field] == vote_row[field]
                                       for field in ("yeas", "nays", "abstentions"))), None)
            if match_index is not None:
                matches[language] += 1
                matches_by_date[(language, day)] += 1
                journal_remaining.remove(journal_row)
                vote_remaining.pop(match_index)
        if journal_remaining or vote_remaining:
            mismatches.append({"language": language, "date": day, "journalRollcalls": len(journal_rows),
                               "voteIndexRecords": len(vote_rows), "reason": "unmatched roll-call/index tally blocks",
                               "journalUnmatched": [{"issue": row["issue"],
                                                     "sourceVoteBlockOrdinal": row["sourceVoteBlockOrdinal"],
                                                     "citation": row["citation"], "context": row["context"],
                                                     "explicitZeroEvidence": row["explicitZeroEvidence"],
                                                     "yeas": row["yeas"],
                                                     "nays": row["nays"], "abstentions": row["abstentions"]}
                                                    for row in journal_remaining],
                               "voteIndexUnmatched": [{"key": row["key"], "yeas": row["yeas"],
                                                       "nays": row["nays"], "abstentions": row["abstentions"]}
                                                      for row in vote_remaining]})
    unresolved.extend(mismatches)
    post_cutoff = {}
    totals = {}
    for language in LANGUAGES:
        totals[language] = {
            "journalRollcallEvents": sum(len(rows) for (lang, _), rows in journal_events.items() if lang == language),
            "voteIndexRecords": sum(len(rows) for (lang, _), rows in vote_events.items() if lang == language),
            "matchedTallyPairs": matches[language],
        }
        journal_post = [(day, len(rows)) for (lang, day), rows in journal_events.items()
                        if lang == language and day > cutoff]
        vote_post = [(day, len(rows)) for (lang, day), rows in vote_events.items()
                     if lang == language and day > cutoff]
        post_cutoff[language] = {
            "journalRollcallEvents": sum(count for _, count in journal_post),
            "journalDates": sorted(day for day, _ in journal_post),
            "voteIndexRecords": sum(count for _, count in vote_post),
            "voteIndexDates": sorted(day for day, _ in vote_post),
        }
    control = {}
    for language in LANGUAGES:
        control[language] = {
            "journalRollcallEvents": len(journal_events.get((language, positive_control), [])),
            "voteIndexRecords": len(vote_events.get((language, positive_control), [])),
            "matchedTallyPairs": matches_by_date.get((language, positive_control), 0),
        }
    return {"cutoff": cutoff, "positiveControlDate": positive_control,
            "totals": totals, "matchedTallyPairs": dict(matches), "positiveControl": control,
            "postCutoff": post_cutoff, "unresolvedDifferences": unresolved}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journals", required=True, help="senate-journals.json")
    parser.add_argument("--votes", required=True, help="senate-votes.json")
    parser.add_argument("--cutoff", default="2026-06-18", help="inclusive last vote date to reconcile")
    parser.add_argument("--positive-control", default="2026-06-18", help="known date that must match in both sources")
    args = parser.parse_args(argv)
    try:
        result = reconcile(json.loads(Path(args.journals).read_text()), json.loads(Path(args.votes).read_text()),
                           args.cutoff, args.positive_control)
    except Exception as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if any(result["positiveControl"][lang]["journalRollcallEvents"] == 0
           or result["positiveControl"][lang]["journalRollcallEvents"] != result["positiveControl"][lang]["voteIndexRecords"]
           for lang in LANGUAGES):
        return 2
    return 1 if result["unresolvedDifferences"] else 0


if __name__ == "__main__":
    sys.exit(main())
