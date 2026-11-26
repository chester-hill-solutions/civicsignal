"""Verify a private official-titles import against its pinned register, CKAN page and CSV.

  python3 -B scripts/verify-official-titles-staging.py federal-discovery-<epoch-ms>
  python3 -B scripts/verify-official-titles-staging.py --local-baseline data/corpus/federal-bulk

Add --compare-baseline data/corpus/federal-bulk to compare a hosted import with the latest local CSV.
All Cloudflare commands are reads. The source register and bulk checkers run locally.
"""
import argparse
from contextlib import closing
import csv
from datetime import datetime, timezone
import gzip
from importlib import import_module
import io
import json
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request

register = import_module('verify-federal-register-staging')
PREFIX = 'weekly/official-titles'
DATASET = '83320390-7715-43bc-a281-2049bf5d4232'
REFERENCE = '8886bdb49637df24ba4283ec0da3e40361a91869'
require, same, sha = register.require, register.same, register.sha


def bulk_reference():
    raw = subprocess.check_output(['git', 'show', REFERENCE + ':scripts/federal-bulk.py'], cwd=register.ROOT)
    with tempfile.TemporaryDirectory(prefix='civicsignal-bulk-reference-') as directory:
        path = Path(directory) / 'federal-bulk.py'
        path.write_bytes(raw)
        return runpy.run_path(str(path))


bulk = bulk_reference()


def parse_csv(raw):
    def stream():
        return io.TextIOWrapper(io.BytesIO(raw), encoding='utf-8-sig', newline='')

    with stream() as source:
        fields, count = bulk['scan'](source, 'official-titles')
    with stream() as source:
        reader = csv.reader(source, strict=True)
        same(next(reader), fields, 'CSV header mismatch')
        rows = [row for row in reader if row]
    require(len(rows) == count, 'CSV record count differs from the bulk reference operator')
    return {'schemaVersion': 1, 'fields': fields, 'rows': rows}


def check_final_url(url, final):
    parsed = urlsplit(final)
    require(parsed.scheme == 'https' and not (parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.port),
            'Final CSV citation must be plain publisher HTTPS')
    # The existing bulk operator admits the exact Open Canada Azure blob path on redirect.
    require(bulk['official'](url), 'Invalid CSV publication URL')
    bulk['PublisherRedirect']().redirect_request(Request(url), None, 302, '', {}, final)
    if bulk['official'](final):
        require(parsed.path == urlsplit(url).path, 'Official publisher redirect changed the selected resource path')


def local_baseline(path):
    db_uri = (path / 'publications.sqlite').resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(db_uri, uri=True)) as db:
        row = db.execute("""SELECT observed_at, resources FROM publications WHERE series='official-titles'
                            ORDER BY observed_at DESC LIMIT 1""").fetchone()
    require(row is not None, 'Local official-titles publication is missing')
    resource, = json.loads(row[1])
    digest = resource['sha256']
    require(re.fullmatch('[a-f0-9]{64}', digest), 'Unexpected local CSV digest')
    raw = gzip.decompress((path/'objects'/(digest + '.csv.gz')).read_bytes())
    require(len(raw) == resource['bytes'] and sha(raw) == digest, 'Local archived CSV differs from publication')
    check_final_url(resource['url'], resource['finalUrl'])
    records = parse_csv(raw)
    same([resource['fields'], resource['rows']], [records['fields'], len(records['rows'])], 'Local published CSV count or header differs')
    return {'observedAt': row[0], 'sourceSha256': digest, 'sourceBytes': len(raw),
            'columns': len(records['fields']), 'rows': len(records['rows']),
            'orderedFieldsAndRowsSha256': sha(register.canonical(records))}


def load_ref(ref, key, limit):
    require(isinstance(ref['sha256'], str) and re.fullmatch('[a-f0-9]{64}', ref['sha256']), 'Invalid reference digest')
    require(ref['key'] == key and type(ref['bytes']) is int and 0 < ref['bytes'] <= limit, 'Unexpected object reference: ' + key)
    raw = register.object_bytes(key)
    require(len(raw) == ref['bytes'] and sha(raw) == ref['sha256'], 'R2 bytes disagree with reference: ' + key)
    return raw


