import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lib import hosted_official_titles as titles


class HostedOfficialTitlesTests(unittest.TestCase):
    def setUp(self):
        self.objects = {}
        self.id = 'aaaaaaaa-aaaa-4abc-babc-aaaaaaaaaaaa'
        url = f'https://open.canada.ca/data/dataset/{titles.DATASET}/resource/{self.id}/download/names.csv'
        instance = 'federal-discovery-1'
        parent = f'{titles.DISCOVERY}/runs/{instance}.json'
        key = f'{titles.PREFIX}/runs/{instance}.json'
        pointer = dict(instanceId=instance, scheduledTime=1, receiptKey=key, status='complete')
        self.objects[titles.PREFIX + '/latest-complete.json'] = self.encode(pointer)
        self.key = key
        resource = {'datasetId': titles.DATASET, 'resourceId': self.id, 'url': url}
        endpoint = {'series': 'official-titles', 'endpoint': 'entry_url', 'ok': True,
                    'url': 'https://open.canada.ca/data/api/action/package_show?id=' + titles.DATASET,
                    'inventory': {'kind': 'dataset-resources', 'resources': [{'format': 'CSV', 'url': url, 'id': self.id}]}}
        packet = self.object(titles.DISCOVERY + '/inventories', 'json', self.encode(dict(schemaVersion=1, scheduledTime=1, endpoints=[endpoint])))
        parent_body = self.encode(dict(schemaVersion=1, **{**pointer, 'status': 'partial', 'receiptKey': parent}, packetRef=packet))
        discovery = self.ref(parent, parent_body)
        self.fields = ['Legal title', 'Appellation légale', 'Applied title', "Titre d'usage"]
        self.row = ['Sample  ', 'Exemple', 'A', 'B']
        csv = (','.join(self.fields) + '\r\n' + ','.join(self.row) + '\r\n').encode('utf-8-sig')
        source = self.object(titles.PREFIX + '/sources', 'csv', csv)
        self.receipt = dict(schemaVersion=1, **pointer, source=source, resource=resource, rows=1, discovery=discovery, packetRef=packet)
        self.set_records([self.row])

    @staticmethod
    def encode(data):
        return json.dumps(data, ensure_ascii=False).encode()

    def ref(self, key, raw):
        self.objects[key] = raw
        return {'key': key, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

    def object(self, folder, extension, raw):
        return self.ref(f'{folder}/{hashlib.sha256(raw).hexdigest()}.{extension}', raw)

    def set_records(self, rows):
        raw = self.encode(dict(schemaVersion=1, fields=self.fields, rows=rows))
        self.receipt['records'] = self.object(titles.PREFIX + '/records', 'json', raw)
        self.objects[self.key] = self.encode(self.receipt)

    def test_consumes_last_complete_with_verified_partial_parent_and_preserves_publisher_fields(self):
        key, provenance, rows = titles.read_complete_titles(self.objects.__getitem__)
        self.assertEqual(key, self.id)
        self.assertEqual(provenance['url'], self.receipt['resource']['url'])
        self.assertEqual(provenance['sha256'], self.receipt['source']['sha256'])
        self.assertEqual(provenance['hostedReceipt']['sha256'], hashlib.sha256(self.objects[self.key]).hexdigest())
        self.assertEqual(rows, [dict(zip(self.fields, self.row))])

    def test_refuses_corrupt_source_even_if_normalized_object_is_readable(self):
        key = self.receipt['source']['key']
        self.objects[key] = self.objects[key].upper()
        with self.assertRaisesRegex(ValueError, 'Invalid hosted titles object'):
            titles.read_complete_titles(self.objects.__getitem__)

    def test_refuses_rehashed_records_with_changed_publisher_text(self):
        self.set_records([['Sample', *self.row[1:]]])
        with self.assertRaisesRegex(ValueError, 'records differ'):
            titles.read_complete_titles(self.objects.__getitem__)

    def test_refuses_latest_pointer_to_a_failed_publication(self):
        self.receipt['status'] = 'failed'
        self.objects[self.key] = self.encode(self.receipt)
        with self.assertRaisesRegex(ValueError, 'receipt does not match pointer'):
            titles.read_complete_titles(self.objects.__getitem__)
