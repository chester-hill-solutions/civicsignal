from contextlib import redirect_stdout
import csv
import gzip
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sources = load("federal-source-inventory")
bulk = load("federal-bulk")
disclosures = load("federal-disclosures")


class FederalSources(unittest.TestCase):
    def test_catalogue_requires_expected_dataset_and_main_links(self):
        with self.assertRaises(ValueError):
            sources.describe(b'{"success":true,"result":{"id":"wrong"}}', "https://open.canada.ca", "right")
        with self.assertRaises(ValueError):
            sources.describe(b'<main><h1>Request rejected</h1><a href="/help">Help</a></main>', "https://open.canada.ca", None)
        page = sources.describe(b'<a href="/nav">x</a><main><h1>Policies</h1><a href="/pol/">p</a></main>',
                                "https://canada.ca", None)
        self.assertEqual(page["links"], ["https://canada.ca/pol/"])

    def test_wrong_shape_cannot_replace_a_published_set(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            resources = [{"id": "one", "url": "https://open.canada.ca/a"}, {"id": "two", "url": "https://open.canada.ca/b"}]
            ok = [{"id":"one","sha256":"aaa","rows":1}, {"id":"two","sha256":"bbb","rows":2}]
            with patch.object(bulk, "published_resources", return_value=("date", resources)), redirect_stdout(io.StringIO()):
                with patch.object(bulk, "capture", side_effect=ok):
                    bulk.refresh(root, "official-titles")
                with patch.object(bulk, "capture", side_effect=[ok[0], ValueError("bad CSV")]):
                    with self.assertRaises(ValueError):
                        bulk.refresh(root, "official-titles")
            with sqlite3.connect(root / "publications.sqlite") as db:
                self.assertEqual([json.loads(r[0]) for r in db.execute("SELECT resources FROM publications")], [ok])

    def test_disclosures_reject_duplicate_or_mismatched_pages(self):
        record = {"id": "one", "collection": "aia", "organization": {"name": "publisher"},
                  "title_translated": {"en": "title"}, "resources": []}
        def fake_fetch(root, url):
            return {"count": 2, "results": [record]}, "digest"
        with self.assertRaisesRegex(ValueError, "ordering"):
            disclosures.collect(None, "aia", fake_fetch)
        with self.assertRaisesRegex(ValueError, "collection"):
            disclosures.collect(None, "transition", fake_fetch)

    def test_published_disclosure_links_retain_their_origin(self):
        for url, expected in [("https://www.canada.ca/example", "published-government-https-link"),
                              ("https://example.org", "other-published-link"),
                              ("/relative.pdf", "no-absolute-web-link"), ("", "no-absolute-web-link")]:
            self.assertEqual(disclosures.link_status(url), expected)

    def test_award_nil_returns_are_quarterly(self):
        fields, total = bulk.scan(io.StringIO("fiscal_year,quarter,owner_org,owner_org_title\n2026-2027,1,a,Org\n"),
                                  "grant-awards", nil=True)
        self.assertIn("quarter", fields)
        self.assertEqual(total, 1)
        with self.assertRaisesRegex(ValueError, "fields"):
            bulk.scan(io.StringIO("year,month,owner_org\n2026,4,a\n"), "grant-awards", nil=True)

    def test_validates_every_record_and_preserves_quoted_newlines(self):
        content = '''"Legal title","Appellation légale","Applied title","Titre d'usage"
"one
two",nom,title,nom
'''
        fields, rows = bulk.scan(io.StringIO(content), "official-titles")
        self.assertEqual(rows, 1)
        self.assertEqual(len(fields), 4)
        with self.assertRaises(ValueError):
            bulk.scan(io.StringIO(content + 'bad,row\n'), "official-titles")


if __name__ == "__main__":
    unittest.main()
