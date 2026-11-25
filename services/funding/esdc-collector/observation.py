"""Capture and replay one publisher observation from immutable objects."""
import asyncio
from datetime import datetime
import gc
from hashlib import sha256
import io
import json
import re
from urllib.error import HTTPError
from urllib.parse import urldefrag, urlsplit

from esdc import INDEXES, is_government_url, parse_detail, requested_pages

PREFIX = "funding/esdc"
PAGE_LIMIT = 2 * 1024 * 1024
TOTAL_LIMIT = 32 * 1024 * 1024
PACKET_LIMIT = 12 * 1024 * 1024
URL_LIMIT = 768
CHECKPOINT_LIMIT = 16 * 1024
CONCURRENCY = 4


def publisher_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not is_government_url(url) or parsed.username is not None
            or parsed.password is not None or parsed.port not in (None, 443)):
        raise ValueError(f"Unexpected ESDC publisher URL: {url}")
    return urldefrag(url).url


def observation_time(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value):
        raise ValueError("Expected UTC observation with milliseconds.")
    datetime.fromisoformat(value)
    return value


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def inventory_json(packet):
    # Encode one row at a time so the complete catalogue never exists as a wide
    # Unicode string alongside the encoded packet and parsed records in Wasm.
    out = io.BytesIO()
    out.write(b"{")
    for i, (key, value) in enumerate(packet.items()):
        if i:
            out.write(b",")
        out.write(compact_json(key) + b":")
        if isinstance(value, list):
            out.write(b"[")
            for j, item in enumerate(value):
                if j:
                    out.write(b",")
                out.write(compact_json(item))
                if out.tell() > PACKET_LIMIT:
                    raise ValueError("ESDC inventory exceeds its byte limit.")
            out.write(b"]")
        else:
            out.write(compact_json(value))
    out.write(b"}")
    if out.tell() > PACKET_LIMIT:
        raise ValueError("ESDC inventory exceeds its byte limit.")
    return out.getvalue()


def checkpoint_key(observed_at, url):
    return f"{PREFIX}/observations/{observed_at}/pages/{sha256(url.encode()).hexdigest()}.json"


async def capture(store, fetch, observed_at, url):
    publisher_url(url)
    key = checkpoint_key(observed_at, url)
    cached = await store.read(key, CHECKPOINT_LIMIT)
    fetched = cached is None
    if fetched:
        checkpoint, body = await fetch(url)
        status = checkpoint["status"]
        if checkpoint["url"] != url or publisher_url(checkpoint["resolvedUrl"]) != checkpoint["resolvedUrl"]:
            raise ValueError(f"Invalid ESDC publisher URL in response: {url}")
        if status == 200:
            if not isinstance(body, bytes) or not 0 < len(body) <= PAGE_LIMIT:
                raise ValueError(f"Invalid ESDC publisher body: {url}")
        elif status not in (404, 410) or url in INDEXES.values() or body is not None:
            raise RuntimeError(f"Unexpected ESDC HTTP {status}: {url}")
        if body is not None:
            digest = sha256(body).hexdigest()
            checkpoint.update(sha256=digest, bytes=len(body))
            await store.archive(f"{PREFIX}/sources/{digest}.html", body, digest)
        encoded = compact_json(checkpoint)
        if len(encoded) > CHECKPOINT_LIMIT:
            raise ValueError("ESDC checkpoint metadata exceeds its byte limit.")
        # If concurrent retries race, both must parse the winner's observation.
        if await store.create(key, encoded, sha256(encoded).hexdigest()):
            cached = encoded
        else:
            cached = await store.read(key, CHECKPOINT_LIMIT)
            if cached is None:
                raise ValueError(f"ESDC checkpoint disappeared: {url}")
            body = None
    else:
        body = None
    ref = json.loads(cached)
    if ref["url"] != url or publisher_url(ref["resolvedUrl"]) != ref["resolvedUrl"]:
        raise ValueError(f"Invalid ESDC checkpoint URL: {url}")
    status = ref.pop("status")
    if status in (404, 410) and url not in INDEXES.values():
        error = HTTPError(ref["resolvedUrl"], status, "Confirmed publisher response", {}, None)
        error.close()
        return error, None, fetched
    if (status != 200 or not re.fullmatch(r"[a-f0-9]{64}", ref["sha256"])
            or type(ref["bytes"]) is not int or not 0 < ref["bytes"] <= PAGE_LIMIT):
        raise ValueError(f"Invalid ESDC checkpoint metadata: {url}")
    if body is None:
        body = await store.read(f"{PREFIX}/sources/{ref['sha256']}.html", ref["bytes"])
    if body is None or len(body) != ref["bytes"] or sha256(body).hexdigest() != ref["sha256"]:
        raise ValueError(f"Missing or corrupt ESDC source: {url}")
    return (body if url in INDEXES.values() else parse_detail(body, url)), ref, fetched


async def acquire(store, fetch, observed_at, on_complete=None):
    observation_time(observed_at)
    refs = {}
    count = total = fetched = 0
    pages = requested_pages()
    urls = next(pages)
    while True:
        count += len(urls)
        if count > URL_LIMIT:
            raise ValueError("ESDC catalogue exceeds its URL limit.")
        results = {}
        for offset in range(0, len(urls), CONCURRENCY):
            batch = urls[offset:offset + CONCURRENCY]
            captured = await asyncio.gather(*(capture(store, fetch, observed_at, url) for url in batch),
                                            return_exceptions=True)
            for url, result in zip(batch, captured):
                if isinstance(result, BaseException):
                    raise RuntimeError(f"ESDC capture failed for {url}: {result}") from result
                page, ref, from_publisher = result
                fetched += int(from_publisher)
                results[url] = page
                if ref is not None:
                    refs[url] = ref
                    total += ref["bytes"]
            if total > TOTAL_LIMIT:
                raise ValueError("ESDC catalogue exceeds its source byte limit.")
        try:
            urls = pages.send(results)
        except StopIteration as done:
            packet = done.value
            break
    del results, pages, captured
    gc.collect()
    packet.update(source="esdc", observedAt=observed_at, sources=[refs[key] for key in sorted(refs)])
    encoded = inventory_json(packet)
    del packet
    gc.collect()
    digest = sha256(encoded).hexdigest()
    key = f"{PREFIX}/inventories/{digest}.json"
    await store.archive(key, encoded, digest)
    if on_complete:
        on_complete({"event": "esdc-acquisition-complete", "observedAt": observed_at,
                     "fetchedPages": fetched, "checkpointPages": count - fetched,
                     "successfulPages": len(refs), "terminalPages": count - len(refs),
                     "sourceBytes": total, "inventorySha256": digest})
    return {"key": key, "sha256": digest, "bytes": len(encoded), "sources": len(refs), "sourceBytes": total}
