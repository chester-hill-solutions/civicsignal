"""Resolve House sessional-paper citations through the Library of Parliament's digital catalogue."""
import json
from pathlib import Path
import re
from urllib.parse import urlencode, urlsplit

from .wq_replies import _pdf_text, _store

DISCOVERY = 'https://parl-gc.primo.exlibrisgroup.com'
DELIVERY = 'https://na01.alma.exlibrisgroup.com/view/delivery/01CALP_INST'


def sessional_documents(record, response, get, objects):
    paper = response['sessionalPaperNumber']
    if not isinstance(paper,str) or not re.fullmatch(r'\d{4}-\d{3}-\d+[A-Za-z0-9-]*', paper):
        raise ValueError('Unrecognized published sessional-paper number')
    if urlsplit(response['url']).hostname != 'parl-gc.primo.exlibrisgroup.com':
        raise ValueError('Expected a Library of Parliament discovery link')
    params = {'vid':'01CALP_INST:01CALP','inst':'01CALP_INST','scope':'SESSIONPAP','tab':'SESSIONAL',
              'q':f'any,exact,{paper}','lang':record['language'],'offset':0,'limit':25}
    matches = json.loads(get(DISCOVERY + '/primaws/rest/pub/pnxs?' + urlencode(params)))
    if matches['info']['total'] > len(matches['docs']):
        raise ValueError('Ambiguous sessional-paper catalogue search')
    def exact_match(match):
        display = match['pnx']['display']
        exact_series = any(re.search(r'(?<![\w-])' + re.escape(paper) + r'(?![\w-])', value) for value in display.get('series',[]))
        titles = display.get('title',[])
        same_question = any(re.search(r'\bQ[-– ]' + str(record['number']) + r'(?!\d)', title, re.I) for title in titles)
        return exact_series and same_question
    records = [m for m in matches['docs'] if exact_match(m)]
    if not records:
        params['q'] = f"title,contains,Q-{record['number']}"
        other = json.loads(get(DISCOVERY + '/primaws/rest/pub/pnxs?' + urlencode(params)))
        records = [m for m in other['docs'] if exact_match(m)]
    documents = []
    for match in records:
        display = match['pnx']['display']
        for mms in display.get('mms',[]):
            if not mms.isdigit():
                raise ValueError('Invalid Library record identifier')
            payload = get(f'{DELIVERY}/{mms}.json')
            if getattr(payload, 'status', 200) == 404:
                raise ValueError(f'Library record {mms} matches {paper} but publishes no digital file manifest (HTTP 404)')
            manifest = json.loads(payload)
            rep = str(manifest['id'])
            if str(manifest['mms_id']) != mms or not rep.isdigit():
                raise ValueError('Library digital record identity mismatch')
            for item in manifest.get('files', []):
                file_id = str(item['pid'])
                if not file_id.isdigit():
                    raise ValueError('Invalid Library file identifier')
                title = item['label']
                lang_suffix = re.search(r'[-_]([efb])(?:\.pdf)?$',title,re.I)
                if lang_suffix and lang_suffix[1].lower() in ('e','f') and lang_suffix[1].lower() != record['language'][0]:
                    continue
                url = f'{DELIVERY}/{rep}/{file_id}'
                doc = {'doc_key':f"paper:{paper}:{file_id}",'response_id':str(response['id']),'kind':'reply',
                       'title':title,'respondent':record.get('respondingInstitution'),'url':url,
                       'catalogue_url':response['url'],'mms_id':mms,'sessional_paper_number':paper,
                       'file_language':lang_suffix[1].lower() if lang_suffix else None,
                       'mime_type':item.get('format'),'availability':'gap','text':''}
                if item.get('accessRightsOk') is True and not item.get('deniedMessage'):
                    body = get(url)
                    expected = int(item.get('fileSize') or 0)
                    if getattr(body,'status',200) == 200 and body and (not expected or len(body)==expected):
                        if item.get('format') == 'application/pdf' and not body.startswith(b'%PDF-'):
                            raise ValueError('Library PDF returned an unexpected format')
                        doc['object_sha256'] = _store(Path(objects), body)
                        doc['text'] = _pdf_text(body) if body.startswith(b'%PDF-') else ''
                        doc['availability'] = 'searchable' if doc['text'] else 'stored'
                documents.append(doc)
    if not documents:
        raise ValueError('No verified Library digital file matched the published sessional paper and edition')
    return documents
