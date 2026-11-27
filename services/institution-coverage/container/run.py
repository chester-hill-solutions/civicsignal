"""Private native coverage runner. The only work endpoint accepts a pinned occurrence."""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from bulk_inputs import DIRECTORY_ORIGINS, prepare_bulk_inputs
from snapshot import DEFAULT_ROOTS, canonical, capture, restore

ROOT = Path('/app')
SCRATCH = Path('/coverage')
PREFIX = 'weekly/institution-coverage'
ARCHIVE = 'http://objects.coverage.internal/'
LIMIT = 16 * 1024 ** 2
EXPECTED_EXTRACTOR = 'pdftotext version 26.01.0'

# The commands are the same producers used by the Mac runner. Tests of the
# local serving Worker are separate from the acquisition contract here.
PRODUCERS = (
    ('ati-summaries', (('federal-bulk.py', 'refresh', 'ati-summaries'),), 3600),
    ('grant-awards', (('federal-bulk.py', 'refresh', 'grant-awards'),), 7200),
    ('briefing-notes', (('briefing-notes.py', '--download'),), 3600),
    ('federal-procurement', (('federal-procurement.py', 'refresh'), ('federal-procurement.py', 'verify')), 3600),
    ('federal-disclosures', (('federal-disclosures.py',),), 3600),
    ('eccc', (('eccc-intake.py', '--workers', '1'), ('eccc-passages.py',)), 3600),
    ('federal-report-directories', (('federal-report-directories.py', '--hosted-origins',
                                    f'data/corpus/federal-source-inventory/{DIRECTORY_ORIGINS}'),), 1800),
    ('departmental-report-editions', (('departmental-report-editions.py', 'refresh'),
                                     ('departmental-report-editions.py', 'replay', '@runId')), 3600),
    ('departmental-report-documents', (('departmental-report-documents.py', 'refresh'),
                                       ('departmental-report-documents.py', 'replay', '@runId')), 3600),
    # The coverage reducer replays all HTML batches for the current edition and requires a drained queue.
    ('departmental-report-html', (('departmental-report-documents.py', 'html-backfill', '--batch-size', '40'),), 3600),
    ('federal-regulatory-plans', (('federal-regulatory-plans.py', 'refresh'),
                                  ('federal-regulatory-plans.py', 'replay', '@runId')), 3600),
    ('federal-publications', (('federal-publications.py', 'refresh', '--download'),), 3600),
    ('federal-publication-checklists', (('federal-publication-checklists.py', 'refresh', '--download'),
                                       ('federal-publication-catalogue.py', 'build')), 3600),
    ('federal-guidance', (('federal-guidance.py', '--refresh'), ('ircc-guidance-documents.py', 'refresh'),
                          ('ircc-guidance-documents.py', 'replay', '--report', '@reportSha256')), 3600),
    ('federal-policy-editions', (('federal-policy-editions.py', 'refresh'),
                                 ('federal-policy-editions.py', 'replay', '--portable-layout', '--report', '@reportSha256')), 3600),
    ('geds', (('geds-import.ts', '--download', '--min-new-snapshot-bytes', str(2 * 1024**3),
                '--db', 'dist/geds/geds.sqlite', '--archive', 'dist/geds/archive'),), 3600),
)

