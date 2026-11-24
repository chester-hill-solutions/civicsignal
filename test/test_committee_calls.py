"""Check the House consultation parser against the shapes it was written for."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from lib.committee_calls import (  # noqa: E402
    build_call,
    call_id,
    parse_deadline,
    parse_participate,
    parse_session,
    parse_study,
)

PARTICIPATE = """
<div id="collapse-participate-studies">
  <ul>
    <li><a href="/committees/en/HESA">HESA Standing Committee on Health</a></li>
    <li><a href="/committees/en/HESA/StudyActivity?studyActivityId=13632808">Diagnostic Imaging Capacity</a></li>
    <li><a href="/committees/en/HUMA/StudyActivity?studyActivityId=13666586">Bill S-209, An Act to restrict young persons&#8217; online access to pornographic material</a></li>
    <li><a href="/committees/fr/HESA/StudyActivity?studyActivityId=13632808">Capacit&#233; en imagerie diagnostique</a></li>
  </ul>
</div>
"""

STUDY = """
<div class="panel panel-default study-header"><div class="core-content">
  <span id="session-bold">45th Parliament, 1st Session</span>
  <h1 class="study-title-label">Diagnostic Imaging Capacity</h1>
</div></div>
<div class="panel panel-default"><div class="core-content study-participation-container">
  <h3>Participate</h3>
  <a class="btn btn-dark" href="/committee-participation/en/submit-brief/hesa/13632808" title="Submit a brief">
    <div class="btn-title">Submit a brief</div>
    <span class="btn-subtitle">before 11:59 p.m. (EST) on Monday, November 30, 2026</span>
  </a>
</div></div>
<div class="panel panel-default"><div class="core-content">
  <div class="custom-message-container x">
    <div id="custom-message-1" class="custom-message"><div>
      <p>Written submissions of no more than 2,000 words can be submitted to the committee.</p>
      <p>Email <a href="mailto:HESA@parl.gc.ca">HESA@parl.gc.ca</a>.</p>
    </div></div>
  </div>
</div></div>
<!-- Information -->
"""

BILL = """
<div class="panel panel-default study-header"><div class="core-content">
  <span id="session-bold">45e l&#233;gislature, 1re session</span>
  <h1 class="study-bill-label">Projet de loi S-209</h1>
  <h2 class="study-bill-title-label">Loi limitant l&#8217;acc&#232;s en ligne des jeunes au mat&#233;riel pornographique</h2>
</div></div>
<div class="core-content study-participation-container">
  <h3>Participez</h3>
  <a class="btn btn-dark" href="/committee-participation/fr/submit-brief/huma/13666586" title="Pr&#233;sentez un m&#233;moire">
    <div class="btn-title">Pr&#233;sentez un m&#233;moire</div>
    <span class="btn-subtitle">avant 23 h 59 (HNE) le vendredi 8 janvier 2027</span>
  </a>
</div>
<div class="custom-message-container x">
  <div id="custom-message-1" class="custom-message"><div><b>Les m&#233;moires ne doivent pas d&#233;passer deux pages.</b></div></div>
  <div id="custom-message-2" class="custom-message"><div><b>Avertissement : Le mat&#233;riel publi&#233; peut contenir du contenu sensible.</b></div></div>
