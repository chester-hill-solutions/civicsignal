"""Follow the original files and chapters explicitly cited by committee report and response pages."""

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import hashlib
from pathlib import Path
from urllib.parse import urldefrag, urlsplit

from lib.committee_files import cache_db, capture, download_urls, fetch_url, official, read_object
from lib.committee_inventory import Inventory, classify
from lib.committee_study_sources import StudyCitations, publication_facts
from lib.committee_publications import publication_parts
from lib.wq_catalog import save_atomic


def capture_new_linked_originals(root, urls, catalogue_urls, checked_urls, workers):
    """Refresh each expansion-only URL once, excluding sources refreshed by catalogue download."""
    candidates = sorted({fetch_url(url) for url in urls} - catalogue_urls - checked_urls)
    if candidates:
        capture(root, candidates, workers, refresh=True)
        checked_urls.update(candidates)
    return candidates


def expand(root, catalogue, workers, refresh_linked_originals=False):
    catalogue_data = json.loads(catalogue.read_text())
    model = Inventory(catalogue_data)
    catalogue_urls = set(download_urls(catalogue_data)) if refresh_linked_originals else set()
    checked_linked_urls = set()
    db = cache_db(root)
    files = {r["url"]: dict(r) for r in db.execute("SELECT * FROM files")}
    db.close()
    study_sources = []
    source_digests = {}
    additional = set()
    for (lang, rid), row in list(model.records.items()):
        if row["kind"] != "study" or "studyactivityid=" not in row["url"].lower():
            continue
        raw = files.get(urldefrag(row["url"])[0])
        if not raw or not raw["digest"]:
            continue
        parser = StudyCitations(
            row["url"], model.session, row["committee_id"].split("-", 1)[1], lang
        )
        source_digests[urldefrag(row["url"])[0]] = raw["digest"]
        parser.feed(read_object(root, raw["digest"]).decode("utf-8", "replace"))
        parser.close()
        pubs = [
            {"kind": "publication", "url": u, "studyUrl": row["url"]}
            for u in sorted(parser.publications)
        ]
        for item in pubs:
            item["kind"] = classify(item)
        model.page(row["url"], {"links": pubs, "url": row["url"]})
        study_sources.append(
            {
                "language": lang,
                "studyId": rid,
                "url": row["url"],
                "sourceHash": raw["digest"],
                "billUrls": sorted(parser.bills),
                "reportEvents": parser.events,
                "publications": pubs,
            }
        )
        additional.update(item["url"] for item in pubs
                          if refresh_linked_originals or item["url"] not in files)
    if refresh_linked_originals:
        capture_new_linked_originals(root, additional, catalogue_urls, checked_linked_urls, workers)
    elif additional:
        capture(root, sorted(additional), workers)
    queue = {
        (lang, rid, urldefrag(url)[0])
        for (lang, rid), url in model.wanted.items()
        if model.records[lang, rid]["kind"] in ("report", "government-response")
        or urlsplit(url).hostname == "publications.gc.ca"
    }
    seen = set()
    parents = {}
    while queue:
        db = cache_db(root)
        files = {r["url"]: dict(r) for r in db.execute("SELECT * FROM files")}
        db.close()
        scan = {}
        for lang, parent, url in sorted(queue):
            key = lang, parent, url
            if key in seen:
                continue
            seen.add(key)
            record = files.get(url)
            if not record or not record["digest"] or "html" not in record["media"]:
                continue
            parts = publication_parts(read_object(root, record["digest"]), url)
            source_digests[url] = record["digest"]
            children = parents.setdefault((lang, parent), {})
            for item in parts:
                child = urldefrag(item["url"])[0]
                if not official(child):
                    continue
                if child == url:
                    if item["url"] != url:
                        children[item["url"]] = dict(item, sourcePage=url)
                    continue
                children[child] = dict(item, url=child, sourcePage=url)
                scan[lang, parent, child] = True
        queue = set(scan) - seen
        if refresh_linked_originals:
            work = {url for _, _, url in queue}
            capture_new_linked_originals(root, work, catalogue_urls, checked_linked_urls, workers)
        else:
            work = sorted(
                {url for _, _, url in queue if not files.get(url, {}).get("digest")}
            )
            if work:
                capture(root, work, workers)
    facts = []
    tasks = []
    for (lang, rid), url in model.wanted.items():
        row = model.records[lang, rid]
        original = files.get(urldefrag(url)[0])
        if (
            row["kind"] in {"notice", "minutes", "report", "government-response"}
            and original
            and original["digest"]
            and "html" in original["media"]
        ):
            tasks.append((root, lang, rid, url, original["digest"]))
            source_digests[urldefrag(url)[0]] = original["digest"]
    version = hashlib.sha256(
        (Path(__file__).parent / "lib/committee_publications.py").read_bytes()
    ).hexdigest()
    db = cache_db(root)
    db.execute("""CREATE TABLE IF NOT EXISTS publication_facts(digest TEXT, url TEXT, language TEXT,
        version TEXT, facts_json TEXT, PRIMARY KEY(digest,url,language,version))""")
    remaining = []
    for task in tasks:
        _, lang, rid, url, digest = task
        stored = db.execute(
            "SELECT facts_json FROM publication_facts WHERE digest=? AND url=? AND language=? AND version=?",
            (digest, url, lang, version),
        ).fetchone()
        if stored is None:
            remaining.append(task)
        elif stored[0] != "{}":
            facts.append(
                dict(
                    language=lang,
                    id=rid,
                    url=url,
                    digest=digest,
                    facts=json.loads(stored[0]),
                )
            )
    print(
        "Publication metadata:",
        len(remaining),
        "of",
        len(tasks),
        "need extraction",
        flush=True,
    )
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending = []
        for row in pool.map(publication_facts, remaining, chunksize=8):
            pending.append(
                (
                    row["digest"],
                    row["url"],
                    row["language"],
                    version,
                    json.dumps(row["facts"], ensure_ascii=False),
                )
            )
            if row["facts"]:
                facts.append(row)
            if len(pending) >= 64:
                with db:
                    db.executemany(
                        "INSERT OR REPLACE INTO publication_facts VALUES(?,?,?,?,?)",
                        pending,
                    )
                pending.clear()
        with db:
            db.executemany(
                "INSERT OR REPLACE INTO publication_facts VALUES(?,?,?,?,?)", pending
            )
    db.close()
    result = {
        "session": model.session,
        "cutoff": model.cutoff,
        "sourceDigests": source_digests,
        "studySources": study_sources,
        "publicationFacts": sorted(
            facts, key=lambda fact: (fact["language"], fact["id"])
        ),
        "parents": [
            {"language": lang, "parentId": rid, "children": list(children.values())}
            for (lang, rid), children in sorted(parents.items())
            if children
        ],
    }
    save_atomic(root / "publication-parts.json", result)
    print("Publication parents with linked parts:", len(result["parents"]))
    print(
        "Distinct part URLs:",
        len({p["url"] for row in result["parents"] for p in row["children"]}),
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path("data/corpus/committees"))
    p.add_argument("--catalogue", type=Path)
    p.add_argument("--workers", type=int, default=4, choices=range(1, 13))
    p.add_argument("--refresh-linked-originals", action="store_true",
                   help="Refresh each expansion-discovered original once; skip URLs already refreshed from the catalogue.")
    args = p.parse_args()
    expand(args.root, args.catalogue or args.root / "catalogue.json", args.workers, args.refresh_linked_originals)
