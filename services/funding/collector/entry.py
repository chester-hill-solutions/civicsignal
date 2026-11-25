"""Private NSERC acquisition service for the funding refresh Workflow."""
import json
import re
from datetime import datetime
from hashlib import sha256
from urllib.parse import urldefrag, urljoin, urlsplit

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint

from nserc import ALLOWED_HOSTS, INDEXES, requested_pages


PAGE_LIMIT = 2 * 1024 * 1024
TOTAL_LIMIT = 16 * 1024 * 1024
PACKET_LIMIT = 8 * 1024 * 1024
SOURCE_LIMIT = 64
REDIRECT_LIMIT = 5


def js_object(value):
    return to_js(value, dict_converter=js.Object.fromEntries)


def publisher_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or
            parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443)):
        raise ValueError("Unexpected NSERC publisher URL.")
    return urldefrag(url).url


async def read_page(response, limit):
    length = response.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > limit):
        await response.body.cancel()
        raise ValueError("NSERC source exceeds its byte limit.")
    reader = response.body.getReader()
    body = bytearray()
    try:
        while True:
            chunk = await reader.read()
            if chunk.done:
                break
            if len(body) + chunk.value.byteLength > limit:
                await reader.cancel()
                raise ValueError("NSERC source exceeds its byte limit.")
            body.extend(chunk.value.to_bytes())
    finally:
        reader.releaseLock()
    if not body or (length and not response.headers.has("content-encoding") and len(body) != int(length)):
        raise ValueError("NSERC publisher supplied an empty or incomplete page.")
    return bytes(body)


async def fetch_page(url, limit):
    resolved = publisher_url(url)
    for _ in range(REDIRECT_LIMIT + 1):
        response = await js.fetch(resolved, js_object({
            "redirect": "manual", "signal": js.AbortSignal.timeout(30000),
            "headers": {"Accept": "text/html", "User-Agent": "CivicSignal/0.1 (bilingual funding catalogue)"},
        }))
        if response.status in (301, 302, 303, 307, 308):
            location = response.headers.get("location")
            if response.body:
                await response.body.cancel()
            if not location:
                raise ValueError("NSERC publisher redirect has no destination.")
            resolved = publisher_url(urljoin(resolved, location))
            continue
        if response.status != 200 or not response.body or response.headers.has("content-range"):
            if response.body:
                await response.body.cancel()
            raise ValueError(f"NSERC publisher returned HTTP {response.status} for {resolved}.")
        body = await read_page(response, limit)
        return body, {
            "url": url, "resolvedUrl": resolved, "sha256": sha256(body).hexdigest(), "bytes": len(body),
            "etag": response.headers.get("etag") or None,
            "lastModified": response.headers.get("last-modified") or None,
        }
    raise ValueError("NSERC publisher redirect limit exceeded.")


async def archive(bucket, key, data, digest):
    created = await bucket.put(key, to_js(data), js_object({"onlyIf": {"etagDoesNotMatch": "*"}, "sha256": digest}))
    if created:
        if created.key != key or created.size != len(data):
            raise ValueError("NSERC archive write returned unexpected metadata.")
        return
    existing = await bucket.get(key)
    if not existing or existing.size != len(data):
        raise ValueError("NSERC archive object is missing or has unexpected length.")
    stored = js.Uint8Array.new(await existing.arrayBuffer()).to_bytes()
    if sha256(stored).hexdigest() != digest:
        raise ValueError("NSERC archive object has unexpected content.")


async def acquire(bucket, observed_at):
    refs = {}
    bodies = {}
    total = 0
    pages = requested_pages(dict(INDEXES))
    url = next(pages)
    while True:
        if url not in refs:
            if len(refs) >= SOURCE_LIMIT or total >= TOTAL_LIMIT:
                raise ValueError("NSERC catalogue exceeds its acquisition budget.")
            body, ref = await fetch_page(url, min(PAGE_LIMIT, TOTAL_LIMIT - total))
            await archive(bucket, f"funding/nserc/sources/{ref['sha256']}.html", body, ref["sha256"])
            refs[url] = ref
            bodies[url] = body
            total += len(body)
        try:
            url = pages.send(bodies[url])
        except StopIteration as done:
            packet = done.value
            break
    packet.update(source="nserc", observedAt=observed_at, sources=[refs[key] for key in sorted(refs)])
    encoded = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > PACKET_LIMIT:
        raise ValueError("NSERC inventory exceeds its byte limit.")
    digest = sha256(encoded).hexdigest()
    key = f"funding/nserc/inventories/{digest}.json"
    await archive(bucket, key, encoded, digest)
    return {"key": key, "sha256": digest, "bytes": len(encoded), "sources": len(refs), "sourceBytes": total}


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != "POST" or urlsplit(request.url).path != "/collect":
            return js.Response.new("Not found", js_object({"status": 404}))
        try:
            params = json.loads(await request.text())
            if not isinstance(params, dict) or set(params) != {"observedAt"}:
                raise ValueError()
            observed_at = params["observedAt"]
            if not isinstance(observed_at, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", observed_at):
                raise ValueError()
            datetime.fromisoformat(observed_at)
        except (ValueError, TypeError):
            return js.Response.new("Invalid observation time", js_object({"status": 400}))
        return js.Response.json(js_object(await acquire(self.env.ARCHIVE, observed_at)))
