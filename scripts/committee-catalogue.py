"""Inventory published House and Senate committee source indexes for session 45-1."""
import argparse
from collections import Counter
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess
import sqlite3
import time
from urllib.parse import parse_qs, urlencode, urljoin

from lib.committee_files import capture, official
from lib.wq_catalog import cls, save_atomic, tree
from lib.wq_store import now

HOUSE = 'https://www.ourcommons.ca'
SENATE = 'https://sencanada.ca'
SENATE_AJAX = SENATE + '/umbraco/surface/CommitteesAjax/'


def get(url):
    """Fetch official catalogue HTML; curl HTTP/2 is reliable for Senate TLS."""
    last = None
    for attempt in range(4):
        try:
            result = subprocess.run(['curl','--fail','--location','--silent','--show-error',
                                     '--max-time','45','--user-agent','CivicSignal committee catalogue/1.0',url],
                                    check=True,capture_output=True)
            return result.stdout.decode('utf-8-sig',errors='replace')
        except (subprocess.CalledProcessError, OSError) as exc:
            last = exc
            if attempt < 3:
                time.sleep(attempt + 1)
    raise RuntimeError(f'Official source fetch failed after retries: {url}: {last}')


def senate_directory_url(language):
    return SENATE_AJAX + 'GetCommitteeListPartialView?' + urlencode({'forMenu':'false','Session':'45-1','Lang':language})


def parse_senate_directory(html, source):
    return [{'code':n.attrs['id'].upper(),'name':n.find(lambda t: cls(t,'sc-committee-list-item-name')).text(),
             'url':urljoin(SENATE,n.attrs['href']), 'directory':source}
            for n in tree(html).walk() if cls(n,'sc-committee-list-item') and n.attrs.get('id')]


def directories(chamber, language):
    if chamber == 'senate':
        src = senate_directory_url(language)
        return parse_senate_directory(get(src), src)
    src = HOUSE + f'/Committees/{language}/List?parl=45&session=1'
    committees = []
    for group in tree(get(src)).findall(lambda n: cls(n,'accordion-item')):
        name = group.find(lambda n: cls(n,'committee-name'))
        for link in group.findall(lambda n: n.tag=='a' and re.fullmatch(fr'(?:(?:https:)?//www\.parl\.ca)?/Committees/{language}/[A-Za-z0-9]+',n.attrs.get('href',''),re.I)):
            code = link.attrs['href'].split('/')[-1]
            owner = link.parent
            while owner != group and not cls(owner,'subcommittee-item'):
                owner = owner.parent
            title = owner.find(lambda n: cls(n,'subcommittee-name')) if owner != group else name
            committees.append({'code':code,'name':title.text() if title else code,'url':urljoin(HOUSE,link.attrs['href']), 'directory':src})
    return committees


def anchors(node):
    return node.findall(lambda n: n.tag=='a' and n.attrs.get('href'))


def entries(url, records):
    # Keep shared files attached to each published study and submitter.
    index = {(item['url'],item.get('study','') or '',item.get('submitter','') or '',
              item.get('organization','') or '',item.get('studyUrl'),
              json.dumps(item.get('studyUrls',[]),sort_keys=True),item.get('meetingUrl'),
              item.get('reportUrl'),item.get('committeeCode'),item.get('language'),item.get('section')):item for item in records}
    links = [index[key] for key in sorted(index, key=lambda value: tuple('' if item is None else str(item) for item in value))]
    return {'url':url, 'sourceUrl':url, 'links':links,
            'sourceTotals':{'rows':len(records),'uniqueLinks':len(links)},
            'terminalPage':{'kind':'rendered-index','exhausted':True,'rows':len(records)}}


PARTICIPATION_LABELS = {'participate', 'participez'}


def house_study_title(page):
    title=page.find(lambda n:n.tag=='h1' and cls(n,'study-title-label'))
    if title: return title.text()
    bill=page.find(lambda n:n.tag=='h1' and cls(n,'study-bill-label'))
    name=page.find(lambda n:n.tag=='h2' and cls(n,'study-bill-title-label'))
    if bill: return ' — '.join(x.text() for x in (bill,name) if x and x.text())
    return None


def load_resume_checkpoint(partial_path):
    if not partial_path.is_file():
        raise RuntimeError('No interrupted partial catalogue is available to resume')
    data=json.loads(partial_path.read_text())
    if data.get('completed') is not False:
        raise RuntimeError('Resume source is not an incomplete partial catalogue')
    return data


