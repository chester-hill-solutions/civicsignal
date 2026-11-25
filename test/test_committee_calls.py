"""Check the House consultation parser against the shapes it was written for."""

import gzip
import hashlib
import importlib.util
import io
import json
import sqlite3
import sys
import unittest
from contextlib import redirect_stdout
from tempfile import TemporaryDirectory
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from lib.committee_calls import (  # noqa: E402
    build_call,
    mark_unlisted,
    call_id,
    PARTICIPATE_INDEX,
    parse_call_editions,
    parse_call_indexes,
    parse_deadline,
    parse_participate,
    parse_session,
    parse_study,
    study_url,
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


class CallObservationTest(unittest.TestCase):
    def setUp(self):
        self.listings = parse_call_indexes({url: PARTICIPATE for url in PARTICIPATE_INDEX.values()})
        self.pages = {
            study_url(study["committee"], study["study_id"], lang): STUDY if lang == "en" else BILL
            for lang, rows in self.listings.items() for study in rows
        }

    def test_rejects_every_wrong_or_missing_session_before_returning_calls(self):
        french = study_url("HESA", "13632808", "fr")
        for body in [BILL.replace("45e", "44e"), BILL.replace("45e", "unknown")]:
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "expected session 45-1"):
                parse_call_editions("45-1", self.listings, {**self.pages, french: body})

    def test_shared_motion_is_flagged_for_distinct_studies_only_in_the_same_language(self):
        standard = parse_call_editions("45-1", self.listings, self.pages)
        self.assertTrue(all(not edition["shares_with"] for edition in standard))
        motion = "The same motion was published for this study."
        pages = {url: body.split('id="custom-message-1"')[0] +
                 'id="custom-message-1" class="custom-message"><p>' + motion + '</p></div><!-- Information -->'
                 for url, body in self.pages.items()}
        editions = parse_call_editions("45-1", self.listings, pages)
        self.assertEqual([(e["language"], e["study"]["study_id"], e["shares_with"]) for e in editions],
                         [("en", "13632808", ["13666586"]), ("en", "13666586", ["13632808"]),
                          ("fr", "13632808", [])])


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

    def test_records_the_listing_observation_without_a_revision(self):
        first = self.build(observed_at="2026-11-24T12:00:00Z")
        self.assertTrue(first["metadata"]["listed"])
        self.assertEqual(first["metadata"]["lastListedAt"], "2026-11-24T12:00:00Z")
        from lib.committee_store import signature
        dropped = dict(first, metadata=dict(first["metadata"], listed=False))
        self.assertEqual(signature(first), signature(dropped))

    def test_requires_a_second_observation_before_committing_a_content_change(self):
        first = self.build(observed_at="2026-11-24T12:00:00Z")
        self.assertEqual(first["metadata"]["revision"], 1)
        changed_parsed = dict(self.parsed, instructions="Written submissions of no more than 1,000 words.")
        candidate = self.build(observed_at="2026-11-25T12:00:00Z", existing=first, parsed=changed_parsed)
        self.assertEqual(candidate["metadata"]["revision"], 1)
        self.assertEqual(candidate["metadata"]["instructions"], self.parsed["instructions"])
        self.assertIsNotNone(candidate["metadata"]["pendingDigest"])
        self.assertEqual(candidate["metadata"]["firstObservedAt"], "2026-11-24T12:00:00Z")
        committed = self.build(observed_at="2026-11-26T12:00:00Z", existing=candidate, parsed=changed_parsed)
        self.assertEqual(committed["metadata"]["revision"], 2)
        self.assertEqual(committed["metadata"]["instructions"], "Written submissions of no more than 1,000 words.")
        self.assertIsNone(committed["metadata"]["pendingDigest"])

    def test_holds_content_that_another_study_also_published(self):
        first = self.build(observed_at="2026-11-24T12:00:00Z")
        shared = dict(self.parsed, instructions="Another study's motion.")
        seen_twice = self.build(
            observed_at="2026-11-25T12:00:00Z", existing=first, parsed=shared,
            conflict=True,
        )
        self.assertEqual(seen_twice["metadata"]["revision"], 1)
        self.assertEqual(seen_twice["metadata"]["instructions"], self.parsed["instructions"])
        self.assertTrue(seen_twice["metadata"]["contentConflict"])
        self.assertIsNotNone(seen_twice["metadata"]["pendingDigest"])

    def test_does_not_commit_a_page_that_alternates_between_two_blocks(self):
        first = self.build(observed_at="2026-11-24T12:00:00Z")
        other = dict(self.parsed, instructions="Another study's motion.")
        seen_other = self.build(observed_at="2026-11-25T12:00:00Z", existing=first, parsed=other)
        back = self.build(observed_at="2026-11-26T12:00:00Z", existing=seen_other, parsed=self.parsed)
        self.assertEqual(back["metadata"]["revision"], 1)
        self.assertEqual(back["metadata"]["instructions"], self.parsed["instructions"])
        self.assertIsNone(back["metadata"]["pendingDigest"])


