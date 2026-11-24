import json
import sqlite3
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from lib.wq_store import database, set_catalogue, save_material


def catalogue(status='awaiting_response'):
    return {'totals':{'complete': True, 'officialReported':1},
            'sessions':[{'id':'45-1'}],'records':[
                {'number':3,'url':f'https://www.ourcommons.ca/{lang}/45-1/q-3','language':lang,
                 'dateAsked':'23 novembre 2026','askedBy':{'personId':12,'name':'Member'},
                 'status':status,'text':f'question {lang}','responses':[] if status=='awaiting_response' else [{'id':'345'}]}
                for lang in ('en','fr')]}


class Storage(unittest.TestCase):
    def setUp(self):
        self.db = database(':memory:')
        self.key = ('45-1',3,'fr')
        self.doc = {'doc_key':'345-1','kind':'reply','url':'https://www.ourcommons.ca/example',
                    'text':'mesures','availability':'searchable','response_id':'345','shell_sha256':'a'*64}
    def tearDown(self):
        self.db.close()
    def test_resume_correction_and_partial_refresh(self):
        self.assertEqual(set_catalogue(self.db,catalogue()),2)
        self.assertEqual(self.db.execute('SELECT member_id,asked_on FROM questions').fetchone()[:],('12','2026-11-23'))
        save_material(self.db,self.key,{'documents':[]})
        self.assertEqual(set_catalogue(self.db,catalogue()),0)
        self.assertEqual(set_catalogue(self.db,catalogue('answered')),2)
        save_material(self.db,self.key,{'documents':[self.doc]})
        count = self.db.execute('SELECT count(*) FROM changes').fetchone()[0]
        save_material(self.db,self.key,{'documents':[dict(self.doc,shell_sha256='b'*64)]})
        self.assertEqual(self.db.execute('SELECT count(*) FROM changes').fetchone()[0],count)
        save_material(self.db,self.key,{'documents':[],'errors':['network']})
        self.assertEqual(self.db.execute("SELECT acquisition FROM questions WHERE language='fr'").fetchone()[0],'gap')
        self.assertEqual(self.db.execute("SELECT count(*) FROM wq_fts WHERE wq_fts MATCH 'mesures'").fetchone()[0],1)
        save_material(self.db,self.key,{'documents':[dict(self.doc,text='révisées')]})
        self.assertEqual(self.db.execute("SELECT count(*) FROM wq_fts WHERE wq_fts MATCH 'mesures'").fetchone()[0],0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM wq_fts WHERE wq_fts MATCH 'révisées'").fetchone()[0],1)
    def test_incomplete_inventory_cannot_remove_complete_editions(self):
        c = catalogue()
        set_catalogue(self.db,c)
        c['records'].pop()
        with self.assertRaises(ValueError):
            set_catalogue(self.db,c)
        set_catalogue(self.db,c,partial=True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM questions').fetchone()[0],2)
    def test_fetched_time_does_not_generate_source_events(self):
        c = catalogue()
        set_catalogue(self.db,c)
        c['records'][0]['detailFetchedAt']='later'
        self.assertEqual(set_catalogue(self.db,c),0)


if __name__=='__main__':
    unittest.main()