def registered_csv(discovery, titles, instance, epoch):
    prefix = register.PREFIX
    discovery_key = f'{prefix}/runs/{instance}.json'
    same([discovery['schemaVersion'], discovery['instanceId'], discovery['scheduledTime'], discovery['receiptKey']],
         [1, instance, epoch, discovery_key], 'Unexpected discovery identity')
    same(titles['packetRef'], discovery['packetRef'], 'Titles pinned a different discovery inventory')
    ref = discovery['register']
    raw_register = load_ref(ref, f"{prefix}/registers/{ref['sha256']}.csv", 64 * 1024)
    require(raw_register == register.REGISTER.read_bytes(), 'Discovery register differs from the checked-in register')
    packet_ref = titles['packetRef']
    packet = json.loads(load_ref(packet_ref, f"{prefix}/inventories/{packet_ref['sha256']}.json", 8 * 1024 * 1024))
    same([packet['schemaVersion'], packet['scheduledTime'], packet['registerSha256']], [1, epoch, sha(raw_register)], 'Wrong register packet')
    parser = register.reference_parser()
    expected = register.members(parser, raw_register)
    same([(item['series'], item['endpoint'], item['url']) for item in packet['endpoints']],
         [(series, field, url) for series, field, url, _ in expected], 'Discovery endpoint identities differ from register')
    same([source['url'] for source in packet['sources']], sorted({row[2] for row in expected}), 'Discovery URL set differs from register')
    sources = {source['url']: source for source in packet['sources']}
    for item in packet['endpoints']:
        failure = sources[item['url']].get('failure')
        require(item['ok'] is (failure is None) and item.get('reason') == failure, 'Endpoint status disagrees with capture')
    verified = sum(item['ok'] for item in packet['endpoints'])
    failed = len(expected) - verified
    same(discovery['counts'], {'series': len({item[0] for item in expected}), 'endpoints': len(expected),
         'uniqueUrls': len(sources), 'verified': verified, 'failed': failed, 'originals': sum('key' in s for s in sources.values()),
         'originalBytes': sum(s.get('bytes', 0) for s in sources.values())}, 'Discovery receipt counters disagree with its packet')
    same(discovery['status'], 'partial' if failed else 'complete', 'Discovery status disagrees with its endpoints')
    (url, dataset), = [(url, dataset) for series, field, url, dataset in expected
                       if series == 'official-titles' and field == 'entry_url']
    require(dataset == DATASET, 'Registered institution titles dataset changed')
    captured = sources[url]
    metadata = register.verify_source(parser, captured, dataset, epoch)
    endpoint, = (x for x in packet['endpoints'] if x['series'] == 'official-titles' and x['endpoint'] == 'entry_url')
    if metadata is None:
        same([endpoint['url'], endpoint['ok'], endpoint['reason']], [url, False, captured['failure']], 'Unverified titles dependency failure')
        return False, None
    same([endpoint['url'], endpoint['ok'], endpoint['inventory']], [url, True, metadata], 'Discovery list differs from original CKAN page')
    choices = [row for row in metadata['resources'] if isinstance(row['format'], str) and row['format'].upper() == 'CSV']
    if len(choices) != 1:
        return True, None
    resource = choices[0]
    base = f"https://open.canada.ca/data/dataset/{dataset}/resource/{resource['id']}/download/"
    if (not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', resource['id']) or
            not resource['url'].startswith(base) or not resource['url'].lower().endswith('.csv') or
            any(char in resource['url'][len(base):] for char in '/?#')):
        return True, None
    return True, {'datasetId': dataset, 'resourceId': resource['id'], 'url': resource['url']}


def pointers(instance, epoch, status):
    result = {}
    for name in ('latest-attempt', 'latest-complete'):
        expected_complete = name == 'latest-complete'
        raw = register.object_bytes(f'{PREFIX}/{name}.json', allow_missing=expected_complete and status != 'complete')
        if raw is None:
            result[name] = None
            continue
        pointer = json.loads(raw)
        timestamp = pointer['scheduledTime']
        ident = f'federal-discovery-{timestamp}'
        key = f'{PREFIX}/runs/{ident}.json'
        require(type(timestamp) is int and pointer['instanceId'] == ident and pointer['receiptKey'] == key, 'Invalid ' + name)
        if expected_complete:
            require(pointer['status'] == 'complete', 'Latest complete points to an incomplete titles import')
        if not expected_complete or status == 'complete':
            require(timestamp >= epoch, name + ' predates this run')
        if ident != instance:
            other = json.loads(register.object_bytes(key))
            same(pointer, {k: other[k] for k in ('instanceId', 'scheduledTime', 'receiptKey', 'status')}, 'Pointer target mismatch')
        else:
            require(pointer['status'] == status, 'Pointer status differs from this dated receipt')
        result[name] = pointer
    return result


