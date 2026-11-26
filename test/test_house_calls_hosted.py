"""Check acquisition, replay and change scope at the private House collector's entry point."""
import json
import sys
import unittest
from collections import Counter
from datetime import datetime
from pathlib import Path

from test_committee_calls import BILL, PARTICIPATE, STUDY
from test_funding_esdc_hosted import MemoryStore

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/house-collector"))
from house import PARTICIPATE_INDEX, SENATE_CHECKS, PublisherUnavailable, acquire, publisher_url, study_url

CHECKED = "2026-11-25T12:00:00.123Z"


def request(stamp=CHECKED, prior=()):
    millis = int(datetime.fromisoformat(stamp).timestamp() * 1000)
    return {"instanceId": f"house-calls-{millis}", "session": "45-1", "scheduledTime": millis, "prior": list(prior)}


class HouseCollectorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.requests = Counter()
        self.failures = set()
        self.checked = CHECKED
        self.pages = {url: PARTICIPATE for url in PARTICIPATE_INDEX.values()}
        self.en = study_url("HESA", "13632808", "en")
        self.fr = study_url("HESA", "13632808", "fr")
        self.other = study_url("HUMA", "13666586", "en")
        self.pages.update({self.en: STUDY, self.other: STUDY, self.fr: BILL})
        for lang, urls in SENATE_CHECKS.items():
            for url in urls:
                self.pages[url] = "<html>" + ("Senate of Canada" if lang == "en" else "Sénat du Canada") + "</html>"

    async def fetch(self, url, chamber):
        self.requests[url] += 1
        if url in self.failures:
            raise PublisherUnavailable("Publisher returned HTTP 429.", url, 429)
        return self.pages[url].encode(), url

    async def collect(self, params=None):
        events = []
        ref = await acquire(self.store, self.fetch, params or request(), lambda: self.checked, events.append)
        return ref, json.loads(self.store.objects[ref["key"]]), events[0]

    async def test_interruption_resumes_first_observation_and_reuses_unreadable_senate_probe(self):
        senate = SENATE_CHECKS["fr"][0]
        self.failures.update((self.fr, senate))
        with self.assertRaisesRegex(RuntimeError, "House page unavailable"):
            await self.collect()
        self.assertFalse(any("/inventories/" in key for key in self.store.objects))
        self.pages[PARTICIPATE_INDEX["en"]] = "changed index after initial observation"
        self.failures.remove(self.fr)
        ref, packet, event = await self.collect()
        self.assertEqual((event["checkpointPages"], event["fetchedPages"], len(packet["calls"])), (4, 9, 3))
        missing = next(source for source in packet["sources"] if source["url"] == senate)
        self.assertEqual((missing["status"], missing["state"], missing["listing"]), (429, "unavailable", "unreadable"))
        self.assertNotIn("key", missing)
        counts = self.requests.copy()
        self.failures.clear()
        same, replayed, event = await self.collect()
        self.assertEqual((same, replayed, self.requests, event["checkpointPages"]), (ref, packet, counts, 13))

    async def test_corrupt_original_and_wrong_session_fail_before_publication(self):
        self.pages[self.fr] = BILL.replace("45e", "44e")
        with self.assertRaisesRegex(ValueError, "expected session"):
            await self.collect()
        self.pages[self.fr] = BILL
        self.store = MemoryStore()
        _, packet, _ = await self.collect()
        en = next(r for r in packet["sources"] if r["url"] == self.en)
        self.store.objects[en["key"]] = b"x" * en["bytes"]
        counts = self.requests.copy()
        with self.assertRaisesRegex(ValueError, "Corrupt archived"):
            await self.collect()
        self.assertEqual(counts, self.requests)

    async def test_new_observation_drops_only_missing_prior_and_pins_its_base(self):
        _, first, _ = await self.collect()
        prior = [{k: call[k] for k in ("id", "title", "language")} | {"metadata_json": json.dumps(call["metadata"])}
                 for call in first["calls"]]
        self.checked = "2026-11-26T12:00:00.123Z"
        self.pages[PARTICIPATE_INDEX["en"]] = PARTICIPATE.replace("studyActivityId=13666586", "removed=13666586")
        params = request(self.checked, prior)
        _, second, _ = await self.collect(params)
        dropped = [call for call in second["calls"] if not call["metadata"]["listed"]]
        original = next(row for row in first["calls"] if row["url"] == self.other)
        self.assertEqual(dropped, [original | {"metadata": original["metadata"] | {"listed": False}}])
        with self.assertRaisesRegex(ValueError, "Archive object conflict"):
            await self.collect(params | {"prior": []})
        prior = [{k: call[k] for k in ("id", "title", "language")} | {"metadata_json": json.dumps(call["metadata"])}
                 for call in second["calls"]]
        self.checked = "2026-11-27T12:00:00.123Z"
        _, third, _ = await self.collect(request(self.checked, prior))
        self.assertEqual(len(third["calls"]), 2)

    async def test_rejects_wrong_instance_wrong_date_and_foreign_destinations(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            await self.collect(request() | {"instanceId": "other"})
        with self.assertRaisesRegex(ValueError, "predates"):
            await self.collect(request("2026-11-26T12:00:00.123Z"))
        for url in ["https://www.ourcommons.ca.example.org/path", "https://user@www.ourcommons.ca/path",
                    "http://www.ourcommons.ca/path", "https://www.ourcommons.ca:8443/", "https://sencanada.ca/"]:
            with self.assertRaises(ValueError):
                publisher_url(url, "house")