def pub(link, base, kind):
    url = urljoin(base,link.attrs['href'])
    title = link.attrs.get('title') or link.text()
    path = url.lower()
    if kind == 'submission':
        category = 'submission'; ident = None
    elif 'studyactivityid=' in path:
        category = 'study'
        ident = re.search(r'studyactivityid=(\d+)',url,re.I)
    elif '/content/sen/committee/' in path and re.search(r'\d+ev-\d+-(?:e|f|en|fr)$',path):
        category = 'evidence'; ident = re.search(r'ev-(\d+)',path)
    elif '/content/sen/committee/' in path and re.search(r'\d+mn-\d+[a-z]*-(?:e|f|en|fr)$',path):
        category = 'minutes'; ident = re.search(r'mn-(\d+)',path)
    elif any(term in title.lower() for term in ('government response','réponse du gouvernement','réponse gouvernementale')):
        category = 'government-response'; ident = None
    elif re.search(r'-gr-\d+-',path):
        category = 'government-response'; ident = re.search(r'-gr-(\d+)-',url,re.I)
    elif '/report/' in path or '/rapport/' in path or re.search(r'/(?:reports|rapports)/[^/]+\.(?:pdf|docx?)$',path):
        category = 'report'; ident = re.search(r'/(?:report|rapport)/(\d+)',url,re.I)
    elif '/content/sen/committee/' in path and re.search(r'-(?:c|s|ss)-\d+-[ef]$',path):
        category = 'study'; ident = None
    elif '/content/sen/committee/' in path:
        category = 'report'; ident = None
    elif '/noticeofmeeting/' in path or '/avisdeconvocation/' in path or re.search(r'/meeting-\d+/notice(?:/|$)',path):
        category = 'notice'; ident = re.search(r'(?:noticeofmeeting/|avisdeconvocation/|meeting-)(\d+)',url,re.I)
    elif re.search(r'/meeting-\d+/minutes',path) or 'minutes' in title.lower() or 'procès-verbal' in title.lower():
        category = 'minutes'; ident = re.search(r'/meeting-(\d+)',url,re.I)
    elif re.search(r'/meeting-\d+/evidence',path) or 'evidence' in title.lower() or 'témoignages' in title.lower():
        category = 'evidence'; ident = re.search(r'/meeting-(\d+)',url,re.I)
    elif '/response-' in path or 'government response' in title.lower() or 'réponse du gouvernement' in title.lower():
        category = 'government-response'; ident = None
    elif re.search(r'/report-\d+',path) or 'committee report' in title.lower() or 'rapport du comité' in title.lower():
        category = 'report'; ident = re.search(r'/report-(\d+)',url,re.I)
    elif '/meeting-' in path or 'meeting' in title.lower() or 'réunion' in title.lower():
        category = 'meeting'; ident = re.search(r'/meeting-(\d+)',url,re.I)
    elif kind in ('brief','exhibit','correspondence','attachment'):
        category = kind; ident = None
    else:
        category = kind; ident = None
    result = {'kind':category,'url':url,'title':title,'sourceUrl':url,'sourceContext':title}
    if ident:
        key = 'studyId' if category == 'study' else ('meetingId' if category in ('meeting','notice','minutes','evidence') else 'reportId')
        result[key] = ident.group(1)
    meeting = re.search(r'/meeting-(\d+)',url,re.I)
    if meeting:
        result['meetingId'] = meeting.group(1)
        result['meetingUrl'] = urljoin(url, f'../meeting-{meeting.group(1)}/')
    report = re.search(r'(/report-\d+)',url,re.I)
    if report:
        result['reportUrl'] = url[:url.lower().find(report.group(1).lower())] + report.group(1) + '/'
        result['reportId'] = report.group(1).rsplit('-',1)[-1]
    if category == 'notice' and ('/noticeofmeeting/' in path or '/avisdeconvocation/' in path):
        result['meetingUrl'] = url
    study = re.search(r'(?:studyActivityId=)(\d+)',url,re.I)
    if study:
        result['studyId'] = study.group(1)
    order = re.search(r'-(C|S|SS)-(\d+)-[ef]$',url,re.I)
    if category == 'study' and order:
        result['orderOfReferenceId'] = f'{order.group(1).upper()}-{order.group(2)}'
        result['studyId'] = result['orderOfReferenceId']
    return result


