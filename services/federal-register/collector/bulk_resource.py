"""Bind federal bulk downloads and their redirects to the exact catalogued resource."""
import io
import re
from urllib.parse import unquote, urlsplit

from federal_bulk_csv import scan

PORTAL = "https://open.canada.ca"
BLOB_HOST = "opencanada.blob.core.windows.net"
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")


def registered_resource(params, expected_dataset):
    if not isinstance(params, dict) or set(params) != {"datasetId", "resourceId", "url"}:
        raise ValueError("Expected a registered CSV resource.")
    dataset, resource, url = (params[key] for key in ("datasetId", "resourceId", "url"))
    if dataset != expected_dataset or not isinstance(resource, str) or not UUID.fullmatch(resource):
        raise ValueError("Unexpected registered CSV dataset or resource ID.")
    prefix = f"{PORTAL}/data/dataset/{dataset}/resource/{resource}/download/"
    if not isinstance(url, str) or len(url) > 2048 or not url.startswith(prefix):
        raise ValueError("Unexpected registered CSV URL.")
    filename = url[len(prefix):]
    decoded = unquote(filename, errors="strict")
    if (not decoded.lower().endswith(".csv") or len(decoded) <= 4 or not filename.lower().endswith(".csv")
            or any(char in decoded for char in "/\\?#") or any(ord(char) < 32 or ord(char) == 127 for char in decoded)
            or any(char.isspace() for char in filename) or re.search(r"%(?![a-fA-F0-9]{2})", filename)):
        raise ValueError("Invalid registered CSV filename.")
    return url, f"/opengovprod/resources/{resource}/{filename}"


def redirect_target(url, portal_path, blob_path):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 33 or c == "\\" or ord(c) == 127 for c in url):
        raise ValueError("Invalid CSV redirect.")
    target = urlsplit(url)
    if (target.scheme != "https" or target.username is not None or target.password is not None
            or target.port not in (None, 443) or target.fragment):
        raise ValueError("Invalid CSV redirect.")
    host = target.hostname or ""
    official = host == "canada.ca" or host.endswith((".canada.ca", ".gc.ca"))
    if (official and target.path == portal_path) or (host == BLOB_HOST and target.path == blob_path):
        return url
    raise ValueError("CSV redirect does not preserve the resource identity.")


def scan_bytes(raw, series, on_row=None):
    with io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig", newline="") as stream:
        return scan(stream, series, on_row=on_row)


def public_metadata(final_url, last_modified, url, blob_path):
    redirect_target(final_url, urlsplit(url).path, blob_path)
    public_url = urlsplit(final_url)._replace(query="", fragment="").geturl()
    return public_url, last_modified if isinstance(last_modified, str) and 0 < len(last_modified) <= 128 else None
