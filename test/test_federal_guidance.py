import sys
import unittest
import gzip
import hashlib
import html
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.federal_guidance import (IRCC_LANDING, parse_ircc, parse_ircc_json,
                                  parse_ircc_json_sources, parse_tbs, replay)


class FederalGuidanceTests(unittest.TestCase):
    def test_tbs_entries_preserve_id_label_language_and_page_status(self):
        body = b"""<html><body><h1>Inactive policy instruments</h1>
        <a href="doc-eng.aspx?id=12345">Example Directive</a></body></html>"""
        rows = parse_tbs(body, "https://www.tbs-sct.canada.ca/pol/arch-eng.aspx", "inactive", "en")
        self.assertEqual(rows, [{
            "policy_id": "12345", "label": "Example Directive", "status": "inactive",
            "language": "en", "source_index": "https://www.tbs-sct.canada.ca/pol/arch-eng.aspx",
            "citation_url": "https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=12345",
        }])

    def test_ircc_row_keeps_heading_cutoff_text_and_pdf_citations(self):
        body = """<html><body><h2>Overseas Processing (OP)</h2><table>
        <caption>Operational manuals</caption><tr>
        <td>OP 8</td><td><a href="/content/dam/ircc/op08-eng.pdf">Entrepreneur and Self-Employed (PDF, 488.13 KB)</a>
        <p>All applications in the self-employed persons class received on or before May 2, 2017, must be processed using OP 8.</p>
        <a href="/en/program-instructions.html">SE PDIs</a></td>
        </tr></table></body></html>""".encode()
        url = "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/index.html"
        rows = parse_ircc(body, url, "en")
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["kind"], "combined")
        self.assertIn("manual-or-guidance-pdf", row["kinds"])
        self.assertIn("program-guidance-or-other-index-entry", row["kinds"])
        self.assertEqual(row["section"], {"level": "h2", "text": "Overseas Processing (OP)"})
        self.assertIn("received on or before May 2, 2017", row["nearby_text"])
        self.assertEqual(row["citations"][0]["url"], "https://www.canada.ca/content/dam/ircc/op08-eng.pdf")
        self.assertIn("488.13 KB", row["citations"][0]["label"])

    def test_ircc_html_index_excludes_json_template_rows(self):
        body = b"""<html><body><h2>Program Delivery Instructions</h2><table>
        <tr><td><a href="#">[[PageTitle]]</a><span>[[Label]]</span></td></tr>
        </table></body></html>"""
        self.assertEqual(parse_ircc(body, IRCC_LANDING["en"], "en"), [])

    def test_archived_landing_links_identify_all_four_language_json_feeds(self):
        specs = {}
        for language in ("en", "fr"):
            suffix = language
            pdi_config = html.escape(json.dumps({"url": f"/content/dam/ircc/documents/json/pdi/pdi-{suffix}.json#/data"}), quote=True)
            pdu_config = html.escape(json.dumps({"url": f"/content/dam/ircc/documents/json/pdi/pdu-{suffix}.json#/pdu"}), quote=True)
            html_body = f"""<html><body><h2>Program Delivery Instructions</h2>
            <table id="pdi-table" data-wb-json="{pdi_config}"></table>
            <h2>Program Delivery Updates</h2><table id="pdu-table" data-wb-json="{pdu_config}"></table>
            </body></html>""".encode()
            specs[language] = parse_ircc_json_sources(html_body, IRCC_LANDING[language], language)
            self.assertEqual(set(specs[language]), {"pdi-table", "pdu-table"})
        self.assertEqual(specs["en"]["pdi-table"]["url"],
                         "https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdi-en.json")
        self.assertEqual(specs["fr"]["pdu-table"]["pointer"], "pdu")
        with self.assertRaisesRegex(ValueError, "lacks the official PDI and PDU"):
            parse_ircc_json_sources(b"<html></html>", IRCC_LANDING["en"], "en")

    def test_ircc_pdi_and_pdu_records_keep_real_citations_metadata_and_hashes(self):
        source_index_sha = "a" * 64
        pdi_url = "https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdi-en.json"
        pdi_doc = {"data": [
            {"PageTitle": "Translation of supporting documents", "Link": "/content/canadasite/en/immigration-refugees-citizenship/manuals/translation.html",
             "Label": "Standard requirements", "Keywords": "standard-requirements", "Date": "2026-05-01"},
            {"PageTitle": "[[PageTitle]]", "Link": "#", "Label": "[[Label]]", "Date": "[[date]]"},
        ]}
        pdi_bytes = json.dumps(pdi_doc).encode()
        pdi_sha = hashlib.sha256(pdi_bytes).hexdigest()
        pdi_rows, pdi_counts = parse_ircc_json(pdi_bytes, pdi_url, pdi_sha, IRCC_LANDING["en"],
                                               source_index_sha, "en", "pdi", "data")
        self.assertEqual(pdi_counts, {"rawRows": 2, "publishedRecords": 1, "excludedTemplateRows": 1})
        pdi = pdi_rows[0]
        self.assertEqual(pdi["kind"], "program-delivery-instruction")
        self.assertEqual(pdi["source_index"], IRCC_LANDING["en"])
        self.assertEqual(pdi["source_data_url"], pdi_url)
        self.assertEqual(pdi["source_data_sha256"], pdi_sha)
        self.assertEqual(pdi["citations"][0]["url"],
                         "https://www.canada.ca/content/canadasite/en/immigration-refugees-citizenship/manuals/translation.html")
        self.assertEqual(pdi["source_data_record"]["Keywords"], "standard-requirements")
        self.assertIn("2026-05-01", pdi["cells"])

        pdu_url = "https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdu-fr.json"
        pdu_doc = {"pdu": [
            {"category": "temporary-resident-program", "link": "/content/canadasite/en/immigration-refugees-citizenship/updates/entry.html",
             "title": "Mise à jour", "dataOrder": "2026-11-19", "date": "19 novembre 2026"},
            {"category": "[[cat]]", "link": "#", "title": "[[title]]", "date": "[[date]]"},
        ]}
        pdu_bytes = json.dumps(pdu_doc, ensure_ascii=False).encode()
        pdu_sha = hashlib.sha256(pdu_bytes).hexdigest()
        pdu_rows, pdu_counts = parse_ircc_json(pdu_bytes, pdu_url, pdu_sha, IRCC_LANDING["fr"],
                                               source_index_sha, "fr", "pdu", "pdu")
        self.assertEqual(pdu_counts["publishedRecords"], 1)
        self.assertEqual(pdu_rows[0]["kind"], "program-delivery-update")
        self.assertEqual(pdu_rows[0]["language"], "fr")
        self.assertEqual(pdu_rows[0]["citations"][0]["language"], "en")
        self.assertEqual(pdu_rows[0]["citations"][0]["label"], "Mise à jour")

    def test_replay_is_offline_deterministic_and_accepts_older_inventory_without_json_feeds(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            body = b"<html><body>legacy archived IRCC landing page</body></html>"
            sha = hashlib.sha256(body).hexdigest()
            object_path = root / "objects" / sha[:2] / (sha + ".gz")
            object_path.parent.mkdir(parents=True)
            with object_path.open("wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                    compressed.write(body)
            source = {"url": IRCC_LANDING["en"], "final_url": IRCC_LANDING["en"], "sha256": sha,
                      "bytes": len(body), "archive": str(object_path)}
            inventory = {"collection": "federal-guidance-indexes", "observed_at": "2026-01-01T00:00:00+00:00",
                         "sources": {"ircc-en": source}, "records": []}
            inventory_path = root / "inventories" / "legacy.json"
            inventory_path.parent.mkdir()
            inventory_bytes = (json.dumps(inventory, sort_keys=True, separators=(",", ":")) + "\n").encode()
            inventory_path.write_bytes(inventory_bytes)
            receipt = {"observed_at": inventory["observed_at"], "inventory": {
                "path": str(inventory_path), "sha256": hashlib.sha256(inventory_bytes).hexdigest(), "bytes": len(inventory_bytes)}}
            receipt_path = root / "dist" / "receipt.json"
            receipt_path.parent.mkdir()
            receipt_path.write_text(json.dumps(receipt))
            before = receipt_path.read_bytes()

            result = replay(root)

            self.assertEqual(result["records"], [])
            self.assertEqual(result["inventory"], receipt["inventory"])
            self.assertEqual(receipt_path.read_bytes(), before)

    def test_replay_rederives_all_four_archived_ircc_feeds(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = {}
            records = []

            def archive(key, url, body):
                digest = hashlib.sha256(body).hexdigest()
                object_path = root / "objects" / digest[:2] / (digest + ".gz")
                object_path.parent.mkdir(parents=True, exist_ok=True)
                with object_path.open("wb") as raw:
                    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                        compressed.write(body)
                sources[key] = {"url": url, "final_url": url, "sha256": digest,
                                "bytes": len(body), "archive": str(object_path)}
                return digest

            for language in ("en", "fr"):
                section = "immigration-refugees-citizenship" if language == "en" else "immigration-refugies-citoyennete"
                pdi_url = f"https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdi-{language}.json"
                pdu_url = f"https://www.canada.ca/content/dam/ircc/documents/json/pdi/pdu-{language}.json"
                landing = f"""<html><body><h2>Program Delivery Instructions</h2>
                <table id="pdi-table" data-wb-json="{html.escape(json.dumps({'url': pdi_url + '#/data'}), quote=True)}"></table>
                <h2>Program Delivery Updates</h2><table id="pdu-table" data-wb-json="{html.escape(json.dumps({'url': pdu_url + '#/pdu'}), quote=True)}"></table>
                </body></html>""".encode()
                landing_sha = archive(f"ircc-{language}", IRCC_LANDING[language], landing)
                sample_rows = {
                    "pdi": {"PageTitle": f"Sample {language}", "Link": f"/content/canadasite/{language}/{section}/guidance/sample.html",
                            "Label": "Sample", "Keywords": "sample", "Date": "2026-01-01"},
                    "pdu": {"category": "temporary-resident-program", "link": f"/content/canadasite/{language}/{section}/updates/sample.html",
                            "title": f"Update {language}", "dataOrder": "2026-01-01", "date": "2026-01-01"},
                }
                for dataset, pointer in (("pdi", "data"), ("pdu", "pdu")):
                    url = pdi_url if dataset == "pdi" else pdu_url
                    body = json.dumps({pointer: [sample_rows[dataset]]}, ensure_ascii=False).encode()
                    key = f"ircc-json-{dataset}-{language}"
                    digest = archive(key, url, body)
                    parsed, _ = parse_ircc_json(body, url, digest, IRCC_LANDING[language], landing_sha,
                                                language, dataset, pointer)
                    records.extend(parsed)

            inventory = {"collection": "federal-guidance-indexes", "observed_at": "2026-01-01T00:00:00+00:00",
                         "sources": sources, "records": records}
            inventory_path = root / "inventories" / "sample.json"
            inventory_path.parent.mkdir()
            inventory_bytes = (json.dumps(inventory, sort_keys=True, separators=(",", ":")) + "\n").encode()
            inventory_path.write_bytes(inventory_bytes)
            receipt = {"inventory": {"path": str(inventory_path), "sha256": hashlib.sha256(inventory_bytes).hexdigest(),
                                      "bytes": len(inventory_bytes)}}
            receipt_path = root / "dist" / "receipt.json"
            receipt_path.parent.mkdir()
            receipt_path.write_text(json.dumps(receipt))

            report = replay(root)

            self.assertEqual(len(report["records"]), 4)
            self.assertEqual({record["source_data_url"] for record in report["records"]},
                             {sources[key]["url"] for key in sources if key.startswith("ircc-json-")})


if __name__ == "__main__":
    unittest.main()