def house_index(c, lang, section):
    url = c['url'] + f'/{section}?parl=45&session=1'
    html = get(url)
    if '<html' not in html.lower() or '45' not in html:
        raise ValueError('House index response was not a recognized committee page')
    pager = tree(html)
    page_numbers = {int(n.attrs['data-page']) for n in pager.findall(lambda n:n.tag=='a' and n.attrs.get('data-page','').isdigit())}
    for n in anchors(pager):
        match = re.search(r'[?&](?:page|pagenumber|pageindex)=(\d+)',n.attrs['href'],re.I)
        if match: page_numbers.add(int(match.group(1)))
    max_page = max(page_numbers,default=1)
    pages = [(url,html)]
    if max_page > 1:
        pages = []
        seen = set()
        for number in range(1,max_page+1):
            page_url = url + f'&page={number}'
            page_html = get(page_url)
            signature = tuple(sorted(a.attrs['href'] for a in anchors(tree(page_html))))
            if signature in seen:
                raise ValueError(f'Repeated House index page: {page_url}')
            seen.add(signature)
            pages.append((page_url,page_html))
    records = []
    study_titles = {}
    for page_url,page_html in pages:
      page = tree(page_html)
      for a in anchors(page):
        path = a.attrs['href']
        if re.search(rf'/committees/{lang}/{c["code"]}/StudyActivity\?studyActivityId=\d+$', path, re.I):
            item=pub(a,page_url,'study'); item['studyUrl']=item['url']
            label = ' '.join((a.text() or '').split())
            # A Work page repeats each study's URL on a "Participate" button. That
            # label is an action, not the published study title.
            if label.casefold() not in PARTICIPATION_LABELS:
                study_titles.setdefault(item['url'], label)
            records.append(item)
        elif re.search(rf'/DocumentViewer/{lang}/45-1/{c["code"]}/',path,re.I):
            item = pub(a,page_url,'publication')
            item.update({'committeeCode':c['code'],'language':lang,'section':section,
                         'studyUrl':None,'sourceIndexUrl':url})
            if section == 'Meetings':
                card = a
                while card is not None and 'meeting-card-container' not in card.attrs.get('class','').split():
                    card = card.parent
                if card:
                    card_links = anchors(card)
                    study_links = [x for x in card_links if re.search(r'studyactivityid=\d+',x.attrs.get('href',''),re.I)]
                    study_urls = [urljoin(page_url,x.attrs['href']) for x in study_links]
                    item['studyUrls'] = sorted(set(study_urls))
                    item['studyUrl'] = study_urls[0] if len(study_urls)==1 else None
                    watch = next((x for x in card_links if x.attrs.get('data-meeting-id')),None)
                    if watch:
                        item['meetingId'] = watch.attrs['data-meeting-id']
                    number = re.search(r'/meeting-(\d+)',item['url'],re.I)
                    if number: item['meetingNumber'] = number.group(1)
                    notice = next((x for x in card_links if re.search(r'/notice(?:/|$)',x.attrs.get('href',''),re.I)),None)
                    if notice: item['meetingUrl'] = urljoin(page_url,notice.attrs['href'])
            records.append(item)
    for item in records:
        if item.get('kind') == 'study':
            better = study_titles.get(item['url'])
            if better and (item.get('title') or '').casefold() in PARTICIPATION_LABELS | {''}:
                item['title'] = better
                item['sourceContext'] = better
        item.setdefault('committeeCode',c['code']); item.setdefault('language',lang)
        item.setdefault('section',section); item.setdefault('sourceIndexUrl',url)
        item.setdefault('studyUrl',None)
    result = entries(url,records)
    result['terminalPage']={'kind':'house-rendered-index','pages':len(pages),'pageUrls':[x[0] for x in pages],
                            'paginationControlsObserved':max_page>1,'exhausted':True}
    result['sourceTotals']={'renderedLinks':len(records),'uniqueLinks':len(result['links'])}
    return result


def house_briefs(study):
    url = study['url']
    html = get(url)
    page=tree(html)
    title=house_study_title(page)
    if title is None:
        raise ValueError('House study page missing its published study title')
    match = re.search(r'var a\s*=\s*"([^"]+/StudyActivity/GetBriefs\?studyActivityId=\d+)"',html,re.I)
    if 'id="briefs-submitted-item"' not in html:
        result=entries(url,[])
        result['coverage']={'status':'publisher-omits-submissions-section','studyTitle':title}
        result['terminalPage']={'kind':'house-study-page','exhausted':True,'emptyListReason':'submissions section absent'}
        return result
    if not match:
        raise ValueError('House brief list is advertised without a data link')
    source = urljoin(url,match[1])
    briefs = []
    for item in tree(get(source)).findall(lambda n: cls(n,'brief-item')):
        author = item.find(lambda n: cls(n,'name'))
        for a in anchors(item):
            if cls(a,'btn-brief'):
                briefs.append(dict(pub(a,source,'submission'),submitter=author.text() if author else None,
                                   studyUrl=url,studyId=re.search(r'studyActivityId=(\d+)',url,re.I).group(1),
                                   studyTitle=title,sourceIndexUrl=source))
    return entries(source,briefs)


