#!/usr/bin/env python3
"""Probe or replay the official federal briefing note title and nil CSVs."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.briefing_intake import MAIN_URL, NIL_URL, SCHEMA_URL, fetch_official, ingest, probe, replay, search_records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-csv", type=Path, help="Previously acquired official main CSV")
    parser.add_argument("--nil-csv", type=Path, help="Previously acquired official nothing-to-report CSV")
    parser.add_argument("--schema-json", type=Path, help="Previously acquired published schema JSON")
    parser.add_argument("--output-root", type=Path, default=ROOT, help="Repository root (default: this checkout)")
    parser.add_argument("--probe", action="store_true", help="Issue HEAD requests only; never download bodies")
    parser.add_argument("--download", action="store_true", help="Fetch pinned official CSVs/schema after disk and size preflight")
    parser.add_argument("--replay", action="store_true", help="Rebuild receipt from previously archived CSV/schema objects")
    parser.add_argument("--search", help="Search archived English/French titles and metadata")
    parser.add_argument("--limit", type=int, default=10, help="Maximum search results (default: 10)")
    args = parser.parse_args()
    if args.probe:
        print(json.dumps({name: probe(url) for name, url in
                          (("main", MAIN_URL), ("nil", NIL_URL), ("schema", SCHEMA_URL))}, indent=2))
        return 0
    if args.search is not None:
        try:
            receipt = json.loads((args.output_root / "dist" / "briefing-notes" / "receipt.json").read_text(encoding="utf-8"))
            archive = Path(receipt["sources"]["main"]["object"])
            print(json.dumps(search_records(archive, args.search, max(1, args.limit)), ensure_ascii=False, indent=2))
        except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
            parser.exit(2, f"briefing-notes search failed: {error}\n")
        return 0
    if args.replay:
        try:
            packet = replay(args.output_root)
        except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
            parser.exit(2, f"briefing-notes replay failed: {error}\n")
        print(json.dumps({"receipt": str(args.output_root / "dist" / "briefing-notes" / "receipt.json"),
                          "main_rows": packet["main"]["rows"], "nil_rows": packet["nil"]["rows"]}, indent=2))
        return 0
    if args.download:
        try:
            packet = fetch_official(args.output_root)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            parser.exit(2, f"briefing-notes intake failed: {error}\n")
        print(json.dumps({"receipt": str(args.output_root / "dist" / "briefing-notes" / "receipt.json"),
                          "main_rows": packet["main"]["rows"], "nil_rows": packet["nil"]["rows"],
                          "main_source_sha256": packet["sources"]["main"]["sha256"],
                          "nil_source_sha256": packet["sources"]["nil"]["sha256"]}, indent=2))
        return 0
    if not args.main_csv or not args.nil_csv:
        parser.error("--main-csv and --nil-csv are required unless --probe, --download, --replay, or --search is used")
    try:
        packet = ingest(args.main_csv, args.nil_csv, args.schema_json, args.output_root)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(2, f"briefing-notes intake failed: {error}\n")
    print(json.dumps({"receipt": str(args.output_root / "dist" / "briefing-notes" / "receipt.json"),
                      "main_rows": packet["main"]["rows"], "nil_rows": packet["nil"]["rows"],
                      "main_source_sha256": packet["sources"]["main"]["sha256"],
                      "nil_source_sha256": packet["sources"]["nil"]["sha256"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
