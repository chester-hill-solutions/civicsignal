"""Private service binding for the registered federal catalogue discovery workflow."""
from hashlib import sha256
import io
import json
from urllib.parse import urljoin, urlsplit

import js
from pyodide.ffi import to_js
from workers import WorkerEntrypoint

from discovery import PAGE_LIMIT, SourceFailure, acquire, official, request_fields
from bulk_resource import redirect_target
from official_titles import CSV_LIMIT, acquire_titles, resource_request
from service_inventory import (CSV_LIMIT as SERVICE_LIMIT, acquire_service_inventory,
                               resource_request as service_request)


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
        return await stream_bytes(obj.body, obj.size, obj.size)

    async def archive(self, key, body, digest):
        if await self.create(key, body, digest):
            return
        prior = await self.bucket.get(key)
        if not prior or prior.size != len(body):
            if prior:
                await prior.body.cancel()
            raise ValueError(f"Archive object conflicts with its immutable content: {key}")
        check = sha256()
        await consume(prior.body, prior.size, check.update)
        if check.hexdigest() != digest:
            raise ValueError(f"Archive object conflicts with its immutable content: {key}")


async def consume(stream, limit, write):
    reader = stream.getReader()
    size = 0
    try:
        while True:
            part = await reader.read()
            if part.done:
                break
            size += part.value.byteLength
            if size > limit:
                await reader.cancel()
                raise ValueError("Body exceeds the byte limit.")
            write(part.value.to_bytes())
    finally:
        reader.releaseLock()
    return size


async def stream_bytes(stream, limit, expected):
    # BytesIO returns its backing bytes without a second full Python buffer.
    with io.BytesIO() as output:
        size = await consume(stream, limit, output.write)
        if not size or (expected is not None and size != expected):
            raise ValueError("Response body is empty or truncated.")
        return output.getvalue()


async def bounded_body(response, limit):
    length = response.headers.get("content-length")
    if not response.body:
        raise ValueError("Response body is missing.")
    if length and (not length.isdigit() or int(length) > limit):
        await response.body.cancel()
        raise ValueError("Content length exceeds the byte limit.")
    expected = int(length) if length and not response.headers.has("content-encoding") else None
    return await stream_bytes(response.body, limit, expected)


async def fetch_publisher(url, accept, expected, limit, destination, signal=None):
    final_url = url
    for _ in range(6):
        try:
            response = await js.fetch(final_url, js_object({
                "redirect": "manual", "signal": signal if signal is not None else js.AbortSignal.timeout(35000),
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
                    final_url = destination(urljoin(final_url, location))
                except ValueError as error:
                    raise SourceFailure("publisher-redirect", final_url, status) from error
                continue
            raise SourceFailure(f"http-{status}", final_url, status)
        media = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
        if media not in expected or response.headers.has("content-range") or response.headers.get("cf-mitigated") == "challenge":
            if response.body:
                await response.body.cancel()
            raise SourceFailure("publisher-response-type", final_url, status)
        try:
            body = await bounded_body(response, limit)
        except Exception as error:
            raise SourceFailure("publisher-body", final_url, status) from error
        return body, final_url, response.headers.get("last-modified") or None
    raise SourceFailure("publisher-redirect", final_url)


async def fetch_source(url, dataset):
    accept = "application/json" if dataset else "text/html,application/xhtml+xml"
    expected = ("application/json",) if dataset else ("text/html", "application/xhtml+xml")
    body, final_url, _ = await fetch_publisher(official(url), accept, expected, PAGE_LIMIT, official)
    if not dataset and not body.rstrip().lower().endswith(b"</html>"):
        raise SourceFailure("publisher-body", final_url, 200)
    return body, final_url


async def fetch_csv(url, blob_path, limit=CSV_LIMIT, timeout=35000):
    portal_path = urlsplit(url).path
    allowed = ("text/csv", "application/csv", "application/octet-stream", "binary/octet-stream",
               "text/plain", "application/vnd.ms-excel", "text/comma-separated-values")
    return await fetch_publisher(url, "text/csv,application/csv,application/octet-stream,*/*;q=0.1", allowed,
                                 limit, lambda next_url: redirect_target(next_url, portal_path, blob_path),
                                 signal=js.AbortSignal.timeout(timeout))


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlsplit(request.url).path
        if request.method != "POST" or path not in ("/collect", "/official-titles", "/service-inventory"):
            return js.Response.new("Not found", js_object({"status": 404}))
        try:
            body = await request.text()
            if len(body) > (1024 if path == "/collect" else 4096):
                raise ValueError("Oversized register occurrence.")
            params = json.loads(body)
            if path == "/collect":
                request_fields(params)
            elif path == "/service-inventory":
                service_request(params)
            else:
                resource_request(params)
        except (ValueError, TypeError):
            return js.Response.new("Invalid federal register occurrence", js_object({"status": 400}))
        store = R2Store(self.env.ARCHIVE)
        if path == "/official-titles":
            result = await acquire_titles(store, fetch_csv, params)
        elif path == "/service-inventory":
            async def fetch_service(url, blob_path):
                return await fetch_csv(url, blob_path, SERVICE_LIMIT, 60000)
            result = await acquire_service_inventory(store, fetch_service, params)
        else:
            result = await acquire(store, fetch_source, params,
                                   on_complete=lambda event: js.console.log(js_object(event)))
        return js.Response.json(js_object(result))
