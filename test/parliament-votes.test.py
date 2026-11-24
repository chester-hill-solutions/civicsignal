"""Focused fixtures for the bilingual recorded-vote catalogue parser."""

import importlib.util
from pathlib import Path
import unittest
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
SPEC = importlib.util.spec_from_file_location("parliament_votes", ROOT / "scripts/parliament-votes.py")
votes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(votes)


EN = b'''<ArrayOfVote><Vote><ParliamentNumber>45</ParliamentNumber><SessionNumber>1</SessionNumber><DecisionEventDateTime>2025-05-29T18:45:00</DecisionEventDateTime><DecisionDivisionNumber>1</DecisionDivisionNumber><DecisionDivisionSubject>Address in Reply to the Speech</DecisionDivisionSubject><DecisionResultName>Agreed To</DecisionResultName><DecisionDivisionNumberOfYeas>337</DecisionDivisionNumberOfYeas><DecisionDivisionNumberOfNays>0</DecisionDivisionNumberOfNays><DecisionDivisionNumberOfPaired>0</DecisionDivisionNumberOfPaired></Vote></ArrayOfVote>'''
FR = '''<ArrayOfVote><Vote><ParliamentNumber>45</ParliamentNumber><SessionNumber>1</SessionNumber><DecisionEventDateTime>2025-05-29T18:45:00</DecisionEventDateTime><DecisionDivisionNumber>1</DecisionDivisionNumber><DecisionDivisionSubject>Adresse en réponse au discours</DecisionDivisionSubject><DecisionResultName>Adoptée</DecisionResultName><DecisionDivisionNumberOfYeas>337</DecisionDivisionNumberOfYeas><DecisionDivisionNumberOfNays>0</DecisionDivisionNumberOfNays><DecisionDivisionNumberOfPaired>0</DecisionDivisionNumberOfPaired></Vote></ArrayOfVote>'''.encode()


class ParliamentVotesTests(unittest.TestCase):
    def parse(self, data, lang):
        return votes.parse_edition(data, lang, 45, 1)

    def test_parse_edition_maps_official_fields_and_builds_detail_url(self):
        record = self.parse(EN, "en")[1]
        self.assertEqual(record, {
            "key": "1", "language": "en", "title": "Address in Reply to the Speech",
            "summary": "Agreed To (Yeas: 337, Nays: 0, Paired: 0)", "date": "2025-05-29",
            "url": "https://www.ourcommons.ca/Members/en/votes/45/1/1",
            "details": {"kind": "house-vote", "result": "Agreed To", "yeas": 337, "nays": 0, "paired": 0},
        })

    def test_both_editions_required_and_interleaved(self):
        records = votes.combine_editions(self.parse(EN, "en"), self.parse(FR, "fr"))
        self.assertEqual([x["language"] for x in records], ["en", "fr"])
        self.assertEqual(records[1]["title"], "Adresse en réponse au discours")
        self.assertEqual(records[1]["summary"], "Adoptée (Pour: 337, Contre: 0, Pairés: 0)")
        self.assertEqual(records[1]["url"], "https://www.ourcommons.ca/deputes/fr/votes/45/1/1")

    def test_listing_cross_check_sees_all_numbers(self):
        listing = b'<a href="/Members/en/votes/45/1/1">No. 1</a><a href="/Members/en/votes/45/1/2">No. 2</a>'
        self.assertEqual(votes.parse_listing(listing, "en", 45, 1), {1, 2})
        with self.assertRaisesRegex(ValueError, "contains no"):
            votes.parse_listing(b"<html>no links</html>", "en", 45, 1)

    def test_rejects_empty_invalid_and_out_of_session_downloads(self):
        with self.assertRaises(ValueError):
            self.parse(b"<ArrayOfVote/>", "en")
        with self.assertRaises(ValueError):
            self.parse(b"not xml", "en")
        with self.assertRaises(ValueError):
            self.parse(EN.replace(b"<ParliamentNumber>45", b"<ParliamentNumber>44"), "en")

    def test_rejects_duplicate_and_invalid_division_numbers(self):
        duplicate = EN.replace(b"</ArrayOfVote>", EN[EN.index(b"<Vote>"):EN.index(b"</ArrayOfVote>")] + b"</ArrayOfVote>")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.parse(duplicate, "en")
        invalid = EN.replace(b"<DecisionDivisionNumber>1", b"<DecisionDivisionNumber>0")
        with self.assertRaisesRegex(ValueError, "invalid division"):
            self.parse(invalid, "en")

    def test_rejects_bilingual_gaps_or_noncontiguous_bounds(self):
        with self.assertRaisesRegex(ValueError, "mismatch"):
            votes.combine_editions({1: self.parse(EN, "en")[1], 2: {}}, self.parse(FR, "fr"))
        two = EN.replace(b"<DecisionDivisionNumber>1", b"<DecisionDivisionNumber>2")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            votes.combine_editions(self.parse(two, "en"), self.parse(two.replace(b"Address in Reply", b"Adresse"), "fr"))

    def test_rejects_bilingual_tally_disagreement(self):
        en = self.parse(EN, "en")
        fr = self.parse(FR, "fr")
        fr[1]["details"]["yeas"] = 336
        with self.assertRaisesRegex(ValueError, "different vote tallies"):
            votes.combine_editions(en, fr)

    def test_rejects_invalid_session_and_bad_counts(self):
        with self.assertRaises(ValueError):
            votes.parse_session("45-0")
        invalid = EN.replace(b"<DecisionDivisionNumberOfYeas>337", b"<DecisionDivisionNumberOfYeas>many")
        with self.assertRaisesRegex(ValueError, "count"):
            self.parse(invalid, "en")


if __name__ == "__main__":
    unittest.main()
