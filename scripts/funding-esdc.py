"""Acquire the published bilingual ESDC funding-programme catalogue."""
from __future__ import annotations

from hashlib import sha256
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter, defaultdict
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse, urldefrag, unquote
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.wq_catalog import cls, tree
from lib.funding_intake import acquire

EN = 'https://www.canada.ca/en/employment-social-development/services/funding/programs.html'
FR = 'https://www.canada.ca/fr/emploi-developpement-social/services/financement/programmes.html'
INDEXES = {'en': EN, 'fr': FR}

def text(node):
    return node.text().strip() if node else ''


def slug(value):
    value = value.lower().replace('&', ' and ')
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', value)).strip('-') or 'program'


def list_cards(markup, language):
    root = tree(markup.decode('utf-8-sig', 'replace') if isinstance(markup, bytes) else markup)
    cards = root.findall(lambda n: cls(n, 'tagfilter-item'))
    if not cards:
        raise ValueError(f'{language} index did not contain recognized funding cards')
    audience_labels = {}
    for label in root.findall(lambda n:n.tag=='label'):
        input_node = label.find(lambda n:n.tag=='input' and n.attrs.get('name')=='audience' and n.attrs.get('value','').startswith('apply-'))
        if input_node:
            audience_labels[input_node.attrs['value']] = re.sub(r'\s+',' ', text(label).replace(input_node.attrs.get('value',''), '')).strip()
    out = []
    for card in cards:
        title_link = card.find(lambda n: n.tag == 'a' and n.attrs.get('href'))
        if not title_link:
            raise ValueError(f'{language} recognized funding card is missing its title link')
        grouping = card.find(lambda n: n.tag == 'h4')
        intro = card.find(lambda n: n.tag == 'p' and 'h4' not in n.attrs.get('class', '').split())
        # The title paragraph is the first .h4 paragraph, while the summary is the
        # following ordinary paragraph. Select it by element order to avoid confusing
        # the emphasized amount panel with programme copy.
        ps = card.findall(lambda n: n.tag == 'p')
        overview_node = next((p for p in ps if 'h4' not in p.attrs.get('class', '').split()
                              and p is not intro), None)
        # In current markup the first ordinary paragraph after the title is overview.
        title_p = title_link.parent
        seen_title = False
        for p in ps:
            if p is title_p:
                seen_title = True
                continue
            if seen_title and p.find(lambda n: n.tag == 'a') is None:
                overview_node = p
                break
        url = urljoin(INDEXES[language], title_link.attrs['href'])
        tags = card.attrs.get('data-wb-tags', '').split()
        status_node = card.find(lambda n: n.tag == 'li' and ('text-success' in n.attrs.get('class','').split() or 'text-danger' in n.attrs.get('class','').split()))
        status_text = text(status_node)
        if 'open' in tags and ('apply-esdc' in tags or 'invitation' in status_text.lower()):
            status = 'invitation-only'
        elif 'open' in tags:
            status = 'open'
        elif 'closed' in tags:
            status = 'closed'
        elif 'upcoming' in tags:
            status = 'upcoming'
        else:
            status = 'unknown'
        if (('continuous' in tags or re.search(r'continuous\s+intake|apport\s+continu|processus d’application continu',status_text,re.I))
                and status == 'open'):
            status = 'ongoing'
        audience = [audience_labels[tag] for tag in tags if tag in audience_labels]
        amount = card.find(lambda n: cls(n, 'bg-info'))
        row = {'language':language,'title':text(title_link),'url':url,'group':text(grouping) or None,
               'overview':text(overview_node) or None,'amount':text(amount) or None,
               'status':status,'statusText':status_text or None,'audience':audience,
               'process':[tag.removeprefix('process-') for tag in tags if tag.startswith('process-')],
               'tags':tags}
        out.append(row)
    return out


def normalized_url(url):
    parsed = urlparse(url)
    host = parsed.netloc.lower().removeprefix('www.')
    path = re.sub(r'/{2,}', '/', parsed.path)
    return (host, path.rstrip('/').lower(), parsed.query.lower())


