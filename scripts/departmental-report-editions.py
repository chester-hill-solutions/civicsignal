#!/usr/bin/env python3
"""Index year-labelled departmental plan/results report links from issuer pages."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import gzip
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote, unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib import committee_files  # noqa: E402

DIRECTORIES_ROOT = ROOT / "data/corpus/federal-report-directories"
DIRECTORIES_RECEIPT = DIRECTORIES_ROOT / "dist/receipt.json"
DEFAULT_ROOT = ROOT / "data/corpus/departmental-report-editions"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 192 * 1024 * 1024
MIN_FREE_BYTES = 512 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_WORKERS = 4
USER_AGENT = "CivicSignal local departmental report edition index/1.0"
FAMILIES = ("departmental-plans", "departmental-results")
REGULATORY_FAMILY = "regulatory-plans"

YEAR_RE = re.compile(r"(?<!\d)(20\d{2})(?:\s*(?:[-–—]|to|à|/|\bde\b)\s*(20\d{2}|\d{2}))?(?!\d)", re.I)
PLAN_TERMS = {
    "en": ("departmental plan", "plans and priorities", "report on plans", "reports on plans"),
    "fr": ("plan ministériel", "plans ministériels", "plan et priorités", "plans et priorités",
           "rapport sur les plans", "rapports sur les plans"),
}
RESULT_TERMS = {
    "en": ("departmental results report", "departmental performance report", "departmental results",
           "departmental performance", "results report", "performance report"),
    "fr": ("rapport sur les résultats ministériels", "rapports sur les résultats ministériels",
           "rapport ministériel sur le rendement", "rapports ministériels sur le rendement",
           "rapport ministériel de rendement", "rapports ministériels de rendement",
           "rapport sur les résultats", "rapports sur les résultats"),
}
REGULATORY_TERMS = {
    "en": ("forward regulatory plan", "forward plan", "regulatory stock review plan", "stock review plan"),
    "fr": ("plan prospectif de la réglementation", "plan prospectif de reglementation",
           "plan de réglementation", "plan de reglementation", "examen de la réglementation",
           "examen de la reglementation"),
}
DIRECT_EXTENSIONS = {".pdf", ".doc", ".docx", ".odt", ".rtf", ".xlsx", ".xls"}
HTML_TYPES = {"text/html", "application/xhtml+xml"}
PUBLISHER_LISTED_HOSTS = {
    "www.atlanticpilotage.com", "atlanticpilotage.com",
    "www.pilotagedelatlantique.com", "pilotagedelatlantique.com",
    "cdc-ccl.ca", "www.cdc-ccl.ca",
}
PUBLISHER_INTERMEDIATE_HOSTS = frozenset({
    "housing-infrastructure.canada.ca", "logement-infrastructure.canada.ca",
    "www.clo-ocol.gc.ca", "www.crcc-ccetp.gc.ca",
})
PUBLISHER_HTTPS = "/usr/local/bin/civicsignal-publisher-https"

# These are exact legacy URLs present in the checksum-verified publisher
# directories. The replacement targets were confirmed on the issuer's own
# current English/French pages and language switch, or on the issuer's current
# Canada.ca Acts and Regulations page. Keep the original published URL as the
# primary identity; this only changes the request target for these exact rows.
PUBLISHER_PAGE_RECOVERIES = {
    "https://www.cnsc-ccsn.gc.ca/eng/resources/publications/reports/rpp/": {
        "family": "departmental-plans", "language": "en",
        "resolvedUrl": "https://www.cnsc-ccsn.gc.ca/eng/corporate/plans-results/rpp/",
        "evidenceUrls": [
            "https://www.cnsc-ccsn.gc.ca/eng/corporate/plans-results/rpp/",
            "https://www.cnsc-ccsn.gc.ca/fra/corporate/plans-results/rpp/",
        ],
        "method": "publisher-current-bilingual-plans-pages",
        "validation": "English and French pages are titled Departmental plans / Plans ministériels and list current departmental plans.",
    },
    "https://www.canada.ca/en/farm-products-council/corporate/acts-and-regulations.html": {
        "family": REGULATORY_FAMILY, "language": "en",
        "resolvedUrl": "https://www.canada.ca/en/farm-products-council/services/acts-and-regulations.html",
        "evidenceUrls": [
            "https://www.canada.ca/en/farm-products-council/services/acts-and-regulations.html",
            "https://www.canada.ca/en/farm-products-council/services/acts-and-regulations/forward-regulatory-plan-farm-products-council-of-canada.html",
            "https://www.canada.ca/fr/conseil-produits-agricoles/services/lois-et-reglements/plan-prospectif-de-la-reglementation-conseil-des-produits-agricoles-du-canada.html",
        ],
        "method": "publisher-current-bilingual-acts-regulations-directory",
        "validation": "The current Canada.ca FPCC Acts and Regulations page links to the Forward Regulatory Plan; the plan has an official French-language page.",
    },
    "https://www.canada.ca/fr/conseil-produits-agricoles/entreprise/lois-et-reglements.html": {
        "family": REGULATORY_FAMILY, "language": "fr",
        "resolvedUrl": "https://www.canada.ca/fr/conseil-produits-agricoles/services/lois-et-reglements.html",
        "evidenceUrls": [
            "https://www.canada.ca/fr/conseil-produits-agricoles/services/lois-et-reglements.html",
            "https://www.canada.ca/fr/conseil-produits-agricoles/services/lois-et-reglements/plan-prospectif-de-la-reglementation-conseil-des-produits-agricoles-du-canada.html",
            "https://www.canada.ca/en/farm-products-council/services/acts-and-regulations/forward-regulatory-plan-farm-products-council-of-canada.html",
        ],
        "method": "publisher-current-bilingual-acts-regulations-directory",
        "validation": "The current Canada.ca FPCC Acts and Regulations page links to the Forward Regulatory Plan; the plan has an official English-language page.",
    },
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normalized(value: str) -> str:
    return " ".join((value or "").casefold().replace("’", "'").split())


def year_label(value: str) -> str | None:
    match = YEAR_RE.search(value or "")
    if not match:
        return None
    first, second = match.groups()
    if not second:
        return first
    end = second if len(second) == 4 else first[:2] + second
    return f"{first}-{end}"


def acquisition_url(url: str) -> str | None:
    """Return an allowed request URL; upgrade only publisher-listed HTTP .gc.ca URLs."""
    parsed = urlsplit(url)
    if parsed.scheme == "http" and (parsed.hostname or "").endswith(".gc.ca"):
        candidate = parsed._replace(scheme="https").geturl()
    else:
        candidate = url
    host = urlsplit(candidate).hostname or ""
    if committee_files.official(candidate) or (urlsplit(candidate).scheme == "https" and host in PUBLISHER_LISTED_HOSTS
                                                and not urlsplit(candidate).username and not urlsplit(candidate).password):
        return candidate
    return None


def acquisition_official(url: str) -> bool:
    return acquisition_url(url) == url


class ReportPageParser(HTMLParser):
    """Collect page title, headings, and links with the active heading context."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.page_title_parts: list[str] = []
        self.page_title = ""
        self.headings: list[str] = []
        self.h1s: list[str] = []
        self.links: list[dict] = []
        self._title_depth = 0
        self._heading: dict | None = None
        self._anchor: dict | None = None
        self._current_heading = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self._title_depth += 1
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading = {"tag": tag, "parts": []}
        if tag == "a" and attrs.get("href"):
            self._anchor = {"url": urljoin(self.base_url, attrs["href"]), "parts": [],
                            "title": attrs.get("title") or attrs.get("aria-label") or ""}

    def handle_data(self, data):
        if self._title_depth:
            self.page_title_parts.append(data)
        if self._heading is not None:
            self._heading["parts"].append(data)
        if self._anchor is not None:
            self._anchor["parts"].append(data)

    def handle_endtag(self, tag):
        if tag == "title" and self._title_depth:
            self._title_depth -= 1
            if not self._title_depth:
                self.page_title = " ".join("".join(self.page_title_parts).split())
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._heading is not None:
            heading = " ".join("".join(self._heading["parts"]).split())
            if heading:
                self.headings.append(heading)
                if self._heading["tag"] == "h1":
                    self.h1s.append(heading)
                self._current_heading = heading
            self._heading = None
        if tag == "a" and self._anchor is not None:
            label = " ".join("".join(self._anchor["parts"]).split())
            title = " ".join(self._anchor["title"].split())
            url = self._anchor["url"]
            if urlsplit(url).scheme == "https":
                self.links.append({"label": label, "title": title, "url": url,
                                   "heading": self._current_heading})
            self._anchor = None


