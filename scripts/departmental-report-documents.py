#!/usr/bin/env python3
"""Acquire, text-check, and replay explicitly linked departmental report PDFs."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import gzip
import hashlib
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
from urllib.parse import quote, urljoin, urlsplit

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

PLAN_TERMS = {
    "en": ("departmental plan", "plans and priorities", "report on plans and priorities", "reports on plans and priorities"),
    "fr": ("plan ministériel", "plans ministériels", "plans et priorités", "rapport sur les plans et priorités"),
}
RESULT_TERMS = {
    "en": ("departmental results report", "departmental performance report", "results report", "performance report"),
    "fr": ("rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "rapport ministériel de rendement"),
}
LANGUAGE_MARKERS = {
    "en": ("departmental plan", "plans and priorities", "departmental results report", "departmental performance report", "table of contents"),
    "fr": ("plan ministériel", "plans ministériels", "rapport sur les résultats ministériels", "rapport ministériel sur le rendement", "table des matières"),
}
YEAR_RANGE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*(?:[-–—]|\bto\b|\bà\b)\s*((?:(?:19|20)\d{2})|\d{2})(?!\d)", re.I)
YEAR_TOKEN = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")


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


def public_archive_continue(body: bytes, requested_url: str) -> bool:
    """Recognize the publisher's visible Continue button only when it links back to this exact PDF."""
    source = body.decode("utf-8", "replace").casefold().replace("\\u0026", "&").replace("\\/", "/")
    target = requested_url.casefold()
    labels = ("continue to publication", "continuer vers la publication")
    return any(label in source for label in labels) and target in source


def fetch_pdf(url: str, *, referer: str | None = None, continued: bool = False) -> tuple[bytes, str, int, str]:
    if not committee_files.fetchable(url):
        raise FetchError("direct PDF URL is outside official HTTPS acquisition policy")

    class CheckedRedirect(urllib.request.HTTPRedirectHandler):
        def __init__(self):
            super().__init__()
            self.count = 0

        def redirect_request(self, request, response, code, message, headers, new_url):
            self.count += 1
            target = urljoin(request.full_url, new_url)
            if self.count > MAX_REDIRECTS or not committee_files.official(target):
                raise FetchError("redirect outside official HTTPS hosts or exceeds redirect limit", code)
            return super().redirect_request(request, response, code, message, headers, target)

    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1"}
    if referer:
        headers["Referer"] = referer
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.build_opener(CheckedRedirect()).open(request, timeout=45) as response:
            final_url = response.geturl()
            if not committee_files.official(final_url):
                raise FetchError("final URL outside official HTTPS hosts")
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_DOCUMENT_BYTES:
                raise FetchError("PDF exceeds per-document byte limit")
            chunks = bytearray()
            while True:
                block = response.read(128 * 1024)
                if not block:
                    break
                chunks.extend(block)
                if len(chunks) > MAX_DOCUMENT_BYTES:
                    raise FetchError("PDF exceeds per-document byte limit")
            body = bytes(chunks)
            media = response.headers.get_content_type().casefold()
            if response.status != 200:
                raise FetchError("HTTP " + str(response.status), response.status)
            if not continued and media == "text/html" and public_archive_continue(body, url):
                return fetch_pdf(url, referer=final_url, continued=True)
            return body, final_url, response.status, media
    except urllib.error.HTTPError as error:
        raise FetchError("HTTP " + str(error.code), error.code) from error
    except ssl.SSLCertVerificationError as error:
        body, final, status, media = fetch_pdf_curl(url, error, referer=referer)
        if not continued and media == "text/html" and public_archive_continue(body, url):
            return fetch_pdf(url, referer=final, continued=True)
        return body, final, status, media
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            body, final, status, media = fetch_pdf_curl(url, error.reason, referer=referer)
            if not continued and media == "text/html" and public_archive_continue(body, url):
                return fetch_pdf(url, referer=final, continued=True)
            return body, final, status, media
        raise FetchError(str(error.reason)[:1000]) from error
    except (TimeoutError, OSError) as error:
        raise FetchError(str(error)[:1000]) from error