def is_government_url(url):
    host = urlparse(url).hostname or ''
    return host == 'canada.ca' or host.endswith(('.canada.ca','.gc.ca'))


def record_id_base(row):
    path = unquote(urlparse(row['url']).path.rstrip('/').split('/')[-1])
    stem = re.sub(r'\.html?$', '', path, flags=re.I)
    return slug(stem or row['title'])


def language_alternates(markup, base_url):
    root = tree(markup.decode('utf-8-sig','replace') if isinstance(markup,bytes) else markup)
    alternates = {}
    for node in root.walk():
        if node.tag == 'link' and node.attrs.get('hreflang') in ('en','fr') and node.attrs.get('href'):
            alternates[node.attrs['hreflang']] = urljoin(base_url,node.attrs['href'])
        elif node.tag == 'a' and node.attrs.get('lang') in ('en','fr') and node.attrs.get('href'):
            alternates[node.attrs['lang']] = urljoin(base_url,node.attrs['href'])
    return alternates


def content_language(markup):
    root = tree(markup.decode('utf-8-sig','replace') if isinstance(markup,bytes) else markup)
    node = root.find(lambda n:n.tag=='html')
    value = (node.attrs.get('lang') or '').strip().lower() if node else ''
    if value.startswith('en'): return 'en'
    if value.startswith('fr'): return 'fr'
    return None


def localized_body(body, url, language, fetch, cache):
    """Accept source text only when its declared language matches the record."""
    declared = content_language(body)
    if declared is None or declared == language:
        return body, url, None
    alternate = language_alternates(body,url).get(language)
    if not alternate or not is_government_url(alternate):
        return None, url, f'detail-page-language-mismatch-declared-{declared}-no-verified-{language}-alternate'
    try:
        translated = cache.get(alternate)
        if translated is None:
            translated = fetch(alternate)
            cache[alternate] = translated
    except Exception as exc:
        return None, alternate, error_kind(exc)
    translated_language = content_language(translated)
    if translated_language and translated_language != language:
        return None, alternate, f'detail-page-language-mismatch-declared-{translated_language}-on-publisher-alternate'
    return translated, alternate, None


def actionable_links(markup, base_url):
    """Return same-program eligibility/application links from a Canada.ca page."""
    root = tree(markup.decode('utf-8-sig','replace') if isinstance(markup,bytes) else markup)
    marker = root.find(lambda n:n.attrs.get('id')=='wb-cont')
    main = next((n for n in ancestors(marker) if n.tag=='main'),None) if marker else None
    main = main or root
    wanted = ('qualify','eligib','who can','applicant','apply','présenter une demande','admissib','qui peut présenter',
              'what this program offers','what this funding opportunity offers','what this funding offers',
              'ce qu’offre le programme','ce qu’offre cette possibilité de financement',"ce qu'offre le programme")
    base_path = urlparse(base_url).path
    stem = re.sub(r'\.html?$', '', base_path, flags=re.I).rstrip('/')
    accepted, external = [], []
    for link in main.findall(lambda n:n.tag=='a' and n.attrs.get('href')):
        if not any(term in text(link).lower() for term in wanted):
            continue
        target = urldefrag(urljoin(base_url,link.attrs['href']))[0]
        if target == base_url or target in accepted: continue
        target_path = urlparse(target).path
        if not target_path.startswith(stem): continue
        if not is_government_url(target):
            external.append(target)
        else:
            accepted.append(target)
    return accepted, external