def _family_terms(family: str, language: str) -> tuple[str, ...]:
    return PLAN_TERMS[language] if family == "departmental-plans" else RESULT_TERMS[language]


def _has_family(value: str, family: str, language: str) -> bool:
    text = normalized(value)
    return any(normalized(term) in text for term in _family_terms(family, language))


def _conflicts_family(value: str, family: str, language: str) -> bool:
    other = "departmental-results" if family == "departmental-plans" else "departmental-plans"
    return _has_family(value, other, language)


def _is_family_year(value: str, family: str, language: str) -> bool:
    return bool(year_label(value)) and _has_family(value, family, language) and not _conflicts_family(value, family, language)


def _has_regulatory_context(value: str, language: str) -> bool:
    text = normalized(value)
    return any(normalized(term) in text for term in REGULATORY_TERMS[language])


def extract_regulatory_links(body: bytes, final_url: str, language: str) -> dict:
    parser = ReportPageParser(final_url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    links = []
    for item in parser.links:
        label = item["label"] or item["title"]
        combined = " ".join((label, item["heading"]))
        conflicts_departmental = _has_family(label, "departmental-plans", language) or _has_family(label, "departmental-results", language)
        if _has_regulatory_context(combined, language) and not conflicts_departmental:
            extension = Path(urlsplit(item["url"]).path).suffix.casefold()
            links.append({"linkType": "labelled-document-link" if extension in DIRECT_EXTENSIONS else "index-link",
                          "label": label, "heading": item["heading"], "url": item["url"],
                          "evidence": "publisher-label-or-heading-regulatory-context"})
    unique = {(item["linkType"], item["label"], item["url"]): item for item in links}
    return {"pageTitle": parser.page_title, "headings": parser.headings, "reportLinks": [],
            "discoveryLinks": sorted(unique.values(), key=lambda item: (item["label"], item["url"])),
            "ambiguousYearLinks": []}


def document_page_record(parser: ReportPageParser, final_url: str, family: str, language: str) -> dict | None:
    candidates = [parser.page_title, *parser.h1s]
    for title in candidates:
        if _is_family_year(title, family, language):
            return {"linkType": "direct-edition", "label": title, "heading": title,
                    "yearLabel": year_label(title), "url": final_url,
                    "evidence": "document-page-title-or-heading"}
    return None


def extract_report_links(body: bytes, final_url: str, family: str, language: str) -> dict:
    parser = ReportPageParser(final_url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    direct = document_page_record(parser, final_url, family, language)
    report_links = []
    ambiguous = []
    if direct:
        report_links.append(direct)
    for item in parser.links:
        label = item["label"] or item["title"]
        year = year_label(label)
        if not year:
            continue
        label_has_family = _has_family(label, family, language)
        heading_has_family = _has_family(item["heading"], family, language)
        family_conflict = _conflicts_family(label, family, language) or _conflicts_family(item["heading"], family, language)
        if family_conflict or not (label_has_family or heading_has_family):
            ambiguous.append({"label": label, "heading": item["heading"], "url": item["url"],
                              "reason": "year-label-without-matching-family-context"})
            continue
        if item["url"] == final_url and direct:
            continue
        extension = Path(urlsplit(item["url"]).path).suffix.casefold()
        link_type = "direct-edition" if extension in DIRECT_EXTENSIONS else "index-link"
        report_links.append({"linkType": link_type, "label": label, "heading": item["heading"],
                             "yearLabel": year, "url": item["url"],
                             "evidence": "family-and-year-in-link-label" if label_has_family
                                        else "family-heading-and-year-link-label"})
    unique = {}
    for row in report_links:
        unique[(row["linkType"], row["label"], row["url"])] = row
    return {"pageTitle": parser.page_title, "headings": parser.headings,
            "reportLinks": sorted(unique.values(), key=lambda row: (row["yearLabel"], row["linkType"], row["url"])),
            "ambiguousYearLinks": ambiguous}


class FetchError(Exception):
    def __init__(self, detail: str, http_status: int | None = None, bytes_read: int = 0):
        super().__init__(detail)
        self.http_status = http_status
        self.bytes_read = bytes_read


def _fetch_page_once(url: str, max_bytes: int = MAX_PAGE_BYTES) -> tuple[bytes, str, str, int]:
    """Fetch one official HTTPS page with checked redirects and a hard size bound."""
    class CheckedRedirect(urllib.request.HTTPRedirectHandler):
        def __init__(self):
            super().__init__()
            self.redirects = 0

        def redirect_request(self, request, response, code, message, headers, new_url):
            self.redirects += 1
            checked_url = urljoin(request.full_url, new_url)
            if self.redirects > MAX_REDIRECTS or not acquisition_official(checked_url):
                raise FetchError("redirect outside official HTTPS hosts or exceeds redirect limit", code)
            return super().redirect_request(request, response, code, message, headers, checked_url)

    if not acquisition_official(url):
        raise FetchError("URL is outside official HTTPS hosts")
    if urlsplit(url).hostname in PUBLISHER_INTERMEDIATE_HOSTS and os.path.isfile(PUBLISHER_HTTPS):
        return _fetch_with_platform_curl(url, max_bytes)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.1"})
    opener = urllib.request.build_opener(CheckedRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            final_url = response.geturl()
            if not acquisition_official(final_url):
                raise FetchError("final URL is outside official HTTPS hosts")
            raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise FetchError("response exceeded per-page byte limit", bytes_read=len(raw))
            status = getattr(response, "status", 200)
            if status != 200:
                raise FetchError("HTTP " + str(status), status, len(raw))
            media = response.headers.get_content_type().casefold()
    except urllib.error.HTTPError as error:
        raise FetchError("HTTP " + str(error.code), error.code) from error
    except ssl.SSLCertVerificationError as error:
        return _fetch_with_platform_curl(url, max_bytes, error)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            return _fetch_with_platform_curl(url, max_bytes, error.reason)
        raise FetchError(str(error.reason)[:1000]) from error
    except (TimeoutError, OSError, urllib.error.URLError) as error:
        detail = str(error.reason) if isinstance(error, urllib.error.URLError) else str(error)
        raise FetchError(detail[:1000]) from error
    if media not in HTML_TYPES and media != "application/pdf":
        raise FetchError("unexpected media type: " + media, bytes_read=len(raw))
    return raw, media, final_url, len(raw)


def fetch_page(url: str, max_bytes: int = MAX_PAGE_BYTES) -> tuple[bytes, str, str, int]:
    """Retry one transient transport failure without retrying publisher responses."""
    try:
        return _fetch_page_once(url, max_bytes)
    except FetchError as error:
        detail = str(error).casefold()
        transient = error.http_status is None and any(marker in detail for marker in (
            "timed out", "timeout", "connection reset", "connection aborted",
            "remote end closed", "temporary failure", "temporarily unavailable"))
        if not transient:
            raise
    time.sleep(0.25)
    return _fetch_page_once(url, max_bytes)


def _fetch_with_platform_curl(url: str, max_bytes: int, original_error: Exception | None = None) -> tuple[bytes, str, str, int]:
    """Fetch with curl, checking each redirect and bounding the response body."""
    current = url
    with tempfile.TemporaryDirectory(prefix="departmental-report-curl-") as temp_dir:
        body_path = Path(temp_dir) / "source"
        for _ in range(MAX_REDIRECTS + 1):
            if not acquisition_official(current):
                raise FetchError("URL or redirect is outside official HTTPS hosts") from original_error
            target = quote(current, safe=":/?#[]@!$&'()*+,;=%")
            accept = "Accept: text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.1"
            if urlsplit(current).hostname in PUBLISHER_INTERMEDIATE_HOSTS and os.path.isfile(PUBLISHER_HTTPS):
                command = [PUBLISHER_HTTPS, target, str(body_path), str(max_bytes), USER_AGENT, accept]
            else:
                command = ["curl", "--silent", "--show-error", "--globoff", "--proto", "=https",
                           "--max-redirs", "0", "--max-time", "30", "--connect-timeout", "10",
                           "--max-filesize", str(max_bytes), "--user-agent", USER_AGENT, "--header", accept,
                           "--output", str(body_path), "--write-out", "%{http_code}\n%{content_type}\n%{redirect_url}", target]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode and result.returncode != 22:
                detail = "response exceeded per-page byte limit" if result.returncode == 63 else (result.stderr.strip() or f"curl exit {result.returncode}")
                raise FetchError(detail[:1000], bytes_read=body_path.stat().st_size if body_path.exists() else 0) from original_error
            parts = result.stdout.split("\n", 2)
            if len(parts) != 3:
                raise FetchError("curl returned malformed response metadata") from original_error
            status, content_type, redirect = parts
            if status in {"301", "302", "303", "307", "308"} and redirect:
                current = urljoin(current, redirect)
                continue
            if status != "200":
                raise FetchError("HTTP " + status, int(status) if status.isdigit() else None) from original_error
            raw = body_path.read_bytes()
            media = content_type.partition(";")[0].strip().casefold()
            if len(raw) > max_bytes:
                raise FetchError("response exceeded per-page byte limit", bytes_read=len(raw)) from original_error
            if media not in HTML_TYPES and media != "application/pdf":
                raise FetchError("unexpected media type: " + media, bytes_read=len(raw)) from original_error
            return raw, media, current, len(raw)
    raise FetchError("too many redirects") from original_error


class ArchiveBudget:
    def __init__(self, maximum: int):
        self.maximum = maximum
        self.used = 0
        self.reserved = 0
        self.lock = threading.Lock()

    def reserve_page(self) -> bool:
        with self.lock:
            if self.used + self.reserved + MAX_PAGE_BYTES > self.maximum:
                return False
            self.reserved += MAX_PAGE_BYTES
            return True

    def settle_page(self, actual: int) -> None:
        with self.lock:
            self.reserved -= MAX_PAGE_BYTES
            self.used += actual


def archive_body(root: Path, body: bytes) -> tuple[str, str]:
    digest = hashlib.sha256(body).hexdigest()
    path = root / "objects" / digest[:2] / (digest + ".source.gz")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd, temp_name = tempfile.mkstemp(prefix=".report-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as zipped:
                    zipped.write(body)
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return digest, str(path.relative_to(root))


def read_archive(path: Path, expected_sha: str, expected_bytes: int) -> bytes:
    with gzip.open(path, "rb") as source:
        body = source.read(MAX_PAGE_BYTES + 1)
    if len(body) > MAX_PAGE_BYTES or len(body) != expected_bytes or hashlib.sha256(body).hexdigest() != expected_sha:
        raise ValueError("Archived issuer page failed byte length or SHA-256 verification")
    return body


def db_open(root: Path = DEFAULT_ROOT, read_only: bool = False) -> sqlite3.Connection:
    if not read_only:
        root.mkdir(parents=True, exist_ok=True)
    db_path = root / "editions.sqlite"
    if read_only and not db_path.is_file():
        raise FileNotFoundError(db_path)
    db = sqlite3.connect(f"file:{db_path.resolve()}?mode=ro" if read_only else db_path, timeout=30, uri=read_only)
    db.row_factory = sqlite3.Row
    if read_only:
        return db
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS generations(
        run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
        status TEXT NOT NULL, source_receipt_path TEXT NOT NULL, source_inventory_path TEXT NOT NULL,
        source_inventory_sha256 TEXT NOT NULL, expected_pages INTEGER NOT NULL,
        fetched_pages INTEGER NOT NULL DEFAULT 0, failed_pages INTEGER NOT NULL DEFAULT 0,
        direct_editions INTEGER NOT NULL DEFAULT 0, index_links INTEGER NOT NULL DEFAULT 0,
        gap_count INTEGER NOT NULL DEFAULT 0, archive_bytes INTEGER NOT NULL DEFAULT 0,
        report_path TEXT, report_sha256 TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS issuer_pages(
        run_id TEXT NOT NULL, family TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
        issuer_attribution TEXT, language TEXT NOT NULL, published_url TEXT NOT NULL,
        source_index_url TEXT NOT NULL, source_index_sha256 TEXT NOT NULL,
        status TEXT NOT NULL, final_url TEXT, fetched_at TEXT, http_status INTEGER,
        media_type TEXT, body_sha256 TEXT, body_bytes INTEGER, object_path TEXT, detail TEXT,
        page_title TEXT, fetch_url TEXT, recovery_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(run_id,family,language,published_url),
        FOREIGN KEY(run_id) REFERENCES generations(run_id));
      CREATE TABLE IF NOT EXISTS report_links(
        run_id TEXT NOT NULL, family TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
        language TEXT NOT NULL, landing_url TEXT NOT NULL, landing_sha256 TEXT NOT NULL,
        ordinal INTEGER NOT NULL, link_type TEXT NOT NULL, label TEXT NOT NULL, heading TEXT,
        year_label TEXT NOT NULL, url TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY(run_id,family,language,landing_url,ordinal),
        FOREIGN KEY(run_id) REFERENCES generations(run_id));
      CREATE TABLE IF NOT EXISTS discovery_links(
        run_id TEXT NOT NULL, family TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
        language TEXT NOT NULL, landing_url TEXT NOT NULL, landing_sha256 TEXT NOT NULL,
        ordinal INTEGER NOT NULL, link_type TEXT NOT NULL, label TEXT NOT NULL, heading TEXT,
        url TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY(run_id,family,language,landing_url,ordinal),
        FOREIGN KEY(run_id) REFERENCES generations(run_id));
      CREATE TABLE IF NOT EXISTS gaps(
        run_id TEXT NOT NULL, family TEXT NOT NULL, issuer_key TEXT, issuer_label TEXT NOT NULL,
        language TEXT NOT NULL, landing_url TEXT NOT NULL, issue_type TEXT NOT NULL,
        code TEXT NOT NULL, detail TEXT,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(run_id,family,language,landing_url,issue_type,code),
        FOREIGN KEY(run_id) REFERENCES generations(run_id));
      CREATE TABLE IF NOT EXISTS attempts(
        attempt_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, landing_url TEXT NOT NULL,
        attempted_at TEXT NOT NULL, outcome TEXT NOT NULL, http_status INTEGER, detail TEXT,
        FOREIGN KEY(run_id) REFERENCES generations(run_id));
      CREATE TABLE IF NOT EXISTS issuer_page_current(
        family TEXT NOT NULL, language TEXT NOT NULL, published_url TEXT NOT NULL,
        verified_run_id TEXT, verified_at TEXT, last_attempt_run_id TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL, last_attempt_status TEXT NOT NULL,
        last_attempt_http_status INTEGER, last_attempt_detail TEXT,
        PRIMARY KEY(family,language,published_url));
    """)
    issuer_columns = {row[1] for row in db.execute("PRAGMA table_info(issuer_pages)")}
    if "fetch_url" not in issuer_columns:
        db.execute("ALTER TABLE issuer_pages ADD COLUMN fetch_url TEXT")
    if "recovery_json" not in issuer_columns:
        db.execute("ALTER TABLE issuer_pages ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}'")
    db.execute("""INSERT OR IGNORE INTO issuer_page_current
      SELECT p.family,p.language,p.published_url,
        (SELECT good.run_id FROM issuer_pages good JOIN generations gg ON gg.run_id=good.run_id
         WHERE good.family=p.family AND good.language=p.language AND good.published_url=p.published_url
           AND good.status='fetched' ORDER BY gg.started_at DESC LIMIT 1),
        (SELECT good.fetched_at FROM issuer_pages good JOIN generations gg ON gg.run_id=good.run_id
         WHERE good.family=p.family AND good.language=p.language AND good.published_url=p.published_url
           AND good.status='fetched' ORDER BY gg.started_at DESC LIMIT 1),
        (SELECT last.run_id FROM issuer_pages last JOIN generations gl ON gl.run_id=last.run_id
         WHERE last.family=p.family AND last.language=p.language AND last.published_url=p.published_url
         ORDER BY gl.started_at DESC LIMIT 1),
        (SELECT last.fetched_at FROM issuer_pages last JOIN generations gl ON gl.run_id=last.run_id
         WHERE last.family=p.family AND last.language=p.language AND last.published_url=p.published_url
         ORDER BY gl.started_at DESC LIMIT 1),
        (SELECT last.status FROM issuer_pages last JOIN generations gl ON gl.run_id=last.run_id
         WHERE last.family=p.family AND last.language=p.language AND last.published_url=p.published_url
         ORDER BY gl.started_at DESC LIMIT 1),
        (SELECT last.http_status FROM issuer_pages last JOIN generations gl ON gl.run_id=last.run_id
         WHERE last.family=p.family AND last.language=p.language AND last.published_url=p.published_url
         ORDER BY gl.started_at DESC LIMIT 1),
        (SELECT last.detail FROM issuer_pages last JOIN generations gl ON gl.run_id=last.run_id
         WHERE last.family=p.family AND last.language=p.language AND last.published_url=p.published_url
         ORDER BY gl.started_at DESC LIMIT 1)
      FROM issuer_pages p""")
    db.commit()
    return db


def _safe_repo_file(value: str) -> Path:
    candidate = (ROOT / value).resolve()
    if candidate != ROOT and ROOT not in candidate.parents:
        raise ValueError("Inventory references a path outside the repository")
    return candidate


def load_verified_inventory(receipt_path: Path = DIRECTORIES_RECEIPT) -> tuple[dict, dict]:
    receipt_path = receipt_path.resolve()
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("collection") != "federal-report-directories":
        raise ValueError("Receipt is not a federal report directory inventory")
    inventory_path = _safe_repo_file(receipt.get("inventoryPath", ""))
    raw = inventory_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != receipt.get("inventorySha256"):
        raise ValueError("Federal report directory inventory checksum mismatch")
    inventory = json.loads(raw)
    if inventory.get("collection") != "federal-report-directories" or inventory.get("sourceRegisterSha256") != receipt.get("sourceRegisterSha256"):
        raise ValueError("Federal report inventory and receipt identity disagree")
    for key, source in inventory.get("sourceArchives", {}).items():
        if not committee_files.official(source.get("finalUrl") or source.get("url", "")):
            raise ValueError(f"Source directory archive is not official: {key}")
        object_path = Path(source.get("archive", "")).resolve()
        if object_path != ROOT and ROOT not in object_path.parents:
            raise ValueError("Directory source archive escapes repository")
        with gzip.open(object_path, "rb") as archived:
            data = archived.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) != source["bytes"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
            raise ValueError(f"Source directory archive checksum mismatch: {key}")
    for family in FAMILIES:
        if family not in inventory.get("families", {}):
            raise ValueError(f"Verified inventory lacks {family}")
    return receipt, inventory


def source_pages(inventory: dict) -> list[dict]:
    pages = {}
    for family in FAMILIES:
        issuers = inventory["families"][family].get("issuers", [])
        for group in issuers:
            for edition in group.get("editions", []):
                language = edition.get("language")
                url = edition.get("url")
                if language not in ("en", "fr") or not url or not committee_files.official(url):
                    raise ValueError("Issuer page link is missing a language or official HTTPS URL")
                source_url = edition.get("sourceIndexUrl")
                source_hash = edition.get("sourceIndexSha256")
                archived = inventory.get("sourceArchives", {}).get(f"{family}-{language}")
                if not archived or source_url != archived["url"] or source_hash != archived["sha256"]:
                    raise ValueError("Issuer page link is not tied to its checksum-verified family directory")
                key = (family, edition.get("issuerKey") or "", language, url)
                page = pages.setdefault(key, {"family": family, "issuerKey": edition.get("issuerKey"),
                    "issuerLabel": edition["issuerLabel"], "issuerAttribution": edition.get("issuerAttribution"),
                    "language": language, "url": url, "fetchUrl": url, "sourceIndexUrl": source_url,
                    "sourceIndexSha256": source_hash})
                recovery = PUBLISHER_PAGE_RECOVERIES.get(url)
                if recovery:
                    if recovery["family"] != family or recovery["language"] != language:
                        raise ValueError("Publisher recovery does not match its registered family/language")
                    if not committee_files.official(recovery["resolvedUrl"]) or any(
                            not committee_files.official(item) for item in recovery["evidenceUrls"]):
                        raise ValueError("Publisher recovery target/evidence must remain on official HTTPS hosts")
                    page["fetchUrl"] = recovery["resolvedUrl"]
                    page["publisherRecovery"] = {"originalUrl": url, **recovery}
                if page["issuerLabel"] != edition["issuerLabel"]:
                    page["alternateIssuerLabels"] = sorted(set(page.get("alternateIssuerLabels", []) + [edition["issuerLabel"]]))
    for edition in inventory.get("families", {}).get(REGULATORY_FAMILY, {}).get("institutionDirectoryLinks", []):
        language = edition.get("language")
        archived = inventory.get("sourceArchives", {}).get(f"regulatory-directories-{language}")
        if language not in ("en", "fr") or not archived or edition.get("sourceIndexUrl") != archived["url"] or edition.get("sourceIndexSha256") != archived["sha256"]:
            raise ValueError("Regulatory issuer link is not tied to its checksum-verified directory")
        issuer = edition.get("issuerLabel") or "Unlabelled issuer"
        url = edition.get("url") or "missing:" + issuer
        fetch_url = acquisition_url(url)
        key = (REGULATORY_FAMILY, issuer, language, url)
        page = {"family": REGULATORY_FAMILY, "issuerKey": issuer, "issuerLabel": issuer,
                "issuerAttribution": issuer, "language": language, "url": url,
                "sourceIndexUrl": archived["url"], "sourceIndexSha256": archived["sha256"]}
        if not edition.get("url"):
            page["preflightGap"] = "Publisher-listed issuer URL is missing"
        elif not fetch_url:
            page["preflightGap"] = "Publisher-listed issuer URL is outside official HTTPS acquisition policy"
        else:
            page["fetchUrl"] = fetch_url
        recovery = PUBLISHER_PAGE_RECOVERIES.get(url)
        if recovery:
            if recovery["family"] != REGULATORY_FAMILY or recovery["language"] != language:
                raise ValueError("Publisher recovery does not match its registered family/language")
            if not committee_files.official(recovery["resolvedUrl"]) or any(
                    not committee_files.official(item) for item in recovery["evidenceUrls"]):
                raise ValueError("Publisher recovery target/evidence must remain on official HTTPS hosts")
            page["fetchUrl"] = recovery["resolvedUrl"]
            page["publisherRecovery"] = {"originalUrl": url, **recovery}
        pages[key] = page
    return sorted(pages.values(), key=lambda page: (page["family"], page["language"], page.get("issuerKey") or "", page["url"]))


def _fetch_budgeted(url: str, budget: ArchiveBudget, fetcher):
    if not budget.reserve_page():
        return {"status": "failed", "detail": "run archive byte budget exhausted", "http_status": None,
                "body": None, "media_type": None, "final_url": None, "bytes": 0}
    try:
        body, media, final_url, size = fetcher(url, MAX_PAGE_BYTES)
        if size > MAX_PAGE_BYTES or len(body) != size:
            raise FetchError("fetcher returned a body outside the per-page limit", bytes_read=len(body))
        budget.settle_page(size)
        return {"status": "fetched", "body": body, "media_type": media, "final_url": final_url,
                "bytes": size, "detail": None, "http_status": 200}
    except FetchError as error:
        budget.settle_page(0)
        return {"status": "failed", "detail": str(error)[:1000], "http_status": error.http_status,
                "body": None, "media_type": None, "final_url": None, "bytes": 0}
    except Exception as error:
        budget.settle_page(0)
        return {"status": "failed", "detail": (str(error) or type(error).__name__)[:1000],
                "http_status": None, "body": None, "media_type": None, "final_url": None, "bytes": 0}


def _family_file_record(url: str, media_type: str, family: str, language: str) -> dict | None:
    name = unquote(Path(urlsplit(url).path).name).replace("_", " ").replace("-", " ")
    if media_type == "application/pdf" or Path(urlsplit(url).path).suffix.casefold() in DIRECT_EXTENSIONS:
        year = year_label(name)
        if year and _has_family(name, family, language) and not _conflicts_family(name, family, language):
            return {"linkType": "direct-edition", "label": name, "heading": None, "yearLabel": year,
                    "url": url, "evidence": "document-page-filename-family-and-year"}
    return None


def _parse_page(body: bytes, final_url: str, media: str, family: str, language: str) -> dict:
    if family == REGULATORY_FAMILY and media in HTML_TYPES:
        return extract_regulatory_links(body, final_url, language)
    if media in HTML_TYPES:
        return extract_report_links(body, final_url, family, language)
    direct = _family_file_record(final_url, media, family, language)
    return {"pageTitle": Path(urlsplit(final_url).path).name, "headings": [],
            "reportLinks": [direct] if direct else [], "ambiguousYearLinks": []}


def _start_generation(db, run_id: str, receipt_path: Path, source_receipt: dict, inventory: dict, pages: list[dict]):
    with db:
        db.execute("INSERT INTO generations(run_id,started_at,status,source_receipt_path,source_inventory_path,source_inventory_sha256,expected_pages) VALUES(?,?,?,?,?,?,?)",
                   (run_id, dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds"), "running", str(receipt_path.relative_to(ROOT)), source_receipt["inventoryPath"],
                    source_receipt["inventorySha256"], len(pages)))
        for page in pages:
            recovery = page.get("publisherRecovery")
            db.execute("INSERT INTO issuer_pages(run_id,family,issuer_key,issuer_label,issuer_attribution,language,published_url,source_index_url,source_index_sha256,status,recovery_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (run_id, page["family"], page.get("issuerKey"), page["issuerLabel"], page.get("issuerAttribution"),
                        page["language"], page["url"], page["sourceIndexUrl"], page["sourceIndexSha256"], "pending",
                        json.dumps(recovery, ensure_ascii=False, sort_keys=True) if recovery else "{}"))


def _record_result(db, root: Path, run_id: str, page: dict, fetched: dict, extraction: dict | None, attempted_at: str):
    family, language, url = page["family"], page["language"], page["url"]
    if page.get("preflightGap"):
        detail = page["preflightGap"]
        with db:
            db.execute("UPDATE issuer_pages SET status='skipped',fetched_at=?,detail=? WHERE run_id=? AND family=? AND language=? AND published_url=?",
                       (attempted_at, detail, run_id, family, language, url))
            db.execute("INSERT INTO gaps(run_id,family,issuer_key,issuer_label,language,landing_url,issue_type,code,detail,candidates_json) VALUES(?,?,?,?,?,?,'edition-gap','publisher-link-out-of-policy',?,'[]')",
                       (run_id, family, page.get("issuerKey"), page["issuerLabel"], language, url, detail))
            db.execute("INSERT INTO attempts(run_id,landing_url,attempted_at,outcome,detail) VALUES(?,?,?,?,?)",
                       (run_id, url, attempted_at, "skipped", detail))
            db.execute("INSERT INTO issuer_page_current VALUES(?,?,?,NULL,NULL,?,?,?,?,?) ON CONFLICT(family,language,published_url) DO UPDATE SET last_attempt_run_id=excluded.last_attempt_run_id,last_attempt_at=excluded.last_attempt_at,last_attempt_status=excluded.last_attempt_status,last_attempt_detail=excluded.last_attempt_detail WHERE (SELECT started_at FROM generations WHERE run_id=excluded.last_attempt_run_id) >= (SELECT started_at FROM generations WHERE run_id=issuer_page_current.last_attempt_run_id)",
                       (family, language, url, run_id, attempted_at, "skipped", None, detail))
        return
    if fetched["status"] == "fetched":
        digest, object_path = archive_body(root, fetched["body"])
        if extraction is None:
            extraction = _parse_page(fetched["body"], fetched["final_url"], fetched["media_type"], family, language)
        report_links = extraction["reportLinks"]
        gaps = []
        if not report_links and family != REGULATORY_FAMILY:
            code = "no-unambiguous-year-labelled-family-links"
            gaps.append((code, "No year-labelled report link with matching family context was found on this issuer page", []))
        if extraction["ambiguousYearLinks"]:
            gaps.append(("ambiguous-year-link", "Year-labelled link lacked matching family context",
                         extraction["ambiguousYearLinks"]))
        discovery_links = extraction.get("discoveryLinks", [])
        if family == REGULATORY_FAMILY and not discovery_links:
            gaps.append(("no-labelled-regulatory-plan-link", "No publisher-labelled forward regulatory or stock-review plan link was found", []))
        with db:
            db.execute("UPDATE issuer_pages SET status='fetched',final_url=?,fetched_at=?,http_status=200,media_type=?,body_sha256=?,body_bytes=?,object_path=?,page_title=?,fetch_url=?,detail=NULL WHERE run_id=? AND family=? AND language=? AND published_url=?",
                       (fetched["final_url"], attempted_at, fetched["media_type"], digest, fetched["bytes"], object_path,
                        extraction["pageTitle"], page.get("fetchUrl", url), run_id, family, language, url))
            db.execute("DELETE FROM report_links WHERE run_id=? AND family=? AND language=? AND landing_url=?",
                       (run_id, family, language, url))
            db.execute("DELETE FROM discovery_links WHERE run_id=? AND family=? AND language=? AND landing_url=?",
                       (run_id, family, language, url))
            db.execute("DELETE FROM gaps WHERE run_id=? AND family=? AND language=? AND landing_url=?",
                       (run_id, family, language, url))
            for ordinal, link in enumerate(report_links):
                db.execute("INSERT INTO report_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (run_id, family, page.get("issuerKey"), page["issuerLabel"], language, url, digest, ordinal,
                            link["linkType"], link["label"], link.get("heading"), link["yearLabel"], link["url"], link["evidence"]))
            for ordinal, link in enumerate(discovery_links):
                db.execute("INSERT INTO discovery_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (run_id, family, page.get("issuerKey"), page["issuerLabel"], language, url, digest, ordinal,
                            link["linkType"], link["label"], link.get("heading"), link["url"], link["evidence"]))
            for code, detail, candidates in gaps:
                db.execute("INSERT OR REPLACE INTO gaps(run_id,family,issuer_key,issuer_label,language,landing_url,issue_type,code,detail,candidates_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (run_id, family, page.get("issuerKey"), page["issuerLabel"], language, url, "edition-gap", code, detail,
                            json.dumps(candidates, ensure_ascii=False, sort_keys=True)))
            db.execute("INSERT INTO attempts(run_id,landing_url,attempted_at,outcome,http_status,detail) VALUES(?,?,?,?,?,?)",
                       (run_id, url, attempted_at, "fetched", 200, None))
            db.execute("INSERT INTO issuer_page_current VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(family,language,published_url) DO UPDATE SET verified_run_id=excluded.verified_run_id,verified_at=excluded.verified_at,last_attempt_run_id=excluded.last_attempt_run_id,last_attempt_at=excluded.last_attempt_at,last_attempt_status=excluded.last_attempt_status,last_attempt_http_status=excluded.last_attempt_http_status,last_attempt_detail=NULL WHERE (SELECT started_at FROM generations WHERE run_id=excluded.last_attempt_run_id) >= (SELECT started_at FROM generations WHERE run_id=issuer_page_current.last_attempt_run_id)",
                       (family, language, url, run_id, attempted_at, run_id, attempted_at, "fetched", 200, None))
    else:
        with db:
            db.execute("UPDATE issuer_pages SET status='failed',fetched_at=?,http_status=?,fetch_url=?,detail=? WHERE run_id=? AND family=? AND language=? AND published_url=?",
                       (attempted_at, fetched.get("http_status"), page.get("fetchUrl", url), fetched["detail"], run_id, family, language, url))
            db.execute("INSERT INTO gaps(run_id,family,issuer_key,issuer_label,language,landing_url,issue_type,code,detail,candidates_json) VALUES(?,?,?,?,?,?, 'acquisition-failure',?,?, '[]')",
                       (run_id, family, page.get("issuerKey"), page["issuerLabel"], language, url, "issuer-page-fetch-failed", fetched["detail"]))
            db.execute("INSERT INTO attempts(run_id,landing_url,attempted_at,outcome,http_status,detail) VALUES(?,?,?,?,?,?)",
                       (run_id, url, attempted_at, "failed", fetched.get("http_status"), fetched["detail"]))
            db.execute("INSERT INTO issuer_page_current VALUES(?,?,?,NULL,NULL,?,?,?,?,?) ON CONFLICT(family,language,published_url) DO UPDATE SET last_attempt_run_id=excluded.last_attempt_run_id,last_attempt_at=excluded.last_attempt_at,last_attempt_status=excluded.last_attempt_status,last_attempt_http_status=excluded.last_attempt_http_status,last_attempt_detail=excluded.last_attempt_detail WHERE (SELECT started_at FROM generations WHERE run_id=excluded.last_attempt_run_id) >= (SELECT started_at FROM generations WHERE run_id=issuer_page_current.last_attempt_run_id)",
                       (family, language, url, run_id, attempted_at, "failed", fetched.get("http_status"), fetched["detail"]))


def _snapshot(db, root: Path, run_id: str, receipt_path: Path, source_receipt: dict, status: str | None = None) -> dict:
    run = db.execute("SELECT * FROM generations WHERE run_id=?", (run_id,)).fetchone()
    if not run:
        raise KeyError(f"unknown report edition generation: {run_id}")
    pages = [dict(row) for row in db.execute("SELECT * FROM issuer_pages WHERE run_id=? ORDER BY family,language,issuer_label,published_url", (run_id,))]
    for page in pages:
        recovery = json.loads(page.pop("recovery_json", "{}"))
        if recovery:
            page["publisherRecovery"] = recovery
    links = [dict(row) for row in db.execute("SELECT * FROM report_links WHERE run_id=? ORDER BY family,language,issuer_label,year_label,link_type,url", (run_id,))]
    discovery_links = [dict(row) for row in db.execute("SELECT * FROM discovery_links WHERE run_id=? ORDER BY family,language,issuer_label,landing_url,ordinal", (run_id,))]
    all_issues = [dict(row) for row in db.execute("SELECT * FROM gaps WHERE run_id=? ORDER BY family,language,issuer_label,landing_url,issue_type,code", (run_id,))]
    gaps = [row for row in all_issues if row["issue_type"] == "edition-gap"]
    acquisition_failures = [row for row in all_issues if row["issue_type"] == "acquisition-failure"]
    successful = sum(page["status"] == "fetched" for page in pages)
    failed = sum(page["status"] == "failed" for page in pages)
    pending = sum(page["status"] == "pending" for page in pages)
    skipped = sum(page["status"] == "skipped" for page in pages)
    if status is None:
        status = "partial" if failed or pending else ("complete-with-gaps" if gaps or skipped else "complete-index-only")
    report = {"collection": "departmental-report-editions", "runId": run_id, "status": status,
              "observedAt": utc_now(), "sourceDirectoryInventory": {
                  "receiptPath": str(receipt_path.relative_to(ROOT)),
                  "inventoryPath": source_receipt["inventoryPath"],
                  "inventorySha256": source_receipt["inventorySha256"],
                  "inventoryObservedAt": source_receipt.get("observedAt")},
              "summary": {"issuerLandingPagesExpected": run["expected_pages"], "issuerLandingPagesFetched": successful,
                          "issuerLandingPagesFailed": failed, "issuerLandingPagesPending": pending,
                          "issuerLandingPagesSkipped": skipped,
                          "yearLabelledLinks": len(links),
                          "directEditionLinks": sum(row["link_type"] == "direct-edition" for row in links),
                          "indexLinks": sum(row["link_type"] == "index-link" for row in links),
                          "labelledDiscoveryLinks": len(discovery_links),
                          "gaps": len(gaps), "acquisitionFailures": len(acquisition_failures),
                          "byFamilyLanguage": {}},
              "scope": "Issuer landing pages are fetched and checksum-archived. Departmental plans/results include only explicit year-labelled links with matching family context. Regulatory-plan discoveries preserve publisher labels without inferring a cycle. Linked report documents are not fetched, parsed, or represented as full-document coverage.",
              "issuerPages": pages, "reportLinks": links, "discoveryLinks": discovery_links,
              "gaps": gaps,
              "acquisitionFailures": acquisition_failures}
    report_families = list(FAMILIES)
    if any(row["family"] == REGULATORY_FAMILY for row in pages):
        report_families.append(REGULATORY_FAMILY)
    for family in report_families:
        for language in ("en", "fr"):
            page_rows = [row for row in pages if row["family"] == family and row["language"] == language]
            family_links = [row for row in links if row["family"] == family and row["language"] == language]
            family_discovery = [row for row in discovery_links if row["family"] == family and row["language"] == language]
            family_gaps = [row for row in gaps if row["family"] == family and row["language"] == language]
            report["summary"]["byFamilyLanguage"][f"{family}/{language}"] = {
                "expectedPages": len(page_rows), "fetchedPages": sum(row["status"] == "fetched" for row in page_rows),
                "failedPages": sum(row["status"] == "failed" for row in page_rows),
                "skippedPages": sum(row["status"] == "skipped" for row in page_rows),
                "yearLabelledLinks": len(family_links),
                "directEditionLinks": sum(row["link_type"] == "direct-edition" for row in family_links),
                "indexLinks": sum(row["link_type"] == "index-link" for row in family_links),
                "labelledDiscoveryLinks": len(family_discovery),
                "gaps": len(family_gaps)}
    return report


def _atomic_json(path: Path, payload: dict) -> tuple[str, int]:
    encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return hashlib.sha256(encoded).hexdigest(), len(encoded)


def _current_evidence(db) -> dict:
    pages = []
    rows = db.execute("""SELECT c.*,COALESCE(p.issuer_key,a.issuer_key) AS issuer_key,
                               COALESCE(p.issuer_label,a.issuer_label) AS issuer_label,
                               COALESCE(p.issuer_attribution,a.issuer_attribution) AS issuer_attribution,
                               COALESCE(p.source_index_url,a.source_index_url) AS source_index_url,
                               COALESCE(p.source_index_sha256,a.source_index_sha256) AS source_index_sha256,
                               COALESCE(p.fetch_url,a.fetch_url) AS fetch_url,
                               p.final_url,p.media_type,p.body_sha256,p.body_bytes,p.object_path
                        FROM issuer_page_current c
                        LEFT JOIN issuer_pages p ON p.run_id=c.verified_run_id AND p.family=c.family
                             AND p.language=c.language AND p.published_url=c.published_url
                        LEFT JOIN issuer_pages a ON a.run_id=c.last_attempt_run_id AND a.family=c.family
                             AND a.language=c.language AND a.published_url=c.published_url
                        ORDER BY c.family,c.language,p.issuer_label,c.published_url""").fetchall()
    for row in rows:
        item = dict(row)
        verified_run_id = item["verified_run_id"]
        if verified_run_id:
            item["reportLinks"] = [dict(link) for link in db.execute(
                "SELECT link_type,label,heading,year_label,url,evidence,landing_sha256 FROM report_links WHERE run_id=? AND family=? AND language=? AND landing_url=? ORDER BY ordinal",
                (verified_run_id, item["family"], item["language"], item["published_url"]))]
            item["discoveryLinks"] = [dict(link) for link in db.execute(
                "SELECT link_type,label,heading,url,evidence,landing_sha256 FROM discovery_links WHERE run_id=? AND family=? AND language=? AND landing_url=? ORDER BY ordinal",
                (verified_run_id, item["family"], item["language"], item["published_url"]))]
            item["contentGaps"] = [dict(gap) for gap in db.execute(
                "SELECT code,detail,candidates_json FROM gaps WHERE run_id=? AND family=? AND language=? AND landing_url=? AND issue_type='edition-gap' ORDER BY code",
                (verified_run_id, item["family"], item["language"], item["published_url"]))]
        else:
            item["reportLinks"] = []
            item["discoveryLinks"] = []
            item["contentGaps"] = []
        pages.append(item)
    return {"collection": "departmental-report-editions-current", "observedAt": utc_now(),
            "scope": "Per-issuer latest verified landing-page extraction is retained when a later attempt fails. Linked report documents are not fetched or represented as full-document coverage.",
            "summary": {"issuerPages": len(pages), "withVerifiedContent": sum(bool(p["verified_run_id"]) for p in pages),
                        "latestAttemptFailed": sum(p["last_attempt_status"] == "failed" for p in pages),
                        "latestAttemptSkipped": sum(p["last_attempt_status"] == "skipped" for p in pages)},
            "issuerPages": pages}


def publish_attempt_evidence(db, root: Path, report: dict, report_path: Path, report_sha: str, report_bytes: int) -> None:
    with db:
        db.execute("UPDATE generations SET detail=detail WHERE run_id=?", (report["runId"],))
        current = _current_evidence(db)
        current_sha, current_bytes = _atomic_json(root / "current.json", current)
        pointer_path = root / "latest-attempt.json"
        pointer = None
        if pointer_path.exists():
            try:
                pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pointer = None
        old_started = None
        if pointer and pointer.get("runId"):
            old = db.execute("SELECT started_at FROM generations WHERE run_id=?", (pointer["runId"],)).fetchone()
            old_started = old[0] if old else None
        this_started = db.execute("SELECT started_at FROM generations WHERE run_id=?", (report["runId"],)).fetchone()[0]
        if pointer is None or old_started is None or this_started >= old_started:
            pointer = {"runId": report["runId"], "status": report["status"],
                       "reportPath": str(report_path.relative_to(root)), "reportSha256": report_sha,
                       "reportBytes": report_bytes, "publishedAt": utc_now()}
        pointer.update({"currentReportPath": "current.json", "currentReportSha256": current_sha,
                        "currentReportBytes": current_bytes})
        _atomic_json(pointer_path, pointer)


def rebuild_current_report(root: Path = DEFAULT_ROOT) -> dict:
    """Refresh the bounded current view from persisted generations without network access."""
    db = db_open(root, read_only=True)
    try:
        report = _current_evidence(db)
    finally:
        db.close()
    digest, size = _atomic_json(root / "current.json", report)
    pointer_path = root / "latest-attempt.json"
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    pointer.update({"currentReportPath": "current.json", "currentReportSha256": digest,
                    "currentReportBytes": size, "publishedAt": utc_now()})
    _atomic_json(pointer_path, pointer)
    return report


def refresh(root: Path = DEFAULT_ROOT, receipt_path: Path = DIRECTORIES_RECEIPT, fetcher=fetch_page,
            max_archive_bytes: int = MAX_ARCHIVE_BYTES, workers: int = MAX_WORKERS,
            min_free_bytes: int = MIN_FREE_BYTES) -> dict:
    free = shutil.disk_usage(root.parent if root.parent.exists() else ROOT).free
    if free < min_free_bytes + max_archive_bytes:
        raise RuntimeError(f"need {min_free_bytes + max_archive_bytes} bytes free for bounded archive intake")
    source_receipt, inventory = load_verified_inventory(receipt_path)
    pages = source_pages(inventory)
    if not pages:
        raise ValueError("Verified federal directory inventory contains no departmental plans/results pages")
    run_id = hashlib.sha256((source_receipt["inventorySha256"] + utc_now() + os.urandom(16).hex()).encode()).hexdigest()[:32]
    db = db_open(root)
    budget = ArchiveBudget(max_archive_bytes)
    try:
        _start_generation(db, run_id, receipt_path.resolve(), source_receipt, inventory, pages)
        for page in (item for item in pages if item.get("preflightGap")):
            _record_result(db, root, run_id, page, {"status": "failed", "detail": page["preflightGap"]}, None, utc_now())
        fetchable_pages = [page for page in pages if not page.get("preflightGap")]
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_fetch_budgeted, page.get("fetchUrl", page["url"]), budget, fetcher): page for page in fetchable_pages}
            for future in as_completed(futures):
                page = futures[future]
                fetched = future.result()
                extraction = None
                if fetched["status"] == "fetched":
                    try:
                        extraction = _parse_page(fetched["body"], fetched["final_url"], fetched["media_type"], page["family"], page["language"])
                    except Exception as error:
                        fetched = {"status": "failed", "detail": f"internal extraction error: {str(error) or type(error).__name__}"[:1000], "http_status": None}
                _record_result(db, root, run_id, page, fetched, extraction, utc_now())
        fetched_count = db.execute("SELECT COUNT(*) FROM issuer_pages WHERE run_id=? AND status='fetched'", (run_id,)).fetchone()[0]
        failed_count = db.execute("SELECT COUNT(*) FROM issuer_pages WHERE run_id=? AND status='failed'", (run_id,)).fetchone()[0]
        skipped_count = db.execute("SELECT COUNT(*) FROM issuer_pages WHERE run_id=? AND status='skipped'", (run_id,)).fetchone()[0]
        if fetched_count + failed_count + skipped_count != len(pages):
            pending = len(pages) - fetched_count - failed_count - skipped_count
            failed_count += pending
            with db:
                db.execute("UPDATE issuer_pages SET status='failed',detail='worker did not return a result' WHERE run_id=? AND status='pending'", (run_id,))
                db.execute("INSERT INTO gaps(run_id,family,issuer_key,issuer_label,language,landing_url,issue_type,code,detail,candidates_json) SELECT run_id,family,issuer_key,issuer_label,language,published_url,'acquisition-failure','issuer-page-fetch-failed',detail,'[]' FROM issuer_pages WHERE run_id=? AND status='failed' AND detail='worker did not return a result'", (run_id,))
        report = _snapshot(db, root, run_id, receipt_path.resolve(), source_receipt)
        report_path = root / "generations" / f"{run_id}.json"
        report_sha, report_bytes = _atomic_json(report_path, report)
        report_rel = str(report_path.relative_to(root))
        counts = report["summary"]
        with db:
            db.execute("UPDATE generations SET completed_at=?,status=?,fetched_pages=?,failed_pages=?,direct_editions=?,index_links=?,gap_count=?,archive_bytes=?,report_path=?,report_sha256=? WHERE run_id=?",
                       (report["observedAt"], report["status"], counts["issuerLandingPagesFetched"],
                        counts["issuerLandingPagesFailed"], counts["directEditionLinks"], counts["indexLinks"],
                        counts["gaps"], budget.used, report_rel, report_sha, run_id))
        publish_attempt_evidence(db, root, report, report_path, report_sha, report_bytes)
        if failed_count == 0 and skipped_count == 0:
            pointer_path = root / "latest.json"
            with db:
                db.execute("UPDATE generations SET detail=detail WHERE run_id=?", (run_id,))
                current = None
                if pointer_path.exists():
                    try:
                        current = json.loads(pointer_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        current = None
                current_started = None
                if current and current.get("runId"):
                    row = db.execute("SELECT started_at FROM generations WHERE run_id=?", (current["runId"],)).fetchone()
                    current_started = row[0] if row else None
                this_started = db.execute("SELECT started_at FROM generations WHERE run_id=?", (run_id,)).fetchone()[0]
                if current_started is None or this_started >= current_started:
                    pointer = {"runId": run_id, "status": report["status"], "reportPath": report_rel,
                               "reportSha256": report_sha, "reportBytes": report_bytes,
                               "sourceInventorySha256": source_receipt["inventorySha256"], "publishedAt": utc_now()}
                    _atomic_json(pointer_path, pointer)
        return report
    finally:
        db.close()


def _load_generation_inventory(run) -> tuple[dict, dict]:
    inventory_path = _safe_repo_file(run["source_inventory_path"])
    raw = inventory_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != run["source_inventory_sha256"]:
        raise ValueError("Generation's immutable source inventory checksum failed")
    inventory = json.loads(raw)
    return {"inventoryPath": run["source_inventory_path"], "inventorySha256": digest,
            "observedAt": inventory.get("observedAt"), "sourceRegisterSha256": inventory.get("sourceRegisterSha256")}, inventory


def replay(run_id: str, root: Path = DEFAULT_ROOT, receipt_path: Path = DIRECTORIES_RECEIPT) -> dict:
    db = db_open(root, read_only=True)
    try:
        run = db.execute("SELECT * FROM generations WHERE run_id=?", (run_id,)).fetchone()
        if not run:
            raise KeyError(f"unknown report edition generation: {run_id}")
        source_receipt, _ = _load_generation_inventory(run)
        page_rows = db.execute("SELECT * FROM issuer_pages WHERE run_id=? AND status='fetched' ORDER BY family,language,published_url", (run_id,)).fetchall()
        for row in page_rows:
            object_path = (root / row["object_path"]).resolve()
            if root.resolve() not in object_path.parents:
                raise ValueError("Generation object path escapes corpus root")
            body = read_archive(object_path, row["body_sha256"], row["body_bytes"])
            extraction = _parse_page(body, row["final_url"], row["media_type"], row["family"], row["language"])
            recorded = [dict(link) for link in db.execute("SELECT * FROM report_links WHERE run_id=? AND family=? AND language=? AND landing_url=? ORDER BY ordinal", (run_id, row["family"], row["language"], row["published_url"]))]
            expected = [(link["linkType"], link["label"], link.get("heading"), link["yearLabel"], link["url"], link["evidence"]) for link in extraction["reportLinks"]]
            actual = [(link["link_type"], link["label"], link["heading"], link["year_label"], link["url"], link["evidence"]) for link in recorded]
            if actual != expected:
                raise ValueError(f"Replay extraction changed for {row['published_url']}")
            expected_gaps = []
            if row["family"] == REGULATORY_FAMILY:
                if not extraction.get("discoveryLinks"):
                    expected_gaps.append(("no-labelled-regulatory-plan-link", "[]"))
            elif not extraction["reportLinks"]:
                expected_gaps.append(("no-unambiguous-year-labelled-family-links", "[]"))
            if extraction["ambiguousYearLinks"]:
                expected_gaps.append(("ambiguous-year-link", json.dumps(extraction["ambiguousYearLinks"], ensure_ascii=False, sort_keys=True)))
            actual_gaps = [(gap["code"], gap["candidates_json"]) for gap in db.execute(
                "SELECT code,candidates_json FROM gaps WHERE run_id=? AND family=? AND language=? AND landing_url=? AND issue_type='edition-gap' ORDER BY code,candidates_json",
                (run_id, row["family"], row["language"], row["published_url"]))]
            if sorted(actual_gaps) != sorted(expected_gaps):
                raise ValueError(f"Replay gap extraction changed for {row['published_url']}")
            recorded_discoveries = [dict(link) for link in db.execute(
                "SELECT link_type,label,heading,url,evidence FROM discovery_links WHERE run_id=? AND family=? AND language=? AND landing_url=? ORDER BY ordinal",
                (run_id, row["family"], row["language"], row["published_url"]))]
            expected_discoveries = [{"link_type": link["linkType"], "label": link["label"], "heading": link["heading"],
                                     "url": link["url"], "evidence": link["evidence"]}
                                    for link in extraction.get("discoveryLinks", [])]
            if recorded_discoveries != expected_discoveries:
                raise ValueError(f"Replay regulatory discovery changed for {row['published_url']}")
        if run["report_path"]:
            report_path = (root / run["report_path"]).resolve()
            if root.resolve() not in report_path.parents:
                raise ValueError("Generation report path escapes corpus root")
            raw_report = report_path.read_bytes()
            if hashlib.sha256(raw_report).hexdigest() != run["report_sha256"]:
                raise ValueError("Generation report checksum failed")
            report = json.loads(raw_report)
            return report
        return _snapshot(db, root, run_id, _safe_repo_file(run["source_receipt_path"]), source_receipt)
    finally:
        db.close()


def finalize_interrupted(run_id: str, reason: str, root: Path = DEFAULT_ROOT) -> dict:
    """Close a deliberately stopped run while preserving its fetched pages as partial evidence."""
    db = db_open(root)
    try:
        run = db.execute("SELECT * FROM generations WHERE run_id=?", (run_id,)).fetchone()
        if not run or run["status"] != "running":
            raise ValueError("Only a running generation can be finalized as interrupted")
        source_receipt, _ = _load_generation_inventory(run)
        with db:
            db.execute("UPDATE issuer_pages SET status='failed',fetched_at=?,detail=? WHERE run_id=? AND status='pending'",
                       (utc_now(), reason, run_id))
            db.execute("INSERT INTO gaps(run_id,family,issuer_key,issuer_label,language,landing_url,issue_type,code,detail,candidates_json) SELECT run_id,family,issuer_key,issuer_label,language,published_url,'acquisition-failure','run-interrupted',?,'[]' FROM issuer_pages WHERE run_id=? AND detail=?",
                       (reason, run_id, reason))
            db.execute("INSERT INTO attempts(run_id,landing_url,attempted_at,outcome,detail) SELECT run_id,published_url,?,'interrupted',? FROM issuer_pages WHERE run_id=? AND detail=?",
                       (utc_now(), reason, run_id, reason))
        report = _snapshot(db, root, run_id, _safe_repo_file(run["source_receipt_path"]), source_receipt)
        report_path = root / "generations" / f"{run_id}.json"
        report_sha, _ = _atomic_json(report_path, report)
        with db:
            db.execute("UPDATE generations SET completed_at=?,status='partial',fetched_pages=?,failed_pages=?,direct_editions=?,index_links=?,gap_count=?,report_path=?,report_sha256=?,detail=? WHERE run_id=?",
                       (report["observedAt"], report["summary"]["issuerLandingPagesFetched"],
                        report["summary"]["issuerLandingPagesFailed"], report["summary"]["directEditionLinks"],
                        report["summary"]["indexLinks"], report["summary"]["gaps"],
                        str(report_path.relative_to(root)), report_sha, reason, run_id))
        return report
    finally:
        db.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    refresh_parser = sub.add_parser("refresh", help="fetch issuer pages from the latest verified directory inventory")
    refresh_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    refresh_parser.add_argument("--receipt", type=Path, default=DIRECTORIES_RECEIPT)
    refresh_parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    refresh_parser.add_argument("--max-archive-bytes", type=int, default=MAX_ARCHIVE_BYTES)
    replay_parser = sub.add_parser("replay", help="re-extract links from verified archived issuer pages")
    replay_parser.add_argument("run_id")
    replay_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    replay_parser.add_argument("--receipt", type=Path, default=DIRECTORIES_RECEIPT)
    interrupted_parser = sub.add_parser("finalize-interrupted", help="durably close a manually stopped refresh as partial")
    interrupted_parser.add_argument("run_id")
    interrupted_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    interrupted_parser.add_argument("--reason", default="refresh interrupted to change transport")
    current_parser = sub.add_parser("current", help="show paths and counts for the per-issuer current evidence report")
    current_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    rebuild_parser = sub.add_parser("rebuild-current", help="rebuild per-issuer current evidence from local generations")
    rebuild_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args(argv)
    try:
        if args.command == "refresh":
            if not 1 <= args.workers <= 6:
                raise ValueError("workers must be between 1 and 6")
            result = refresh(args.root, args.receipt, max_archive_bytes=args.max_archive_bytes, workers=args.workers)
        elif args.command == "replay":
            result = replay(args.run_id, args.root, args.receipt)
        elif args.command == "finalize-interrupted":
            result = finalize_interrupted(args.run_id, args.reason, args.root)
        elif args.command == "rebuild-current":
            result = rebuild_current_report(args.root)
            print(json.dumps({"summary": result["summary"], "currentReport": str((args.root / "current.json").relative_to(ROOT))}, sort_keys=True))
            return 0
        else:
            evidence_path = args.root / "current.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            print(json.dumps({"currentReport": str(evidence_path.relative_to(ROOT)),
                              "latestAttempt": str((args.root / "latest-attempt.json").relative_to(ROOT)),
                              "summary": evidence["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        print(json.dumps({"runId": result["runId"], "status": result["status"],
                          "summary": result["summary"], "sourceInventorySha256": result["sourceDirectoryInventory"]["inventorySha256"],
                          "report": str((args.root / "generations" / f"{result['runId']}.json").relative_to(ROOT))},
                         ensure_ascii=False, sort_keys=True))
        return 0 if result["status"] != "partial" else 2
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"departmental-report-editions: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
