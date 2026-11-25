#!/usr/bin/env python3
"""Acquire, text-check, and replay explicitly linked departmental report PDFs."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import errno
import gzip
import hashlib
from html.parser import HTMLParser
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys_path = str(ROOT / "scripts")
import sys
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from lib import committee_files  # noqa: E402

DEFAULT_ROOT = ROOT / "data/corpus/departmental-report-documents"
EDITION_ROOT = ROOT / "data/corpus/departmental-report-editions"
FAMILIES = {"departmental-plans", "departmental-results"}
MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
MAX_TEXT_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MIN_FREE_BYTES = 1024 * 1024 * 1024
MAX_WORKERS = 4
MAX_REDIRECTS = 5
USER_AGENT = "CivicSignal local departmental report document index/1.0"
PDF_EXTENSIONS = {".pdf"}
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_HTML_TARGETS_PER_BATCH = 40
HTML_PARSER_VERSION = 2
PUBLISHER_PDF_RECOVERIES = {
    "https://epe.lac-bac.gc.ca/100/202/301/treasury_board/estimates_report_plans/canada_customs_revenue_agency/2002-03.pdf": {
        "family": "departmental-plans", "language": "en", "issueYear": "2002-2003",
        "resolvedUrl": "https://publications.gc.ca/collections/collection_2012/arc-cra/Rv1-6-2002-eng.pdf",
        "method": "cra-index-declared-equivalent-corporate-plan",
        "sourceStatus": "publisher-declared-equivalent",
        "previousFailureReportId": "8bf30bd7473588de5dd0efaa8cca91ad",
        "evidenceUrls": [
            "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
            "https://publications.gc.ca/site/eng/9.899585/publication.html",
        ],
        "validation": "CRA labels the 2002-2003 Estimates PDF as the same as its Summary of the Corporate Business Plan; the official English catalogue issue spans 2002-2003 to 2004-2005.",
    },
    "https://epe.lac-bac.gc.ca/100/202/301/treasury_board/estimates_report_plans/canada_customs_revenue_agency/2003-04.pdf": {
        "family": "departmental-plans", "language": "en", "issueYear": "2003-2004",
        "resolvedUrl": "https://publications.gc.ca/collections/collection_2015/arc-cra/Rv1-28-2003-eng.pdf",
        "method": "official-catalogue-english-rpp-issue",
        "sourceStatus": "publisher-matched-rpp",
        "previousFailureReportId": "8bf30bd7473588de5dd0efaa8cca91ad",
        "evidenceUrls": [
            "https://publications.gc.ca/site/eng/9.804902/publication.html",
            "https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/departmental-plan.html",
        ],
        "validation": "The official English RPP catalogue lists the 2003-2004 issue and the PDF itself identifies the Canada Customs and Revenue Agency, year, and Report on Plans and Priorities.",
    },
}
HTML_FAMILY_TERMS = {
    "departmental-plans": {
        "en": ("departmental plan", "plans and priorities"),
        "fr": ("plan ministériel", "plans ministériels", "plans et priorités"),
    },
    "departmental-results": {
        "en": ("departmental results report", "departmental performance report", "departmental results", "performance report"),
        "fr": ("rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "rapport ministériel de rendement", "rapport sur les résultats"),
    },
}

PLAN_TERMS = {
    "en": ("departmental plan", "plans and priorities", "report on plans and priorities", "reports on plans and priorities"),
    "fr": ("plan ministériel", "plans ministériels", "plans et priorités", "rapport sur les plans et priorités", "rapport sur les plans et les priorités"),
}
RESULT_TERMS = {
    "en": ("departmental results report", "departmental performance report", "results report", "performance report"),
    "fr": ("rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "rapport ministériel de rendement"),
}
LANGUAGE_MARKERS = {
    "en": ("departmental plan", "plans and priorities", "departmental results report", "departmental performance report", "table of contents"),
    "fr": ("plan ministériel", "plans ministériels", "rapport sur les plans et les priorités", "rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "table des matières"),
}
YEAR_RANGE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*(?:[-–—]|\bto\b|\bà\b)\s*((?:(?:19|20)\d{2})|\d{2})(?!\d)", re.I)
YEAR_TOKEN = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
HTML_OMIT = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "template"}
HTML_FAMILY_ALIASES = {
    "departmental-plans": {"en": ("departmental plan", "plans and priorities"),
                            "fr": ("plan ministériel", "plans et priorités")},
    "departmental-results": {"en": ("departmental results report", "departmental performance report"),
                              "fr": ("rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "rapport ministériel de rendement")},
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normalized(value: str) -> str:
    return " ".join((value or "").casefold().replace("’", "'").split())


class FetchError(RuntimeError):
    def __init__(self, detail: str, status: int | None = None):
        super().__init__(detail)
        self.status = status


class Budget:
    def __init__(self, maximum: int):
        self.maximum = maximum
        self.used = 0
        self.reserved = 0
        self.lock = threading.Lock()

    def reserve(self) -> bool:
        with self.lock:
            if self.used + self.reserved + MAX_DOCUMENT_BYTES > self.maximum:
                return False
            self.reserved += MAX_DOCUMENT_BYTES
            return True

    def settle(self, actual: int) -> None:
        with self.lock:
            self.reserved -= MAX_DOCUMENT_BYTES
            self.used += actual


class PublisherContinueParser(HTMLParser):
    """Read the publisher's literal continuation anchor and visible label."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.anchor = None
        self.rows = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs = dict(attrs)
            if attrs.get("href"):
                self.anchor = {"href": attrs["href"], "text": []}

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor is not None:
            self.rows.append((self.anchor["href"], " ".join("".join(self.anchor["text"]).split()).casefold()))
            self.anchor = None


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    return parsed.scheme.casefold(), (parsed.hostname or "").casefold(), parsed.port


def _transient_transport_failure(error: BaseException) -> bool:
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    return isinstance(reason, OSError) and getattr(reason, "errno", None) in {
        errno.ECONNRESET, errno.ECONNABORTED, errno.ETIMEDOUT, errno.EPIPE,
    }


def public_archive_continue(body: bytes, requested_url: str, notice_url: str) -> str | None:
    """Return the exact publisher link only for its same-origin archive notice."""
    parts = urlsplit(notice_url)
    if _origin(notice_url) != ("https", "publications.gc.ca", None) or parts.path != "/site/archivee-archived.html":
        return None
    try:
        query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return None
    if set(query) != {"url"} or query["url"] != [requested_url]:
        return None
    parser = PublisherContinueParser()
    try:
        parser.feed(body.decode("utf-8", "replace"))
    except (ValueError, AssertionError):
        return None
    for href, label in parser.rows:
        if label not in {"continue to publication", "continuer vers la publication"}:
            continue
        literal = urljoin(notice_url, href)
        if literal == requested_url and _origin(literal) == ("https", "publications.gc.ca", None):
            return literal
    return None


def fetch_pdf_with_evidence(url: str, *, referer: str | None = None, continued: bool = False,
                            _opener=None, _redirect_handler=None, _notice_evidence: dict | None = None):
    if not committee_files.fetchable(url):
        raise FetchError("direct PDF URL is outside official HTTPS acquisition policy")

    class CheckedRedirect(urllib.request.HTTPRedirectHandler):
        def __init__(self):
            super().__init__()
            self.count = 0
            self.required_origin = None

        def redirect_request(self, request, response, code, message, headers, new_url):
            self.count += 1
            target = urljoin(request.full_url, new_url)
            if (self.count > MAX_REDIRECTS or not committee_files.official(target) or
                    (self.required_origin is not None and _origin(target) != self.required_origin)):
                raise FetchError("redirect outside official HTTPS hosts or exceeds redirect limit", code)
            return super().redirect_request(request, response, code, message, headers, target)

    if _opener is None:
        cookie_jar = CookieJar()
        redirect_handler = CheckedRedirect()
        _opener = urllib.request.build_opener(redirect_handler, urllib.request.HTTPCookieProcessor(cookie_jar))
    else:
        redirect_handler = _redirect_handler

    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1"}
    if referer:
        headers["Referer"] = referer
    request = urllib.request.Request(url, headers=headers)
    try:
        with _opener.open(request, timeout=45) as response:
            final_url = response.geturl()
            if not committee_files.official(final_url):
                raise FetchError("final URL outside official HTTPS hosts")
            media = response.headers.get_content_type().casefold()
            limit = MAX_HTML_BYTES if media == "text/html" else MAX_DOCUMENT_BYTES
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > limit:
                raise FetchError("PDF exceeds per-document byte limit")
            chunks = bytearray()
            while True:
                block = response.read(min(128 * 1024, limit + 1 - len(chunks)))
                if not block:
                    break
                chunks.extend(block)
                if len(chunks) > limit:
                    raise FetchError("PDF exceeds per-document byte limit")
            body = bytes(chunks)
            if response.status != 200:
                raise FetchError("HTTP " + str(response.status), response.status)
            if not continued and media == "text/html":
                literal = public_archive_continue(body, url, final_url)
                if literal:
                    if redirect_handler is not None:
                        redirect_handler.required_origin = _origin(url)
                    evidence = {"noticeUrl": final_url, "targetUrl": literal,
                                "noticeSha256": hashlib.sha256(body).hexdigest(), "noticeBytes": len(body),
                                "continueHref": literal, "noticeBody": body}
                    return fetch_pdf_with_evidence(literal, referer=final_url, continued=True,
                                                   _opener=_opener, _redirect_handler=redirect_handler,
                                                   _notice_evidence=evidence)
            return (body, final_url, response.status, media, _notice_evidence)
    except urllib.error.HTTPError as error:
        raise FetchError("HTTP " + str(error.code), error.code) from error
    except ssl.SSLCertVerificationError as error:
        return fetch_pdf_curl(url, error, referer=referer, continued=continued,
                              notice_evidence=_notice_evidence)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            return fetch_pdf_curl(url, error.reason, referer=referer, continued=continued,
                                  notice_evidence=_notice_evidence)
        if _transient_transport_failure(error):
            return fetch_pdf_curl(url, error.reason, referer=referer, continued=continued,
                                  notice_evidence=_notice_evidence)
        raise FetchError(str(error.reason)[:1000]) from error
    except (TimeoutError, OSError) as error:
        if _transient_transport_failure(error):
            return fetch_pdf_curl(url, error, referer=referer, continued=continued,
                                  notice_evidence=_notice_evidence)
        raise FetchError(str(error)[:1000]) from error


def fetch_pdf(url: str, *, referer: str | None = None, continued: bool = False) -> tuple[bytes, str, int, str]:
    """Keep the original four-value public API for other local PDF consumers."""
    body, final_url, status, media_type, _evidence = fetch_pdf_with_evidence(
        url, referer=referer, continued=continued)
    return body, final_url, status, media_type


def fetch_pdf_curl(url: str, original_error: Exception, *, referer: str | None = None,
                   continued: bool = False, notice_evidence: dict | None = None):
    """Use curl's normal trust store only when urllib cannot validate the certificate."""
    current = url
    continuation_origin = _origin(url) if continued else None
    with tempfile.TemporaryDirectory(prefix="departmental-report-pdf-") as temp:
        target = Path(temp) / "source.pdf"
        cookies = Path(temp) / "cookies.txt"
        for _ in range(MAX_REDIRECTS + 1):
            if not committee_files.official(current):
                raise FetchError("redirect outside official HTTPS hosts") from original_error
            command = ["curl", "--silent", "--show-error", "--globoff", "--proto", "=https", "--max-redirs", "0",
                       "--max-time", "60", "--connect-timeout", "15", "--max-filesize", str(MAX_DOCUMENT_BYTES),
                       "--user-agent", USER_AGENT, "--header", "Accept: application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
                       "--cookie", str(cookies), "--cookie-jar", str(cookies),
                       *( ["--referer", referer] if referer else [] ),
                       "--output", str(target), "--write-out", "%{http_code}\n%{content_type}\n%{redirect_url}",
                       quote(current, safe=":/?#[]@!$&'()*+,;=%")]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode and result.returncode != 22:
                raise FetchError(result.stderr.strip()[:1000] or f"curl exit {result.returncode}") from original_error
            parts = result.stdout.split("\n", 2)
            if len(parts) != 3:
                raise FetchError("curl returned malformed response metadata") from original_error
            status, media, redirect = parts
            if status in {"301", "302", "303", "307", "308"} and redirect:
                next_url = urljoin(current, redirect)
                if continuation_origin is not None and _origin(next_url) != continuation_origin:
                    raise FetchError("continuation redirect changed publication origin", int(status)) from original_error
                current = next_url
                continue
            if status != "200":
                raise FetchError("HTTP " + status, int(status) if status.isdigit() else None) from original_error
            body = target.read_bytes()
            media_type = media.partition(";")[0].casefold()
            limit = MAX_HTML_BYTES if media_type == "text/html" else MAX_DOCUMENT_BYTES
            if len(body) > limit:
                raise FetchError("PDF exceeds per-document byte limit") from original_error
            if not continued and media_type == "text/html":
                literal = public_archive_continue(body, url, current)
                if literal:
                    evidence = {"noticeUrl": current, "targetUrl": literal,
                                "noticeSha256": hashlib.sha256(body).hexdigest(), "noticeBytes": len(body),
                                "continueHref": literal, "noticeBody": body}
                    return fetch_pdf_curl(literal, original_error, referer=current, continued=True,
                                          notice_evidence=evidence)
            return body, current, 200, media_type, notice_evidence
    raise FetchError("too many redirects") from original_error


