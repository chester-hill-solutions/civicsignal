"""Acquire and verify the Library of Parliament's listed 45-1 PDF editions."""
from datetime import date
from hashlib import sha256
from http.client import HTTPException
import re
import subprocess
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .html_tree import cls, tree


SESSION = "45-1"
LIBRARY_HOST = "lop.parl.ca"
CATALOGUE_PATHS = {
    "en": "/en/researchpublications/legislativesummaries",
    "fr": "/fr/publicationsderecherche/resumeslegislatifs",
}
DETAIL_PATHS = {
    language: re.compile(rf"{re.escape(path)}/451([CS])([1-9][0-9]*){'E' if language == 'en' else 'F'}", re.I)
    for language, path in CATALOGUE_PATHS.items()
}
PDF_PATH = re.compile(
    r"/(?:system/files|sites/default/files)/researchpublications/legislativesummaries/pdf/"
    r"(?:45-1/)?(?:PV_)?45-1-([CS])([1-9][0-9]*)-([EF])(?:_[0-9]+)?\.pdf", re.I
)
COVER_BILL = re.compile(r"\b(BILL|PROJET\s+DE\s+LOI)\s+([CS]-[1-9][0-9]*)\b", re.I)
PUBLICATION_NUMBER = re.compile(
    r"^(?:PUBLICATION\s+N(?:O\.?|[°º])\s*)?(([1-9][0-9]*-[1-9][0-9]*)-([CS])-?([1-9][0-9]*)-([EF]))$", re.I
)
PRINTED_SESSION = re.compile(
    r"\b(?:1st Session,?\s+(?:of the\s+)?45th Parliament|"
    r"45e législature,?\s+1(?:re|ère) session|1(?:re|ère) session,?\s+45e législature)\b", re.I
)
PRINTED_DATE = re.compile(r"^(?:le\s+)?([0-9]{1,2})(?:er)?\s+([^\W\d_]+)\s+([0-9]{4})$", re.I)
MONTHS = {
    "en": "january february march april may june july august september october november december".split(),
    "fr": "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split(),
}
DASHES = str.maketrans({character: "-" for character in "‐‑–—−"})
MAX_PDF_BYTES = 16 * 1024 * 1024


class DocumentGap(ValueError):
    def __init__(self, status, reason, **evidence):
        super().__init__(reason)
        self.status = status
        self.evidence = evidence


def official_url(parts):
    return parts.scheme == "https" and parts.netloc == LIBRARY_HOST and not parts.query and not parts.fragment


def summary_identity(url):
    parts = urlsplit(url)
    if official_url(parts):
        for language, pattern in DETAIL_PATHS.items():
            if match := pattern.fullmatch(parts.path):
                return f"{match[1].upper()}-{match[2]}", language
    return None


def pdf_identity(url):
    """Return the bill and language only for an official 45-1 document URL."""
    parts = urlsplit(url)
    match = PDF_PATH.fullmatch(parts.path)
    if not match or not official_url(parts):
        raise DocumentGap("identity-mismatch", f"Unverified Library document identity: {url}")
    chamber, number, edition = match.groups()
    return f"{chamber.upper()}-{number}", {"E": "en", "F": "fr"}[edition.upper()]


class OfficialPDFRedirect(HTTPRedirectHandler):
    max_redirections = 3
    max_repeats = 1

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if pdf_identity(req.full_url) != pdf_identity(newurl):
            raise DocumentGap("identity-mismatch", "Library redirect changed the bill or language")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class FetchedPDF(bytes):
    def __new__(cls, body, resolved_url):
        document = super().__new__(cls, body)
        document.resolved_url = resolved_url
        return document


