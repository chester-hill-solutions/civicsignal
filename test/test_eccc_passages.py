import importlib.util
import gzip
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eccc-passages.py"
spec = importlib.util.spec_from_file_location("eccc_passages", SCRIPT)
eccc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = eccc
spec.loader.exec_module(eccc)


class EcccPassageTests(unittest.TestCase):
    def test_html_sections_and_table_cell_attribution(self):
        html = b"""<html><body><main><h2 id='findings'>Findings</h2>
        <p>Recommendation 1 is about water monitoring.</p>
        <table id='t1'><caption>Table 1: Progress</caption>
        <tr><th>Recommendation</th><th>Reported status</th><th>Assessment</th></tr>
        <tr><td>Appendix K guidance</td><td>Completed by the Centre of Expertise.</td>
        <td>In progress; guidance was withdrawn.</td></tr></table></main></body></html>"""
        rows = eccc.html_passages(html, "https://example.test/report.html")
        para = next(p for p in rows if p["text"].startswith("Recommendation 1"))
        self.assertEqual(para["section"], "Findings")
        self.assertEqual(para["citation_url"], "https://example.test/report.html#findings")
        cells = [p for p in rows if p["kind"] == "table-cell"]
        self.assertEqual([(p["row_number"], p["column_number"]) for p in cells], [(1, 1), (1, 2), (1, 3)])
        self.assertEqual(cells[1]["attribution"], "Reported status")
        self.assertEqual(cells[2]["attribution"], "Assessment")
        self.assertIsNone(para["attribution"])
        self.assertTrue(all(p["citation_url"].endswith("#t1") for p in cells))

    @patch.object(eccc.shutil, "which", return_value="pdftotext")
    @patch.object(eccc.subprocess, "run")
    def test_pdf_pages_get_page_citations(self, run, _which):
        run.return_value.returncode = 0
        run.return_value.stdout = "Page one contains enough searchable words.\fPage two contains another useful passage.\f".encode()
        run.return_value.stderr = b""
        rows = eccc.pdf_passages(b"%PDF-test", "https://example.test/report.pdf")
        self.assertEqual([p["page"] for p in rows], [1, 2])
        self.assertEqual(rows[1]["citation_url"], "https://example.test/report.pdf#page=2")
        self.assertTrue(all(p["kind"] == "pdf-page-text" for p in rows))

    def test_failed_refresh_keeps_previous_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            objects = root / "objects"
            catalogue = Path(tmp) / "catalogue.sqlite"
            output = Path(tmp) / "serving.sqlite"
            body = b"<html><body><main><h1>Local title</h1><p>Readable archived content.</p></main></body></html>"
            digest = hashlib.sha256(body).hexdigest()
            obj = objects / digest[:2] / (digest + ".gz")
            obj.parent.mkdir(parents=True)
            obj.write_bytes(gzip.compress(body))
            conn = sqlite3.connect(catalogue)
            conn.executescript((SCRIPT.parents[1] / "preview/departmental-publications/migrations/0001_dp.sql").read_text())
            conn.execute("INSERT INTO dp_inventory VALUES(1,'cutoff','observed','revision','{}')")
            conn.execute("INSERT INTO dp_documents(id,work_id,language,kind,label,url,sha256,content_sha256,media,bytes,status,first_observed_at,last_observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         ("doc", "work", "en", "report", "Report", "https://example.test/report.html", digest, digest, "text/html", len(body), "stored", "seen", "seen"))
            conn.commit(); conn.close()
            eccc.build(catalogue, output, root)
            before = hashlib.sha256(output.read_bytes()).hexdigest()
            conn = sqlite3.connect(catalogue)
            conn.execute("UPDATE dp_documents SET sha256=? WHERE id='doc'", ("0" * 64,))
            conn.commit(); conn.close()
            with self.assertRaises(FileNotFoundError):
                eccc.build(catalogue, output, root)
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), before)

    def test_only_verified_alternate_documents_enter_search_with_target_citations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            catalogue = Path(tmp) / "catalogue.sqlite"
            output = Path(tmp) / "serving.sqlite"
            body = (
                '<html lang="fr"><body><main><h1>Rapport traduit</h1>'
                "<p>Le contenu français du rapport reste citable.</p></main></body></html>"
            ).encode()
            digest = hashlib.sha256(body).hexdigest()
            obj = root / "objects" / digest[:2] / (digest + ".gz")
            obj.parent.mkdir(parents=True)
            obj.write_bytes(gzip.compress(body))
            conn = sqlite3.connect(catalogue)
            conn.executescript((SCRIPT.parents[1] / "preview/departmental-publications/migrations/0001_dp.sql").read_text())
            conn.executescript((SCRIPT.parents[1] / "preview/departmental-publications/migrations/0003_dp_alternate_documents.sql").read_text())
            conn.execute("INSERT INTO dp_inventory VALUES(1,'cutoff','observed','revision','{}')")
            columns = (
                "id,work_id,series,source_language,source_fiscal_year,language,kind,origin_label,origin_url,origin_sha256,"
                "hreflang,url,final_url,sha256,content_sha256,media,bytes,html_lang,title,heading,"
                "identity_method,status,observed_at"
            )
            values = (
                "alt-verified", "stable-work-id", "audit", "en", "2025 to 2026", "fr", "report", "Report",
                "https://www.canada.ca/en/report.html", "1" * 64, "fr",
                "https://www.canada.ca/fr/rapport.html", "https://www.canada.ca/fr/rapport.html",
                digest, digest, "text/html", len(body), "fr", "Rapport traduit - Canada.ca",
                "Rapport traduit", "reciprocal-hreflang-html-lang-title-h1", "verified", "observed",
            )
            conn.execute(f"INSERT INTO dp_alternate_documents({columns}) VALUES({','.join('?' for _ in values)})", values)
            pending = list(values)
            pending[0] = "alt-pending"
            pending[10] = "https://www.canada.ca/fr/rapport-pending.html"
            pending[11] = pending[10]
            pending[-2] = "pending"
            conn.execute(f"INSERT INTO dp_alternate_documents({columns}) VALUES({','.join('?' for _ in pending)})", pending)
            conn.commit()
            conn.close()

            result = eccc.build(catalogue, output, root)
            self.assertEqual(result["alternate_documents_seen"], 1)
            self.assertEqual(result["alternate_documents_extracted"], 1)
            serving = sqlite3.connect(output)
            try:
                rows = serving.execute(
                    "SELECT document_id,work_id,language,citation_url,text FROM dp_passages ORDER BY ordinal"
                ).fetchall()
                self.assertTrue(rows)
                self.assertEqual({row[0] for row in rows}, {"alt-verified"})
                self.assertEqual({row[1] for row in rows}, {"stable-work-id"})
                self.assertEqual({row[2] for row in rows}, {"fr"})
                self.assertTrue(all(row[3] == "https://www.canada.ca/fr/rapport.html" for row in rows))
                self.assertTrue(any("contenu français du rapport" in row[4] for row in rows))
                extracted = serving.execute(
                    "SELECT alternate_documents_extracted FROM dp_extraction_runs WHERE singleton=1"
                ).fetchone()[0]
                self.assertEqual(extracted, 1)
            finally:
                serving.close()


if __name__ == "__main__":
    unittest.main()
