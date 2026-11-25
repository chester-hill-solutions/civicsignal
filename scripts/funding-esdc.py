"""Acquire the published bilingual ESDC funding-programme catalogue."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/funding/esdc-collector'))
from esdc import (EN, FR, INDEXES, content_language, detail_sections, edition_ids,
                  language_alternates, list_cards, parse_detail, requested_pages)
from lib.funding_intake import acquire


def collect(fetch):
    def capture(url):
        try:
            body = fetch(url)
            return body if url in INDEXES.values() else parse_detail(body, url)
        except Exception as exc:
            return exc

    pages = requested_pages()
    urls = next(pages)
    with ThreadPoolExecutor(max_workers=8) as pool:
        while True:
            results = dict(zip(urls, pool.map(capture, urls)))
            try:
                urls = pages.send(results)
            except StopIteration as done:
                return done.value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='data/corpus/funding/esdc.json')
    parser.add_argument('--resume', action='store_true', help='Resume the unfinished observation for this output, verifying its archived pages.')
    args = parser.parse_args()
    acquire(args.output, 'esdc', collect, checkpoint_indexes=INDEXES, resume=args.resume)


if __name__ == '__main__':
    main()
