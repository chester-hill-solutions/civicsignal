"""Verify Library PDF identity, transport, and degraded receipts."""
from email.message import Message
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch
from urllib.request import Request

from scripts.lib import library_summary_documents as documents


BASE = "https://lop.parl.ca"
EN = f"{BASE}/system/files/researchpublications/legislativesummaries/pdf/PV_45-1-C5-E_0.pdf"
EN_CANONICAL = f"{BASE}/sites/default/files/researchpublications/legislativesummaries/pdf/45-1/45-1-c5-e.pdf"
FR = f"{BASE}/sites/default/files/researchpublications/legislativesummaries/pdf/45-1/45-1-c5-f.pdf"
EN_DETAIL = f"{BASE}/en/researchpublications/legislativesummaries/451c5E"
FR_DETAIL = f"{BASE}/fr/publicationsderecherche/resumeslegislatifs/451c5F"
BODY = b"%PDF-1.7\nfixture"
EN_COVER = "BILL C-5: AN ACT\nPublication No. 45-1-C5-E\n18 June 2025\n"
FR_COVER = "PROJET DE LOI C‑5 : LOI\n45-1-C5-F\nLe 18 juin 2025\n"


def edition(language="en", url=EN):
    return {"billNumber": "C-5", "language": language, "revisionDate": "2025-06-18", "pdfUrl": url,
            "url": EN_DETAIL if language == "en" else FR_DETAIL}


def detail(url, pdf, dated="2025-06-18", field="publication"):
    return (f'<html><head><link rel="canonical" href="{url}"></head><main><a href="{pdf}">PDF</a>'
            f'<div class="name-field-{field}-date"><time datetime="{dated}T00:00:00Z">{dated}</time></div>'
            '</main></html>').encode()


class Response(BytesIO):
    status = 200

    def __init__(self, data, length, content_type="application/pdf"):
        super().__init__(data)
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(length)

    def geturl(self):
        return EN_CANONICAL


