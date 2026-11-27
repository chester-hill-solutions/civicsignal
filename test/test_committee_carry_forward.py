"""Exercise the private shadow operation with both official House page shapes."""
from contextlib import closing
import gzip
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "services/committee-replay"), str(ROOT / "scripts")]
from carry_forward import carry_forward, cutoff, house_calls, house_links
from lib.committee_calls import PARTICIPATE_INDEX, build_call, parse_study, study_url
from lib.committee_store import initialize, write_link, write_record

SESSION = "45-1"
OLD = "2026-11-22T10:00:00Z"
DAILY = "2026-11-24T10:00:00Z"
LATER = "2026-11-25T10:00:00Z"
COMMITTEE = "house-hesa"
STUDY = "13632808"


class CarryForwardTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.base = self.root / "retained.sqlite", self.root / "base.sqlite"
        self.output, self.receipt = self.root / "shadow.sqlite", self.root / "receipt.json"
        receipt = {"session": SESSION, "observedAt": DAILY, "calls": [], "sources": [],
                   "droppedCalls": [], "studiesNotYetInCorpus": []}
        with closing(initialize(sqlite3.connect(self.source))) as source, source, \
                closing(initialize(sqlite3.connect(self.base))) as base, base:
            source.execute("INSERT INTO cc_snapshot VALUES(?,?)", (SESSION, OLD))
            base.execute("INSERT INTO cc_snapshot VALUES(?,?)", (SESSION, LATER))
            for language, title, session_text in (("en", "Health research", "45th Parliament, 1st Session"),
                                                   ("fr", "Recherche en santé", "45e législature, 1re session")):
                url = study_url("HESA", STUDY, language)
                listing_link = url.removeprefix("https://www.ourcommons.ca")
                listing = f'<div id="collapse-participate-studies"><a href="{listing_link}">{title}</a></div>'
                page = f'<span id="session-bold">{session_text}</span><h1 class="study-title-label">{title}</h1>'
                row = build_call(session=SESSION, language=language, committee="HESA", study_id=STUDY,
                                 listed_title=title, observed_at=DAILY, parsed=parse_study(page, language))
                write_record(source, row)
                for db in (source, base):
                    for identifier, kind, citation in ((COMMITTEE, "committee", f"https://www.ourcommons.ca/Committees/{language}/HESA"),
                                                        (f"{COMMITTEE}-study-{STUDY}", "study", url)):
                        write_record(db, {"session": SESSION, "id": identifier, "language": language, "kind": kind,
                                          "chamber": "house", "committee_id": COMMITTEE, "url": citation, "status": "indexed"})
                write_link(source, SESSION, language, COMMITTEE, row["id"], "publishes")
                write_link(source, SESSION, language, f"{COMMITTEE}-study-{STUDY}", row["id"], "study-call")
                receipt["sources"].append({"chamber": "house", "language": language,
                                           "url": PARTICIPATE_INDEX[language], "sha256": self.original(listing)})
                metadata = row["metadata"]
                receipt["calls"].append({"id": row["id"], "language": language, "title": row["title"], "citation": url,
                                         "committeeId": COMMITTEE, "studyId": STUDY, "sourceSha256": self.original(page),
                                         "revision": metadata["revision"], "deadline": metadata["deadline"],
                                         "instructionUrl": metadata["instructionUrl"], "hasContentWarning": metadata["contentWarning"],
                                         "hasInstructions": metadata["instructions"] is not None})
        self.receipt.write_text(json.dumps(receipt))

    def original(self, content):
        body = content.encode()
        digest = sha256(body).hexdigest()
        path = self.root / "objects" / digest[:2] / (digest + ".gz")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(body))
        return digest

    def publish(self):
        return carry_forward(self.source, self.receipt, self.root, self.base, self.output)

    def test_copies_exact_rows_and_links_into_later_cutoff(self):
        result = self.publish()
        self.assertEqual((result["cutoff"], result["observedAt"], result["linksAdded"], result["originalsVerified"]),
                         (LATER, DAILY, 4, 4))
        with closing(sqlite3.connect(self.output)) as output, closing(sqlite3.connect(self.source)) as source, \
                closing(sqlite3.connect(self.base)) as base:
            output.row_factory = source.row_factory = base.row_factory = sqlite3.Row
            self.assertEqual(house_calls(output), house_calls(source))
            self.assertEqual(house_links(output), house_links(source))
            self.assertEqual((cutoff(source), cutoff(base), cutoff(output)), (OLD, LATER, LATER))
            self.assertEqual(house_calls(base), {})
        repeated = carry_forward(self.source, self.receipt, self.root, self.output, self.root / "second.sqlite")
        self.assertEqual((repeated["linksAdded"], repeated["linksRemoved"]), (0, 0))
        with self.assertRaises(FileExistsError):
            self.publish()

    def test_refuses_wrong_french_parent(self):
        with closing(sqlite3.connect(self.base)) as db, db:
            db.execute("UPDATE cc_records SET url=? WHERE language='fr' AND kind='study'", (study_url("HESA", "1", "fr"),))
        with self.assertRaisesRegex(ValueError, "exact fr House study parent"):
            self.publish()
        self.assertFalse(self.output.exists())

    def test_recovers_the_exact_call_superseded_by_its_own_study(self):
        with closing(sqlite3.connect(self.source)) as source, closing(sqlite3.connect(self.base)) as base, base:
            source.row_factory = sqlite3.Row
            row = next(iter(house_calls(source).values()))
            row["status"] = "superseded"
            row["metadata"] = {**json.loads(row["metadata_json"]), "replacementIds": [f"{COMMITTEE}-study-{STUDY}"]}
            write_record(base, row)
        self.assertEqual(self.publish()["linksAdded"], 4)
        with closing(sqlite3.connect(self.output)) as output:
            status, replacement = output.execute("SELECT status,json_extract(metadata_json,'$.replacementIds') FROM cc_records WHERE id=? AND language=?",
                                                 (row["id"], row["language"])).fetchone()
            self.assertEqual((status, replacement), ("indexed", None))

    def test_refuses_newer_daily_observation(self):
        with closing(sqlite3.connect(self.source)) as source, closing(sqlite3.connect(self.base)) as base, base:
            source.row_factory = sqlite3.Row
            row = next(iter(house_calls(source).values()))
            row["metadata"] = {**json.loads(row["metadata_json"]), "observedAt": LATER}
            write_record(base, row)
        with self.assertRaisesRegex(ValueError, "newer or conflicting House call"):
            self.publish()
        self.assertFalse(self.output.exists())

    def test_refuses_corrupt_retained_study(self):
        digest = json.loads(self.receipt.read_text())["calls"][0]["sourceSha256"]
        (self.root / "objects" / digest[:2] / (digest + ".gz")).write_bytes(gzip.compress(b"wrong"))
        with self.assertRaisesRegex(ValueError, "Original checksum mismatch"):
            self.publish()
        self.assertFalse(self.output.exists())

    def test_refuses_daily_receipt_with_wrong_observation(self):
        receipt = json.loads(self.receipt.read_text())
        receipt["observedAt"] = LATER
        self.receipt.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, "retained row differs from its daily receipt"):
            self.publish()
        self.assertFalse(self.output.exists())

    def test_refuses_retained_link_to_wrong_study(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE cc_links SET parent_id=? WHERE relation='study-call' AND language='fr'",
                       (f"{COMMITTEE}-study-1",))
        with self.assertRaisesRegex(ValueError, "retained House call links do not match"):
            self.publish()
        self.assertFalse(self.output.exists())
