"""Read complete, immutable weekly bulk publications and their verified discovery inventories."""
import hashlib
import json
import os
import re
import subprocess
from urllib.parse import urlsplit

ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a'
BUCKET = 'civicsignal-stage-weekly'
DISCOVERY = 'weekly/federal-discovery'


def get_object(key):
    return subprocess.check_output(['cf', 'r2', 'objects', 'get', key, '--bucket-name', BUCKET],
                                   env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': ACCOUNT}, timeout=90)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def verified(read, ref, key, limit):
    require(re.fullmatch('[0-9a-f]{64}', ref['sha256']) and ref['key'] == key and
            type(ref['bytes']) is int and 0 < ref['bytes'] <= limit, 'Invalid hosted bulk reference')
    raw = read(key)
    require(len(raw) == ref['bytes'] and digest(raw) == ref['sha256'], 'Invalid hosted bulk object: ' + key)
    return raw


def discovery_resources(read, run, series, dataset):
    instance = run['instanceId']
    ref = run['discovery']
    raw = verified(read, ref, f'{DISCOVERY}/runs/{instance}.json', 8192)
    parent = json.loads(raw)
    require(parent['schemaVersion'] == 1 and parent['instanceId'] == instance and parent['scheduledTime'] == run['scheduledTime']
            and parent['receiptKey'] == ref['key'] and parent['status'] in ('partial', 'complete')
            and parent['packetRef'] == run['packetRef'], 'Bulk receipt pins a different discovery run')
    ref = run['packetRef']
    packet = json.loads(verified(read, ref, f"{DISCOVERY}/inventories/{ref['sha256']}.json", 8 * 1024 * 1024))
    require(packet['schemaVersion'] == 1 and packet['scheduledTime'] == run['scheduledTime'], 'Wrong discovery observation')
    endpoint, = (r for r in packet['endpoints'] if r['series'] == series and r['endpoint'] == 'entry_url')
    require(endpoint['ok'] is True and endpoint['url'] == 'https://open.canada.ca/data/api/action/package_show?id=' + dataset
            and endpoint['inventory']['kind'] == 'dataset-resources', f'Hosted {series} catalogue was unavailable')
    resources = [csv_identity(dataset, resource) for resource in endpoint['inventory']['resources']
                 if isinstance(resource['format'], str) and resource['format'].upper() == 'CSV']
    require(resources and len({r['resourceId'] for r in resources}) == len(resources), 'Empty or duplicate CSV selection')
    return resources


def csv_identity(dataset, resource):
    parsed = urlsplit(resource['url'])
    require(parsed.scheme == 'https' and parsed.netloc == 'open.canada.ca' and not parsed.query and not parsed.fragment
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', resource['id'])
            and re.fullmatch(f"/data/dataset/{dataset}/resource/{resource['id']}/download/[^/]+[.]csv", parsed.path, re.I),
            'Invalid federal bulk citation')
    return {'datasetId': dataset, 'resourceId': resource['id'], 'url': resource['url']}


def complete_run(read, series, dataset, receipt_limit):
    prefix = 'weekly/' + series
    pointer = json.loads(read(prefix + '/latest-complete.json'))
    epoch = pointer['scheduledTime']
    instance = f'federal-discovery-{epoch}'
    key = f'{prefix}/runs/{instance}.json'
    expected = {'instanceId': instance, 'scheduledTime': epoch, 'receiptKey': key, 'status': 'complete'}
    require(type(epoch) is int and epoch > 0 and pointer == expected, 'Invalid last complete hosted bulk pointer')
    raw = read(key)
    require(0 < len(raw) <= receipt_limit, 'Invalid hosted bulk receipt size')
    run = json.loads(raw)
    require(run['schemaVersion'] == 1 and all(run.get(k) == v for k, v in expected.items()), 'Bulk receipt does not match pointer')
    receipt = {'bucket': BUCKET, 'key': key, 'sha256': digest(raw), 'discoverySha256': run['discovery']['sha256']}
    return run, discovery_resources(read, run, series, dataset), receipt
