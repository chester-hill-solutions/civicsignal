"""Acquire and archive the Library's current-session bilingual summaries."""
import argparse
from collections import Counter
from hashlib import file_digest, sha256
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, command, serve  # noqa: E402


PREFIX = "weekly/library-summaries"
WORKSPACE = Path("/library-summaries")
SESSION = "45-1"


def read_sources(archive, bills, summaries):
    verified = {}
    for source in bills["sources"] + summaries["sources"]:
        key, size = source["sha256"], source["bytes"]
        if not re.fullmatch(r"[a-f0-9]{64}", key) or type(size) is not int or size < 1:
            raise ValueError("Invalid Library or LEGISinfo source reference")
        if key not in verified:
            path = archive / "sources" / "objects" / key[:2] / key
            with path.open("rb") as original:
                if file_digest(original, "sha256").hexdigest() != key:
                    raise ValueError("A retained Library or LEGISinfo original failed verification")
            verified[key] = path.stat().st_size
        if verified[key] != size:
            raise ValueError("The size of a retained Library or LEGISinfo original changed")
    return verified


def verify_documents(records, sources):
    refs = {}
    for source in sources:
        url = source["url"]
        ref = (source["sha256"], source["bytes"])
        if refs.setdefault(url, ref) != ref:
            raise ValueError("The Library inventory assigns conflicting originals to a source URL")
    for row in records:
        document = row["document"]
        url = document["url"]
        if document["status"] == "verified" or "sha256" in document or "bytes" in document:
            if url != row["pdfUrl"] or refs.get(url) != (document.get("sha256"), document.get("bytes")):
                raise ValueError("A retained Library PDF does not match the original for its listed URL")
        if document["status"] != "verified":
            continue
        if document["dateStatus"] == "catalogue-detail-confirmed":
            date_url = document["dateSourceUrl"]
            ref = refs.get(date_url)
            date = document.get("detailRevisionDate") or document.get("detailPublicationDate")
            if (date_url != row["url"] or not ref or ref[0] != document["dateSourceSha256"] or not date
                    or date != row["revisionDate"] or document["documentDate"] >= date):
                raise ValueError("The Library date corroboration does not match the archived detail page")
        elif document["dateStatus"] != "matched" or document["documentDate"] != row["revisionDate"]:
            raise ValueError("A verified Library PDF has no matching catalogue date evidence")


def verify(archive):
    bill_bytes = (archive / "bills.json").read_bytes()
    summary_bytes = (archive / "legislative-summaries.json").read_bytes()
    bills, summaries = json.loads(bill_bytes), json.loads(summary_bytes)
    records, acquisition = summaries["records"], summaries["documentAcquisition"]
    if (bills["session"] != SESSION or summaries["session"] != SESSION
            or bills["collection"] != "bills" or summaries["collection"] != "legislative-summaries"
            or not bills["sources"] or not summaries["sources"] or not records
            or summaries["billInventorySha256"] != sha256(bill_bytes).hexdigest()):
        raise ValueError("The Library inventory does not match the exact LEGISinfo source")
    verified = read_sources(archive, bills, summaries)
    statuses = Counter(row["document"]["status"] for row in records)
    languages = Counter(row["language"] for row in records)
    if (set(languages) != {"en", "fr"} or statuses["verified"] != acquisition["verifiedEditions"]
            or len(records) - statuses["verified"] != acquisition["gapEditions"]):
        raise ValueError("The Library document disposition counts do not match the inventory")
    verify_documents(records, summaries["sources"])
    coverage = summaries["coverage"]
    complete = (statuses["verified"] == len(records) and not coverage["unmatchedBills"]
                and not any(coverage["languageOnly"].values()) and not coverage["missingPdfLinks"])
    if acquisition["complete"] is not complete:
        raise ValueError("The Library inventory completeness flag does not match its coverage")
    return {
        "session": SESSION, "complete": complete, "observedAt": summaries["observedAt"],
        "listedEditions": len(records), "verifiedEditions": statuses["verified"],
        "bills": len({row["billNumber"] for row in records}), "languages": dict(languages),
        "documentStatuses": dict(statuses), "sourceObjectsVerified": len(verified),
        "inventorySha256": sha256(summary_bytes).hexdigest(), "billInventorySha256": summaries["billInventorySha256"],
        "coverage": coverage,
    }


def refresh(request):
    storage = Archive("http://archive.library-summaries.internal/", WORKSPACE, PREFIX)
    storage.restore(request["inputState"])
    archive = WORKSPACE / "archive"
    bills = archive / "bills.json"
    command("python3", "-B", "scripts/parliament-bills.py", "--session", SESSION, "--output", str(bills))
    command("python3", "-B", "scripts/library-legislative-summaries.py", "--bills", str(bills),
            "--output", str(archive / "legislative-summaries.json"), "--with-pdfs")
    result = verify(archive)
    state = storage.snapshot()
    ref = storage.document("reports", {**result, "scheduledTime": request["scheduledTime"], "workspace": state})
    if not result["complete"]:
        return {"status": "failed", "reason": "Library acquisition has unresolved catalogue or document gaps.", "report": ref}
    return {"state": state, "report": ref}


def identity(request):
    return f"library-summaries-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-archive", type=Path, help="Verify an independently restored Library archive")
    args = parser.parse_args()
    if args.verify_archive:
        print(json.dumps(verify(args.verify_archive)))
    else:
        serve(refresh, identity)
