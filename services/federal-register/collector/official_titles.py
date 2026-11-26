"""Resource identity, redirect policy, and immutable records for the federal titles register."""
import csv

from discovery import SourceFailure, digest, encode
from bulk_resource import public_metadata, registered_resource, scan_bytes

DATASET = "83320390-7715-43bc-a281-2049bf5d4232"
CSV_LIMIT = 512 * 1024


def resource_request(params):
    return registered_resource(params, DATASET)


async def acquire_titles(store, fetch, params):
    url, blob_path = resource_request(params)
    try:
        raw, final_url, last_modified = await fetch(url, blob_path)
    except SourceFailure as problem:
        return {"status": "failed", "code": problem.reason, "httpStatus": problem.status}
    if not isinstance(raw, bytes) or not 0 < len(raw) <= CSV_LIMIT:
        return {"status": "failed", "code": "publisher-body", "httpStatus": 200}
    public_url, last_modified = public_metadata(final_url, last_modified, url, blob_path)
    rows = []
    try:
        fields, count = scan_bytes(raw, "official-titles", rows.append)
    except (csv.Error, ValueError):
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    normalized = encode({"schemaVersion": 1, "fields": fields, "rows": rows})
    if len(normalized) > 4 * CSV_LIMIT:
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    result = {"status": "complete", "rows": count, "finalUrl": public_url, "lastModified": last_modified}
    for name, group, ext, data in [("source", "sources", "csv", raw), ("records", "records", "json", normalized)]:
        sha = digest(data)
        key = f"weekly/official-titles/{group}/{sha}.{ext}"
        await store.archive(key, data, sha)
        result[name] = {"key": key, "sha256": sha, "bytes": len(data)}
    return result
