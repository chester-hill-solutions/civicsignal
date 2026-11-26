"""Read the Service Inventory CSVs selected by one complete hosted weekly publication."""
import csv
import io
import json

from .federal_bulk_csv import scan
from .hosted_federal_bulk import complete_run, digest, get_object, require, verified

SERIES = 'service-inventory'
PREFIX = 'weekly/' + SERIES
DATASET = '3ac0d080-6149-499a-8b06-7ce5f00ec56c'


def read_complete_service_inventory(read=get_object):
    """Yield each verified CSV and its rows. Consume the rows before advancing to the next CSV."""
    run, expected, receipt = complete_run(read, SERIES, DATASET, 256 * 1024)
    members = run['resources']
    require(len(expected) <= 12 and [item['resource'] for item in members] == expected,
            'Service Inventory members differ from the verified register')
    require(all(item['status'] == 'complete' and type(item['rows']) is int and item['rows'] > 0 for item in members),
            'Service Inventory receipt has an incomplete member')
    require(run['counts'] == {'resources': len(members), 'verified': len(members), 'failed': 0,
            'rows': sum(item['rows'] for item in members), 'originalBytes': sum(item['source']['bytes'] for item in members)},
            'Service Inventory totals differ from the selected CSVs')
    for item in members:
        resource = item['resource']
        key = f"{PREFIX}/checkpoints/{run['scheduledTime']}/{resource['resourceId']}.json"
        pin = read(key)
        expected_pin = {'schemaVersion': 1, 'scheduledTime': run['scheduledTime'], **resource,
                        'result': {k: value for k, value in item.items() if k != 'resource'}}
        require(0 < len(pin) <= 32 * 1024 and json.loads(pin) == expected_pin,
                'Service Inventory checkpoint differs from published member')
        source = item['source']
        raw = verified(read, source, f"{PREFIX}/sources/{source['sha256']}.csv", 24 * 1024 * 1024)
        with io.TextIOWrapper(io.BytesIO(raw), encoding='utf-8-sig', newline='') as stream:
            fields, count = scan(stream, SERIES)
            require(fields == item['fields'] and len(fields) <= 128 and count == item['rows'],
                    'Service Inventory fields or row count differs from its CSV')
            provenance = {'series': SERIES, 'url': resource['url'], 'sha256': source['sha256'],
                          'hostedReceipt': {**receipt, 'checkpointKey': key, 'checkpointSha256': digest(pin)}}
            stream.seek(0)
            yield resource['resourceId'], provenance, csv.DictReader(stream, strict=True)
