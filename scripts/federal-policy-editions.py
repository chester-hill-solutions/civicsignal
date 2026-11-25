"""Verify dated Treasury Board editions identified by policy ID in official bibliography records."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
from importlib import import_module
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import parse_qs, urlsplit

from lib.federal_guidance import DEFAULT_ROOT as GUIDANCE, atomic_write

catalogue = import_module("federal-publication-catalogue")
pdf = import_module("departmental-report-documents")
extract_passages = import_module("eccc-passages").pdf_passages
ROOT = Path("data/corpus/federal-policy-editions")
POLICY_HOSTS = {"tbs-sct.gc.ca", "www.tbs-sct.gc.ca", "tbs-sct.canada.ca", "www.tbs-sct.canada.ca"}


def packed(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def catalogue_links(metadata, register):
    editions, documents = {}, {}
    for link in metadata.get("links", []):
        url = link["url"]
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            continue
        path = re.fullmatch(r"/pol/doc-(eng|fra)\.aspx", parsed.path, re.I)
        if parsed.hostname in POLICY_HOSTS and path:
            ids = parse_qs(parsed.query).get("id", [])
            if len(ids) == 1:
                key = (ids[0], "en" if path[1].lower() == "eng" else "fr")
                if key in register:
                    editions[key] = url
        if (parsed.hostname in {"publications.gc.ca", "www.publications.gc.ca"} and
                parsed.path.startswith("/collections/") and parsed.path.casefold().endswith(".pdf")):
            # The publisher's archive gateway canonicalizes repeated path separators.
            path = re.sub(r"/+", "/", parsed.path)
            documents[parsed._replace(scheme="https", path=path, fragment="").geturl()] = url
    return editions, documents


def candidates(db_path, guidance):
    receipt = json.loads((guidance / "dist/receipt.json").read_bytes())["inventory"]
    raw = Path(receipt["path"]).read_bytes()
    if sha256(raw).hexdigest() != receipt["sha256"]:
        raise ValueError("Policy index inventory hash mismatch")
    register = {}
    for row in json.loads(raw)["records"]:
        if row.get("policy_id"):
            register.setdefault((row["policy_id"], row["language"]), []).append(row)
    db = catalogue.open_reader(db_path)
    try:
        db.execute("BEGIN")
        identity, = db.execute("SELECT identity FROM publication").fetchone()
        rows = {}
        for src, cat_id, title, data in db.execute("""SELECT source,id,title,metadata FROM records
                WHERE source!='weekly-checklists' AND metadata LIKE '%tbs-s%id=%' ORDER BY source,id,rowid"""):
            meta = json.loads(data)
            editions, urls = catalogue_links(meta, register)
            for (policy_id, lang), policy_url in editions.items():
                for url, published_url in urls.items():
                    row = {"policyId": policy_id, "language": lang, "catalogueId": cat_id, "catalogueTitle": title,
                           "catalogueSource": src, "policyUrlInCatalogue": policy_url, "publishedPdfUrl": published_url,
                           "url": url, "datesIssued": meta["datesIssued"], "catalogueLanguages": meta["languages"],
                           "indexEntries": register[(policy_id, lang)],
                           "multiplePolicyIds": len({i for i, l in editions}) > 1}
                    rows[(src, cat_id, title, policy_id, lang, url)] = row
    finally:
        db.close()
    if not rows:
        raise ValueError("No official catalogue PDFs reference a registered policy ID")
    return {"bibliographyIdentity": identity, "policyInventory": receipt, "registeredLanguageIds": len(register)}, list(rows.values())


def normalize(text):
    folded = unicodedata.normalize("NFKD", text.casefold())
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in folded if not unicodedata.combining(c))))


def matches_title(row, text):
    expected = {"en": {"eng", "mul"}, "fr": {"fre", "fra", "mul"}}[row["language"]]
    if row["multiplePolicyIds"] or not expected.intersection(row["catalogueLanguages"]):
        return False
    terms = [normalize(title) for title in row["catalogueTitle"].split(" = ")]
    return any(len(term) >= 10 and term in text for term in terms)


def capture(root, url):
    try:
        body, final, _, _ = pdf.fetch_pdf(url)
        if not body.startswith(b"%PDF-"):
            raise ValueError("Publisher returned a non-PDF response")
        sections = extract_passages(body, final)
        if not sections:
            raise ValueError("PDF has no readable passages")
        body_sha = sha256(body).hexdigest()
        raw = packed(sections)
        text_sha = sha256(raw).hexdigest()
        document = {"sourceUrl": url, "finalUrl": final, "bodySha256": body_sha, "bodyBytes": len(body),
                    "object": pdf.store_gzip(root, body_sha, body, "objects"), "passagesSha256": text_sha,
                    "passageBytes": len(raw), "passages": pdf.store_gzip(root, text_sha, raw, "passages"),
                    "pagesWithText": len({p["page"] for p in sections}), "observedAt": stamp()}
        return {"status": "retrieved", "document": document}
    except (pdf.FetchError, OSError, ValueError, RuntimeError) as error:
        return {"status": "failed", "error": str(error)}


def read_passages(root, doc, replay=False):
    raw = pdf.read_gzip(root, doc["passages"], doc["passagesSha256"], doc["passageBytes"], 64 * 1024**2)
    items = json.loads(raw)
    if replay:
        original = pdf.read_gzip(root, doc["object"], doc["bodySha256"], doc["bodyBytes"], pdf.MAX_DOCUMENT_BYTES)
        if extract_passages(original, doc["finalUrl"]) != items:
            raise ValueError("Policy PDF passage replay differs from the archived edition")
    return items


def load_report(root, identity=None):
    if identity is None:
        identity = json.loads((root / "latest.json").read_bytes())["reportSha256"]
    if not re.fullmatch("[0-9a-f]{64}", identity):
        raise ValueError("Invalid report SHA-256")
    raw = (root / "reports" / (identity + ".json")).read_bytes()
    if sha256(raw).hexdigest() != identity:
        raise ValueError("Policy edition report hash mismatch")
    return json.loads(raw)


def refresh(root, db_path, guidance, workers):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        inputs, links = candidates(db_path, guidance)
        previous = load_report(root)["targets"] if (root / "latest.json").exists() else {}
        urls = sorted({c["url"] for c in links})
        with ThreadPoolExecutor(max_workers=workers) as pool:
            targets = dict(zip(urls, pool.map(lambda u: capture(root, u), urls), strict=True))
        title_text = {}
        for url, result in targets.items():
            if not result.get("document") and previous.get(url, {}).get("document"):
                result["document"] = previous[url]["document"]
            if result.get("document"):
                sections = read_passages(root, result["document"])
                title_text[url] = normalize(" ".join(p["text"] for p in sections if p["page"] <= 3))
        for row in links:
            row["titleCheck"] = "matched" if matches_title(row, title_text.get(row["url"], "")) else "review"
        summary = {"registeredLanguageIds": inputs["registeredLanguageIds"], "linkedPolicyLanguageIds":
                   len({(r["policyId"], r["language"]) for r in links}), "catalogueIds": len({r["catalogueId"] for r in links}),
                   "uniquePdfTargets": len(targets), "latestFetch": dict(Counter(t["status"] for t in targets.values())),
                   "catalogueEditionLinks": len(links), "titleChecks": dict(Counter(r["titleCheck"] for r in links))}
        report = {"scope": "Dated government bibliography editions referencing a policy identifier listed by Treasury Board. Index status describes the policy register observation.",
                  "observedAt": stamp(), "inputs": inputs, "summary": summary, "editions": links, "targets": targets}
        raw = packed(report)
        identity = sha256(raw).hexdigest()
        atomic_write(root / "reports" / (identity + ".json"), raw)
        pointer = {"reportSha256": identity, "summary": summary}
        atomic_write(root / "latest.json", packed(pointer))
        return pointer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    sub = parser.add_subparsers(dest="command", required=True)
    refresh_cmd = sub.add_parser("refresh")
    refresh_cmd.add_argument("--db", type=Path, default=catalogue.DATABASE)
    refresh_cmd.add_argument("--guidance", type=Path, default=GUIDANCE)
    refresh_cmd.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    replay = sub.add_parser("replay")
    replay.add_argument("--report")
    look = sub.add_parser("lookup")
    look.add_argument("--policy-id", required=True)
    look.add_argument("--language", choices=("en", "fr"), required=True)
    look.add_argument("--query", help="Search the archived dated edition and return page citations")
    look.add_argument("--limit", type=int, choices=range(1, 101), default=5)
    args = parser.parse_args()
    if args.command == "refresh":
        result = refresh(args.root, args.db, args.guidance, args.workers)
        print(json.dumps(result))
        return 2 if result["summary"]["latestFetch"].get("failed") or result["summary"]["titleChecks"].get("review") else 0
    report = load_report(args.root, getattr(args, "report", None))
    if args.command == "replay":
        text = {}
        for url, row in report["targets"].items():
            if row.get("document"):
                sections = read_passages(args.root, row["document"], replay=True)
                text[url] = normalize(" ".join(p["text"] for p in sections if p["page"] <= 3))
        for row in report["editions"]:
            if (row["titleCheck"] == "matched") != matches_title(row, text.get(row["url"], "")):
                raise ValueError("Archived policy title check differs from its receipt")
        print(json.dumps({"replayedTargets": len(text), "summary": report["summary"]}))
        return 0
    results = [{**edition, "archive": report["targets"][edition["url"]]} for edition in report["editions"]
               if edition["policyId"] == args.policy_id and edition["language"] == args.language]
    if args.query:
        for item in results:
            document = item["archive"].get("document")
            passages = read_passages(args.root, document) if document else []
            item["matchingPassages"] = [p for p in passages if args.query.casefold() in p["text"].casefold()][:args.limit]
    print(json.dumps(results, ensure_ascii=False))
    return int(not results)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, KeyError, ValueError, RuntimeError) as exc:
        sys.exit(f"Federal policy editions: {exc}")
