#!/usr/bin/env python3
"""Acquire and verify regulator-published forward regulatory plan pages."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import uuid
import fcntl
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urldefrag, urlsplit
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = ROOT / "data/corpus/federal-regulatory-plans"
DEFAULT_EDITION_ROOT = ROOT / "data/corpus/departmental-report-editions"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 192 * 1024 * 1024
MIN_FREE_BYTES = 512 * 1024 * 1024
MAX_WORKERS = 4

_spec = importlib.util.spec_from_file_location("departmental_report_editions", ROOT / "scripts/departmental-report-editions.py")
if _spec is None or _spec.loader is None:
    raise RuntimeError("Unable to load checked official-page acquisition helper")
_editions = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _editions
_spec.loader.exec_module(_editions)
committee_files = _editions.committee_files

FORWARD_LABEL = {
    "en": re.compile(r"\bforward\s+regulatory\s+plans?\b", re.I),
    "fr": re.compile(r"\bplan\s+prospectif\s+de\s+la\s+reglementation\b", re.I),
}
STOCK_LABEL = re.compile(r"stock\s+review|plan\s+d.examen\s+de\s+l.inventaire", re.I)
GOVERNMENT_WIDE = re.compile(r"government[ -]wide|\bensemble\s+du\s+gouvernement\b", re.I)
FORWARD_IDENTITY = {
    "en": re.compile(r"\bforward\s+regulatory\s+plans?\b", re.I),
    "fr": re.compile(r"\bplan\s+prospectif\s+de\s+la\s+reglementation\b", re.I),
}
YEAR_RANGE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*(?:to|à|[-–—])\s*((?:19|20)\d{2})(?!\d)", re.I)
INITIATIVE_CONTEXT = {
    "en": ("regulatory initiatives", "current initiatives", "planned regulatory changes", "planned or anticipated changes to regulations",
           "proposed regulations", "regulatory proposals"),
    "fr": ("initiatives réglementaires", "initiatives de réglementation", "modifications réglementaires prévues",
           "modifications prévues ou anticipées", "modifications prévues ou envisagées aux règlements",
           "projets de règlement", "propositions réglementaires"),
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    return " ".join("".join(char for char in decomposed if not unicodedata.combining(char)).casefold().split())


class TargetPageParser(HTMLParser):
    """Extract title, headings and publisher-labelled links from a plan page."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.page_title = ""
        self.headings: list[dict] = []
        self.h1s: list[str] = []
        self.links: list[dict] = []
        self._title_depth = 0
        self._title_parts: list[str] = []
        self._heading: dict | None = None
        self._anchor: dict | None = None
        self.current_heading = ""

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "title":
            self._title_depth += 1
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading = {"tag": tag, "parts": []}
        if tag == "a" and attributes.get("href"):
            from urllib.parse import urljoin
            self._anchor = {"url": urljoin(self.base_url, attributes["href"]), "parts": [],
                            "title": attributes.get("title") or attributes.get("aria-label") or ""}

    def handle_data(self, data):
        if self._title_depth:
            self._title_parts.append(data)
        if self._heading is not None:
            self._heading["parts"].append(data)
        if self._anchor is not None:
            self._anchor["parts"].append(data)

    def handle_endtag(self, tag):
        if tag == "title" and self._title_depth:
            self._title_depth -= 1
            if self._title_depth == 0:
                self.page_title = " ".join("".join(self._title_parts).split())
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._heading is not None:
            heading = " ".join("".join(self._heading["parts"]).split())
            if heading:
                item = {"level": int(self._heading["tag"][1]), "text": heading}
                self.headings.append(item)
                if item["level"] == 1:
                    self.h1s.append(heading)
                self.current_heading = heading
            self._heading = None
        if tag == "a" and self._anchor is not None:
            label = " ".join("".join(self._anchor["parts"]).split()) or self._anchor["title"].strip()
            url = self._anchor["url"]
            if label and urlsplit(url).scheme == "https":
                self.links.append({"label": label, "heading": self.current_heading, "url": url})
            self._anchor = None


