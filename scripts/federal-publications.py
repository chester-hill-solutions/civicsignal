#!/usr/bin/env python3
"""Stage, validate, and atomically publish the registered federal publications MARC exports."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

DEFAULT_ROOT = Path("data/corpus/federal-publications")
INVENTORY = Path("data/corpus/federal-source-inventory/inventory.sqlite")
REGISTER = Path("docs/evidence/2026-11-23/federal-public-service-sources.csv")
DATASET_ID = "30f7114d-4b3f-4201-8dc7-0d71eb769617"
DATE_RE = re.compile(r"\((\d{4}-\d{2}-\d{2})\)")
EXPECTED = {
    "monographs": ("Monographs", "Monographies"),
    "series": ("Series", "Series"),
    "periodicals": ("Periodicals", "Periodiques"),
}
OFFICIAL_HOST = "donnees-data.tpsgc-pwgsc.gc.ca"
RESERVE_BYTES = 128 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024


class OfficialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https" or urlsplit(newurl).hostname != OFFICIAL_HOST:
            raise ValueError("MARC resource redirected outside its registered official publisher host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def published_resources(inventory: Path = INVENTORY):
    if not inventory.is_file():
        raise ValueError("Refresh the federal source inventory before importing publications")
    with sqlite3.connect(inventory.resolve().as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute("""SELECT observed_at, url, inventory FROM catalogue_observations
          WHERE series='publications' AND endpoint='entry_url' ORDER BY observed_at DESC""").fetchall()
    if not rows:
        raise ValueError("The federal source inventory has no publications dataset observation")
    observed_at, dataset_url, encoded = rows[0]
    parsed_dataset = urlsplit(dataset_url)
    dataset_query = parse_qs(parsed_dataset.query)
    if (parsed_dataset.scheme != "https" or parsed_dataset.hostname != "open.canada.ca"
        or parsed_dataset.path != "/data/api/action/package_show" or dataset_query.get("id") != [DATASET_ID]):
        raise ValueError("The latest publications observation is not the registered Open Government dataset")
    observation = json.loads(encoded)
    if observation.get("kind") != "dataset-resources":
        raise ValueError("The latest publications observation is not a dataset resource listing")
    entries = [item for item in observation.get("resources", []) if item.get("format", "").upper() == "ZIP"]
    selected = {}
    snapshot_dates = set()
    for category, bilingual in EXPECTED.items():
        matches = []
        for item in entries:
            titles = item.get("titles") or {}
            date_en = DATE_RE.search(titles.get("en", ""))
            date_fr = DATE_RE.search(titles.get("fr", ""))
            if (titles.get("en", "").startswith(bilingual[0] + " ") and
                titles.get("fr", "").startswith(bilingual[1] + " ") and date_en and date_fr and
                date_en.group(1) == date_fr.group(1)):
                matches.append(item)
        if len(matches) != 1:
            raise ValueError(f"The latest publications dataset must contain exactly one bilingual dated ZIP for {category}")
        resource = matches[0]
        if not resource.get("id") or resource.get("format", "").upper() != "ZIP":
            raise ValueError(f"The registered {category} resource is missing its identity or ZIP format")
        url = resource.get("url", "")
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.hostname != OFFICIAL_HOST or not parts.path.lower().endswith(".zip"):
            raise ValueError(f"The registered {category} resource is not an official ZIP URL")
        if not {"en", "fr"}.issubset(set(resource.get("languages") or [])):
            raise ValueError(f"The registered {category} resource is not bilingual")
        snapshot = DATE_RE.search(resource["titles"]["en"]).group(1)
        snapshot_dates.add(snapshot)
        selected[category] = {**resource, "snapshotDate": snapshot}
    if len(snapshot_dates) != 1:
        raise ValueError("The three publications ZIP resources do not share one dated snapshot")
    return observed_at, snapshot_dates.pop(), selected


def _read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            break
        chunks.extend(part)
    return bytes(chunks)


def _decode(value: bytes, utf8: bool) -> str:
    return value.decode("utf-8", "replace") if utf8 else value.decode("ascii", "replace")


def parse_record(record: bytes):
    if len(record) < 26 or len(record) > MAX_RECORD_BYTES:
        raise ValueError("ISO 2709 record length is outside the valid bounds")
    leader = record[:24]
    if not leader[:5].isdigit() or int(leader[:5]) != len(record):
        raise ValueError("ISO 2709 leader record length does not match record bytes")
    if leader[10:11] != b"2" or leader[11:12] != b"2":
        raise ValueError("ISO 2709 directory indicator/subfield lengths are unsupported")
    base_bytes = leader[12:17]
    if not base_bytes.isdigit():
        raise ValueError("ISO 2709 leader has an invalid base address")
    base = int(base_bytes)
    if base < 25 or base >= len(record) or record[base - 1] != 0x1e or record[-1] != 0x1d:
        raise ValueError("ISO 2709 directory or record terminator is invalid")
    directory = record[24:base - 1]
    if not directory or len(directory) % 12:
        raise ValueError("ISO 2709 directory has an invalid entry length")
    fields = {}
    for offset in range(0, len(directory), 12):
        entry = directory[offset:offset + 12]
        tag, length_bytes, start_bytes = entry[:3], entry[3:7], entry[7:12]
        if not tag.isdigit() or not length_bytes.isdigit() or not start_bytes.isdigit():
            raise ValueError("ISO 2709 directory contains a malformed entry")
        length, start = int(length_bytes), int(start_bytes)
        if length < 1 or start + length > len(record) - base - 1:
            raise ValueError("ISO 2709 directory field points outside the record")
        field = record[base + start:base + start + length]
        if field[-1] != 0x1e:
            raise ValueError("ISO 2709 field terminator is missing")
        fields.setdefault(tag.decode("ascii"), []).append(field[:-1])
    identifiers = fields.get("001", [])
    titles = fields.get("245", [])
    if len(identifiers) != 1 or not identifiers[0].strip() or not titles:
        raise ValueError("MARC record must have exactly one nonempty 001 and at least one 245 title")
    utf8 = leader[9:10] == b"a"
    identifier = _decode(identifiers[0], utf8).strip()
    title_parts = []
    for field in titles:
        if len(field) < 2:
            raise ValueError("MARC 245 title field is missing indicators")
        for subfield in field[2:].split(b"\x1f"):
            if not subfield:
                continue
            code, value = subfield[:1], subfield[1:]
            if code in (b"a", b"b", b"n", b"p"):
                title_parts.append(_decode(value, utf8).strip().rstrip(" /:,;"))
    title = " ".join(part for part in title_parts if part).strip()
    if not title:
        raise ValueError("MARC 245 contains no usable title subfields")
    return identifier, title, "utf-8" if utf8 else "MARC-8 ASCII sample"


def iter_records(stream):
    number = 0
    while True:
        leader = _read_exact(stream, 24)
        if not leader:
            return
        if len(leader) != 24:
            raise ValueError(f"Truncated ISO 2709 leader after record {number}")
        length_field = leader[:5]
        if not length_field.isdigit():
            raise ValueError(f"Record {number + 1} has a nonnumeric ISO 2709 length")
        record_length = int(length_field)
        if record_length < 26 or record_length > MAX_RECORD_BYTES:
            raise ValueError(f"Record {number + 1} has an invalid ISO 2709 length")
        tail = _read_exact(stream, record_length - 24)
        if len(tail) != record_length - 24:
            raise ValueError(f"Truncated ISO 2709 record {number + 1}")
        number += 1
        yield parse_record(leader + tail)


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def iter_mods(stream):
    """Yield identifier/title samples from the publisher's streaming MODS XML exports."""
    root_name = None
    root_namespace = None
    root_element = None
    stack = []
    count = 0
    for event, element in ET.iterparse(stream, events=("start", "end")):
        name = _local_name(element.tag)
        if event == "start":
            stack.append(element)
            if root_name is None:
                root_name = name
                root_element = element
                root_namespace = element.tag.partition("}")[0][1:] if element.tag.startswith("{") else ""
                if root_name != "modsCollection" or root_namespace != "http://www.loc.gov/mods/v3":
                    raise ValueError("ZIP XML payload is not a MODS 3 collection")
            continue
        top_level_mods = name == "mods" and len(stack) == 2 and stack[0] is root_element
        if not top_level_mods:
            stack.pop()
            continue
        identifiers = []
        titles = []
        for child in element:
            child_name = _local_name(child.tag)
            if child_name == "recordInfo":
                for field in child:
                    if _local_name(field.tag) == "recordIdentifier":
                        value = "".join(field.itertext()).strip()
                        if value:
                            identifiers.append((field.attrib.get("source", ""), value))
            elif child_name == "titleInfo":
                values = ["".join(field.itertext()).strip() for field in child if _local_name(field.tag) == "title"]
                title = " ".join(value for value in values if value).strip()
                if title:
                    titles.append((child.attrib.get("type", ""), title))
        identifier = next((value for source, value in identifiers if source == "CaOODSP"), None)
        if identifier is None and identifiers:
            identifier = identifiers[0][1]
        title = next((value for kind, value in titles if not kind), None)
        if title is None and titles:
            title = titles[0][1]
        if not identifier or not title:
            raise ValueError(f"MODS record {count + 1} must have a recordIdentifier and title")
        count += 1
        yield identifier, title, "MODS XML UTF-8"
        if root_element is not None:
            root_element.clear()
        stack.pop()
    if root_name != "modsCollection":
        raise ValueError("ZIP XML payload is empty or lacks a MODS collection root")
    if count == 0:
        raise ValueError("MODS export contains no records")


