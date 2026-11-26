"""Service-binding-only acquisition of House calls and Senate availability evidence."""
from hashlib import sha256
import json
from urllib.parse import urljoin, urlsplit

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint

from house import PAGE_LIMIT, REQUEST_LIMIT, PublisherUnavailable, acquire, publisher_url, read_request


def js_object(value):
    return to_js(value, dict_converter=js.Object.fromEntries)


class R2Store:
    def __init__(self, bucket):
        self.bucket = bucket

    async def create(self, key, body, digest):
        obj = await self.bucket.put(key, to_js(body), js_object({
            "onlyIf": {"etagDoesNotMatch": "*"}, "sha256": digest,
        }))
        if obj and (obj.key != key or obj.size != len(body)):
            raise ValueError(f"Unexpected archive write metadata: {key}")
        return bool(obj)

    async def read(self, key, limit):
        obj = await self.bucket.get(key)
        if not obj:
            return None
        if obj.size > limit:
            await obj.body.cancel()
            raise ValueError(f"Archive object exceeds the read limit: {key}")
        return js.Uint8Array.new(await obj.arrayBuffer()).to_bytes()

    async def archive(self, key, body, digest):
        if not await self.create(key, body, digest):
            stored = await self.read(key, len(body))
            if stored is None or sha256(stored).hexdigest() != digest:
                raise ValueError(f"Archive object conflicts with its immutable content: {key}")


async def bounded_body(response, limit):
    size = response.headers.get("content-length")
    if not response.body:
        raise ValueError("Response body is missing.")
    if size and (not size.isdigit() or int(size) > limit):
        await response.body.cancel()
        raise ValueError("Content length exceeds the byte limit.")
    reader = response.body.getReader()
    body = bytearray()
    try:
        while True:
            part = await reader.read()
            if part.done:
                break
            if len(body) + part.value.byteLength > limit:
                await reader.cancel()
                raise ValueError("Response exceeds the byte limit.")
            body.extend(part.value.to_bytes())
    finally:
        reader.releaseLock()
    if not body or (size and not response.headers.has("content-encoding") and int(size) != len(body)):
        raise ValueError("Response body is empty or truncated.")
    return bytes(body)


async def fetch_page(url, chamber):
    resolved = publisher_url(url, chamber)
    for _ in range(6):
        try:
            response = await js.fetch(resolved, js_object({
                "redirect": "manual", "signal": js.AbortSignal.timeout(35000),
                "headers": {"Accept": "text/html,application/xhtml+xml",
                            "User-Agent": "civicsignal.ca research crawler (info@civicsignal.ca)"},
            }))
        except Exception as error:
            raise PublisherUnavailable("Publisher request failed.", resolved) from error
        status = response.status
        if status != 200:
            if response.body:
                await response.body.cancel()
            location = response.headers.get("location")
            if status in (301, 302, 303, 307, 308) and location:
                try:
                    resolved = publisher_url(urljoin(resolved, location), chamber)
                except ValueError as error:
                    raise PublisherUnavailable("Redirect left the publisher.", resolved, status) from error
                continue
            raise PublisherUnavailable(f"Publisher returned HTTP {status}.", resolved, status)
        media = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        if (media not in ("text/html", "application/xhtml+xml") or response.headers.has("content-range")
                or response.headers.get("cf-mitigated") == "challenge"):
            if response.body:
                await response.body.cancel()
            raise PublisherUnavailable("Expected a complete publisher HTML page.", resolved, status)
        try:
            body = await bounded_body(response, PAGE_LIMIT)
        except Exception as error:
            raise PublisherUnavailable("Could not read complete publisher HTML.", resolved, status) from error
        if not body.rstrip().lower().endswith(b"</html>"):
            raise PublisherUnavailable("Incomplete publisher HTML document.", resolved, status)
        return body, resolved
    raise PublisherUnavailable("Publisher redirect limit exceeded.", resolved)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != "POST" or urlsplit(request.url).path != "/collect":
            return js.Response.new("Not found", js_object({"status": 404}))
        try:
            size = request.headers.get("content-length")
            if size and (not size.isdigit() or int(size) > REQUEST_LIMIT):
                raise ValueError("Observation request exceeds its byte limit.")
            body = await request.text()
            if len(body) > REQUEST_LIMIT or len(body.encode()) > REQUEST_LIMIT:
                raise ValueError("Observation request exceeds its byte limit.")
            params = json.loads(body)
            read_request(params)
        except (ValueError, TypeError, KeyError):
            return js.Response.new("Invalid House calls observation request", js_object({"status": 400}))
        result = await acquire(R2Store(self.env.ARCHIVE), fetch_page, params,
                               on_complete=lambda event: js.console.log(js_object(event)))
        return js.Response.json(js_object(result))