class CachedOperatorTest(unittest.TestCase):
    def setUp(self):
        from lib.committee_calls import SENATE_CHECKS
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        path = Path(__file__).resolve().parents[1] / "scripts/committee-calls.py"
        spec = importlib.util.spec_from_file_location("local_calls", path)
        self.operator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.operator)
        self.pages = {url: PARTICIPATE for url in PARTICIPATE_INDEX.values()}
        self.english = study_url("HESA", "13632808", "en")
        self.pages.update({self.english: STUDY, study_url("HUMA", "13666586", "en"): STUDY,
                           study_url("HESA", "13632808", "fr"): BILL})
        self.pages.update({url: "<html>Committee</html>" for urls in SENATE_CHECKS.values() for url in urls})

    def archive(self, checked, only=None):
        from lib.committee_files import cache_db, object_path
        db = cache_db(self.root)
        try:
            with db:
                for url in only or self.pages:
                    body = self.pages[url].encode()
                    digest = hashlib.sha256(body).hexdigest()
                    dest = object_path(self.root, digest)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(gzip.compress(body))
                    db.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",
                               (url, digest, "text/html", len(body), None, checked, url))
        finally:
            db.close()

    def run_operator(self):
        receipt = self.root / "receipt.json"
        argv = ["committee-calls.py", "--from-cache", "--root", str(self.root), "--db", str(self.root / "calls.db"),
                "--receipt", str(receipt)]
        with (
            patch.object(sys, "argv", argv),
            patch("lib.committee_files.download", side_effect=AssertionError("network")),
            redirect_stdout(io.StringIO()),
        ):
            self.operator.main()
        return json.loads(receipt.read_text())

    def test_one_publisher_sighting_only_counts_once_for_a_pending_change(self):
        self.archive("2026-11-23T12:00:00.123456Z")
        self.run_operator()
        self.pages[self.english] = STUDY.replace("2,000", "1,000")
        self.archive("2026-11-24T12:00:00.123456Z")
        first = self.run_operator()
        self.assertEqual(first["counts"]["pending"], 1)
        replay = self.run_operator()
        self.assertEqual((replay["observedAt"], replay["counts"], replay["calls"]),
                         (first["observedAt"], first["counts"], first["calls"]))
        self.archive("2026-11-25T12:00:00.123456Z", only=[self.english])
        with self.assertRaisesRegex(ValueError, "mixes"):
            self.run_operator()
        self.archive("2026-11-25T12:00:00.123456Z")
        confirmed = self.run_operator()
        self.assertEqual((confirmed["counts"]["changed"], confirmed["counts"]["pending"]), (1, 0))
        self.assertEqual(next(c["revision"] for c in confirmed["calls"] if c["citation"] == self.english), 2)

    def test_cached_listing_cannot_drop_or_relist_and_a_fresh_listing_can(self):
        self.archive("2026-11-23T12:00:00.123456Z")
        initial = self.run_operator()
        en = PARTICIPATE_INDEX["en"]
        self.pages[en] = PARTICIPATE.replace("studyActivityId=13666586", "omitted=13666586")
        self.archive("2026-11-23T12:00:00.123456Z", only=[en])
        with self.assertRaisesRegex(ValueError, "cached listing differs"):
            self.run_operator()
        self.archive("2026-11-24T12:00:00.123456Z")
        dropped = self.run_operator()
        self.assertEqual(dropped["droppedCalls"], [{"id": "house-huma-call-13666586", "language": "en",
                                                   "lastListedAt": initial["observedAt"]}])
        self.assertEqual(self.run_operator()["droppedCalls"], [])
        self.pages[en] = PARTICIPATE
        self.archive("2026-11-24T12:00:00.123456Z", only=[en])
        with self.assertRaisesRegex(ValueError, "cached listing differs"):
            self.run_operator()
        self.archive("2026-11-25T12:00:00.123456Z")
        relisted = self.run_operator()
        self.assertEqual((relisted["counts"]["calls"], relisted["counts"]["changed"]), (3, 0))


