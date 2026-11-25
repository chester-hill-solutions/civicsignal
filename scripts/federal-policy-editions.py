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


def catalogue_links(metadata):
    editions, documents = {}, {}
    urls = [link["url"] for link in metadata.get("links", [])]
    urls.extend(url for field in metadata.get("publicationLinks", []) for url in field["urls"])
    for url in urls:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            continue
        path = re.fullmatch(r"/pol/doc-(eng|fra)\.aspx", parsed.path, re.I)
        if parsed.hostname in POLICY_HOSTS and path:
            ids = parse_qs(parsed.query).get("id", [])
            if len(ids) == 1 and re.fullmatch(r"[0-9]+", ids[0]):
                key = (ids[0], "en" if path[1].lower() == "eng" else "fr")
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
                WHERE metadata LIKE '%tbs-s%id=%' ORDER BY source,id,rowid"""):
            meta = json.loads(data)
            editions, urls = catalogue_links(meta)
            if not editions or not urls:
                continue
            if src == "weekly-checklists":
                # Only a single policy and PDF in the same MARC record form a checklist citation.
                if len(editions) != 1 or len(urls) != 1:
                    continue
                dates = [date for field in meta["publicationStatements"] if field["function"] == "publication"
                         for date in field["dates"]]
                languages = meta["languageCodes"]
                provenance = {"checklistRecordSha256": meta["fingerprint"], "listedInIssues": meta["seenInIssues"]}
            else:
                dates, languages, provenance = meta["datesIssued"], meta["languages"], {}
            for (policy_id, lang), policy_url in editions.items():
                if (policy_id, lang) not in register:
                    continue
                for url, published_url in urls.items():
                    row = {"policyId": policy_id, "language": lang, "catalogueId": cat_id, "catalogueTitle": title,
                           "catalogueSource": src, "policyUrlInCatalogue": policy_url, "publishedPdfUrl": published_url,
                           "url": url, "datesIssued": dates, "catalogueLanguages": languages, **provenance,
                           "indexEntries": register[(policy_id, lang)],
                           "multiplePolicyIds": len({i for i, l in editions}) > 1}
                    rows[(src, cat_id, title, policy_id, lang, url, provenance.get("checklistRecordSha256"))] = row
    finally:
        db.close()
    if not rows:
        raise ValueError("No official catalogue PDFs reference a registered policy ID")
    return {"bibliographyIdentity": identity, "policyInventory": receipt, "registeredLanguageIds": len(register)}, list(rows.values())


def normalize(text):
    folded = unicodedata.normalize("NFKD", text.casefold())
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in folded if not unicodedata.combining(c))))


def has_unambiguous_language(row):
    expected = {"en": {"eng", "mul"}, "fr": {"fre", "fra", "mul"}}[row["language"]]
    return not row["multiplePolicyIds"] and bool(expected.intersection(row["catalogueLanguages"]))


def matches_title(row, text):
    if not has_unambiguous_language(row):
        return False
    terms = [normalize(title) for title in row["catalogueTitle"].split(" = ")]
    return any(len(term) >= 10 and term in text for term in terms)


def edition_identity(row, pages):
    if row["titleCheck"] == "matched":
        return {"verified": True, "method": "catalogue-title-first-three-pages"}
    if has_unambiguous_language(row):
        titles = [(title, title, "printed-catalogue-title") for title in row["catalogueTitle"].split(" = ")]
        for entry in row.get("indexEntries", []):
            label = entry["label"]
            # The register files titles under the subject, e.g. "Self-Insurance, Guideline on".
            ordered = " ".join(part.strip() for part in reversed(label.split(",")))
            titles.extend([(label, label, "printed-register-title"), (label, ordered, "printed-register-title")])
        for original, title, method in titles:
            term = normalize(title)
            if len(term) < 10:
                continue
            for passage in pages:
                if normalize(passage["text"]) == term:
                    return {"verified": True, "method": method, "sourceTitle": original,
                            "printedTitle": passage["text"], "page": passage["page"]}
    return {"verified": False, "method": "review"}


def verify_printed_heading(root, document, row, identity):
    if identity["verified"] or not document or not has_unambiguous_language(row):
        return identity
    original = pdf.read_gzip(root, document["object"], document["bodySha256"], document["bodyBytes"], pdf.MAX_DOCUMENT_BYTES)
    layout, _ = pdf.pdf_text(original)
    candidates = {normalize(title) for title in row["catalogueTitle"].split(" = ")}
    for page, text in enumerate(layout.split("\f"), 1):
        heading = next((line.strip() for line in text.splitlines() if line.strip()), "")
        if heading and len(normalize(heading)) >= 10 and normalize(heading) in candidates:
            return {"verified": True, "method": "printed-catalogue-heading", "page": page, "printedTitle": heading}
    return identity


def capture(root, url):
    try:
        body, final, status, media = pdf.fetch_pdf(url)
        if not body.startswith(b"%PDF-"):
            notice = media == "text/html" and pdf.public_archive_continue(body, url, final) == url
            return {"status": "failed", "error": "Publisher returned a non-PDF response",
                    "httpStatus": status, "finalUrl": final, "mediaType": media,
                    "responseBytes": len(body), "responseSha256": sha256(body).hexdigest(),
                    "publicationNotice": notice}
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
        return {"status": "failed", "error": str(error), "httpStatus": getattr(error, "status", None)}


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
        # A publisher notice can survive its first continuation during a bulk capture.
        # Revisit that exact public link, or a transient upstream error, once at the end.
        for url, result in targets.items():
            if result.get("httpStatus") in {500, 502, 503, 504} or result.get("publicationNotice"):
                targets[url] = {**capture(root, url), "initialError": result["error"], "initialAttempt": result}
        opening_pages = {}
        for url, result in targets.items():
            if not result.get("document") and previous.get(url, {}).get("document"):
                result["document"] = previous[url]["document"]
            if result.get("document"):
                sections = read_passages(root, result["document"])
                opening_pages[url] = [p for p in sections if p["page"] <= 10]
        for row in links:
            pages = opening_pages.get(row["url"], [])
            front = normalize(" ".join(p["text"] for p in pages if p["page"] <= 3))
            row["titleCheck"] = "matched" if matches_title(row, front) else "review"
            row["editionIdentity"] = verify_printed_heading(root, targets[row["url"]].get("document"), row, edition_identity(row, pages))
        summary = {"registeredLanguageIds": inputs["registeredLanguageIds"], "linkedPolicyLanguageIds":
                   len({(r["policyId"], r["language"]) for r in links}), "catalogueIds": len({r["catalogueId"] for r in links}),
                   "uniquePdfTargets": len(targets), "latestFetch": dict(Counter(t["status"] for t in targets.values())),
                   "catalogueEditionLinks": len(links), "titleChecks": dict(Counter(r["titleCheck"] for r in links))}
        summary["editionIdentityChecks"] = dict(Counter(row["editionIdentity"]["method"] for row in links))
        report = {"schemaVersion": 3, "scope": "Dated government bibliography editions referencing a policy identifier listed by Treasury Board. Index status describes the policy register observation.",
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
        return 2 if result["summary"]["latestFetch"].get("failed") or result["summary"]["editionIdentityChecks"].get("review") else 0
    report = load_report(args.root, getattr(args, "report", None))
    if args.command == "replay":
        opening_pages = {}
        for url, row in report["targets"].items():
            if row.get("document"):
                sections = read_passages(args.root, row["document"], replay=True)
                opening_pages[url] = [p for p in sections if p["page"] <= 10]
        for row in report["editions"]:
            pages = opening_pages.get(row["url"], [])
            front = normalize(" ".join(p["text"] for p in pages if p["page"] <= 3))
            if (row["titleCheck"] == "matched") != matches_title(row, front):
                raise ValueError("Archived policy title check differs from its receipt")
            if report.get("schemaVersion", 1) >= 2:
                identity = edition_identity(row, pages)
                if report["schemaVersion"] >= 3:
                    identity = verify_printed_heading(args.root, report["targets"][row["url"]].get("document"), row, identity)
                if row["editionIdentity"] != identity:
                    raise ValueError("Archived policy identity evidence differs from its printed source")
        print(json.dumps({"replayedTargets": len(opening_pages), "summary": report["summary"]}))
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