def verify(instance, local_root):
    epoch = int(instance.removeprefix('federal-discovery-'))
    state = json.loads(register.cf('workflows', 'instances', 'get', instance, '--workflow-name', register.WORKFLOW, '--simple', 'true'))
    require(state.get('success') is True, 'Workflow has no verified completion')
    key = f'{PREFIX}/runs/{instance}.json'
    raw = register.object_bytes(key)
    receipt = json.loads(raw)
    same([receipt['schemaVersion'], receipt['instanceId'], receipt['scheduledTime'], receipt['receiptKey']],
         [1, instance, epoch, key], 'Official titles receipt identity mismatch')
    discovery_key = f'{register.PREFIX}/runs/{instance}.json'
    discovery = json.loads(load_ref(receipt['discovery'], discovery_key, 8192))
    same([discovery['receiptKey'], discovery['instanceId'], discovery['scheduledTime'], discovery['status'], discovery['counts']],
         [discovery_key, instance, epoch, state['output']['status'], state['output']['counts']], 'Discovery result mismatch')
    require(state['output']['receiptKey'] == discovery_key, 'Workflow output names a different discovery receipt')
    status = receipt['status']
    available, resource = registered_csv(discovery, receipt, instance, epoch)
    result = {'instanceId': instance, 'scheduledAt': datetime.fromtimestamp(epoch/1000, timezone.utc).isoformat(),
              'trigger': state['trigger'], 'status': status, 'receiptSha256': sha(raw), 'bulkReferenceRevision': REFERENCE,
              'discoverySha256': receipt['discovery']['sha256'], 'packetSha256': receipt['packetRef']['sha256'],
              'discoveryStatus': discovery['status'], 'discoveryCounts': discovery['counts'], 'titlesCatalogueVerified': available}
    summary = {'status': status, 'receiptKey': key}
    if status == 'complete':
        require(available and resource, 'Complete titles import has no verified CSV')
        same(receipt['resource'], resource, 'Titles CSV differs from independently selected discovery resource')
        check_final_url(resource['url'], receipt['finalUrl'])
        modified = receipt['lastModified']
        require(modified is None or isinstance(modified, str) and 0 < len(modified) <= 128, 'Invalid CSV Last-Modified metadata')
        source = receipt['source']
        csv_bytes = load_ref(source, f"{PREFIX}/sources/{source['sha256']}.csv", 512 * 1024)
        records = parse_csv(csv_bytes)
        ref = receipt['records']
        stored = json.loads(load_ref(ref, f"{PREFIX}/records/{ref['sha256']}.json", 2 * 1024 * 1024))
        same(stored, records, 'One or more hosted official title fields or ordered records differ from the CSV')
        require(type(receipt['rows']) is int and len(records['rows']) == receipt['rows'], 'Title receipt row count mismatch')
        summary['rows'] = receipt['rows']
        result.update(resource=receipt['resource'], finalUrl=receipt['finalUrl'], sourceSha256=source['sha256'],
                      sourceBytes=len(csv_bytes), recordsSha256=ref['sha256'], columns=len(records['fields']), rows=receipt['rows'],
                      orderedFieldsAndRowsSha256=sha(register.canonical(records)))
        if local_root:
            baseline = local_baseline(local_root)
            result['localComparison'] = {**baseline, 'sameOriginal': baseline['sourceSha256'] == source['sha256'],
                                         'sameFieldsAndRows': baseline['orderedFieldsAndRowsSha256'] == result['orderedFieldsAndRowsSha256']}
    else:
        require(status in ('failed', 'skipped'), 'Unexpected titles receipt status')
        require(not any(k in receipt for k in ('records', 'source', 'rows')), 'Incomplete titles import published data')
        same(receipt['packetRef'], discovery['packetRef'], 'Wrong parent inventory on failed import')
        if status == 'skipped':
            require(discovery['status'] == 'partial' and receipt['httpStatus'] is None and 'resource' not in receipt,
                    'Invalid skipped import')
            if receipt['code'] == 'titles-catalogue-unavailable':
                require(not available, 'Titles were skipped despite a verified catalogue endpoint')
            else:
                # The first staging release required every endpoint before admitting the titles import.
                same(receipt['code'], 'discovery-partial', 'Unknown titles dependency failure')
        else:
            require(available, 'Missing titles catalogue was not recorded as a dependency skip')
            same(receipt.get('resource'), resource, 'Failed titles import cited a different resource')
            if resource is None:
                same([receipt['code'], receipt['httpStatus']], ['invalid-titles-resource', None], 'Unsupported selection failure')
            else:
                http = receipt['httpStatus']
                require(isinstance(receipt['code'], str) and re.fullmatch('[a-z0-9-]{1,60}', receipt['code']) and
                        (http is None or type(http) is int and 100 <= http <= 599), 'Invalid acquisition failure')
        result.update(code=receipt['code'], httpStatus=receipt['httpStatus'])
    same(state['output']['officialTitles'], summary, 'Workflow and titles receipt disagree')
    result['pointers'] = pointers(instance, epoch, status)
    return result


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    modes = cli.add_mutually_exclusive_group(required=True)
    modes.add_argument('instance', nargs='?')
    modes.add_argument('--local-baseline', type=Path)
    cli.add_argument('--compare-baseline', type=Path)
    args = cli.parse_args()
    if args.instance and not re.fullmatch(r'federal-discovery-[1-9]\d{0,15}', args.instance):
        cli.error('Expected the exact federal-discovery-<epoch-ms> instance ID')
    if args.compare_baseline and not args.instance:
        cli.error('--compare-baseline requires a hosted instance')
    print(json.dumps(local_baseline(args.local_baseline) if args.local_baseline
                     else verify(args.instance, args.compare_baseline), indent=2))
