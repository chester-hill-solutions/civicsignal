import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from lib.wq_archive import sessional_documents


class Archive(unittest.TestCase):
    response = {'id':'3','sessionalPaperNumber':'8555-451-1','url':'https://parl-gc.primo.exlibrisgroup.com/discovery/search'}
    def fetch(self,url):
        if 'pnxs?' in url:
            return json.dumps({'info':{'total':2},'docs':[{'pnx':{'display':{'title':['Q-11'],'mms':['11'],'series':['8555-451-11']}}},
                    {'pnx':{'display':{'title':['Q-1'],'mms':['22'],'series':['Series 8555-451-1$$Q']}}}]}).encode()
        if url.endswith('/22.json'):
            return json.dumps({'id':'333','mms_id':'22','files':[
                {'pid':'8','label':'8555-451-1-e','accessRightsOk':True,'format':'application/octet-stream','fileSize':'4'},
                {'pid':'9','label':'8555-451-1-f','accessRightsOk':False,'format':'application/pdf'}]}).encode()
        if url.endswith('/333/8'):
            return b'file'
        self.fail(url)
    def test_match_exact_paper_language_and_rights(self):
        with tempfile.TemporaryDirectory() as objects:
            en, = sessional_documents({'language':'en','number':1},self.response,self.fetch,objects)
            fr, = sessional_documents({'language':'fr','number':1},self.response,self.fetch,objects)
            self.assertEqual(en['availability'],'stored')
            self.assertEqual((Path(objects)/en['object_sha256']).read_bytes(), b'file')
            self.assertEqual(fr['availability'],'gap')
            self.assertEqual(fr['url'].split('/')[-1],'9')

if __name__=='__main__':
    unittest.main()
