"""Checkpoint and verify official committee publication downloads by URL and byte hash."""

import gzip
import hashlib
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from urllib.parse import quote, urldefrag, urlsplit

from .wq_catalog import UA

HOSTS = {
    "www.ourcommons.ca",
    "www.noscommunes.ca",
    "www.parl.ca",
    "sencanada.ca",
    "publications.gc.ca",
    "lop.parl.ca",
    "www.sencanada.ca",
}


def official(url):
    parsed = urlsplit(url)
    return (
        parsed.scheme == "https"
        and parsed.hostname in HOSTS
        and not parsed.username
        and not parsed.password
    )


def cache_db(root):
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "downloads.sqlite", timeout=45)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS files(
      url TEXT PRIMARY KEY, digest TEXT, media TEXT, size INTEGER, error TEXT, checked TEXT, final_url TEXT)""")
    return db


def object_path(root, digest):
    return root / "objects" / digest[:2] / (digest + ".gz")


def read_object(root, digest):
    data = gzip.decompress(object_path(root, digest).read_bytes())
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Original checksum mismatch: " + digest)
    return data


def verify_objects(root):
    db = cache_db(root)
    try:
        digests = list(
            db.execute(
                "SELECT DISTINCT digest,size FROM files WHERE digest IS NOT NULL"
            )
        )
        for digest, size in digests:
            sha = hashlib.sha256()
            length = 0
            with gzip.open(object_path(root, digest), "rb") as stream:
                while block := stream.read(1024 * 1024):
                    sha.update(block)
                    length += len(block)
            if length != size or sha.hexdigest() != digest:
                raise ValueError("Original failed length or SHA-256 check: " + digest)
        return len(digests)
    finally:
        db.close()


def download(root, url):
    from datetime import datetime, timezone

    checked = datetime.now(timezone.utc).isoformat()
    if not official(url):
        return (url, None, None, 0, "unrecognized publication host", checked, None)
    current = url
    with tempfile.TemporaryDirectory(dir=root) as directory:
        raw = Path(directory) / "source"
        for hop in range(6):
            if not official(current):
                return (
                    url,
                    None,
                    None,
                    0,
                    "redirect outside official publication hosts",
                    checked,
                    current,
                )
            encoded = quote(current, safe=":/?#[]@!$&'()*+,;=%")
            referral = []
            if current.startswith(
                "https://publications.gc.ca/collections/"
            ) and urlsplit(current).path.lower().endswith(".pdf"):
                # The publisher serves the archive notice until its public Continue link is followed.
                referral = [
                    "--referer",
                    "https://publications.gc.ca/site/archivee-archived.html?url="
                    + quote(current, safe=""),
                ]
            result = subprocess.run(
                [
                    "curl",
                    *referral,
                    "--silent",
                    "--show-error",
                    "--globoff",
                    "--proto",
                    "=https",
                    "--retry",
                    "2",
                    "--retry-delay",
                    "1",
                    "--retry-all-errors",
                    "--max-time",
                    "60",
                    "--connect-timeout",
                    "10",
                    "--user-agent",
                    UA,
                    "--output",
                    str(raw),
                    "--write-out",
                    "%{http_code}\n%{content_type}\n%{redirect_url}",
                    encoded,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode:
                return (
                    url,
                    None,
                    None,
                    0,
                    result.stderr.strip()[:500],
                    checked,
                    current,
                )
            status, media, redirect = result.stdout.split("\n", 2)
            if status in {"301", "302", "303", "307", "308"} and redirect:
                current = redirect
                continue
            if status != "200":
                return (url, None, None, 0, "HTTP " + status, checked, current)
            sha = hashlib.sha256()
            packed = Path(directory) / "packed"
            with raw.open("rb") as source, packed.open("wb") as out:
                with gzip.GzipFile(
                    fileobj=out, mode="wb", compresslevel=1, mtime=0
                ) as gz:
                    while block := source.read(256 * 1024):
                        sha.update(block)
                        gz.write(block)
            digest = sha.hexdigest()
            path = object_path(root, digest)
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.is_file():
                os.replace(packed, path)
            return (
                url,
                digest,
                media.partition(";")[0],
                raw.stat().st_size,
                None,
                checked,
                current,
            )
    return (url, None, None, 0, "too many redirects", checked, current)


def fetch_url(url):
    base, fragment = urldefrag(url)
    # The House published FINA BR13581575 with a literal '#' inside the PDF name.
    if (
        "/content/committee/" in urlsplit(base).path.lower()
        and base.endswith("-")
        and re.fullmatch(r"[0-9-]+-[efb]\.pdf", fragment, re.I)
    ):
        return base + "%23" + fragment
    return base


def download_urls(catalogue):
    urls = {
        fetch_url(item["url"])
        for page in catalogue["indexes"].values()
        for item in page.get("links", [])
        if item.get("url")
    }
    urls.update(
        fetch_url(item["studyUrl"])
        for key, page in catalogue["indexes"].items()
        if key.startswith("senate/") and key.endswith("/briefs")
        for item in page.get("links", [])
        if item.get("studyUrl") and official(item["studyUrl"])
    )
    return sorted(urls)


def checkpoint(db, rows):
    with db:
        for row in rows:
            url, digest, media, size, error, checked, final_url = row
            # A transport failure during refresh says nothing about the last verified bytes.
            if not digest and error not in ("HTTP 404", "HTTP 410"):
                prior = db.execute(
                    "SELECT digest,media,size,final_url FROM files WHERE url=?", (url,)
                ).fetchone()
                if prior and prior[0]:
                    digest, media, size, final_url = prior
            db.execute(
                "INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",
                (url, digest, media, size, error, checked, final_url),
            )


def capture(root, urls, workers=10, refresh=False):
    from concurrent.futures import ThreadPoolExecutor
    from collections import Counter

    with cache_db(root) as db:
        existing = (
            {
                row["url"]
                for row in db.execute(
                    "SELECT url,digest FROM files WHERE digest IS NOT NULL AND error IS NULL"
                )
                if object_path(root, row["digest"]).is_file()
            }
            if not refresh
            else set()
        )
        work = [url for url in urls if url not in existing]
        counts = Counter()
        print(
            f"Official URLs {len(urls)}, cached {len(urls) - len(work)}, fetching {len(work)}",
            flush=True,
        )
        buffered = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i, row in enumerate(pool.map(lambda url: download(root, url), work), 1):
                buffered.append(row)
                counts[row[4] or "stored"] += 1
                if i % 32 == 0:
                    checkpoint(db, buffered)
                    buffered.clear()
                if i % 500 == 0:
                    print(i, counts.most_common(4), flush=True)
        checkpoint(db, buffered)
        print("Fetch result", counts.most_common(12), flush=True)
