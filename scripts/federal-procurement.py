#!/usr/bin/env python3
"""Resolve and archive current-fiscal-year CanadaBuys award and contract-history CSVs."""

import argparse
import csv
from datetime import date, datetime, timezone
import fcntl
import gzip
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lib.committee_files import official

REGISTER = Path(__file__).resolve().parents[1] / "docs/evidence/2026-11-23/federal-public-service-sources.csv"
DEFAULT_ROOT = Path("data/corpus/federal-procurement")
SUPPORT = "https://canadabuys.canada.ca/en/support/searching-award-notices-and-contract-history"
DISCLOSURE = "https://open.canada.ca/en/proactive-disclosure"
API = "https://open.canada.ca/data/api/action/package_show?id="
RESERVE = 180 * 1024 * 1024
MAX_METADATA = 12 * 1024 * 1024
KINDS = ("award-notices", "contract-history")

AWARD_REQUIRED = {
    "title-titre-eng", "title-titre-fra", "referenceNumber-numeroReference",
    "amendmentNumber-numeroModification", "solicitationNumber-numeroSollicitation",
    "contractNumber-numeroContrat", "publicationDate-datePublication",
    "contractAwardDate-dateAttributionContrat", "awardStatus-attributionStatut-eng",
    "noticeType-avisType-eng", "supplierLegalName-nomLegalFournisseur-eng",
}
HISTORY_REQUIRED = {
    "title-titre-eng", "title-titre-fra", "referenceNumber-numeroReference",
    "amendmentNumber-numeroModification", "procurementNumber-numeroApprovisionnement",
    "numberOfRecords-nombreEnregistrements", "contractNumber-numeroContrat",
    "publicationDate-datePublication", "contractAwardDate-dateAttributionContrat",
    "contractStatus-statutContrat-eng", "noticeType-avisType-eng",
    "supplierLegalName-nomLegalFournisseur-eng",
}


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        if not official(new_url):
            raise ValueError("CanadaBuys resource redirected outside an official Government of Canada host")
        return super().redirect_request(request, fp, code, msg, headers, new_url)


class Links(HTMLParser):
    def __init__(self, page_url):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.items = []
        self.href = None
        self.label = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href = dict(attrs).get("href")
            self.label = []

    def handle_data(self, data):
        if self.href is not None:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.href:
            target = urljoin(self.page_url, self.href)
            if official(target):
                self.items.append((" ".join("".join(self.label).split()), target))
            self.href = None
            self.label = []


class Reader:
    def __init__(self):
        self.opener = build_opener(Redirects())

    def read(self, url, limit=MAX_METADATA, method="GET", headers=None):
        if not official(url):
            raise ValueError("Refusing non-official source URL")
        request = Request(url, headers={"User-Agent": "CivicSignal public data intake", **(headers or {})}, method=method)
        with self.opener.open(request, timeout=45) as response:
            allowed = response.status == 200 or (headers and "Range" in headers and response.status == 206)
            if not allowed:
                raise ValueError(f"Source returned HTTP {response.status}: {url}")
            if not official(response.geturl()):
                raise ValueError("Final source URL is not an official Government of Canada URL")
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError(f"Metadata response exceeded {limit} bytes")
            return data, {"url": response.geturl(), "lastModified": response.headers.get("Last-Modified"),
                          "mediaType": response.headers.get("Content-Type"),
                          "contentLength": int(response.headers["Content-Length"]) if response.headers.get("Content-Length") else None}

    def head(self, url):
        _, meta = self.read(url, 1024, "HEAD", {"Accept-Encoding": "identity"})
        if meta["contentLength"] is None:
            raise ValueError(f"No advertised resource size for safe staging: {url}")
        return meta

    def sample(self, url, length=65536):
        data, meta = self.read(url, length, headers={"Range": f"bytes=0-{length - 1}", "Accept-Encoding": "identity"})
        if not data:
            raise ValueError(f"Resource sample was empty: {url}")
        return data, meta

    def stream(self, url):
        if not official(url):
            raise ValueError("Refusing non-official resource URL")
        request = Request(url, headers={"User-Agent": "CivicSignal public data intake", "Accept-Encoding": "identity"})
        response = self.opener.open(request, timeout=90)
        if response.status != 200 or not official(response.geturl()):
            response.close()
            raise ValueError(f"Resource response is not an official HTTP 200: {url}")
        return response


def current_fiscal_year(today=None):
    today = today or datetime.now(timezone.utc).date()
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{start + 1}"


