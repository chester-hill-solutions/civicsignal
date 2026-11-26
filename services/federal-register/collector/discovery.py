"""Capture one dated federal discovery register and replay each unique original."""
import asyncio
import csv
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import re
from urllib.parse import urlsplit

from federal_catalogue import describe, source_endpoints

PREFIX = "weekly/federal-discovery"
REGISTER_LIMIT = 64 * 1024
PAGE_LIMIT = 4 * 1024 * 1024
PACKET_LIMIT = 8 * 1024 * 1024
PIN_LIMIT = 8192
CONCURRENCY = 3
DIGEST = re.compile(r"[0-9a-f]{64}")
PARSE_FAILURE = "catalogue-parse-failed"
TRANSPORT_FAILURES = {"publisher-network", "publisher-redirect", "publisher-response-type", "publisher-body"}
FIELDS = ["series_key", "family", "entry_method", "publisher_series", "entry_url", "companion_url", "first_check", "evidence_state"]


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()


def digest(body):
    return sha256(body).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def official(url):
    if not isinstance(url, str) or not url or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise ValueError("Invalid federal catalogue URL.")
    parts = urlsplit(url)
    host = parts.hostname or ""
    if (parts.scheme != "https" or not (host == "canada.ca" or host.endswith((".canada.ca", ".gc.ca")))
            or parts.username is not None or parts.password is not None or parts.port not in (None, 443)
            or parts.fragment):
        raise ValueError("Invalid federal catalogue destination.")
    return url


def request_fields(params):
    if not isinstance(params, dict) or set(params) != {"scheduledTime", "registerKey", "registerSha256"}:
        raise ValueError("Expected a federal register occurrence.")
    scheduled = params["scheduledTime"]
    expected = params["registerSha256"]
    if (type(scheduled) is not int or not 0 < scheduled < 4102444800000
            or not isinstance(expected, str) or not DIGEST.fullmatch(expected)
            or params["registerKey"] != f"{PREFIX}/registers/{expected}.csv"):
        raise ValueError("Invalid federal register occurrence.")
    return scheduled, expected