def validate_zip(path: Path, category: str, seen_db: sqlite3.Connection):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(CHUNK_BYTES), b""):
            digest.update(block)
    samples = []
    records = 0
    duplicate_identifiers = 0
    export_members = []
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if not infos or len(infos) > 20:
                raise ValueError(f"{category}: ZIP must contain 1–20 members")
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ValueError(f"{category}: ZIP contains duplicate member names")
            for info in infos:
                member_path = PurePosixPath(info.filename)
                if member_path.is_absolute() or ".." in member_path.parts or info.flag_bits & 0x1:
                    raise ValueError(f"{category}: ZIP member path or encryption is not accepted")
                if info.file_size > MAX_ARCHIVE_BYTES:
                    raise ValueError(f"{category}: MARC member exceeds the 1 GiB validation bound")
                if not info.is_dir() and member_path.suffix.lower() in (".xml", ".mrc", ".marc"):
                    export_members.append(info)
            if len(export_members) != 1:
                raise ValueError(f"{category}: ZIP must contain exactly one MARCXML or ISO 2709 export member")
            member_format = PurePosixPath(export_members[0].filename).suffix.lower()
            for info in export_members:
                with archive.open(info) as stream:
                    records_stream = iter_mods(stream) if member_format == ".xml" else iter_records(stream)
                    for identifier, title, encoding in records_stream:
                        previous = seen_db.execute("SELECT occurrences FROM seen_ids WHERE category=? AND identifier=?",
                                                   (category, identifier)).fetchone()
                        if previous:
                            duplicate_identifiers += 1
                            seen_db.execute("UPDATE seen_ids SET occurrences=occurrences+1 WHERE category=? AND identifier=?",
                                            (category, identifier))
                        else:
                            seen_db.execute("INSERT INTO seen_ids(category, identifier, occurrences) VALUES (?, ?, 1)",
                                            (category, identifier))
                        records += 1
                        if len(samples) < 5:
                            samples.append({"id": identifier, "title": title, "titleEncoding": encoding})
            if records == 0:
                raise ValueError(f"{category}: MARC export contains no records")
    except (zipfile.BadZipFile, EOFError, RuntimeError, ET.ParseError) as error:
        raise ValueError(f"{category}: malformed or truncated ZIP/MARC export: {error}") from error
    return {"sha256": digest.hexdigest(), "archiveBytes": path.stat().st_size,
            "recordCount": records, "memberCount": len(export_members),
            "duplicateIdentifierCount": duplicate_identifiers,
            "format": "MODS XML" if member_format == ".xml" else "ISO 2709", "samples": samples}