def senate_index(c, lang, section):
    slug = {'briefs':('briefs','memoires'),'studies':('studiesandbills','etudesetprojetsdeloi'),
            'meetings':('meetingschedule','horairereunions'),'reports':('reports','rapports')}[section][lang=='fr']
    url = c['url'].rsplit('/',1)[0] + '/' + slug + '/45-1'
    html = get(url)
    if '<html' not in html.lower() or 'data-ajaxpartial-action' not in html:
        raise ValueError('Senate index response was not a recognized committee table page')
    page = tree(html)
    action = 'GetCommitteeReports' if section == 'reports' else 'GetTablePartialView'
    tables = page.findall(lambda n: n.attrs.get('data-ajaxpartial-action')==action)
    if not tables:
        raise ValueError('Senate page has no published table descriptor')
    records = []
    related_order_references = []
    table_args = [json.loads(t.attrs['data-ajaxpartial-data']) for t in tables]
    if section == 'reports':
        for args in table_args:
            source=SENATE_AJAX+'GetCommitteeReports?'+urlencode(dict(args,Lang=lang,Session='45-1'))
            response=get(source); root=tree(response)
            if root.find(lambda n:cls(n,'sc-committee-reports')) is None:
                raise ValueError('Senate report Ajax response missing its report list container')
            prior_report=None
            for node in root.walk():
                if node.tag=='li' and cls(node,'cmt-li-list-report'):
                    report_link=next((a for a in anchors(node) if re.search(r'/(?:report|rapport)/',a.attrs['href'],re.I)),None)
                    if report_link:
                        prior_report=pub(report_link,source,'report')
                        prior_report.update({'committeeCode':c['code'],'language':lang,'section':section,
                                             'sourceIndexUrl':url,'reportUrl':prior_report['url']})
                        records.append(prior_report)
                elif node.tag=='li' and cls(node,'cmt-ul-list-report-2'):
                    for a in anchors(node):
                        if any(term in (a.text()+' '+a.attrs.get('title','')).lower()
                               for term in ('government response','réponse du gouvernement','réponse gouvernementale')):
                            response_link=pub(a,source,'publication')
                            response_link.update({'reportUrl':prior_report['url'] if prior_report else None,
                                                  'reportId':prior_report.get('reportId') if prior_report else None,
                                                  'committeeCode':c['code'],'language':lang,'section':section,
                                                  'sourceIndexUrl':url,'sourceContext':'Government response'})
                            records.append(response_link)
        result=entries(url,records)
        result['terminalPage']={'kind':'senate-report-list','exhausted':True,'sourceAction':'GetCommitteeReports'}
        result['sourceTotals']={'reportedLinks':len(records),'uniqueLinks':len(result['links'])}
        return result
    if section == 'meetings':
        table_args = [dict(args,TabSelected=tab) for args in table_args for tab in ('PAST','UPCOMING')]
    seen_pages = set()
    terminal = []
    for group_number,args in enumerate(table_args,1):
        page_args=dict(args,Lang=lang,Session='45-1')
        page_number=1
        visited=set()
        page_count=0
        while True:
            source=SENATE_AJAX+'GetTablePartialView?'+urlencode(page_args)
            response=get(source)
            signature=re.sub(r'\s+',' ',response).strip()
            if signature in seen_pages or signature in visited:
                raise ValueError(f'Repeated Senate table page: {source}')
            visited.add(signature); seen_pages.add(signature)
            root=tree(response)
            table=root.find(lambda n:n.attrs.get('id')=='table-print')
            if table is None:
                raise ValueError('Senate table response missing its record container')
            page_count+=1
            row_count=len(table.findall(lambda n:n.tag=='tr'))
            nav=root.find(lambda n:cls(n,'sen-pagination'))
            next_pages={}
            if nav:
                for a in anchors(nav):
                    fragment=a.attrs['href'].split('#?',1)[-1]
                    query=parse_qs(fragment)
                    number=int(query.get('p',['1'])[0])
                    if number>page_number: next_pages[number]={k:v[-1] for k,v in query.items()}
            terminal.append({'group':group_number,'url':source,'rows':row_count,'pageNumber':page_number,
                             'publisherPageCount':max([page_number,*next_pages.keys()]),'exhausted':not next_pages})
            if section == 'briefs':
                study = order_url = current_order_id = current_order_code = None
                for node in table.walk():
                    if cls(node,'cmt-site_v2-briefs-table-brief-name-label'):
                        study = node.text(); order_url = current_order_id = current_order_code = None
                    if cls(node,'cmt-site_v2-studybills-table-study-item-oof') or cls(node,'cmt-site_v2-briefs-table-brief-oor'):
                        order_anchor=next(iter(anchors(node)),None)
                        order_url=urljoin(source,order_anchor.attrs['href']) if order_anchor else None
                        order_ref=order_anchor.attrs['href'] if order_anchor else ''
                        numeric=re.search(r'OrderOfReferenceID=(\d+)',order_ref,re.I)
                        code=re.search(r'-(C|S|SS)-(\d+)-[ef]$',order_url or '',re.I)
                        current_order_id=numeric.group(1) if numeric else None
                        current_order_code=f'{code.group(1).upper()}-{code.group(2)}' if code else None
                    if node.tag=='tr':
                        cells=[child for child in node.children if child.tag=='td']
                        if len(cells)>=5:
                            for a in anchors(cells[-1]):
                                records.append(dict(pub(a,source,'submission'),study=study,
                                                    organization=cells[0].text(),submitter=cells[1].text(),received=cells[3].text(),
                                                    committeeCode=c['code'],language=lang,section=section,sourceIndexUrl=url,
                                                    studyId=current_order_id or current_order_code,
                                                    orderOfReferenceId=current_order_id or current_order_code,
                                                    orderOfReferenceCode=current_order_code,studyUrl=order_url))
            elif section=='studies':
                groups=table.findall(lambda n:cls(n,'cmt-site_v2-studybills-table-study-item'))
                for study_group in groups:
                    heading=study_group.find(lambda n:n.tag=='h3' and cls(n,'cmt-site_v2-studybills-table-study-item-name'))
                    study_title=heading.text() if heading else None
                    order_id=None
                    for node in study_group.walk():
                        for value in node.attrs.values():
                            match=re.search(r'id-study-(\d+)',value,re.I) or re.search(r'OrderOfReferenceID=(\d+)',value,re.I)
                            if match: order_id=match.group(1); break
                        if order_id: break
                    group_study=None; group_code=None
                    for a in anchors(study_group):
                        href=a.attrs['href']
                        if 'briefs and other documents' in a.text().lower() or 'mémoires et autres documents' in a.text().lower():
                            query=parse_qs(href.split('#?',1)[-1])
                            numeric=query.get('OrderOfReferenceID',[])
                            if numeric:
                                related_order_references.append({'orderOfReferenceId':numeric[0],
                                    'url':urljoin(source,href),'title':a.text(),
                                    'studyTitle':study_title,'sourceContext':study_title})
                        if group_study is None and '/content/sen/committee/' in href.lower() and pub(a,source,section)['kind']=='study':
                            group_study=urljoin(source,href)
                            match=re.search(r'-(C|S|SS)-(\d+)-[ef]$',href,re.I)
                            group_code=f'{match.group(1).upper()}-{match.group(2)}' if match else None
                    for a in anchors(study_group):
                        item=pub(a,source,section)
                        if item['kind'] not in ('study','report','government-response','evidence','minutes','notice','meeting'):
                            continue
                        item.update({'committeeCode':c['code'],'language':lang,'section':section,'sourceIndexUrl':url,
                                     'studyTitle':study_title,'sourceContext':study_title,
                                     'studyId':order_id or item.get('studyId') or group_code,
                                     'orderOfReferenceId':order_id or group_code,
                                     'orderOfReferenceCode':group_code,'studyUrl':group_study})
                        if item['kind']=='study': item['studyUrl']=item['url']
                        if item['kind']=='notice': item['meetingUrl']=item['url']
                        records.append(item)
                if not groups:
                    self_contained=[]
                    for a in anchors(table):
                        href=a.attrs['href'].lower()
                        if '/content/sen/committee/' in href or re.search(r'/(?:report|rapport)/\d+/45-1',href):
                            item=pub(a,source,section)
                            item.update({'committeeCode':c['code'],'language':lang,'section':section,'sourceIndexUrl':url})
                            self_contained.append(item)
                    records.extend(self_contained)
            else:
                rows=table.findall(lambda n:n.tag=='tr')
                if not rows: rows=[table]
                for row in rows:
                    row_anchors=anchors(row)
                    notice=next((a for a in row_anchors if pub(a,source,section)['kind']=='notice'),None)
                    notice_item=pub(notice,source,section) if notice else None
                    for a in row_anchors:
                        href=a.attrs['href']; lower=href.lower()
                        published_record=('/content/sen/committee/' in lower or
                                          bool(re.search(r'/(?:noticeofmeeting|avisdeconvocation)/\d+/45-1',lower)))
                        if not href.startswith('/') or not published_record: continue
                        item=pub(a,source,section)
                        item.update({'committeeCode':c['code'],'language':lang,'section':section,'sourceIndexUrl':url,
                                     'meetingUrl':notice_item['url'] if notice_item else None,
                                     'meetingId':notice_item.get('meetingId') if notice_item else item.get('meetingId')})
                        records.append(item)
            if not next_pages: break
            page_number=min(next_pages)
            page_args.update(next_pages[page_number])
    result = entries(url,records)
    if section=='studies' and related_order_references:
        result['relatedOrderReferences']=related_order_references
    result['terminalPage'] = {'kind':'senate-ajax-table',
                              'exhausted':all(any(x['group']==n and x['exhausted'] for x in terminal)
                                              for n in range(1,len(table_args)+1)),
                              'pages':terminal}
    result['sourceTotals'] = {'renderedRows':sum(x['rows'] for x in terminal),'uniqueLinks':len(result['links'])}
    if section == 'meetings': result['meetingTabs']=['PAST','UPCOMING']
    return result