def pdf_text(body: bytes) -> tuple[str, int]:
    if not body.startswith(b"%PDF-"):
        raise ValueError("response does not have a PDF signature")
    if not shutil.which("pdftotext"):
        raise RuntimeError("pdftotext is required to verify readable report PDFs")
    temp_root = ROOT / "tmp/pdfs"
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="departmental-report-text-", dir=temp_root) as temp:
        source, output = Path(temp) / "source.pdf", Path(temp) / "source.txt"
        source.write_bytes(body)
        try:
            with output.open("wb") as stream:
                result = subprocess.run(["pdftotext", "-f", "1", "-l", "10", "-layout", "-enc", "UTF-8", str(source), "-"],
                                        stdout=stream, stderr=subprocess.PIPE, timeout=90, check=False)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("pdftotext timed out") from error
        if result.returncode:
            raise RuntimeError("pdftotext failed: " + result.stderr.decode("utf-8", "replace")[:500])
        if output.stat().st_size > MAX_TEXT_BYTES:
            raise RuntimeError("extracted PDF text exceeds the per-document text limit")
        text = output.read_text(encoding="utf-8", errors="replace")
    pages = max(1, len(text.split("\f")) - (1 if text.endswith("\f") else 0))
    return text, pages


def source_year(label: str, year_label: str, url: str | None = None,
                *, use_pdf_filename_for_size_label: bool = False) -> str | None:
    if (use_pdf_filename_for_size_label and
            re.fullmatch(r"\s*(?:PDF\s*:\s*)?\d+\s*(?:KB|KO|MB|MO)\s*", label or "", re.I) and url):
        match = YEAR_RANGE.search(year_label or "")
        if not match:
            filename = unquote(Path(urlsplit(url).path).name)
            match = YEAR_RANGE.search(filename)
        if match:
            first, second = match.groups()
            return first + "-" + (second if len(second) == 4 else first[:2] + second)
        return None
    match = YEAR_RANGE.search(label or "")
    if match:
        first, second = match.groups()
        return first + "-" + (second if len(second) == 4 else first[:2] + second)
    years = YEAR_TOKEN.findall(label or "")
    if len(years) >= 2 and abs(int(years[1]) - int(years[0])) <= 1:
        return years[0] + "-" + years[1]
    if year_label:
        return year_label
    return None


def year_disposition(text: str, expected: str | None) -> str:
    if not expected:
        return "unresolved"
    compact = re.sub(r"\s+", "", text[:100_000]).replace("–", "-").replace("—", "-")
    if "-" in expected:
        start, end = expected.split("-", 1)
        short = end[-2:]
        if f"{start}-{end}" in compact or f"{start}-{short}" in compact:
            return "match"
        return "mismatch"
    return "match" if expected in compact else "mismatch"


def language_disposition(text: str, language: str, *, semantics_version: int = 3) -> str:
    sample = normalized(text[:300_000])
    markers_by_language = LANGUAGE_MARKERS
    if semantics_version < 3:
        markers_by_language = {lang: tuple(term for term in markers if
            normalized(term) != normalized("rapport sur les plans et les priorités"))
            for lang, markers in LANGUAGE_MARKERS.items()}
    scores = {lang: sum(sample.count(normalized(term)) for term in markers) for lang, markers in markers_by_language.items()}
    requested, other = scores[language], scores["fr" if language == "en" else "en"]
    if requested and other:
        return "multilingual"
    if requested:
        return "match"
    if other:
        return "mismatch"
    return "unresolved"


def family_disposition(text: str, family: str, language: str, *, semantics_version: int = 3) -> str:
    sample = normalized(text[:300_000])
    terms = PLAN_TERMS[language] if family == "departmental-plans" else RESULT_TERMS[language]
    if family == "departmental-plans" and language == "fr" and semantics_version >= 3:
        title_phrase = normalized("rapport sur les plans et les priorités")
        first_page = normalized(text.split("\f", 1)[0])
        if title_phrase in first_page:
            return "match"
        # Older French results reports explain what a report on plans and priorities is.
        # That incidental paragraph is not evidence that the PDF itself is a plan.
        terms = tuple(term for term in terms if normalized(term) != title_phrase)
    elif family == "departmental-plans" and language == "fr":
        terms = tuple(term for term in terms if normalized(term) != normalized("rapport sur les plans et les priorités"))
    return "match" if any(normalized(term) in sample for term in terms) else "unresolved"


def body_language_conflict(candidate: dict) -> bool:
    stem = urlsplit(candidate["url"]).path.rsplit("/", 1)[-1].casefold()
    stem = re.sub(r"[^a-z0-9]+", "-", stem)
    english_file = bool(re.search(r"(?:^|-)eng(?:-|\.)", stem))
    french_file = bool(re.search(r"(?:^|-)fra(?:-|\.)", stem))
    return (candidate["language"] == "en" and french_file and not english_file) or (candidate["language"] == "fr" and english_file and not french_file)


def collect_candidates(report: dict, *, apply_recoveries: bool = True,
                       use_pdf_filename_for_size_label: bool = False) -> list[dict]:
    candidates = []
    for page in report.get("issuerPages", []):
        family, language = page.get("family"), page.get("language")
        if family not in FAMILIES or language not in ("en", "fr"):
            continue
        for link in page.get("reportLinks", []):
            if link.get("link_type") != "direct-edition":
                continue
            url = link.get("url", "")
            if Path(urlsplit(url).path).suffix.casefold() not in PDF_EXTENSIONS:
                continue
            if any(ord(char) < 32 for char in url):
                continue
            if not committee_files.fetchable(url):
                continue
            issue_year = source_year(link.get("label", ""), link.get("year_label", ""), url,
                                     use_pdf_filename_for_size_label=use_pdf_filename_for_size_label)
            fetch_url = quote(url, safe=":/?#[]@!$&'()*+,;=%")
            recovery = PUBLISHER_PDF_RECOVERIES.get(url) if apply_recoveries else None
            recovery_receipt = None
            if recovery:
                if (recovery["family"] != family or recovery["language"] != language or
                        recovery["issueYear"] != issue_year or not committee_files.fetchable(recovery["resolvedUrl"]) or
                        any(not committee_files.official(item) for item in recovery["evidenceUrls"])):
                    raise ValueError("Publisher PDF recovery does not match its exact source citation")
                fetch_url = recovery["resolvedUrl"]
                recovery_receipt = {"originalUrl": url, **recovery}
            candidate = {"family": family, "language": language,
                "issuerLabel": page.get("issuer_label") or page.get("issuer_attribution") or "Unknown issuer",
                "issuerKey": page.get("issuer_key"), "landingUrl": page.get("published_url"),
                "landingSha256": link.get("landing_sha256"),
                "sourceIndexUrl": page.get("source_index_url"), "sourceIndexSha256": page.get("source_index_sha256"),
                "label": link.get("label", ""), "heading": link.get("heading"),
                "yearLabel": link.get("year_label"), "issueYear": issue_year,
                "url": url, "fetchUrl": fetch_url,
                "evidence": link.get("evidence"),
                "linkLanguageConflict": body_language_conflict({"url": url, "language": language})}
            if recovery_receipt:
                candidate["publisherRecovery"] = recovery_receipt
            candidates.append(candidate)
    return candidates


def validate_input(root: Path) -> tuple[bytes, dict, str]:
    pointer_path = root / "latest-attempt.json"
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    current_path = root / pointer["currentReportPath"]
    raw = current_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != pointer.get("currentReportSha256"):
        raise ValueError("Edition current report hash does not match latest-attempt pointer")
    report = json.loads(raw)
    if report.get("collection") != "departmental-report-editions-current":
        raise ValueError("Unsupported departmental editions current report")
    return raw, report, pointer["runId"]


