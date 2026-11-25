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


if __name__ == "__main__":
    unittest.main()
