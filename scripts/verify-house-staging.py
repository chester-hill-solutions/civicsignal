"""Compare a private House refresh with an offline replay of its archived originals.

Run with the latest completed staging instance while it is the deployed head.
Only the temporary replay database is written. Commands use the registered cf CLI.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch

from lib import committee_files
from lib.committee_calls import committee_id, study_url
from lib.committee_store import initialize, update

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'committee/house-calls'
DATABASE = 'fb9b6314-4b06-4690-a893-7277a8ea00bb'
ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a'


def cf(*args):
    return subprocess.check_output(['cf', *args], env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': ACCOUNT})


def object_bytes(key):
    return cf('r2', 'objects', 'get', key, '--bucket-name', 'civicsignal-stage-funding')


def query(sql):
    result, = json.loads(cf('d1', 'query', DATABASE, '--sql', sql))
    if not result['success']:
        raise RuntimeError('Staging committee query failed')
    return result['results']


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def rows_to_calls(rows):
    calls = []
    for row in rows:
        data = dict(row)
        data['metadata'] = json.loads(data.pop('metadata_json'))
        calls.append(data)
    return calls


def replay(root, base, packet):
    def fetch(page):
        if page['state'] != 'archived':
            if page['chamber'] != 'senate' or page['listing'] != 'unreadable':
                raise ValueError('Missing required House original')
            return
        raw = object_bytes(page['key'])
        digest = sha(raw)
        if digest != page['sha256'] or len(raw) != page['bytes']:
            raise ValueError('Archived original differs from its capture: ' + page['url'])
        target = committee_files.object_path(root, digest)
        target.parent.mkdir(exist_ok=True, parents=True)
        target.write_bytes(gzip.compress(raw))

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, packet['sources']))
    with closing(committee_files.cache_db(root)) as db, db:
        db.executemany('INSERT INTO files VALUES (?,?,?,?,?,?,?)', [
            (p['url'], p.get('sha256'), 'text/html', p.get('bytes'), p.get('error'), p['checked'], p.get('resolvedUrl'))
            for p in packet['sources']])
    path = root / 'calls.sqlite'
    with closing(initialize(sqlite3.connect(path))) as db, db:
        for row in base['prior']:
            m = json.loads(row['metadata_json'])
            update(db, {'session':base['session'], 'id':row['id'], 'language':row['language'], 'kind':'call',
                        'chamber':'house', 'committee_id':committee_id(m['committeeCode']), 'title':row['title'],
                        'url':study_url(m['committeeCode'],m['studyId'],row['language']), 'status':'indexed','metadata':m})
    stored = {p['url'] for p in packet['sources']}
    def offline_capture(_root, urls, _workers, _refresh):
        if set(urls) - stored:
            raise ValueError('Reference parser requested an original absent from this observation')
    receipt_file = root / 'replay.json'
    args = ['committee-calls.py', '--from-cache','--root', str(root), '--db', str(path), '--receipt', str(receipt_file)]
    with patch.object(sys,'argv',args), patch.object(committee_files,'capture',offline_capture), redirect_stdout(sys.stderr):
        runpy.run_path(str(ROOT/'scripts/committee-calls.py'),run_name='__main__')
    with closing(sqlite3.connect(path)) as db:
        db.row_factory = sqlite3.Row
        calls = rows_to_calls(db.execute(CALLS))
    return json.loads(receipt_file.read_bytes()), calls


CALLS = ("SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json "
         "FROM cc_records WHERE session='45-1' AND chamber='house' AND kind='call' ORDER BY id,language")


def verify(instance):
    status = json.loads(cf('workflows','instances','get',instance,'--workflow-name','civicsignal-stage-house','--simple','true'))
    if status.get('success') is not True or status['output']['receiptKey'] != f'{PREFIX}/runs/{instance}.json':
        raise ValueError('House Workflow has no verified completion')
    raw_receipt = object_bytes(status['output']['receiptKey'])
    receipt = json.loads(raw_receipt)
    ref = receipt['packetRef']
    if ref['key'] != f"{PREFIX}/inventories/{ref['sha256']}.json":
        raise ValueError('Unexpected inventory key')
    data = object_bytes(ref['key'])
    if sha(data) != ref['sha256'] or len(data) != ref['bytes']:
        raise ValueError('Inventory disagrees with completion receipt')
    packet = json.loads(data)
    base = json.loads(object_bytes(f'{PREFIX}/observations/{instance}/publication-base.json'))
    if packet['instanceId'] != instance or receipt['instanceId'] != instance:
        raise ValueError('Unexpected observation identity')
    with tempfile.TemporaryDirectory(prefix='civicsignal-house-observation-') as tmp:
        local, calls = replay(Path(tmp),base,packet)
    hosted = rows_to_calls(query(CALLS))
    head = query("SELECT instance_id FROM cc_house_runs WHERE session='45-1' ORDER BY scheduled_time DESC LIMIT 1")
    if head != [{'instance_id':instance}]:
        raise ValueError('Run is no longer the current D1 head; check its dated serving receipt')
    if hosted != calls or local['observedAt'] != packet['observedAt']:
        raise ValueError('Hosted call records or observation timestamp differ from independent replay')
    by_id = {(c['id'],c['language']):c for c in calls}
    for row in packet['calls']:
        if by_id.get((row['id'],row['language'])) != row:
            raise ValueError('Dated packet differs from the original-page replay')
    senate = {p['url']:p['listing'] for p in packet['sources'] if p['chamber']=='senate'}
    if senate != {p['url']:p['listing'] for p in local['sources'] if p['chamber']=='senate'}:
        raise ValueError('Independent Senate probe classifications differ')
    return {'instance':instance,'trigger':status['trigger'], 'start':status['start'], 'end':status['end'],
            'observedAt':packet['observedAt'],'priorObservedAt':base['observedAt'], 'sessionCutoff':base['cutoff'],
            'originals':sum(p['state']=='archived' for p in packet['sources']),
            'bytes':sum(p.get('bytes',0) for p in packet['sources']), 'senate':senate,
            'allHostedCallRowsMatched':len(calls), 'replayCounts':local['counts'], 'packetSha256':ref['sha256'],
            'receiptSha256':sha(raw_receipt), 'serving':receipt['served']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('instance')
    args = parser.parse_args()
    if not re.fullmatch(r'house-calls-[0-9]+',args.instance):
        parser.error('Expected a House refresh instance ID')
    print(json.dumps(verify(args.instance),indent=2))
