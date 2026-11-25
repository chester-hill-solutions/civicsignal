#!/usr/bin/env python3
"""Refresh or replay the bounded Treasury Board and IRCC guidance indexes."""
import argparse
import fcntl
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.federal_guidance import DEFAULT_ROOT, build_inventory, find_records, replay


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT / DEFAULT_ROOT,
                        help="Corpus/output root (default: repository data/corpus/federal-guidance)")
    parser.add_argument("--refresh", action="store_true", help="Refresh the four small TBS A–Z/inactive indexes")
    parser.add_argument("--replay", action="store_true", help="Rebuild receipt from archived index HTML")
    parser.add_argument("--search", help="Search archived policy IDs/labels and IRCC index text")
    parser.add_argument("--limit", type=int, default=20, help="Maximum search results (default: 20)")
    args = parser.parse_args()
    try:
        if args.search is not None:
            result = find_records(args.root, args.search, args.limit)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        args.root.mkdir(parents=True, exist_ok=True)
        with (args.root / "intake.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            report = replay(args.root) if args.replay else build_inventory(args.root, refresh=args.refresh)
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        parser.exit(2, f"federal-guidance intake failed: {error}\n")
    receipt = args.root / "dist" / "receipt.json"
    print(json.dumps({"receipt": str(receipt), "inventory": report["inventory"],
                      "tbs": report["tbs"]["status_counts_and_language_parity"],
                      "ircc": report["ircc"]["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
