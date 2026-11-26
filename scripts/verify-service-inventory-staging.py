"""Replay a dated hosted Service Inventory against its registered catalogue and complete CSV originals.

Use --local-baseline data/corpus/federal-bulk to check the retained SQLite publication and gzip
archives. Pass a federal-discovery-<epoch-ms> occurrence and optionally --compare-baseline
data/corpus/federal-bulk to compare the hosted observation with that publication. All Cloudflare
commands read private staging.
"""
import argparse
from contextlib import closing
import gzip
from importlib import import_module
import io
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote

register = import_module('verify-federal-register-staging')
bulk_reference = import_module('verify-official-titles-staging')
require, same, sha = register.require, register.same, register.sha
SERIES = 'service-inventory'
PREFIX = 'weekly/' + SERIES
SOURCE_LIMIT = 24 * 1024 * 1024
DATASET = '3ac0d080-6149-499a-8b06-7ce5f00ec56c'
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
DIGEST = re.compile(r'[0-9a-f]{64}')


def scan(raw):
    with io.TextIOWrapper(io.BytesIO(raw), encoding='utf-8-sig', newline='') as stream:
        fields, rows = bulk_reference.bulk['scan'](stream, SERIES)
    return {'fields': fields, 'columns': len(fields), 'rows': rows, 'bytes': len(raw), 'sha256': sha(raw)}


def resource_identity(resource):
    ident, url = resource['id'], resource['url']
    require(isinstance(ident, str) and UUID.fullmatch(ident), 'Invalid Service Inventory CSV resource ID')
    base = f'https://open.canada.ca/data/dataset/{DATASET}/resource/{ident}/download/'
    require(isinstance(url, str) and len(url) <= 2048 and url.startswith(base), 'Unexpected Service Inventory publisher URL')
    filename = url[len(base):]
    require(re.fullmatch(r'[^\s/?#\\]+\.csv', filename, re.I) and not re.search(r'%(?![a-fA-F0-9]{2})', filename), 'Invalid CSV filename')
    name = unquote(filename, errors='strict')
    require(not any(c in '/?#\\' or ord(c) < 32 or ord(c) == 127 for c in name), 'Invalid decoded CSV filename')
    return {'datasetId': DATASET, 'resourceId': ident, 'url': url}


def local_baseline(path):
    db = (path / 'publications.sqlite').resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(db, uri=True)) as connection:
        row = connection.execute('''SELECT observed_at, catalogue_date, resources FROM publications
                                    WHERE series=? ORDER BY observed_at DESC LIMIT 1''', (SERIES,)).fetchone()
    require(row is not None, 'No local Service Inventory publication')
    results = []
    for record in json.loads(row[2]):
        resource = resource_identity(record)
        digest = record['sha256']
        require(DIGEST.fullmatch(digest), 'Invalid local CSV digest')
        checked = scan(gzip.decompress((path/'objects'/(digest + '.csv.gz')).read_bytes()))
        same([checked['fields'], checked['rows'], checked['bytes'], checked['sha256']],
             [record['fields'], record['rows'], record['bytes'], digest], 'Local CSV differs from SQLite')
        bulk_reference.check_final_url(resource['url'], record['finalUrl'])
        results.append({**resource, **checked, 'finalUrl': record['finalUrl']})
    require(len({r['resourceId'] for r in results}) == len(results) > 0, 'Empty or duplicate local resources')
    return {'observedAt': row[0], 'catalogueDate': row[1], 'bulkReferenceRevision': bulk_reference.REFERENCE,
            'resources': results, 'totalRows': sum(r['rows'] for r in results),
            'totalBytes': sum(r['bytes'] for r in results)}


