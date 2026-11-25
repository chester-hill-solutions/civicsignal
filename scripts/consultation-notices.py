#!/usr/bin/env python3
"""Archive labelled participation details from open consultation notices."""

from __future__ import annotations

import argparse
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
import sys
import tempfile
import zlib
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.committee_files import GOVERNMENT_SUFFIXES, fetchable, official  # noqa: E402

CATALOGUE = ROOT / "data/corpus/consultations/catalogue.sqlite"
STORE = ROOT / "data/corpus/consultations/notice-index.sqlite"
OBJECTS = ROOT / "data/corpus/consultations/notice-objects"
QUERIES = ROOT / "data/corpus/consultations/notice-queries"
RECEIPTS = ROOT / "data/corpus/consultations/notice-receipts"
MAX_BODY = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 48 * 1024 * 1024
MIN_FREE_BYTES = 96 * 1024 * 1024
USER_AGENT = "CivicSignal local consultation notice archive/1.0"

# These HTTPS engagement hosts are linked as official consultation portals
# from Canada Energy Regulator and Transport Canada pages. Keep this list
# exact-host scoped: it does not bless arbitrary third-party hosts or their
# redirects.
OFFICIAL_ENGAGEMENT_HOSTS = frozenset({
    "www.cerdialogue.ca", "dialogueregie.ca",
    "www.letstalktransportation.ca", "parlonstransport.ca",
})
SAFE_LINKS_HOST = "can01.safelinks.protection.outlook.com"

# Publisher-confirmed replacements for individual catalogue URLs. A preview
# hostname never becomes an eligible fetch destination.
CURRENT_PUBLICATION_URLS = json.loads((ROOT / "src/corpora/consultation-notice-urls.json").read_text(encoding="utf-8"))