def fetch_pdf_curl(url: str, original_error: Exception, *, referer: str | None = None):
    """Use curl's normal trust store only when urllib cannot validate the certificate."""
    current = url
    with tempfile.TemporaryDirectory(prefix="departmental-report-pdf-") as temp:
        target = Path(temp) / "source.pdf"
        for _ in range(MAX_REDIRECTS + 1):
            if not committee_files.official(current):
                raise FetchError("redirect outside official HTTPS hosts") from original_error
            command = ["curl", "--silent", "--show-error", "--globoff", "--proto", "=https", "--max-redirs", "0",
                       "--max-time", "60", "--connect-timeout", "15", "--max-filesize", str(MAX_DOCUMENT_BYTES),
                       "--user-agent", USER_AGENT, "--header", "Accept: application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
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
                current = urljoin(current, redirect)
                continue
            if status != "200":
                raise FetchError("HTTP " + status, int(status) if status.isdigit() else None) from original_error
            body = target.read_bytes()
            if len(body) > MAX_DOCUMENT_BYTES:
                raise FetchError("PDF exceeds per-document byte limit") from original_error
            if media.partition(";")[0].casefold() == "text/html" and public_archive_continue(body, url) and not referer:
                return fetch_pdf_curl(url, original_error, referer=current)
            return body, current, 200, media.partition(";")[0].casefold()
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


def source_year(label: str, year_label: str) -> str | None:
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


def language_disposition(text: str, language: str) -> str:
    sample = normalized(text[:300_000])
    scores = {lang: sum(sample.count(normalized(term)) for term in markers) for lang, markers in LANGUAGE_MARKERS.items()}
    requested, other = scores[language], scores["fr" if language == "en" else "en"]
    if requested and other:
        return "multilingual"
    if requested:
        return "match"
    if other:
        return "mismatch"
    return "unresolved"


def family_disposition(text: str, family: str, language: str) -> str:
    sample = normalized(text[:300_000])
    terms = PLAN_TERMS[language] if family == "departmental-plans" else RESULT_TERMS[language]
    return "match" if any(normalized(term) in sample for term in terms) else "unresolved"


def body_language_conflict(candidate: dict) -> bool:
    stem = urlsplit(candidate["url"]).path.rsplit("/", 1)[-1].casefold()
    stem = re.sub(r"[^a-z0-9]+", "-", stem)
    english_file = bool(re.search(r"(?:^|-)eng(?:-|\.)", stem))
    french_file = bool(re.search(r"(?:^|-)fra(?:-|\.)", stem))
    return (candidate["language"] == "en" and french_file and not english_file) or (candidate["language"] == "fr" and english_file and not french_file)


def collect_candidates(report: dict) -> list[dict]:
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
            candidates.append({"family": family, "language": language,
                "issuerLabel": page.get("issuer_label") or page.get("issuer_attribution") or "Unknown issuer",
                "issuerKey": page.get("issuer_key"), "landingUrl": page.get("published_url"),
                "landingSha256": link.get("landing_sha256"),
                "sourceIndexUrl": page.get("source_index_url"), "sourceIndexSha256": page.get("source_index_sha256"),
                "label": link.get("label", ""), "heading": link.get("heading"),
                "yearLabel": link.get("year_label"), "issueYear": source_year(link.get("label", ""), link.get("year_label", "")),
                "url": url, "fetchUrl": quote(url, safe=":/?#[]@!$&'()*+,;=%"),
                "evidence": link.get("evidence"),
                "linkLanguageConflict": body_language_conflict({"url": url, "language": language})})
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
      text_pages INTEGER, readable_chars INTEGER, detail TEXT,
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
    """)
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


def assess(text: str, candidate: dict) -> dict:
    lang = language_disposition(text, candidate["language"])
    if candidate.get("linkLanguageConflict"):
        lang = "source-link-conflict"
    fam = family_disposition(text, candidate["family"], candidate["language"])
    year = year_disposition(text, candidate.get("issueYear"))
    issuer_norm = normalized(candidate["issuerLabel"])
    issuer_found = bool(issuer_norm and issuer_norm in normalized(text[:300_000]))
    issuer = "named-in-text" if issuer_found else "source-page-attribution-only"
    checks = [lang in {"match", "multilingual"}, fam == "match", year == "match"]
    disposition = "verified" if all(checks) else "review"
    return {"disposition": disposition, "familyDisposition": fam, "languageDisposition": lang,
            "yearDisposition": year, "issuerDisposition": issuer}


def _fetch_one(url: str, budget: Budget, fetcher=fetch_pdf) -> dict:
    if not budget.reserve():
        return {"status": "budget-skipped", "detail": "aggregate document archive budget exhausted"}
    try:
        body, final, status, media = fetcher(url)
        digest = hashlib.sha256(body).hexdigest()
        budget.settle(len(body))
        return {"status": "fetched", "body": body, "bodySha256": digest,
                "bodyBytes": len(body), "finalUrl": final, "httpStatus": status, "mediaType": media}
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
    return {"status": status, "detail": detail, "bodyPath": body_path, "textSha256": text_digest,
            "textBytes": text_bytes, "textPath": text_path, "textPages": pages,
            "readableChars": chars, "citations": citations}


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


def _write_generation(db, root: Path, run_id: str, report_run_id: str, input_path: str,
                      source_sha: str, source_path: str, groups: dict, started: str,
                      budget: Budget) -> dict:
    docs, citations, failed, readable = [], [], 0, 0
    for row in db.execute("SELECT * FROM documents WHERE run_id=? ORDER BY target_url", (run_id,)):
        docs.append(dict(row))
    for row in db.execute("SELECT * FROM citations WHERE run_id=? ORDER BY family,language,issuer_label,issue_year,target_url", (run_id,)):
        citations.append(dict(row))
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
    return {"collection": "departmental-report-documents", "runId": run_id, "status": status,
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
            fetcher=fetch_pdf) -> dict:
    if not 1 <= workers <= 4:
        raise ValueError("workers must be between 1 and 4")
    if shutil.disk_usage(root.parent if root.parent.exists() else ROOT).free < min_free_bytes + max_archive_bytes:
        raise RuntimeError("insufficient free space for bounded document archive refresh")
    raw, source, source_run_id = validate_input(edition_root)
    candidates = collect_candidates(source)
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
                        db.execute("UPDATE documents SET status=?,http_status=?,media_type=?,final_url=?,body_sha256=?,body_bytes=?,object_path=?,text_sha256=?,text_bytes=?,text_object_path=?,text_pages=?,readable_chars=?,detail=? WHERE run_id=? AND target_url=?",
                            (extracted["status"], fetched["httpStatus"], fetched["mediaType"], fetched["finalUrl"], fetched["bodySha256"], fetched["bodyBytes"], extracted["bodyPath"], extracted["textSha256"], extracted["textBytes"], extracted["textPath"], extracted["textPages"], extracted["readableChars"], extracted["detail"], run_id, url))
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
        candidates = collect_candidates(source)
        by_url = _candidate_report(candidates)
        for doc in db.execute("SELECT * FROM documents WHERE run_id=? ORDER BY target_url", (run_id,)):
            if doc["body_sha256"]:
                body = read_gzip(root, doc["object_path"], doc["body_sha256"], doc["body_bytes"], MAX_DOCUMENT_BYTES)
                if body.startswith(b"%PDF-"):
                    text, pages = pdf_text(body)
                    text_raw = text.encode("utf-8")
                    if hashlib.sha256(text_raw).hexdigest() != doc["text_sha256"] or pages != doc["text_pages"]:
                        raise ValueError("PDF text replay differs: " + doc["target_url"])
                    expected = [assess(text, candidate) for candidate in by_url[doc["target_url"]]]
                    recorded = [dict(row) for row in db.execute("SELECT disposition,family_disposition,language_disposition,year_disposition,issuer_disposition FROM citations WHERE run_id=? AND target_url=? ORDER BY citation_id", (run_id, doc["target_url"]))]
                    pairs = sorted((x["disposition"], x.get("familyDisposition"), x.get("languageDisposition"), x.get("yearDisposition"), x.get("issuerDisposition")) for x in expected)
                    actual = sorted((x["disposition"], x["family_disposition"], x["language_disposition"], x["year_disposition"], x["issuer_disposition"]) for x in recorded)
                    if pairs != actual:
                        raise ValueError("PDF citation assessment replay differs: " + doc["target_url"])
        report_path = root / generation["report_path"]
        report_raw = report_path.read_bytes()
        if hashlib.sha256(report_raw).hexdigest() != generation["report_sha256"]:
            raise ValueError("Document generation report hash failed")
        return json.loads(report_raw)
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
    args = parser.parse_args(argv)
    try:
        result = refresh(args.root, args.edition_root, args.workers, args.max_archive_bytes) if args.command == "refresh" else replay(args.run_id, args.root)
        if args.command == "refresh":
            print(json.dumps({"runId": result["runId"], "status": result["status"], "summary": result["summary"],
                              "report": str((args.root / "generations" / f"{result['runId']}.json").relative_to(ROOT))}, ensure_ascii=False, sort_keys=True))
        else:
            print(json.dumps({"runId": result["runId"], "status": result["status"], "summary": result["summary"]}, ensure_ascii=False, sort_keys=True))
        return 0 if result["status"] == "complete" else 2
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"departmental-report-documents: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