def registered_urls(register=REGISTER):
    with register.open(newline="", encoding="utf-8-sig") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("series_key") == "procurement"]
    if len(rows) != 1:
        raise ValueError("Expected exactly one registered procurement source row")
    row = rows[0]
    if row.get("entry_url") != SUPPORT or row.get("companion_url") != DISCLOSURE:
        raise ValueError("The registered procurement source changed; review the official entry points")
    return row


def find_dataset_links(reader, register=REGISTER):
    registered = registered_urls(register)
    support_html, support_meta = reader.read(registered["entry_url"])
    support_links = Links(support_meta["url"])
    support_links.feed(support_html.decode("utf-8-sig", errors="replace"))
    index_url = next((url for label, url in support_links.items
                      if "procurement-and-contracting-data" in urlsplit(url).path), None)
    if not index_url:
        raise ValueError("Registered CanadaBuys guide no longer points to its procurement data index")
    index_html, index_meta = reader.read(index_url)
    index = Links(index_meta["url"])
    index.feed(index_html.decode("utf-8-sig", errors="replace"))
    found = {}
    for label, url in index.items:
        key = " ".join(label.casefold().split())
        if key == "tender notices":
            found["tender-notices"] = url
        elif key == "award notices":
            found["award-notices"] = url
        elif key == "contract history":
            found["contract-history"] = url
    if not all(kind in found for kind in KINDS) or "tender-notices" not in found:
        raise ValueError("CanadaBuys data index is missing a tender, award, or contract-history dataset link")
    return {"registeredSupport": support_meta["url"], "dataIndex": index_meta["url"],
            "disclosureIndex": registered["companion_url"], "datasets": found}


def package_resources(reader, dataset_url):
    parts = urlsplit(dataset_url).path.rstrip("/").split("/")
    if len(parts) < 2 or parts[-2] != "dataset":
        raise ValueError(f"Dataset link is not a registered dataset page: {dataset_url}")
    dataset_id = parts[-1]
    api_body, _ = reader.read(API + dataset_id)
    document = json.loads(api_body)
    result = document.get("result", {})
    if document.get("success") is not True or result.get("id") != dataset_id:
        raise ValueError(f"Open Canada metadata did not match dataset {dataset_id}")
    resources = result.get("resources")
    if not isinstance(resources, list) or not resources:
        raise ValueError(f"Open Canada dataset {dataset_id} has no resources")
    return dataset_id, result, resources


def localized_text(value):
    if isinstance(value, dict):
        return " ".join(str(text) for text in value.values() if text)
    return str(value or "")


def select_current_resource(resources, kind, fiscal_year):
    matches = []
    for resource in resources:
        name = localized_text(resource.get("name_translated") or resource.get("name"))
        url = resource.get("url")
        if fiscal_year not in name or "CSV" not in str(resource.get("format", "")).upper():
            continue
        if kind.split("-")[0] not in name.casefold() and kind == "award-notices":
            continue
        if kind == "contract-history" and "contract histor" not in name.casefold():
            continue
        if not isinstance(url, str) or not official(url):
            raise ValueError(f"Current-year {kind} resource has an unverified URL")
        matches.append({**resource, "name": name})
    if len(matches) != 1:
        raise ValueError(f"Expected one {fiscal_year} {kind} CSV, found {len(matches)}")
    return matches[0]


def resolve(reader, fiscal_year):
    indexes = find_dataset_links(reader)
    resolved = []
    for kind in KINDS:
        dataset_url = indexes["datasets"][kind]
        dataset_id, metadata, resources = package_resources(reader, dataset_url)
        resource = select_current_resource(resources, kind, fiscal_year)
        head = reader.head(resource["url"])
        sample, sample_meta = reader.sample(resource["url"])
        first_line = sample.decode("utf-8-sig", errors="replace").splitlines()[0]
        header = next(csv.reader([first_line], strict=True), [])
        schema = validate_header(header, kind)
        compressed_sample = len(gzip.compress(sample, compresslevel=3, mtime=0))
        estimate = int(head["contentLength"] * compressed_sample / len(sample) * 1.25) + 1024 * 1024
        resolved.append({"kind": kind, "schema": schema, "datasetId": dataset_id,
                         "datasetTitle": localized_text(metadata.get("title_translated") or metadata.get("title")),
                         "datasetUrl": dataset_url, "sourceUrl": resource["url"],
                         "sourceName": resource["name"], "catalogueModified": metadata.get("metadata_modified"),
                         "advertisedBytes": head["contentLength"], "estimatedGzipBytes": estimate,
                         "lastModified": head["lastModified"], "finalUrl": sample_meta["url"]})
    if len({entry["datasetId"] for entry in resolved}) != 2:
        raise ValueError("Award notices and contract history must resolve to distinct datasets")
    return {"indexes": indexes, "fiscalYear": fiscal_year, "resources": resolved,
            "excluded": [{"kind": "tender-notices", "datasetUrl": indexes["datasets"]["tender-notices"],
                          "reason": "Tender opportunities are not awards or contract history."},
                         {"kind": "proactive-disclosure", "datasetUrl": indexes["disclosureIndex"],
                          "reason": "Registered disclosure source is separate from CanadaBuys contract history."}]}


