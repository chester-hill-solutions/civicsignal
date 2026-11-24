import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "reconcile-parliament-senate-journals.py"
SPEC = importlib.util.spec_from_file_location("reconcile_senate_journals", SCRIPT)
reconcile_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reconcile_module)


def journal_record(language, date, key, labels, counts):
    texts = []
    for label, count in zip(labels, counts):
        texts.extend([label, "Nil" if count == 0 else f"Senator A—{count}"])
    return {"language": language, "date": date, "key": str(key),
            "url": f"https://sencanada.ca/{language}/content/sen/chamber/451/journals/086jr_{date}-{'e' if language == 'en' else 'f'}",
            "details": {"status": "published", "passages": [{"text": text} for text in texts]}}


def vote_record(language, date, key, tally):
    return {"language": language, "date": date, "key": str(key),
            "details": {"kind": "senate-vote", "yeas": tally[0], "nays": tally[1], "abstentions": tally[2]}}


class SenateJournalVoteReconciliationTest(unittest.TestCase):
    def test_bilingual_positive_control_and_post_cutoff_totals(self):
        journals = {"records": [
            journal_record("en", "2026-06-18", 86, ["YEAS", "NAYS", "ABSTENTIONS"], [58, 9, 1]),
            journal_record("fr", "2026-06-18", 86, ["POUR", "CONTRE", "ABSTENTIONS"], [58, 9, 1]),
            journal_record("en", "2026-11-17", 102, ["YEAS", "NAYS", "ABSTENTIONS"], [1, 0, 0]),
        ]}
        votes = {"records": [
            vote_record("en", "2026-06-18", 702799, (58, 9, 1)),
            vote_record("fr", "2026-06-18", 702799, (58, 9, 1)),
        ]}
        result = reconcile_module.reconcile(journals, votes)
        self.assertEqual(result["positiveControl"]["en"]["matchedTallyPairs"], 1)
        self.assertEqual(result["positiveControl"]["fr"]["matchedTallyPairs"], 1)
        self.assertEqual(result["postCutoff"]["en"], {
            "journalRollcallEvents": 1, "journalDates": ["2026-11-17"],
            "voteIndexRecords": 0, "voteIndexDates": []})
        self.assertEqual(result["postCutoff"]["fr"]["journalRollcallEvents"], 0)
        self.assertTrue(any(x["language"] == "en" and x["date"] == "2026-11-17"
                            for x in result["unresolvedDifferences"]))
        unmatched = next(x for x in result["unresolvedDifferences"]
                         if x["language"] == "en" and x["date"] == "2026-11-17")
        self.assertEqual(unmatched["journalUnmatched"][0]["sourceVoteBlockOrdinal"], 1)
        self.assertIn("sencanada.ca", unmatched["journalUnmatched"][0]["citation"])
        self.assertEqual(unmatched["journalUnmatched"][0]["explicitZeroEvidence"]["abstentions"], "Nil")

    def test_surfaces_tally_mismatch_and_unparseable_block(self):
        journal = {"records": [journal_record("en", "2026-06-18", 86,
                                               ["YEAS", "NAYS", "ABSTENTIONS"], [57, 9, 1])]}
        votes = {"records": [vote_record("en", "2026-06-18", 702799, (58, 9, 1))]}
        result = reconcile_module.reconcile(journal, votes)
        self.assertEqual(result["positiveControl"]["en"]["matchedTallyPairs"], 0)
        self.assertIn("unmatched", result["unresolvedDifferences"][0]["reason"])
        self.assertEqual(result["unresolvedDifferences"][0]["journalUnmatched"][0]["yeas"], 57)

    def test_nil_is_zero_in_localized_roll_call(self):
        record = journal_record("en", "2026-06-18", 86,
                                ["YEAS", "NAYS", "ABSTENTIONS"], [3, 2, 0])
        events, unresolved = reconcile_module.journal_rollcalls({"records": [record]})
        self.assertEqual(events[("en", "2026-06-18")][0]["abstentions"], 0)
        self.assertEqual(unresolved, [])


if __name__ == "__main__":
    unittest.main()
