#!/usr/bin/env python3
"""Supplement indexed Senate roll calls with verified Journal-only ballots."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.parliament_intake import save_atomic

LANGUAGES = ("en", "fr")
EXPECTED_KIND = "senate-roll-call"
REGION_ALIASES = {
    "terre-neuve-et-labrador": "newfoundland and labrador",
    "nouvelle-ecosse": "nova scotia",
    "nouveau-brunswick": "new brunswick",
    "quebec": "quebec",
    "ile-du-prince-edouard": "prince edward island",
    "colombie-britannique": "british columbia",
    "territoires-du-nord-ouest": "northwest territories",
}
LABELS = {
    "en": {"start": "YEAS", "yea": "YEAS", "nay": "NAYS", "abstention": "ABSTENTIONS"},
    "fr": {"start": "POUR", "yea": "POUR", "nay": "CONTRE", "abstention": "ABSTENTIONS"},
}
POSITION_BY_LABEL = {
    "en": {"YEAS": "yea", "NAYS": "nay", "ABSTENTIONS": "abstention", "ABSTENTION": "abstention"},
    "fr": {"POUR": "yea", "CONTRE": "nay", "ABSTENTIONS": "abstention", "ABSTENTION": "abstention"},
}


def _load_reconciler():
    path = Path(__file__).resolve().parent / "reconcile-parliament-senate-journals.py"
    spec = importlib.util.spec_from_file_location("senate_journal_reconciliation", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load Senate Journal reconciliation tool")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class JournalBallotParser(HTMLParser):
    """Retain Senate Journal vote-block ordinal, positions, and listed names."""
    def __init__(self, language):
        super().__init__(convert_charrefs=True)
        self.language = language
        self.in_document = False
        self.document_depth = 0
        self.in_paragraph = False
        self.paragraph_text = []
        self.paragraph_has_members = False
        self.current_block = None
        self.current_position = None
        self.member = None
        self.member_depth = 0
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div" and attrs.get("id") == "content-viewer-document":
            self.in_document = True
            self.document_depth = 1
        elif self.in_document and tag == "div":
            self.document_depth += 1
        if not self.in_document:
            return
        if tag == "p":
            self.in_paragraph = True
            self.paragraph_text = []
            self.paragraph_has_members = False
        if tag == "span" and "spanMembersList" in attrs.get("class", "").split():
            if self.current_block is not None and self.current_position is not None:
                self.member = {"text": [], "position": self.current_position}
                self.member_depth = 1
                self.paragraph_has_members = True
        elif self.member is not None and tag == "span":
            self.member_depth += 1

    def handle_data(self, data):
        if self.in_paragraph:
            self.paragraph_text.append(data)
        if self.member is not None:
            self.member["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "span" and self.member is not None:
            self.member_depth -= 1
            if self.member_depth <= 0:
                name = clean("".join(self.member["text"]))
                name = re.sub(r"\s*[—–−-]\s*[0-9]+\s*$", "", name).strip()
                if not name:
                    raise ValueError("Senate Journal contains an empty senator name")
                self.current_block["members"].append({"name": name, "position": self.member["position"]})
                self.member = None
        if tag == "p" and self.in_paragraph:
            text = clean("".join(self.paragraph_text))
            self.in_paragraph = False
            label = text.upper().strip(" .:;()")
            if label == LABELS[self.language]["start"]:
                self.current_block = {"ordinal": len(self.blocks) + 1, "members": [], "positions": {"yea"}}
                self.blocks.append(self.current_block)
                self.current_position = "yea"
            elif self.current_block is not None and label in POSITION_BY_LABEL[self.language]:
                self.current_position = POSITION_BY_LABEL[self.language][label]
                self.current_block["positions"].add(self.current_position)
            elif self.paragraph_has_members:
                # Journal lists are one paragraph per roll-call position. Stop
                # accepting names after that list so attendance rosters cannot
                # leak into the ballot.
                self.current_position = None
        if tag == "div" and self.in_document:
            self.document_depth -= 1
            if self.document_depth <= 0:
                self.in_document = False
                self.current_position = None


def clean(value):
    return re.sub(r"\s+", " ", value).strip()


def parse_rollcall_blocks(data, language):
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if "</html" not in data.lower() or "content-viewer-document" not in data:
        raise ValueError(f"{language} Senate Journal HTML appears truncated")
    parser = JournalBallotParser(language)
    parser.feed(data)
    parser.close()
    if not parser.blocks:
        raise ValueError(f"{language} Senate Journal contains no roll-call blocks")
    return parser.blocks


def _unaccent(value):
    return "".join(char for char in unicodedata.normalize("NFKD", value)
                   if not unicodedata.combining(char))


def canonical_member_name(value):
    """Normalize published EN/FR regional suffixes without collapsing people."""
    value = clean(value)
    match = re.fullmatch(r"(.+?)\s*\(([^()]*)\)", value)
    if match:
        name, region = match.groups()
        region_key = _unaccent(region).casefold().strip()
        region = REGION_ALIASES.get(region_key, region_key)
        value = f"{name} ({region})"
    return _unaccent(value).casefold()


def _members_by_identity(block, language):
    members = block["members"]
    keys = [canonical_member_name(row["name"]) for row in members]
    duplicates = [name for name, count in Counter(keys).items() if count > 1]
    if duplicates:
        raise ValueError(f"{language} Journal block has colliding senator names: {duplicates}")
    return dict(zip(keys, members))


def _validate_block(block, language, expected):
    if block.get("positions") != {"yea", "nay", "abstention"}:
        raise ValueError(f"{language} Journal block {block['ordinal']} lacks a recognized tally position heading")
    counts = Counter(member["position"] for member in block["members"])
    tally = {"yeas": counts["yea"], "nays": counts["nay"], "abstentions": counts["abstention"]}
    expected_tally = {key: expected[key] for key in tally}
    if tally != expected_tally:
        raise ValueError(f"{language} Journal block {block['ordinal']} named-position counts {tally} differ from reconciled tally {expected_tally}")
    if len(block["members"]) != sum(expected_tally.values()):
        raise ValueError(f"{language} Journal block {block['ordinal']} does not account for every recorded vote")
    _members_by_identity(block, language)
    return tally


def _source_data(journal_path, journal_packet, citation):
    sources = {row.get("url"): row.get("sha256") for row in journal_packet.get("sources", [])}
    digest = sources.get(citation)
    if not re.fullmatch(r"[0-9a-f]{64}", digest or ""):
        raise ValueError(f"Archived Senate Journal source has no valid hash: {citation}")
    object_path = Path(journal_path).parent / "sources" / "objects" / digest[:2] / digest
    data = object_path.read_bytes()
    if sha256(data).hexdigest() != digest:
        raise ValueError(f"Archived Senate Journal source hash mismatch: {citation}")
    return data


def _motion_context(journal_record, language, ordinal, fallback):
    passages = journal_record.get("details", {}).get("passages", [])
    texts = [clean(str(row.get("text", ""))) for row in passages]
    start = LABELS[language]["start"]
    headings = [i for i, text in enumerate(texts) if text.upper().strip(" .:;()") == start]
    if ordinal <= len(headings):
        index = headings[ordinal - 1]
        candidates = texts[max(0, index - 40):index]
        motion = next((text for text in reversed(candidates)
                       if re.search(r"motion.{0,160}(?:senator|sénateur|sénatrice)", text, re.I)
                       or re.search(r"(?:senator|sénateur|sénatrice).{0,160}motion", text, re.I)), None)
        if motion:
            return motion
    return clean(str(fallback or ""))


def _indexed_identity_map(packet, label):
    result = {}
    for record in packet.get("records", []):
        if record.get("language") not in LANGUAGES or not record.get("key"):
            raise ValueError(f"{label} contains an invalid key/language identity")
        identity = (str(record["key"]), record["language"])
        if identity in result:
            raise ValueError(f"{label} contains duplicate key/language identity {identity}")
        result[identity] = record
    return result


def validate_indexed_rollcalls(vote_packet, rollcall_packet):
    votes = _indexed_identity_map(vote_packet, "Senate vote index")
    rollcalls = _indexed_identity_map(rollcall_packet, "Indexed Senate roll-call packet")
    if set(votes) != set(rollcalls):
        missing = sorted(set(votes) - set(rollcalls))
        extra = sorted(set(rollcalls) - set(votes))
        raise ValueError(f"Indexed Senate member records do not cover the vote index: missing {missing[:10]}, extra {extra[:10]}")
    for identity, vote in votes.items():
        vote_details = vote.get("details", {})
        rollcall = rollcalls[identity]
        details = rollcall.get("details", {})
        if vote_details.get("kind") != "senate-vote" or details.get("kind") != EXPECTED_KIND:
            raise ValueError(f"Unexpected vote/roll-call kind for {identity}")
        if vote.get("date") != rollcall.get("date"):
            raise ValueError(f"Indexed Senate vote and member records have different dates for {identity}")
        members = details.get("members")
        if not isinstance(members, list) or not members:
            raise ValueError(f"Indexed Senate roll call {identity} has no member roster")
        positions = Counter()
        member_ids = set()
        for member in members:
            if not isinstance(member, dict) or member.get("position") not in ("yea", "nay", "abstention"):
                raise ValueError(f"Indexed Senate roll call {identity} contains an invalid member position")
            if not isinstance(member.get("name"), str) or not member["name"].strip():
                raise ValueError(f"Indexed Senate roll call {identity} contains a nameless member")
            member_id = member.get("memberId")
            if not isinstance(member_id, str) or not member_id or member_id in member_ids:
                raise ValueError(f"Indexed Senate roll call {identity} contains an invalid or duplicate profile ID")
            member_ids.add(member_id)
            positions[member["position"]] += 1
        observed = {"yeas": positions["yea"], "nays": positions["nay"], "abstentions": positions["abstention"]}
        expected = {field: vote_details.get(field) for field in observed}
        if observed != expected:
            raise ValueError(f"Indexed Senate roster counts differ from vote index for {identity}: {observed} vs {expected}")
    return votes, rollcalls


def supplement(journal_path, journal_packet, vote_packet, base_rollcalls, reconcile_module=None):
    if journal_packet.get("collection") != "senate-journals" or vote_packet.get("collection") != "senate-votes" or base_rollcalls.get("collection") != "senate-roll-calls":
        raise ValueError("Expected Senate Journals, Senate votes, and indexed Senate roll-call packets")
    session = journal_packet.get("session")
    if not session or session != vote_packet.get("session") or session != base_rollcalls.get("session"):
        raise ValueError("Senate source packets do not identify the same session")
    _, rollcall_map = validate_indexed_rollcalls(vote_packet, base_rollcalls)
    records = list(base_rollcalls.get("records", []))
    base_ids = set(rollcall_map)

    reconcile_module = reconcile_module or _load_reconciler()
    reconciliation = reconcile_module.reconcile(journal_packet, vote_packet)
    journal_events, _ = reconcile_module.journal_rollcalls(journal_packet)
    vote_events = reconcile_module.vote_index_events(vote_packet)
    unmatched = {}
    ambiguity = []
    for report in reconciliation["unresolvedDifferences"]:
        if report.get("unknownCountCategories"):
            raise ValueError(f"Cannot supplement an unparseable Journal roll-call block: {report}")
        language = report.get("language")
        day = report.get("date")
        if language not in LANGUAGES:
            continue
        if report.get("voteIndexUnmatched"):
            for row in report.get("journalUnmatched", []):
                ambiguity.append({"language": language, "date": day,
                    "issue": row.get("issue"), "sourceVoteBlockOrdinal": row.get("sourceVoteBlockOrdinal"),
                    "reason": "unmatched vote-index rows remain on the same date"})
            continue
        for row in report.get("journalUnmatched", []):
            tally = (row.get("yeas"), row.get("nays"), row.get("abstentions"))
            journal_rows = [event for event in journal_events.get((language, day), [])
                            if (event["yeas"], event["nays"], event["abstentions"]) == tally]
            indexed_rows = [event for event in vote_events.get((language, day), [])
                            if (event["yeas"], event["nays"], event["abstentions"]) == tally]
            if len(journal_rows) > 1 and len(indexed_rows) < len(journal_rows):
                ambiguity.append({"language": language, "date": day,
                    "issue": row.get("issue"), "sourceVoteBlockOrdinal": row.get("sourceVoteBlockOrdinal"),
                    "reason": "repeated Journal tally has fewer matching vote-index occurrences; leftover block identity is ambiguous"})
                continue
            identity = (str(row.get("issue")), row.get("sourceVoteBlockOrdinal"), day)
            if not identity[0] or type(identity[1]) is not int or identity[1] < 1 or not day:
                raise ValueError(f"Reconciliation emitted an invalid source block identity: {row}")
            editions = unmatched.setdefault(identity, {})
            if language in editions:
                raise ValueError(f"Reconciliation emitted duplicate unmatched block {identity}")
            editions[language] = row

    if ambiguity:
        raise ValueError("Refusing ambiguous Journal-only Senate roll calls: " + json.dumps(ambiguity, ensure_ascii=False))

    supplemental = []
    for (issue, ordinal, day), editions in sorted(unmatched.items(), key=lambda item: (item[0][2], int(item[0][0]), item[0][1])):
        if set(editions) != set(LANGUAGES):
            raise ValueError(f"Journal-only block {issue}-{ordinal} is not unresolved in both official languages")
        en_row, fr_row = editions["en"], editions["fr"]
        if ((en_row.get("yeas"), en_row.get("nays"), en_row.get("abstentions")) !=
                (fr_row.get("yeas"), fr_row.get("nays"), fr_row.get("abstentions"))):
            raise ValueError(f"Bilingual Journal-only block {issue}-{ordinal} has different tallies")
        if en_row.get("citation") == fr_row.get("citation"):
            raise ValueError(f"Bilingual Journal-only block {issue}-{ordinal} has one shared citation")
        result_by_language = {}
        for language, row in editions.items():
            citation = row.get("citation", "")
            parsed_url = urlsplit(citation)
            if parsed_url.scheme != "https" or parsed_url.hostname not in ("sencanada.ca", "www.sencanada.ca"):
                raise ValueError(f"Journal-only block has a non-official citation: {citation}")
            source_records = [record for record in journal_packet["records"]
                             if record.get("key") == issue and record.get("language") == language]
            if len(source_records) != 1 or source_records[0].get("date") != day or source_records[0].get("url") != citation:
                raise ValueError(f"Journal-only block {issue}-{ordinal} does not match one published Journal row")
            raw = _source_data(journal_path, journal_packet, citation)
            blocks = parse_rollcall_blocks(raw, language)
            if ordinal > len(blocks):
                raise ValueError(f"{language} Journal issue {issue} has no source vote block ordinal {ordinal}")
            block = blocks[ordinal - 1]
            if block["ordinal"] != ordinal:
                raise ValueError("Journal source block parser produced an unstable ordinal")
            _validate_block(block, language, row)
            result_by_language[language] = (block, row)
        en_members = _members_by_identity(result_by_language["en"][0], "en")
        fr_members = _members_by_identity(result_by_language["fr"][0], "fr")
        if set(en_members) != set(fr_members):
            only_en = sorted(set(en_members) - set(fr_members))
            only_fr = sorted(set(fr_members) - set(en_members))
            raise ValueError(f"Bilingual Journal-only block {issue}-{ordinal} has different named members: EN-only {only_en}, FR-only {only_fr}")
        if any(en_members[name]["position"] != fr_members[name]["position"] for name in en_members):
            raise ValueError(f"Bilingual Journal-only block {issue}-{ordinal} has different member positions")
        for language in LANGUAGES:
            block, row = result_by_language[language]
            key = f"j{issue}-{ordinal}"
            if (key, language) in base_ids:
                raise ValueError(f"Indexed Senate roll-call identity collides with supplement {key}/{language}")
            names = block["members"]
            journal_record = next(record for record in journal_packet["records"]
                                  if record.get("key") == issue and record.get("language") == language)
            context = _motion_context(journal_record, language, ordinal, row.get("context"))
            source_description = context or (
                "The Journal records an amendment vote." if language == "en" else
                "Le Journal consigne un vote sur une motion d’amendement.")
            if language == "en":
                title = f"Senate Journal vote, issue {issue}, vote block {ordinal}"
                summary = (f"{source_description} " if context else "") + f"{row['yeas']} yeas, {row['nays']} nays and {row['abstentions']} abstentions."
            else:
                title = f"Scrutin du Sénat, fascicule {issue}, bloc de vote {ordinal}"
                summary = (f"{source_description} " if context else "") + f"{row['yeas']} pour, {row['nays']} contre et {row['abstentions']} abstentions."
            record = {
                "key": key,
                "language": language,
                "title": title,
                "summary": summary,
                "date": day,
                "url": row["citation"],
                "details": {
                    "kind": EXPECTED_KIND,
                    "journalIssue": issue,
                    "journalVoteOrdinal": ordinal,
                    "yeas": row["yeas"], "nays": row["nays"], "abstentions": row["abstentions"],
                    "members": [{"name": member["name"], "position": member["position"],
                                 "memberId": None, "affiliation": None, "constituency": None,
                                 "province": None, "url": None, "paired": False}
                                for member in names],
                },
            }
            records.append(record)
            supplemental.append(record)
    records.sort(key=lambda row: (row["date"], row["language"],
                                  (1, int(row["key"][1:].split("-", 1)[0]), int(row["key"].split("-", 1)[1]))
                                  if row["key"].startswith("j") else (0, int(row["key"]), 0)))
    per_language = {language: sum(row["language"] == language for row in supplemental) for language in LANGUAGES}
    if per_language["en"] != per_language["fr"]:
        raise ValueError(f"Bilingual Journal-only supplement counts differ: {per_language}")
    source_map = {}
    for source in (list(journal_packet.get("sources", [])) + list(vote_packet.get("sources", [])) +
                   list(base_rollcalls.get("sources", []))):
        source_map[(source.get("url"), source.get("sha256"))] = source
    source_list = list(source_map.values())
    return {"session": session, "collection": "senate-roll-calls",
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "journalReconciliation": {"observedAt": journal_packet.get("observedAt"),
                "journalOnlyRecordsPerLanguage": per_language["en"],
                "journalOnlyRecordsByLanguage": per_language,
                "verifiedJournalOnlyBlockCount": len(supplemental) // 2,
                "reconciliationCutoff": reconciliation.get("cutoff"),
                "positiveControlDate": reconciliation.get("positiveControlDate")},
            "records": records, "sources": source_list}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journals", required=True, help="archived senate-journals.json")
    parser.add_argument("--votes", required=True, help="senate-votes.json tally index")
    parser.add_argument("--roll-calls", required=True, help="senate-roll-calls.json indexed member records")
    parser.add_argument("--output", required=True, help="combined output JSON path")
    args = parser.parse_args(argv)
    try:
        journals = json.loads(Path(args.journals).read_text())
        votes = json.loads(Path(args.votes).read_text())
        roll_calls = json.loads(Path(args.roll_calls).read_text())
        result = supplement(args.journals, journals, votes, roll_calls)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        save_atomic(output, result)
    except Exception as exc:
        parser.error(str(exc))
    counts = {language: sum(row["language"] == language for row in result["records"]) for language in LANGUAGES}
    print(f"Wrote {len(result['records'])} records for {result['session']} to {args.output} ({counts}; Journal supplement {result['journalReconciliation']['journalOnlyRecordsPerLanguage']})")


if __name__ == "__main__":
    main()