def validate_header(header, kind):
    header = [field.strip() for field in header]
    if header and header[0].startswith("\ufeff"):
        header[0] = header[0].lstrip("\ufeff")
    required = AWARD_REQUIRED if kind == "award-notices" else HISTORY_REQUIRED
    if not header or len(header) != len(set(header)) or not required.issubset(header):
        raise ValueError(f"{kind} CSV schema mismatch; missing {sorted(required - set(header))}")
    return {"headers": header}


def scan(stream, kind, fiscal_year, enforce_year=True):
    reader = csv.reader(stream, strict=True)
    header = next(reader, [])
    schema = validate_header(header, kind)
    date_column = "publicationDate-datePublication" if kind == "award-notices" else "contractAwardDate-dateAttributionContrat"
    position = header.index(date_column)
    start_year, end_year = map(int, fiscal_year.split("-"))
    rows = 0
    dated = 0
    for ordinal, row in enumerate(reader, start=2):
        if len(row) != len(header):
            raise ValueError(f"{kind} CSV row {ordinal} has {len(row)} columns, expected {len(header)}")
        value = row[position].strip() if position < len(row) else ""
        if value:
            try:
                published = date.fromisoformat(value[:10])
            except ValueError as error:
                raise ValueError(f"Invalid {date_column} on {kind} row {ordinal}: {value}") from error
            dated += 1
            if enforce_year and not (date(start_year, 4, 1) <= published < date(end_year, 4, 1)):
                raise ValueError(f"{kind} row {ordinal} falls outside fiscal year {fiscal_year}")
        rows += 1
    if not rows or not dated:
        raise ValueError(f"{kind} CSV contains no dated records")
    return {**schema, "rows": rows, "dateColumn": date_column, "datedRows": dated}


def stage_resource(reader, resource, fiscal_year, root):
    head = reader.head(resource["sourceUrl"])
    if head["contentLength"] != resource["advertisedBytes"]:
        raise ValueError(f"{resource['kind']} size changed after preflight")
    digest = hashlib.sha256()
    total = 0
    path = None
    response = reader.stream(resource["sourceUrl"])
    try:
        with tempfile.NamedTemporaryFile(dir=root, suffix=".csv.gz", delete=False) as candidate:
            path = Path(candidate.name)
            with gzip.GzipFile(fileobj=candidate, mode="wb", compresslevel=3, mtime=0) as archive:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if shutil.disk_usage(root).free - RESERVE < len(block) + 64 * 1024:
                        raise ValueError(f"Insufficient free space to stage {resource['kind']} safely")
                    digest.update(block)
                    archive.write(block)
            candidate.flush()
            os.fsync(candidate.fileno())
        if total != head["contentLength"]:
            raise ValueError(f"Incomplete {resource['kind']} response: got {total}, expected {head['contentLength']}")
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as stream:
            schema = scan(stream, resource["kind"], fiscal_year)
        return {**resource, "lastModified": response.headers.get("Last-Modified") or head["lastModified"],
                "finalUrl": response.geturl(), "sha256": digest.hexdigest(), "bytes": total,
                "compressedBytes": path.stat().st_size, "schema": schema, "stagedPath": str(path)}
    except Exception:
        if path and path.exists():
            path.unlink()
        raise
    finally:
        response.close()


