"""Replayable, source-preserving intake for federal briefing note CSVs."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import unicodedata

from lib.parliament_intake import atomic_write, save_atomic

DATASET = "https://open.canada.ca/data/en/dataset/ee9bd7e8-90a5-45db-9287-85c8cf3589b6"
MAIN_URL = ("https://open.canada.ca/data/dataset/ee9bd7e8-90a5-45db-9287-85c8cf3589b6/"
            "resource/299a2e26-5103-4a49-ac3a-53db9fcc06c7/download/briefingt.csv")
NIL_URL = ("https://open.canada.ca/data/dataset/ee9bd7e8-90a5-45db-9287-85c8cf3589b6/"
           "resource/5e28b544-720b-4745-9e55-3aac6464a4fb/download/briefingt-nil.csv")
SCHEMA_URL = "https://open.canada.ca/data/recombinant-published-schema/briefingt.json"
SEARCH_EN = "https://search.open.canada.ca/briefing_titles/"
SEARCH_FR = "https://rechercher.ouvert.canada.ca/notesdinfo"
MAIN_FIELDS = ("tracking_number", "title_en", "title_fr", "originating_sector_en",
               "originating_sector_fr", "addressee", "date_received", "action_required",
               "additional_information_en", "additional_information_fr", "owner_org", "owner_org_title")
NIL_FIELDS = ("year", "month", "owner_org", "owner_org_title")
REDACTED = re.compile(r"^(?:redacted|caviard[ée]|withheld|exempt(?:ed)?)$", re.I)
FIXED_HEADROOM = 64 * 1024 * 1024


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    """Allow only the portal and its official Azure blob download host."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.netloc.lower() not in {"open.canada.ca", "opencanada.blob.core.windows.net"}:
            raise ValueError(f"Unexpected briefing source redirect: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def probe(url: str):
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "CivicSignal/0.1"})
    try:
        with urllib.request.build_opener(OfficialRedirect()).open(request, timeout=20) as response:
            return {"url": url, "status": response.status, "resolved_url": urllib.parse.urlsplit(response.geturl())._replace(query="", fragment="").geturl(),
                    "content_length": response.headers.get("Content-Length"),
                    "content_type": response.headers.get("Content-Type"),
                    "last_modified": response.headers.get("Last-Modified"), "etag": response.headers.get("ETag")}
    except (urllib.error.URLError, TimeoutError) as error:
        return {"url": url, "error": str(error)}


def validate_schema(schema: dict):
    if schema.get("dataset_type") != "briefingt":
        raise ValueError("Schema dataset_type is not briefingt")
    resources = schema.get("resources")
    resource = next((item for item in resources or [] if item.get("resource_name") == "briefingt"), None)
    if resource is None:
        raise ValueError("Schema has no briefingt resource")
    field_ids = {field.get("id") for field in resource.get("fields", [])}
    missing = sorted(set(MAIN_FIELDS[:10]) - field_ids)
    if missing:
        raise ValueError(f"Schema does not define expected briefing fields: {', '.join(missing)}")
    return resource


def _header_map(fieldnames):
    return {name.strip().lower(): name for name in (fieldnames or [])}


def _validate_header(fieldnames, kind):
    headers = set(_header_map(fieldnames))
    required = MAIN_FIELDS if kind == "main" else NIL_FIELDS
    missing = [field for field in required if field not in headers]
    if missing:
        raise ValueError(f"Official {kind} CSV missing expected fields: {', '.join(missing)}")


def _read_header(path: Path):
    """Read only the UTF-8 header row, avoiding decoding a truncated multibyte sample."""
    with path.open("rb") as stream:
        first_line = stream.readline()
    return next(csv.reader([first_line.decode("utf-8-sig", errors="strict")]))


