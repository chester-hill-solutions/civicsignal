"""Capture and revalidate the official pages behind a funding catalogue."""
from datetime import datetime, timezone
from contextlib import contextmanager
from email.parser import BytesParser
import fcntl
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lib.parliament_intake import atomic_write, save_atomic


def official(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or
            not (host == "canada.ca" or host.endswith((".canada.ca", ".gc.ca")))):
        raise ValueError(f"Unexpected government funding source: {url}")
    return url


class OfficialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, official(newurl))


@contextmanager
def canada_response(url, headers):
    """Use curl for Canada.ca, checking each redirect before following it."""
    with TemporaryDirectory() as tmp:
        raw_headers = Path(tmp) / "headers"
        body = Path(tmp) / "body"
        for _ in range(10):
            cmd = ["curl", "-q", "--silent", "--show-error", "--max-time", "35",
                   "--connect-timeout", "10", "--dump-header", str(raw_headers),
                   "--output", str(body), "--write-out", "%{http_code}"]
            for key, value in headers.items():
                if key != "User-Agent":
                    cmd.extend(["--header", f"{key}: {value}"])
            result = subprocess.run([*cmd, "--", official(url)], capture_output=True)
            if result.returncode:
                raise URLError(result.stderr.decode(errors="replace").strip())
            status = int(result.stdout)
            block = raw_headers.read_bytes().replace(b"\r\n", b"\n").strip().split(b"\n\n")[-1]
            response_headers = BytesParser().parsebytes(block.partition(b"\n")[2])
            if status in (301, 302, 303, 307, 308) and response_headers.get("Location"):
                url = urljoin(url, response_headers["Location"])
                continue
            if status != 200:
                raise HTTPError(url, status, "Unexpected funding source response", response_headers, None)
            with body.open("rb") as stream:
                yield stream, url, response_headers
            return
        raise ValueError("Too many government funding redirects")


@contextmanager
def open_source(url, headers, source):
    if source == "esdc":
        with canada_response(url, headers) as page:
            yield page
    else:
        with build_opener(OfficialRedirect()).open(Request(url, headers=headers), timeout=40) as response:
            yield response, response.geturl(), response.headers


def acquire(output, source, collect):
    output = Path(output)
    root = output.parent / "sources"
    root.mkdir(parents=True, exist_ok=True)
    validators = root / f"{source}-validators.json"
    with (root / f"{source}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cache = json.loads(validators.read_text()) if validators.exists() else {}
        seen = {}
        mutex = threading.Lock()

        def capture(url):
            url = official(urldefrag(url)[0])
            with mutex:
                old = cache.get(url, {})
                prior = seen.get(url)
            digest = old.get("sha256", "")
            path = root / "objects" / digest[:2] / digest
            body = path.read_bytes() if digest and path.is_file() else None
            if body is not None and sha256(body).hexdigest() != digest:
                body = None
            if prior and body is not None:
                return body
            headers = {"User-Agent": "CivicSignal/0.1 (bilingual funding catalogue)", "Accept-Encoding": "identity"}
            if body is not None:
                for field, header in (("etag", "If-None-Match"), ("lastModified", "If-Modified-Since")):
                    if old.get(field):
                        headers[header] = old[field]
            for attempt in range(3):
                try:
                    with open_source(url, headers, source) as (response, resolved, response_headers):
                        data = response.read()
                        if not data:
                            raise ValueError(f"Empty government source: {url}")
                        digest = sha256(data).hexdigest()
                        new = {"url": url, "resolvedUrl": resolved, "sha256": digest, "bytes": len(data),
                               "etag": response_headers.get("ETag"), "lastModified": response_headers.get("Last-Modified")}
                        target = root / "objects" / digest[:2] / digest
                        if not target.exists() or sha256(target.read_bytes()).hexdigest() != digest:
                            atomic_write(target, data)
                        break
                except HTTPError as error:
                    error.close()
                    if error.code == 304 and body is not None:
                        new, data = old, body
                        break
                    if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                        raise
                except (URLError, TimeoutError):
                    if attempt == 2:
                        raise
                time.sleep(2 ** attempt)
            with mutex:
                cache[url] = seen[url] = new
                save_atomic(validators, cache)
            return data

        packet = collect(capture)
        for language in ("en", "fr"):
            if packet["indexes"][language] not in seen:
                raise ValueError(f"Missing archived {language} index for {source}")
        packet.update(source=source, observedAt=datetime.now(timezone.utc).isoformat(),
                      sources=[seen[key] for key in sorted(seen)])
        encoded = (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode()
        atomic_write(root / "inventories" / source / (sha256(encoded).hexdigest() + ".json"), encoded)
        atomic_write(output, encoded)
        return packet
