#!/usr/bin/env python3
"""Archive bilingual member-level roll calls for a Commons or Senate vote packet."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.parliament_intake import atomic_write, save_atomic
from lib.parliament_ballots import HOUSE_DETAIL, SENATE_DETAIL, parse_roll, reconcile

MAX_WORKERS = 4
LANGUAGES = ("en", "fr")


def _load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read vote inventory {path}: {exc}") from exc


def _validate_parent(payload):
    collection = payload.get("collection")
    mapping = {"house-votes": ("house", "house-roll-calls"), "senate-votes": ("senate", "senate-roll-calls")}
    if collection not in mapping:
        raise ValueError("--votes must point to a house-votes or senate-votes inventory")
    kind, out_collection = mapping[collection]
    session = payload.get("session")
    if not isinstance(session, str) or not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", session):
        raise ValueError("parent inventory has an invalid session")
    records = payload.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError("parent inventory has no vote records")
    by_vote = {}
    for row in records:
        if not isinstance(row, dict) or row.get("language") not in LANGUAGES:
            raise ValueError("parent inventory contains an invalid vote row or language")
        key = row.get("key")
        if not isinstance(key, str) or not re.fullmatch(r"[1-9][0-9]*", key):
            raise ValueError(f"parent inventory contains an invalid division key: {key!r}")
        details = row.get("details") or {}
        if details.get("kind") != collection.removesuffix("s"):
            # house-votes -> house-vote and senate-votes -> senate-vote
            raise ValueError(f"parent vote {key} does not match its {collection} collection")
        pair = by_vote.setdefault(key, {})
        if row["language"] in pair:
            raise ValueError(f"parent inventory duplicates {row['language']} division {key}")
        if not isinstance(row.get("url"), str) or not row.get("date") or not row.get("title"):
            raise ValueError(f"parent inventory division {key} lacks its official URL, title, or date")
        pair[row["language"]] = row
    for key, pair in by_vote.items():
        if set(pair) != set(LANGUAGES):
            raise ValueError(f"parent inventory division {key} is not bilingual")
        en, fr = pair["en"], pair["fr"]
        if en["date"] != fr["date"]:
            raise ValueError(f"parent inventory division {key} has mismatched bilingual dates")
        tally_fields = ("yeas", "nays", "paired") if collection == "house-votes" else ("yeas", "nays", "abstentions")
        if any(en["details"].get(field) != fr["details"].get(field) for field in tally_fields):
            raise ValueError(f"parent inventory division {key} has mismatched bilingual tally fields")
        if en["details"].get("kind") not in ("house-vote", "senate-vote"):
            raise ValueError(f"parent inventory division {key} has an unexpected vote kind")
    if kind == "house":
        expected_numbers = set(range(1, max(map(int, by_vote)) + 1))
        if set(map(int, by_vote)) != expected_numbers:
            raise ValueError(f"House parent inventory has a division sequence gap: {sorted(expected_numbers-set(map(int, by_vote)))[:10]}")
    return kind, out_collection, session, by_vote


def _page_cache(root):
    cache_path = root / "roll-call-page-cache.json"
    try:
        value = json.loads(cache_path.read_text(encoding="utf-8"))
        return cache_path, value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return cache_path, {}


def _fetch(url, cache_state):
    cache_path, cache = cache_state
    cached = cache.get(url)
    cached_body = None
    if isinstance(cached, dict) and re.fullmatch(r"[0-9a-f]{64}", cached.get("sha256", "")):
        object_path = cache_path.parent / "objects" / cached["sha256"][:2] / cached["sha256"]
        try:
            body = object_path.read_bytes()
            if sha256(body).hexdigest() == cached["sha256"]:
                cached_body = body
        except OSError:
            pass
    last_error = None
    for attempt in range(4):
        try:
            headers = {"Accept": "text/html", "User-Agent": "CivicSignal parliamentary roll-call archive/1.0"}
            if cached_body is not None:
                if cached.get("etag"):
                    headers["If-None-Match"] = cached["etag"]
                if cached.get("lastModified"):
                    headers["If-Modified-Since"] = cached["lastModified"]
            request = Request(url, headers=headers)
            with urlopen(request, timeout=60) as response:
                status = response.status
                body = response.read()
                final_url = response.geturl()
                validators = {"etag": response.headers.get("ETag"), "lastModified": response.headers.get("Last-Modified")}
            if status == 200:
                requested, final = urlsplit(url), urlsplit(final_url)
                if (requested.hostname, requested.path.rstrip("/"), requested.query) != (final.hostname, final.path.rstrip("/"), final.query):
                    raise ValueError(f"official source redirected away from the requested vote identity: {url} -> {final_url}")
            if status == 304 and cached_body is not None:
                return url, cached_body, cached["sha256"], cached
            if status != 200:
                raise ValueError(f"official source returned HTTP {status}: {url}")
            if not body.strip():
                raise ValueError(f"official source returned an empty page: {url}")
            digest = sha256(body).hexdigest()
            object_path = cache_path.parent / "objects" / digest[:2] / digest
            if not object_path.exists() or sha256(object_path.read_bytes()).hexdigest() != digest:
                atomic_write(object_path, body)
            meta = {"sha256": digest, "bytes": len(body), **{k: v for k, v in validators.items() if v}}
            return url, body, digest, meta
        except HTTPError as exc:
            if exc.code == 304 and cached_body is not None:
                return url, cached_body, cached["sha256"], cached
            if exc.code == 404:
                raise ValueError(f"official per-vote roll-call page is unavailable (HTTP 404; source gap): {url}") from exc
            if exc.code not in (408, 425, 429, 500, 502, 503, 504):
                raise ValueError(f"official source returned HTTP {exc.code}: {url}") from exc
            last_error = exc
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"transient source/network failure after four attempts for {url}: {last_error}")


def _expected_details(record):
    details = record["details"]
    if details["kind"] == "house-vote":
        return {"yeas": details.get("yeas"), "nays": details.get("nays"), "paired": details.get("paired")}
    return {"yeas": details.get("yeas"), "nays": details.get("nays"), "abstentions": details.get("abstentions")}


def _collect(payload, output):
    kind, collection, session, by_vote = _validate_parent(payload)
    root = Path(output).resolve().parent / "sources" / f"{kind}-roll-calls"
    root.mkdir(parents=True, exist_ok=True)
    cache_state = _page_cache(root)
    cache_path, cache = cache_state
    urls = {}
    for key, pair in by_vote.items():
        for language in LANGUAGES:
            record = pair[language]
            parliament, session_number = session.split("-", 1)
            expected = (HOUSE_DETAIL[language].format(language=language, parliament=parliament, session=session_number, number=key)
                        if kind == "house" else SENATE_DETAIL[language].format(number=key, session=session))
            if record["url"].rstrip("/").casefold() != expected.rstrip("/").casefold():
                raise ValueError(f"parent division {key} URL does not match the official {language} session route")
            urls[(key, language)] = expected

    parsed = {}
    errors = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_fetch, url, cache_state): ident for ident, url in urls.items()}
        for future in as_completed(futures):
            ident = futures[future]
            try:
                url, body, digest, cache_entry = future.result()
                cache[url] = cache_entry
                number, roster = parse_roll(body, ident[1], session, url, kind)
                if str(number) != ident[0]:
                    raise ValueError(f"source detail identity {number} does not match parent division {ident[0]}")
                parsed[ident] = {"url": url, "sha256": digest, "bytes": len(body), "roster": roster}
            except Exception as exc:
                errors.append((ident, exc))
    # Keep successful page mappings if another page failed. This lets a retry
    # reuse verified objects when the publisher supplies HTTP validators.
    if parsed:
        save_atomic(cache_path, cache)
    if errors:
        ident, exc = sorted(errors, key=lambda item: (int(item[0][0]), item[0][1]))[0]
        raise ValueError(f"failed to obtain {kind} roll call {ident[0]} ({ident[1]}): {exc}; {len(errors)} source request(s) failed") from exc

    sources, records = [], []
    for key in sorted(by_vote, key=int):
        pair = by_vote[key]
        editions = {}
        for language in LANGUAGES:
            item = parsed[(key, language)]
            sources.append({"url": item["url"], "sha256": item["sha256"], "bytes": item["bytes"]})
            editions[language] = item["roster"]
        reconcile(editions["en"], editions["fr"], _expected_details(pair["en"]), kind, key)
        for language in LANGUAGES:
            parent = pair[language]
            out_members = list(editions[language].values())
            records.append({
                "key": key, "language": language, "title": parent["title"],
                "summary": parent["summary"], "date": parent["date"],
                "url": urls[(key, language)],
                "details": {"kind": f"{kind}-roll-call", "members": out_members},
            })
    save_atomic(cache_path, cache)
    result = {
        "collection": collection, "session": session,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "parentInventory": {"collection": payload["collection"], "observedAt": payload.get("observedAt"), "sources": payload.get("sources", [])},
        "sources": sources, "records": records,
    }
    encoded = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode()
    digest = sha256(encoded).hexdigest()
    manifest_root = root / "manifests" / collection
    manifest_name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + digest + ".json"
    atomic_write(manifest_root / manifest_name, encoded)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--votes", required=True, help="parent House or Senate vote inventory JSON")
    parser.add_argument("--output", required=True, help="output packet JSON path")
    args = parser.parse_args(argv)
    try:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.with_suffix(output.suffix + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            payload = _load(args.votes)
            result = _collect(payload, output)
            save_atomic(output, result)
    except Exception as exc:
        parser.error(str(exc))
    print(f"Wrote {len(result['records'])} bilingual {result['collection']} records to {args.output}")


if __name__ == "__main__":
    main()