class LibrarySummaryDocumentTest(unittest.TestCase):
    def test_confirms_bilingual_cover_dates_and_labelled_or_bare_publication_numbers(self):
        self.assertEqual(documents.verify_cover(EN_COVER, edition()), {
            "publicationNumber": "45-1-C5-E", "documentDate": "2025-06-18",
        })
        self.assertEqual(documents.verify_cover(FR_COVER, edition("fr", FR)), {
            "publicationNumber": "45-1-C5-F", "documentDate": "2025-06-18",
        })

    def test_uses_cover_date_after_hyphenated_publication_number(self):
        cover = "PROJET DE LOI C-5 :\nLOI SUR LE BUDGET DU\nLE 4 NOVEMBRE 2025\n45-1-C-5-F\nLe 18 juin 2025\n"
        self.assertEqual(documents.verify_cover(cover, edition("fr", FR)), {
            "publicationNumber": "45-1-C-5-F", "documentDate": "2025-06-18",
        })

    def test_rejects_wrong_bill_session_language_and_date_even_at_a_valid_pdf_url(self):
        wrong_identity = (EN_COVER.replace("C-5", "C-50"), EN_COVER.replace("45-1", "44-1"), FR_COVER)
        for cover in wrong_identity:
            with self.subTest(cover=cover), self.assertRaises(documents.DocumentGap) as raised:
                documents.verify_cover(cover, edition())
            self.assertEqual(raised.exception.status, "identity-mismatch")
        row = edition()
        printed = documents.verify_cover(EN_COVER.replace("18 June", "19 June"), row)
        with self.assertRaises(documents.DocumentGap) as raised:
            documents.reconcile_dates(row, EN, printed, lambda _: self.fail("unexpected detail fetch"))
        self.assertEqual(raised.exception.status, "date-mismatch")
        self.assertEqual(raised.exception.evidence["documentDate"], "2025-06-19")

    def test_earlier_cover_date_requires_same_edition_detail_page_and_pdf_link(self):
        row = edition()
        printed = documents.verify_cover(EN_COVER.replace("18 June", "17 June"), row)
        original = detail(EN_DETAIL, EN_CANONICAL)
        evidence = documents.reconcile_dates(row, EN_CANONICAL, printed, {EN_DETAIL: original}.__getitem__)
        self.assertEqual(evidence["dateStatus"], "catalogue-detail-confirmed")
        self.assertEqual(evidence["detailPublicationDate"], "2025-06-18")
        self.assertEqual(evidence["documentDate"], "2025-06-17")
        self.assertEqual(evidence["dateSourceSha256"], sha256(original).hexdigest())
        for stale in (detail(EN_DETAIL, FR), detail(FR_DETAIL, EN), detail(EN_DETAIL, EN, "2025-06-16")):
            with self.subTest(body=stale), self.assertRaises(documents.DocumentGap) as raised:
                documents.reconcile_dates(row, EN_CANONICAL, printed, {EN_DETAIL: stale}.__getitem__)
            self.assertEqual(raised.exception.status, "date-mismatch")

    def test_redirects_only_to_the_same_https_library_bill_and_edition(self):
        redirect = documents.OfficialPDFRedirect()
        self.assertEqual(redirect.redirect_request(Request(EN), None, 302, "", {}, EN_CANONICAL).full_url, EN_CANONICAL)
        for target in (EN + "?other=1", EN.replace("https:", "http:"), EN.replace("lop.parl.ca", "example.net"), FR):
            with self.subTest(target=target), self.assertRaises(documents.DocumentGap):
                redirect.redirect_request(Request(EN), None, 302, "", {}, target)

    def test_fetch_validates_pdf_length_mime_and_signature(self):
        with patch.object(documents, "build_opener") as opener:
            opener.return_value.open.return_value = Response(BODY, len(BODY))
            result = documents.fetch_pdf(EN)
            self.assertEqual(result, BODY)
            self.assertEqual(result.resolved_url, EN_CANONICAL)
            for data, length, mime in ((BODY, len(BODY) + 1, "application/pdf"),
                                       (BODY, documents.MAX_PDF_BYTES + 1, "application/pdf"),
                                       (b"captcha", 7, "application/pdf"),
                                       (BODY, len(BODY), "text/html")):
                with self.subTest(data=data, length=length, mime=mime):
                    opener.return_value.open.return_value = Response(data, length, mime)
                    with self.assertRaises(documents.DocumentGap) as raised:
                        documents.fetch_pdf(EN)
                    self.assertEqual(raised.exception.status, "invalid-pdf")

    def test_partial_acquisition_preserves_retrieved_original_provenance(self):
        rows = [edition(), edition("fr", FR), edition("en", None)]
        coverage = {"unmatchedBills": [], "languageOnly": {"en": [], "fr": []}}
        inventory = {"records": rows, "coverage": coverage}

        def get(url):
            if url == FR:
                return documents.FetchedPDF(BODY + b"-French", FR)
            if url == FR_DETAIL:
                return detail(FR_DETAIL, FR, "2025-06-16")
            return documents.FetchedPDF(BODY, EN_CANONICAL)

        documents.acquire_documents(inventory, get, lambda body: FR_COVER.replace("18 juin", "17 juin") if body.endswith(b"French") else EN_COVER)
        self.assertEqual(inventory["documentAcquisition"], {"complete": False, "verifiedEditions": 1, "gapEditions": 2})
        self.assertEqual(rows[0]["document"]["sha256"], sha256(BODY).hexdigest())
        self.assertEqual(rows[0]["document"]["resolvedUrl"], EN_CANONICAL)
        self.assertEqual(rows[1]["document"]["status"], "date-mismatch")
        self.assertEqual(rows[1]["document"]["sha256"], sha256(BODY + b"-French").hexdigest())
        self.assertEqual(rows[2]["document"]["status"], "missing-pdf-link")


class ArchiveVerificationTest(unittest.TestCase):
    def test_rejects_an_existing_object_or_detail_page_from_the_wrong_url(self):
        runner = Path(__file__).resolve().parents[1] / "services/library-summaries/run.py"
        verify = runpy.run_path(str(runner))["verify_documents"]
        digest = sha256(BODY).hexdigest()
        row = edition()
        row["document"] = {"status": "verified", "url": EN, "sha256": digest, "bytes": len(BODY),
                           "dateStatus": "matched", "documentDate": row["revisionDate"]}
        source = {"url": EN, "sha256": digest, "bytes": len(BODY)}
        verify([row], [source])
        with self.assertRaisesRegex(ValueError, "original for its listed URL"):
            verify([row], [dict(source, url=FR)])

        row["document"].update(dateStatus="catalogue-detail-confirmed", documentDate="2025-06-17",
                               dateSourceUrl=EN_DETAIL, dateSourceSha256=digest, detailPublicationDate="2025-06-18")
        with self.assertRaisesRegex(ValueError, "archived detail page"):
            verify([row], [source, dict(source, url=FR_DETAIL)])
        verify([row], [source, dict(source, url=EN_DETAIL)])
