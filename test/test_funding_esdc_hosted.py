"""The hosted acquisition resumes one observation and verifies retained bytes."""
import json
from hashlib import sha256
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/funding/esdc-collector"))
from esdc import EN, FR
from observation import acquire, checkpoint_key, publisher_url

EN_DETAIL = "https://www.canada.ca/en/example.html"
FR_DETAIL = "https://www.canada.ca/fr/exemple.html"
LINK = "https://www.canada.ca/en/example/qualify.html"
TRANSLATION = "https://www.canada.ca/en/example/translation.html"
OBSERVED = "2026-11-25T11:18:02.738Z"


class MemoryStore:
    def __init__(self):
        self.objects = {}

    async def create(self, key, body, digest):
        if sha256(body).hexdigest() != digest:
            raise ValueError("Content checksum mismatch.")
        if key in self.objects:
            return False
        self.objects[key] = body
        return True

    async def archive(self, key, body, digest):
        if not await self.create(key, body, digest) and self.objects[key] != body:
            raise ValueError("Archive object conflict.")

    async def read(self, key, limit):
        body = self.objects.get(key)
        if body is not None and len(body) > limit:
            raise ValueError("Archive read exceeds limit.")
        return body


def index(url):
    return f'<div class="tagfilter-item"><p class="h4"><a href="{url}">Call</a></p><p>Summary</p></div>'.encode()


class HostedEsdc(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.calls = []
        self.responses = {
            EN: index(EN_DETAIL), FR: index(FR_DETAIL),
            EN_DETAIL: f'<html lang="en"><main><h1 id="wb-cont">Call</h1><p>Text</p><a href="{LINK}">Eligibility</a></main></html>'.encode(),
            FR_DETAIL: 410, LINK: 404,
        }

    async def fetch(self, url):
        self.calls.append(url)
        result = self.responses[url]
        if isinstance(result, int):
            return {"url": url, "resolvedUrl": url, "status": result}, None
        return {"url": url, "resolvedUrl": url, "status": 200, "etag": None, "lastModified": None}, result

    async def test_refuses_403_then_resumes_and_replays_with_terminal_url_gaps(self):
        self.responses[LINK] = 403
        with self.assertRaisesRegex(RuntimeError, "403"):
            await acquire(self.store, self.fetch, OBSERVED)
        self.assertNotIn(checkpoint_key(OBSERVED, LINK), self.store.objects)
        self.assertFalse(any("/inventories/" in key for key in self.store.objects))
        self.calls.clear()
        self.responses[LINK] = 404
        events = []
        ref = await acquire(self.store, self.fetch, OBSERVED, events.append)
        self.assertEqual([(e["fetchedPages"], e["checkpointPages"], e["terminalPages"]) for e in events],
                         [(1, 4, 2)])
        self.assertEqual(self.calls, [LINK])
        packet = json.loads(self.store.objects[ref["key"]])
        self.assertEqual([(g["url"], g["reason"]) for g in packet["gaps"] if "http" in g["reason"]],
                         [(LINK, "confirmed-detail-http-404"), (FR_DETAIL, "confirmed-detail-http-410")])
        self.assertEqual(ref["sources"], 3)
        self.calls.clear()
        self.assertEqual(await acquire(self.store, self.fetch, OBSERVED), ref)
        self.assertEqual(self.calls, [])
        self.responses[LINK] = b'<main><h1 id="wb-cont">New source</h1><p>Opened.</p></main>'
        next_ref = await acquire(self.store, self.fetch, "2026-11-26T11:18:02.738Z")
        self.assertEqual(next_ref["sources"], 4)
        self.assertEqual(set(self.calls), set(self.responses))

    async def test_cites_failed_publisher_translation_and_refuses_corrupt_replay(self):
        self.responses[LINK] = f'<html lang="fr"><link hreflang="en" href="{TRANSLATION}"></html>'.encode()
        self.responses[TRANSLATION] = 410
        ref = await acquire(self.store, self.fetch, OBSERVED)
        packet = json.loads(self.store.objects[ref["key"]])
        self.assertTrue(any(g["url"] == TRANSLATION and g["reason"] == "confirmed-detail-http-410" for g in packet["gaps"]))
        original = next(r for r in packet["sources"] if r["url"] == EN)
        self.store.objects[f"funding/esdc/sources/{original['sha256']}.html"] = b"x" * original["bytes"]
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "corrupt"):
            await acquire(self.store, self.fetch, OBSERVED)
        self.assertEqual(self.calls, [])

    async def test_missing_index_is_never_pinned(self):
        self.responses[EN] = 404
        with self.assertRaisesRegex(RuntimeError, "404"):
            await acquire(self.store, self.fetch, OBSERVED)
        self.assertNotIn(checkpoint_key(OBSERVED, EN), self.store.objects)

    def test_only_allows_https_government_publisher_destinations(self):
        for url in ("http://canada.ca/a", "https://notcanada.ca/a", "https://a.gc.ca:8443/p", "https://name@canada.ca/a"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                publisher_url(url)
