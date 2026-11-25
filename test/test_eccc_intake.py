import gzip
import hashlib
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location(
    "eccc_intake", ROOT / "scripts" / "eccc-intake.py"
)
intake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intake)

def archive(root, body):
    """Write a body the way committee_files archives it and return its digest."""
    from lib import committee_files
    digest = hashlib.sha256(body).hexdigest()
    path = committee_files.object_path(root, digest)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as out:
        out.write(body)
    return digest


MIGRATION = (
    ROOT
    / "preview"
    / "departmental-publications"
    / "migrations"
    / "0001_dp.sql"
)
ALTERNATE_MIGRATION = MIGRATION.with_name("0003_dp_alternate_documents.sql")


def entry(language, title, href, series="eval", index_url=None):
    return {
        "series": series,
        "language": language,
        "fiscal_year": "2025 to 2026" if language == "en" else "2025 à 2026",
        "title": title,
        "lead": None,
        "index_url": index_url or f"https://www.canada.ca/{language}/index.html",
        "links": [
            {
                "label": "Report",
                "kind": "report",
                "href": href,
                "path": "/" + href.split("/")[-1],
                "pdf": False,
            }
        ],
    }


def prepared_work(language="en", url="https://www.canada.ca/en/report.html", digest=None,
                  status="stored", series="eval"):
    publication = entry(language, "Example report", url, series=series)
    publication["documents"] = [
        {
            **publication["links"][0],
            "status": status,
            "sha256": digest,
            "media": "text/html",
            "bytes": 7 if digest else None,
            "final_url": url,
            "fetched_at": "2026-11-24T12:00:00Z",
        }
    ]
    return {
        "id": intake.work_id(series, publication),
        "series": series,
        "editions": {language: publication},
    }


def connect():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(MIGRATION.read_text(encoding="utf-8"))
    db.executescript(ALTERNATE_MIGRATION.read_text(encoding="utf-8"))
    return db


def connect_plain():
    db = sqlite3.connect(":memory:")
    db.executescript(MIGRATION.read_text(encoding="utf-8"))
    return db