def fetch_pdf(url):
    pdf_identity(url)
    request = Request(url, headers={"Accept": "application/pdf", "User-Agent": "CivicSignal Library of Parliament intake/1.0"})
    deadline = monotonic() + 45
    try:
        with build_opener(OfficialPDFRedirect()).open(request, timeout=15) as response:
            resolved = response.geturl()
            if pdf_identity(url) != pdf_identity(resolved):
                raise DocumentGap("identity-mismatch", "Resolved Library PDF changed the bill or language")
            if response.status != 200 or response.headers.get_content_type() != "application/pdf":
                raise DocumentGap("invalid-pdf", "Unexpected Library PDF response", httpStatus=response.status)
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isdecimal() or not 0 < int(length) <= MAX_PDF_BYTES):
                raise DocumentGap("invalid-pdf", "Library PDF has an invalid or oversized Content-Length")
            body = bytearray()
            while block := response.read1(64 * 1024):
                if monotonic() > deadline:
                    raise DocumentGap("download-failed", "Library PDF transfer exceeded 45 seconds")
                if len(body) + len(block) > MAX_PDF_BYTES:
                    raise DocumentGap("invalid-pdf", "Library PDF exceeded the 16 MiB byte limit")
                body.extend(block)
            if (length is not None and len(body) != int(length)) or not body.startswith(b"%PDF-"):
                raise DocumentGap("invalid-pdf", "Library response was truncated or did not begin with a PDF header")
            return FetchedPDF(body, resolved)
    except HTTPError as error:
        code = error.code
        error.close()
        raise DocumentGap("download-failed", f"Library PDF returned HTTP {code}", httpStatus=code) from error
    except (URLError, OSError, HTTPException) as error:
        raise DocumentGap("download-failed", f"Library PDF transfer failed: {error}") from error


def extract_cover(body):
    try:
        result = subprocess.run(
            ["pdftotext", "-f", "1", "-l", "1", "-layout", "-enc", "UTF-8", "-", "-"],
            input=body, capture_output=True, timeout=30, check=True,
        )
        return result.stdout.decode("utf-8").split("\f", 1)[0]
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise DocumentGap("extraction-failed", f"pdftotext could not read the Library cover: {error}") from error


def verify_cover(text, record):
    bill, language = record["billNumber"], record["language"]
    cover = text.translate(DASHES)
    lines = [" ".join(line.split()) for line in cover.splitlines()]
    expected_heading = "BILL" if language == "en" else "PROJET DE LOI"
    headings = {(" ".join(kind.upper().split()), number.upper()) for kind, number in COVER_BILL.findall(cover)}
    if headings != {(expected_heading, bill)}:
        raise DocumentGap("identity-mismatch", "Printed cover does not confirm the expected bill and language")

    numbers = [(index, match) for index, line in enumerate(lines) if (match := PUBLICATION_NUMBER.fullmatch(line))]
    expected_edition = "E" if language == "en" else "F"
    if any((match[2], f"{match[3].upper()}-{match[4]}", match[5].upper()) != (SESSION, bill, expected_edition)
           for _, match in numbers):
        raise DocumentGap("identity-mismatch", "Printed publication number conflicts with the bill, session or language")
    if not numbers and not PRINTED_SESSION.search(" ".join(lines)):
        raise DocumentGap("identity-mismatch", "Printed cover does not identify the parliamentary session")
    publication = numbers[0][1][1].upper() if numbers else None
    # A bill title can itself contain dates. The cover's document date follows the publication number.
    date_lines = lines[numbers[-1][0] + 1:] if numbers else lines

    dates = set()
    for line in date_lines:
        if not (match := PRINTED_DATE.fullmatch(line)):
            continue
        day, month, year = match.groups()
        try:
            dates.add(date(int(year), MONTHS[language].index(month.casefold()) + 1, int(day)).isoformat())
        except ValueError as error:
            raise DocumentGap("date-mismatch", "Printed Library cover date is invalid", publicationNumber=publication) from error
    if len(dates) != 1:
        raise DocumentGap("date-mismatch", "Printed Library cover lacks one unambiguous date", publicationNumber=publication)
    return {"publicationNumber": publication, "documentDate": next(iter(dates))}


