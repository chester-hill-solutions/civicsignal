import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lib import hosted_service_inventory as service
from lib.hosted_federal_bulk import DISCOVERY


class HostedServiceInventoryTests(unittest.TestCase):
    def store(self, key, raw):
        self.objects[key] = raw
        return {'key': key, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

    def by_digest(self, folder, extension, raw):
        return self.store(f'{folder}/{hashlib.sha256(raw).hexdigest()}.{extension}', raw)

    def setUp(self):
        self.objects = {}
        self.members, catalogue = [], []
        epoch, instance = 1, 'federal-discovery-1'
        fields = ['service_id', 'fiscal_yr', 'service_name_en', 'service_name_fr']
        for i in range(2):
            rid = f'0000000{i}-aaaa-40ff-bbbb-000000000000'
            url = f'https://open.canada.ca/data/dataset/{service.DATASET}/resource/{rid}/download/sample.csv'
            catalogue.append({'id': rid, 'url': url, 'format': 'CSV'})
            resource = {'datasetId': service.DATASET, 'resourceId': rid, 'url': url}
            text = ','.join(fields) + f'\r\n{i},2024,"Sample,\r\nName",Exemple\r\n'
            source = self.by_digest(service.PREFIX + '/sources', 'csv', text.encode('utf-8-sig'))
            result = {'status': 'complete', 'rows': 1, 'fields': fields, 'source': source, 'finalUrl': url, 'lastModified': None}
            self.members.append({'resource': resource, **result})
            self.store(f'{service.PREFIX}/checkpoints/{epoch}/{rid}.json', json.dumps(
                {'schemaVersion': 1, 'scheduledTime': epoch, **resource, 'result': result}).encode())
        endpoint = {'series': service.SERIES, 'endpoint': 'entry_url', 'ok': True,
                    'url': 'https://open.canada.ca/data/api/action/package_show?id=' + service.DATASET,
                    'inventory': {'kind': 'dataset-resources', 'resources': catalogue}}
        packet = self.by_digest(DISCOVERY + '/inventories', 'json',
                                json.dumps({'schemaVersion': 1, 'scheduledTime': epoch, 'endpoints': [endpoint]}).encode())
        parent_key = f'{DISCOVERY}/runs/{instance}.json'
        shared = {'schemaVersion': 1, 'instanceId': instance, 'scheduledTime': epoch, 'packetRef': packet}
        parent = self.store(parent_key, json.dumps({**shared, 'receiptKey': parent_key, 'status': 'partial'}).encode())
        self.key = f'{service.PREFIX}/runs/{instance}.json'
        self.run_data = {**shared, 'receiptKey': self.key, 'discovery': parent, 'status': 'complete', 'resources': self.members,
                         'counts': {'resources': 2, 'verified': 2, 'failed': 0, 'rows': 2,
                                    'originalBytes': sum(m['source']['bytes'] for m in self.members)}}
        self.store(service.PREFIX + '/latest-complete.json', json.dumps(
            {k: self.run_data[k] for k in ('status', 'instanceId', 'scheduledTime', 'receiptKey')}).encode())

    def records(self):
        self.store(self.key, json.dumps(self.run_data).encode())
        return [(key, provenance, list(rows)) for key, provenance, rows in service.read_complete_service_inventory(self.objects.__getitem__)]

    def test_reads_each_verified_member_with_quoted_multiline_rows(self):
        output = self.records()
        self.assertEqual([k for k, _, _ in output], [m['resource']['resourceId'] for m in self.members])
        for i, (_, provenance, rows) in enumerate(output):
            self.assertEqual(rows[0]['service_name_en'], 'Sample,\r\nName')
            self.assertEqual(rows[0]['service_id'], str(i))
            self.assertEqual(provenance['sha256'], self.members[i]['source']['sha256'])
            pin = provenance['hostedReceipt']
            self.assertEqual(pin['checkpointSha256'], hashlib.sha256(self.objects[pin['checkpointKey']]).hexdigest())

    def test_refuses_a_missing_catalogue_member_before_consumption(self):
        self.members.pop()
        with self.assertRaisesRegex(ValueError, 'members differ'):
            self.records()

    def test_refuses_member_with_another_observations_checkpoint(self):
        m = self.members[1]
        key = f"{service.PREFIX}/checkpoints/1/{m['resource']['resourceId']}.json"
        checkpoint = json.loads(self.objects[key])
        self.objects[key] = json.dumps({**checkpoint, 'scheduledTime': 2}).encode()
        with self.assertRaisesRegex(ValueError, 'checkpoint differs'):
            self.records()

    def test_refuses_corrupt_csv_bytes(self):
        self.objects[self.members[1]['source']['key']] += b'x'
        with self.assertRaisesRegex(ValueError, 'Invalid hosted bulk object'):
            self.records()
