"""One replayable House call observation from the two indexes, all studies and Senate probes."""
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from html import unescape
import json
import re
from urllib.parse import urlsplit

from committee_calls import (
    PARTICIPATE_INDEX, SENATE_CHECKS, build_call, call_id, call_observation_time, classify_senate_probe,
    committee_id, dropped_call_metadata, parse_call_editions, parse_call_indexes, study_url,
)

PREFIX = "committee/house-calls"
SESSION = "45-1"
PAGE_LIMIT = 2 * 1024 * 1024
SOURCE_BUDGET = 24 * 1024 * 1024
PACKET_LIMIT = 4 * 1024 * 1024
REQUEST_LIMIT = 2 * 1024 * 1024
CHECKPOINT_LIMIT = 8192
STUDY_LIMIT = 256
PRIOR_LIMIT = 1024
CONCURRENCY = 4
DIGEST = re.compile(r"[a-f0-9]{64}")
HOSTS = {"house": {"www.ourcommons.ca", "ourcommons.ca", "www.noscommunes.ca", "noscommunes.ca"},
         "senate": {"sencanada.ca", "www.sencanada.ca"}}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def publisher_url(url, chamber):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in HOSTS[chamber] or parsed.username is not None
            or parsed.password is not None or parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError(f"Unexpected {chamber} publisher destination.")
    return url


def read_request(params):
    if not isinstance(params, dict) or set(params) != {"session", "instanceId", "scheduledTime", "prior"}:
        raise ValueError("Expected a House calls observation request.")
    scheduled = params["scheduledTime"]
    if (params["session"] != SESSION or type(scheduled) is not int or not 0 < scheduled < 4102444800000
            or params["instanceId"] != f"house-calls-{scheduled}"):
        raise ValueError("Invalid House calls observation identity.")
    if not isinstance(params["prior"], list) or len(params["prior"]) > PRIOR_LIMIT:
        raise ValueError("Invalid House calls prior rows.")
    prior = {}
    for row in params["prior"]:
        if not isinstance(row, dict) or set(row) != {"id", "language", "title", "metadata_json"}:
            raise ValueError("Incomplete House calls prior row.")
        if not all(isinstance(value, str) and value for value in row.values()):
            raise ValueError("Invalid House calls prior row fields.")
        metadata = json.loads(row["metadata_json"])
        if not isinstance(metadata, dict):
            raise ValueError("Invalid prior House call metadata.")
        observed = metadata.get("observedAt")
        if not isinstance(observed, str) or datetime.fromisoformat(observed).utcoffset() is None:
            raise ValueError("Invalid prior House call observation time.")
        code, study = metadata.get("committeeCode"), metadata.get("studyId")
        if (not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9]+", code)
                or not isinstance(study, str) or not re.fullmatch(r"[0-9]+", study)
                or row["id"] != call_id(code, study) or row["language"] not in PARTICIPATE_INDEX):
            raise ValueError("Invalid prior House call identity.")
        key = row["id"], row["language"]
        if key in prior:
            raise ValueError("Duplicate prior House call edition.")
        prior[key] = {"title": row["title"], "metadata": metadata}
    return prior


def checked_instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z", value):
        raise ValueError("Invalid archived publisher request time.")
    return datetime.fromisoformat(value)


def desired_calls(editions, prior, observed):
    present = set()
    results = []
    for edition in editions:
        study, lang = edition["study"], edition["language"]
        key = call_id(study["committee"], study["study_id"]), lang
        present.add(key)
        results.append(build_call(session=SESSION, language=lang, committee=study["committee"],
                                  study_id=study["study_id"], listed_title=study["title"],
                                  observed_at=observed, parsed=edition["parsed"], existing=prior.get(key),
                                  conflict=bool(edition["shares_with"])))
    for (identifier, lang), previous in prior.items():
        if (identifier, lang) in present:
            continue
        meta = dropped_call_metadata(previous["metadata"])
        if meta is not None:
            code, study = meta["committeeCode"], meta["studyId"]
            results.append({"session": SESSION, "id": identifier, "language": lang, "kind": "call",
                            "chamber": "house", "committee_id": committee_id(code), "title": previous["title"],
                            "url": study_url(code, study, lang), "status": "indexed", "metadata": meta})
    return sorted(results, key=lambda call: (call["id"], call["language"]))


