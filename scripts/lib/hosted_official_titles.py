"""Read the private weekly register's last complete titles publication for the institution report."""
import hashlib
import io
import json
import os
import re
import subprocess
from urllib.parse import urlsplit

from .federal_bulk_csv import scan

ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a'
BUCKET = 'civicsignal-stage-weekly'
PREFIX = 'weekly/official-titles'
DISCOVERY = 'weekly/federal-discovery'
DATASET = '83320390-7715-43bc-a281-2049bf5d4232'


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
            type(ref['bytes']) is int and 0 < ref['bytes'] <= limit, 'Invalid hosted titles reference')
    raw = read(key)
    require(len(raw) == ref['bytes'] and digest(raw) == ref['sha256'], 'Invalid hosted titles object: ' + key)
    return raw


def check_discovery(read, run):
    instance = run['instanceId']
    ref = run['discovery']
    raw = verified(read, ref, f'{DISCOVERY}/runs/{instance}.json', 8192)
    parent = json.loads(raw)
    require(parent['schemaVersion'] == 1 and parent['instanceId'] == instance and parent['scheduledTime'] == run['scheduledTime']
            and parent['receiptKey'] == ref['key'] and parent['status'] in ('partial', 'complete')
            and parent['packetRef'] == run['packetRef'], 'Hosted titles pin a different discovery run')
    ref = run['packetRef']
    packet = json.loads(verified(read, ref, f"{DISCOVERY}/inventories/{ref['sha256']}.json", 8 * 1024 * 1024))
    require(packet['schemaVersion'] == 1 and packet['scheduledTime'] == run['scheduledTime'], 'Wrong discovery observation')
    endpoint, = (r for r in packet['endpoints'] if r['series'] == 'official-titles' and r['endpoint'] == 'entry_url')
    require(endpoint['ok'] is True and endpoint['url'] == 'https://open.canada.ca/data/api/action/package_show?id=' + DATASET
            and endpoint['inventory']['kind'] == 'dataset-resources', 'Hosted titles catalogue was unavailable')
    resource, = (r for r in endpoint['inventory']['resources'] if isinstance(r['format'], str) and r['format'].upper() == 'CSV')
    require(run['resource'] == {'datasetId': DATASET, 'resourceId': resource['id'], 'url': resource['url']},
            'Hosted titles CSV differs from its verified catalogue')
    parsed = urlsplit(resource['url'])
    require(parsed.scheme == 'https' and parsed.netloc == 'open.canada.ca' and not parsed.query and not parsed.fragment
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', resource['id'])
            and re.fullmatch(f"/data/dataset/{DATASET}/resource/{resource['id']}/download/[^/]+[.]csv", parsed.path, re.I),
            'Invalid federal titles citation')
    return resource


def read_complete_titles(read=get_object):
    pointer = json.loads(read(PREFIX + '/latest-complete.json'))
    epoch = pointer['scheduledTime']
    instance = f'federal-discovery-{epoch}'
    key = f'{PREFIX}/runs/{instance}.json'
    expected = {'instanceId': instance, 'scheduledTime': epoch, 'receiptKey': key, 'status': 'complete'}
    require(type(epoch) is int and epoch > 0 and pointer == expected, 'Invalid last complete hosted titles pointer')
    raw = read(key)
    require(0 < len(raw) <= 8192, 'Invalid hosted titles receipt size')
    run = json.loads(raw)
    require(run['schemaVersion'] == 1 and all(run.get(k) == v for k, v in expected.items()), 'Hosted titles receipt does not match pointer')
    resource = check_discovery(read, run)
    source, records = run['source'], run['records']
    original = verified(read, source, f"{PREFIX}/sources/{source['sha256']}.csv", 512 * 1024)
    stored = json.loads(verified(read, records, f"{PREFIX}/records/{records['sha256']}.json", 2 * 1024 * 1024))
    rows = []
    with io.TextIOWrapper(io.BytesIO(original), encoding='utf-8-sig', newline='') as stream:
        fields, count = scan(stream, 'official-titles', on_row=rows.append)
    require(type(run['rows']) is int and run['rows'] == count and stored == {'schemaVersion': 1, 'fields': fields, 'rows': rows},
            'Hosted titles records differ from the archived CSV')
    provenance = {'series': 'official-titles', 'url': resource['url'], 'sha256': source['sha256'],
                  'hostedReceipt': {'bucket': BUCKET, 'key': key, 'sha256': digest(raw),
                                    'discoverySha256': run['discovery']['sha256'], 'recordsSha256': records['sha256']}}
    return resource['id'], provenance, [dict(zip(fields, row, strict=True)) for row in rows]