def probe(url: str, opener):
    request = Request(url, method="HEAD", headers={"Accept-Encoding": "identity", "User-Agent": "CivicSignal public bibliography intake"})
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError(f"MARC HEAD returned HTTP {response.status}: {url}")
            length = response.headers.get("Content-Length")
            if length and length.isdigit():
                return int(length), response.headers.get("ETag"), response.headers.get("Last-Modified")
    except HTTPError as error:
        if error.code not in (400, 403, 405, 501):
            raise
    request = Request(url, headers={"Range": "bytes=0-0", "Accept-Encoding": "identity",
                                    "User-Agent": "CivicSignal public bibliography intake"})
    with opener.open(request, timeout=30) as response:
        if response.status != 206:
            raise ValueError(f"MARC range probe did not return HTTP 206: {url}")
        content_range = response.headers.get("Content-Range", "")
        match = re.fullmatch(r"bytes\s+0-0/(\d+)", content_range.strip(), re.I)
        byte = response.read(2)
        if not match or len(byte) != 1:
            raise ValueError(f"MARC range probe returned an invalid Content-Range: {url}")
        return int(match.group(1)), response.headers.get("ETag"), response.headers.get("Last-Modified")


def download(resource, target: Path, expected_size, expected_etag, opener, root: Path):
    request = Request(resource["url"], headers={"Accept-Encoding": "identity", "User-Agent": "CivicSignal public bibliography intake"})
    digest = hashlib.sha256()
    total = 0
    with opener.open(request, timeout=120) as response:
        if response.status != 200:
            raise ValueError(f"MARC download returned HTTP {response.status}: {resource['url']}")
        actual_length = response.headers.get("Content-Length")
        if expected_size is not None and actual_length and actual_length.isdigit() and int(actual_length) != expected_size:
            raise ValueError(f"Publisher changed Content-Length between preflight and download: {resource['url']}")
        if expected_etag and response.headers.get("ETag") and response.headers.get("ETag") != expected_etag:
            raise ValueError(f"Publisher changed ETag between preflight and download: {resource['url']}")
        with target.open("xb") as sink:
            while True:
                block = response.read(CHUNK_BYTES)
                if not block:
                    break
                total += len(block)
                free_after = shutil.disk_usage(root).free - RESERVE_BYTES
                if free_after < 0 or len(block) > free_after:
                    raise ValueError(f"Insufficient free space to stage {resource['url']} while preserving reserve")
                sink.write(block)
                digest.update(block)
            sink.flush()
            os.fsync(sink.fileno())
        if expected_size is not None and total != expected_size:
            raise ValueError(f"Incomplete MARC archive: received {total} of {expected_size} bytes")
        if actual_length and actual_length.isdigit() and total != int(actual_length):
            raise ValueError(f"MARC response body length does not match Content-Length: {resource['url']}")
        return {"bytes": total, "sha256": digest.hexdigest(),
                "finalUrl": response.geturl(), "etag": response.headers.get("ETag"),
                "lastModified": response.headers.get("Last-Modified")}


