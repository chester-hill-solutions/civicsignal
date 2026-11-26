#!/usr/bin/env python3
"""Seed the private staging institution coverage snapshot. Stdout is the immutable manifest reference."""
import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from hashlib import md5
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services/institution-coverage/container"))
import snapshot  # noqa: E402

BUCKET = "civicsignal-stage-weekly"
ACCOUNT = "ad5ec479b9a421faa2ed06c3d1c2b23a"


def existing_chunks():
    cursor = []
    found = {}
    while True:
        values = json.loads(subprocess.check_output([
            "cf", "r2", "objects", "list", "--bucket-name", BUCKET,
            "--prefix", f"{snapshot.PREFIX}/chunks/", "--per-page", "1000", *cursor,
        ], env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT}, timeout=90))
        found.update((item["key"], (item["size"], item["etag"].strip('"'))) for item in values)
        if len(values) < 1000:
            return found
        cursor = ["--start-after", values[-1]["key"]]


def upload(key, data, content_type):
    with tempfile.NamedTemporaryFile() as part:
        part.write(data)
        part.flush()
        command = ["cf", "r2", "objects", "put", key, "--bucket-name", BUCKET,
                   "--file", part.name, "--content-type", content_type, "--content-length", str(len(data))]
        for attempt in range(4):
            try:
                response = subprocess.run(command, cwd=REPO, capture_output=True, timeout=150,
                                          env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT})
                if response.returncode == 0:
                    print(f"Uploaded {key}", file=sys.stderr, flush=True)
                    return
            except subprocess.TimeoutExpired:
                pass
            if attempt < 3:
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Cloudflare refused or timed out during upload of {key} after four attempts.")


def publish(workspace, jobs, put):
    pending = set()
    submitted = set()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        def put_chunk(key, data):
            if key in submitted:
                return
            submitted.add(key)
            if len(pending) >= jobs:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for task in done:
                    task.result()
                    pending.remove(task)
            pending.add(pool.submit(put, key, data, "application/octet-stream"))

        manifest = snapshot.capture(workspace, snapshot.DEFAULT_ROOTS, put_chunk)
        for task in pending:
            task.result()
    raw = snapshot.canonical(manifest)
    checksum = snapshot.digest(raw)
    key = f"{snapshot.PREFIX}/manifests/{checksum}.json"
    put(key, raw, "application/json")
    print(f"{len(manifest['chunks'])} chunks, {manifest['compressedBytes']:,} compressed bytes",
          file=sys.stderr)
    return {"key": key, "sha256": checksum, "bytes": len(raw)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=REPO)
    parser.add_argument("--jobs", type=int, choices=range(1, 9), default=4)
    parser.add_argument("--dry-run", action="store_true", help="Hash the workspace locally, without uploading.")
    args = parser.parse_args()
    present = {} if args.dry_run else existing_chunks()

    def resume(key, data, content_type):
        # The key still pins SHA-256; the single-PUT ETag lets an interrupted
        # bootstrap reuse already uploaded bytes before the full hosted replay.
        if present.get(key) == (len(data), md5(data, usedforsecurity=False).hexdigest()):
            print(f"Reused {key}", file=sys.stderr, flush=True)
        elif not args.dry_run:
            upload(key, data, content_type)

    ref = publish(args.workspace, args.jobs, resume)
    sys.stdout.buffer.write(snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