def summarize_csv(path: Path, kind: str):
    """Stream rows so source size does not translate into a large in-memory list."""
    summary = {"rows": 0, "headers": [], "organizations": set(), "period_rows": {}, "year_forms": {},
               "date_min": None, "date_max": None, "title_en_redacted": 0,
               "title_fr_redacted": 0, "title_en_missing": 0, "title_fr_missing": 0,
               "bilingual_title_rows": 0}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        headers = _header_map(reader.fieldnames)
        _validate_header(reader.fieldnames, kind)
        summary["headers"] = list(reader.fieldnames or [])
        for line, row in enumerate(reader, start=2):
            if None in row:
                raise ValueError(f"{kind} CSV row {line} has extra cells")
            summary["rows"] += 1
            owner = (row.get(headers["owner_org"]) or "").strip()
            owner_title = (row.get(headers["owner_org_title"]) or "").strip()
            if owner or owner_title:
                summary["organizations"].add((owner, owner_title))
            if kind == "main":
                tracking = (row.get(headers["tracking_number"]) or "").strip()
                date = (row.get(headers["date_received"]) or "").strip()
                if not tracking:
                    raise ValueError(f"main CSV row {line} has no tracking number")
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                    raise ValueError(f"main CSV row {line} has invalid date_received: {date}")
                try:
                    datetime.strptime(date, "%Y-%m-%d")
                except ValueError as error:
                    raise ValueError(f"main CSV row {line} has invalid date_received: {date}") from error
                summary["date_min"] = min(date, summary["date_min"] or date)
                summary["date_max"] = max(date, summary["date_max"] or date)
                title_en = (row.get(headers["title_en"]) or "").strip()
                title_fr = (row.get(headers["title_fr"]) or "").strip()
                summary["title_en_redacted"] += bool(REDACTED.fullmatch(title_en))
                summary["title_fr_redacted"] += bool(REDACTED.fullmatch(title_fr))
                summary["title_en_missing"] += not bool(title_en)
                summary["title_fr_missing"] += not bool(title_fr)
                summary["bilingual_title_rows"] += bool(title_en and title_fr)
            else:
                year = (row.get(headers["year"]) or "").strip()
                month = (row.get(headers["month"]) or "").strip()
                if not re.fullmatch(r"\d{2}|\d{4}", year) or not re.fullmatch(r"\d{1,2}", month):
                    raise ValueError(f"nil CSV row {line} has invalid year/month: {year}/{month}")
                summary["year_forms"][year] = summary["year_forms"].get(year, 0) + 1
                normalized_year = f"20{year}" if len(year) == 2 else year
                month = f"{int(month):02d}"
                if not 1 <= int(month) <= 12:
                    raise ValueError(f"nil CSV row {line} has out-of-range month: {month}")
                period = f"{normalized_year}-{month}"
                summary["period_rows"][period] = summary["period_rows"].get(period, 0) + 1
    summary["organizations"] = [dict(owner_org=owner, owner_org_title=title)
                                for owner, title in sorted(summary["organizations"])]
    return summary


def _archive_file(root: Path, source: Path, source_url: str):
    hex_digest = file_sha256(source)
    target = root / "sources" / "objects" / hex_digest[:2] / hex_digest
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        check = file_sha256(target)
        if check != hex_digest:
            raise ValueError(f"Corrupt immutable source object: {target}")
    else:
        atomic_copy(source, target)
    return {"url": source_url, "sha256": hex_digest, "bytes": source.stat().st_size, "object": str(target)}