</div>
<!-- Information -->
"""


class ParticipateIndexTest(unittest.TestCase):
    def test_keeps_the_studies_listed_for_one_edition_in_source_order(self):
        studies = parse_participate(PARTICIPATE, "en")
        self.assertEqual([study["study_id"] for study in studies], ["13632808", "13666586"])
        self.assertEqual(studies[0]["committee"], "HESA")
        self.assertEqual(studies[0]["title"], "Diagnostic Imaging Capacity")
        self.assertEqual(
            studies[1]["title"],
            "Bill S-209, An Act to restrict young persons\u2019 online access to pornographic material",
        )

    def test_reads_the_session_from_each_edition(self):
        self.assertEqual(parse_session(STUDY, "en"), "45-1")
        self.assertEqual(parse_session(BILL, "fr"), "45-1")


class StudyPageTest(unittest.TestCase):
    def test_reads_the_button_deadline_and_instructions(self):
        study = parse_study(STUDY, "en")
        self.assertEqual(study["page_title"], "Diagnostic Imaging Capacity")
        self.assertEqual(study["instruction_href"], "/committee-participation/en/submit-brief/hesa/13632808")
        self.assertEqual(study["deadline_text"], "before 11:59 p.m. (EST) on Monday, November 30, 2026")
        self.assertEqual(study["deadline"]["instant"], "2026-12-01T04:59:00Z")
        self.assertEqual(
            study["instructions"],
            "Written submissions of no more than 2,000 words can be submitted to the committee. "
            "Email HESA@parl.gc.ca .",
        )
        self.assertFalse(study["content_warning"])
        self.assertIsNone(study["content_warning_text"])

    def test_reads_a_bill_header_french_labels_and_the_content_warning(self):
        study = parse_study(BILL, "fr")
        self.assertEqual(
            study["page_title"],
            "Projet de loi S-209, Loi limitant l\u2019acc\u00e8s en ligne des jeunes au mat\u00e9riel pornographique",
        )
        self.assertEqual(study["deadline_text"], "avant 23 h 59 (HNE) le vendredi 8 janvier 2027")
        self.assertTrue(study["content_warning"])
        self.assertEqual(study["instructions"], "Les m\u00e9moires ne doivent pas d\u00e9passer deux pages.")
        self.assertTrue(study["content_warning_text"].startswith("Avertissement"))


class DeadlineTest(unittest.TestCase):
    def test_turns_a_complete_english_phrase_into_an_eastern_instant(self):
        self.assertEqual(
            parse_deadline("before 11:59 p.m. (EST) on Monday, November 30, 2026", "en"),
            {"text": "before 11:59 p.m. (EST) on Monday, November 30, 2026",
             "instant": "2026-12-01T04:59:00Z", "timeZone": "EST"},
        )

    def test_turns_a_complete_french_phrase_into_an_eastern_instant(self):
        self.assertEqual(
            parse_deadline("avant 23 h 59 (HNE) le vendredi 8 janvier 2027", "fr")["instant"],
            "2027-01-09T04:59:00Z",
        )

    def test_keeps_a_phrase_it_cannot_place_instead_of_guessing(self):
        text = "before 11:59 p.m. (EST) on Monday, December 1, 2026"
        self.assertEqual(
            parse_deadline(text, "en"), {"text": text, "instant": None, "timeZone": "EST"}
        )
        unknown = "before 11:59 p.m. (XYZ) on Monday, November 30, 2026"
        self.assertIsNone(parse_deadline(unknown, "en")["instant"])
        self.assertIsNone(parse_deadline(None, "en"))

    def test_rejects_a_time_that_is_not_twelve_hour(self):
        self.assertIsNone(parse_deadline("before 23:59 p.m. (EST) on Monday, November 30, 2026", "en")["instant"])


class CallRecordTest(unittest.TestCase):
    def setUp(self):
        self.parsed = {
            "instruction_href": "/committee-participation/en/submit-brief/hesa/13632808",
            "deadline": parse_deadline("before 11:59 p.m. (EST) on Monday, November 30, 2026", "en"),
            "instructions": "Written submissions of no more than 2,000 words.",
            "content_warning": False,
            "content_warning_text": None,
        }

    def build(self, **overrides):
        arguments = dict(
            session="45-1", language="en", committee="HESA", study_id="13632808",
            listed_title="Diagnostic Imaging Capacity", observed_at="2026-11-24T12:00:00Z",
            parsed=self.parsed,
        )
        arguments.update(overrides)
        return build_call(**arguments)

    def test_uses_civicsignal_ids_and_the_study_page_as_the_citation(self):
        record = self.build()
        self.assertEqual(record["id"], call_id("HESA", "13632808"))
        self.assertEqual(record["id"], "house-hesa-call-13632808")
        self.assertEqual(record["committee_id"], "house-hesa")
        self.assertEqual(
            record["url"],
            "https://www.ourcommons.ca/committees/en/HESA/StudyActivity?studyActivityId=13632808",
        )
        self.assertEqual(record["metadata"]["deadline"]["instant"], "2026-12-01T04:59:00Z")
        self.assertEqual(
            record["metadata"]["instructionUrl"],
            "https://www.ourcommons.ca/committee-participation/en/submit-brief/hesa/13632808",
        )

    def test_counts_a_revision_only_when_the_published_call_changes(self):
        first = self.build(observed_at="2026-11-24T12:00:00Z")
        self.assertEqual(first["metadata"]["revision"], 1)
        unchanged = self.build(observed_at="2026-11-25T12:00:00Z", existing=first)
        self.assertEqual(unchanged["metadata"]["revision"], 1)
        self.assertEqual(unchanged["metadata"]["firstObservedAt"], "2026-11-24T12:00:00Z")
        self.assertEqual(unchanged["metadata"]["observedAt"], "2026-11-25T12:00:00Z")
        changed = self.build(
            observed_at="2026-11-26T12:00:00Z",
            existing=first,
            parsed=dict(self.parsed, instructions="Written submissions of no more than 1,000 words."),
        )
        self.assertEqual(changed["metadata"]["revision"], 2)
        self.assertEqual(changed["metadata"]["firstObservedAt"], "2026-11-24T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
