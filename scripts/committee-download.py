"""Acquire or refresh linked originals. Each committed URL is resumable."""

import argparse
import json
from urllib.parse import urlsplit
from pathlib import Path
from lib.committee_files import capture, download_urls, verify_objects

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path("data/corpus/committees"))
    p.add_argument("--workers", type=int, choices=range(1, 25), default=10)
    p.add_argument("--refresh", action="store_true")
    p.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify local originals without fetching.",
    )
    p.add_argument(
        "--host",
        action="append",
        help="Limit a resumed run to the given publication hosts.",
    )
    p.add_argument(
        "--url", action="append", help="Recheck a specific published URL, repeatable."
    )
    args = p.parse_args()
    if args.verify_only:
        print("Verified original objects:", verify_objects(args.root))
        raise SystemExit(0)
    urls = args.url or download_urls(
        json.loads((args.root / "catalogue.json").read_text())
    )
    if args.host:
        urls = [url for url in urls if urlsplit(url).hostname in args.host]
    capture(args.root, urls, args.workers, args.refresh)