def source_archive_path(edition_root: Path, source: dict) -> Path:
    relative = Path(str(source.get("object_path", "")))
    path = (edition_root / relative).resolve()
    if path == edition_root.resolve() or edition_root.resolve() not in path.parents:
        raise ValueError("Issuer landing archive path escapes its source root")
    return path


def read_checked_gzip(path: Path, expected_sha: str, expected_bytes: int, maximum: int) -> bytes:
    with gzip.open(path, "rb") as stream:
        body = stream.read(maximum + 1)
    if len(body) > maximum or len(body) != expected_bytes or digest(body) != expected_sha:
        raise ValueError("Archived source failed byte length or SHA-256 verification")
    return body


def load_source_snapshot(edition_root: Path) -> tuple[dict, bytes, str, str]:
    current_path = (edition_root / "current.json").resolve()
    root = edition_root.resolve()
    if root not in current_path.parents or not current_path.is_file():
        raise ValueError("Current departmental report edition snapshot is missing")
    pointer_path = edition_root / "latest-attempt.json"
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    if pointer.get("currentReportPath") != "current.json":
        raise ValueError("Latest edition pointer does not name current.json")
    raw = current_path.read_bytes()
    source_sha = digest(raw)
    if source_sha != pointer.get("currentReportSha256") or pointer.get("status") not in ("complete", "partial"):
        raise ValueError("Current issuer-link snapshot does not match its latest-attempt pointer")
    report = json.loads(raw)
    if report.get("collection") != "departmental-report-editions-current" or not isinstance(report.get("issuerPages"), list):
        raise ValueError("Current input is not the departmental report edition snapshot")
    return report, raw, source_sha, pointer.get("runId", "")


def is_forward_candidate(link: dict, language: str) -> bool:
    label = str(link.get("label", ""))
    return bool(FORWARD_LABEL.get(language) and FORWARD_LABEL[language].search(normalize(label))) and not STOCK_LABEL.search(normalize(label)) and not GOVERNMENT_WIDE.search(normalize(label))