class ECCCIntake(unittest.TestCase):
    def test_pairing_uses_explicit_alternates_and_keeps_unpaired_single(self):
        english_url = "https://www.canada.ca/en/report.html"
        french_url = "https://www.canada.ca/fr/rapport.html"
        en = entry("en", "English title", english_url)
        fr = entry("fr", "Titre français", french_url)
        paired = intake.pair_entries(
            [en, fr],
            {english_url: {french_url}},
        )
        self.assertEqual(len(paired["works"]), 1)
        self.assertEqual(set(paired["works"][0]["editions"]), {"en", "fr"})
        self.assertEqual(paired["works"][0]["id"], intake.work_id("eval", en))
        unpaired = intake.pair_entries([fr], {})
        self.assertEqual(len(unpaired["works"]), 1)
        self.assertEqual(set(unpaired["works"][0]["editions"]), {"fr"})
        self.assertEqual([gap["kind"] for gap in unpaired["gaps"]], ["pairing"])

    def test_duplicate_appearance_is_counted_without_second_edition(self):
        one = entry("en", "English title", "https://www.canada.ca/en/report.html")
        result = intake.pair_entries([one, dict(one)], {})
        self.assertEqual(result["duplicated_index_appearances"], 1)
        self.assertEqual(len(result["works"]), 1)

    def test_alternates_parser_reads_link_and_anchor_hreflang(self):
        urls = intake.parse_alternates(
            '<link rel="alternate" hreflang="fr" href="/fr/rapport.html">'
            '<a hreflang="en" href="https://www.canada.ca/en/report.html">English</a>',
            "https://www.canada.ca/en/rapport.html",
        )
        self.assertEqual(
            urls,
            {
                "https://www.canada.ca/fr/rapport.html",
                "https://www.canada.ca/en/report.html",
            },
        )

    def test_reciprocal_hreflang_is_additive_and_replay_keeps_index_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "archive"
            source_url = "https://www.canada.ca/en/report.html"
            target_url = "https://www.canada.ca/fr/rapport.html"
            source_body = (
                '<html lang="en"><head><title>English report</title>'
                '<link rel="alternate" hreflang="fr" href="/fr/rapport.html"></head>'
                "<body><main><h1>English report</h1></main></body></html>"
            ).encode()
            target_body = (
                '<html lang="fr"><head><title>Rapport français</title>'
                '<link rel="alternate" hreflang="en" href="/en/report.html"></head>'
                "<body><main><h1>Rapport français</h1><p>Texte officiel français.</p></main></body></html>"
            ).encode()
            source_hash = archive(root, source_body)
            target_hash = archive(root, target_body)
            cache = {
                source_url: {"digest": source_hash, "media": "text/html", "size": len(source_body), "final_url": source_url},
                target_url: {"digest": target_hash, "media": "text/html", "size": len(target_body), "final_url": target_url},
            }
            source = entry("en", "English report", source_url)
            refs = intake._alternate_references(root, [source], cache)
            self.assertEqual(len(refs), 1)
            work_id = intake.work_id("eval", source)
            works = intake.pair_entries([source], {})["works"]
            intake.attach_documents(root, works, cache)
            verified = intake._verified_alternate_documents(
                root, works, refs, cache, "2026-11-25T12:00:00Z"
            )
            self.assertEqual(len(verified), 1)
            alternate = verified[0]
            self.assertEqual(alternate["work_id"], work_id)
            self.assertEqual(alternate["origin_url"], source_url)
            self.assertEqual(alternate["origin_sha256"], source_hash)
            self.assertEqual(alternate["hreflang"], "fr")
            self.assertEqual(alternate["source_fiscal_year"], "2025 to 2026")
            self.assertEqual(alternate["url"], target_url)
            self.assertEqual(alternate["sha256"], target_hash)
            self.assertEqual(alternate["heading"], "Rapport français")
            self.assertEqual(alternate["identity_method"], "reciprocal-hreflang-html-lang-title-h1")

            db = connect()
            try:
                observed = "2026-11-25T12:00:00Z"
                keys = {(work_id, "fr", target_url)}
                intake.write_inventory(db, works, observed, gaps=intake.pair_entries([source], {})["gaps"], alternate_documents=verified,
                                       alternate_reference_keys=keys)
                first_revision = db.execute("SELECT revision FROM dp_inventory").fetchone()[0]
                intake.write_inventory(db, works, observed, gaps=intake.pair_entries([source], {})["gaps"], alternate_documents=verified,
                                       alternate_reference_keys=keys)
                self.assertEqual(db.execute("SELECT id FROM dp_works").fetchone()[0], work_id)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_editions").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT language FROM dp_editions").fetchone()[0], "en")
                self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_alternate_documents WHERE status='verified'").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT revision FROM dp_inventory").fetchone()[0], first_revision)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_gaps WHERE kind='pairing'").fetchone()[0], 1)
            finally:
                db.close()

    def test_ambiguous_hreflang_candidates_are_not_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "archive"
            source_url = "https://www.canada.ca/en/report.html"
            body = (
                '<html lang="en"><head><title>Report</title>'
                '<link rel="alternate" hreflang="fr" href="/fr/rapport-a.html">'
                '<link rel="alternate" hreflang="fr" href="/fr/rapport-b.html"></head>'
                "<body><main><h1>Report</h1></main></body></html>"
            ).encode()
            digest = archive(root, body)
            source = entry("en", "Report", source_url)
            refs = intake._alternate_references(
                root,
                [source],
                {source_url: {"digest": digest, "media": "text/html"}},
            )
            self.assertEqual(refs, [])

    def test_pre_alternate_catalogue_migrates_additively(self):
        db = connect_plain()
        try:
            db.execute("INSERT INTO dp_inventory VALUES(1,'cutoff','observed','revision','{}')")
            intake._load_migration(db)
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("dp_alternate_documents", tables)
            self.assertEqual(db.execute("SELECT cutoff FROM dp_inventory").fetchone()[0], "cutoff")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_editions").fetchone()[0], 0)
        finally:
            db.close()

    def test_unchanged_replay_changed_bytes_and_removal(self):
        db = connect()
        try:
            first_hash = hashlib.sha256(b"first!!").hexdigest()
            second_hash = hashlib.sha256(b"second!").hexdigest()
            work = prepared_work(digest=first_hash)
            start = "2026-11-24T12:00:00Z"
            intake.write_inventory(db, [work], start)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_changes").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_document_versions").fetchone()[0], 1)

            intake.write_inventory(db, [work], start)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_changes").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_document_versions").fetchone()[0], 1)

            changed = prepared_work(digest=second_hash)
            intake.write_inventory(db, [changed], "2026-11-24T13:00:00Z")
            changes = [row[0] for row in db.execute("SELECT change FROM dp_changes ORDER BY seq")]
            self.assertEqual(changes, ["added", "changed"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dp_document_versions").fetchone()[0], 2)

            intake.write_inventory(db, [], "2026-11-24T14:00:00Z", selected_series=("eval",))
            self.assertEqual(
                db.execute("SELECT status FROM dp_documents").fetchone()[0], "removed"
            )
            self.assertEqual(
                db.execute("SELECT change FROM dp_changes ORDER BY seq DESC").fetchone()[0],
                "removed",
            )
        finally:
            db.close()

    def test_404_status_and_document_gap_are_written(self):
        db = connect()
        try:
            work = prepared_work(digest=None, status="unavailable")
            gap = {
                "kind": "document",
                "series": "eval",
                "language": "en",
                "url": work["editions"]["en"]["links"][0]["href"],
                "reason": "HTTP 404",
            }
            result = intake.write_inventory(
                db, [work], "2026-11-24T12:00:00Z", gaps=[gap]
            )
            self.assertEqual(
                db.execute("SELECT status FROM dp_documents").fetchone()[0],
                "unavailable",
            )
            self.assertEqual(db.execute("SELECT kind FROM dp_gaps").fetchone()[0], "document")
            self.assertEqual(result["counts"]["gapsByKind"], {"document": 1})
        finally:
            db.close()

    def test_capture_retries_transient_failure_once_and_not_404(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            url = "https://www.canada.ca/en/report.html"
            attempts = []

            def fake_capture(path, urls, workers, refresh):
                attempts.append((tuple(urls), refresh))
                db = intake.committee_files.cache_db(path)
                try:
                    for item in urls:
                        if len(attempts) == 1:
                            row = (item, None, None, 0, "temporary network error", "now", None)
                        else:
                            row = (item, None, None, 0, "HTTP 404", "now", None)
                        db.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)", row)
                    db.commit()
                finally:
                    db.close()

            result = intake.capture_urls(
                root, [url], workers=8, refresh=True, capture_fn=fake_capture
            )
            self.assertEqual(len(attempts), 2)
            self.assertTrue(all(call[1] for call in attempts))
            self.assertEqual(result[url]["error"], "HTTP 404")
            self.assertEqual(attempts[0][0], attempts[1][0])

    def test_legacy_http_government_links_are_fetched_over_https_and_others_are_gapped(self):
        legacy = "http://www.canada.ca/en/report.html"
        external = "https://example.org/report.html"
        row = entry("en", "Legacy and unsafe links", legacy)
        row["links"].append(
            {"label": "Other", "kind": "other", "href": external, "path": "/report.html"}
        )
        self.assertEqual(
            intake.collect_document_urls([row]),
            ["http://www.canada.ca/en/report.html"],
        )
        work = {
            "id": intake.work_id("eval", row),
            "series": "eval",
            "editions": {"en": row},
        }
        cached = {
            legacy: {
                "digest": "a" * 64,
                "media": "text/html",
                "size": 10,
                "checked": "now",
                "final_url": "https://www.canada.ca/en/report.html",
            }
        }
        gaps = intake.attach_documents(Path("."), [work], cached)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["kind"], "non-official")
        self.assertEqual(gaps[0]["url"], external)

    def test_older_observation_rolls_back(self):
        db = connect_plain()
        try:
            intake.write_inventory(db, [], "2026-11-24T12:00:00Z")
            with self.assertRaises(ValueError):
                intake.write_inventory(db, [], "2026-11-23T12:00:00Z")
            self.assertEqual(
                db.execute("SELECT cutoff FROM dp_inventory").fetchone()[0],
                "2026-11-24T12:00:00Z",
            )
        finally:
            db.close()

    def test_receipt_counts_match_database_rows(self):
        db = connect()
        try:
            digest = hashlib.sha256(b"first!!").hexdigest()
            index = {
                "url": "https://www.canada.ca/en/index.html",
                "series": "eval",
                "language": "en",
                "sha256": hashlib.sha256(b"index").hexdigest(),
                "bytes": 5,
            }
            work = prepared_work(digest=digest)
            result = intake.write_inventory(
                db,
                [work],
                "2026-11-24T12:00:00Z",
                indexes=[index],
                gaps=[
                    {
                        "kind": "pairing",
                        "series": "eval",
                        "language": "en",
                        "url": index["url"],
                        "reason": "No explicit alternate",
                    }
                ],
                duplicated_index_appearances=2,
            )
            counts = result["counts"]
            self.assertEqual(counts["indexes"], db.execute("SELECT COUNT(*) FROM dp_indexes").fetchone()[0])
            self.assertEqual(counts["works"], db.execute("SELECT COUNT(*) FROM dp_works").fetchone()[0])
            self.assertEqual(counts["versions"], db.execute("SELECT COUNT(*) FROM dp_document_versions").fetchone()[0])
            self.assertEqual(counts["pairingGaps"], 1)
            self.assertEqual(counts["duplicatedIndexAppearances"], 2)
            receipt = intake.build_receipt(
                db,
                "2026-11-24T12:00:00Z",
                10,
                [index],
                {"eval": {"en": 1}},
                1,
                counts,
            )
            self.assertEqual(receipt["uniqueWorks"], counts["works"])
            self.assertEqual(receipt["versions"], counts["versions"])
            self.assertEqual(receipt["pairingGaps"], 1)
            self.assertEqual(receipt["indexes"][0]["sha256"], index["sha256"])
        finally:
            db.close()


class ContentDigestTest(unittest.TestCase):
    def test_ignores_volatile_scripts_and_keeps_published_text(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            one = archive(root, b"<html><body><p>Recommendation 1</p><script>var nonce='a';</script></body></html>")
            two = archive(root, b"<html><body><p>Recommendation 1</p><script>var nonce='b';</script></body></html>")
            changed = archive(root, b"<html><body><p>Recommendation 2</p><script>var nonce='a';</script></body></html>")
            media = {"digest": one, "media": "text/html"}
            self.assertEqual(
                intake.content_digest(root, media),
                intake.content_digest(root, {"digest": two, "media": "text/html"}),
            )
            self.assertNotEqual(
                intake.content_digest(root, media),
                intake.content_digest(root, {"digest": changed, "media": "text/html"}),
            )

    def test_keeps_the_byte_digest_for_non_html(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            digest = archive(root, b"%PDF-1.7 ... %%EOF")
            self.assertEqual(
                intake.content_digest(root, {"digest": digest, "media": "application/pdf"}),
                digest,
            )


if __name__ == "__main__":
    unittest.main()
