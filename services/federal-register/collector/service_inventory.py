"""Acquire one weekly Service Inventory resource, or verify its original and reuse its checkpoint."""
import csv
import json

from bulk_resource import public_metadata, registered_resource, scan_bytes
from discovery import DIGEST, SourceFailure, digest, encode

DATASET = "3ac0d080-6149-499a-8b06-7ce5f00ec56c"
PREFIX = "weekly/service-inventory"
CSV_LIMIT = 24 * 1024 * 1024
PIN_LIMIT = 32 * 1024


def resource_request(params):
    if not isinstance(params, dict):
        raise ValueError("Expected a service inventory observation.")
    scheduled = params.get("scheduledTime")
    if type(scheduled) is not int or not 0 < scheduled < 4102444800000:
        raise ValueError("Invalid service inventory occurrence.")
    return registered_resource({key: value for key, value in params.items() if key != "scheduledTime"}, DATASET)


async def replay(store, saved, params, url, blob_path):
    checkpoint = json.loads(saved)
    if not isinstance(checkpoint, dict) or set(checkpoint) != {"schemaVersion", "result", *params}:
        raise ValueError("Invalid service inventory checkpoint.")
    if type(checkpoint["schemaVersion"]) is not int or checkpoint["schemaVersion"] != 1 or any(
            checkpoint[k] != v for k, v in params.items()):
        raise ValueError("Service inventory checkpoint belongs to another occurrence or resource.")
    result = checkpoint["result"]
    if (not isinstance(result, dict) or set(result) != {"status", "source", "rows", "fields", "finalUrl", "lastModified"}
            or result["status"] != "complete" or type(result["rows"]) is not int or result["rows"] <= 0):
        raise ValueError("Invalid service inventory success checkpoint.")
    public_url, last_modified = public_metadata(result["finalUrl"], result["lastModified"], url, blob_path)
    if public_url != result["finalUrl"] or last_modified != result["lastModified"]:
        raise ValueError("Invalid checkpointed service inventory response metadata.")
    source = result["source"]
    if not isinstance(source, dict) or set(source) != {"key", "sha256", "bytes"}:
        raise ValueError("Invalid service inventory original reference.")
    sha, size = source["sha256"], source["bytes"]
    if (not isinstance(sha, str) or not DIGEST.fullmatch(sha) or source["key"] != f"{PREFIX}/sources/{sha}.csv"
            or type(size) is not int or not 0 < size <= CSV_LIMIT):
        raise ValueError("Invalid service inventory source identity.")
    raw = await store.read(source["key"], size)
    if raw is None or len(raw) != size or digest(raw) != sha:
        raise ValueError("Service inventory original differs from its checkpoint.")
    fields, count = scan_bytes(raw, "service-inventory")
    if (fields, count) != (result["fields"], result["rows"]):
        raise ValueError("Service inventory checkpoint differs from the archived CSV rows.")
    return result


async def acquire_service_inventory(store, fetch, params):
    url, blob_path = resource_request(params)
    pin = f"{PREFIX}/checkpoints/{params['scheduledTime']}/{params['resourceId']}.json"
    saved = await store.read(pin, PIN_LIMIT)
    if saved is not None:
        return await replay(store, saved, params, url, blob_path)
    try:
        raw, final_url, last_modified = await fetch(url, blob_path)
    except SourceFailure as problem:
        return {"status": "failed", "code": problem.reason, "httpStatus": problem.status}
    if not isinstance(raw, bytes) or not 0 < len(raw) <= CSV_LIMIT:
        return {"status": "failed", "code": "publisher-body", "httpStatus": 200}
    final_url, last_modified = public_metadata(final_url, last_modified, url, blob_path)
    try:
        fields, count = scan_bytes(raw, "service-inventory")
    except (ValueError, csv.Error):
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    if len(fields) > 128:
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    sha = digest(raw)
    key = f"{PREFIX}/sources/{sha}.csv"
    result = {"status": "complete", "source": {"key": key, "sha256": sha, "bytes": len(raw)},
              "rows": count, "fields": fields, "finalUrl": final_url, "lastModified": last_modified}
    checkpoint = encode({"schemaVersion": 1, **params, "result": result})
    if len(checkpoint) > PIN_LIMIT:
        return {"status": "failed", "code": "invalid-csv", "httpStatus": 200}
    await store.archive(key, raw, sha)
    del raw
    if await store.create(pin, checkpoint, digest(checkpoint)):
        return result
    saved = await store.read(pin, PIN_LIMIT)
    if saved is None:
        raise ValueError("Missing winning service inventory checkpoint.")
    return await replay(store, saved, params, url, blob_path)