def collect_discovery_links(report: dict, edition_root: Path) -> tuple[list[dict], list[dict]]:
    rows: list[dict] = []
    candidates: dict[tuple[str, str], dict] = {}
    for page in report["issuerPages"]:
        if page.get("family") != "regulatory-plans":
            continue
        language = page.get("language")
        links = page.get("discoveryLinks") or []
        for link in links:
            label = str(link.get("label", ""))
            normalized_label = normalize(label)
            if is_forward_candidate(link, language):
                classification = "forward-plan-candidate"
            elif STOCK_LABEL.search(normalized_label):
                classification = "related-stock-review"
            elif GOVERNMENT_WIDE.search(normalized_label):
                classification = "related-government-wide-directory"
            else:
                classification = "other-regulatory-discovery"
            source_hash = page.get("body_sha256")
            attempt_status = page.get("last_attempt_status")
            if (attempt_status not in {"fetched", "failed", "skipped"} or not page.get("verified_at") or
                    not source_hash or link.get("landing_sha256") != source_hash):
                raise ValueError("Forward-plan discovery link is not tied to a verified issuer landing page")
            source_fetch_url = page.get("fetch_url") or page.get("final_url") or page.get("published_url")
            if not _editions.acquisition_official(source_fetch_url) or not _editions.acquisition_official(page.get("final_url") or source_fetch_url):
                raise ValueError("Issuer landing URL is outside the official HTTPS policy")
            if (not _editions.acquisition_official(page.get("source_index_url", "")) or
                    not re.fullmatch(r"[0-9a-f]{64}", str(page.get("source_index_sha256", "")))):
                raise ValueError("Issuer landing is missing its verified official directory citation")
            archived = read_checked_gzip(source_archive_path(edition_root, page), source_hash,
                                         int(page.get("body_bytes", 0)), MAX_PAGE_BYTES)
            landing_parser = _editions.ReportPageParser(page["final_url"] or page["published_url"])
            landing_parser.feed(archived.decode("utf-8-sig", errors="replace"))
            if not any(item.get("url") == link.get("url") and item.get("label") == label
                       for item in landing_parser.links):
                raise ValueError("Discovery link is absent from its checksum-verified issuer landing page")
            url = str(link.get("url", ""))
            row = {
                "discoveryId": "",
                "classification": classification,
                "issuerKey": page.get("issuer_key"), "issuerLabel": page.get("issuer_label"),
                "issuerAttribution": page.get("issuer_attribution"), "language": language,
                "sourceUrl": page.get("published_url"), "sourceFetchUrl": source_fetch_url,
                "sourceFinalUrl": page.get("final_url") or source_fetch_url, "sourceBodySha256": source_hash,
                "sourceIndexUrl": page.get("source_index_url"), "sourceIndexSha256": page.get("source_index_sha256"),
                "label": label, "heading": link.get("heading"), "url": url,
                "landingLinkEvidence": link.get("evidence"), "landingLinkType": link.get("link_type"),
            }
            if attempt_status != "fetched":
                row["sourceCarryForward"] = {"verifiedAt": page["verified_at"], "latestAttemptAt": page.get("last_attempt_at"),
                                             "latestAttemptStatus": attempt_status}
            row["discoveryId"] = digest("\n".join((str(row["issuerKey"] or ""), str(language), url, label)).encode())
            rows.append(row)
            if classification != "forward-plan-candidate":
                continue
            if language not in ("en", "fr") or not row["issuerKey"] or not row["issuerLabel"] or not _editions.acquisition_official(url):
                raise ValueError("Forward-plan discovery link lacks a valid issuer identity, language, or official target")
            key = (language, urldefrag(url)[0])
            candidate = candidates.setdefault(key, {"language": language, "fetchUrl": key[1], "sourceLinks": []})
            candidate["sourceLinks"].append(row)
    for candidate in candidates.values():
        issuers = {(row["issuerKey"], row["issuerLabel"], row["issuerAttribution"]) for row in candidate["sourceLinks"]}
        candidate["attributionAmbiguous"] = len(issuers) != 1
        candidate["issuerKey"], candidate["issuerLabel"], candidate["issuerAttribution"] = next(iter(issuers)) if len(issuers) == 1 else (None, None, None)
    return rows, list(candidates.values())


def classify_target(body: bytes, final_url: str, language: str) -> dict:
    parser = TargetPageParser(final_url)
    parser.feed(body.decode("utf-8-sig", errors="replace"))
    identity_signals = [{"text": parser.page_title, "origin": "page-title"},
                        *({"text": value, "origin": "h1"} for value in parser.h1s),
                        *({"text": item["text"], "origin": "heading"} for item in parser.headings if item["level"] > 1)]
    identity = next((item for item in identity_signals if FORWARD_IDENTITY[language].search(normalize(item["text"]))), None)
    cycles = extract_cycles(parser, language)
    initiatives = extract_initiatives(parser, language, final_url)
    return {"confirmed": identity is not None, "identityEvidence": identity,
            "pageTitle": parser.page_title, "headings": parser.headings,
            "cycles": cycles, "initiatives": initiatives}


def extract_cycles(parser: TargetPageParser, language: str) -> list[dict]:
    evidence_rows = [{"text": parser.page_title, "origin": "page-title"},
                     *({"text": item["text"], "origin": "heading"} for item in parser.headings),
                     *({"text": item["label"], "origin": "publisher-link-label"} for item in parser.links)]
    output = {}
    for item in evidence_rows:
        if not FORWARD_IDENTITY[language].search(normalize(item["text"])):
            continue
        match = YEAR_RANGE.search(item["text"])
        if match:
            cycle = f"{match.group(1)}-{match.group(2)}"
            output[(cycle, item["origin"], item["text"])] = {"cycle": cycle, "evidenceText": item["text"], "evidenceOrigin": item["origin"]}
    return list(output.values())


