"""Private service binding for the registered federal catalogue discovery workflow."""
from hashlib import sha256
import json
from urllib.parse import urljoin, urlsplit

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint

from discovery import PAGE_LIMIT, SourceFailure, acquire, official, request_fields


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


async def fetch_source(url, dataset):
    final_url = official(url)
    accept = "application/json" if dataset else "text/html,application/xhtml+xml"
    for _ in range(6):
        try:
            response = await js.fetch(final_url, js_object({
                "redirect": "manual", "signal": js.AbortSignal.timeout(35000),
                "headers": {"Accept": accept, "User-Agent": "civicsignal.ca research crawler (info@civicsignal.ca)"},
            }))
        except Exception as error:
            raise SourceFailure("publisher-network", final_url) from error
        status = response.status
        if status != 200:
            if response.body:
                await response.body.cancel()
            location = response.headers.get("location")
            if status in (301, 302, 303, 307, 308) and location:
                try:
                    final_url = official(urljoin(final_url, location))
                except ValueError as error:
                    raise SourceFailure("publisher-redirect", final_url, status) from error
                continue
            raise SourceFailure(f"http-{status}", final_url, status)
        media = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        expected = ("application/json",) if dataset else ("text/html", "application/xhtml+xml")
        if media not in expected or response.headers.has("content-range") or response.headers.get("cf-mitigated") == "challenge":
            if response.body:
                await response.body.cancel()
            raise SourceFailure("publisher-response-type", final_url, status)
        try:
            body = await bounded_body(response, PAGE_LIMIT)
        except Exception as error:
            raise SourceFailure("publisher-body", final_url, status) from error
        if not dataset and not body.rstrip().lower().endswith(b"</html>"):
            raise SourceFailure("publisher-body", final_url, status)
        return body, final_url
    raise SourceFailure("publisher-redirect", final_url)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != "POST" or urlsplit(request.url).path != "/collect":
            return js.Response.new("Not found", js_object({"status": 404}))
        try:
            body = await request.text()
            if len(body) > 1024:
                raise ValueError("Oversized register occurrence.")
            params = json.loads(body)
            request_fields(params)
        except (ValueError, TypeError):
            return js.Response.new("Invalid federal register occurrence", js_object({"status": 400}))
        result = await acquire(R2Store(self.env.ARCHIVE), fetch_source, params,
                               on_complete=lambda event: js.console.log(js_object(event)))
        return js.Response.json(js_object(result))