class UnlistedCallTest(unittest.TestCase):
    def setUp(self):
        from lib.committee_store import initialize, update
        self.update = update
        self.db = initialize(sqlite3.connect(":memory:"))
        self.db.row_factory = sqlite3.Row
        self.parsed = {
            "instruction_href": "/committee-participation/en/submit-brief/test/1",
            "deadline": None,
            "instructions": None,
            "content_warning": False,
            "content_warning_text": None,
        }

    def tearDown(self):
        self.db.close()

    def write(self, study_id):
        record = build_call(
            session="45-1", language="en", committee="TEST", study_id=study_id,
            listed_title=f"Study {study_id}", observed_at="2026-11-24T12:00:00Z",
            parsed=self.parsed,
        )
        self.update(self.db, record)
        return record["id"]

    def test_marks_absent_calls_without_creating_a_revision(self):
        first = self.write("1")
        second = self.write("2")
        changes = self.db.execute("SELECT count(*) AS n FROM cc_changes").fetchone()["n"]
        dropped = mark_unlisted(self.db, "45-1", {(first, "en")})
        self.assertEqual([entry["id"] for entry in dropped], [second])
        self.assertEqual(dropped[0]["lastListedAt"], "2026-11-24T12:00:00Z")
        row = self.db.execute("SELECT metadata_json FROM cc_records WHERE id=?", (second,)).fetchone()
        metadata = json.loads(row["metadata_json"])
        self.assertFalse(metadata["listed"])
        self.assertEqual(metadata["lastListedAt"], "2026-11-24T12:00:00Z")
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM cc_changes").fetchone()["n"], changes)
        self.assertEqual(mark_unlisted(self.db, "45-1", {(first, "en")}), [])

    def test_relisting_restores_the_flag(self):
        record = self.write("1")
        mark_unlisted(self.db, "45-1", set())
        again = build_call(
            session="45-1", language="en", committee="TEST", study_id="1",
            listed_title="Study 1", observed_at="2026-11-25T12:00:00Z", parsed=self.parsed,
            existing={"metadata": json.loads(self.db.execute(
                "SELECT metadata_json FROM cc_records WHERE id=?", (record,)
            ).fetchone()["metadata_json"])},
        )
        again["metadata"] = {**again["metadata"]}
        again["metadata"]["listed"] = True
        again["metadata"]["lastListedAt"] = "2026-11-25T12:00:00Z"
        self.update(self.db, again)
        metadata = json.loads(self.db.execute(
            "SELECT metadata_json FROM cc_records WHERE id=?", (record,)).fetchone()["metadata_json"])
        self.assertTrue(metadata["listed"])
        self.assertEqual(metadata["lastListedAt"], "2026-11-25T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