def catalogue(discovery, epoch):
    raw = register.read_ref(discovery['register'], 'registers', 'csv', 1024 * 1024)
    same(sha(raw), sha(register.REGISTER.read_bytes()), 'Hosted source register differs from checkout')
    parser = register.reference_parser()
    members = register.members(parser, raw)
    packet = json.loads(register.read_ref(discovery['packetRef'], 'inventories', 'json', 8 * 1024 * 1024))
    same([packet['schemaVersion'], packet['scheduledTime'], packet['registerSha256']], [1, epoch, sha(raw)], 'Invalid discovery packet identity')
    same([(r['series'], r['endpoint'], r['url']) for r in packet['endpoints']],
         [(s, field, url) for s, field, url, _ in members], 'Discovery packet memberships differ from register')
    same([s['url'] for s in packet['sources']], sorted({m[2] for m in members}), 'Invalid discovery source set')
    sources = {s['url']: s for s in packet['sources']}
    for item in packet['endpoints']:
        failure = sources[item['url']].get('failure')
        same([item['ok'], item.get('reason')], [failure is None, failure], 'Discovery endpoint status disagrees with source')
    ok = sum(item['ok'] for item in packet['endpoints'])
    same(discovery['counts'], {'series': len({m[0] for m in members}), 'endpoints': len(members), 'uniqueUrls': len(sources),
         'verified': ok, 'failed': len(members) - ok, 'originals': sum('key' in s for s in sources.values()),
         'originalBytes': sum(s.get('bytes', 0) for s in sources.values())}, 'Incorrect discovery receipt counts')
    same(discovery['status'], 'complete' if ok == len(members) else 'partial', 'Incorrect discovery receipt status')
    (url, dataset), = [(url, d) for s, field, url, d in members if s == SERIES and field == 'entry_url']
    require(dataset == DATASET, 'Unexpected registered Service Inventory dataset')
    metadata = register.verify_source(parser, sources[url], dataset, epoch)
    endpoint, = [e for e in packet['endpoints'] if e['series'] == SERIES and e['endpoint'] == 'entry_url']
    if metadata is None:
        require(not endpoint['ok'] and 'inventory' not in endpoint, 'Failed Service Inventory endpoint published an inventory')
        return None
    same(endpoint['inventory'], metadata, 'Hosted Service Inventory catalogue differs from pre-port CKAN parse')
    csvs = [r for r in metadata['resources'] if isinstance(r['format'], str) and r['format'].upper() == 'CSV']
    if not 1 <= len(csvs) <= 12:
        return []
    try:
        selected = [resource_identity(r) for r in csvs]
    except ValueError:
        return []
    return selected if len({r['resourceId'] for r in selected}) == len(selected) else []


def pointers(instance, epoch, status):
    heads = {}
    for label in ('latest-attempt', 'latest-complete'):
        complete = label == 'latest-complete'
        body = register.object_bytes(f'{PREFIX}/{label}.json', allow_missing=complete and status != 'complete')
        if body is None:
            heads[label] = None
            continue
        head = json.loads(body)
        recorded = head['scheduledTime']
        require(type(recorded) is int and recorded > 0, 'Invalid pointer timestamp')
        selected = f'federal-discovery-{recorded}'
        key = f'{PREFIX}/runs/{selected}.json'
        same([head['instanceId'], head['receiptKey']], [selected, key], 'Invalid Service Inventory pointer')
        if complete:
            require(head['status'] == 'complete', 'Complete pointer references unsuccessful import')
        if not complete or status == 'complete':
            require(recorded >= epoch, 'Service Inventory pointer predates the observed publication')
        if selected == instance:
            same(head['status'], status, 'Pointer status differs from observed publication')
        else:
            actual = json.loads(register.object_bytes(key))
            same(head, {k: actual[k] for k in ('instanceId', 'scheduledTime', 'receiptKey', 'status')}, 'Invalid pointer target')
        heads[label] = head
    return heads


def verify_member(item, epoch):
    resource = item['resource']
    result = {k: v for k, v in item.items() if k != 'resource'}
    checkpoint = f"{PREFIX}/checkpoints/{epoch}/{resource['resourceId']}.json"
    if result['status'] == 'failed':
        same(sorted(result), sorted(('status', 'code', 'httpStatus')), 'Failed CSV claimed publication metadata')
        require(re.fullmatch(r'[a-z0-9-]{1,60}', result['code']), 'Invalid failure code')
        code = result['httpStatus']
        require(code is None or type(code) is int and 100 <= code <= 599, 'Invalid upstream HTTP status')
        return {**resource, **result}
    same(result['status'], 'complete', 'Unknown Service Inventory member status')
    pin = register.object_bytes(checkpoint)
    require(0 < len(pin) <= 32 * 1024, 'Invalid checkpoint size')
    same(json.loads(pin), {'schemaVersion': 1, 'scheduledTime': epoch, **resource, 'result': result},
         'Service Inventory member differs from its occurrence checkpoint')
    modified = result['lastModified']
    require(modified is None or isinstance(modified, str) and 0 < len(modified) <= 128, 'Invalid Last-Modified metadata')
    bulk_reference.check_final_url(resource['url'], result['finalUrl'])
    source = result['source']
    raw = bulk_reference.load_ref(source, f"{PREFIX}/sources/{source['sha256']}.csv", SOURCE_LIMIT)
    checked = scan(raw)
    require(checked['columns'] <= 128, 'Too many fields in a published CSV')
    same([checked['fields'], checked['rows']], [result['fields'], result['rows']], 'CSV header or count differs from the pre-port scan')
    return {**resource, **checked, 'status': 'complete', 'sourceKey': source['key'],
            'finalUrl': result['finalUrl'], 'lastModified': modified}