def read_register(raw, expected):
    if not raw or len(raw) > REGISTER_LIMIT or digest(raw) != expected:
        raise ValueError("Federal discovery register checksum mismatch.")
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    if reader.fieldnames != FIELDS:
        raise ValueError("Federal discovery register columns differ.")
    seen = set()
    endpoints = []
    for row in reader:
        series = row["series_key"]
        if (len(row) != len(FIELDS) or not all(isinstance(value, str) for value in row.values())
                or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", series) or series in seen or not row["entry_url"]):
            raise ValueError("Invalid federal discovery register row.")
        seen.add(series)
        endpoints.extend((series, field, official(url), dataset) for field, url, dataset in source_endpoints(row))
    if not 0 < len(endpoints) <= 128:
        raise ValueError("Invalid federal discovery register size.")
    return endpoints


class SourceFailure(Exception):
    def __init__(self, reason, final_url, status=None):
        super().__init__(reason)
        self.reason = reason
        self.final_url = final_url
        self.status = status


def parse(body, final_url, dataset):
    try:
        return describe(body, final_url, dataset), None
    except (ValueError, KeyError, TypeError, AttributeError):
        return None, PARSE_FAILURE


def validate_source(source, url, scheduled, dataset):
    allowed = {"url", "finalUrl", "status", "observedAt", "key", "sha256", "bytes", "failure"}
    if not isinstance(source, dict) or source.keys() - allowed or source.get("url") != url:
        raise ValueError("Unexpected federal source checkpoint identity.")
    official(source.get("finalUrl"))
    stamp = source.get("observedAt")
    if not isinstance(stamp, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", stamp):
        raise ValueError("Invalid federal source checkpoint time.")
    if datetime.fromisoformat(stamp) < datetime.fromtimestamp(scheduled / 1000, timezone.utc):
        raise ValueError("Federal source checkpoint predates its occurrence.")
    status = source.get("status")
    if status is not None and (type(status) is not int or not 100 <= status < 600):
        raise ValueError("Invalid federal publisher HTTP status.")
    reason = source.get("failure")
    if any(field in source for field in ("key", "bytes", "sha256")):
        sha = source.get("sha256")
        ext = "json" if dataset else "html"
        if (status != 200 or reason not in (None, PARSE_FAILURE) or not isinstance(sha, str) or not DIGEST.fullmatch(sha)
                or source.get("key") != f"{PREFIX}/sources/{sha}.{ext}" or type(source.get("bytes")) is not int
                or not 0 < source["bytes"] <= PAGE_LIMIT):
            raise ValueError("Invalid federal original checkpoint.")
    elif reason not in TRANSPORT_FAILURES and not (status is not None and status != 200 and reason == f"http-{status}"):
        raise ValueError("Invalid federal publisher failure checkpoint.")


async def observe(store, fetch, scheduled, url, dataset, clock):
    pin = f"{PREFIX}/observations/{scheduled}/pages/{digest(url.encode())}.json"
    saved = await store.read(pin, PIN_LIMIT)
    fresh = saved is None
    document = None
    if fresh:
        source = {"url": url, "observedAt": clock()}
        try:
            raw, final_url = await fetch(url, dataset)
        except SourceFailure as error:
            source.update(finalUrl=official(error.final_url), failure=error.reason)
            if error.status is not None:
                source["status"] = error.status
        else:
            if not isinstance(raw, bytes) or not 0 < len(raw) <= PAGE_LIMIT:
                raise ValueError("Invalid federal source size.")
            official(final_url)
            sha = digest(raw)
            ext = "json" if dataset else "html"
            key = f"{PREFIX}/sources/{sha}.{ext}"
            await store.archive(key, raw, sha)
            source.update(finalUrl=final_url, status=200, key=key, sha256=sha, bytes=len(raw))
            document, reason = parse(raw, final_url, dataset)
            if reason:
                source["failure"] = reason
        validate_source(source, url, scheduled, dataset)
        encoded = encode(source)
        if len(encoded) > PIN_LIMIT:
            raise ValueError("Federal catalogue checkpoint exceeds its size limit.")
        if await store.create(pin, encoded, digest(encoded)):
            return source, document, fresh
        saved = await store.read(pin, PIN_LIMIT)
    if saved is None:
        raise ValueError("Missing federal source checkpoint.")
    source = json.loads(saved)
    validate_source(source, url, scheduled, dataset)
    if "key" in source:
        raw = await store.read(source["key"], source["bytes"])
        if raw is None or len(raw) != source["bytes"] or digest(raw) != source["sha256"]:
            raise ValueError("Corrupt archived federal source.")
        document, reason = parse(raw, source["finalUrl"], dataset)
        if reason != source.get("failure"):
            raise ValueError("Federal catalogue checkpoint disagrees with parser.")
    else:
        document = None
    return source, document, fresh


async def acquire(store, fetch, params, clock=now, on_complete=None):
    scheduled, expected = request_fields(params)
    register = await store.read(params["registerKey"], REGISTER_LIMIT)
    endpoints = read_register(register, expected)
    scope = f"{PREFIX}/observations/{scheduled}"
    base = encode(params)
    await store.archive(f"{scope}/register.json", base, digest(base))
    unique = {url: dataset for _, _, url, dataset in endpoints}
    ordered = sorted(unique)
    captured = {}
    fetched = 0
    for offset in range(0, len(ordered), CONCURRENCY):
        batch = ordered[offset:offset + CONCURRENCY]
        results = await asyncio.gather(*(observe(store, fetch, scheduled, url, unique[url], clock) for url in batch),
                                       return_exceptions=True)
        for url, result in zip(batch, results):
            if isinstance(result, BaseException):
                raise result
            source, document, fresh = result
            captured[url] = source, document
            fetched += int(fresh)
    deliveries = []
    for series, field, url, _ in endpoints:
        source, document = captured[url]
        item = {"series": series, "endpoint": field, "url": url, "ok": document is not None}
        if document is None:
            item["reason"] = source["failure"]
        else:
            item["inventory"] = document
        deliveries.append(item)
    packet = {"schemaVersion": 1, "scheduledTime": scheduled, "registerSha256": expected,
              "endpoints": deliveries, "sources": [captured[url][0] for url in ordered]}
    raw = encode(packet)
    if len(raw) > PACKET_LIMIT:
        raise ValueError("Federal discovery inventory exceeds its size limit.")
    sha = digest(raw)
    key = f"{PREFIX}/inventories/{sha}.json"
    await store.archive(key, raw, sha)
    if on_complete:
        on_complete({"event": "federal-discovery-acquired", "scheduledTime": scheduled,
                     "fetched": fetched, "reused": len(ordered) - fetched, "sha256": sha,
                     "succeeded": sum(item["ok"] for item in deliveries), "endpoints": len(deliveries)})
    return {"key": key, "sha256": sha, "bytes": len(raw)}