def is_senate_notice_index(key):
    return key.startswith('senate/') and '/notice/' in key


def is_senate_meetings_index(key):
    return key.startswith('senate/') and key.endswith('/meetings')


def can_reuse_index(key, indexes, refresh_senate_notices=False):
    return (key in indexes and 'error' not in indexes[key]
            and not (refresh_senate_notices and (is_senate_meetings_index(key) or is_senate_notice_index(key))))


def remove_old_senate_notice_indexes(indexes):
    stale = [key for key in indexes if is_senate_notice_index(key)]
    for key in stale:
        del indexes[key]
    return len(stale)


def refresh_senate_notice_sources(notices, cache_root, workers=5):
    urls = sorted({notice['url'] for notice in notices})
    approved = [url for url in urls if official(url)]
    if approved:
        # This shared capture path archives original bytes and validates redirects.
        capture(cache_root, approved, workers, refresh=True)
    return urls


def senate_notice(notice, require_fresh=False):
    """Follow published transcript, minutes, report and study links on a notice."""
    url=notice['url']
    if require_fresh and not official(url):
        raise ValueError('Senate meeting notice is outside the official publication host allowlist')
    cache_root=Path(__file__).resolve().parents[1]/'data/corpus/committees'
    db_path=cache_root/'downloads.sqlite'
    body=None
    source_fetched_at=None
    source_hash=None
    if db_path.is_file():
        with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            row=db.execute('SELECT digest,media,error,checked FROM files WHERE url=?',(url,)).fetchone()
        if row and row[0] and row[1]=='text/html' and not row[2]:
            from lib.committee_files import read_object
            body=read_object(cache_root,row[0])
            source_hash=row[0]
            source_fetched_at=row[3]
    if require_fresh and body is None:
        raise RuntimeError('Refreshed Senate notice original is unavailable; refusing to parse a prior cached copy')
    html=body.decode('utf-8-sig',errors='replace') if body is not None else get(url)
    if source_fetched_at is None: source_fetched_at=now()
    if '<html' not in html.lower() or '45' not in html:
        raise ValueError('Senate meeting notice response was not recognized')
    page=tree(html)
    links=[]
    notice_id=re.search(r'/(?:noticeofmeeting|avisdeconvocation)/(\d+)',url,re.I)
    for a in anchors(page):
        href=a.attrs['href']
        label=' '.join((a.attrs.get('title') or '',a.text())).strip()
        if '/content/sen/committee/' not in href.lower() and '/content/sen/committee/' not in href.lower():
            continue
        item=pub(a,url,'publication')
        item.update({'noticeUrl':url,'meetingUrl':url,'meetingId':notice.get('meetingId') or (notice_id.group(1) if notice_id else None),
                     'sourceContext':label or notice.get('title'),'committeeCode':notice.get('committeeCode'),
                     'language':notice.get('language'),'sourceIndexUrl':notice.get('sourceIndexUrl'),
                     'sourceFetchedAt':source_fetched_at,
                     'sourceSha256':source_hash,
                     'sourceCapture':'hash-verified local original' if body is not None else 'live fetch'})
        if item.get('kind')=='study': item['studyUrl']=item['url']
        links.append(item)
    result=entries(url,links)
    result['sourceFetchedAt']=source_fetched_at
    result['sourceSha256']=source_hash
    result['sourceCapture']='hash-verified local original' if body is not None else 'live fetch'
    result['sourceTotals']={'linkedSourceUrls':len(result['links'])}
    result['terminalPage']={'kind':'senate-notice-links','exhausted':True,'publisherLinksInspected':True}
    result['coverage']={'linkedPublications':bool(links),'unlinkedEvidence':'not-linked' if not any(x['kind']=='evidence' for x in links) else None,
                        'unlinkedMinutes':'not-linked' if not any(x['kind']=='minutes' for x in links) else None}
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=Path('data/corpus/committees/catalogue.json'))
    p.add_argument('--workers',type=int,choices=range(1,13),default=5)
    p.add_argument('--resume',action='store_true', help='Reuse completed indexes from the same local acquisition.')
    p.add_argument('--chamber',choices=('house','senate'),help='Acquire one chamber independently.')
    p.add_argument('--merge-existing',action='store_true',help='Preserve the other chamber from the current output while acquiring --chamber.')
    p.add_argument('--finalize',action='store_true',help='Publish the complete merged partial catalogue atomically.')
    p.add_argument('--verify-empty-studies',action='store_true',help='Revalidate empty House study lists using the official study-page sentinel.')
    p.add_argument('--verify-empty-studies-from-cache',action='store_true',help='Validate empty House lists from hash-checked official page originals.')
    p.add_argument('--refresh-senate-notices',action='store_true',
                   help='Refresh official Senate notice originals before parsing their linked publications.')
    a = p.parse_args()
    partial = a.output.with_name(a.output.stem + '.partial' + a.output.suffix)
    if a.verify_empty_studies or a.verify_empty_studies_from_cache:
        source_path=partial if partial.exists() else a.output
        data=json.loads(source_path.read_text()); indexes=data['indexes']
        studies={r['url'] for page in indexes.values() for r in page.get('links',[])
                 if r.get('kind')=='study' and re.search(r'/StudyActivity\?studyActivityId=\d+',r.get('url',''),re.I)}
        todo=sorted(url for url in studies if not indexes.get(url,{}).get('links') and
                     ('error' not in indexes.get(url,{}) or 'published study title' in indexes.get(url,{}).get('error','')))
        if a.verify_empty_studies_from_cache:
            cache_root=Path(__file__).resolve().parents[1]/'data/corpus/committees'
            from lib.committee_files import read_object
            with closing(sqlite3.connect((cache_root/'downloads.sqlite').resolve().as_uri() + '?mode=ro', uri=True)) as db:
                cached={row[0]:row[1:] for row in db.execute("SELECT url,digest,media,error,checked FROM files WHERE media='text/html'")}
            for url in todo:
                row=cached.get(url)
                if not row or not row[0] or row[1]!='text/html' or row[2]:
                    indexes[url]={'error':'StudyActivity page has no verified cached original; live recheck required'}
                    continue
                body=read_object(cache_root,row[0]); html=body.decode('utf-8-sig',errors='replace'); page=tree(html)
                title=house_study_title(page)
                if title is None:
                    indexes[url]={'error':'Cached source missing published study title'}
                    continue
                status='publisher-omits-submissions-section' if 'id="briefs-submitted-item"' not in html else 'submission-section-needs-live-list-check'
                current=indexes[url]
                current.pop('error',None)
                current['coverage']={'status':status,'studyTitle':title,'sourceFetchedAt':row[3]}
                current['terminalPage']={'kind':'house-study-page','exhausted':status=='publisher-omits-submissions-section',
                                         'emptyListReason':'submissions section absent' if status=='publisher-omits-submissions-section' else None}
            data['observedAt']=now(); data['indexes']=indexes
            observations=data.setdefault('sourceObservations',{})
            observations.setdefault('house',{})['emptyStudyCacheValidationAt']=data['observedAt']
            notice_count=0
            for key,value in indexes.items():
                if not (key.startswith('senate/') and '/notice/' in key): continue
                original=cached.get(value.get('url'))
                if not original or not original[0] or original[1]!='text/html' or original[2]:
                    value['sourceCacheStatus']='original-not-cached'
                    continue
                checked=original[3]
                value['sourceFetchedAt']=checked
                value['sourceCapture']='hash-verified local original'
                for link in value.get('links',[]):
                    link['sourceFetchedAt']=checked
                    link['sourceCapture']='hash-verified local original'
                notice_count+=1
            observations.setdefault('senate',{})['noticeOriginalsValidatedAt']=data['observedAt']
            save_atomic(partial,data)
            print(json.dumps({'emptyStudiesValidatedFromCache':len(todo),'remainingErrors':sum('error' in indexes.get(url,{}) for url in todo),
                              'sourceSectionChecks':Counter(indexes[url].get('coverage',{}).get('status') for url in todo),
                              'senateNoticeOriginalsValidated':notice_count}))
            return
        def verify(url):
            try: return house_briefs({'url':url})
            except (RuntimeError,OSError,ValueError) as exc: return {'error':str(exc)}
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            for i,(url,result) in enumerate(zip(todo,pool.map(verify,todo)),1):
                indexes[url]=result
                if i%100==0:
                    data['observedAt']=now(); data['indexes']=indexes
                    save_atomic(partial,data); print(f'{i}/{len(todo)} empty studies verified',flush=True)
        data['observedAt']=now(); data['indexes']=indexes
        data.setdefault('sourceObservations',{}).setdefault('house',{})['emptyStudyRevalidationAt']=data['observedAt']
        save_atomic(partial,data)
        print(json.dumps({'emptyStudiesRevalidated':len(todo),'remainingErrors':sum('error' in indexes.get(url,{}) for url in todo)}))
        return
    previous = load_resume_checkpoint(partial) if a.resume else (
        json.loads((partial if partial.exists() else a.output).read_text()) if a.merge_existing else None)
    inventory = []
    chambers = (a.chamber,) if a.chamber else ('house','senate')
    if previous and a.resume:
        inventory=previous.get('committees',[])
    else:
        for chamber in chambers:
            for lang in ('en','fr'):
                group = directories(chamber,lang)
                if not group or len({x['code'] for x in group}) != len(group):
                    raise RuntimeError(f'Empty or duplicate {chamber} {lang} directory')
                inventory.extend(dict(c,chamber=chamber,language=lang) for c in group)
    if previous and a.chamber and not a.resume:
        inventory = [x for x in previous.get('committees',[]) if x.get('chamber') != a.chamber] + inventory
    indexes = dict(previous.get('indexes',{})) if previous else {}
    if a.chamber and not a.resume:
        indexes = {k:v for k,v in indexes.items() if not k.startswith(a.chamber + '/') and not
                   (a.chamber == 'house' and (k.startswith('https://www.ourcommons.ca/') or k.startswith('https://www.parl.ca/committees/')))}
    observations = dict(previous.get('sourceObservations',{})) if previous else {}
    if previous and a.chamber:
        for other in ('house','senate'):
            if other != a.chamber and other not in observations:
                observations[other]={'status':'retained-previous-snapshot','observedAt':previous.get('observedAt'),
                                    'note':'Inherited from existing catalogue; not rechecked in this chamber-only run.'}
    def checkpoint():
        observed = now()
        if a.chamber:
            observations[a.chamber] = {'status':'live-indexed','observedAt':observed}
        save_atomic(partial,{'session':'45-1','observedAt':observed,'scope':'published index links',
                             'completed':False,'sourceObservations':observations,'committees':inventory,'indexes':indexes})
    def process(task):
        key,fn,args = task
        if can_reuse_index(key, indexes, a.refresh_senate_notices):
            return key,indexes[key]
        try:
            return key,fn(*args)
        except (RuntimeError, OSError, ValueError) as exc:
            return key,{'error':str(exc)}
    def run(batch):
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            for i,(key,payload) in enumerate(pool.map(process,batch),1):
                indexes[key] = payload
                if i % 100 == 0:
                    checkpoint()
                    print(f'{i}/{len(batch)} indexes',flush=True)
        checkpoint()
    jobs = []
    joint = {(c['code'],c['language']):c for c in inventory if c['chamber']=='house' and c['url'].startswith('https://www.parl.ca/')}
    for c in inventory:
        lang = c['language']
        if a.chamber and c['chamber'] != a.chamber:
            continue
        if c['chamber'] == 'senate' and (c['code'],lang) in joint:
            c['jointPublicationDirectory'] = joint[c['code'],lang]['url']
            continue
        house = c['chamber']=='house'
        for section in (('Work','Meetings') if house else ('studies','meetings','briefs','reports')):
            jobs.append((f'{c["chamber"]}/{lang}/{c["code"]}/{section}',house_index if house else senate_index,(c,lang,section)))
    run(jobs)
    studies = {}
    if not a.chamber or a.chamber=='house':
        studies = {record['url']:record for v in indexes.values() for record in v.get('links',[])
                   if record.get('kind')=='study' and
                   record.get('url','').startswith(('https://www.ourcommons.ca/committees/','https://www.parl.ca/committees/')) and
                   re.search(r'/StudyActivity\?studyActivityId=\d+',record.get('url',''),re.I)}
    run([(url,house_briefs,(r,)) for url,r in studies.items()])
    if a.refresh_senate_notices and (not a.chamber or a.chamber=='senate'):
        remove_old_senate_notice_indexes(indexes)
    notices = {r['url']:r for k,v in indexes.items() if (not a.chamber or a.chamber=='senate') and k.startswith('senate/') and k.endswith('/meetings')
               for r in v.get('links',[]) if r.get('kind')=='notice'}
    if a.refresh_senate_notices and (not a.chamber or a.chamber=='senate'):
        cache_root=Path(__file__).resolve().parents[1]/'data/corpus/committees'
        observations.setdefault('senate',{})['noticeOriginalRefreshAttemptedAt']=now()
        checkpoint()
        refresh_senate_notice_sources(notices.values(),cache_root,a.workers)
    run([(f'senate/{r.get("language","en")}/{r.get("committeeCode","unknown")}/notice/{re.search(r"(?:noticeofmeeting|avisdeconvocation)/(\\d+)",url,re.I).group(1) if re.search(r"(?:noticeofmeeting|avisdeconvocation)/(\\d+)",url,re.I) else url}',
          senate_notice,(r,a.refresh_senate_notices)) for url,r in notices.items()])
    if not a.chamber or a.finalize:
        data = json.loads(partial.read_text())
        data['completed'] = True
        data['observedAt'] = now()
        save_atomic(partial,data)
        os.replace(partial,a.output)
    print(json.dumps({'directoryEditions':len(inventory),'indexes':len(indexes),'failedIndexes':sum('error' in v for v in indexes.values()),
                      'linkedRecordOccurrences':Counter(r['kind'] for v in indexes.values() for r in v.get('links',[]))}))


if __name__=='__main__':
    main()
