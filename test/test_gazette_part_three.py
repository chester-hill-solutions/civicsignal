"""Exercise Part III volume discovery, chapter reconciliation and archive replay."""

from functools import partial
from hashlib import sha256
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "gazette-part-three.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("gazette_part_three", SCRIPT)
gazette = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gazette)

VOLUME = "/rp-pr/p3/2025/"
PDF_PATH = VOLUME + "g3-04801.pdf"
PDF_URL = gazette.GAZETTE + PDF_PATH
PDF = b"%PDF-1.7\nfixture\n%%EOF\n"
COVER = ("Vol. 48  Vol. 48  Part III  Partie III\n"
         "OTTAWA, Friday, April 10, 2026  OTTAWA, LE vendredi 10\ufeffavril 2026\n"
         "Statutes of Canada, 2025  Lois du Canada (2025)\nChapters 1 to 2  Chapitres 1 à 2\n")


def page(language, body):
    return f'<html lang="{language}"><head><title>Gazette</title></head><body><main>{body}</main></body></html>'.encode()


def volume_fixture(language, *, path=PDF_PATH):
    part = gazette.PART[language]
    titles = {"en": ("First Act", "Second Act"), "fr": ("Première loi", "Deuxième loi")}
    citations = {"en": "S.C. 2025, c.", "fr": "L.C. 2025, ch."}
    items = (f'<li><a href="https://{gazette.JUSTICE}{gazette.ANNUAL_PATH[language]}2025_{chapter}">'
             f'{title} ({citations[language]}{chapter})</a></li>'
             for chapter, title in enumerate(titles[language], start=1))
    return page(language, f'<h1>Gazette, {part}: Volume 48</h1><table><caption id="a01">{part}: Acts</caption>'
                '<tbody><tr><td data-order="2026-04-10">Published</td>'
                f'<td><ul>{"".join(items)}</ul></td><td><a href="{path}">PDF</a></td></tr></tbody></table>')


def fixture():
    urls = {PDF_URL: PDF}
    for language, code in gazette.LANGUAGES.items():
        part = gazette.PART[language]
        current = f"{VOLUME}index-{code}.html"
        previous = f"/rp-pr/p3/2024/index-{code}.html"
        urls[gazette.CATALOGUE[language]] = page(language, f'<details><summary><h2 id="a3">{part}</h2></summary>'
                                                 f'<a href="{previous}">2024: Gazette, {part}: Volume 47</a>'
                                                 f'<a href="{current}">2025: Gazette, {part}: Volume 48</a></details>')
        urls[gazette.GAZETTE + current] = volume_fixture(language)
    return urls


class GazettePartThreeTests(unittest.TestCase):
    def test_archives_one_pdf_and_keeps_publication_date_separate_from_statute_year(self):
        urls = fixture()
        with tempfile.TemporaryDirectory() as scratch:
            manifest = Path(scratch) / "latest.json"

            def extract(_):
                return COVER

            result = gazette.archive_inventory(manifest, None, partial(gazette.collect, extract=extract), urls.__getitem__)
            issue = result["issue"]
            self.assertEqual((issue["volume"], issue["number"], issue["nominalVolumeYear"], issue["publicationDate"]),
                             (48, 1, 2025, "2026-04-10"))
            self.assertEqual([(row["statuteYear"], row["chapter"]) for row in result["records"]], [(2025, 1), (2025, 2)])
            self.assertEqual(result["records"][0]["editions"]["fr"]["justiceUrl"],
                             "https://laws-lois.justice.gc.ca/fra/LoisAnnuelles/2025_1")
            self.assertEqual(len(result["sources"]), 5)
            self.assertEqual(issue["pdfSha256"], sha256(PDF).hexdigest())
            self.assertEqual(gazette.verify_archive(manifest, extract=extract), result)
            pdf_object = manifest.parent / "sources" / "objects" / issue["pdfSha256"][:2] / issue["pdfSha256"]
            pdf_object.write_bytes(PDF.replace(b"fixture", b"corrupt"))
            with self.assertRaisesRegex(ValueError, "source hash"):
                gazette.verify_archive(manifest, extract=extract)

    def test_rejects_mismatched_bilingual_issue_before_fetching_pdf(self):
        urls = fixture()
        fr = gazette.GAZETTE + VOLUME + "index-fra.html"
        urls[fr] = urls[fr].replace(b'2026-04-10', b'2026-04-11')
        with patch.object(gazette, "verify_cover") as cover:
            with self.assertRaisesRegex(ValueError, "issue dates"):
                gazette.collect(None, urls.__getitem__)
            cover.assert_not_called()

    def test_rejects_secondary_hosts_and_mismatched_justice_chapter_urls(self):
        urls = fixture()
        en = gazette.GAZETTE + VOLUME + "index-eng.html"
        urls[en] = volume_fixture("en", path=f"https://gazetteXgcXca{PDF_PATH}")
        with self.assertRaisesRegex(ValueError, "PDF link"):
            gazette.collect(None, urls.__getitem__)
        urls[en] = volume_fixture("en").replace(b"2025_2", b"2025_3")
        with self.assertRaisesRegex(ValueError, "Justice Laws chapter citation"):
            gazette.collect(None, urls.__getitem__)

    def test_rejects_truncation_wrong_cover_date_and_wrong_chapter_range(self):
        urls = fixture()
        urls[PDF_URL] = PDF.removesuffix(b"%%EOF\n")
        with self.assertRaisesRegex(ValueError, "truncated"):
            gazette.collect(None, urls.__getitem__, extract=lambda _: COVER)
        urls[PDF_URL] = PDF
        with self.assertRaisesRegex(ValueError, "publication date"):
            gazette.collect(None, urls.__getitem__, extract=lambda _: COVER.replace("April 10", "April 11"))
        with self.assertRaisesRegex(ValueError, "chapter citations disagree"):
            gazette.collect(None, urls.__getitem__, extract=lambda _: COVER.replace("à 2", "à 3"))


if __name__ == "__main__":
    unittest.main()
