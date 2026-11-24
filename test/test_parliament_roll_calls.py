import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.parliament_ballots import parse_roll, reconcile

SCRIPT = ROOT / "scripts" / "parliament-roll-calls.py"
SPEC = importlib.util.spec_from_file_location("parliament_roll_calls", SCRIPT)
roll_calls = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(roll_calls)


def house_page(language="en"):
    is_fr = language == "fr"
    route = "/deputes/fr" if is_fr else "/Members/en"
    province = "Québec" if is_fr else "Quebec"
    party = "Libéral" if is_fr else "Liberal"
    yea, paired = ("Pour", "Pairés") if is_fr else ("Yea", "Paired")
    return f"""<!doctype html><html lang="{language}"><body>
      <div class="mip-vote-votedetails-section"><h1>{'Vote n<sup>o</sup> 198' if is_fr else 'Vote No. 198'}</h1><h2>{'Détails du vote' if is_fr else 'Vote details'}</h2>
      <div id="btn-mp-view"><table class="table table-striped ce-mip-table-mobile"><tbody>
      <tr><th>Member</th><th>Party</th><th>Vote</th><th>Paired</th></tr>
      <tr><td><a href="{route}/123">Alex Member</a><br>(Example Centre)</td><td>{party}</td><td>{yea}</td><td>{paired}</td></tr>
      <tr><td><a href="{route}/456">Sam Member</a><br>(Example North)</td><td>{party}</td><td></td><td>{paired}</td></tr>
      </tbody></table></div>
      <div id="btn-province-view"><div><h3>{province}</h3><table class="table ce-mip-table-mobile"><tbody>
      <tr><th>Member</th><th>Party</th><th>Vote</th><th>Paired</th></tr>
      <tr><td><a href="{route}/123">Alex Member</a></td><td>{party}</td><td>{yea}</td><td>{paired}</td></tr>
      <tr><td><a href="{route}/456">Sam Member</a></td><td>{party}</td><td></td><td>{paired}</td></tr>
      </tbody></table></div></div>
      <div id="btn-party-view"></div><div id="btn-result-view"></div>
      </div></body></html>""".encode()


def senate_page(language="en"):
    is_fr = language == "fr"
    path = "/fr/dans-la-chambre/votes/senateur" if is_fr else "/en/in-the-chamber/votes/senator"
    affiliation = "GSI" if is_fr else "ISG"
    province = "Québec" if is_fr else "Quebec"
    labels = ("Pour", "Contre", "Abstention") if is_fr else ("Yea", "Nay", "Abstention")
    detail_path = "/fr/dans-la-chambre/votes/details" if is_fr else "/en/in-the-chamber/votes/details"
    return f"""<!doctype html><html lang="{language}"><body><a href="{detail_path}/665744/45-1">Current vote</a><table class="table sc-table" id="sc-vote-details-table">
      <thead><tr><th>Senator</th><th>Affiliation</th><th>Province/Territory</th><th>{labels[0]}</th><th>{labels[1]}</th><th>{labels[2]}</th></tr></thead>
      <tbody><tr><td><a href="{path}/321/45-1">Senator Example</a></td><td>{affiliation}</td><td>{province}</td>
      <td><i class="fa-solid fa-times" aria-hidden="true"></i></td><td></td><td></td></tr>
      <tr><td><a href="{path}/654/45-1">Senator Other</a></td><td>{affiliation}</td><td>Ontario</td>
      <td></td><td></td><td><i class="fa-solid fa-times" aria-hidden="true"></i></td></tr></tbody>
      </table></body></html>""".encode()


class ParliamentRollCallsTest(unittest.TestCase):
    def test_house_real_publisher_structure_preserves_paired_overlap_and_province(self):
        urls = (
            "https://www.ourcommons.ca/Members/en/votes/45/1/198",
            "https://www.ourcommons.ca/deputes/fr/votes/45/1/198",
        )
        editions = [parse_roll(house_page(language), language, "45-1", url, "house")[1]
                    for language, url in zip(("en", "fr"), urls)]
        result = reconcile(*editions, {"yeas": 1, "nays": 0, "paired": 2}, "house", 198)
        self.assertEqual(result["yea"], 1)
        member = editions[0]["123"]
        self.assertEqual(member["position"], "yea")
        self.assertTrue(member["paired"])
        self.assertEqual(member["province"], "Quebec")
        self.assertEqual(editions[1]["456"]["position"], "paired")
        self.assertEqual(editions[0]["456"]["constituency"], "Example North")

    def test_senate_real_publisher_structure_and_localized_affiliation(self):
        urls = (
            "https://sencanada.ca/en/in-the-chamber/votes/details/665744/45-1",
            "https://sencanada.ca/fr/dans-la-chambre/votes/details/665744/45-1",
        )
        editions = [parse_roll(senate_page(language), language, "45-1", url, "senate")[1]
                    for language, url in zip(("en", "fr"), urls)]
        self.assertEqual(reconcile(*editions, {"yeas": 1, "nays": 0, "abstentions": 1}, "senate", 665744)["abstention"], 1)
        self.assertEqual(editions[1]["321"]["url"], "https://sencanada.ca/fr/dans-la-chambre/votes/senateur/321/45-1")
        self.assertFalse(editions[0]["321"]["paired"])
        self.assertIsNone(editions[0]["321"]["constituency"])

    def test_rejects_bilingual_roster_and_aggregate_mismatches(self):
        en = parse_roll(house_page("en"), "en", "45-1", "https://www.ourcommons.ca/Members/en/votes/45/1/198", "house")[1]
        fr = parse_roll(house_page("fr"), "fr", "45-1", "https://www.ourcommons.ca/deputes/fr/votes/45/1/198", "house")[1]
        with self.assertRaisesRegex(ValueError, "yeas tally"):
            reconcile(en, fr, {"yeas": 2, "nays": 0, "paired": 2}, "house", 198)
        fr.pop("123")
        with self.assertRaisesRegex(ValueError, "bilingual roster mismatch"):
            reconcile(en, fr, {"yeas": 1, "nays": 0, "paired": 2}, "house", 198)

    def test_rejects_wrong_session_or_unverified_source_routes(self):
        with self.assertRaisesRegex(ValueError, "invalid official house detail URL"):
            parse_roll(house_page(), "en", "45-1", "https://www.ourcommons.ca/Members/en/votes/44/1/198", "house")
        with self.assertRaisesRegex(ValueError, "must point to a house-votes or senate-votes"):
            roll_calls._validate_parent({"collection": "other", "session": "45-1", "records": []})

    def test_rejects_page_payload_that_does_not_match_requested_identity(self):
        wrong = house_page().replace(b"Vote No. 198", b"Vote No. 197")
        with self.assertRaisesRegex(ValueError, "heading does not identify division 198"):
            parse_roll(wrong, "en", "45-1", "https://www.ourcommons.ca/Members/en/votes/45/1/198", "house")


if __name__ == "__main__":
    unittest.main()