def detail_sections(markup, url, language):
    """Extract headed substantive text from an official program application page."""
    root = tree(markup.decode('utf-8-sig', 'replace') if isinstance(markup, bytes) else markup)
    declared = content_language(markup)
    if declared and declared != language:
        return []
    marker = root.find(lambda n: n.attrs.get('id') == 'wb-cont')
    main = next((n for n in ancestors(marker) if n.tag=='main'),None) if marker else None
    main = main or (root.find(lambda n: n.attrs.get('id') == 'content') or root)
    sections = []
    headings = main.findall(lambda n: n.tag in ('h1','h2','h3','h4'))
    for heading in headings:
        name = text(heading)
        if not name or name.lower() in ('on this page','sur cette page','document navigation','navigation du document'):
            continue
        # Collect paragraphs/list items until the next heading in document order.
        content = []
        active = False
        for node in main.walk():
            if node is heading:
                active = True
                continue
            if active and node.tag in ('h1','h2','h3','h4'):
                break
            if active and node.tag in ('p','li'):
                value = text(node)
                if value and value not in content:
                    content.append(value)
        body = ' '.join(content)
        if not body:
            continue
        lower = name.lower()
        if heading.tag == 'h1':
            field = 'overview'
        elif any(x in lower for x in ('eligib','who can','applicant','admissib','qui peut','demandeur')):
            field = 'eligibility'
        elif any(x in lower for x in ('partner','partenaire')):
            field = 'partners'
        elif any(x in lower for x in ('amount','funding','montant','financement','grant','bonus')):
            field = 'amount'
        elif any(x in lower for x in ('deadline','date limite','important dates','dates importantes','when to apply','présenter une demande')):
            field = 'deadline'
        else:
            field = 'other'
        sections.append({'field':field,'heading':name,'text':body,'url':url})
    # Canada.ca funding summaries publish their key facts in a definition list.
    for dl in main.findall(lambda n:n.tag=='dl' and not any(p.tag=='nav' and 'gc-subway' in p.attrs.get('class','').split() for p in ancestors(n))):
        children = dl.children
        for pos,node in enumerate(children):
            if node.tag != 'dt':
                continue
            value = next((child for child in children[pos+1:] if child.tag == 'dd'),None)
            if value is None:
                continue
            label, body = text(node).rstrip(':').strip(), text(value)
            low = label.lower()
            if any(x in low for x in ('who can apply','qui peut présenter','qui peut demander')):
                field = 'eligibility'
            elif any(x in low for x in ('funding amount','montant du financement')):
                field = 'amount'
            elif any(x in low for x in ('application period','période de présentation','période de demande')):
                field = 'status'
            else:
                field = 'other'
            sections.append({'field':field,'heading':label,'text':body,'url':url})
    return sections


def ancestors(node):
    while node:
        yield node
        node = node.parent


def error_kind(exc):
    if isinstance(exc, HTTPError):
        if exc.code in (404,410):
            return f'confirmed-detail-http-{exc.code}'
        if exc.code in (408,429,500,502,503,504):
            return f'transient-detail-http-{exc.code}'
        return f'detail-http-{exc.code}-unclassified'
    return f'transient-detail-fetch-failure: {type(exc).__name__}: {exc}'


def edition_ids(rows, bodies):
    """Pair only one-to-one catalogue calls connected by a publisher language link."""
    aliases = {'en': defaultdict(set), 'fr': defaultdict(set)}
    peers = {}
    counts = Counter((lang, record_id_base(row)) for lang, row in rows)
    titles = Counter((lang, record_id_base(row), slug(row['title'])) for lang, row in rows)
    identifiers = {}
    issued = set()
    for i, (lang, row) in enumerate(rows):
        url = row['url']
        base = record_id_base(row)
        if counts[lang, base] > 1:
            base += '-' + slug(row['title'])
        identifier = ('esdc-' if lang == 'en' else 'esdc-fr-') + base
        if titles[lang, record_id_base(row), slug(row['title'])] > 1:
            discriminator = url + '\n' + (row['group'] or '')
            identifier += '-' + sha256(discriminator.encode()).hexdigest()[:12]
        if identifier in issued:
            raise ValueError(f'Duplicate catalogue call without a distinguishable source identifier: {url}')
        issued.add(identifier)
        identifiers[lang, i] = identifier
        aliases[lang][normalized_url(url)].add(i)
        if url not in bodies:
            continue
        body = bodies[url]
        page_language = re.search(rb'<html\b[^>]*\blang=["\x27]([a-z]{2})', body, re.I)
        if page_language and page_language[1].decode().lower() != lang:
            continue
        links = language_alternates(body, url)
        if lang in links and is_government_url(links[lang]):
            aliases[lang][normalized_url(links[lang])].add(i)
        other = 'fr' if lang == 'en' else 'en'
        if other in links and is_government_url(links[other]):
            peers[i] = normalized_url(links[other])

    candidates = defaultdict(set)
    for i, target in peers.items():
        lang = rows[i][0]
        other = 'fr' if lang == 'en' else 'en'
        for j in aliases[other][target]:
            candidates[i].add(j)
            candidates[j].add(i)
    paired = set()
    for i, (lang, _) in enumerate(rows):
        if lang == 'en' and len(candidates[i]) == 1:
            j, = candidates[i]
            if candidates[j] == {i}:
                identifiers['fr', j] = identifiers['en', i]
                paired.update((i, j))
    gaps = []
    for i, (lang, row) in enumerate(rows):
        if i not in paired:
            other = 'fr' if lang == 'en' else 'en'
            gaps.append({'id': identifiers[lang, i], 'language': other,
                         'url': row['url'] if is_government_url(row['url']) else INDEXES[lang],
                         'reason': 'No unique counterpart established from the independently listed calls and publisher language links.'})
    return identifiers, gaps


