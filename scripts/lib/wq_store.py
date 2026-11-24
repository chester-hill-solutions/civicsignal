"""Durable, edition-scoped catalogue and materialization for House written questions."""
import hashlib
import json
import sqlite3
from datetime import date, datetime, timezone
import re

SESSION = "45-1"
SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS questions (
 session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL,
 url TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, member_id TEXT, member_name TEXT, asked_on TEXT,
 metadata_json TEXT NOT NULL, source_hash TEXT NOT NULL, content_hash TEXT, acquisition TEXT NOT NULL DEFAULT 'pending',
 error TEXT, last_checked TEXT, PRIMARY KEY(session,number,language)
);
CREATE TABLE IF NOT EXISTS documents (
 session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL, doc_key TEXT NOT NULL,
 kind TEXT NOT NULL, respondent TEXT, title TEXT, url TEXT NOT NULL, text TEXT NOT NULL,
 object_sha256 TEXT, availability TEXT NOT NULL, metadata_json TEXT NOT NULL,
 PRIMARY KEY(session,number,language,doc_key),
 FOREIGN KEY(session,number,language) REFERENCES questions(session,number,language) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS wq_fts USING fts5(session UNINDEXED,number UNINDEXED,language UNINDEXED,doc_key UNINDEXED,text);
CREATE TABLE IF NOT EXISTS changes (
 sequence INTEGER PRIMARY KEY, session TEXT NOT NULL, number INTEGER NOT NULL, language TEXT NOT NULL,
 layer TEXT NOT NULL, change TEXT NOT NULL, fingerprint TEXT, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 session TEXT PRIMARY KEY, metadata_json TEXT NOT NULL
);
"""
KEY = 'session=? AND number=? AND language=?'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def fingerprint(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def database(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def event(db, key, layer, change, digest):
    db.execute("INSERT INTO changes(session,number,language,layer,change,fingerprint,observed_at) VALUES (?,?,?,?,?,?,?)",
               (*key, layer, change, digest, now()))


def edition_key(record):
    return SESSION, int(record['number']), record['language']


def asked_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        pass
    months = ('janvier février mars avril mai juin juillet août septembre octobre novembre décembre').split()
    french = re.fullmatch(r"(\d{1,2})(?:er)? (\w+) (\d{4})", value.strip().lower())
    if french and french[2] in months:
        return date(int(french[3]), months.index(french[2]) + 1, int(french[1])).isoformat()
    try:
        return datetime.strptime(value, "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


def clear_documents(db, key):
    db.execute(f"DELETE FROM wq_fts WHERE rowid IN (SELECT rowid FROM documents WHERE {KEY})", key)
    db.execute(f"DELETE FROM documents WHERE {KEY}", key)


def response_inventory(record):
    return (record['status'], [(str(r['id']),r.get('type','viewer'),r.get('url'),
             r.get('date'),(r.get('sessionalPaperNumber') or '').strip(chr(34))) for r in record['responses']])


def set_catalogue(db, catalogue, partial=False):
    records = catalogue['records']
    totals = catalogue['totals']
    keys = {edition_key(r) for r in records}
    if not records or len(keys) != len(records):
        raise ValueError('Empty or duplicate question inventory.')
    for r in records:
        if r['language'] not in ('en', 'fr') or not r['url'].endswith(f"/{SESSION}/q-{r['number']}") or not r['text'].strip():
            raise ValueError(f"Invalid edition: {edition_key(r)}")
    if not partial:
        en, fr = ({k[1] for k in keys if k[2] == language} for language in ('en','fr'))
        if not totals['complete'] or en != fr or len(en) != totals['officialReported']:
            raise ValueError('Complete matching English and French official inventories required.')
        if any(r.get('fetchError') or r['status'] == 'unknown' or not asked_date(r.get('dateAsked')) for r in records):
            raise ValueError('Unresolved question detail, status or asked date in complete catalogue.')
    changed = 0
    with db:
        for session in catalogue['sessions']:
            db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?)', (session['id'], packed(session)))
        for record in records:
            key = edition_key(record)
            signature = fingerprint({field:value for field,value in record.items() if field != 'detailFetchedAt'})
            prior = db.execute(f'SELECT rowid,source_hash,metadata_json,acquisition,error FROM questions WHERE {KEY}', key).fetchone()
            if prior and prior[1] == signature:
                continue
            same_material = prior and response_inventory(json.loads(prior[2])) == response_inventory(record)
            member = record.get('askedBy') or {}
            text = record['text']
            rowid = db.execute('''INSERT INTO questions(session,number,language,url,text,status,member_id,member_name,asked_on,metadata_json,source_hash,acquisition,error)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session,number,language) DO UPDATE SET
              url=excluded.url,text=excluded.text,status=excluded.status,member_id=excluded.member_id,
              member_name=excluded.member_name,asked_on=excluded.asked_on,metadata_json=excluded.metadata_json,
              source_hash=excluded.source_hash,acquisition=excluded.acquisition,error=excluded.error RETURNING rowid''',
              (*key, record['url'], text, record['status'], member.get('personId'), member.get('name'),
               asked_date(record.get('dateAsked')), packed(record), signature, prior[3] if same_material else 'pending',
               prior[4] if same_material else None)).fetchone()[0]
            db.execute('INSERT OR REPLACE INTO wq_fts(rowid,session,number,language,doc_key,text) VALUES (?,?,?,?,?,?)', (-rowid,*key, '', text))
            event(db,key,'catalogue','changed' if prior else 'added',signature)
            changed += 1
        if not partial:
            for row in db.execute('SELECT rowid,session,number,language FROM questions WHERE session=?', (SESSION,)).fetchall():
                key = tuple(row)[1:]
                if key not in keys:
                    clear_documents(db, key)
                    db.execute('DELETE FROM wq_fts WHERE rowid=?', (-row[0],))
                    db.execute(f'DELETE FROM questions WHERE {KEY}', key)
                    event(db,key,'catalogue','removed',None)
                    changed += 1
    return changed


def save_material(db, key, result):
    docs = result['documents']
    errors = list(result.get('errors', []))
    incomplete_inventory = bool(errors)
    errors.extend(f"{doc['doc_key']}: {doc.get('reason') or 'published document was unavailable'}"
                  for doc in docs if doc['availability'] == 'gap')
    by_key = {doc['doc_key']:doc for doc in docs}
    if len(by_key) != len(docs):
        raise ValueError(f'Duplicate response document key in {key}.')
    with db:
        prior = db.execute(f'SELECT content_hash,status,metadata_json FROM questions WHERE {KEY}', key).fetchone()
        if prior is None:
            raise ValueError(f'Question edition disappeared: {key}')
        expected = {str(r['id']) for r in json.loads(prior[2])['responses']}
        reported = {str(d.get('response_id')) for d in docs if d['kind'] == 'reply' and d['availability'] != 'gap'}
        missing = expected - reported
        incomplete_inventory = incomplete_inventory or bool(missing)
        errors.extend(f'response_{i}_missing_material' for i in sorted(missing))
        if not expected and prior[1] not in ('awaiting_response', 'withdrawn'):
            errors.append('question_status_requires_published_response')
        has_gap = errors or any(d['availability'] == 'gap' for d in docs)
        if has_gap and prior[0]:
            # Preserve previously verified material during partial refreshes.
            for old in db.execute(f'SELECT doc_key,metadata_json,text FROM documents WHERE {KEY}', key):
                existing = dict(json.loads(old[1]), text=old[2])
                candidate = by_key.get(old[0])
                missing_from_partial_read = candidate is None and incomplete_inventory
                same_unavailable_file = (candidate is not None and candidate['availability'] == 'gap'
                                         and candidate['url'] == existing['url'] and existing['availability'] != 'gap')
                if missing_from_partial_read or same_unavailable_file:
                    by_key[old[0]] = existing
        canonical = [by_key[k] for k in sorted(by_key)]
        signature = fingerprint([{field:value for field,value in doc.items() if field != 'shell_sha256'} for doc in canonical])
        if prior[0] != signature:
            clear_documents(db,key)
            for d in canonical:
                body = d.get('text') or ''
                cur = db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (*key,d['doc_key'],d['kind'],d.get('respondent'),d.get('title'),d['url'],body,d.get('object_sha256'),
                     d['availability'], packed({k:v for k,v in d.items() if k != 'text'})))
                if body:
                    db.execute('INSERT INTO wq_fts(rowid,session,number,language,doc_key,text) VALUES (?,?,?,?,?,?)',
                               (cur.lastrowid,*key,d['doc_key'],body))
            if canonical or prior[0]:
                event(db,key,'documents','changed' if prior[0] else 'added',signature)
        db.execute(f'UPDATE questions SET content_hash=?,acquisition=?,error=?,last_checked=? WHERE {KEY}',
            (signature,'gap' if has_gap else 'complete', packed(errors) if errors else None, now(),*key))
