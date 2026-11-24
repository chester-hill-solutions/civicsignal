"""Tests for reconciling named Senate ballots from official Journal editions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "parliament-journal-roll-calls.py"
SPEC = importlib.util.spec_from_file_location("parliament_journal_roll_calls", SCRIPT)
rollcalls = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollcalls)
FIXTURES = ROOT / "test" / "fixtures" / "senate-journal-rollcalls"
DATE = "2025-06-26"


class FakeReconciler:
    def __init__(self, unmatched=None, journal_events=None, vote_events=None):
        self.unmatched = unmatched or []
        self.journal_events = journal_events or {}
        self.vote_events = vote_events or {}

    def reconcile(self, journals, votes):
        return {"cutoff": "2026-06-18", "positiveControlDate": "2026-06-18",
                "unresolvedDifferences": self.unmatched}

    def journal_rollcalls(self, journals):
        return self.journal_events, []

    def vote_index_events(self, votes):
        return self.vote_events


def source_record(language, digest):
    return {"key": "16", "language": language, "date": DATE,
            "url": f"https://sencanada.ca/{language}/content/sen/chamber/451/journals/016jr_2025-06-26-{'e' if language == 'en' else 'f'}",
            "details": {"kind": "senate-journal", "status": "published", "passages": []}}


def unmatched_row(language, citation):
    return {"issue": "16", "sourceVoteBlockOrdinal": 3, "citation": citation,
            "context": ("And on the motion in amendment of the Honourable Senator McPhedran, seconded by Senator Karetak-Lindell:" if language == "en" else
                        "Et sur la motion d’amendement de l’honorable sénatrice McPhedran, appuyée par la sénatrice Karetak-Lindell :"),
            "yeas": 6, "nays": 67, "abstentions": 7}


def fixture_inputs(directory, vote_index_unmatched=False):
    base_date = "2026-06-18"
    journals = {"session": "45-1", "collection": "senate-journals", "observedAt": "2026-11-24T03:00:00Z",
                "records": [], "sources": []}
    base_votes = {"session": "45-1", "collection": "senate-votes", "records": []}
    indexed = {"session": "45-1", "collection": "senate-roll-calls", "records": []}
    base_member = {"name": "Senator Example", "position": "yea", "memberId": "1",
                   "affiliation": "ISG", "constituency": None, "province": "Ontario",
                   "url": "https://sencanada.ca/en/in-the-chamber/votes/senator/1/45-1", "paired": False}
    reports = []
    for language in ("en", "fr"):
        record = source_record(language, "")
        fixture = (FIXTURES / f"issue-16-{language}.html").read_bytes()
        digest = hashlib.sha256(fixture).hexdigest()
        record["details"]["passages"] = [
            {"text": unmatched_row(language, record["url"])["context"], "url": record["url"], "links": []},
        ]
        journals["records"].append(record)
        journals["sources"].append({"url": record["url"], "sha256": digest, "bytes": len(fixture)})
        target = Path(directory) / "sources" / "objects" / digest[:2] / digest
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(fixture)
        base_votes["records"].append({"key": "999", "language": language, "date": base_date,
            "details": {"kind": "senate-vote", "yeas": 1, "nays": 0, "abstentions": 0}})
        indexed["records"].append({"key": "999", "language": language, "date": base_date,
            "details": {"kind": "senate-roll-call", "members": [dict(base_member)]}})
        report = {"language": language, "date": DATE,
                  "journalUnmatched": [unmatched_row(language, record["url"])],
                  "voteIndexUnmatched": ([{"key": "777"}] if vote_index_unmatched else [])}
        reports.append(report)
    journal_path = Path(directory) / "senate-journals.json"
    journal_path.write_text(json.dumps(journals))
    return journal_path, journals, base_votes, indexed, reports


class JournalRollCallsTest(unittest.TestCase):
    def test_real_june_26_block_is_named_and_bilingual(self):
        blocks = {}
        for language in ("en", "fr"):
            blocks[language] = rollcalls.parse_rollcall_blocks(
                (FIXTURES / f"issue-16-{language}.html").read_bytes(), language)
            self.assertEqual(len(blocks[language]), 3)
            block = blocks[language][2]
            rollcalls._validate_block(block, language, {"yeas": 6, "nays": 67, "abstentions": 7})
        en = rollcalls._members_by_identity(blocks["en"][2], "en")
        fr = rollcalls._members_by_identity(blocks["fr"][2], "fr")
        self.assertEqual(set(en), set(fr))
        self.assertTrue(all(en[name]["position"] == fr[name]["position"] for name in en))
        self.assertEqual(len(en), 80)

    def test_supplement_reconciles_archived_editions_and_preserves_unknown_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            journal_path, journals, base_votes, indexed, reports = fixture_inputs(directory)
            fake = FakeReconciler(reports,
                journal_events={(lang, DATE): [{"yeas": 6, "nays": 67, "abstentions": 7}] for lang in ("en", "fr")},
                vote_events={})
            output = rollcalls.supplement(journal_path, journals, base_votes, indexed, fake)

        self.assertEqual(len(output["records"]), 4)
        self.assertEqual(output["journalReconciliation"]["observedAt"], journals["observedAt"])
        self.assertEqual(output["journalReconciliation"]["journalOnlyRecordsPerLanguage"], 1)
        self.assertEqual(output["journalReconciliation"]["journalOnlyRecordsByLanguage"], {"en": 1, "fr": 1})
        for language in ("en", "fr"):
            row = next(record for record in output["records"] if record["key"] == "j16-3" and record["language"] == language)
            self.assertEqual(row["details"]["journalIssue"], "16")
            self.assertEqual(row["details"]["journalVoteOrdinal"], 3)
            self.assertEqual(row["title"], "Senate Journal vote, issue 16, vote block 3" if language == "en" else
                             "Scrutin du Sénat, fascicule 16, bloc de vote 3")
            self.assertIn("McPhedran", row["summary"])
            self.assertEqual((row["details"]["yeas"], row["details"]["nays"], row["details"]["abstentions"]), (6, 67, 7))
            self.assertTrue(all(member["memberId"] is None and member["url"] is None and not member["paired"]
                                for member in row["details"]["members"]))

    def test_rejects_unmatched_index_rows_and_repeated_tally_ambiguity(self):
        with tempfile.TemporaryDirectory() as directory:
            journal_path, journals, votes, indexed, reports = fixture_inputs(directory, vote_index_unmatched=True)
            fake = FakeReconciler(reports,
                journal_events={(lang, DATE): [{"yeas": 6, "nays": 67, "abstentions": 7}] for lang in ("en", "fr")},
                vote_events={})
            with self.assertRaisesRegex(ValueError, "unmatched vote-index rows remain"):
                rollcalls.supplement(journal_path, journals, votes, indexed, fake)

        with tempfile.TemporaryDirectory() as directory:
            journal_path, journals, votes, indexed, reports = fixture_inputs(directory)
            fake = FakeReconciler(reports,
                journal_events={("en", DATE): [
                    {"yeas": 6, "nays": 67, "abstentions": 7},
                    {"yeas": 6, "nays": 67, "abstentions": 7}],
                    ("fr", DATE): [{"yeas": 6, "nays": 67, "abstentions": 7}]},
                vote_events={("en", DATE): [{"yeas": 6, "nays": 67, "abstentions": 7}]})
            with self.assertRaisesRegex(ValueError, "repeated Journal tally"):
                rollcalls.supplement(journal_path, journals, votes, indexed, fake)

    def test_rejects_unparseable_count_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            journal_path, journals, votes, indexed, _ = fixture_inputs(directory)
            fake = FakeReconciler([{"language": "en", "date": DATE,
                                    "unknownCountCategories": ["abstentions"],
                                    "reason": "missing abstention count"}])
            with self.assertRaisesRegex(ValueError, "unparseable Journal roll-call block"):
                rollcalls.supplement(journal_path, journals, votes, indexed, fake)

    def test_rejects_truncated_or_unheaded_ballot_source(self):
        with self.assertRaisesRegex(ValueError, "appears truncated"):
            rollcalls.parse_rollcall_blocks(b"<html><div id='content-viewer-document'>", "en")
        html = b"<html><div id='content-viewer-document'><p>YEAS</p><p><span class='spanMembersList'>Name</span></p></div></html>"
        blocks = rollcalls.parse_rollcall_blocks(html, "en")
        with self.assertRaisesRegex(ValueError, "lacks a recognized tally position heading"):
            rollcalls._validate_block(blocks[0], "en", {"yeas": 1, "nays": 0, "abstentions": 0})


if __name__ == "__main__":
    unittest.main()
