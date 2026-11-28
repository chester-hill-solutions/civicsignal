#!/usr/bin/env python3
"""Build an empty workspace manifest for a new private weekly R2 archive."""
import argparse
from pathlib import Path
import os
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/institution-coverage/container"))
from snapshot import canonical, capture, digest  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", help="Private archive name under weekly/")
    parser.add_argument("output", type=Path, help="New directory for local bootstrap files")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", args.service):
        parser.error("The service name must consist of lowercase words and digits separated by hyphens")

    prefix = f"weekly/{args.service}"
    root = args.output.resolve()
    archive = root / "archive"
    root.mkdir(parents=True)
    archive.mkdir(mode=0o755)
    archive.chmod(0o755)
    os.utime(archive, (0, 0))

    def write(key, body):
        path = root / key.removeprefix(prefix + "/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        print(f"{key}\t{path}")

    manifest = canonical(capture(root, ("archive",), write, allowed=("archive",), prefix=prefix))
    checksum = digest(manifest)
    key = f"{prefix}/manifests/{checksum}.json"
    write(key, manifest)
    write(f"{prefix}/bootstrap.json", canonical({"key": key, "sha256": checksum, "bytes": len(manifest)}))


if __name__ == "__main__":
    main()