def file_sha256(path: Path):
    digest = sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_copy(source: Path, target: Path):
    """Copy a file to a temporary sibling, fsync, then atomically expose it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with source.open("rb") as incoming, temporary.open("wb") as outgoing:
            shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def ingest(main_path: Path, nil_path: Path, schema_path: Path | None, output_root: Path,
           source_observations=None, observed_at=None):
    main = summarize_csv(main_path, "main")
    nil = summarize_csv(nil_path, "nil")
    schema_bytes = schema_path.read_bytes() if schema_path else None
    schema = json.loads(schema_bytes) if schema_bytes else None
    if schema is not None:
        validate_schema(schema)
    root = Path(output_root) / "data" / "corpus" / "briefing-notes"
    out = Path(output_root) / "dist" / "briefing-notes"
    sources = {"main": _archive_file(root, main_path, MAIN_URL),
               "nil": _archive_file(root, nil_path, NIL_URL)}
    if schema_bytes is not None:
        schema_path = Path(schema_path)
        sources["schema"] = _archive_file(root, schema_path, SCHEMA_URL)
    packet = {
        "collection": "federal-briefing-note-titles",
        "observed_at": observed_at or datetime.now(timezone.utc).isoformat(),
        "dataset_url": DATASET,
        "search_urls": {"en": SEARCH_EN, "fr": SEARCH_FR},
        "schema_status": "validated-and-archived" if schema is not None else "not-provided",
        "schema_identity": {"dataset_type": schema.get("dataset_type"), "resource_name": "briefingt"} if schema else None,
        "source_observations": source_observations or {},
        "sources": sources,
        "main": {
            "rows": main["rows"], "headers": main["headers"],
            "date_received_min": main["date_min"], "date_received_max": main["date_max"],
            "institutions_seen": len(main["organizations"]), "institutions": main["organizations"],
            "title_en_redacted": main["title_en_redacted"], "title_fr_redacted": main["title_fr_redacted"],
            "title_en_missing": main["title_en_missing"], "title_fr_missing": main["title_fr_missing"],
            "bilingual_title_rows": main["bilingual_title_rows"],
            "public_text": "titles and metadata only; underlying briefing note texts are not provided by this register",
        },
        "nil": {"rows": nil["rows"], "headers": nil["headers"],
                "reporting_period_rows": nil["period_rows"], "source_year_value_rows": nil["year_forms"],
                "institutions": nil["organizations"],
                "note": "Each row is an institution's reported nothing-to-report return for that year and month. "
                        "Two-digit source years are interpreted as 20xx for period grouping; raw source bytes are retained."},
        "coverage_limitations": [
            "Source-provided redacted titles remain redacted and are not reconstructed.",
            "The register omits titles relating to Cabinet confidences and may withhold titles under applicable exemptions.",
            "This receipt describes the supplied snapshots and does not establish completeness of institutional reporting.",
            "The title register does not include the underlying briefing note documents or their full text.",
        ],
    }
    out.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode()
    digest = sha256(encoded).hexdigest()
    inventory = root / "inventories" / f"{digest}.json"
    if inventory.exists() and sha256(inventory.read_bytes()).hexdigest() != digest:
        raise ValueError(f"Corrupt immutable inventory: {inventory}")
    if not inventory.exists():
        atomic_write(inventory, encoded)
    packet["inventory"] = {"path": str(inventory), "sha256": digest}
    save_atomic(out / "receipt.json", packet)
    return packet


def download_to(url: str, path: Path, expected_bytes: int, expected_etag: str | None,
                expected_last_modified: str | None):
    request = urllib.request.Request(url, headers={"User-Agent": "CivicSignal/0.1", "Accept-Encoding": "identity"})
    opener = urllib.request.build_opener(OfficialRedirect())
    total = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with opener.open(request, timeout=60) as response, path.open("xb") as output:
            if response.headers.get("Content-Length") != str(expected_bytes):
                raise ValueError(f"Content-Length changed after HEAD; rerun to re-probe: {url}")
            if expected_etag and response.headers.get("ETag") != expected_etag:
                raise ValueError(f"ETag changed after HEAD; rerun to re-probe: {url}")
            if expected_last_modified and response.headers.get("Last-Modified") != expected_last_modified:
                raise ValueError(f"Last-Modified changed after HEAD; rerun to re-probe: {url}")
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                total += len(chunk)
                if total > expected_bytes:
                    raise ValueError(f"Source grew beyond preflight Content-Length: {url}")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if total != expected_bytes:
            raise ValueError(f"Downloaded {total} bytes, expected {expected_bytes}: {url}")
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def reusable_object(root, name, prior, current):
    previous = prior.get("source_observations", {}).get(name, {})
    source = prior.get("sources", {}).get(name, {})
    etag = current.get("etag")
    if not etag or etag.startswith("W/") or not all(previous.get(k) == current.get(k)
            for k in ("url", "etag", "content_length")):
        return None
    digest = source.get("sha256", "")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        return None
    path = root / "sources" / "objects" / digest[:2] / digest
    if path.is_file() and path.stat().st_size == int(current["content_length"]) and file_sha256(path) == digest:
        return path
    return None


def fetch_official(output_root: Path):
    """Preflight remote lengths/disk, stage sources, validate, then atomically publish a receipt."""
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)
    root = output_root / "data" / "corpus" / "briefing-notes"
    root.mkdir(parents=True, exist_ok=True)
    with (root / "intake.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        specs = {"main": MAIN_URL, "nil": NIL_URL, "schema": SCHEMA_URL}
        heads = {name: probe(url) for name, url in specs.items()}
        errors = [f"{name}: {result.get('error')}" for name, result in heads.items() if result.get("error")]
        if errors:
            raise ValueError("Could not preflight official sources: " + "; ".join(errors))
        sizes = {}
        for name in specs:
            try:
                sizes[name] = int(heads[name]["content_length"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"No valid Content-Length for {name}; refusing unbounded download") from error
            if sizes[name] <= 0:
                raise ValueError(f"Invalid Content-Length for {name}; refusing download")
        receipt_path = output_root / "dist/briefing-notes/receipt.json"
        prior = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {}
        files = {name: reusable_object(root, name, prior, heads[name]) for name in specs}
        # New downloads and their new immutable archive can coexist.
        required = 2 * sum(sizes[name] for name in specs if files[name] is None) + FIXED_HEADROOM
        available = shutil.disk_usage(output_root).free
        if available < required:
            raise ValueError(f"Insufficient disk space: require {required} bytes ({required / 1048576:.1f} MiB), "
                             f"available {available} bytes ({available / 1048576:.1f} MiB)")

        filenames = {"main": "main.csv", "nil": "nil.csv", "schema": "schema.json"}
        with tempfile.TemporaryDirectory(prefix=".staging-", dir=root) as staging_name:
            staging = Path(staging_name)
            for name, url in specs.items():
                if files[name] is None:
                    files[name] = staging / filenames[name]
                    download_to(url, files[name], sizes[name], heads[name].get("etag"), heads[name].get("last_modified"))
            schema = json.loads(files["schema"].read_text(encoding="utf-8"))
            validate_schema(schema)
            for name in ("main", "nil"):
                _validate_header(_read_header(files[name]), name)
            return ingest(files["main"], files["nil"], files["schema"], output_root, heads)


def replay(output_root: Path):
    """Rebuild the current inventory from its archived source objects without downloading."""
    output_root = Path(output_root)
    receipt_path = output_root / "dist" / "briefing-notes" / "receipt.json"
    prior = json.loads(receipt_path.read_text(encoding="utf-8"))
    sources = prior.get("sources", {})
    main_path = Path(sources["main"]["object"])
    nil_path = Path(sources["nil"]["object"])
    schema_path = Path(sources["schema"]["object"]) if sources.get("schema") else None
    return ingest(main_path, nil_path, schema_path, output_root, prior.get("source_observations"),
                  prior.get("observed_at"))


def search_records(csv_path: Path, query: str, limit: int = 10):
    """Stream bilingual title/metadata search from an archived main CSV."""
    needle = unicodedata.normalize("NFKC", query).casefold().strip()
    if not needle:
        raise ValueError("Search query must not be empty")
    matches = []
    with Path(csv_path).open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        _validate_header(reader.fieldnames, "main")
        for row in reader:
            haystack = unicodedata.normalize("NFKC", " ".join(value or "" for value in row.values())).casefold()
            if needle in haystack:
                matches.append(row)
                if len(matches) >= limit:
                    break
    return matches