LABELS = {
    "eligibility": (
        "eligibility", "who can participate", "who can comment", "who may participate",
        "admissibility", "who is eligible", "qui peut participer", "qui peut commenter",
        "admissibilité", "admissibilite", "personnes admissibles",
        "who is the focus of this consultation", "qui cette consultation vise-t-elle",
    ),
    "deadline": (
        "deadline", "closing date", "consultation closes", "submit by", "comments due",
        "date limite", "échéance", "echeance", "la consultation prend fin",
    ),
    "submission-instructions": (
        "how to participate", "how to submit", "how to submit comments", "submit comments", "send your comments",
        "providing comments", "submitting comments", "comment participer", "comment soumettre",
        "comment déposer des commentaires", "soumettre des commentaires", "transmettre vos commentaires",
        "présenter des commentaires", "how to get involved", "join in: how to participate",
        "joignez-vous à nous : comment participer", "pour participer",
        "participez : comment prendre part à la consultation",
        "online questionnaire and written submissions", "questionnaire en ligne et soumissions écrites",
        "share your ideas online", "partagez vos idées en ligne",
    ),
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normalize_text(value: str) -> str:
    return " ".join(value.split())


def classify_heading(text: str) -> str | None:
    normalized = normalize_text(text).casefold().rstrip(": ?!.)")
    for kind, labels in LABELS.items():
        if any(normalized == label.casefold() or normalized.startswith(label.casefold() + ":") for label in labels):
            return kind
    return None


class NoticeParser(HTMLParser):
    """Extract text only from sections headed by a known participation label."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[dict] = []
        self.sections: list[dict] = []
        self.active: dict | None = None
        self.heading_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        level = int(tag[1]) if len(tag) == 2 and tag[0] == "h" and tag[1].isdigit() else None
        if level is not None:
            if self.active and level <= self.active["level"]:
                self._finish()
            self.heading_depth += 1
            self.stack.append({"tag": tag, "id": attrs.get("id"), "level": level, "text": []})
        else:
            self.stack.append({"tag": tag, "id": attrs.get("id"), "level": None, "text": []})

    def handle_data(self, data):
        for item in self.stack:
            item["text"].append(data)
        if self.active and self.heading_depth == 0:
            self.active["body"].append(data)

    def handle_endtag(self, tag):
        found = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                found = self.stack[i]
                del self.stack[i:]
                break
        if not found or found["level"] is None:
            return
        self.heading_depth = max(0, self.heading_depth - 1)
        heading = normalize_text(" ".join(found["text"]))
        kind = classify_heading(heading)
        if kind:
            self._finish()
            self.active = {"kind": kind, "heading": heading, "fragment": found["id"],
                           "level": found["level"], "body": []}

    def _finish(self):
        if self.active:
            text = normalize_text(" ".join(self.active.pop("body")))
            if text:
                self.active["text"] = text
                self.sections.append(self.active)
            self.active = None

    def close(self):
        super().close()
        self._finish()


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not notice_official(newurl):
            raise ValueError("redirect leaves the recognized official-host set")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def notice_official(url: str) -> bool:
    """HTTPS GoC hosts and a small set of agency-linked public portals."""
    if official(url):
        return True
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname in OFFICIAL_ENGAGEMENT_HOSTS
            and not parsed.username and not parsed.password)


def unwrap_official_safe_link(profile: dict) -> str | None:
    """Read an embedded official destination without contacting the wrapper."""
    candidate = profile.get("published")
    if not candidate:
        return None
    parsed = urlsplit(candidate)
    if parsed.scheme != "https" or parsed.hostname != SAFE_LINKS_HOST or parsed.username or parsed.password:
        return None
    values = parse_qs(parsed.query, keep_blank_values=True).get("url", [])
    if len(values) != 1:
        return None
    target = values[0]
    catalogue_target = profile.get("unwrapped") or profile.get("url")
    return target if target == catalogue_target and notice_official(target) else None


def current_publication_url(url: str) -> str:
    return CURRENT_PUBLICATION_URLS.get(url, url)


def fetch(url: str) -> tuple[bytes, str, str]:
    opener = build_opener(SafeRedirect())
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    with opener.open(request, timeout=35) as response:
        final_url = response.geturl()
        if not notice_official(final_url):
            raise ValueError("final URL is outside the recognized official-host set")
        if response.status != 200:
            raise HTTPError(final_url, response.status, "publisher did not return a complete notice", response.headers, None)
        media = response.headers.get_content_type().lower()
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError(f"response exceeds {MAX_BODY} byte per-notice limit")
        if media not in ("text/html", "application/xhtml+xml"):
            raise ValueError("unexpected content type: " + media)
        return body, media, final_url


def validate_notice_body(body: bytes, source_url: str) -> None:
    if not body.strip():
        raise ValueError("publisher returned an empty notice")
    lowered = body.lower()
    if b"<noscript" in lowered and b"we need to verify that you're not a robot" in lowered:
        raise ValueError("publisher returned a browser verification page")
    source = urlsplit(source_url)
    if (source.hostname in ("species-registry.canada.ca", "registre-especes.canada.ca") and source.fragment.startswith("/documents/")
            and re.search(rb"""<div\s+id=["']?app["']?\s*>\s*</div>""", lowered)):
        raise ValueError("species registry returned the app shell without the requested document")


def verified_original(entry: dict) -> bool:
    digest = entry.get("bodySha256", "")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        return False
    path = OBJECTS / digest[:2] / (digest + ".html.gz")
    if entry.get("objectPath") != str(path.relative_to(ROOT)):
        return False
    try:
        with gzip.open(path, "rb") as stream:
            body = stream.read(MAX_BODY + 1)
        validate_notice_body(body, entry["sourceUrl"])
        return len(body) == entry.get("bodyBytes") and hashlib.sha256(body).hexdigest() == digest
    except (OSError, EOFError, ValueError, zlib.error):
        return False


def db_open(path: Path = STORE) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS notices(
      catalogue_revision TEXT NOT NULL, catalogue_observed_at TEXT NOT NULL,
      consultation_id TEXT NOT NULL, language TEXT NOT NULL, status TEXT NOT NULL,
      published_url TEXT, final_url TEXT, checked_at TEXT NOT NULL,
      http_status INTEGER, media_type TEXT, body_sha256 TEXT, body_bytes INTEGER,
      object_path TEXT, sections_json TEXT NOT NULL, detail TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]',
      last_attempt_status TEXT, last_attempt_at TEXT, last_attempt_detail TEXT,
      PRIMARY KEY(catalogue_revision, consultation_id, language))""")
    columns = {row[1] for row in db.execute("PRAGMA table_info(notices)")}
    for name in ("last_attempt_status", "last_attempt_at", "last_attempt_detail"):
        if name not in columns:
            db.execute(f"ALTER TABLE notices ADD COLUMN {name} TEXT")
    if "sources_json" not in columns:
        db.execute("ALTER TABLE notices ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'")
    db.execute("""CREATE TABLE IF NOT EXISTS notice_attempts(
      attempt_id INTEGER PRIMARY KEY, catalogue_revision TEXT NOT NULL, consultation_id TEXT NOT NULL,
      language TEXT NOT NULL, attempted_at TEXT NOT NULL, requested_url TEXT, outcome TEXT NOT NULL,
      http_status INTEGER, detail TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS queries(
      catalogue_revision TEXT NOT NULL, consultation_id TEXT NOT NULL, language TEXT NOT NULL,
      queried_at TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(catalogue_revision, consultation_id, language))""")
    return db


def archive_body(body: bytes) -> tuple[str, str]:
    digest = hashlib.sha256(body).hexdigest()
    path = OBJECTS / digest[:2] / (digest + ".html.gz")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with gzip.open(path, "rb") as existing:
            if existing.read(len(body) + 1) == body:
                return digest, str(path.relative_to(ROOT))
    except (OSError, EOFError, zlib.error):
        pass
    fd, temporary = tempfile.mkstemp(prefix=".notice-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                compressed.write(body)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return digest, str(path.relative_to(ROOT))


def parse_sections(body: bytes) -> list[dict]:
    parser = NoticeParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    parser.close()
    return parser.sections


def latest_catalogue(db: sqlite3.Connection):
    # Pin both catalogue pointer and records to one SQLite read snapshot so a
    # simultaneous daily catalogue publication cannot mix two observations.
    db.execute("BEGIN")
    cat = db.execute("SELECT observed_at,revision FROM consultations_catalogues WHERE source='canada' ORDER BY observed_at DESC LIMIT 1").fetchone()
    if not cat:
        raise RuntimeError("consultation catalogue has no Canada observation")
    records = db.execute("""SELECT id, state_at_observation, observed_at, revision, facts_json
      FROM consultations_records WHERE removed_at IS NULL AND observed_at=? AND state_at_observation='open'
      ORDER BY id""", (cat["observed_at"],)).fetchall()
    return cat, records


def local_link(profile: dict | None) -> tuple[str, str | None, str | None]:
    if not profile:
        return "missing-link", None, "edition has no profile link"
    kind, url = profile.get("kind", "missing"), profile.get("url")
    if not url:
        return "missing-link", profile.get("published"), "catalogue has no resolved profile URL"
    if kind == "third-party-wrapper":
        url = unwrap_official_safe_link(profile)
        if not url:
            return "unrecognized-link-kind", profile.get("published") or profile.get("url"), \
                "catalogue wrapper does not contain one recognized official HTTPS destination"
    elif kind != "official":
        return "unrecognized-link-kind", profile.get("published") or url, f"catalogue link kind is {kind}"
    url = current_publication_url(url)
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "unrecognized-url", profile.get("published") or url, "catalogue URL is not an absolute HTTP(S) URL"
    if "." not in parsed.hostname:
        return "unrecognized-url", profile.get("published") or url, "catalogue URL contains a placeholder or incomplete host"
    if parsed.scheme == "http":
        if not fetchable(url):
            return "unrecognized-url", profile.get("published") or url, "insecure HTTP link cannot be safely upgraded to HTTPS"
        if (parsed.hostname or "").endswith(GOVERNMENT_SUFFIXES):
            url = urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    if not notice_official(url):
        return "unrecognized-host", profile.get("published") or url, "URL host is outside the recognized official-host set"
    return "pending", url, None


def record_notice(db, revision, observed_at, cid, language, status, url, **kwargs):
    fields = {"final_url": None, "checked_at": utc_now(), "http_status": None, "media_type": None,
              "body_sha256": None, "body_bytes": None, "object_path": None, "sections_json": "[]", "detail": None,
              "sources_json": "[]",
              "last_attempt_status": None, "last_attempt_at": None, "last_attempt_detail": None}
    fields.update(kwargs)
    db.execute("""INSERT OR REPLACE INTO notices(catalogue_revision,catalogue_observed_at,consultation_id,language,
      status,published_url,final_url,checked_at,http_status,media_type,body_sha256,body_bytes,object_path,sections_json,detail,
      sources_json,last_attempt_status,last_attempt_at,last_attempt_detail)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
      (revision, observed_at, cid, language, status, url, fields["final_url"], fields["checked_at"], fields["http_status"],
       fields["media_type"], fields["body_sha256"], fields["body_bytes"], fields["object_path"], fields["sections_json"], fields["detail"],
       fields["sources_json"], fields["last_attempt_status"], fields["last_attempt_at"], fields["last_attempt_detail"]))


def split_profile_urls(url: str) -> list[str]:
    """Split only the catalogue's exact space-semicolon-space multi-link shape."""
    decoded = unquote(url)
    parts = [part.strip() for part in decoded.split(" ; ")]
    if len(parts) == 1:
        return [url]
    if all(notice_official(part) for part in parts):
        return parts
    return [url]


def _log_attempt(db, revision, cid, language, url, outcome, detail=None, http_status=None):
    attempted_at = utc_now()
    db.execute("INSERT INTO notice_attempts(catalogue_revision,consultation_id,language,attempted_at,requested_url,outcome,http_status,detail) VALUES(?,?,?,?,?,?,?,?)",
               (revision, cid, language, attempted_at, url, outcome, http_status, detail))
    return attempted_at


def _previous_sources(previous):
    if not previous:
        return []
    try:
        sources = json.loads(previous["sources_json"] or "[]")
    except (KeyError, TypeError, json.JSONDecodeError):
        sources = []
    if sources:
        return sources
    if previous["body_sha256"]:
        url = previous["published_url"]
        sections = json.loads(previous["sections_json"] or "[]")
        for section in sections:
            section.setdefault("sourceUrl", url)
            section.setdefault("bodySha256", previous["body_sha256"])
        return [{"sourceUrl": url, "finalUrl": previous["final_url"], "status": "fetched",
                 "mediaType": previous["media_type"], "bodySha256": previous["body_sha256"],
                 "bodyBytes": previous["body_bytes"], "objectPath": previous["object_path"],
                 "sections": sections}]
    return []


def _log_attempt(db, revision, cid, language, url, outcome, detail=None, http_status=None):
    attempted_at = utc_now()
    db.execute("INSERT INTO notice_attempts(catalogue_revision,consultation_id,language,attempted_at,requested_url,outcome,http_status,detail) VALUES(?,?,?,?,?,?,?,?)",
               (revision, cid, language, attempted_at, url, outcome, http_status, detail))
    return attempted_at


def refresh(catalogue: Path = CATALOGUE, store: Path = STORE, fetcher=fetch, total_budget=MAX_ARCHIVE_BYTES,
            receipt_root: Path = RECEIPTS, consultation_ids: set[str] | None = None):
    free = shutil.disk_usage(ROOT).free
    if free < MIN_FREE_BYTES:
        raise RuntimeError(f"notice intake requires {MIN_FREE_BYTES} free bytes; currently {free}")
    source = sqlite3.connect(catalogue); source.row_factory = sqlite3.Row
    target = db_open(store)
    counts: dict[str, int] = {}
    bytes_archived = 0
    try:
        cat, records = latest_catalogue(source)
        if consultation_ids:
            records = [record for record in records if record["id"] in consultation_ids]
            found_ids = {record["id"] for record in records}
            missing_ids = consultation_ids - found_ids
            if missing_ids:
                raise ValueError("selected IDs are not current open consultations: " + ", ".join(sorted(missing_ids)))
        revision, observed = cat["revision"], cat["observed_at"]
        target.execute("BEGIN IMMEDIATE")
        seen_urls: dict[str, dict] = {}
        network_attempts = 0
        for record in records:
            facts = json.loads(record["facts_json"])
            for language in ("en", "fr"):
                edition = facts.get("editions", {}).get(language) or {}
                profile = edition.get("profile")
                state, url, detail = local_link(profile)
                published_url = (profile or {}).get("published") or (profile or {}).get("url")
                if state != "pending":
                    record_notice(target, revision, observed, record["id"], language, state, url, detail=detail)
                    counts[state] = counts.get(state, 0) + 1
                    continue
                source_urls = [current_publication_url(source) for source in split_profile_urls(url)]
                previous = target.execute("SELECT * FROM notices WHERE catalogue_revision=? AND consultation_id=? AND language=?",
                                          (revision, record["id"], language)).fetchone()
                previous_sources = [entry for entry in _previous_sources(previous) if verified_original(entry)]
                source_entries = []
                source_errors = []
                latest_attempt = utc_now()
                for source_url in source_urls:
                    old_source = next((s for s in previous_sources if s.get("bodySha256") and
                                       current_publication_url(s.get("sourceUrl")) == source_url), None)
                    if source_url in seen_urls:
                        entry = dict(seen_urls[source_url])
                        entry["lastAttemptStatus"] = "reused"
                        entry["catalogueUrl"] = published_url
                        source_entries.append(entry)
                        counts["fetched-reused-url"] = counts.get("fetched-reused-url", 0) + 1
                        continue
                    if bytes_archived >= total_budget:
                        err = f"weekly archive budget of {total_budget} raw bytes reached"
                        attempted_at = _log_attempt(target, revision, record["id"], language, source_url, "archive-budget", err)
                        latest_attempt = attempted_at
                        source_errors.append(err)
                        counts["archive-budget"] = counts.get("archive-budget", 0) + 1
                        entry = dict(old_source) if old_source else {"sourceUrl": source_url, "status": "archive-budget"}
                        entry.update(catalogueUrl=published_url, lastAttemptStatus="archive-budget",
                                     lastAttemptAt=attempted_at, lastAttemptDetail=err)
                        source_entries.append(entry)
                        continue
                    try:
                        network_attempts += 1
                        body, media, final_url = fetcher(source_url)
                        validate_notice_body(body, source_url)
                        if bytes_archived + len(body) > total_budget:
                            err = f"response would exceed weekly archive budget of {total_budget} raw bytes"
                            attempted_at = _log_attempt(target, revision, record["id"], language, source_url, "archive-budget", err)
                            latest_attempt = attempted_at
                            source_errors.append(err)
                            counts["archive-budget"] = counts.get("archive-budget", 0) + 1
                            entry = dict(old_source) if old_source else {"sourceUrl": source_url, "status": "archive-budget"}
                            entry.update(catalogueUrl=published_url, lastAttemptStatus="archive-budget",
                                         lastAttemptAt=attempted_at, lastAttemptDetail=err)
                            source_entries.append(entry)
                            continue
                        digest, objpath = archive_body(body)
                        sections = parse_sections(body)
                        for section in sections:
                            section["sourceUrl"] = source_url
                            section["bodySha256"] = digest
                        bytes_archived += len(body)
                        attempted_at = _log_attempt(target, revision, record["id"], language, source_url, "fetched")
                        latest_attempt = attempted_at
                        entry = {"sourceUrl": source_url, "finalUrl": final_url, "status": "fetched",
                                 "mediaType": media, "bodySha256": digest, "bodyBytes": len(body),
                                 "objectPath": objpath, "sections": sections,
                                 "catalogueUrl": published_url,
                                 "lastAttemptStatus": "fetched", "lastAttemptAt": attempted_at}
                        seen_urls[source_url] = entry
                        source_entries.append(entry)
                        counts["fetched"] = counts.get("fetched", 0) + 1
                    except HTTPError as e:
                        attempted_at = _log_attempt(target, revision, record["id"], language, source_url, "http-error", str(e), e.code)
                        latest_attempt = attempted_at
                        counts["http-error"] = counts.get("http-error", 0) + 1
                        err = str(e)
                        source_errors.append(err)
                        entry = dict(old_source) if old_source else {"sourceUrl": source_url, "status": "http-error", "httpStatus": e.code}
                        entry.update(catalogueUrl=published_url, lastAttemptStatus="http-error",
                                     lastAttemptAt=attempted_at, lastAttemptDetail=err)
                        source_entries.append(entry)
                    except (URLError, TimeoutError, OSError, ValueError) as e:
                        attempted_at = _log_attempt(target, revision, record["id"], language, source_url, "fetch-error", str(e)[:1000])
                        latest_attempt = attempted_at
                        counts["fetch-error"] = counts.get("fetch-error", 0) + 1
                        err = str(e)[:1000]
                        source_errors.append(err)
                        entry = dict(old_source) if old_source else {"sourceUrl": source_url, "status": "fetch-error"}
                        entry.update(catalogueUrl=published_url, lastAttemptStatus="fetch-error",
                                     lastAttemptAt=attempted_at, lastAttemptDetail=err)
                        source_entries.append(entry)

                published_sources = [entry for entry in source_entries if entry.get("bodySha256")]
                aggregate_sections = [section for entry in source_entries for section in entry.get("sections", [])]
                if published_sources:
                    row_status = "fetched"
                    last_status = "partial" if source_errors else "fetched"
                else:
                    row_status = next((entry.get("status") for entry in source_entries
                                       if entry.get("status") in ("http-error", "fetch-error", "archive-budget")), "fetch-error")
                    last_status = row_status
                single_source = len(published_sources) == 1
                only_source = published_sources[0] if single_source else {}
                detail = "; ".join(source_errors)[:2000] if source_errors else None
                record_notice(target, revision, observed, record["id"], language, row_status, published_url,
                              final_url=only_source.get("finalUrl"), media_type=only_source.get("mediaType"),
                              body_sha256=only_source.get("bodySha256"),
                              body_bytes=sum(entry.get("bodyBytes", 0) or 0 for entry in published_sources),
                              object_path=only_source.get("objectPath"),
                              sections_json=json.dumps(aggregate_sections, ensure_ascii=False),
                              sources_json=json.dumps(source_entries, ensure_ascii=False), detail=detail,
                              last_attempt_status=last_status, last_attempt_at=latest_attempt,
                              last_attempt_detail=detail)
                if row_status == "fetched":
                    counts["published-editions"] = counts.get("published-editions", 0) + 1
        target.commit()
        result = {"catalogueRevision": revision, "catalogueObservedAt": observed, "openConsultations": len(records),
                  "editions": len(records) * 2, "counts": counts, "rawBytesArchived": bytes_archived,
                  "diskFreeBytesAtStart": free,
                  "scope": "selected" if consultation_ids else "all-open",
                  "selectedConsultationIds": sorted(consultation_ids) if consultation_ids else None,
                  "attemptedFetches": network_attempts,
                  "publishedFetchedEditions": target.execute("SELECT COUNT(*) FROM notices WHERE catalogue_revision=? AND status='fetched'", (revision,)).fetchone()[0],
                  "publishedArchivedSources": sum(sum(bool(source.get("bodySha256")) for source in json.loads(row[0] or "[]")) for row in target.execute(
                      "SELECT sources_json FROM notices WHERE catalogue_revision=? AND status='fetched'", (revision,))) }
        _write_receipt(result, receipt_root)
        return result
    except Exception:
        target.rollback()
        raise
    finally:
        source.close(); target.close()


def _write_receipt(result, receipt_root):
    receipt_root.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    payload = json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    for path in (receipt_root / f"{stamp}.json", receipt_root / "latest.json"):
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(payload)
        os.replace(temp, path)


def query(consultation_id: str, language: str, revision: str | None = None, store: Path = STORE,
          catalogue: Path = CATALOGUE) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", consultation_id) or consultation_id in (".", ".."):
        raise ValueError("consultation ID contains unsupported path characters")
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    source = sqlite3.connect(catalogue); source.row_factory = sqlite3.Row
    db = db_open(store)
    try:
        cat = source.execute("SELECT revision FROM consultations_catalogues WHERE source='canada' ORDER BY observed_at DESC LIMIT 1").fetchone()
        revision = revision or (cat["revision"] if cat else None)
        if not revision:
            raise RuntimeError("consultation catalogue has no revision")
        row = db.execute("SELECT * FROM notices WHERE catalogue_revision=? AND consultation_id=? AND language=?",
                         (revision, consultation_id, language)).fetchone()
        if not row:
            raise KeyError(f"no archived notice result for {consultation_id}/{language} at revision {revision}")
        result = {"consultationId": consultation_id, "language": language, "catalogueRevision": revision,
                  "catalogueObservedAt": row["catalogue_observed_at"], "status": row["status"],
                  "sourceUrl": row["published_url"], "finalUrl": row["final_url"], "checkedAt": row["checked_at"],
                  "httpStatus": row["http_status"], "mediaType": row["media_type"], "bodySha256": row["body_sha256"],
                  "bodyBytes": row["body_bytes"], "objectPath": row["object_path"],
                  "sections": json.loads(row["sections_json"]), "detail": row["detail"],
                  "sources": json.loads(row["sources_json"] or "[]"),
                  "lastAttemptStatus": row["last_attempt_status"], "lastAttemptAt": row["last_attempt_at"],
                  "lastAttemptDetail": row["last_attempt_detail"]}
        db.execute("INSERT OR REPLACE INTO queries VALUES(?,?,?,?,?)",
                   (revision, consultation_id, language, utc_now(), json.dumps(result, ensure_ascii=False, sort_keys=True)))
        db.commit()
        path = QUERIES / revision / consultation_id / f"{language}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        os.replace(temp, path)
        return result
    finally:
        source.close(); db.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    ref = sub.add_parser("refresh", help="archive open catalogue notice editions")
    ref.add_argument("--catalogue", type=Path, default=CATALOGUE)
    ref.add_argument("--store", type=Path, default=STORE)
    ref.add_argument("--only-id", action="append", default=[], help="refresh one current open consultation ID; repeatable")
    qry = sub.add_parser("query", help="read one exact ID/language/revision result")
    qry.add_argument("consultation_id")
    qry.add_argument("language", choices=("en", "fr"))
    qry.add_argument("--revision")
    qry.add_argument("--store", type=Path, default=STORE)
    qry.add_argument("--catalogue", type=Path, default=CATALOGUE)
    args = parser.parse_args(argv)
    try:
        result = refresh(args.catalogue, args.store, consultation_ids=set(args.only_id) or None) if args.command == "refresh" else query(
            args.consultation_id, args.language, args.revision, args.store, args.catalogue)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        if args.command == "refresh" and any(result["counts"].get(status, 0) for status in ("fetch-error", "http-error", "archive-budget")):
            return 1
        return 0
    except Exception as e:
        print(f"consultation-notices: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