def publish(root, observation):
    objects = root / "objects"
    objects.mkdir(parents=True, exist_ok=True)
    published = []
    for resource in observation["resources"]:
        target = objects / (resource["sha256"] + ".csv.gz")
        staged = Path(resource.pop("stagedPath"))
        if target.exists():
            with gzip.open(target, "rb") as archive:
                if hashlib.file_digest(archive, "sha256").hexdigest() != resource["sha256"]:
                    raise ValueError(f"Existing {resource['kind']} object checksum mismatch")
            staged.unlink()
        else:
            os.replace(staged, target)
        published.append({**resource, "objectPath": str(target)})
    observation["resources"] = published
    generation = datetime.now(timezone.utc).isoformat()
    root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(root / "publications.sqlite") as db:
        db.execute("""CREATE TABLE IF NOT EXISTS observations(
          generation TEXT PRIMARY KEY, fiscal_year TEXT NOT NULL, source_indexes_json TEXT NOT NULL,
          resources_json TEXT NOT NULL, excluded_json TEXT NOT NULL)""")
        db.execute("INSERT INTO observations VALUES (?,?,?,?,?)", (generation, observation["fiscalYear"],
                    json.dumps(observation["indexes"], ensure_ascii=False, sort_keys=True),
                    json.dumps(published, ensure_ascii=False, sort_keys=True),
                    json.dumps(observation["excluded"], ensure_ascii=False, sort_keys=True)))
    receipt = {"generation": generation, **observation}
    receipts = root / "receipts"
    receipts.mkdir(exist_ok=True)
    target = receipts / (generation.replace(":", "-") + ".json")
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    return receipt


def verify(root):
    db_path = root / "publications.sqlite"
    if not db_path.exists():
        raise ValueError("No CanadaBuys procurement publication exists")
    with sqlite3.connect(db_path) as db:
        row = db.execute("SELECT generation,fiscal_year,resources_json FROM observations ORDER BY generation DESC LIMIT 1").fetchone()
    if not row:
        raise ValueError("No CanadaBuys procurement publication exists")
    generation, fiscal_year, encoded = row
    resources = json.loads(encoded)
    if {item["kind"] for item in resources} != set(KINDS):
        raise ValueError("Stored generation does not contain both procurement datasets")
    checks = []
    for item in resources:
        path = Path(item["objectPath"])
        digest = hashlib.sha256()
        count = 0
        with gzip.open(path, "rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
                count += len(block)
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as source:
            schema = scan(source, item["kind"], fiscal_year)
        if digest.hexdigest() != item["sha256"] or count != item["bytes"]:
            raise ValueError(f"Stored {item['kind']} object failed checksum/length verification")
        checks.append({"kind": item["kind"], "sha256": digest.hexdigest(), "bytes": count, "rows": schema["rows"]})
    return {"generation": generation, "fiscalYear": fiscal_year, "verified": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "refresh", "verify"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--fiscal-year", help="Override current fiscal year (YYYY-YYYY)")
    args = parser.parse_args()
    if args.action == "verify":
        print(json.dumps(verify(args.root), indent=2))
        return
    fy = args.fiscal_year or current_fiscal_year()
    if not re.fullmatch(r"\d{4}-\d{4}", fy):
        parser.error("--fiscal-year must be YYYY-YYYY")
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / "procurement.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        reader = Reader()
        observation = resolve(reader, fy)
        available = shutil.disk_usage(args.root).free - RESERVE
        estimate = sum(item["estimatedGzipBytes"] for item in observation["resources"])
        if available < estimate:
            raise ValueError(f"Insufficient space after reserve: need about {estimate} bytes, have {available}")
        summary = {"fiscalYear": fy, "supportUrl": observation["indexes"]["registeredSupport"],
                   "dataIndexUrl": observation["indexes"]["dataIndex"], "resources": [
                       {key: item[key] for key in ("kind", "datasetId", "datasetUrl", "sourceUrl", "advertisedBytes",
                                                    "estimatedGzipBytes", "lastModified", "schema")}
                       for item in observation["resources"]],
                   "proactiveDisclosureExcluded": observation["excluded"][1]}
        if args.action == "preflight":
            print(json.dumps({**summary, "freeBytesAfterReserve": available, "estimatedTotalCompressedBytes": estimate}, indent=2))
            return
        staged = []
        try:
            for resource in observation["resources"]:
                staged.append(stage_resource(reader, resource, fy, args.root))
            observation["resources"] = staged
            receipt = publish(args.root, observation)
        except Exception:
            for item in staged:
                path = Path(item.get("stagedPath", ""))
                if path.is_file():
                    path.unlink()
            raise
        print(json.dumps({"generation": receipt["generation"], "fiscalYear": fy,
                          "resources": [{"kind": r["kind"], "url": r["sourceUrl"], "sha256": r["sha256"],
                                         "bytes": r["bytes"], "rows": r["schema"]["rows"]}
                                        for r in receipt["resources"]]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, csv.Error, json.JSONDecodeError) as error:
        sys.exit(str(error))
