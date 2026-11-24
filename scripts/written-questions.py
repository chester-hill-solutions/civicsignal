"""Acquire the House's published written-question material into a resumable local corpus."""
import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import fcntl
from http.cookiejar import CookieJar
from threading import local
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPCookieProcessor

from lib.wq_replies import acquire_written_question_replies, MAX_ATTACHMENT_BYTES
from lib.wq_archive import sessional_documents
from lib.wq_store import database, now, SESSION, save_material, set_catalogue


class Body(bytes):
    pass


_connections = local()


def get(url, headers=None):
    if not hasattr(_connections, 'opener'):
        _connections.opener = build_opener(HTTPCookieProcessor(CookieJar()))
    request = Request(url, headers={'User-Agent': 'CivicSignal parliamentary corpus/0.1',
                                    'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', **(headers or {})})
    for attempt in range(4):
        try:
            with _connections.opener.open(request, timeout=45) as response:
                data = Body(response.read(MAX_ATTACHMENT_BYTES + 1))
                if len(data) > MAX_ATTACHMENT_BYTES:
                    raise ValueError('Source response exceeds maximum object size')
                data.headers, data.status = response.headers, response.status
                return data
        except HTTPError as error:
            if error.code in (404, 410):
                data = Body(b'')
                data.headers, data.status = error.headers, 404
                return data
            if error.code != 429 and error.code < 500 or attempt == 3:
                raise
            delay = error.headers.get('Retry-After', '')
            time.sleep(min(120, int(delay)) if delay.isdigit() else 2 ** attempt)
        except (URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def acquire(record, objects):
    try:
        archives = [r for r in record['responses'] if r.get('type') == 'sessional_paper']
        other = [r for r in record['responses'] if r not in archives]
        result = acquire_written_question_replies(dict(record, session=SESSION, responses=other), get, objects)
        for response in archives:
            try:
                result['documents'].extend(sessional_documents(record, response, get, objects))
            except (ValueError, KeyError, OSError) as error:
                result['errors'].append(f"{response['sessionalPaperNumber']}: {error}")
        return result
    except (ValueError, HTTPError, URLError, OSError, TimeoutError) as error:
        return {'documents': [], 'errors': [str(error)]}


def run(db, records, args, objects):
    subset = {int(n) for n in args.number}
    sql = 'SELECT number,language FROM questions WHERE session=?'
    if not args.recheck:
        sql += " AND acquisition <> 'complete'"
    due = {tuple(row) for row in db.execute(sql, (SESSION,))}
    selected = [r for r in records if (r['number'], r['language']) in due and (not subset or r['number'] in subset)]
    if args.limit is not None:
        selected = selected[:args.limit]
    started, finished = time.monotonic(), 0
    items = iter(selected)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        waiting = {}
        while True:
            while len(waiting) < 2 * args.workers:
                record = next(items, None)
                if record is None:
                    break
                waiting[pool.submit(acquire, record, objects)] = record
            if not waiting:
                break
            done, _ = wait(waiting, return_when=FIRST_COMPLETED)
            for future in done:
                record = waiting.pop(future)
                save_material(db, (SESSION,record['number'],record['language']), future.result())
                finished += 1
                if finished % 100 == 0:
                    print(f'{finished}/{len(selected)} editions checked in {time.monotonic()-started:.0f}s', flush=True)
    return finished


def inventory(db, root, catalogue, verify):
    def rows(sql):
        return [dict(row) for row in db.execute(sql)]
    result = {'observedAt': now(), 'session':SESSION, 'catalogue':catalogue['totals'],
              'sessionsInventoried': len(catalogue['sessions']),
              'sourceCutoff': catalogue['observedAt'],
              'sourceOverview': catalogue.get('overview',{}),
              'publishedResponses':rows('''SELECT q.language, count(*) AS responses
                    FROM questions q,json_each(q.metadata_json,'$.responses') GROUP BY q.language ORDER BY q.language'''),
              'responseCoverage':rows('''SELECT language,
                    count(*) AS answered,
                    sum(EXISTS (SELECT 1 FROM documents d WHERE d.session=q.session AND d.number=q.number
                        AND d.language=q.language AND d.kind='reply' AND d.availability IN ('stored','searchable'))) AS withStoredReply,
                    sum(EXISTS (SELECT 1 FROM documents d WHERE d.session=q.session AND d.number=q.number
                        AND d.language=q.language AND d.kind='reply' AND d.availability='searchable')) AS withSearchableReply
                    FROM questions q WHERE status='answered' GROUP BY language ORDER BY language'''),
              'editions':rows('SELECT language,status,acquisition,count(*) AS count FROM questions GROUP BY 1,2,3 ORDER BY 1,2,3'),
              'documents':rows('SELECT language,kind,availability,count(*) AS count FROM documents GROUP BY 1,2,3 ORDER BY 1,2,3'),
              'gaps':rows("SELECT number,language,url,error FROM questions WHERE acquisition='gap' ORDER BY 1,2"),
              'journalEvents':db.execute('SELECT count(*) FROM changes').fetchone()[0]}
    if verify:
        hashes = set()
        for row in db.execute('SELECT object_sha256,metadata_json FROM documents'):
            if row[0]:
                hashes.add(row[0])
            meta = json.loads(row[1])
            if meta.get('shell_sha256'):
                hashes.add(meta['shell_sha256'])
        invalid = []
        for digest in sorted(hashes):
            path = root / 'objects' / digest
            if not path.is_file():
                invalid.append(digest)
                continue
            hash_bytes = sha256()
            with path.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    hash_bytes.update(chunk)
            if hash_bytes.hexdigest() != digest:
                invalid.append(digest)
        result['objectVerification'] = {'referenced':len(hashes), 'invalid':invalid}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('data/corpus/written-questions'))
    parser.add_argument('--catalogue', type=Path)
    parser.add_argument('--partial', action='store_true', help='Add checkpoint records without removing existing editions.')
    parser.add_argument('--recheck', action='store_true', help='Fetch previously completed editions again, including same-URL corrections.')
    parser.add_argument('--number', type=int, action='append', default=[])
    parser.add_argument('--limit', type=int)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--verify-objects', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.workers <= 24 or args.limit is not None and args.limit < 0:
        parser.error('Expected 1–24 workers and a nonnegative limit.')
    root = args.root
    root.mkdir(exist_ok=True, parents=True)
    with (root/'writer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        catalogue = json.loads((args.catalogue or root/'catalogue.json').read_text())
        db = database(root/'questions.sqlite')
        try:
            if args.partial:
                catalogue['records'] = [r for r in catalogue['records'] if r.get('text') and r.get('detailFetchedAt') and not r.get('fetchError')]
            changed = set_catalogue(db, catalogue, partial=args.partial)
            checked = run(db, catalogue['records'], args, root/'objects')
            receipt = inventory(db, root, catalogue, args.verify_objects)
            receipt.update({'catalogueChanges':changed,'editionsChecked':checked})
            with tempfile.NamedTemporaryFile(mode='w',dir=root,delete=False) as tmp:
                json.dump(receipt,tmp,ensure_ascii=False,indent=2)
                tmp.write('\n')
            os.replace(tmp.name,root/'coverage.json')
            print(json.dumps({k:v for k,v in receipt.items() if k!='gaps'},ensure_ascii=False))
            if receipt.get('objectVerification',{}).get('invalid'):
                raise SystemExit('Object verification failed.')
        finally:
            # A clean single-file snapshot can be opened by read-only Bun and D1 tooling.
            # During acquisition WAL keeps earlier checkpoints available to other readers.
            try:
                db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                db.execute('PRAGMA journal_mode=DELETE')
            finally:
                db.close()


if __name__ == '__main__':
    main()
