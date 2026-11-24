#!/usr/bin/env python3
"""Build the revision-bound R2 search index from verified corpus snapshot files."""
import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
from xml.etree import ElementTree


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'


def legal_parts(path, language):
    part = None
    for item in ElementTree.parse(path).getroot().find('Body'):
        if item.tag == 'Heading' and item.get('level') == '1':
            label = item.findtext('Label') or ''
            part = f"{label} {item.findtext('TitleText') or ''}".strip() if label.startswith(('PART ', 'PARTIE ')) else None
        elif item.tag == 'Section' and part and (number := item.findtext('Label')):
            yield f'{language}:{number}', part


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--snapshot', required=True, type=Path)
    cli.add_argument('--manifest', required=True, type=Path)
    cli.add_argument('--manifest-sha256', required=True)
    cli.add_argument('--labour-en', required=True, type=Path)
    cli.add_argument('--labour-fr', required=True, type=Path)
    cli.add_argument('--out', required=True, type=Path)
    args = cli.parse_args()

    raw = args.manifest.read_bytes()
    if sha256(raw).hexdigest() != args.manifest_sha256:
        raise ValueError('The corpus manifest differs from the verified digest.')
    manifest = json.loads(raw)
    groups = defaultdict(list)
    count = 0
    labels = set()
    for part in manifest['rows']['parts']:
        data = (args.snapshot / part['key']).read_bytes()
        if len(data) != part['bytes'] or sha256(data).hexdigest() != part['sha256']:
            raise ValueError('The corpus part differs from its manifest.')
        for line in data.splitlines():
            row = json.loads(line)
            count += 1
            section = row['section'] or ''
            if (row['status'] != 'in-force' or not row['id'].startswith('acts-')
                    or not re.fullmatch(r'\d+[a-z]?(?:\.\d+[a-z]?)*', section, re.I)
                    or not row['source_url'].endswith(f'/section-{section}.html')):
                continue
            scope = (row['language'], row['citation'], row['instrument'])
            label = (*scope, row['id'])
            if label in labels:
                raise ValueError('Duplicate provision in a scoped index.')
            labels.add(label)
            groups[scope].append({'id': row['id'], 'heading': row['heading'] or '', 'lead': (row['text'] or '')[:320]})
    if count != manifest['rows']['count']:
        raise ValueError('The corpus row count differs from its manifest.')

    output = args.out / 'hybrid-lexical-v1' / manifest['commit'] / manifest['parser']
    output.mkdir(parents=True)
    instruments = []
    with (output / 'provisions.jsonl').open('xb') as file:
        for (language, citation, title), rows in sorted(groups.items()):
            block = encode(rows)
            if len(block) > 2 * 1024 * 1024 or len(rows) > 5000:
                raise ValueError(f'The scoped index exceeds its serving limit for {language} {citation}.')
            instruments.append({'title': title, 'citation': citation, 'language': language, 'offset': file.tell(), 'length': len(block)})
            file.write(block)
    parts = dict([*legal_parts(args.labour_en, 'en'), *legal_parts(args.labour_fr, 'fr')])
    catalog = encode({'revision': f"{manifest['commit']}:{manifest['parser']}", 'instruments': instruments, 'labourParts': parts})
    if len(catalog) > 2 * 1024 * 1024 or len(instruments) > 6000:
        raise ValueError('The catalog exceeds its serving limit.')
    (output / 'catalog.json').write_bytes(catalog)
    print(f'{len(labels)} provisions across {len(instruments)} instrument-language indexes written to {output}.')


if __name__ == '__main__':
    main()