def extract_initiatives(parser: TargetPageParser, language: str, source_url: str) -> list[dict]:
    contexts = tuple(normalize(value) for value in INITIATIVE_CONTEXT[language])
    initiatives = {}
    for link in parser.links:
        heading = normalize(link["heading"])
        if not any(context in heading for context in contexts):
            continue
        if STOCK_LABEL.search(normalize(link["label"])) or GOVERNMENT_WIDE.search(normalize(link["label"])):
            continue
        identity = (normalize(link["label"]), link["url"])
        initiatives[identity] = {"name": link["label"], "heading": link["heading"], "publisherLinkUrl": link["url"],
                                 "sourceUrl": source_url, "sourceEvidence": "publisher link under regulatory initiative heading"}
    return sorted(initiatives.values(), key=lambda row: (normalize(row["name"]), row["publisherLinkUrl"]))


def archive_object(root: Path, body: bytes, maximum: int = MAX_PAGE_BYTES) -> dict:
    sha = digest(body)
    relative = Path("sources/objects") / sha[:2] / f"{sha}.source.gz"
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        fd, temporary = tempfile.mkstemp(prefix=".regplan-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as zipped:
                    zipped.write(body)
            try:
                os.link(temporary, target)
            except FileExistsError:
                pass
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    read_checked_gzip(target, sha, len(body), maximum)
    return {"archivePath": relative.as_posix(), "sha256": sha, "bytes": len(body)}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def inside_root(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if root.resolve() not in path.parents:
        raise ValueError("Report path escapes the corpus root")
    return path


def repo_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_prior_verified(root: Path) -> dict[str, dict]:
    receipt_path = root / "dist" / "receipt.json"
    if not receipt_path.exists():
        return {}
    pointer = json.loads(receipt_path.read_text(encoding="utf-8"))
    report_path = inside_root(root, pointer.get("reportPath", ""))
    raw = report_path.read_bytes()
    if digest(raw) != pointer.get("reportSha256"):
        raise ValueError("Prior regulatory plan report failed its SHA-256 check")
    previous = json.loads(raw)
    return {row["editionId"]: row for row in previous.get("planEditions", []) if row.get("editionId")}


class ArchiveBudget:
    def __init__(self, maximum: int):
        self.maximum = maximum
        self.used = 0
        self.reserved = 0
        self.lock = threading.Lock()

    def reserve(self) -> bool:
        with self.lock:
            if self.used + self.reserved + MAX_PAGE_BYTES > self.maximum:
                return False
            self.reserved += MAX_PAGE_BYTES
            return True

    def settle(self, actual: int) -> None:
        with self.lock:
            self.reserved -= MAX_PAGE_BYTES
            self.used += actual


def attempt_candidate(candidate: dict, fetcher, budget: ArchiveBudget) -> dict:
    base = {key: candidate.get(key) for key in ("language", "fetchUrl", "issuerKey", "issuerLabel", "issuerAttribution", "sourceLinks", "attributionAmbiguous")}
    if candidate["attributionAmbiguous"]:
        return {**base, "status": "related-unattributed", "detail": "same language and target URL are linked for multiple issuers"}
    if not budget.reserve():
        return {**base, "status": "failed", "failureCode": "aggregate-byte-budget-exceeded",
                "detail": "aggregate byte budget has no room for another bounded plan page"}
    settled = False
    try:
        body, media, final_url, byte_count = fetcher(candidate["fetchUrl"])
        if len(body) > MAX_PAGE_BYTES or byte_count != len(body):
            raise ValueError("target response exceeded byte limit or length metadata disagreed")
        if not _editions.acquisition_official(final_url):
            raise ValueError("target final URL is outside the official HTTPS policy")
        budget.settle(len(body))
        settled = True
        archived = archive_object(candidate["root"], body)
        output = {**base, "finalUrl": final_url, "mediaType": media, "bodyBytes": len(body), "bodySha256": digest(body), "archive": archived}
        if media not in ("text/html", "application/xhtml+xml"):
            return {**output, "status": "failed", "failureCode": "unsupported-media-type", "detail": f"publisher target returned {media}"}
        classification = classify_target(body, final_url, candidate["language"])
        output["targetClassification"] = classification
        if not classification["confirmed"]:
            return {**output, "status": "failed", "failureCode": "target-plan-identity-missing",
                    "detail": "target title or h1 does not identify a forward regulatory plan"}
        output["status"] = "verified"
        return output
    except Exception as error:
        return {**base, "status": "failed", "failureCode": "acquisition-failure", "detail": str(error)[:1000]}
    finally:
        if not settled:
            budget.settle(0)


def refresh(root: Path = DEFAULT_ROOT, edition_root: Path = DEFAULT_EDITION_ROOT,
            max_archive_bytes: int = MAX_ARCHIVE_BYTES, workers: int = MAX_WORKERS, fetcher=None) -> dict:
    root = root.resolve()
    edition_root = edition_root.resolve()
    if not 1 <= workers <= MAX_WORKERS:
        raise ValueError(f"workers must be 1..{MAX_WORKERS}")
    if max_archive_bytes < 1 or shutil.disk_usage(root.parent if root.parent.exists() else ROOT).free < max_archive_bytes + MIN_FREE_BYTES:
        raise RuntimeError("insufficient free space for bounded regulatory plan archive refresh")
    lock_path = root / "dist" / "refresh.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _refresh_locked(root, edition_root, max_archive_bytes, workers, fetcher)


def _refresh_locked(root: Path, edition_root: Path, max_archive_bytes: int, workers: int, fetcher) -> dict:
    input_report, input_bytes, input_sha, source_run_id = load_source_snapshot(edition_root)
    discovery, candidates = collect_discovery_links(input_report, edition_root)
    if not candidates:
        raise ValueError("No explicitly linked forward regulatory plan candidates were verified in current.json")
    previous = load_prior_verified(root)
    source_object = archive_object(root, input_bytes, 8 * 1024 * 1024)
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:12]
    for candidate in candidates:
        candidate["root"] = root
    fetcher = fetcher or _editions.fetch_page
    attempts: dict[tuple[str, str], dict] = {}
    failures = []
    budget = ArchiveBudget(max_archive_bytes)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(attempt_candidate, candidate, fetcher, budget): candidate for candidate in candidates}
        for future in as_completed(futures):
            candidate = futures[future]
            key = (candidate["language"], candidate["fetchUrl"])
            attempt = future.result()
            edition_id = digest("\n".join((str(candidate["language"]), candidate["fetchUrl"])).encode())
            attempt["editionId"] = edition_id
            attempt["attemptedAt"] = utc_now()
            attempt["priorVerifiedVersions"] = previous.get(edition_id, {}).get("verifiedVersions", [])
            attempts[key] = attempt
            if attempt["status"] not in ("verified", "related-unattributed"):
                failures.append({"editionId": edition_id, "language": candidate["language"], "url": candidate["fetchUrl"],
                                 "issuerKey": candidate.get("issuerKey"), "issuerLabel": candidate.get("issuerLabel"),
                                 "issuerAttribution": candidate.get("issuerAttribution"), "failureCode": attempt.get("failureCode"),
                                 "detail": attempt.get("detail"), "priorVerifiedVersions": attempt["priorVerifiedVersions"]})
    plan_editions = []
    related_initiatives = []
    for candidate in candidates:
        attempt = attempts[(candidate["language"], candidate["fetchUrl"])]
        if attempt["status"] != "verified":
            continue
        target = attempt["targetClassification"]
        edition_id = attempt["editionId"]
        version = {"bodySha256": attempt["bodySha256"], "bodyBytes": attempt["bodyBytes"],
                   "archivePath": attempt["archive"]["archivePath"], "finalUrl": attempt["finalUrl"],
                   "verifiedAt": attempt["attemptedAt"]}
        versions = list(attempt["priorVerifiedVersions"])
        if not any(item.get("bodySha256") == version["bodySha256"] for item in versions):
            versions.append(version)
        plan_editions.append({
            "editionId": edition_id, "issuerKey": candidate["issuerKey"], "issuerLabel": candidate["issuerLabel"],
            "issuerAttribution": candidate["issuerAttribution"], "language": candidate["language"],
            "sourceUrl": candidate["fetchUrl"], "finalUrl": attempt["finalUrl"],
            "sourceBodySha256": attempt["bodySha256"], "sourceBodyBytes": attempt["bodyBytes"],
            "sourceArchivePath": attempt["archive"]["archivePath"], "pageTitle": target["pageTitle"],
            "planIdentity": target["identityEvidence"], "planCycles": target["cycles"],
            "initiativeIds": [digest((edition_id + "\n" + row["name"] + "\n" + row["publisherLinkUrl"]).encode()) for row in target["initiatives"]],
            "discoveryIds": [row["discoveryId"] for row in candidate["sourceLinks"]],
            "verifiedAt": attempt["attemptedAt"], "verifiedVersions": versions,
        })
        for initiative in target["initiatives"]:
            related_initiatives.append({"initiativeId": digest((edition_id + "\n" + initiative["name"] + "\n" + initiative["publisherLinkUrl"]).encode()),
                                        "editionId": edition_id, "issuerKey": candidate["issuerKey"], "language": candidate["language"], **initiative})
    plan_editions.sort(key=lambda row: (str(row["issuerKey"]), row["language"], row["sourceUrl"]))
    related_initiatives.sort(key=lambda row: (row["editionId"], row["name"], row["publisherLinkUrl"]))
    verified_attempts = sum(item["status"] == "verified" for item in attempts.values())
    related_count = sum(item["status"].startswith("related") for item in attempts.values())
    failed_count = sum(item["status"] == "failed" for item in attempts.values())
    status = "complete" if failed_count == 0 and verified_attempts + related_count == len(candidates) else "partial"
    report = {
        "schemaVersion": 1, "collection": "federal-regulatory-plans", "runId": run_id,
        "observedAt": utc_now(), "status": status,
        "sourceSnapshot": {"path": repo_path(edition_root / "current.json"), "runId": source_run_id,
                           "sha256": input_sha, "bytes": len(input_bytes), "archivePath": source_object["archivePath"]},
        "scope": "Only explicitly labelled forward regulatory plan links from verified institutional landing pages in the current departmental report edition snapshot are considered. Stock review links and government-wide directories remain related discovery. A plan edition is confirmed only when its target page title or H1 identifies a forward regulatory plan in the source language.",
        "summary": {"discoveryLinks": len(discovery), "forwardPlanCandidates": len(candidates),
                    "verifiedPlanEditions": len(plan_editions), "failedTargets": failed_count,
                    "relatedOrUnattributedTargets": related_count, "namedInitiatives": len(related_initiatives),
                    "archiveBytes": budget.used},
        "discoveryLinks": discovery,
        "attempts": sorted(attempts.values(), key=lambda row: (row["language"], row["fetchUrl"])),
        "planEditions": plan_editions, "relatedInitiatives": related_initiatives,
        "failures": failures,
    }
    report_path = root / "dist" / "generations" / f"{run_id}.json"
    atomic_json(report_path, report)
    report_bytes = report_path.read_bytes()
    receipt = {"schemaVersion": 1, "collection": report["collection"], "runId": run_id, "status": status,
               "completedAt": utc_now(), "reportPath": report_path.relative_to(root).as_posix(),
               "reportSha256": digest(report_bytes), "summary": report["summary"]}
    atomic_json(root / "dist" / "receipt.json", receipt)
    atomic_json(root / "dist" / "latest-attempt.json", receipt)
    return {"receipt": str(root / "dist" / "receipt.json"), "report": str(report_path),
            "runId": run_id, "status": status, "summary": report["summary"]}