def _copy_input(source: Path, target: Path, root: Path):
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as incoming, target.open("xb") as outgoing:
        while True:
            block = incoming.read(CHUNK_BYTES)
            if not block:
                break
            free_after = shutil.disk_usage(root).free - RESERVE_BYTES
            if free_after < 0 or len(block) > free_after:
                raise ValueError("Insufficient free space to stage supplied archives while preserving reserve")
            digest.update(block)
            outgoing.write(block)
            total += len(block)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    return {"bytes": total, "sha256": digest.hexdigest(), "finalUrl": None,
            "etag": None, "lastModified": None}


def _atomic_current(root: Path, generation_name: str):
    temporary = root / f".current-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        os.symlink(f"generations/{generation_name}", temporary)
        os.replace(temporary, root / "current")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _current_receipt(root: Path):
    current = root / "current"
    if not current.is_symlink():
        return None
    try:
        return json.loads((current / "receipt.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _reuse_existing(root: Path, category: str, resource: dict, validators, staging_archive: Path, receipt):
    if not receipt or receipt.get("snapshotDate") != resource["snapshotDate"]:
        return None
    previous = (receipt.get("resources") or {}).get(category) or {}
    size, etag, modified = validators
    previous_etag = previous.get("etag")
    has_stable_validator = (etag == previous_etag if etag and previous_etag else bool(
        modified and modified == previous.get("lastModified")))
    if (previous.get("id") != resource.get("id") or previous.get("url") != resource.get("url")
        or not has_stable_validator or size != previous.get("archiveBytes")):
        return None
    old_archive = root / "current" / "archives" / f"{category}.zip"
    try:
        if old_archive.stat().st_size != previous.get("archiveBytes"):
            return None
        digest = hashlib.sha256()
        with old_archive.open("rb") as stream:
            for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
                digest.update(block)
        if digest.hexdigest() != previous.get("sha256"):
            return None
        os.link(old_archive, staging_archive)
    except OSError:
        return None
    return {key: previous[key] for key in ("recordCount", "memberCount", "duplicateIdentifierCount", "format", "samples", "sha256")
            if key in previous} | {"archiveBytes": size, "finalUrl": previous.get("finalUrl"),
                                   "etag": etag or previous.get("etag"),
                                   "lastModified": modified or previous.get("lastModified"),
                                   "reused": True}


def refresh(root: Path, input_dir: Path | None, download_live: bool, inventory: Path = INVENTORY):
    observed_at, snapshot_date, resources = published_resources(inventory)
    root.mkdir(parents=True, exist_ok=True)
    generations = root / "generations"
    generations.mkdir(exist_ok=True)
    opener = build_opener(OfficialRedirect())
    probes = {}
    previous_receipt = _current_receipt(root)
    if download_live:
        for category, resource in resources.items():
            probes[category] = probe(resource["url"], opener)
        total_bytes = 0
        if any(size is None for size, _etag, _modified in probes.values()):
            raise ValueError("Publisher size was unavailable for at least one MARC archive; refusing a download without a full disk preflight")
        for category, resource in resources.items():
            size, etag, modified = probes[category]
            old = (previous_receipt.get("resources") or {}).get(category, {}) if previous_receipt else {}
            old_etag = old.get("etag")
            stable = etag == old_etag if etag and old_etag else bool(modified and modified == old.get("lastModified"))
            reusable = (previous_receipt and previous_receipt.get("snapshotDate") == snapshot_date
                        and old.get("id") == resource["id"] and old.get("url") == resource["url"]
                        and old.get("archiveBytes") == size and stable)
            if not reusable:
                total_bytes += size
        available = shutil.disk_usage(root).free
        required = total_bytes + RESERVE_BYTES
        if available < required:
            mib = lambda value: round(value / (1024 * 1024), 1)
            raise ValueError(f"MARC acquisition preflight needs {mib(total_bytes)} MiB plus {mib(RESERVE_BYTES)} MiB reserve; only {mib(available)} MiB free")
    elif input_dir is None:
        raise ValueError("Select --download for official resources or --input-dir for replay")
    else:
        input_bytes = 0
        for category in EXPECTED:
            source = input_dir / f"{category}.zip"
            if not source.is_file():
                raise ValueError(f"Missing staged input file: {source}")
            input_bytes += source.stat().st_size
        available = shutil.disk_usage(root).free
        required = input_bytes + RESERVE_BYTES
        if available < required:
            mib = lambda value: round(value / (1024 * 1024), 1)
            raise ValueError(f"Replay staging needs {mib(input_bytes)} MiB plus {mib(RESERVE_BYTES)} MiB reserve; only {mib(available)} MiB free")
    stamp = datetime.now(timezone.utc)
    generation_name = f"{snapshot_date}-{stamp.strftime('%Y%m%dT%H%M%S')}-{os.urandom(4).hex()}"
    staging = Path(tempfile.mkdtemp(prefix=".publications-stage-", dir=root))
    try:
        archive_dir = staging / "archives"
        archive_dir.mkdir()
        seen_path = staging / "seen.sqlite"
        with sqlite3.connect(seen_path) as seen_db:
            seen_db.execute("CREATE TABLE seen_ids(category TEXT NOT NULL, identifier TEXT NOT NULL, occurrences INTEGER NOT NULL, PRIMARY KEY(category, identifier))")
            entries = {}
            for category, resource in resources.items():
                archive_path = archive_dir / f"{category}.zip"
                if download_live:
                    size, etag, modified = probes[category]
                    transfer = _reuse_existing(root, category, resource, probes[category], archive_path, previous_receipt)
                    if transfer is not None:
                        validation = transfer
                    else:
                        transfer = download(resource, archive_path, size, etag, opener, root)
                        validation = validate_zip(archive_path, category, seen_db)
                else:
                    source = input_dir / f"{category}.zip"
                    transfer = _copy_input(source, archive_path, root)
                    modified = None
                    validation = validate_zip(archive_path, category, seen_db)
                entries[category] = {
                    "id": resource["id"], "titles": resource["titles"], "url": resource["url"],
                    "format": resource["format"], "snapshotDate": snapshot_date,
                    "catalogueLastModified": resource.get("lastModified"),
                    **transfer, "lastModified": transfer.get("lastModified") or modified,
                    **validation,
                }
            seen_db.commit()
        seen_path.unlink()
        manifest = {
            "schemaVersion": 1, "series": "publications", "publisher": "Publications.gc.ca",
            "catalogueDatasetId": DATASET_ID, "registerSha256": hashlib.sha256(REGISTER.read_bytes()).hexdigest(),
            "catalogueObservedAt": observed_at,
            "observedAt": stamp.isoformat(), "snapshotDate": snapshot_date,
            "coverage": "Three dated ZIP exports containing MODS 3 XML records for monographs, series, and periodicals; identifiers and titles validated and records counted.",
            "resources": entries,
        }
        (staging / "receipt.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        final = generations / generation_name
        os.replace(staging, final)
        _atomic_current(root, generation_name)
        print(json.dumps({"published": True, "generation": generation_name,
                          "receipt": str((final / "receipt.json").resolve()),
                          "snapshotDate": snapshot_date,
                          "resources": {key: {"archiveBytes": value["archiveBytes"], "recordCount": value["recordCount"],
                                               "sha256": value["sha256"], "samples": value["samples"]}
                                        for key, value in entries.items()}}, ensure_ascii=False, indent=2))
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def inspect(root: Path):
    current = root / "current"
    if not current.is_symlink():
        raise ValueError(f"No complete publications generation at {current}")
    receipt = current / "receipt.json"
    print(receipt.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("refresh", "inspect"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--inventory", type=Path, default=INVENTORY)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--download", action="store_true", help="fetch the three registered official ZIP resources")
    source.add_argument("--input-dir", type=Path, help="replay category ZIP files from a local directory")
    args = parser.parse_args()
    if args.action == "inspect":
        inspect(args.root)
        return
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        refresh(args.root, args.input_dir, args.download, args.inventory)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, zipfile.BadZipFile, HTTPError) as error:
        sys.exit(str(error))