def open_db(root: Path, read_only: bool = False):
    if not read_only:
        root.mkdir(parents=True, exist_ok=True)
    path = root / "documents.sqlite"
    if read_only:
        db = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=30)
        db.row_factory = sqlite3.Row
        return db
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS generations(
      run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL,
      source_report_run_id TEXT NOT NULL, source_report_path TEXT NOT NULL,
      source_report_sha256 TEXT NOT NULL, input_path TEXT NOT NULL, expected_citations INTEGER NOT NULL,
      unique_targets INTEGER NOT NULL, fetched_targets INTEGER NOT NULL DEFAULT 0,
      failed_targets INTEGER NOT NULL DEFAULT 0, readable_targets INTEGER NOT NULL DEFAULT 0,
      archived_bytes INTEGER NOT NULL DEFAULT 0, report_path TEXT, report_sha256 TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS documents(
      run_id TEXT NOT NULL, target_url TEXT NOT NULL, fetch_url TEXT NOT NULL, final_url TEXT,
      status TEXT NOT NULL, http_status INTEGER, media_type TEXT, body_sha256 TEXT, body_bytes INTEGER,
      object_path TEXT, text_sha256 TEXT, text_bytes INTEGER, text_object_path TEXT,
      text_pages INTEGER, readable_chars INTEGER, detail TEXT, publisher_notice_json TEXT,
      PRIMARY KEY(run_id,target_url), FOREIGN KEY(run_id) REFERENCES generations(run_id));
    CREATE TABLE IF NOT EXISTS citations(
      run_id TEXT NOT NULL, citation_id TEXT NOT NULL, target_url TEXT NOT NULL,
      family TEXT NOT NULL, language TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
      landing_url TEXT NOT NULL, landing_sha256 TEXT NOT NULL, source_index_url TEXT,
      source_index_sha256 TEXT, label TEXT NOT NULL, heading TEXT, year_label TEXT,
      issue_year TEXT, evidence TEXT, disposition TEXT NOT NULL,
      family_disposition TEXT, language_disposition TEXT, year_disposition TEXT,
      issuer_disposition TEXT, detail TEXT,
      PRIMARY KEY(run_id,citation_id), FOREIGN KEY(run_id,target_url) REFERENCES documents(run_id,target_url));
    CREATE TABLE IF NOT EXISTS html_runs(
      run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      source_report_run_id TEXT NOT NULL, source_report_path TEXT NOT NULL,
      source_report_sha256 TEXT NOT NULL, input_path TEXT NOT NULL,
      candidate_citations INTEGER NOT NULL, candidate_targets INTEGER NOT NULL,
      batch_limit INTEGER NOT NULL, processed_targets INTEGER NOT NULL DEFAULT 0,
      remaining_pending INTEGER NOT NULL DEFAULT 0, report_path TEXT, report_sha256 TEXT,
      status TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS html_targets(
      source_report_sha256 TEXT NOT NULL, target_url TEXT NOT NULL, status TEXT NOT NULL,
      last_run_id TEXT, attempted_at TEXT, fetch_url TEXT, final_url TEXT,
      http_status INTEGER, media_type TEXT, body_sha256 TEXT, body_bytes INTEGER,
      object_path TEXT, text_sha256 TEXT, text_bytes INTEGER, text_object_path TEXT,
      page_title TEXT, h1_json TEXT, html_language TEXT, readable_chars INTEGER,
      detail TEXT, PRIMARY KEY(source_report_sha256,target_url));
    CREATE TABLE IF NOT EXISTS html_citations(
      source_report_sha256 TEXT NOT NULL, citation_id TEXT NOT NULL, target_url TEXT NOT NULL,
      family TEXT NOT NULL, language TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
      landing_url TEXT NOT NULL, landing_sha256 TEXT, source_index_url TEXT,
      source_index_sha256 TEXT, label TEXT NOT NULL, heading TEXT, year_label TEXT NOT NULL,
      evidence TEXT, status TEXT NOT NULL DEFAULT 'pending',
      family_disposition TEXT, year_disposition TEXT, language_disposition TEXT,
      issuer_disposition TEXT, detail TEXT,
      PRIMARY KEY(source_report_sha256,citation_id));
    CREATE TABLE IF NOT EXISTS html_run_targets(
      run_id TEXT NOT NULL, target_url TEXT NOT NULL, status TEXT NOT NULL,
      body_sha256 TEXT, body_bytes INTEGER, object_path TEXT, text_sha256 TEXT,
      text_bytes INTEGER, text_object_path TEXT, page_title TEXT, h1_json TEXT,
      html_language TEXT, readable_chars INTEGER, http_status INTEGER, media_type TEXT,
      final_url TEXT, detail TEXT,
      PRIMARY KEY(run_id,target_url), FOREIGN KEY(run_id) REFERENCES html_runs(run_id));
    CREATE TABLE IF NOT EXISTS html_run_citations(
      run_id TEXT NOT NULL, citation_id TEXT NOT NULL, target_url TEXT NOT NULL,
      family TEXT NOT NULL, language TEXT NOT NULL, issuer_label TEXT NOT NULL,
      landing_url TEXT NOT NULL, landing_sha256 TEXT, source_index_url TEXT,
      source_index_sha256 TEXT, label TEXT NOT NULL, heading TEXT, year_label TEXT NOT NULL,
      evidence TEXT, status TEXT NOT NULL, family_disposition TEXT, year_disposition TEXT,
      language_disposition TEXT, issuer_disposition TEXT, detail TEXT,
      PRIMARY KEY(run_id,citation_id), FOREIGN KEY(run_id) REFERENCES html_runs(run_id));
    """)
    document_columns = {row[1] for row in db.execute("PRAGMA table_info(documents)")}
    if "publisher_notice_json" not in document_columns:
        db.execute("ALTER TABLE documents ADD COLUMN publisher_notice_json TEXT")
    return db


def store_gzip(root: Path, digest: str, content: bytes, area: str) -> str:
    path = root / area / digest[:2] / (digest + ".gz")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd, tmp = tempfile.mkstemp(prefix=".doc-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=1, mtime=0) as out:
                    out.write(content)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return str(path.relative_to(root))


def read_gzip(root: Path, rel: str, digest: str, length: int, maximum: int) -> bytes:
    path = (root / rel).resolve()
    if root.resolve() not in path.parents:
        raise ValueError("Archived document path escapes corpus root")
    with gzip.open(path, "rb") as source:
        data = source.read(maximum + 1)
    if len(data) > maximum or len(data) != length or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Archived document checksum or length mismatch")
    return data


def cite_id(row: dict) -> str:
    identity = "\0".join(str(row.get(k) or "") for k in ("family", "language", "issuerLabel", "landingUrl", "url", "label"))
    return hashlib.sha256(identity.encode()).hexdigest()[:32]


def assess(text: str, candidate: dict, *, semantics_version: int = 3) -> dict:
    lang = language_disposition(text, candidate["language"], semantics_version=semantics_version)
    if candidate.get("linkLanguageConflict"):
        lang = "source-link-conflict"
    fam = family_disposition(text, candidate["family"], candidate["language"], semantics_version=semantics_version)
    year = year_disposition(text, candidate.get("issueYear"))
    issuer_norm = normalized(candidate["issuerLabel"])
    issuer_found = bool(issuer_norm and issuer_norm in normalized(text[:300_000]))
    issuer = "named-in-text" if issuer_found else "source-page-attribution-only"
    checks = [lang in {"match", "multilingual"}, fam == "match", year == "match"]
    disposition = "verified" if all(checks) else "review"
    return {"disposition": disposition, "familyDisposition": fam, "languageDisposition": lang,
            "yearDisposition": year, "issuerDisposition": issuer}


def _fetch_one(url: str, budget: Budget, fetcher=fetch_pdf_with_evidence) -> dict:
    if not budget.reserve():
        return {"status": "budget-skipped", "detail": "aggregate document archive budget exhausted"}
    try:
        fetched = fetcher(url)
        if len(fetched) == 5:
            body, final, status, media, publisher_notice = fetched
        else:
            body, final, status, media = fetched
            publisher_notice = None
        if publisher_notice:
            notice_body = publisher_notice.get("noticeBody")
            if (not isinstance(notice_body, bytes) or len(notice_body) != publisher_notice.get("noticeBytes") or
                    hashlib.sha256(notice_body).hexdigest() != publisher_notice.get("noticeSha256")):
                raise FetchError("Publisher continuation notice failed its byte/checksum validation")
        digest = hashlib.sha256(body).hexdigest()
        budget.settle(len(body))
        return {"status": "fetched", "body": body, "bodySha256": digest,
                "bodyBytes": len(body), "finalUrl": final, "httpStatus": status, "mediaType": media,
                "publisherNotice": publisher_notice}
    except FetchError as error:
        budget.settle(0)
        return {"status": "failed", "detail": str(error)[:1000], "httpStatus": error.status}
    except Exception as error:
        budget.settle(0)
        return {"status": "failed", "detail": (str(error) or type(error).__name__)[:1000]}


def _pdf_process(root: Path, run_id: str, url: str, fetched: dict, candidates: list[dict]):
    body = fetched["body"]
    body_path = store_gzip(root, fetched["bodySha256"], body, "objects")
    status, detail, text_digest, text_bytes, text_path, pages, chars = "unreadable", None, None, 0, None, 0, 0
    citations = []
    if not body.startswith(b"%PDF-"):
        status, detail = "wrong-kind", "Direct edition URL did not return a PDF body"
    else:
        try:
            text, pages = pdf_text(body)
            normalized_text = text.strip()
            chars = len(normalized_text)
            if not normalized_text:
                raise ValueError("PDF contains no extractable text")
            text_bytes_data = text.encode("utf-8")
            text_digest = hashlib.sha256(text_bytes_data).hexdigest()
            text_bytes = len(text_bytes_data)
            text_path = store_gzip(root, text_digest, text_bytes_data, "text-objects")
            for candidate in candidates:
                citations.append({**candidate, **assess(text, candidate)})
            verified = any(c["disposition"] == "verified" for c in citations)
            status = "readable" if verified else "review"
            if not verified:
                detail = "Readable PDF, but source issue/year/language checks require review"
        except (OSError, RuntimeError, ValueError) as error:
            detail = (str(error) or type(error).__name__)[:1000]
    publisher_notice = fetched.get("publisherNotice")
    if publisher_notice:
        notice_body = publisher_notice["noticeBody"]
        notice_path = store_gzip(root, publisher_notice["noticeSha256"], notice_body, "archive-notices")
        publisher_notice = {k: v for k, v in publisher_notice.items() if k != "noticeBody"}
        publisher_notice["archivePath"] = notice_path
    return {"status": status, "detail": detail, "bodyPath": body_path, "textSha256": text_digest,
            "textBytes": text_bytes, "textPath": text_path, "textPages": pages,
            "readableChars": chars, "citations": citations, "publisherNotice": publisher_notice}


def load_report_input(root: Path, report_run_id: str, raw: bytes, report: dict) -> str:
    digest = hashlib.sha256(raw).hexdigest()
    path = root / "inputs" / (digest + ".json")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(raw)
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError("Archived source current report checksum failed")
    return str(path.relative_to(root))


def _candidate_report(candidates: list[dict]) -> dict:
    by_url = {}
    for row in candidates:
        by_url.setdefault(row["url"], []).append(row)
    return by_url


def collect_html_candidates(report: dict) -> list[dict]:
    """Discover only year- and family-labelled non-PDF links from the captured issuer pages."""
    candidates = []
    for page in report.get("issuerPages", []):
        family, language = page.get("family"), page.get("language")
        if family not in HTML_FAMILY_TERMS or language not in ("en", "fr"):
            continue
        for link in page.get("reportLinks", []):
            if link.get("link_type") != "index-link":
                continue
            label = link.get("label") or ""
            url = link.get("url") or ""
            if not YEAR_TOKEN.search(label) or not any(normalized(term) in normalized(label)
                    for term in HTML_FAMILY_TERMS[family][language]):
                continue
            path = urlsplit(url).path
            suffix = Path(path.rsplit("/", 1)[-1]).suffix.casefold()
            if suffix and suffix not in {".html", ".htm"}:
                continue
            if any(ord(ch) < 32 for ch in url):
                continue
            fetch_url = quote(url, safe=":/?#[]@!$&'()*+,;=%")
            candidates.append({"family": family, "language": language,
                "issuerLabel": page.get("issuer_label") or page.get("issuer_attribution") or "Unknown issuer",
                "issuerKey": page.get("issuer_key"), "landingUrl": page.get("published_url"),
                "landingSha256": link.get("landing_sha256"),
                "sourceIndexUrl": page.get("source_index_url"), "sourceIndexSha256": page.get("source_index_sha256"),
                "label": label, "heading": link.get("heading"), "yearLabel": link.get("year_label"),
                "issueYear": source_year(label, link.get("year_label", "")),
                "url": url, "fetchUrl": fetch_url, "evidence": link.get("evidence"),
                "policyDisposition": "allowed" if committee_files.fetchable(url) else "out-of-policy"})
    return candidates


class LegacyHtmlReportParser(HTMLParser):
    HIDDEN = HTML_OMIT

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.h1_parts: list[str] = []
        self.h1s: list[str] = []
        self.body_parts: list[str] = []
        self.main_parts: list[str] = []
        self.html_language = ""
        self.title_depth = 0
        self.h1_depth = 0
        self.main_depth = 0
        self.hidden_depth = 0

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "html":
            self.html_language = attr.get("lang", "").strip().casefold()
        if tag in self.HIDDEN:
            self.hidden_depth += 1
            return
        if self.hidden_depth:
            return
        if tag == "title": self.title_depth += 1
        if tag == "h1":
            self.h1_depth += 1
            if self.h1_depth == 1:
                self.h1_parts = []
        if tag == "main": self.main_depth += 1

    def handle_endtag(self, tag):
        if tag in self.HIDDEN and self.hidden_depth:
            self.hidden_depth -= 1
            return
        if self.hidden_depth:
            return
        if tag == "title" and self.title_depth: self.title_depth -= 1
        if tag == "h1" and self.h1_depth:
            self.h1_depth -= 1
            if not self.h1_depth:
                value = " ".join("".join(self.h1_parts).split())
                if value: self.h1s.append(value)
        if tag == "main" and self.main_depth: self.main_depth -= 1

    def handle_data(self, data):
        if self.hidden_depth or not data.strip():
            return
        clean = " ".join(data.split())
        self.body_parts.append(clean)
        if self.main_depth:
            self.main_parts.append(clean)
        if self.title_depth: self.title_parts.append(clean)
        if self.h1_depth: self.h1_parts.append(clean)

    def result(self):
        return {"title": " ".join(self.title_parts).strip(), "h1s": self.h1s,
                "htmlLanguage": self.html_language,
                "text": " ".join(self.main_parts or self.body_parts).strip()}


class HtmlReportParser(LegacyHtmlReportParser):
    """Read visible HTML while recovering after a malformed unclosed SVG block."""

    SVG_BREAKOUT = {
        "address", "article", "aside", "b", "big", "blockquote", "body", "br",
        "center", "code", "dd", "details", "div", "dl", "dt", "em", "embed", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "head",
        "hr", "i", "img", "li", "listing", "main", "menu", "meta", "nav", "nobr", "ol",
        "p", "pre", "ruby", "s", "section", "small", "span", "strong", "strike", "sub", "summary",
        "sup", "table", "tt", "u", "ul", "var", "font",
    }

    def __init__(self):
        super().__init__()
        self.hidden_elements: list[str] = []
        self.foreign_object_depth = 0

    def _sync_hidden_depth(self):
        self.hidden_depth = len(self.hidden_elements)

    def _inside_svg(self):
        return "svg" in self.hidden_elements

    def _exit_malformed_svg(self):
        svg_index = next((i for i, name in enumerate(self.hidden_elements) if name == "svg"), None)
        if svg_index is None:
            return
        del self.hidden_elements[svg_index:]
        self.foreign_object_depth = 0
        self._sync_hidden_depth()

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        if self._inside_svg() and not self.foreign_object_depth and tag in self.SVG_BREAKOUT:
            self._exit_malformed_svg()
        if tag == "foreignobject" and self._inside_svg():
            self.foreign_object_depth += 1
            return
        if tag in self.HIDDEN:
            self.hidden_elements.append(tag)
            self._sync_hidden_depth()
            return
        if self.hidden_depth:
            return
        super().handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if tag == "foreignobject" and self.foreign_object_depth:
            self.foreign_object_depth -= 1
            if self.hidden_depth:
                return
        if self._inside_svg() and not self.foreign_object_depth and tag in self.SVG_BREAKOUT:
            self._exit_malformed_svg()
        if tag in self.HIDDEN:
            index = next((i for i in range(len(self.hidden_elements) - 1, -1, -1)
                          if self.hidden_elements[i] == tag), None)
            if index is not None:
                del self.hidden_elements[index:]
                self._sync_hidden_depth()
            return
        if self.hidden_depth:
            return
        super().handle_endtag(tag)


def _analyze_html(body: bytes, candidates: list[dict], parser_type) -> dict:
    parser = parser_type()
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    parser.close()
    page = parser.result()
    results = []
    title_heading = normalized(" ".join([page["title"], *page["h1s"]]))
    text = normalized(page["text"])
    for candidate in candidates:
        lang_attr = page["htmlLanguage"].split("-", 1)[0]
        lang = "match" if lang_attr == candidate["language"] else ("mismatch" if lang_attr in {"en", "fr"} else "unresolved")
        terms = HTML_FAMILY_ALIASES[candidate["family"]][candidate["language"]]
        family = "match" if any(normalized(term) in title_heading for term in terms) else "mismatch"
        year_forms = [candidate["issueYear"] or candidate["yearLabel"] or ""]
        if year_forms[0] and "-" in year_forms[0]:
            first, last = year_forms[0].split("-", 1)
            year_forms.extend([first + " to " + last, first + " à " + last,
                               first + "-" + last[-2:], first + "–" + last])
        year = "match" if any(normalized(form) in title_heading for form in year_forms if form) else "mismatch"
        issuer_label = normalized(candidate["issuerLabel"])
        issuer = "named-in-text" if issuer_label in text else "mismatch"
        if len(page["text"]) < 100:
            disposition = "unreadable"
        elif candidate["policyDisposition"] != "allowed":
            disposition = "out-of-policy"
        elif lang == "mismatch":
            disposition = "wrong-language"
        elif family == "match" and year == "match" and lang == "match" and issuer == "named-in-text":
            disposition = "accepted"
        else:
            disposition = "not-report"
        results.append({**candidate, "disposition": disposition,
                        "familyDisposition": family, "yearDisposition": year,
                        "languageDisposition": lang, "issuerDisposition": issuer})
    return {**page, "citations": results}


def analyze_html(body: bytes, candidates: list[dict]) -> dict:
    return _analyze_html(body, candidates, HtmlReportParser)


def analyze_html_legacy(body: bytes, candidates: list[dict]) -> dict:
    """Reproduce pre-v2 archived HTML assessments for immutable old receipts."""
    return _analyze_html(body, candidates, LegacyHtmlReportParser)


class HtmlFetchError(FetchError):
    pass


def fetch_html(url: str) -> tuple[bytes, str, int, str]:
    """Fetch one small official HTML landing document with strict redirects and byte bounds."""
    if not committee_files.fetchable(url):
        raise HtmlFetchError("HTML URL outside official HTTPS acquisition policy")

    class CheckedRedirect(urllib.request.HTTPRedirectHandler):
        def __init__(self):
            super().__init__()
            self.count = 0

        def redirect_request(self, request, response, code, message, headers, new_url):
            self.count += 1
            target = urljoin(request.full_url, new_url)
            if self.count > MAX_REDIRECTS or not committee_files.official(target):
                raise HtmlFetchError("redirect outside official HTTPS hosts or exceeds redirect limit", code)
            return super().redirect_request(request, response, code, message, headers, target)

    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9"})
    try:
        with urllib.request.build_opener(CheckedRedirect()).open(request, timeout=30) as response:
            final = response.geturl()
            if not committee_files.official(final):
                raise HtmlFetchError("final URL outside official HTTPS hosts")
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_HTML_BYTES:
                raise HtmlFetchError("HTML exceeds per-page byte limit")
            body = response.read(MAX_HTML_BYTES + 1)
            if len(body) > MAX_HTML_BYTES:
                raise HtmlFetchError("HTML exceeds per-page byte limit")
            return body, final, response.status, response.headers.get_content_type().casefold()
    except urllib.error.HTTPError as error:
        raise HtmlFetchError("HTTP " + str(error.code), error.code) from error
    except ssl.SSLCertVerificationError as error:
        return fetch_html_curl(url,error)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            return fetch_html_curl(url,error.reason)
        raise HtmlFetchError(str(error.reason)[:1000]) from error
    except (TimeoutError, OSError) as error:
        raise HtmlFetchError(str(error)[:1000]) from error


def fetch_html_curl(url: str, original_error: Exception) -> tuple[bytes, str, int, str]:
    """Fallback to curl's normal platform trust only for urllib certificate-validation failures."""
    current=url
    with tempfile.TemporaryDirectory(prefix="departmental-report-html-") as temp:
        target=Path(temp)/"source.html"
        for _ in range(MAX_REDIRECTS+1):
            if not committee_files.official(current):
                raise HtmlFetchError("redirect outside official HTTPS hosts") from original_error
            command=["curl","--silent","--show-error","--globoff","--proto","=https","--max-redirs","0",
                     "--max-time","30","--connect-timeout","10","--max-filesize",str(MAX_HTML_BYTES),
                     "--user-agent",USER_AGENT,"--header","Accept: text/html,application/xhtml+xml;q=0.9",
                     "--output",str(target),"--write-out","%{http_code}\n%{content_type}\n%{redirect_url}",
                     quote(current,safe=":/?#[]@!$&'()*+,;=%")]
            result=subprocess.run(command,capture_output=True,text=True)
            if result.returncode and result.returncode!=22:
                raise HtmlFetchError(result.stderr.strip()[:1000] or f"curl exit {result.returncode}") from original_error
            parts=result.stdout.split("\n",2)
            if len(parts)!=3:
                raise HtmlFetchError("curl returned malformed response metadata") from original_error
            status,media,redirect=parts
            if status in {"301","302","303","307","308"} and redirect:
                current=urljoin(current,redirect)
                continue
            if not status.isdigit() or int(status)!=200:
                raise HtmlFetchError("HTTP "+status,int(status) if status.isdigit() else None) from original_error
            body=target.read_bytes()
            if len(body)>MAX_HTML_BYTES:
                raise HtmlFetchError("HTML exceeds per-page byte limit") from original_error
            return body,current,200,media.partition(";")[0].casefold()
    raise HtmlFetchError("too many redirects") from original_error


def html_target_status(error: Exception | None, media: str = "", parsed: dict | None = None) -> tuple[str, str]:
    if error:
        code = error.status if isinstance(error, FetchError) else None
        if code in (401, 403, 429): return "source-refused", str(error)[:1000]
        if code == 404: return "not-found", str(error)[:1000]
        return "fetch-failed", str(error)[:1000]
    if media not in {"text/html", "application/xhtml+xml"}:
        return "wrong-kind", "Response media type is not HTML"
    if not parsed or len(parsed["text"]) < 100:
        return "unreadable", "HTML response has insufficient visible text"
    return "fetched", ""


def html_refresh(root: Path = DEFAULT_ROOT, edition_root: Path = EDITION_ROOT,
                 batch_size: int = 24, priority_urls: list[str] | None = None,
                 fetcher=fetch_html, retry_urls: list[str] | None = None,
                 recheck_after_days: int = 7) -> dict:
    if not 1 <= batch_size <= MAX_HTML_TARGETS_PER_BATCH:
        raise ValueError(f"HTML batch-size must be between 1 and {MAX_HTML_TARGETS_PER_BATCH}")
    if not 1 <= recheck_after_days <= 365:
        raise ValueError("recheck-after-days must be between 1 and 365")
    raw, source, source_run_id = validate_input(edition_root)
    source_pointer = json.loads((edition_root / "latest-attempt.json").read_text(encoding="utf-8"))
    candidates = collect_html_candidates(source)
    source_sha = hashlib.sha256(raw).hexdigest()
    source_path = root / "inputs" / (source_sha + ".json")
    source_path.parent.mkdir(parents=True, exist_ok=True)
    if not source_path.exists(): source_path.write_bytes(raw)
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != source_sha:
        raise ValueError("Archived HTML source inventory checksum failed")
    by_url = _candidate_report(candidates)
    root.mkdir(parents=True, exist_ok=True)
    db = open_db(root)
    now, run_id = utc_now(), hashlib.sha256(os.urandom(32)).hexdigest()[:32]
    try:
        with db:
            for url, rows in by_url.items():
                inserted = db.execute("INSERT OR IGNORE INTO html_targets(source_report_sha256,target_url,status) VALUES(?,?, 'pending')", (source_sha, url)).rowcount
                prior_target = None
                prior_html = {}
                if inserted:
                    prior_target = db.execute("SELECT * FROM html_targets WHERE target_url=? AND source_report_sha256<>? AND status<>'pending' AND attempted_at IS NOT NULL ORDER BY attempted_at DESC LIMIT 1", (url,source_sha)).fetchone()
                    if prior_target:
                        db.execute("""UPDATE html_targets SET status=?,last_run_id=?,attempted_at=?,fetch_url=?,final_url=?,http_status=?,media_type=?,body_sha256=?,body_bytes=?,object_path=?,text_sha256=?,text_bytes=?,text_object_path=?,page_title=?,h1_json=?,html_language=?,readable_chars=?,detail=? WHERE source_report_sha256=? AND target_url=?""",
                            (prior_target["status"],prior_target["last_run_id"],prior_target["attempted_at"],prior_target["fetch_url"],prior_target["final_url"],prior_target["http_status"],prior_target["media_type"],prior_target["body_sha256"],prior_target["body_bytes"],prior_target["object_path"],prior_target["text_sha256"],prior_target["text_bytes"],prior_target["text_object_path"],prior_target["page_title"],prior_target["h1_json"],prior_target["html_language"],prior_target["readable_chars"],prior_target["detail"],source_sha,url))
                        if prior_target["media_type"] in {"text/html","application/xhtml+xml"} and prior_target["body_sha256"]:
                            prior_body=read_gzip(root,prior_target["object_path"],prior_target["body_sha256"],prior_target["body_bytes"],MAX_HTML_BYTES)
                            prior_parsed=analyze_html(prior_body,rows)
                            prior_status,prior_detail=html_target_status(None,prior_target["media_type"],prior_parsed)
                            prior_text=prior_parsed["text"].encode("utf-8")
                            prior_text_sha=hashlib.sha256(prior_text).hexdigest()
                            prior_text_path=store_gzip(root,prior_text_sha,prior_text,"html-text")
                            db.execute("""UPDATE html_targets SET status=?,text_sha256=?,text_bytes=?,text_object_path=?,
                                page_title=?,h1_json=?,html_language=?,readable_chars=?,detail=?
                                WHERE source_report_sha256=? AND target_url=?""",
                                (prior_status,prior_text_sha,len(prior_text),prior_text_path,prior_parsed["title"],
                                 json.dumps(prior_parsed["h1s"],ensure_ascii=False),prior_parsed["htmlLanguage"],
                                 len(prior_parsed["text"]),prior_detail,source_sha,url))
                            prior_html={cite_id(c):c for c in prior_parsed["citations"]}
                for row in rows:
                    cid = cite_id(row)
                    db.execute("""INSERT OR IGNORE INTO html_citations(source_report_sha256,citation_id,target_url,family,language,issuer_key,issuer_label,landing_url,landing_sha256,source_index_url,source_index_sha256,label,heading,year_label,evidence)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (source_sha,cid,url,row["family"],row["language"],row.get("issuerKey"),row["issuerLabel"],row["landingUrl"] or "",row.get("landingSha256"),row.get("sourceIndexUrl"),row.get("sourceIndexSha256"),row["label"],row.get("heading"),row.get("yearLabel") or "",row.get("evidence")))
                    if inserted and prior_target:
                        prior_citation=db.execute("SELECT status,family_disposition,year_disposition,language_disposition,issuer_disposition,detail FROM html_citations WHERE source_report_sha256<>? AND citation_id=? ORDER BY rowid DESC LIMIT 1",(source_sha,cid)).fetchone()
                        assessment=prior_html.get(cid)
                        if assessment:
                            db.execute("UPDATE html_citations SET status=?,family_disposition=?,year_disposition=?,language_disposition=?,issuer_disposition=?,detail=? WHERE source_report_sha256=? AND citation_id=?",
                                (assessment["disposition"],assessment.get("familyDisposition"),assessment.get("yearDisposition"),assessment.get("languageDisposition"),assessment.get("issuerDisposition"),prior_target["detail"],source_sha,cid))
                        elif prior_citation:
                            db.execute("UPDATE html_citations SET status=?,family_disposition=?,year_disposition=?,language_disposition=?,issuer_disposition=?,detail=? WHERE source_report_sha256=? AND citation_id=?",
                                (*tuple(prior_citation),source_sha,cid))
                        elif prior_target["status"]!="fetched":
                            db.execute("UPDATE html_citations SET status=?,detail=? WHERE source_report_sha256=? AND citation_id=?",
                                (prior_target["status"],prior_target["detail"],source_sha,cid))
            for retry_url in retry_urls or []:
                if retry_url not in by_url:
                    raise ValueError("retry URL is not in current HTML candidate inventory")
                db.execute("UPDATE html_targets SET status='pending' WHERE source_report_sha256=? AND target_url=? AND status='fetch-failed'", (source_sha,retry_url))
                db.execute("UPDATE html_citations SET status='pending' WHERE source_report_sha256=? AND target_url=? AND status='fetch-failed'", (source_sha,retry_url))
            db.execute("INSERT INTO html_runs(run_id,started_at,source_report_run_id,source_report_path,source_report_sha256,input_path,candidate_citations,candidate_targets,batch_limit,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (run_id,now,source_run_id,source_pointer["currentReportPath"],source_sha,str(source_path.relative_to(root)),len(candidates),len(by_url),batch_size,"running"))
        priority = {u:i for i,u in enumerate(priority_urls or [])}
        pending = [row[0] for row in db.execute("SELECT target_url FROM html_targets WHERE source_report_sha256=? AND status='pending'", (source_sha,))]
        pending.sort(key=lambda u: (priority.get(u, len(priority)), u))
        batch = pending[:batch_size]
        slots = batch_size-len(batch)
        if slots:
            now_dt=dt.datetime.now(dt.timezone.utc)
            possible=db.execute("SELECT target_url,status,attempted_at FROM html_targets WHERE source_report_sha256=? AND status NOT IN ('pending','out-of-policy') AND attempted_at IS NOT NULL ORDER BY attempted_at,target_url",(source_sha,)).fetchall()
            due=[]
            for row in possible:
                attempted=dt.datetime.fromisoformat(row["attempted_at"])
                attempts=db.execute("SELECT COUNT(*) FROM html_run_targets WHERE target_url=?",(row["target_url"],)).fetchone()[0]
                delay=recheck_after_days
                if row["status"] in {"fetch-failed","source-refused","not-found"}:
                    delay=min(30,recheck_after_days*(2**max(0,attempts-1)))
                if (now_dt-attempted).total_seconds()>=delay*86400:
                    due.append(row["target_url"])
            due=due[:slots]
            batch.extend(due)
            with db:
                for url in due:
                    db.execute("UPDATE html_targets SET status='pending' WHERE source_report_sha256=? AND target_url=?",(source_sha,url))
                    db.execute("UPDATE html_citations SET status='pending' WHERE source_report_sha256=? AND target_url=?",(source_sha,url))
        outputs = []
        for url in batch:
            if not committee_files.fetchable(url):
                status, detail = "out-of-policy", "Target is outside official HTTPS acquisition policy"
                body, final, http, media, parsed = None, None, None, None, None
            else:
                try:
                    body, final, http, media = fetcher(quote(url, safe=":/?#[]@!$&'()*+,;=%"))
                    parsed = analyze_html(body, by_url[url]) if media in {"text/html", "application/xhtml+xml"} else None
                    status, detail = html_target_status(None, media, parsed)
                except FetchError as error:
                    body, final, http, media, parsed = None, None, getattr(error, "status", None), None, None
                    status, detail = html_target_status(error)
            body_hash = hashlib.sha256(body).hexdigest() if body is not None else None
            body_path = store_gzip(root, body_hash, body, "html-objects") if body is not None else None
            text = parsed["text"].encode("utf-8") if parsed else None
            text_hash = hashlib.sha256(text).hexdigest() if text is not None else None
            text_path = store_gzip(root, text_hash, text, "html-text") if text is not None else None
            dispositions = {cite_id(cite): cite for cite in (parsed["citations"] if parsed else [])}
            for cite in by_url[url]:
                assessment = dispositions.get(cite_id(cite))
                cite_status = assessment["disposition"] if assessment else status
                cite.update(assessment or {})
                cite["status"] = cite_status
                cite["detail"] = detail
            outputs.append({"url":url,"status":status,"body_sha256":body_hash,"body_bytes":len(body) if body is not None else None,"object_path":body_path,"text_sha256":text_hash,"text_bytes":len(text) if text is not None else None,"text_object_path":text_path,"title":parsed["title"] if parsed else None,"h1s":parsed["h1s"] if parsed else [],"html_language":parsed["htmlLanguage"] if parsed else None,"readable_chars":len(parsed["text"]) if parsed else 0,"http_status":http,"media_type":media,"final_url":final,"detail":detail,"citations":[c for c in by_url[url]]})
        with db:
            for result in outputs:
                db.execute("""UPDATE html_targets SET status=?,last_run_id=?,attempted_at=?,fetch_url=?,final_url=?,http_status=?,media_type=?,body_sha256=?,body_bytes=?,object_path=?,text_sha256=?,text_bytes=?,text_object_path=?,page_title=?,h1_json=?,html_language=?,readable_chars=?,detail=? WHERE source_report_sha256=? AND target_url=?""",
                    (result["status"],run_id,now,quote(result["url"], safe=":/?#[]@!$&'()*+,;=%"),result["final_url"],result["http_status"],result["media_type"],result["body_sha256"],result["body_bytes"],result["object_path"],result["text_sha256"],result["text_bytes"],result["text_object_path"],result["title"],json.dumps(result["h1s"],ensure_ascii=False),result["html_language"],result["readable_chars"],result["detail"],source_sha,result["url"]))
                for cite in result["citations"]:
                    db.execute("UPDATE html_citations SET status=?,family_disposition=?,year_disposition=?,language_disposition=?,issuer_disposition=?,detail=? WHERE source_report_sha256=? AND citation_id=?",
                        (cite["status"],cite.get("familyDisposition"),cite.get("yearDisposition"),cite.get("languageDisposition"),cite.get("issuerDisposition"),result["detail"],source_sha,cite_id(cite)))
                    db.execute("""INSERT INTO html_run_citations(run_id,citation_id,target_url,family,language,issuer_label,landing_url,landing_sha256,source_index_url,source_index_sha256,label,heading,year_label,evidence,status,family_disposition,year_disposition,language_disposition,issuer_disposition,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (run_id,cite_id(cite),cite["url"],cite["family"],cite["language"],cite["issuerLabel"],cite["landingUrl"] or "",cite.get("landingSha256"),cite.get("sourceIndexUrl"),cite.get("sourceIndexSha256"),cite["label"],cite.get("heading"),cite.get("yearLabel") or "",cite.get("evidence"),cite["status"],cite.get("familyDisposition"),cite.get("yearDisposition"),cite.get("languageDisposition"),cite.get("issuerDisposition"),result["detail"]))
                db.execute("""INSERT INTO html_run_targets(run_id,target_url,status,body_sha256,body_bytes,object_path,text_sha256,text_bytes,text_object_path,page_title,h1_json,html_language,readable_chars,http_status,media_type,final_url,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (run_id,result["url"],result["status"],result["body_sha256"],result["body_bytes"],result["object_path"],result["text_sha256"],result["text_bytes"],result["text_object_path"],result["title"],json.dumps(result["h1s"],ensure_ascii=False),result["html_language"],result["readable_chars"],result["http_status"],result["media_type"],result["final_url"],result["detail"]))
            remaining = db.execute("SELECT COUNT(*) FROM html_targets WHERE source_report_sha256=? AND status='pending'",(source_sha,)).fetchone()[0]
            possible=db.execute("SELECT target_url,status,attempted_at FROM html_targets WHERE source_report_sha256=? AND status NOT IN ('pending','out-of-policy') AND attempted_at IS NOT NULL ORDER BY attempted_at,target_url",(source_sha,)).fetchall()
            due_remaining=0
            now_dt=dt.datetime.now(dt.timezone.utc)
            for row in possible:
                attempted=dt.datetime.fromisoformat(row["attempted_at"])
                attempts=db.execute("SELECT COUNT(*) FROM html_run_targets WHERE target_url=?",(row["target_url"],)).fetchone()[0]
                delay=min(30,recheck_after_days*(2**max(0,attempts-1))) if row["status"] in {"fetch-failed","source-refused","not-found"} else recheck_after_days
                if (now_dt-attempted).total_seconds()>=delay*86400: due_remaining+=1
            counts = dict(db.execute("SELECT status,COUNT(*) FROM html_targets WHERE source_report_sha256=? GROUP BY status",(source_sha,)).fetchall())
            coverage={}
            for fam in sorted(FAMILIES):
                for lang in ("en","fr"):
                    coverage[f"{fam}/{lang}"]={"citations":sum(1 for c in candidates if c["family"]==fam and c["language"]==lang),"targets":len({c["url"] for c in candidates if c["family"]==fam and c["language"]==lang}),"accepted":db.execute("SELECT COUNT(*) FROM html_citations WHERE source_report_sha256=? AND family=? AND language=? AND status='accepted'",(source_sha,fam,lang)).fetchone()[0],"pending":db.execute("SELECT COUNT(*) FROM html_citations WHERE source_report_sha256=? AND family=? AND language=? AND status='pending'",(source_sha,fam,lang)).fetchone()[0]}
            status="pending" if remaining or due_remaining else ("complete" if all(x in {"accepted"} for x in [r[0] for r in db.execute("SELECT DISTINCT status FROM html_citations WHERE source_report_sha256=?",(source_sha,))]) else "partial")
            report={"collection":"departmental-report-html-documents","htmlParserVersion":HTML_PARSER_VERSION,"runId":run_id,"status":status,"observedAt":now,"sourceEditionRunId":source_run_id,"sourceCurrentReportSha256":source_sha,"candidateCitations":len(candidates),"candidateTargets":len(by_url),"batchLimit":batch_size,"processedTargets":len(outputs),"remainingPending":remaining,"dueRecheckTargets":due_remaining,"recheckPolicy":{"days":recheck_after_days,"failedTargetBackoffDays":"7,14,28,30 (capped)","retryableStatuses":["fetch-failed","source-refused","not-found"]},"transportPolicy":{"tls":"urllib verification; curl system trust fallback only after certificate-verification failure","tlsVerificationDisabled":False,"redirects":"manual, official HTTPS hosts only, at most five","maxResponseBytes":MAX_HTML_BYTES},"targetStatusCounts":counts,"byFamilyLanguage":coverage,"targets":[{k:v for k,v in r.items() if k!="citations"} for r in outputs],"citations":[c for r in outputs for c in r["citations"]],"scope":"HTML landing pages are accepted only when title/H1 identify family and year, the html lang matches, and the visible text names the attributed issuer. Matching URLs carry their last archived assessment into a new inventory snapshot until a due recheck. Missing links in one partial inventory are not treated as removals. This is page-level identification, not complete report-text coverage."}
            rel=f"html-generations/{run_id}.json"; path=root/rel
            report_sha, report_bytes=write_json(path,report)
            db.execute("UPDATE html_runs SET completed_at=?,processed_targets=?,remaining_pending=?,report_path=?,report_sha256=?,status=? WHERE run_id=?",(utc_now(),len(outputs),remaining,rel,report_sha,status,run_id))
        latest={"runId":run_id,"status":status,"reportPath":rel,"reportSha256":report_sha,"reportBytes":report_bytes,"publishedAt":utc_now()}
        _atomic_pointer(root/"latest-html-attempt.json",latest)
        if status=="complete": _atomic_pointer(root/"latest-html-complete.json",latest)
        return report
    except Exception as error:
        try:
            with db:
                db.execute("UPDATE html_runs SET completed_at=?,status='failed',detail=? WHERE run_id=? AND completed_at IS NULL",
                           (utc_now(),str(error)[:1000],run_id))
        except sqlite3.Error:
            pass
        raise
    finally:
        db.close()


def html_replay(run_id: str, root: Path = DEFAULT_ROOT) -> dict:
    db=open_db(root,read_only=True)
    try:
        run=db.execute("SELECT * FROM html_runs WHERE run_id=?",(run_id,)).fetchone()
        if not run: raise KeyError("unknown HTML document generation "+run_id)
        source=read_gzip(root,run["input_path"],run["source_report_sha256"],len((root/run["input_path"]).read_bytes()),16*1024*1024) if run["input_path"].endswith(".gz") else (root/run["input_path"]).read_bytes()
        if hashlib.sha256(source).hexdigest()!=run["source_report_sha256"]: raise ValueError("HTML source inventory hash mismatch")
        report=json.loads(source)
        report_raw=(root/run["report_path"]).read_bytes()
        if hashlib.sha256(report_raw).hexdigest()!=run["report_sha256"]: raise ValueError("HTML generation report hash failed")
        generation=json.loads(report_raw)
        parser=analyze_html if generation.get("htmlParserVersion", 1) >= HTML_PARSER_VERSION else analyze_html_legacy
        by_url=_candidate_report(collect_html_candidates(report))
        for row in db.execute("SELECT * FROM html_run_targets WHERE run_id=? AND body_sha256 IS NOT NULL",(run_id,)):
            body=read_gzip(root,row["object_path"],row["body_sha256"],row["body_bytes"],MAX_HTML_BYTES)
            if row["media_type"] in {"text/html","application/xhtml+xml"}:
                parsed=parser(body,by_url[row["target_url"]])
                text=parsed["text"].encode("utf-8")
                if hashlib.sha256(text).hexdigest()!=row["text_sha256"] or parsed["title"]!=row["page_title"] or json.dumps(parsed["h1s"],ensure_ascii=False)!=row["h1_json"]:
                    raise ValueError("HTML replay differs for "+row["target_url"])
                expected=sorted((c["disposition"],c["familyDisposition"],c["yearDisposition"],c["languageDisposition"],c["issuerDisposition"]) for c in parsed["citations"])
                recorded=sorted((r["status"],r["family_disposition"],r["year_disposition"],r["language_disposition"],r["issuer_disposition"]) for r in db.execute("SELECT * FROM html_run_citations WHERE run_id=? AND target_url=?",(run_id,row["target_url"])))
                if expected!=recorded: raise ValueError("HTML citation replay differs for "+row["target_url"])
        return generation
    finally: db.close()


def html_reassess(target_urls: list[str] | None = None, root: Path = DEFAULT_ROOT,
                  unreadable_host: str | None = None) -> dict:
    """Re-extract already archived HTML without network access, preserving fetch timestamps."""
    target_urls = list(target_urls or [])
    if bool(target_urls) == bool(unreadable_host) or len(set(target_urls)) != len(target_urls):
        raise ValueError("provide unique target URLs or one exact host for unreadable archived HTML")
    if unreadable_host and not re.fullmatch(r"[A-Za-z0-9.-]+", unreadable_host):
        raise ValueError("unreadable host must be an exact hostname")
    pointer=json.loads((root/"latest-html-attempt.json").read_text(encoding="utf-8"))
    old_run=pointer["runId"]
    db=open_db(root)
    now,run_id=utc_now(),hashlib.sha256(os.urandom(32)).hexdigest()[:32]
    try:
        run=db.execute("SELECT * FROM html_runs WHERE run_id=?",(old_run,)).fetchone()
        if not run: raise ValueError("latest HTML run is absent from its database")
        if unreadable_host:
            target_urls=[row[0] for row in db.execute("SELECT target_url FROM html_targets WHERE source_report_sha256=? AND status='unreadable' ORDER BY target_url",(run["source_report_sha256"],))
                         if urlsplit(row[0]).hostname == unreadable_host]
            if not target_urls: raise ValueError("no unreadable archived HTML targets match the exact host")
        source_path=root/run["input_path"]
        raw=source_path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=run["source_report_sha256"]: raise ValueError("archived HTML source inventory checksum failed")
        source=json.loads(raw); candidates=collect_html_candidates(source); by_url=_candidate_report(candidates)
        if any(url not in by_url for url in target_urls): raise ValueError("reassessment URL is not in the pinned source inventory")
        db.execute("INSERT INTO html_runs(run_id,started_at,source_report_run_id,source_report_path,source_report_sha256,input_path,candidate_citations,candidate_targets,batch_limit,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (run_id,now,run["source_report_run_id"],run["source_report_path"],run["source_report_sha256"],run["input_path"],len(candidates),len(by_url),len(target_urls),"running"))
        outputs=[]
        for url in target_urls:
            row=db.execute("SELECT * FROM html_targets WHERE source_report_sha256=? AND target_url=?",(run["source_report_sha256"],url)).fetchone()
            if not row or not row["body_sha256"] or row["media_type"] not in {"text/html","application/xhtml+xml"}:
                raise ValueError("target has no archived HTML body: "+url)
            body=read_gzip(root,row["object_path"],row["body_sha256"],row["body_bytes"],MAX_HTML_BYTES)
            parsed=analyze_html(body,by_url[url]); text=parsed["text"].encode("utf-8")
            text_hash=hashlib.sha256(text).hexdigest(); text_path=store_gzip(root,text_hash,text,"html-text")
            status,detail=html_target_status(None,row["media_type"],parsed)
            result={"url":url,"status":status,"body_sha256":row["body_sha256"],"body_bytes":row["body_bytes"],"object_path":row["object_path"],"text_sha256":text_hash,"text_bytes":len(text),"text_object_path":text_path,"title":parsed["title"],"h1s":parsed["h1s"],"html_language":parsed["htmlLanguage"],"readable_chars":len(parsed["text"]),"http_status":row["http_status"],"media_type":row["media_type"],"final_url":row["final_url"],"detail":detail,"citations":parsed["citations"]}
            outputs.append(result)
            db.execute("UPDATE html_targets SET status=?,last_run_id=?,text_sha256=?,text_bytes=?,text_object_path=?,page_title=?,h1_json=?,html_language=?,readable_chars=?,detail=? WHERE source_report_sha256=? AND target_url=?",
                (status,run_id,text_hash,len(text),text_path,parsed["title"],json.dumps(parsed["h1s"],ensure_ascii=False),parsed["htmlLanguage"],len(parsed["text"]),detail,run["source_report_sha256"],url))
            for cite in parsed["citations"]:
                db.execute("UPDATE html_citations SET status=?,family_disposition=?,year_disposition=?,language_disposition=?,issuer_disposition=?,detail=? WHERE source_report_sha256=? AND citation_id=?",
                    (cite["disposition"],cite["familyDisposition"],cite["yearDisposition"],cite["languageDisposition"],cite["issuerDisposition"],detail,run["source_report_sha256"],cite_id(cite)))
                db.execute("INSERT INTO html_run_citations(run_id,citation_id,target_url,family,language,issuer_label,landing_url,landing_sha256,source_index_url,source_index_sha256,label,heading,year_label,evidence,status,family_disposition,year_disposition,language_disposition,issuer_disposition,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (run_id,cite_id(cite),url,cite["family"],cite["language"],cite["issuerLabel"],cite["landingUrl"] or "",cite.get("landingSha256"),cite.get("sourceIndexUrl"),cite.get("sourceIndexSha256"),cite["label"],cite.get("heading"),cite.get("yearLabel") or "",cite.get("evidence"),cite["disposition"],cite["familyDisposition"],cite["yearDisposition"],cite["languageDisposition"],cite["issuerDisposition"],detail))
            db.execute("INSERT INTO html_run_targets(run_id,target_url,status,body_sha256,body_bytes,object_path,text_sha256,text_bytes,text_object_path,page_title,h1_json,html_language,readable_chars,http_status,media_type,final_url,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id,url,status,row["body_sha256"],row["body_bytes"],row["object_path"],text_hash,len(text),text_path,parsed["title"],json.dumps(parsed["h1s"],ensure_ascii=False),parsed["htmlLanguage"],len(parsed["text"]),row["http_status"],row["media_type"],row["final_url"],detail))
        status_counts=dict(db.execute("SELECT status,COUNT(*) FROM html_targets WHERE source_report_sha256=? GROUP BY status",(run["source_report_sha256"],)).fetchall())
        citation_counts=dict(db.execute("SELECT status,COUNT(*) FROM html_citations WHERE source_report_sha256=? GROUP BY status",(run["source_report_sha256"],)).fetchall())
        status="complete" if set(citation_counts).issubset({"accepted"}) else "partial"
        report={"collection":"departmental-report-html-documents","htmlParserVersion":HTML_PARSER_VERSION,"runId":run_id,"status":status,"observedAt":now,"reassessedAt":now,"sourceEditionRunId":run["source_report_run_id"],"sourceCurrentReportSha256":run["source_report_sha256"],"candidateCitations":len(candidates),"candidateTargets":len(by_url),"batchLimit":len(target_urls),"processedTargets":len(outputs),"remainingPending":status_counts.get("pending",0),"targetStatusCounts":status_counts,"citationDispositionCounts":citation_counts,"targets":[{k:v for k,v in result.items() if k!="citations"} for result in outputs],"citations":[cite for result in outputs for cite in result["citations"]],"reassessment":{"kind":"archived-html-re-extraction","networkAccess":False,"targets":target_urls,"fetchTimestampsPreserved":True},"scope":"Reassessment re-extracts archived HTML bytes only; it does not represent a new publisher fetch."}
        rel=f"html-generations/{run_id}.json"; report_sha,report_bytes=write_json(root/rel,report)
        db.execute("UPDATE html_runs SET completed_at=?,processed_targets=?,remaining_pending=?,report_path=?,report_sha256=?,status=? WHERE run_id=?",(utc_now(),len(outputs),status_counts.get("pending",0),rel,report_sha,status,run_id))
        db.commit()
        latest={"runId":run_id,"status":status,"reportPath":rel,"reportSha256":report_sha,"reportBytes":report_bytes,"publishedAt":utc_now()}
        _atomic_pointer(root/"latest-html-attempt.json",latest)
        return report
    except Exception:
        db.rollback()
        raise
    finally: db.close()


def html_audit(root: Path = DEFAULT_ROOT, edition_root: Path = EDITION_ROOT,
               pinned_source_sha256: str | None = None) -> dict:
    """Reproduce cumulative queue coverage for the exact current inventory and replay its batches."""
    if pinned_source_sha256:
        if not re.fullmatch(r"[0-9a-f]{64}",pinned_source_sha256): raise ValueError("source SHA-256 must be 64 lowercase hex characters")
        input_path=root/"inputs"/(pinned_source_sha256+".json")
        raw=input_path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=pinned_source_sha256: raise ValueError("Pinned HTML source inventory hash mismatch")
        source=json.loads(raw)
        source_sha=pinned_source_sha256
        source_run_id=None
    else:
        raw, source, source_run_id=validate_input(edition_root)
        source_sha=hashlib.sha256(raw).hexdigest()
    candidates=collect_html_candidates(source)
    groups=_candidate_report(candidates)
    db=open_db(root,read_only=True)
    try:
        targets=[tuple(row) for row in db.execute("SELECT status,COUNT(*) FROM html_targets WHERE source_report_sha256=? GROUP BY status ORDER BY status",(source_sha,))]
        citations=[tuple(row) for row in db.execute("SELECT status,COUNT(*) FROM html_citations WHERE source_report_sha256=? GROUP BY status ORDER BY status",(source_sha,))]
        target_count=db.execute("SELECT COUNT(*) FROM html_targets WHERE source_report_sha256=?",(source_sha,)).fetchone()[0]
        citation_count=db.execute("SELECT COUNT(*) FROM html_citations WHERE source_report_sha256=?",(source_sha,)).fetchone()[0]
        if target_count!=len(groups) or citation_count!=len(candidates):
            raise ValueError("HTML persisted queue does not match current inventory candidate denominator")
        if source_run_id is None:
            source_runs=db.execute("SELECT DISTINCT source_report_run_id FROM html_runs WHERE source_report_sha256=?",(source_sha,)).fetchall()
            if len(source_runs)!=1: raise ValueError("Pinned inventory has no unique local acquisition run provenance")
            source_run_id=source_runs[0][0]
        by_family_language={}
        for family in sorted(FAMILIES):
            for language in ("en","fr"):
                status_counts=[tuple(row) for row in db.execute("SELECT status,COUNT(*) FROM html_citations WHERE source_report_sha256=? AND family=? AND language=? GROUP BY status ORDER BY status",(source_sha,family,language))]
                by_family_language[f"{family}/{language}"]={"candidates":sum(1 for c in candidates if c["family"]==family and c["language"]==language),"statuses":dict(status_counts)}
        runs=[row[0] for row in db.execute("SELECT run_id FROM html_runs WHERE source_report_sha256=? AND report_path IS NOT NULL ORDER BY started_at,run_id",(source_sha,))]
        incomplete_runs=[tuple(row) for row in db.execute("SELECT run_id,status,detail FROM html_runs WHERE source_report_sha256=? AND report_path IS NULL ORDER BY started_at,run_id",(source_sha,))]
    finally:
        db.close()
    for run_id in runs: html_replay(run_id,root)
    targets_by_status=dict(targets); citations_by_status=dict(citations)
    queue_complete=not targets_by_status.get("pending",0) and not citations_by_status.get("pending",0)
    all_accepted=queue_complete and set(citations_by_status).issubset({"accepted"})
    run_ids_sha=hashlib.sha256("\n".join(runs).encode()).hexdigest()
    return {"collection":"departmental-report-html-audit","sourceEditionRunId":source_run_id,
            "sourceCurrentReportSha256":source_sha,"candidateTargets":len(groups),"candidateCitations":len(candidates),
            "targetStatusCounts":targets_by_status,"citationDispositionCounts":citations_by_status,
            "readableAcquisitions":targets_by_status.get("fetched",0),"acceptedCitations":citations_by_status.get("accepted",0),
            "byFamilyLanguage":by_family_language,"replayedBatchRuns":len(runs),"replayedRunIdsSha256":run_ids_sha,
            "failedOrIncompleteRuns":[{"runId":r[0],"status":r[1],"detail":r[2]} for r in incomplete_runs],
            "status":"complete" if all_accepted else "partial","replayStatus":"verified",
            "queueCompleteness":"drained" if queue_complete else "pending"}


def html_backfill(root: Path = DEFAULT_ROOT, edition_root: Path = EDITION_ROOT,
                  batch_size: int = 24, minimum_free_bytes: int = 3 * 1024 * 1024 * 1024,
                  max_batches: int | None = None, fetcher=fetch_html,
                  recheck_after_days: int = 7) -> list[dict]:
    """Sequentially exhaust the current pending queue, stopping on a disk floor or no progress."""
    reports = []
    batches = 0
    retried = False
    while max_batches is None or batches < max_batches:
        free = shutil.disk_usage(root if root.exists() else root.parent).free
        if free < minimum_free_bytes + batch_size * MAX_HTML_BYTES:
            raise RuntimeError("HTML backfill stopped to preserve configured host free-space floor")
        retry_urls = []
        if not retried:
            raw, source, _ = validate_input(edition_root)
            source_sha = hashlib.sha256(raw).hexdigest()
            if root.exists() and (root / "documents.sqlite").exists():
                db = open_db(root, read_only=True)
                try:
                    retry_urls = [row[0] for row in db.execute("SELECT target_url FROM html_targets WHERE source_report_sha256=? AND status='fetch-failed'", (source_sha,))]
                finally:
                    db.close()
            retried = True
        report = html_refresh(root, edition_root, batch_size, fetcher=fetcher, retry_urls=retry_urls,
                              recheck_after_days=recheck_after_days)
        reports.append(report)
        batches += 1
        free = shutil.disk_usage(root).free
        print(json.dumps({"runId":report["runId"],"processedTargets":report["processedTargets"],
                          "remainingPending":report["remainingPending"],"statusCounts":report["targetStatusCounts"],
                          "freeBytes":free},sort_keys=True),flush=True)
        if report["remainingPending"] == 0:
            break
        if report["processedTargets"] == 0 and report["remainingPending"] > 0:
            raise RuntimeError("HTML backfill made no pending-queue progress; stopping before a repeated batch")
    return reports


def _write_generation(db, root: Path, run_id: str, report_run_id: str, input_path: str,
                      source_sha: str, source_path: str, groups: dict, started: str,
                      budget: Budget) -> dict:
    docs, citations, failed, readable = [], [], 0, 0
    for row in db.execute("SELECT * FROM documents WHERE run_id=? ORDER BY target_url", (run_id,)):
        document = dict(row)
        if document.get("publisher_notice_json"):
            document["publisherNotice"] = json.loads(document.pop("publisher_notice_json"))
        else:
            document.pop("publisher_notice_json", None)
        docs.append(document)
    for row in db.execute("SELECT * FROM citations WHERE run_id=? ORDER BY family,language,issuer_label,issue_year,target_url", (run_id,)):
        citation = dict(row)
        candidate = next((item for item in groups.get(row["target_url"], []) if cite_id(item) == row["citation_id"]), None)
        if candidate and candidate.get("publisherRecovery"):
            citation["publisherRecovery"] = candidate["publisherRecovery"]
        citations.append(citation)
    failed = sum(doc["status"] in {"failed", "budget-skipped", "unreadable", "wrong-kind"} for doc in docs)
    readable = sum(doc["status"] in {"readable", "review"} for doc in docs)
    verified = sum(cite["disposition"] == "verified" for cite in citations)
    status = "complete" if failed == 0 and verified == len(citations) else "partial"
    by_family_language = {}
    for family in sorted(FAMILIES):
        for language in ("en", "fr"):
            matches = [item for item in citations if item["family"] == family and item["language"] == language]
            by_family_language[f"{family}/{language}"] = {
                "citations": len(matches),
                "verified": sum(item["disposition"] == "verified" for item in matches),
                "review": sum(item["disposition"] == "review" for item in matches),
                "acquisitionFailures": sum(item["disposition"] in {"failed", "budget-skipped"} for item in matches),
                "languageMismatches": sum(item["language_disposition"] in {"mismatch", "source-link-conflict"} for item in matches),
                "yearMismatches": sum(item["year_disposition"] == "mismatch" for item in matches),
            }
    return {"collection": "departmental-report-documents", "schemaVersion": 3,
        "runId": run_id, "status": status,
        "observedAt": utc_now(), "sourceEditionRunId": report_run_id,
        "sourceCurrentReportPath": source_path, "sourceCurrentReportSha256": source_sha,
        "sourceCurrentReportObject": input_path,
        "summary": {"directLinkCitations": len(citations), "uniquePdfTargets": len(docs),
                    "fetchedTargets": sum(d["body_sha256"] is not None for d in docs),
                    "failedTargets": failed, "readableTargets": readable,
                    "verifiedCitations": verified, "reviewCitations": len(citations) - verified,
                    "archivedBodyBytes": budget.used, "byFamilyLanguage": by_family_language},
        "scope": "Only explicitly labelled direct-edition PDF links from the source snapshot were fetched. Generic index links and regulatory discovery links were excluded. Source PDFs are archived intact; readable text and issue/language checks use up to the first ten PDF pages. A linked PDF is verified only when it is readable and its family, issue year, and language signals match; linked PDF coverage is not full-document coverage for any issuer series.",
        "documents": docs, "citations": citations}


def refresh(root: Path = DEFAULT_ROOT, edition_root: Path = EDITION_ROOT, workers: int = MAX_WORKERS,
            max_archive_bytes: int = MAX_ARCHIVE_BYTES, min_free_bytes: int = MIN_FREE_BYTES,
            fetcher=fetch_pdf_with_evidence) -> dict:
    if not 1 <= workers <= 4:
        raise ValueError("workers must be between 1 and 4")
    if shutil.disk_usage(root.parent if root.parent.exists() else ROOT).free < min_free_bytes + max_archive_bytes:
        raise RuntimeError("insufficient free space for bounded document archive refresh")
    raw, source, source_run_id = validate_input(edition_root)
    candidates = collect_candidates(source, use_pdf_filename_for_size_label=True)
    groups = _candidate_report(candidates)
    if not candidates:
        raise ValueError("Current edition report contains no allowed direct PDF links")
    run_id = hashlib.sha256((hashlib.sha256(raw).hexdigest() + utc_now() + os.urandom(16).hex()).encode()).hexdigest()[:32]
    db = open_db(root)
    budget = Budget(max_archive_bytes)
    input_path = load_report_input(root, source_run_id, raw, source)
    started = dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")
    current_path = (edition_root / "current.json").resolve()
    source_path = str(current_path.relative_to(ROOT)) if ROOT in current_path.parents else str(current_path)
    source_sha = hashlib.sha256(raw).hexdigest()
    try:
        with db:
            db.execute("INSERT INTO generations(run_id,started_at,status,source_report_run_id,source_report_path,source_report_sha256,input_path,expected_citations,unique_targets) VALUES(?,?,?,?,?,?,?,?,?)",
                       (run_id, started, "running", source_run_id, source_path, source_sha, input_path, len(candidates), len(groups)))
            for url, citations in groups.items():
                db.execute("INSERT INTO documents(run_id,target_url,fetch_url,status) VALUES(?,?,?,'pending')",
                           (run_id, url, citations[0]["fetchUrl"]))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_fetch_one, items[0]["fetchUrl"], budget, fetcher): url for url, items in groups.items()}
            for future in as_completed(futures):
                url, fetched = futures[future], future.result()
                if fetched["status"] == "fetched":
                    extracted = _pdf_process(root, run_id, url, fetched, groups[url])
                    with db:
                        notice_json = json.dumps(extracted["publisherNotice"], sort_keys=True) if extracted.get("publisherNotice") else None
                        db.execute("UPDATE documents SET status=?,http_status=?,media_type=?,final_url=?,body_sha256=?,body_bytes=?,object_path=?,text_sha256=?,text_bytes=?,text_object_path=?,text_pages=?,readable_chars=?,detail=?,publisher_notice_json=? WHERE run_id=? AND target_url=?",
                                   (extracted["status"], fetched["httpStatus"], fetched["mediaType"], fetched["finalUrl"], fetched["bodySha256"], fetched["bodyBytes"], extracted["bodyPath"], extracted["textSha256"], extracted["textBytes"], extracted["textPath"], extracted["textPages"], extracted["readableChars"], extracted["detail"], notice_json, run_id, url))
                        for candidate, assessment in zip(groups[url], extracted["citations"]):
                            _store_citation(db, run_id, url, candidate, assessment)
                        if not extracted["citations"]:
                            for candidate in groups[url]:
                                _store_citation(db, run_id, url, candidate, {"disposition": extracted["status"], "detail": extracted["detail"]})
                else:
                    with db:
                        db.execute("UPDATE documents SET status=?,http_status=?,detail=? WHERE run_id=? AND target_url=?",
                                   (fetched["status"], fetched.get("httpStatus"), fetched.get("detail"), run_id, url))
                        for candidate in groups[url]:
                            _store_citation(db, run_id, url, candidate, {"disposition": fetched["status"], "detail": fetched.get("detail")})
        provisional = _write_generation(db, root, run_id, source_run_id, input_path, source_sha, source_path, groups, started, budget)
        report_path = root / "generations" / f"{run_id}.json"
        report_sha, report_bytes = write_json(report_path, provisional)
        with db:
            db.execute("UPDATE generations SET completed_at=?,status=?,fetched_targets=?,failed_targets=?,readable_targets=?,archived_bytes=?,report_path=?,report_sha256=? WHERE run_id=?",
                       (provisional["observedAt"], provisional["status"], provisional["summary"]["fetchedTargets"], provisional["summary"]["failedTargets"], provisional["summary"]["readableTargets"], budget.used, str(report_path.relative_to(root)), report_sha, run_id))
        publish_pointer(root, db, run_id, provisional, report_path, report_sha, report_bytes, complete=provisional["status"] == "complete")
        return provisional
    finally:
        db.close()


def _store_citation(db, run_id: str, url: str, candidate: dict, assessment: dict) -> None:
    cid = cite_id(candidate)
    db.execute("INSERT OR REPLACE INTO citations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, cid, url, candidate["family"], candidate["language"], candidate.get("issuerKey"), candidate["issuerLabel"],
         candidate["landingUrl"], candidate.get("landingSha256") or "", candidate.get("sourceIndexUrl"),
         candidate.get("sourceIndexSha256"), candidate["label"], candidate.get("heading"), candidate.get("yearLabel"),
         candidate.get("issueYear"), candidate.get("evidence"), assessment.get("disposition", "review"),
         assessment.get("familyDisposition"), assessment.get("languageDisposition"), assessment.get("yearDisposition"),
         assessment.get("issuerDisposition"), assessment.get("detail")))


def write_json(path: Path, value: dict) -> tuple[str, int]:
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".documents-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return hashlib.sha256(data).hexdigest(), len(data)


def publish_pointer(root: Path, db, run_id: str, report: dict, report_path: Path,
                    report_sha: str, report_bytes: int, complete: bool):
    pointer = {"runId": run_id, "status": report["status"], "reportPath": str(report_path.relative_to(root)),
               "reportSha256": report_sha, "reportBytes": report_bytes, "publishedAt": utc_now()}
    with db:
        db.execute("UPDATE generations SET detail=detail WHERE run_id=?", (run_id,))
        started = db.execute("SELECT started_at FROM generations WHERE run_id=?", (run_id,)).fetchone()[0]
        for name in ("latest-attempt.json", "latest.json"):
            if name == "latest.json" and not complete:
                continue
            path = root / name
            existing = None
            if path.exists():
                try:
                    existing = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    existing = None
            prior_started = None
            if existing and existing.get("runId"):
                prior = db.execute("SELECT started_at FROM generations WHERE run_id=?", (existing["runId"],)).fetchone()
                prior_started = prior[0] if prior else None
            if prior_started is None or started >= prior_started:
                _atomic_pointer(path, pointer)


def _atomic_pointer(path: Path, value: dict) -> None:
    write_json(path, value)


def replay(run_id: str, root: Path = DEFAULT_ROOT) -> dict:
    db = open_db(root, read_only=True)
    try:
        generation = db.execute("SELECT * FROM generations WHERE run_id=?", (run_id,)).fetchone()
        if not generation:
            raise KeyError("unknown document generation " + run_id)
        input_path = root / generation["input_path"]
        raw = input_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != generation["source_report_sha256"]:
            raise ValueError("Archived source edition report failed checksum verification")
        source = json.loads(raw)
        report_path = root / generation["report_path"]
        report_raw = report_path.read_bytes()
        if hashlib.sha256(report_raw).hexdigest() != generation["report_sha256"]:
            raise ValueError("Document generation report hash failed")
        report = json.loads(report_raw)
        schema_version = report.get("schemaVersion", 1)
        candidates = collect_candidates(source, apply_recoveries=schema_version >= 2,
                                        use_pdf_filename_for_size_label=schema_version >= 3)
        by_url = _candidate_report(candidates)
        document_columns = {row[1] for row in db.execute("PRAGMA table_info(documents)")}
        notice_column = "publisher_notice_json" in document_columns
        doc_query = ("SELECT * FROM documents WHERE run_id=? ORDER BY target_url" if notice_column else
                     "SELECT *,NULL AS publisher_notice_json FROM documents WHERE run_id=? ORDER BY target_url")
        for doc in db.execute(doc_query, (run_id,)):
            if schema_version >= 2 and doc["publisher_notice_json"]:
                notice = json.loads(doc["publisher_notice_json"])
                notice_body = read_gzip(root, notice["archivePath"], notice["noticeSha256"],
                                        notice["noticeBytes"], MAX_HTML_BYTES)
                if (notice["continueHref"] != notice["targetUrl"] or
                        not public_archive_continue(notice_body, notice["targetUrl"], notice["noticeUrl"]) or
                        doc["fetch_url"] != notice["targetUrl"] or
                        not any(candidate.get("fetchUrl") == notice["targetUrl"]
                                for candidate in by_url.get(doc["target_url"], []))):
                    raise ValueError("Publisher archive notice recovery evidence does not match its source citation")
            if doc["body_sha256"]:
                body = read_gzip(root, doc["object_path"], doc["body_sha256"], doc["body_bytes"], MAX_DOCUMENT_BYTES)
                if body.startswith(b"%PDF-"):
                    text, pages = pdf_text(body)
                    text_raw = text.encode("utf-8")
                    if hashlib.sha256(text_raw).hexdigest() != doc["text_sha256"] or pages != doc["text_pages"]:
                        raise ValueError("PDF text replay differs: " + doc["target_url"])
                    expected = [assess(text, candidate, semantics_version=schema_version)
                                for candidate in by_url[doc["target_url"]]]
                    recorded = [dict(row) for row in db.execute("SELECT disposition,family_disposition,language_disposition,year_disposition,issuer_disposition FROM citations WHERE run_id=? AND target_url=? ORDER BY citation_id", (run_id, doc["target_url"]))]
                    pairs = sorted((x["disposition"], x.get("familyDisposition"), x.get("languageDisposition"), x.get("yearDisposition"), x.get("issuerDisposition")) for x in expected)
                    actual = sorted((x["disposition"], x["family_disposition"], x["language_disposition"], x["year_disposition"], x["issuer_disposition"]) for x in recorded)
                    if pairs != actual:
                        raise ValueError("PDF citation assessment replay differs: " + doc["target_url"])
        report_docs = {doc["target_url"]: doc for doc in report.get("documents", [])}
        if schema_version >= 2:
            notice_query = ("SELECT target_url,publisher_notice_json FROM documents WHERE run_id=?" if notice_column else
                            "SELECT target_url,NULL AS publisher_notice_json FROM documents WHERE run_id=?")
            for doc in db.execute(notice_query, (run_id,)):
                recorded_notice = json.loads(doc["publisher_notice_json"]) if doc["publisher_notice_json"] else None
                report_notice = report_docs.get(doc["target_url"], {}).get("publisherNotice")
                if recorded_notice != report_notice:
                    raise ValueError("Publisher archive notice receipt differs from stored acquisition evidence: " + doc["target_url"])
        report_citations = {(cite["target_url"], cite["citation_id"]): cite for cite in report.get("citations", [])}
        if schema_version >= 2:
            for candidate in candidates:
                recovery = candidate.get("publisherRecovery")
                if recovery:
                    recorded = report_citations.get((candidate["url"], cite_id(candidate)))
                    if recorded is None or recorded.get("publisherRecovery") != recovery:
                        raise ValueError("Publisher source recovery citation differs from archived edition evidence: " + candidate["url"])
        return report
    finally:
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    refresh_parser = sub.add_parser("refresh", help="fetch explicitly linked direct PDF editions")
    refresh_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    refresh_parser.add_argument("--edition-root", type=Path, default=EDITION_ROOT)
    refresh_parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    refresh_parser.add_argument("--max-archive-bytes", type=int, default=MAX_ARCHIVE_BYTES)
    replay_parser = sub.add_parser("replay", help="verify local source objects and repeat text extraction")
    replay_parser.add_argument("run_id")
    replay_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    html_parser = sub.add_parser("html-refresh", help="resume bounded acquisition of year/family-labelled HTML report links")
    html_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    html_parser.add_argument("--edition-root", type=Path, default=EDITION_ROOT)
    html_parser.add_argument("--batch-size", type=int, default=24)
    html_parser.add_argument("--priority-url", action="append", default=[])
    html_parser.add_argument("--retry-url", action="append", default=[])
    html_parser.add_argument("--recheck-after-days", type=int, default=7)
    html_replay_parser = sub.add_parser("html-replay", help="verify archived HTML source objects and extracted text")
    html_replay_parser.add_argument("run_id")
    html_replay_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    html_reassess_parser = sub.add_parser("html-reassess", help="re-extract selected archived HTML targets without network access")
    html_reassess_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    reassess_group=html_reassess_parser.add_mutually_exclusive_group(required=True)
    reassess_group.add_argument("--target-url", action="append")
    reassess_group.add_argument("--unreadable-host", help="reassess all unreadable archived HTML targets on this exact host")
    audit_parser = sub.add_parser("html-audit", help="replay all batches and reproduce cumulative coverage for current inventory")
    audit_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    audit_parser.add_argument("--edition-root", type=Path, default=EDITION_ROOT)
    audit_parser.add_argument("--source-sha256", help="pin audit to an archived source inventory hash")
    backfill_parser = sub.add_parser("html-backfill", help="sequentially drain HTML candidates while preserving disk headroom")
    backfill_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    backfill_parser.add_argument("--edition-root", type=Path, default=EDITION_ROOT)
    backfill_parser.add_argument("--batch-size", type=int, default=24)
    backfill_parser.add_argument("--minimum-free-bytes", type=int, default=3 * 1024 * 1024 * 1024)
    backfill_parser.add_argument("--max-batches", type=int)
    backfill_parser.add_argument("--recheck-after-days", type=int, default=7)
    args = parser.parse_args(argv)
    try:
        if args.command == "refresh":
            result = refresh(args.root, args.edition_root, args.workers, args.max_archive_bytes)
        elif args.command == "replay":
            result = replay(args.run_id, args.root)
        elif args.command == "html-refresh":
            result = html_refresh(args.root, args.edition_root, args.batch_size, args.priority_url, retry_urls=args.retry_url,
                                  recheck_after_days=args.recheck_after_days)
        elif args.command == "html-backfill":
            reports = html_backfill(args.root,args.edition_root,args.batch_size,args.minimum_free_bytes,args.max_batches,
                                    recheck_after_days=args.recheck_after_days)
            result = reports[-1] if reports else {"runId":None,"status":"complete","candidateCitations":0,"candidateTargets":0,"processedTargets":0,"remainingPending":0,"targetStatusCounts":{}}
        elif args.command == "html-audit":
            result = html_audit(args.root,args.edition_root,args.source_sha256)
        elif args.command == "html-reassess":
            result = html_reassess(args.target_url,args.root,args.unreadable_host)
        else:
            result = html_replay(args.run_id, args.root)
        if args.command in {"refresh", "html-refresh", "html-backfill"}:
            print(json.dumps({"runId": result["runId"], "status": result["status"], "summary": result["summary"],
                              "report": str((args.root / ("generations" if args.command == "refresh" else "html-generations") / f"{result['runId']}.json").relative_to(ROOT))} if args.command == "refresh" else
                             {"runId": result["runId"], "status": result["status"], "candidateCitations": result["candidateCitations"], "candidateTargets": result["candidateTargets"], "processedTargets": result["processedTargets"], "remainingPending": result["remainingPending"], "targetStatusCounts": result["targetStatusCounts"], "report": str((args.root / "html-generations" / f"{result['runId']}.json").relative_to(ROOT))}, ensure_ascii=False, sort_keys=True))
        else:
            if args.command == "replay":
                output = {"runId": result["runId"], "status": result["status"], "summary": result["summary"]}
            elif args.command == "html-audit":
                output = result
            else:
                output = {"runId": result["runId"], "status": result["status"],
                          "candidateCitations": result["candidateCitations"],
                          "candidateTargets": result["candidateTargets"],
                          "processedTargets": result["processedTargets"],
                          "remainingPending": result["remainingPending"]}
            print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        return 0 if result["status"] == "complete" else (2 if args.command in {"refresh", "html-refresh", "html-backfill"} else 0)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"departmental-report-documents: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