def detail_date(main, field):
    timestamps = {
        node.attrs.get("datetime")
        for label in main.findall(lambda node: cls(node, field))
        for node in label.findall(lambda node: node.tag == "time")
    }
    if not timestamps:
        return None
    if None in timestamps or len(timestamps) != 1:
        raise ValueError(f"Ambiguous Library detail date field {field}")
    return date.fromisoformat(next(iter(timestamps)).split("T", 1)[0]).isoformat()


def reconcile_dates(record, resolved_url, cover, get):
    listed_date = record["revisionDate"]
    if listed_date == cover["documentDate"]:
        return {"dateStatus": "matched"}
    if not listed_date or cover["documentDate"] > listed_date:
        raise DocumentGap("date-mismatch", "Printed date cannot be reconciled to the catalogue date", **cover)
    url = record["url"]
    if summary_identity(url) != (record["billNumber"], record["language"]):
        raise DocumentGap("date-mismatch", "Library detail URL does not identify this edition", **cover)
    evidence = {**cover, "dateSourceUrl": url}
    try:
        original = get(url)
        evidence["dateSourceSha256"] = sha256(original).hexdigest()
        root = tree(original.decode("utf-8-sig"))
        main = root.find(lambda node: node.tag == "main")
        canonical = root.find(lambda node: node.tag == "link" and node.attrs.get("rel") == "canonical")
        if not main or not canonical or canonical.attrs.get("href") != url:
            raise ValueError("Library detail page lacks its canonical edition identity")
        links = {urljoin(url, node.attrs["href"])
                 for node in main.findall(lambda node: node.tag == "a" and node.attrs.get("href"))}
        publication_date = detail_date(main, "name-field-publication-date")
        revision_date = detail_date(main, "name-field-revised-date")
        evidence.update(detailPublicationDate=publication_date, detailRevisionDate=revision_date)
        if not links.intersection({record["pdfUrl"], resolved_url}):
            raise ValueError("Library detail page does not link the archived PDF")
        if (revision_date or publication_date) != listed_date:
            raise ValueError("Library detail publication or revision date does not confirm the catalogue date")
    except (URLError, TimeoutError, ValueError) as error:
        if isinstance(error, HTTPError):
            error.close()
        raise DocumentGap("date-mismatch", f"Library date discrepancy was not reconciled: {error}", **evidence) from error
    return {**evidence, "dateStatus": "catalogue-detail-confirmed"}


def acquire_document(record, get, extract=extract_cover):
    url = record["pdfUrl"]
    if url is None:
        return {"status": "missing-pdf-link", "url": None, "reason": "The catalogue has no PDF link for this edition"}
    result = {"url": url}
    try:
        if pdf_identity(url) != (record["billNumber"], record["language"]):
            raise DocumentGap("identity-mismatch", "The PDF link does not match the catalogue edition")
        body = get(url)
        resolved = body.resolved_url
        result.update(resolvedUrl=resolved, sha256=sha256(body).hexdigest(), bytes=len(body))
        if pdf_identity(resolved) != pdf_identity(url):
            raise DocumentGap("identity-mismatch", "The resolved PDF link does not match the catalogue edition")
        cover = verify_cover(extract(body), record)
        evidence = {**cover, **reconcile_dates(record, resolved, cover, get)}
    except DocumentGap as error:
        return dict(result, status=error.status, reason=str(error), **error.evidence)
    return dict(result, status="verified", **evidence)


def acquire_documents(inventory, get, extract=extract_cover):
    for row in inventory["records"]:
        row["document"] = acquire_document(row, get, extract)
    verified = sum(row["document"]["status"] == "verified" for row in inventory["records"])
    gaps = len(inventory["records"]) - verified
    coverage = inventory["coverage"]
    inventory["documentAcquisition"] = {
        "complete": bool(verified) and gaps == 0 and not coverage["unmatchedBills"]
        and not any(coverage["languageOnly"].values()),
        "verifiedEditions": verified,
        "gapEditions": gaps,
    }
