"""Verify funding capture, publisher revalidation, and publication after success."""
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys
from subprocess import CompletedProcess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lib.funding_intake import acquire, canada_response, official

INDEXES = {lang: 'https://nserc.canada.ca/' + lang for lang in ('en', 'fr')}


class Response(BytesIO):
    headers = {'ETag': '"a"'}
    def __init__(self, url, body):
        super().__init__(body)
        self.url = url

    def geturl(self):
        return self.url


class CaptureTest(unittest.TestCase):
    def test_revalidates_archive_and_failure_preserves_last_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'nserc.json'
            def collect(fetch):
                for url in INDEXES.values():
                    self.assertEqual(fetch(url), b'index')
                return {'indexes': INDEXES, 'records': [], 'gaps': []}
            with patch('lib.funding_intake.build_opener') as opener:
                read = opener.return_value.open
                read.side_effect = lambda req, timeout: Response(req.full_url, b'index')
                packet = acquire(output, 'nserc', collect)
                self.assertEqual(len(packet['sources']), 2)
                digest = sha256(b'index').hexdigest()
                self.assertEqual((output.parent/'sources'/'objects'/digest[:2]/digest).read_bytes(), b'index')
                def revalidate(req, timeout):
                    self.assertEqual(req.get_header('If-none-match'), '"a"')
                    raise HTTPError(req.full_url, 304, 'Not modified', {}, None)
                read.side_effect = revalidate
                refreshed = acquire(output, 'nserc', collect)
                self.assertEqual(refreshed['sources'], packet['sources'])
                self.assertGreaterEqual(datetime.fromisoformat(refreshed['observedAt']), datetime.fromisoformat(packet['observedAt']))
                read.side_effect = HTTPError(INDEXES['en'], 404, 'Missing index', {}, None)
                with self.assertRaises(HTTPError):
                    acquire(output, 'nserc', collect)
                self.assertEqual(json.loads(output.read_bytes()), refreshed)

    def test_rejects_unrelated_redirect_hosts(self):
        with self.assertRaises(ValueError):
            official('https://nserc.canada.ca.example.org/grants')

    @patch('lib.funding_intake.subprocess.run')
    def test_esdc_checks_redirect_before_contact_and_retains_validators(self, run):
        def reply(cmd, **kwargs):
            target = cmd[-1]
            headers = Path(cmd[cmd.index('--dump-header') + 1])
            body = Path(cmd[cmd.index('--output') + 1])
            if target.endswith('/en'):
                headers.write_bytes(b'HTTP/2 301\r\nLocation: /final\r\n\r\n')
                return CompletedProcess(cmd, 0, stdout=b'301')
            headers.write_bytes(b'HTTP/2 200\r\nETag: "v1"\r\n\r\n')
            body.write_bytes(b'published')
            return CompletedProcess(cmd, 0, stdout=b'200')
        run.side_effect = reply
        with canada_response(INDEXES['en'], {'If-None-Match': '"v0"'}) as (body, url, headers):
            self.assertEqual(body.read(), b'published')
            self.assertEqual(url, 'https://nserc.canada.ca/final')
            self.assertEqual(headers['ETag'], '"v1"')
        self.assertIn('If-None-Match: "v0"', run.call_args.args[0])
        def redirect(cmd, **kwargs):
            Path(cmd[cmd.index('--dump-header') + 1]).write_bytes(b'HTTP/2 302\r\nLocation: https://example.org/\r\n\r\n')
            return CompletedProcess(cmd, 0, stdout=b'302')
        run.reset_mock()
        run.side_effect = redirect
        with self.assertRaises(ValueError):
            with canada_response(INDEXES['en'], {}):
                self.fail('Unexpected external source')
        self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
