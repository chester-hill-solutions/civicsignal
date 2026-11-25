from importlib import import_module
import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
catalogue = import_module("federal-publication-catalogue")


class PublicationCatalogueTests(unittest.TestCase):
    def test_distinct_sources_and_immutable_last_good_after_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base, weekly, db = root/"base", root/"weekly", root/"local.sqlite"
            archives = base/"current/archives"
            archives.mkdir(parents=True)
            (weekly/"current").mkdir(parents=True)
            fields = {"snapshotDate": "2025-11-20", "resources": {}}
            for kind in catalogue.base_intake.EXPECTED:
                archive = archives / (kind + ".zip")
                with ZipFile(archive, "w") as output:
                    output.writestr("input.xml", '<modsCollection xmlns="http://www.loc.gov/mods/v3"><mods>'
                                    '<titleInfo><title>Évaluation publique</title></titleInfo>'
                                    '<name type="corporate"><namePart>Office A</namePart><role><roleTerm>auteur</roleTerm></role></name>'
                                    '<recordInfo><recordIdentifier source="CaOODSP">9.100</recordIdentifier></recordInfo>'
                                    '</mods></modsCollection>')
                fields["resources"][kind] = {"sha256": catalogue.sha_file(archive), "recordCount": 1, "format": "MODS XML",
                                             "finalUrl": "https://publications.gc.ca/source.zip"}
            (base/"current/receipt.json").write_text(json.dumps(fields))
            records = weekly/"current/records.jsonl"
            weekly_record = {"catalogueId": "9.100", "agencyCode": "CaOODSP", "title": "Évaluation publique",
                             "citations": {"fr": "https://publications.gc.ca/liste"},
                             "corporateNames": [{"tag": "110", "label": "Office A", "roles": ["issuing body"]}],
                             "issuingBodies": [{"label": "Office A", "sourceTag": "110", "roles": ["issuing body"]}],
                             "publishers": [{"name": "Publisher A", "sourceTag": "264", "function": "publication"}],
                             "publicationStatements": [{"tag": "264", "ind2": "1", "function": "publication",
                                                         "entities": ["Publisher A"], "dates": ["2026"]}],
                             "publicationLinks": [{"tag": "856", "urls": ["https://publications.gc.ca/example.pdf"],
                                                   "formats": ["PDF"], "labels": ["Full text"]}]}
            records.write_text(json.dumps(weekly_record) + "\n")
            (weekly/"current/receipt.json").write_text(json.dumps({"status": "complete", "range": {"latestIssue": "2026-26-01"},
                "baseSnapshotDate": fields["snapshotDate"], "recordsSha256": catalogue.sha_file(records), "aggregateRecordCount": 1}))
            first = catalogue.build(db, base, weekly)
            self.assertEqual(first["rows"], 4)
            self.assertTrue(catalogue.build(db, base, weekly)["reused"])
            rows = catalogue.lookup(db, None, "ÉVALUATION", 10)["items"]
            self.assertEqual(len(rows), 4)
            self.assertEqual(rows[0]["metadata"]["corporateNames"], [{"label": "Office A", "roles": ["auteur"]}])
            self.assertEqual(rows[-1]["source"], "weekly-checklists")
            self.assertEqual(rows[-1]["metadata"]["corporateNames"][0]["roles"], ["issuing body"])
            self.assertEqual(rows[-1]["metadata"]["publicationStatements"][0]["function"], "publication")
            self.assertEqual(rows[-1]["metadata"]["publicationLinks"][0]["formats"], ["PDF"])
            self.assertNotIn("CaOODSP", json.dumps(rows[-1]["metadata"]["publishers"]))
            records.write_text("broken")
            with self.assertRaisesRegex(ValueError, "differs from its receipt"):
                catalogue.build(db, base, weekly)
            self.assertEqual(catalogue.lookup(db, "9.100", None, 10)["items"], rows)