class PublisherUnavailable(Exception):
    def __init__(self, message, resolved_url=None, status=None):
        super().__init__(message)
        self.resolved_url = resolved_url
        self.status = status


class HousePublisherForbidden(RuntimeError):
    """A required, identified House publisher request returned HTTP 403."""

    def __init__(self, url):
        super().__init__(f"Required House publisher returned HTTP 403: {url}")
        self.url = url


async def capture(store, fetch, instance, chamber, lang, url, clock):
    publisher_url(url, chamber)
    pin = f"{PREFIX}/observations/{instance}/pages/{sha256(url.encode()).hexdigest()}.json"
    saved = await store.read(pin, CHECKPOINT_LIMIT)
    fresh = saved is None
    body = None
    if fresh:
        ref = {"url": url, "chamber": chamber, "language": lang, "checked": clock()}
        try:
            body, resolved = await fetch(url, chamber)
            publisher_url(resolved, chamber)
            if not isinstance(body, bytes) or not 0 < len(body) <= PAGE_LIMIT:
                raise ValueError(f"Invalid publisher body: {url}")
            if chamber == "senate":
                brand = "Senate of Canada" if lang == "en" else "Sénat du Canada"
                if brand.casefold() not in unescape(body.decode("utf-8", "replace")).casefold():
                    raise PublisherUnavailable("Unrecognized Senate publisher page.", resolved, 200)
        except PublisherUnavailable as error:
            if chamber == "house":
                if error.status == 403 and error.resolved_url == url:
                    raise HousePublisherForbidden(url) from error
                raise RuntimeError(f"Required House page unavailable: {url}: {error}") from error
            body = None
            ref.update(state="unavailable", error=str(error), listing="unreadable")
            if error.resolved_url:
                ref["resolvedUrl"] = publisher_url(error.resolved_url, chamber)
            if error.status is not None:
                ref["status"] = error.status
        else:
            digest = sha256(body).hexdigest()
            key = f"{PREFIX}/sources/{digest}.html"
            await store.archive(key, body, digest)
            ref.update(state="archived", resolvedUrl=resolved, status=200, sha256=digest, bytes=len(body), key=key)
            if chamber == "senate":
                ref["listing"] = classify_senate_probe(body.decode("utf-8", "replace"))
        raw = encode(ref)
        if len(raw) > CHECKPOINT_LIMIT:
            raise ValueError("House source checkpoint exceeds its byte limit.")
        if await store.create(pin, raw, sha256(raw).hexdigest()):
            saved = raw
        else:
            saved = await store.read(pin, CHECKPOINT_LIMIT)
            body = None
    if saved is None:
        raise ValueError(f"Missing observation checkpoint: {url}")
    ref = json.loads(saved)
    if (ref.get("url"), ref.get("language"), ref.get("chamber")) != (url, lang, chamber):
        raise ValueError("Publisher checkpoint identity mismatch.")
    checked_instant(ref.get("checked"))
    if ref.get("resolvedUrl"):
        publisher_url(ref["resolvedUrl"], chamber)
    if (chamber == "senate" and ref.get("state") == "unavailable" and ref.get("listing") == "unreadable"
            and ref.get("error") and not any(k in ref for k in ("key", "bytes", "sha256"))):
        return None, ref, fresh
    digest = ref.get("sha256", "")
    if (ref.get("state") != "archived" or ref.get("status") != 200 or not ref.get("resolvedUrl")
            or not DIGEST.fullmatch(digest) or ref.get("key") != f"{PREFIX}/sources/{digest}.html"
            or type(ref.get("bytes")) is not int or not 0 < ref["bytes"] <= PAGE_LIMIT):
        raise ValueError("Invalid publisher source checkpoint.")
    if body is None:
        body = await store.read(ref["key"], ref["bytes"])
    if body is None or len(body) != ref["bytes"] or sha256(body).hexdigest() != digest:
        raise ValueError(f"Corrupt archived publisher source: {url}")
    markup = body.decode("utf-8", "replace")
    if chamber == "senate" and ref.get("listing") != classify_senate_probe(markup):
        raise ValueError("Archived Senate classification mismatch.")
    return markup, ref, fresh


