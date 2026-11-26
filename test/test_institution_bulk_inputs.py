"""Check the native weekly boundary between a complete discovery packet and federal-bulk.py."""
from contextlib import closing
import csv
from hashlib import sha256
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/institution-coverage/container'))
import bulk_inputs as inputs  # noqa: E402


class InstitutionBulkInputs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name)
        self.objects = {}
        register = inputs.REGISTER.read_bytes()
        rows = list(csv.DictReader(io.StringIO(register.decode())))
        self.stamp = '2026-11-26T15:39:00.000Z'
        self.epoch = 1795707540000
        instance = 'federal-discovery-' + str(self.epoch)
        self.key = f'{inputs.DISCOVERY}/runs/{instance}.json'
        self.register = self.save('registers',register,'csv')
        sources = {}
        endpoints = []
        for row in rows:
            for field,url,dataset in inputs.source_endpoints(row):
                series = row['series_key']
                entry = {'series':series,'endpoint':field,'url':url,'ok':True}
                source = {'url':url,'finalUrl':url,'observedAt':self.stamp,'status':200,'bytes':1}
                if (series in inputs.DATASETS or series == 'publications') and field == 'entry_url':
                    resource = 'aaaa0000-0000-4000-8000-000000000000'
                    csv_url = f'https://open.canada.ca/data/dataset/{dataset}/resource/{resource}/download/source.csv'
                    raw = json.dumps({'success':True,'result':{'id':dataset,'title':'Data','resources':[
                        {'id':resource,'url':csv_url,'format':'CSV','name':'Resource'}]}}).encode()
                    source.update(self.save('sources',raw,'json'))
                    entry['inventory'] = inputs.describe(raw,url,dataset)
                if url in {*inputs.TB_LANDING.values(), *inputs.IRCC_LANDING.values()}:
                    raw = f'<main><h1>{url}</h1><a href="/index.html">Index</a></main>'.encode()
                    source.update(self.save('sources',raw,'html'))
                    entry['inventory'] = inputs.describe(raw,url,None)
                sources[url] = source
                endpoints.append(entry)
        self.packet = {'schemaVersion':1,'scheduledTime':self.epoch,'registerSha256':self.register['sha256'],
                       'endpoints':endpoints,'sources':[sources[url] for url in sorted(sources)]}
        self.receipt = {'schemaVersion':1,'instanceId':instance,'scheduledTime':self.epoch,'receiptKey':self.key,
                        'observedAt':self.stamp,'status':'complete','register':self.register,'counts':{
                            'series':len(rows),'endpoints':len(endpoints),'verified':len(endpoints),'failed':0,
                            'uniqueUrls':len(sources),'originals':len(sources),'originalBytes':sum(s['bytes'] for s in sources.values())}}

    def save(self, group, raw, extension):
        digest = sha256(raw).hexdigest()
        key = f'{inputs.DISCOVERY}/{group}/{digest}.{extension}'
        self.objects[key] = raw
        return {'key':key,'bytes':len(raw),'sha256':digest}

    def seal(self):
        self.receipt['packetRef'] = self.save('inventories',json.dumps(self.packet).encode(),'json')
        raw = json.dumps(self.receipt).encode()
        self.objects[self.key] = raw
        return {'key':self.key,'sha256':sha256(raw).hexdigest(),'bytes':len(raw)}

    def prepare(self):
        return inputs.prepare_bulk_inputs(self.workspace, self.objects.__getitem__, self.seal())

    def test_replay_and_conflict_keep_existing_observations(self):
        first = self.prepare()
        path = self.workspace / 'data/corpus/federal-source-inventory/inventory.sqlite'
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("INSERT INTO catalogue_observations VALUES('other','entry_url', 'before', 'sha', 'url','{}')")
        self.assertEqual(first,self.prepare())
        with closing(inputs.committee_files.cache_db(path.parent)) as cache:
            self.assertEqual(dict(cache.execute('SELECT url,digest FROM files')), first['guidance'])
        with closing(sqlite3.connect(path)) as db, db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM catalogue_observations').fetchone()[0],4)
            self.assertEqual(db.execute("SELECT sha256 FROM catalogue_observations WHERE series='publications'").fetchone()[0],
                             first['publicationsCatalogueSha256'])
            db.execute("UPDATE catalogue_observations SET sha256='bad' WHERE series='grant-awards'")
            db.execute("DELETE FROM catalogue_observations WHERE series='ati-summaries'")
        with self.assertRaisesRegex(ValueError, 'would be selected'):
            self.prepare()
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT series FROM catalogue_observations ORDER BY series').fetchall(),
                             [('grant-awards',),('other',),('publications',)])

    def test_rejects_incomplete_or_unbacked_metadata_before_any_database_write(self):
        self.receipt['status'] = 'partial'
        with self.assertRaisesRegex(ValueError, 'did not complete'):
            self.prepare()
        self.receipt['status'] = 'complete'
        entry = next(e for e in self.packet['endpoints'] if e['series']=='ati-summaries')
        entry['inventory']['resources'][0]['url'] += '?replacement'
        with self.assertRaisesRegex(ValueError, 'differ'):
            self.prepare()
        self.assertFalse((self.workspace/'data').exists())
