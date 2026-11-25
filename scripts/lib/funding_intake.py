"""Capture and revalidate the official pages behind a funding catalogue."""
from datetime import datetime, timezone
from contextlib import contextmanager
from email.parser import BytesParser
import fcntl
from hashlib import sha256
import json
from pathlib import Path
import re
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


def archived_body(root, reference):
    digest = reference.get("sha256", "")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        return None
    path = root / "objects" / digest[:2] / digest
    if not path.is_file() or path.stat().st_size != reference.get("bytes"):
        return None
    body = path.read_bytes()
    return body if sha256(body).hexdigest() == digest else None


class FundingCheckpoint:
    """References captured by one unfinished observation. Callers hold the source lock."""

    def __init__(self, root, output, source, indexes, resume):
        self.path = root / f"{output.name}.in-progress.json"
        identity = {"version": 1, "source": source, "output": output.name, "indexes": indexes}
        if resume:
            if not self.path.is_file():
                raise ValueError(f"No unfinished {source} funding observation for {output.name}.")
            self.state = json.loads(self.path.read_text())
            if any(self.state.get(k) != v for k, v in identity.items()):
                raise ValueError("Funding checkpoint source, output or publisher indexes differ.")
            observed = datetime.fromisoformat(self.state["observedAt"])
            if observed.utcoffset() is None or not isinstance(self.state["pages"], dict):
                raise ValueError("Invalid funding checkpoint.")
            if output.exists() and datetime.fromisoformat(json.loads(output.read_bytes())["observedAt"]) > observed:
                raise ValueError("A newer funding inventory has already been published.")
        else:
            self.state = {**identity, "observedAt": datetime.now(timezone.utc).isoformat(), "pages": {}}
            save_atomic(self.path, self.state)

    def record(self, url, reference):
        self.state["pages"][url] = reference
        save_atomic(self.path, self.state)


def acquire(output, source, collect, *, checkpoint_indexes=None, resume=False):
    output = Path(output)
    root = output.parent / "sources"
    root.mkdir(parents=True, exist_ok=True)
    validators = root / f"{source}-validators.json"
    with (root / f"{source}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if resume and checkpoint_indexes is None:
            raise ValueError("Funding resume requires known publisher indexes.")
        checkpoint = FundingCheckpoint(root, output, source, checkpoint_indexes, resume) if checkpoint_indexes else None
        cache = json.loads(validators.read_text()) if validators.exists() else {}
        seen = {}
        mutex = threading.Lock()

        def capture(url):
            url = official(urldefrag(url)[0])
            with mutex:
                old = cache.get(url, {})
                prior = checkpoint.state["pages"].get(url) if checkpoint else seen.get(url)
            if prior is not None:
                if prior["url"] != url:
                    raise ValueError("Funding checkpoint URL mismatch.")
                resolved = official(prior["resolvedUrl"])
                if prior.get("httpError") in (404, 410):
                    error = HTTPError(resolved, prior["httpError"], "Archived publisher response", {}, None)
                    error.close()
                    raise error
                body = archived_body(root, prior)
                if body is None:
                    raise ValueError(f"Missing or corrupt funding checkpoint object for {url}")
                with mutex:
                    seen[url] = prior
                return body
            body = archived_body(root, old)
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
                    if checkpoint and error.code in (404, 410) and url not in checkpoint_indexes.values():
                        with mutex:
                            checkpoint.record(url, {"url": url, "resolvedUrl": official(error.url), "httpError": error.code})
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
                if checkpoint:
                    checkpoint.record(url, new)
            return data

        packet = collect(capture)
        for language in ("en", "fr"):
            if packet["indexes"][language] not in seen:
                raise ValueError(f"Missing archived {language} index for {source}")
        if checkpoint and packet["indexes"] != checkpoint_indexes:
            raise ValueError("Collected funding indexes differ from the selected checkpoint.")
        packet.update(source=source, observedAt=checkpoint.state["observedAt"] if checkpoint else datetime.now(timezone.utc).isoformat(),
                      sources=[seen[key] for key in sorted(seen)])
        encoded = (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode()
        atomic_write(root / "inventories" / source / (sha256(encoded).hexdigest() + ".json"), encoded)
        atomic_write(output, encoded)
        if checkpoint:
            checkpoint.path.unlink()
        return packet
