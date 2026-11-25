"""Session-wide inventory identity, source relationships and refresh regressions."""

import importlib.util
import gzip
import hashlib
from contextlib import closing
import sqlite3
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from lib.committee_files import cache_db, checkpoint, fetch_url, indexed_notice_originals, object_path  # noqa: E402
from lib.committee_inventory import Inventory  # noqa: E402
from lib.committee_store import initialize  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "committee_corpus", SCRIPTS / "committee-corpus.py"
)
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)


class CommitteeInventoryTests(unittest.TestCase):
    def test_linked_notice_original_must_match_the_catalogue_and_archived_bytes(self):
        url = "https://sencanada.ca/en/committees/noticeofmeeting/123/45-1"
        body = b"<html>45-1</html>"
        digest = hashlib.sha256(body).hexdigest()
        page = dict(sourceUrl=url, sourceSha256=digest, sourceFetchedAt="2026-11-24T21:15:00Z")
        catalogue = {"indexes": {"senate/en/PROC/notice/123": page}}
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with closing(cache_db(root)) as db:
                checkpoint(db, [(url, digest, "text/html", len(body), None, page["sourceFetchedAt"], url)])
            original = object_path(root, digest)
            original.parent.mkdir(parents=True)
            original.write_bytes(gzip.compress(body))
            self.assertEqual(indexed_notice_originals(root, catalogue), {url})
            original.write_bytes(gzip.compress(b"unexpected content"))
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                indexed_notice_originals(root, catalogue)
            page["sourceFetchedAt"] = "2026-11-23T21:15:00Z"
            with self.assertRaisesRegex(ValueError, "archive changed"):
                indexed_notice_originals(root, catalogue)

    def test_brief_cites_an_order_missing_from_the_study_index(self):
        order = "https://sencanada.ca/en/Content/SEN/Committee/451/NFFN/NFFN-ME-26-e"
        directory = "https://sencanada.ca/en/committees/nffn/45-1"
        model = Inventory(
            {
                "session": "45-1",
                "observedAt": "2026-11-23",
                "committees": [
                    dict(
                        code="NFFN",
                        chamber="senate",
                        language="en",
                        name="National Finance",
                        url=directory,
                        directory=directory,
                    )
                ],
                "indexes": {
                    "senate/en/NFFN/briefs": {
                        "url": directory,
                        "links": [
                            dict(
                                kind="submission",
                                title="PDF",
                                url=directory + "/brief.pdf",
                                study="Main Estimates",
                                studyUrl=order,
                            )
                        ],
                    }
                },
            }
        )
        study = model.records["en", "senate-nffn-study-nffn-me-26"]
        self.assertEqual(study["title"], "Main Estimates")
        children = [
            model.records[lang, child]["kind"]
            for lang, parent, child, relation in model.links
            if parent == study["id"] and relation == "study-publication"
        ]
        self.assertCountEqual(children, ["submission", "order-of-reference"])

    def test_published_hash_inside_pdf_name_is_encoded_and_page_anchors_stay_fragments(
        self,
    ):
        url = "https://www.ourcommons.ca/Content/Committee/451/FINA/Brief/BR13581575/br-external/example-#067-250807-003-e.pdf"
        self.assertEqual(fetch_url(url), url.replace("#", "%23"))
        self.assertEqual(
            fetch_url("https://sencanada.ca/report.pdf#page=3"),
            "https://sencanada.ca/report.pdf",
        )

    def test_study_meeting_traversal_and_joint_edition_identity(self):
        base = "https://www.parl.ca/Committees/en/REGS"
        first = base + "/StudyActivity?studyActivityId=42"
        second = base + "/StudyActivity?studyActivityId=43"
        source = "https://www.parl.ca/DocumentViewer/en/45-1/REGS/meeting-1/evidence"
        catalogue = dict(
            session="45-1",
            observedAt="2026-11-23",
            committees=[
                dict(
                    code="REGS",
                    language="en",
                    chamber="house",
                    url=base,
                    name="Scrutiny",
                    directory="house directory",
                ),
                dict(
                    code="REGS",
                    language="en",
                    chamber="senate",
                    url="https://sencanada.ca/en/committees/regs/45-1",
                    name="Scrutiny",
                    directory="senate directory",
                    jointPublicationDirectory=base,
                ),
            ],
            indexes={
                "house/en/REGS/Work": {
                    "url": base,
                    "links": [
                        dict(kind="study", url=first, title="Health"),
                        dict(kind="study", url=second, title="Water"),
                        dict(
                            kind="evidence",
                            url=source,
                            title="Evidence",
                            studyUrls=[first, second],
                        ),
                    ],
                }
            },
        )
        model = Inventory(catalogue)
        self.assertEqual(
            len(model.records["en", "joint-regs"]["metadata"]["directories"]), 2
        )
        for sid in ("42", "43"):
            self.assertIn(
                (
                    "en",
                    "joint-regs-study-" + sid,
                    "joint-regs-meeting-1",
                    "study-meeting",
                ),
                model.links,
            )
        self.assertEqual(len(model.wanted), 1)

    def test_replay_correction_removal_and_late_edition(self):
        db = initialize(sqlite3.connect(":memory:"))
        base = "https://www.ourcommons.ca/Committees/en/ENVI"
        row = dict(
            session="45-1",
            id="house-envi-notice-1",
            language="en",
            kind="notice",
            chamber="house",
            committee_id="house-envi",
            title="Notice",
            url=base,
            status="searchable",
            metadata={"date": "2026-11-19"},
        )
        corpus.update(db, row)
        row["metadata"]["lastChecked"] = "2026-11-24"
        corpus.update(db, row)
        row["metadata"]["date"] = "2026-11-20"
        corpus.update(db, row)
        corpus.update(db, dict(row, language="fr"))
        inventory = Inventory(
            dict(session="45-1", observedAt="2026-11-23", committees=[], indexes={})
        )
        corpus.write_graph(db, inventory)
        corpus.write_graph(db, inventory)
        self.assertEqual(db.execute("SELECT count(*) FROM cc_changes").fetchone()[0], 5)
        self.assertEqual(
            db.execute(
                "SELECT count(*) FROM cc_records WHERE status='removed'"
            ).fetchone()[0],
            2,
        )
        db.close()

    def test_failed_refresh_retains_last_verified_bytes_until_confirmed_removed(self):
        with TemporaryDirectory() as directory:
            db = cache_db(Path(directory))
            url = "https://sencanada.ca/example.pdf"
            checkpoint(
                db, [(url, "a" * 64, "application/pdf", 400, None, "first", url)]
            )
            checkpoint(db, [(url, None, None, 0, "HTTP 503", "second", url)])
            self.assertEqual(
                tuple(db.execute("SELECT digest,error FROM files").fetchone()),
                ("a" * 64, "HTTP 503"),
            )
            checkpoint(db, [(url, None, None, 0, "HTTP 404", "third", url)])
            self.assertIsNone(db.execute("SELECT digest FROM files").fetchone()[0])
            db.close()


if __name__ == "__main__":
    unittest.main()
