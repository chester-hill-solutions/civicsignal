"""Resource identity, redirect policy, and immutable records for the federal titles register."""
import csv
import io
import re
from urllib.parse import unquote, urlsplit

from discovery import SourceFailure, digest, encode
from federal_bulk_csv import scan

DATASET = "83320390-7715-43bc-a281-2049bf5d4232"
PORTAL = "https://open.canada.ca"
BLOB_HOST = "opencanada.blob.core.windows.net"
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
CSV_LIMIT = 512 * 1024


def resource_request(params):
    if not isinstance(params, dict) or set(params) != {"datasetId", "resourceId", "url"}:
        raise ValueError("Expected an official titles resource.")
    dataset, resource, url = (params[key] for key in ("datasetId", "resourceId", "url"))
    if dataset != DATASET or not isinstance(resource, str) or not UUID.fullmatch(resource):
        raise ValueError("Unexpected official titles dataset or resource ID.")
    prefix = f"{PORTAL}/data/dataset/{dataset}/resource/{resource}/download/"
    if not isinstance(url, str) or len(url) > 2048 or not url.startswith(prefix):
        raise ValueError("Unexpected official titles URL.")
    filename = url[len(prefix):]
    decoded = unquote(filename, errors="strict")
    if (not decoded.lower().endswith(".csv") or len(decoded) <= 4 or not filename.lower().endswith(".csv")
            or any(char in decoded for char in "/\\?#") or any(ord(char) < 32 or ord(char) == 127 for char in decoded)
            or any(char.isspace() for char in filename) or re.search(r"%(?![a-fA-F0-9]{2})", filename)):
        raise ValueError("Invalid official titles filename.")
    return url, f"/opengovprod/resources/{resource}/{filename}"


def redirect_target(url, portal_path, blob_path):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 33 or c == "\\" or ord(c) == 127 for c in url):
        raise ValueError("Invalid titles redirect.")
    target = urlsplit(url)
    if (target.scheme != "https" or target.username is not None or target.password is not None
            or target.port not in (None, 443) or target.fragment):
        raise ValueError("Invalid titles redirect.")
    host = target.hostname or ""
    official = host == "canada.ca" or host.endswith((".canada.ca", ".gc.ca"))
    if (official and target.path == portal_path) or (host == BLOB_HOST and target.path == blob_path):
        return url
    raise ValueError("Titles redirect does not preserve the resource identity.")


async def acquire_titles(store, fetch, params):
    url, blob_path = resource_request(params)
    try:
        raw, final_url, last_modified = await fetch(url, blob_path)
    except SourceFailure as problem:
        return {"status": "failed", "code": problem.reason, "httpStatus": problem.status}
    if not isinstance(raw, bytes) or not 0 < len(raw) <= CSV_LIMIT:
        return {"status": "failed", "code": "publisher-body", "httpStatus": 200}
    # Verify the returned final destination before exposing its public path.
    redirect_target(final_url, urlsplit(url).path, blob_path)
    public_url = urlsplit(final_url)._replace(query="", fragment="").geturl()
    rows = []
    try:
        with io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig", newline="") as stream:
            fields, count = scan(stream, "official-titles", on_row=rows.append)
    except (csv.Error, ValueError):
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    normalized = encode({"schemaVersion": 1, "fields": fields, "rows": rows})
    if len(normalized) > 4 * CSV_LIMIT:
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    if not isinstance(last_modified, str) or len(last_modified) > 128:
        last_modified = None
    result = {"status": "complete", "rows": count, "finalUrl": public_url, "lastModified": last_modified}
    for name, group, ext, data in [("source", "sources", "csv", raw), ("records", "records", "json", normalized)]:
        sha = digest(data)
        key = f"weekly/official-titles/{group}/{sha}.{ext}"
        await store.archive(key, data, sha)
        result[name] = {"key": key, "sha256": sha, "bytes": len(data)}
    return result