def collect(fetch):
    pages, records, gaps, raw_pages = {}, [], [], {}
    for language, index in INDEXES.items():
        try:
            raw_pages[language] = fetch(index)
            pages[language] = list_cards(raw_pages[language], language)
        except Exception as exc:
            raise RuntimeError(f'Could not inventory official {language} index {index}: {exc}') from exc
    all_rows = [(language,row) for language in ('en','fr') for row in pages[language]]
    detail_urls = sorted({row['url'] for _,row in all_rows if is_government_url(row['url'])})
    detail_bodies, detail_errors = {}, {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch,url):url for url in detail_urls}
        for future in as_completed(futures):
            url = futures[future]
            try: detail_bodies[url] = future.result()
            except Exception as exc: detail_errors[url] = exc

    # Stage linked eligibility/application pages and explicit translated alternates
    # across all records, then fetch them with the same bounded concurrency.
    subpage_urls, external_actions = set(), defaultdict(set)
    for language,row in all_rows:
        body = detail_bodies.get(row['url'])
        if body is None: continue
        declared = content_language(body)
        if declared and declared != language:
            alternate = language_alternates(body,row['url']).get(language)
            if alternate and is_government_url(alternate): subpage_urls.add(alternate)
        links, external = actionable_links(body,row['url'])
        subpage_urls.update(links)
        external_actions[(language,row['url'])].update(external)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch,url):url for url in sorted(subpage_urls - detail_bodies.keys() - detail_errors.keys())}
        for future in as_completed(futures):
            url = futures[future]
            try: detail_bodies[url] = future.result()
            except Exception as exc: detail_errors[url] = exc
    nested_urls = set()
    for url,body in detail_bodies.items():
        if not is_government_url(url): continue
        links,_ = actionable_links(body,url)
        nested_urls.update(links)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch,url):url for url in sorted(nested_urls - detail_bodies.keys() - detail_errors.keys())}
        for future in as_completed(futures):
            url = futures[future]
            try: detail_bodies[url] = future.result()
            except Exception as exc: detail_errors[url] = exc

    ids, pairing_gaps = edition_ids(all_rows, detail_bodies)
    gaps.extend(pairing_gaps)

    resolved_details = {}
    detail_destination_counts = Counter()
    for i,(language,row) in enumerate(all_rows):
        body = detail_bodies.get(row['url'])
        if body is not None:
            body, detail_url, problem = localized_body(body,row['url'],language,fetch,detail_bodies)
        else:
            detail_url, problem = row['url'], None
        resolved_details[i] = (body,detail_url,problem)
        detail_destination_counts[(language,normalized_url(detail_url))] += 1

    for i,(language,row) in enumerate(all_rows):
        ident = ids[(language,i)]
        source = INDEXES[language]
        sections = []
        if row['overview']:
            sections.append({'field':'overview','heading':row['group'] or row['title'],'text':row['overview'],'url':source})
        if row['audience']:
            sections.append({'field':'eligibility','heading':'Audience filter' if language=='en' else 'Filtre de public',
                             'text':'; '.join(row['audience']),'url':source})
        if row['amount']:
            sections.append({'field':'amount','heading':'Funding amount' if language=='en' else 'Montant du financement',
                             'text':row['amount'],'url':source})
        if row['statusText']:
            sections.append({'field':'status','heading':'Application status' if language=='en' else 'État des demandes',
                             'text':row['statusText'],'url':source})
            deadline = re.search(r'(?:until|by|jusqu\s*[’\']?au|avant le)\s+(.+)',row['statusText'],re.I)
            if deadline:
                sections.append({'field':'deadline','heading':'Application deadline' if language=='en' else 'Date limite de présentation',
                                 'text':deadline.group(1).strip(),'url':source})
        if row['process']:
            sections.append({'field':'other','heading':'Application process' if language=='en' else 'Processus de demande',
                             'text':'; '.join(row['process']),'url':source})
        body, detail_url, detail_problem = resolved_details[i]
        shared_destination = body is not None and detail_destination_counts[(language,normalized_url(detail_url))] > 1
        availability = 'metadata-only'
        if shared_destination:
            gaps.append({'language':language,'id':ident,'url':detail_url if is_government_url(detail_url) else source,
                         'reason':'multiple-published-calls-share-one-detail-url-call-specific-terms-unresolved'})
        elif body is not None:
            extra = detail_sections(body,detail_url,language)
            if extra:
                sections.extend(extra)
                availability = 'published'
            elif not sections:
                gaps.append({'language':language,'id':ident,'url':detail_url,'reason':'detail-page-had-no-recognized-content'})
        else:
            if not is_government_url(row['url']):
                gaps.append({'language':language,'id':ident,'url':source,
                             'reason':f'external-advertised-destination-not-fetched: {row["url"]}'})
            elif detail_problem:
                if detail_problem.startswith('transient-'):
                    raise RuntimeError(f'Incomplete detail refresh: {detail_url}: {detail_problem}')
                gaps.append({'language':language,'id':ident,'url':detail_url,'reason':detail_problem})
            else:
                exc = detail_errors[row['url']]
                gaps.append({'language':language,'id':ident,'url':row['url'],'reason':error_kind(exc)})
        # Capture linked application/eligibility pages for all published detail pages
        # that advertise them, especially the current Red Seal bonus.
        if body is not None and not shared_destination:
            links, external = actionable_links(body,detail_url)
            for target in external_actions.get((language,row['url']),set()) | set(external):
                gaps.append({'language':language,'id':ident,'url':detail_url,
                             'reason':f'external-action-link-not-fetched: {target}'})
            for target in links:
                if target in detail_errors:
                    exc = detail_errors[target]
                    gaps.append({'language':language,'id':ident,'url':detail_url,'reason':error_kind(exc)})
                    continue
                page = detail_bodies.get(target)
                if page is None:
                    gaps.append({'language':language,'id':ident,'url':detail_url,
                                 'reason':f'unfetched-within-program-detail-page: {target}'})
                    continue
                page, page_url, problem = localized_body(page,target,language,fetch,detail_bodies)
                if problem:
                    if problem.startswith('transient-'):
                        raise RuntimeError(f'Incomplete detail refresh: {page_url}: {problem}')
                    gaps.append({'language':language,'id':ident,'url':target,'reason':problem})
                    continue
                sections.extend(detail_sections(page,page_url,language))
                availability = 'published'
        records.append({'id':ident,'language':language,'title':row['title'],
                        'url':detail_url if body is not None and not detail_problem else source,
                        'status':row['status'],'statusText':row['statusText'],'sections':sections,
                        'availability':availability})

    # Any transient failure means this capture cannot be considered a fresh full
    # inventory. Raising before acquire writes preserves the previous successful file.
    if detail_errors:
        transient = [(url,error) for url,error in detail_errors.items()
                     if not isinstance(error,HTTPError) or error.code in (408,429,500,502,503,504)]
        if transient:
            raise RuntimeError(f'{len(transient)} transient detail fetch failure(s); refusing partial refresh: {transient[0][0]}')

    return {'indexes':INDEXES,'records':records,'gaps':gaps}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='data/corpus/funding/esdc.json')
    args = parser.parse_args()
    acquire(args.output, 'esdc', collect)


if __name__ == '__main__':
    main()