SERVING_CHECKS = {
    'eccc': ('departmental publications through the Worker', 'CIVICSIGNAL_ECCC_SQLITE',
             'data/corpus/eccc/serving.sqlite', 2),
    'geds': ('resolves one real unit from both published names and cites the imported contact', 'CIVICSIGNAL_GEDS_SQLITE',
             'dist/geds/geds.sqlite', 1),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_read(key, limit=LIMIT):
    with urllib.request.urlopen(ARCHIVE + urllib.parse.quote(key, safe='/'), timeout=120) as response:
        length = response.headers.get('Content-Length')
        if length and int(length) > limit:
            raise ValueError('Cloudflare input exceeded the expected object limit.')
        body = response.read(limit + 1)
    if not body or len(body) > limit:
        raise ValueError('Cloudflare input is empty or exceeds the expected object limit.')
    return body


def verify_ref(ref, limit=LIMIT):
    raw = object_read(ref['key'], limit)
    if len(raw) != ref['bytes'] or sha(raw) != ref['sha256']:
        raise ValueError('Cloudflare input differs from its pinned digest or size.')
    return raw


def put_object(key, body):
    request = urllib.request.Request(ARCHIVE + urllib.parse.quote(key, safe='/'), method='PUT', data=body)
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status not in (200, 201, 204):
            raise ValueError('Cloudflare archive rejected an immutable write.')
    return {'key': key, 'sha256': sha(body), 'bytes': len(body)}


def hydrate_objects(inputs):
    """Make the existing report readers use the parent Workflow's exact pointers."""
    target = SCRATCH / 'objects'

    def save(key, body):
        path = target.joinpath(*key.split('/'))
        if not path.is_relative_to(target) or any(p in ('', '.', '..') for p in key.split('/')):
            raise ValueError('Invalid pinned object path.')
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() != body:
            raise ValueError('Pinned object repeated with different content.')
        path.write_bytes(body)

    for series, pointer in inputs.items():
        save(f'weekly/{series}/latest-complete.json', canonical(pointer))
        receipt_key = pointer['receiptKey']
        receipt_body = object_read(receipt_key, 256 * 1024)
        receipt = json.loads(receipt_body)
        save(receipt_key, receipt_body)
        for name in ('discovery', 'packetRef'):
            ref = receipt[name]
            save(ref['key'], verify_ref(ref))
        if series == 'official-titles':
            for name in ('source', 'records'):
                ref = receipt[name]
                save(ref['key'], verify_ref(ref))
        else:
            for member in receipt['resources']:
                resource_id = member['resource']['resourceId']
                pin = f"weekly/{series}/checkpoints/{pointer['scheduledTime']}/{resource_id}.json"
                save(pin, object_read(pin, 32 * 1024))
                ref = member['source']
                save(ref['key'], verify_ref(ref, 24 * 1024 ** 2))
    return target


def run_command(args, timeout, log, receipt_path=None):
    interpreter = ('bun',) if args[0].endswith('.ts') else (sys.executable, '-B')
    with log.open('ab') as console, (receipt_path or log).open('ab') as output:
        try:
            return subprocess.run([*interpreter, str(ROOT / 'scripts' / args[0]), *args[1:]],
                                  cwd=ROOT, stdout=output, stderr=console, timeout=timeout, check=False).returncode
        except subprocess.TimeoutExpired:
            return 124


def run_producer(commands, timeout, log):
    codes = []
    for index, command in enumerate(commands):
        if command[-1].startswith('@'):
            field = command[-1][1:]
            pattern = r'[A-Za-z0-9][A-Za-z0-9-]{0,79}' if field == 'runId' else r'[0-9a-f]{64}'
            try:
                value = json.loads(log.with_suffix(f'.{index - 1}.receipt').read_bytes())[field]
                if not re.fullmatch(pattern, value):
                    raise ValueError('Invalid acquisition identifier')
            except (OSError, KeyError, TypeError, ValueError):
                with log.open('a') as console:
                    console.write(f'Acquisition did not return a valid {field} to replay.\n')
                return [*codes, 1]
            command = (*command[:-1], value)
        capture_receipt = index + 1 < len(commands) and commands[index + 1][-1].startswith('@')
        receipt_path = log.with_suffix(f'.{index}.receipt') if capture_receipt else None
        code = run_command(command, timeout, log, receipt_path)
        codes.append(code)
        if receipt_path:
            with log.open('ab') as console:
                console.write(receipt_path.read_bytes())
        if code and (code != 2 or not capture_receipt):
            return codes
    return codes


def log_tail(path, size=3000):
    with path.open('rb') as log:
        log.seek(max(0, log.seek(0, io.SEEK_END) - size))
        return log.read().decode('utf-8', 'replace')


def verify_serving(name, log):
    pattern, variable, database, expected = SERVING_CHECKS[name]
    report = SCRATCH / f'{name}-serving.json'
    report.unlink(missing_ok=True)
    try:
        with log.open('ab') as output:
            subprocess.run(['bun', 'run', 'test', 'test/endpoints.test.ts', '-t', pattern, '--reporter=json',
                            f'--outputFile={report}'], cwd=ROOT, env={**os.environ, variable: str(ROOT / database)},
                           timeout=180, check=True, stdout=output, stderr=output)
        result = json.loads(report.read_bytes())
        if result['success'] is not True or result['numPassedTests'] != expected or result['numFailedTests'] != 0:
            raise ValueError(f'Expected {expected} authenticated Worker checks.')
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        with log.open('a') as output:
            output.write(f'Authenticated serving checks failed: {error}\n')
        return 0
    return expected


def run_coverage(request):
    instance, mode = request['instanceId'], request['mode']
    Handler.progress('restore')
    SCRATCH.mkdir(exist_ok=True)
    manifest = json.loads(verify_ref(request['state'], 2 * 1024 ** 2))
    if not set(DEFAULT_ROOTS).issubset(manifest['roots']):
        raise ValueError('The workspace snapshot omits one or more input roots.')
    restore(ROOT, manifest, object_read)
    inputs = hydrate_objects(request['inputs'])
    consultations = SCRATCH / 'consultations.json'
    consultations.write_bytes(canonical(request['consultations']))
    attempts = []
    if mode == 'refresh':
        Handler.progress('catalogues')
        catalogue = prepare_bulk_inputs(ROOT, object_read, request['discovery'])
        print(json.dumps({'instanceId': instance, 'catalogue': catalogue}), flush=True)
        for name, commands, timeout in PRODUCERS:
            Handler.progress('acquire', name, len(attempts))
            print(json.dumps({'instanceId': instance, 'source': name, 'event': 'started'}), flush=True)
            started = time.monotonic()
            log = SCRATCH / f'{name}.log'
            codes = run_producer(commands, timeout, log)
            attempt = {'source': name, 'exitCodes': codes, 'ok': all(code == 0 for code in codes),
                       'elapsedSeconds': round(time.monotonic() - started, 3)}
            if attempt['ok'] and name in SERVING_CHECKS:
                Handler.progress('verify-serving', name, len(attempts))
                passed = verify_serving(name, log)
                attempt['servingTestsPassed'] = passed
                attempt['ok'] = passed == SERVING_CHECKS[name][3]
                attempt['elapsedSeconds'] = round(time.monotonic() - started, 3)
            if not attempt['ok']:
                attempt['diagnostic'] = log_tail(log)
            attempts.append(attempt)
            print(json.dumps({'instanceId': instance, **attempts[-1]}), flush=True)

    report_path = SCRATCH / 'report.json'
    Handler.progress('reduce')
    code = run_command(('federal-institution-coverage.py', '--include-acquisitions', '--hosted-objects', str(inputs),
                        '--hosted-consultations', str(consultations), '--output', str(report_path)), 1800, SCRATCH / 'coverage.log')
    if code:
        raise ValueError(f'Coverage reducer exited with status {code} on {Handler.extractor}.\n{log_tail(SCRATCH / "coverage.log", 2950)}')
    report = report_path.read_bytes()
    payload = json.loads(report)
    report_ref = put_object(f'{PREFIX}/reports/{sha(report)}.json', report)
    state = request['state']
    if mode == 'refresh':
        Handler.progress('archive')
        packed = canonical(capture(ROOT, DEFAULT_ROOTS, put_object))
        state = put_object(f'{PREFIX}/manifests/{sha(packed)}.json', packed)
    return {'instanceId': instance, 'mode': mode, 'report': report_ref, 'state': state, 'attempts': attempts,
            'sources': len(payload['sources']), 'registeredSeries': len(payload['registeredSeriesSummary']),
            'namesWithRecords': payload['namesWithRecords'], 'provisionalNames': payload['provisionalNames']}


class Handler(BaseHTTPRequestHandler):
    job = None
    lock = threading.Lock()
    extractor = ''

    @classmethod
    def progress(cls, phase, source=None, attempted=0):
        with cls.lock:
            cls.job = {**cls.job, 'phase': phase, 'source': source, 'attempted': attempted}

    def response(self, status, body):
        raw = canonical(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/health':
            return self.response(200, {'ready': True, 'extractor': self.extractor})
        if self.path == '/status':
            with self.lock:
                job = type(self).job
            return self.response(200, job or {'status': 'empty'})
        return self.response(404, {'status': 'unknown-route'})

    @classmethod
    def background(cls, request):
        try:
            outcome = {'status': 'complete', 'result': run_coverage(request)}
        except Exception as error:
            outcome = {'status': 'failed', 'reason': str(error)[-3200:]}
            print(json.dumps({'instanceId': request['instanceId'], **outcome}), flush=True)
        with cls.lock:
            cls.job = {'instanceId': request['instanceId'], **outcome}

    def do_POST(self):
        if self.path != '/start':
            return self.response(404, {'status': 'unknown-route'})
        try:
            length = int(self.headers['Content-Length'])
            if not 0 < length <= 512 * 1024:
                raise ValueError('Invalid coverage request length.')
            body = json.loads(self.rfile.read(length))
            if not re.fullmatch(r'institution-coverage-[1-9][0-9]{0,15}', body['instanceId']) or body['mode'] not in ('replay', 'refresh'):
                raise ValueError('Invalid coverage request identity.')
        except (KeyError, TypeError, ValueError):
            return self.response(400, {'status': 'invalid-request'})
        with self.lock:
            current = type(self).job
            if current:
                if current['instanceId'] != body['instanceId']:
                    return self.response(409, {'status': 'different-occurrence'})
                return self.response(202, current)
            type(self).job = {'instanceId': body['instanceId'], 'status': 'running'}
            threading.Thread(target=self.background, args=(body,), daemon=True).start()
        return self.response(202, {'instanceId': body['instanceId'], 'status': 'running'})


if __name__ == '__main__':
    extractor = subprocess.check_output(['pdftotext', '-v'], stderr=subprocess.STDOUT, text=True).splitlines()[0]
    if extractor != EXPECTED_EXTRACTOR:
        raise RuntimeError(f'Expected {EXPECTED_EXTRACTOR}; found {extractor}')
    Handler.extractor = extractor
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
