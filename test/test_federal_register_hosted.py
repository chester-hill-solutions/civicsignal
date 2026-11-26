"""Exercise the same register, original and checkpoint contract used by the weekly collector."""
import csv
from datetime import datetime
import io
import json
from pathlib import Path
import sys
import unittest
from collections import Counter

from test_funding_esdc_hosted import MemoryStore

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/federal-register/collector"))
from discovery import FIELDS, PREFIX, SourceFailure, acquire, digest, official  # noqa: E402

STAMP = "2026-11-26T16:15:02.001Z"
SCHEDULED = int(datetime.fromisoformat(STAMP).timestamp() * 1000) - 1
ID = "aaaa0000-0000-0000-0000-000000000000"
DATASET = "https://open.canada.ca/data/en/dataset/" + ID
API = "https://open.canada.ca/data/api/action/package_show?id=" + ID
INDEX = "https://www.canada.ca/en/index"
DENIED = "https://www.canada.ca/fr/index"
INVALID = "https://www.canada.ca/fr/invalid"
DOCUMENT = {"success": True, "result": {"id": ID, "title": "Sets", "resources": [
    {"id": "resource", "url": "https://www.canada.ca/export.csv", "format": "csv", "name": "Data"}]}}
INDEX_BODY = b'<html><main><h1>Reports</h1><a href="/result">Result</a></main></html>'


def register(rows):
    text = io.StringIO(newline="")
    out = csv.writer(text)
    out.writerow(FIELDS)
    for series, url, other in rows:
        out.writerow((series, "family", "method", "title", url, other, "check", "state"))
    return text.getvalue().encode()


class WeeklyFederalRegister(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.pages = {API: json.dumps(DOCUMENT).encode(), INDEX: INDEX_BODY, INVALID: b"<main>broken</main>"}
        self.requests = Counter()
        self.interrupt = None
        self.params = self.install(register([("one", DATASET, INDEX), ("two", DENIED, INDEX), ("three", INVALID, "")]))

    def install(self, raw):
        sha = digest(raw)
        key = f"{PREFIX}/registers/{sha}.csv"
        self.store.objects[key] = raw
        return {"scheduledTime": SCHEDULED, "registerKey": key, "registerSha256": sha}

    async def fetch(self, url, dataset):
        self.requests[url] += 1
        if self.interrupt == url:
            raise RuntimeError("interrupted")
        if url == DENIED:
            raise SourceFailure("http-403", url, 403)
        return self.pages[url], url

    async def run_acquire(self):
        events = []
        ref = await acquire(self.store, self.fetch, self.params, lambda: STAMP, events.append)
        raw = self.store.objects[ref["key"]]
        self.assertEqual((digest(raw),len(raw)), (ref["sha256"],ref["bytes"]))
        return ref, json.loads(raw), events[0]

    async def test_archive_and_replay_preserve_shared_urls_denials_and_parser_failures(self):
        ref, packet, first = await self.run_acquire()
        self.assertEqual((len(packet["endpoints"]),len(packet["sources"]),first["fetched"]), (5,4,4))
        self.assertEqual(set(self.requests.values()), {1})
        deliveries = packet["endpoints"]
        self.assertEqual(deliveries[0]["inventory"]["resources"][0]["id"], "resource")
        self.assertEqual(deliveries[1]["inventory"], deliveries[3]["inventory"])
        self.assertEqual(deliveries[1]["inventory"]["links"], ["https://www.canada.ca/result"])
        self.assertEqual([d.get("reason") for d in deliveries if not d["ok"]], ["http-403","catalogue-parse-failed"])
        sources = {s["url"]:s for s in packet["sources"]}
        self.assertNotIn("key", sources[DENIED])
        self.assertEqual(sources[DENIED]["status"], 403)
        for url, raw in self.pages.items():
            source = sources[url]
            self.assertEqual(self.store.objects[source["key"]], raw)
            self.assertEqual(source["sha256"], digest(raw))
        self.pages[INDEX] = b"changed publisher page"
        again, same, replay = await self.run_acquire()
        self.assertEqual((again,same,replay["reused"]), (ref,packet,4))
        self.assertEqual(set(self.requests.values()), {1})

    async def test_interrupted_coverage_resumes_and_refuses_corrupt_checkpointed_original(self):
        self.interrupt = INDEX
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            await self.run_acquire()
        self.assertFalse(any("/inventories/" in key for key in self.store.objects))
        self.interrupt = None
        _, packet, event = await self.run_acquire()
        self.assertEqual((event["reused"],event["fetched"],self.requests[API]), (2,2,1))
        original = next(s for s in packet["sources"] if s["url"] == INDEX)
        self.store.objects[original["key"]] = b"x" * original["bytes"]
        counts = self.requests.copy()
        with self.assertRaisesRegex(ValueError, "Corrupt archived"):
            await self.run_acquire()
        self.assertEqual(self.requests, counts)

    async def test_occurrence_pins_exact_register_and_official_urls(self):
        await self.run_acquire()
        counts = self.requests.copy()
        self.params = self.install(register([("changed", INDEX, "")]))
        with self.assertRaisesRegex(ValueError, "Archive object conflict"):
            await self.run_acquire()
        self.store.objects[self.params["registerKey"]] += b"altered"
        with self.assertRaisesRegex(ValueError, "checksum"):
            await self.run_acquire()
        self.assertEqual(self.requests, counts)
        for url in ["http://www.canada.ca/x", "https://www.canada.ca.example.org/x", "https://key@www.canada.ca/x",
                    "https://www.canada.ca:8443/x"]:
            with self.assertRaises(ValueError):
                official(url)

    async def test_racing_capture_uses_the_first_archived_response(self):
        _, packet, _ = await self.run_acquire()
        source = next(s for s in packet["sources"] if s["url"] == DENIED)
        pin = f"{PREFIX}/observations/{SCHEDULED}/pages/{digest(DENIED.encode())}.json"
        saved = self.store.objects.pop(pin)
        create = self.store.create

        async def racing_create(key, body, sha):
            if key == pin:
                self.store.objects[key] = saved
                return False
            return await create(key, body, sha)

        self.store.create = racing_create
        async def recovered(url, dataset):
            return INDEX_BODY, url
        ref = await acquire(self.store, recovered, self.params, lambda: STAMP)
        raced = json.loads(self.store.objects[ref["key"]])
        self.assertEqual(next(s for s in raced["sources"] if s["url"] == DENIED), source)
        self.assertFalse(next(d for d in raced["endpoints"] if d["url"] == DENIED)["ok"])