async def acquire(store, fetch, params, clock=now, on_complete=None):
    prior = read_request(params)
    instance = params["instanceId"]
    # One instance must retain its original base even if another Workflow publishes in between attempts.
    ordered = [[key[0], key[1], prior[key]] for key in sorted(prior)]
    prior_hash = sha256(encode(ordered)).hexdigest()
    base = encode({"priorSha256": prior_hash, "session": SESSION, "scheduledTime": params["scheduledTime"]})
    await store.archive(f"{PREFIX}/observations/{instance}/base.json", base, sha256(base).hexdigest())
    refs, bodies = {}, {}
    total = fetched = 0
    async def group(targets):
        nonlocal total, fetched
        for offset in range(0, len(targets), CONCURRENCY):
            chunk = targets[offset:offset + CONCURRENCY]
            values = await asyncio.gather(*(capture(store, fetch, instance, chamber, lang, url, clock)
                                          for chamber, lang, url in chunk), return_exceptions=True)
            for (chamber, _, url), value in zip(chunk, values):
                if isinstance(value, BaseException):
                    raise value
                body, ref, fresh = value
                scheduled = datetime.fromtimestamp(params["scheduledTime"] / 1000, timezone.utc)
                if checked_instant(ref["checked"]) < scheduled:
                    raise ValueError("Publisher checkpoint predates its scheduled observation.")
                fetched += int(fresh)
                refs[url] = ref
                total += ref.get("bytes", 0)
                if total > SOURCE_BUDGET:
                    raise ValueError("House calls observation exceeds its source byte budget.")
                if chamber == "house":
                    bodies[url] = body
    await group([("house", lang, url) for lang, url in PARTICIPATE_INDEX.items()])
    listings = parse_call_indexes(bodies)
    studies = [("house", lang, study_url(s["committee"], s["study_id"], lang))
               for lang, items in listings.items() for s in items]
    if len(studies) > STUDY_LIMIT:
        raise ValueError("House study listing exceeds its URL budget.")
    await group(studies)
    editions = parse_call_editions(SESSION, listings, bodies)
    bodies.clear()
    latest = max((row["metadata"]["observedAt"] for row in prior.values()), key=datetime.fromisoformat, default=None)
    observed = call_observation_time(refs.values(), latest)
    if latest is not None and datetime.fromisoformat(observed) <= datetime.fromisoformat(latest):
        # The same prior base is pinned across retries. An older set of captured
        # House pages must never overwrite a later published listing.
        raise ValueError("House observation did not advance the supplied base.")
    calls = desired_calls(editions, prior, observed)
    await group([("senate", lang, url) for lang, urls in SENATE_CHECKS.items() for url in urls])
    sources = sorted(refs.values(), key=lambda r: (r["chamber"], r["language"], r["url"]))
    packet = {"instanceId": instance, "session": SESSION, "scheduledTime": params["scheduledTime"],
              "observedAt": observed, "calls": calls, "sources": sources, "priorSha256": prior_hash}
    encoded = encode(packet)
    if len(encoded) > PACKET_LIMIT:
        raise ValueError("House calls inventory exceeds its byte limit.")
    digest = sha256(encoded).hexdigest()
    key = f"{PREFIX}/inventories/{digest}.json"
    await store.archive(key, encoded, digest)
    if on_complete:
        on_complete({"event": "house-calls-acquisition-complete", "instanceId": instance, "observedAt": observed,
                     "fetchedPages": fetched, "checkpointPages": len(refs) - fetched, "sourceBytes": total,
                     "houseEditions": len(editions), "senateUnreadable": sum(s.get("listing") == "unreadable" for s in sources),
                     "inventorySha256": digest})
    return {"key": key, "sha256": digest, "bytes": len(encoded)}
