"""Private ESDC acquisition service for the funding refresh Workflow."""
from hashlib import sha256
import json
from urllib.parse import urljoin, urlsplit

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint

from observation import PAGE_LIMIT, acquire, observation_time, publisher_url


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
            raise ValueError(f"Unexpected ESDC archive write metadata: {key}")
        return bool(obj)

    async def read(self, key, limit):
        obj = await self.bucket.get(key)
        if not obj:
            return None
        if obj.size > limit:
            await obj.body.cancel()
            raise ValueError(f"ESDC archive object exceeds its size limit: {key}")
        return js.Uint8Array.new(await obj.arrayBuffer()).to_bytes()

    async def archive(self, key, body, digest):
        if await self.create(key, body, digest):
            return
        stored = await self.read(key, len(body))
        if stored is None or len(stored) != len(body) or sha256(stored).hexdigest() != digest:
            raise ValueError(f"Conflicting ESDC archive contents: {key}")


async def fetch_page(url):
    resolved = publisher_url(url)
    for _ in range(6):
        response = await js.fetch(resolved, js_object({
            "redirect": "manual", "signal": js.AbortSignal.timeout(35000),
            "headers": {"Accept": "text/html", "User-Agent": "civicsignal.ca research crawler (info@civicsignal.ca)"},
        }))
        status = response.status
        ref = {"url": url, "resolvedUrl": resolved, "status": status}
        if status != 200 or response.headers.has("content-range"):
            if response.body:
                await response.body.cancel()
            location = response.headers.get("location")
            if status in (301, 302, 303, 307, 308) and location:
                resolved = publisher_url(urljoin(resolved, location))
                continue
            if status in (404, 410):
                return ref, None
            raise ValueError(f"Unexpected ESDC HTTP response {status} for {resolved}")
        if not response.body:
            raise ValueError(f"Missing body from {resolved}")
        length = response.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > PAGE_LIMIT):
            await response.body.cancel()
            raise ValueError(f"Invalid ESDC content length: {resolved}")
        reader = response.body.getReader()
        body = bytearray()
        try:
            while True:
                part = await reader.read()
                if part.done:
                    break
                if len(body) + part.value.byteLength > PAGE_LIMIT:
                    await reader.cancel()
                    raise ValueError(f"ESDC page exceeds its size limit: {resolved}")
                body.extend(part.value.to_bytes())
        finally:
            reader.releaseLock()
        if not body or (length and not response.headers.has("content-encoding") and len(body) != int(length)):
            raise ValueError(f"Incomplete ESDC source: {resolved}")
        ref.update(etag=response.headers.get("etag") or None,
                   lastModified=response.headers.get("last-modified") or None)
        return ref, bytes(body)
    raise ValueError(f"Too many publisher redirects from {url}")


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != "POST" or urlsplit(request.url).path != "/collect":
            return js.Response.new("Not found", js_object({"status": 404}))
        try:
            params = json.loads(await request.text())
            if not isinstance(params, dict) or set(params) != {"observedAt"}:
                raise ValueError()
            observed_at = observation_time(params["observedAt"])
        except (ValueError, TypeError):
            return js.Response.new("Invalid observation time", js_object({"status": 400}))
        result = await acquire(R2Store(self.env.ARCHIVE), fetch_page, observed_at,
                               lambda event: js.console.log(js_object(event)))
        return js.Response.json(js_object(result))
