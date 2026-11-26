"""Read a dated staging register and reproduce its normalized metadata from archived originals.

Pass federal-discovery-<epoch-ms> to read private staging with cf, or pass
--local-baseline PATH to replay an existing local register receipt against its SQLite inventory.
For a staging run, --compare-baseline PATH also reports changes since that local observation.
The reference operator is loaded from the Git revision before the Cloudflare port.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REGISTER = ROOT / 'docs/evidence/2026-11-23/federal-public-service-sources.csv'
REFERENCE = '07ba2098206f40e281b689a60ec1549cbde37be7'
REFERENCE_PATH = 'scripts/federal-source-inventory.py'
ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a'
BUCKET = 'civicsignal-stage-weekly'
WORKFLOW = 'civicsignal-stage-federal-register'
PREFIX = 'weekly/federal-discovery'


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def same(left, right, message):
    require(canonical(left) == canonical(right), message)


def reference_parser():
    source = subprocess.check_output(['git', 'show', REFERENCE + ':' + REFERENCE_PATH], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix='civicsignal-register-reference-') as directory:
        script = Path(directory) / 'federal-source-inventory.py'
        script.write_bytes(source)
        return runpy.run_path(str(script))


def members(parser, raw):
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8'))))
    keys = [r['series_key'] for r in rows]
    require(all(keys) and len(set(keys)) == len(keys), 'Duplicate or empty register series')
    return [(row['series_key'], field, url, dataset) for row in rows
            for field, url, dataset in parser['source_endpoints'](row)]


def normalized_summary(entries):
    kinds = Counter()
    counts = Counter()
    digest = hashlib.sha256()
    for series, endpoint, metadata in entries:
        kind = metadata['kind']
        kinds[kind] += 1
        counts[kind] += len(metadata['resources'] if kind == 'dataset-resources' else metadata['links'])
        digest.update(canonical([series, endpoint, metadata]))
    return {'comparedEndpointInventories': len(entries), 'catalogueKinds': dict(kinds),
            'catalogueEntries': dict(counts), 'orderedMetadataSha256': digest.hexdigest()}


def local_baseline(receipt_path, parser, register, observations=None):
    root = receipt_path.resolve().parent.parent
    raw_receipt = receipt_path.read_bytes()
    receipt = json.loads(raw_receipt)
    expected = members(parser, register)
    require(receipt['registerSha256'] == sha(register) and receipt['ok'] is True, 'Expected complete local register')
    require(len(expected) == len(receipt['endpoints']), 'Local endpoint count mismatch')
    entries, originals = [], {}
    with closing(sqlite3.connect((root/'downloads.sqlite').as_uri() + '?mode=ro', uri=True)) as cache, \
            closing(sqlite3.connect((root/'inventory.sqlite').as_uri() + '?mode=ro', uri=True)) as store:
        for (series, field, url, dataset), item in zip(expected, receipt['endpoints'], strict=True):
            same([item['series'], item['endpoint'], item['url'], item['ok']], [series, field, url, True], 'Local register order')
            digest = item['sha256']
            require(re.fullmatch('[0-9a-f]{64}', digest), 'Invalid local digest')
            body = gzip.decompress((root/'objects'/digest[:2]/(digest + '.gz')).read_bytes())
            record = cache.execute('SELECT final_url,digest FROM files WHERE url=?', (url,)).fetchone()
            require(record and record[1] == digest and sha(body) == digest, 'Local cache differs from receipt: ' + url)
            desc = parser['describe'](body, record[0] or url, dataset)
            stored = store.execute('SELECT sha256,url,inventory FROM catalogue_observations WHERE series=? AND endpoint=? AND observed_at=?',
                                   (series, field, item['observedAt'])).fetchone()
            require(stored and stored[:2] == (digest, url), 'Local observation identity mismatch')
            same(desc, json.loads(stored[2]), 'Local inventory differs for ' + series + '/' + field)
            same([desc['kind'], len(desc.get('resources', desc.get('links', [])))], [item['kind'], item['entries']], 'Local entry count differs')
            entries.append((series, field, desc))
            originals[url] = len(body)
            if observations is not None:
                observations[series, field] = digest, sha(canonical(desc))
    return {'receiptSha256': sha(raw_receipt), 'registerSha256': sha(register), 'referenceRevision': REFERENCE,
            'series': len({r[0] for r in expected}), 'uniqueUrls': len(originals), 'originalBytes': sum(originals.values()),
            'largestOriginalBytes': max(originals.values()), **normalized_summary(entries)}


def cf(*args, allow_missing=False):
    result = subprocess.run(['cf', *args], env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': ACCOUNT},
                            capture_output=True, timeout=90)
    if result.returncode:
        detail = (result.stderr + result.stdout).decode(errors='replace')
        if allow_missing and re.search(r'(?:object|key).{0,60}(?:does not exist|(?:could )?not (?:be )?found)|NoSuchKey', detail, re.I):
            return None
        raise RuntimeError('cf read failed (' + ' '.join(args[:3]) + '): ' + detail[:350])
    return result.stdout


def object_bytes(key, *, allow_missing=False):
    return cf('r2', 'objects', 'get', key, '--bucket-name', BUCKET, allow_missing=allow_missing)


def read_ref(ref, directory, extension, limit):
    digest, length = ref['sha256'], ref['bytes']
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'Invalid R2 digest')
    require(type(length) is int and 0 < length <= limit, 'Invalid R2 object length')
    require(ref['key'] == f'{PREFIX}/{directory}/{digest}.{extension}', 'Invalid R2 object key')
    body = object_bytes(ref['key'])
    require(len(body) == length and sha(body) == digest, 'R2 bytes differ from reference ' + ref['key'])
    return body


def verify_source(parser, source, dataset, epoch):
    url = source['url']
    pin = f'{PREFIX}/observations/{epoch}/pages/{sha(url.encode())}.json'
    same(json.loads(object_bytes(pin)), source, 'Packet source differs from saved observation: ' + url)
    stamp = datetime.fromisoformat(source['observedAt'])
    require(stamp.tzinfo and stamp >= datetime.fromtimestamp(epoch / 1000, timezone.utc), 'Source observation predates run')
    require(parser['committee_files'].official(source['finalUrl']), 'Unrecognized final publisher origin: ' + url)
    failure = source.get('failure')
    if 'key' not in source:
        status = source.get('status')
        transport = failure in ('publisher-body', 'publisher-redirect', 'publisher-network', 'publisher-response-type')
        http = type(status) is int and 100 <= status < 600 and status != 200 and failure == f'http-{status}'
        require((http or transport) and 'bytes' not in source and 'sha256' not in source, 'Unaccounted missing original: ' + url)
        return None
    require(source['status'] == 200, 'Archived original must have HTTP 200: ' + url)
    body = read_ref(source, 'sources', 'json' if dataset else 'html', 4 * 1024 * 1024)
    try:
        desc = parser['describe'](body, source['finalUrl'], dataset)
    except (ValueError, KeyError, TypeError) as error:
        require(failure == 'catalogue-parse-failed', 'Pre-port parser rejected a published original: ' + url + ': ' + str(error))
        return None
    require(not failure, 'Pre-port parser accepted an original classified as failed: ' + url)
    return desc


def check_pointers(instance, epoch, status):
    result = {}
    for name in ('latest-attempt', 'latest-complete'):
        complete = name == 'latest-complete'
        raw = object_bytes(f'{PREFIX}/{name}.json', allow_missing=complete and status == 'partial')
        if raw is None:
            result[name] = None
            continue
        pointer = json.loads(raw)
        recorded = pointer['scheduledTime']
        selected = f'federal-discovery-{recorded}'
        require(type(recorded) is int and pointer['instanceId'] == selected and
                pointer['receiptKey'] == f'{PREFIX}/runs/{selected}.json', 'Invalid ' + name)
        require(pointer['status'] in (('complete',) if complete else ('partial', 'complete')), 'Bad pointer status')
        if not complete or status == 'complete':
            require(recorded >= epoch, name + ' predates the verified run')
        if selected == instance:
            require(pointer['status'] == status, name + ' disagrees with the dated receipt')
        result[name] = pointer
    return result


def verify_staging(instance, parser, register, local_receipt=None):
    epoch = int(instance.removeprefix('federal-discovery-'))
    state = json.loads(cf('workflows', 'instances', 'get', instance, '--workflow-name', WORKFLOW, '--simple', 'true'))
    key = f'{PREFIX}/runs/{instance}.json'
    raw = object_bytes(key)
    receipt = json.loads(raw)
    same([receipt['schemaVersion'], receipt['instanceId'], receipt['scheduledTime'], receipt['receiptKey']],
         [1, instance, epoch, key], 'Wrong receipt identity')
    require(datetime.fromisoformat(receipt['observedAt']) == datetime.fromtimestamp(epoch / 1000, timezone.utc), 'Wrong receipt date')
    require(read_ref(receipt['register'], 'registers', 'csv', 1024 * 1024) == register, 'Archived register differs from checkout')
    same(json.loads(object_bytes(f'{PREFIX}/observations/{epoch}/register.json')),
         {'registerKey': receipt['register']['key'], 'registerSha256': sha(register), 'scheduledTime': epoch},
         'Collector register checkpoint differs from receipt')
    packet = json.loads(read_ref(receipt['packetRef'], 'inventories', 'json', 8 * 1024 * 1024))
    same([packet['schemaVersion'], packet['scheduledTime'], packet['registerSha256']], [1, epoch, sha(register)], 'Wrong packet identity')
    expected = members(parser, register)
    dataset_for = {url: dataset for _, _, url, dataset in expected}
    sources = packet['sources']
    same([s['url'] for s in sources], sorted(dataset_for), 'Unexpected, duplicate or missing source URL')
    with ThreadPoolExecutor(max_workers=4) as pool:
        parsed = list(pool.map(lambda s: verify_source(parser, s, dataset_for[s['url']], epoch), sources))
    by_url = {s['url']: (s, desc) for s, desc in zip(sources, parsed, strict=True)}
    entries = []
    for (series, field, url, _), item in zip(expected, packet['endpoints'], strict=True):
        same([item['series'], item['endpoint'], item['url']], [series, field, url], 'Register memberships or order differ')
        source, desc = by_url[url]
        if desc is None:
            same([item['ok'], item['reason']], [False, source['failure']], 'Endpoint failure differs from its observation: ' + url)
            require('inventory' not in item, 'Failed endpoint claimed published metadata')
        else:
            same([item['ok'], item['inventory']], [True, desc], 'Normalized catalogue differs for ' + series + '/' + field)
            require('reason' not in item, 'Successful endpoint carries a failure reason')
            entries.append((series, field, desc))
    counts = {'series': len({r[0] for r in expected}), 'endpoints': len(expected), 'uniqueUrls': len(sources),
              'verified': len(entries), 'failed': len(expected) - len(entries), 'originals': sum('key' in s for s in sources),
              'originalBytes': sum(s.get('bytes', 0) for s in sources)}
    same(counts, receipt['counts'], 'Run counters disagree with archived evidence')
    status = 'complete' if counts['failed'] == 0 else 'partial'
    require(receipt['status'] == status, 'Run status disagrees with endpoint evidence')
    require(state.get('success') is True, 'Workflow did not complete')
    same({name: state['output'][name] for name in ('receiptKey', 'status', 'counts')},
         {'receiptKey': key, 'status': status, 'counts': counts}, 'Workflow output differs from receipt')
    comparison = {}
    if local_receipt:
        previous = {}
        local = local_baseline(local_receipt, parser, register, previous)
        changed = []
        raw_changed = set()
        for series, field, url, _ in expected:
            source, desc = by_url[url]
            if desc is not None:
                prior_raw, prior_metadata = previous[series, field]
                if sha(canonical(desc)) != prior_metadata:
                    changed.append({'series': series, 'endpoint': field})
                if source['sha256'] != prior_raw:
                    raw_changed.add(url)
        comparison = {'comparedToLocal': {'receiptSha256': local['receiptSha256'],
                      'comparedEndpoints': len(entries), 'changedMetadataEndpoints': changed,
                      'changedOriginalUrlsAmongVerified': len(raw_changed)}}
    return {'instanceId': instance, 'trigger': state['trigger'], 'start': state['start'], 'end': state['end'],
            'status': status, 'referenceRevision': REFERENCE, 'receiptSha256': sha(raw), 'packetSha256': receipt['packetRef']['sha256'],
            'registerSha256': sha(register), 'counts': counts, **normalized_summary(entries),
            'failedEndpoints': [{k: item[k] for k in ('series', 'endpoint', 'reason')} for item in packet['endpoints'] if not item['ok']],
            'pointers': check_pointers(instance, epoch, status), **comparison}


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    group = cli.add_mutually_exclusive_group(required=True)
    group.add_argument('instance', nargs='?')
    group.add_argument('--local-baseline', type=Path)
    cli.add_argument('--compare-baseline', type=Path, help='complete local receipt for comparison with a staging run')
    options = cli.parse_args()
    if options.instance and not re.fullmatch(r'federal-discovery-(?:0|[1-9]\d{0,15})', options.instance):
        cli.error('Expected the exact federal-discovery-<epoch-ms> instance ID')
    if options.compare_baseline and not options.instance:
        cli.error('--compare-baseline requires a staging instance')
    parser = reference_parser()
    register = REGISTER.read_bytes()
    result = (local_baseline(options.local_baseline, parser, register) if options.local_baseline
              else verify_staging(options.instance, parser, register, options.compare_baseline))
    print(json.dumps(result, indent=2))