def compare_local(checked, path):
    baseline = local_baseline(path)
    refs = {r['resourceId']: r for r in baseline['resources']}
    checks = {}
    for item in checked:
        ident = item['resourceId']
        if item['status'] != 'complete' or ident not in refs:
            continue
        prior = refs[ident]
        checks[ident] = {'sameUrl': item['url'] == prior['url'], 'sameOriginal': item['sha256'] == prior['sha256'],
                         'sameFields': item['fields'] == prior['fields'], 'sameRows': item['rows'] == prior['rows'],
                         'baselineRows': prior['rows'], 'baselineBytes': prior['bytes'], 'baselineSha256': prior['sha256']}
    return {'localObservedAt': baseline['observedAt'], 'localRows': baseline['totalRows'], 'localBytes': baseline['totalBytes'],
            'sameResourceIds': set(refs) == {r['resourceId'] for r in checked}, 'sharedVerifiedResources': checks}


def verify(instance, local_root=None):
    epoch = int(instance.rsplit('-', 1)[1])
    state = json.loads(register.cf('workflows', 'instances', 'get', instance, '--workflow-name', register.WORKFLOW, '--simple', 'true'))
    same(state['success'], True, 'Service Inventory Workflow did not reach completion')
    key = f'{PREFIX}/runs/{instance}.json'
    raw = register.object_bytes(key)
    receipt = json.loads(raw)
    same([receipt['schemaVersion'], receipt['instanceId'], receipt['scheduledTime'], receipt['receiptKey']],
         [1, instance, epoch, key], 'Invalid Service Inventory receipt identity')
    discovery_key = f'{register.PREFIX}/runs/{instance}.json'
    parent = json.loads(bulk_reference.load_ref(receipt['discovery'], discovery_key, 8192))
    same([parent['schemaVersion'], parent['instanceId'], parent['scheduledTime'], parent['receiptKey'], parent['packetRef']],
         [1, instance, epoch, discovery_key, receipt['packetRef']], 'Service Inventory pinned an unrelated discovery observation')
    same([state['output']['receiptKey'], state['output']['status'], state['output']['counts']],
         [discovery_key, parent['status'], parent['counts']], 'Workflow output differs from discovered catalogue')
    members = catalogue(parent, epoch)
    items = receipt['resources']
    if members is None:
        same([receipt['status'], receipt.get('code'), items], ['skipped', 'service-catalogue-unavailable', []], 'Incorrect missing dependency outcome')
    elif not members:
        same([receipt['status'], receipt.get('code'), items], ['failed', 'invalid-service-resources', []], 'Incorrect invalid selection outcome')
    else:
        same([row['resource'] for row in items], members, 'Service Inventory selection differs from the registered CKAN original')
    checked = [verify_member(row, epoch) for row in items]
    verified = [row for row in checked if row['status'] == 'complete']
    counts = {'resources': len(checked), 'verified': len(verified), 'failed': len(checked) - len(verified),
              'rows': sum(r['rows'] for r in verified), 'originalBytes': sum(r['bytes'] for r in verified)}
    same(counts, receipt['counts'], 'Service Inventory totals differ from verified CSV resources')
    if items:
        same(receipt['status'], 'failed' if counts['failed'] else 'complete', 'Service Inventory result disagrees with its resources')
    same(state['output']['serviceInventory'], {'receiptKey': key, 'status': receipt['status'], 'counts': counts},
         'Workflow output differs from the Service Inventory receipt')
    result = {'instanceId': instance, 'trigger': state['trigger'], 'start': state['start'], 'end': state['end'],
              'status': receipt['status'], 'counts': counts, 'resources': checked, 'discoveryStatus': parent['status'],
              'catalogueVerified': members is not None, 'receiptSha256': sha(raw), 'discoverySha256': receipt['discovery']['sha256'],
              'packetSha256': receipt['packetRef']['sha256'], 'bulkReferenceRevision': bulk_reference.REFERENCE,
              'pointers': pointers(instance, epoch, receipt['status'])}
    if receipt.get('code'):
        result['code'] = receipt['code']
    if local_root:
        result['localComparison'] = compare_local(checked, local_root)
    return result


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    mode = cli.add_mutually_exclusive_group(required=True)
    mode.add_argument('instance', nargs='?')
    mode.add_argument('--local-baseline', type=Path)
    cli.add_argument('--compare-baseline', type=Path)
    args = cli.parse_args()
    if args.instance and not re.fullmatch(r'federal-discovery-[1-9]\d{0,15}', args.instance):
        cli.error('Expected federal-discovery-<epoch-ms>')
    if args.compare_baseline and not args.instance:
        cli.error('--compare-baseline needs a hosted occurrence')
    result = local_baseline(args.local_baseline) if args.local_baseline else verify(args.instance, args.compare_baseline)
    print(json.dumps(result, ensure_ascii=False, indent=2))