def replay(root: Path = DEFAULT_ROOT, run_id: str | None = None) -> dict:
    root = root.resolve()
    pointer = json.loads((root / "dist" / "receipt.json").read_text(encoding="utf-8"))
    selected = run_id or pointer.get("runId")
    report_path = root / "dist" / "generations" / f"{selected}.json"
    raw = report_path.read_bytes()
    if selected == pointer.get("runId") and digest(raw) != pointer.get("reportSha256"):
        raise ValueError("Latest regulatory plan report checksum mismatch")
    report = json.loads(raw)
    if report.get("collection") != "federal-regulatory-plans" or report.get("runId") != selected:
        raise ValueError("Requested generation is not a federal regulatory plan report")
    source = report["sourceSnapshot"]
    source_bytes = read_checked_gzip(inside_root(root, source["archivePath"]), source["sha256"], source["bytes"], 8 * 1024 * 1024)
    parsed_source = json.loads(source_bytes)
    if parsed_source.get("collection") != "departmental-report-editions-current":
        raise ValueError("Archived source snapshot has the wrong collection identity")
    replayed = []
    for attempt in report["attempts"]:
        archive = attempt.get("archive")
        if not archive:
            replayed.append({"editionId": attempt["editionId"], "status": attempt["status"], "archiveVerified": False})
            continue
        body = read_checked_gzip(inside_root(root, archive["archivePath"]), archive["sha256"], archive["bytes"], MAX_PAGE_BYTES)
        is_html = attempt.get("mediaType") in ("text/html", "application/xhtml+xml")
        if is_html and attempt.get("targetClassification"):
            check = classify_target(body, attempt["finalUrl"], attempt["language"])
            if check != attempt["targetClassification"]:
                raise ValueError(f"Archived target extraction differs from generation: {attempt['editionId']}")
        replayed.append({"editionId": attempt["editionId"], "status": attempt["status"], "archiveVerified": True})
    if len(report["planEditions"]) != len({row["editionId"] for row in report["planEditions"]}):
        raise ValueError("Generation contains duplicate plan edition identities")
    return {"runId": selected, "sourceSha256": source["sha256"], "attempts": len(replayed),
            "verifiedArchives": sum(row["archiveVerified"] for row in replayed),
            "planEditions": len(report["planEditions"]), "relatedInitiatives": len(report["relatedInitiatives"]),
            "complete": all(row["archiveVerified"] or row["status"] in ("failed", "related-unattributed") for row in replayed)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    refresh_parser = sub.add_parser("refresh", help="fetch explicitly linked issuer forward-plan pages")
    refresh_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    refresh_parser.add_argument("--edition-root", type=Path, default=DEFAULT_EDITION_ROOT)
    refresh_parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    refresh_parser.add_argument("--max-archive-bytes", type=int, default=MAX_ARCHIVE_BYTES)
    replay_parser = sub.add_parser("replay", help="verify extraction against immutable source page archives")
    replay_parser.add_argument("run_id", nargs="?")
    replay_parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args(argv)
    try:
        result = refresh(args.root, args.edition_root, args.max_archive_bytes, args.workers) if args.command == "refresh" else replay(args.root, args.run_id)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if args.command == "refresh" and result["status"] != "complete":
            return 2
        return 0 if result.get("complete", True) else 2
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"federal-regulatory-plans: {str(error)[:1000]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
