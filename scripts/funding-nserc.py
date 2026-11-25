#!/usr/bin/env python3
"""Acquire NSERC's bilingual College and Community Innovation catalogue."""
import argparse
import sys
from pathlib import Path

from lib.funding_intake import acquire

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.funding.collector.nserc import BASE, INDEXES, classify_heading, classify_status, requested_pages


def collect(fetch):
    pages = requested_pages(dict(INDEXES))
    url = next(pages)
    while True:
        data = fetch(url)
        try:
            url = pages.send(data)
        except StopIteration as done:
            return done.value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    acquire(args.output, "nserc", collect)


if __name__ == "__main__":
    main()
