"""Acquire and verify a private archive of bilingual parliamentary agendas."""
import argparse
from datetime import date, datetime
from hashlib import file_digest, sha256
import json
from pathlib import Path
import re
from subprocess import TimeoutExpired
import sys
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, command, serve  # noqa: E402


SESSION = "45-1"
WORKSPACE = Path("/chamber-agenda")
CHAMBERS = {"house": {"www.ourcommons.ca", "www.noscommunes.ca"}, "senate": {"sencanada.ca"}}
LANGUAGES = ("en", "fr")
MANIFEST = "agenda.json"


def prefix(chamber):
    return f"weekly/chamber-agenda-{chamber}"


def identity(request):
    chamber = request["chamber"]
    if chamber not in CHAMBERS:
        raise ValueError("Unknown agenda chamber")
    return f"chamber-agenda-{chamber}-{request['scheduledTime']}", prefix(chamber)


def verify_sources(archive, sources, chamber):
    verified, urls = {}, {}
    for source in sources:
        url, key, size = source["url"], source["sha256"], source["bytes"]
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.netloc not in CHAMBERS[chamber] or parsed.fragment
                or not re.fullmatch(r"[a-f0-9]{64}", key) or type(size) is not int or size < 1):
            raise ValueError("Invalid agenda source reference")
        if urls.setdefault(url, (key, size)) != (key, size):
            raise ValueError("The agenda inventory assigns conflicting originals to a source URL")
        if key not in verified:
            original = archive / "sources" / "objects" / key[:2] / key
            if original.resolve() != original or not original.is_file() or original.stat().st_size != size:
                raise ValueError("Missing or incorrectly sized agenda original")
            with original.open("rb") as stream:
                if file_digest(stream, "sha256").hexdigest() != key:
                    raise ValueError("An archived agenda original failed verification")
            verified[key] = size
        if verified[key] != size:
            raise ValueError("Conflicting sizes for an archived agenda original")
    return urls, len(verified)


def edition_identity(row, chamber, sources):
    raw_key, language = row["key"], row["language"]
    if chamber == "house":
        details = row["details"]
        kind, sitting, doc_id = details["kind"], details["sitting"], details["publisherDocumentId"]
        page = details.get("page")
        urls = (row["sourceUrl"],)
        if kind not in {"contents", "listed", "noticed", "projected"}:
            raise ValueError("Unknown House agenda record type")
        if kind in {"listed", "noticed"} and not page or kind in {"contents", "projected"} and page is not None:
            raise ValueError("The House agenda record does not identify its section correctly")
        if raw_key != f"{SESSION}:{sitting}:{kind}:{language}" + (f":{page}" if page else "") or not doc_id:
            raise ValueError("The House agenda record key differs from its official edition identity")
        shared_key = (sitting, kind, page)
    else:
        kind = "contents"
        sitting = str(row["issue"])
        doc_id = None
        urls = (row["url"], row["indexUrl"], row["pdfUrl"])
        if raw_key != sitting:
            raise ValueError("The Senate agenda record key differs from its official edition identity")
        shared_key = sitting
    if not all(url in sources for url in urls):
        raise ValueError("An agenda record points to an unarchived original")
    number = re.fullmatch(r"([1-9][0-9]*)([A-Z]?)", sitting)
    if not number or not row["title"].strip() or (chamber == "senate" and number[2]):
        raise ValueError("Invalid agenda edition identity")
    return shared_key, (kind, date.fromisoformat(row["date"]).isoformat(), int(number[1]), number[2], doc_id)


def verify(archive, chamber):
    archive = archive.resolve(strict=True)
    contents = (archive / MANIFEST).read_bytes()
    packet = json.loads(contents)
    collection = f"{chamber}-agenda"
    rows, sources = packet["records"], packet["sources"]
    if packet["collection"] != collection or packet["session"] != SESSION or not rows or not sources:
        raise ValueError("The retained agenda manifest has the wrong identity or no records")
    if datetime.fromisoformat(packet["observedAt"]).utcoffset() is None:
        raise ValueError("The agenda observation must include a timezone")
    inventory_hash = sha256(contents).hexdigest()
    inventory = archive / "sources" / "inventories" / collection / f"{inventory_hash}.json"
    if inventory.resolve() != inventory or inventory.read_bytes() != contents:
        raise ValueError("The agenda inventory differs from its archived copy")

    urls, verified = verify_sources(archive, sources, chamber)
    editions = {language: {} for language in LANGUAGES}
    for row in rows:
        language = row["language"]
        key, edition = edition_identity(row, chamber, urls)
        if language not in editions or key in editions[language]:
            raise ValueError("Invalid or duplicate agenda edition key")
        editions[language][key] = edition
    if editions["en"] != editions["fr"]:
        raise ValueError("Agenda record identities differ between published languages")

    items = editions["en"].values()
    kinds = {item[0] for item in items}
    expected = {"contents", "listed", "noticed", "projected"} if chamber == "house" else {"contents"}
    if kinds != expected:
        raise ValueError("The agenda manifest does not cover the expected document types")
    if chamber == "house" and len({item[1:] for item in items if item[0] != "projected"}) != 1:
        raise ValueError("House agenda sections do not belong to the same paper")
    latest = {}
    for name, kind in (("paper", "contents"), ("projected", "projected")):
        if kind in kinds:
            day, number, suffix = max(item[1:4] for item in items if item[0] == kind)
            latest[name] = {"number": number, "date": day}
            if suffix:
                latest[name]["suffix"] = suffix
    return {"collection": collection, "observedAt": packet["observedAt"], "inventorySha256": inventory_hash,
            "records": len(rows), "languages": {language: len(pairs) for language, pairs in editions.items()},
            "sources": len(sources), "sourceObjectsVerified": verified, "latest": latest}


def refresh(request):
    chamber = request["chamber"]
    storage = Archive(f"http://archive.{chamber}-agenda.internal/", WORKSPACE, prefix(chamber))
    report = {"chamber": chamber, "session": SESSION, "scheduledTime": request["scheduledTime"],
              "inputState": request["inputState"], "phase": "restore"}
    try:
        storage.restore(request["inputState"])
        archive = WORKSPACE / "archive"
        previous = verify(archive, chamber) if (archive / MANIFEST).exists() else None
        report["phase"] = "acquire"
        options = ("--latest",) if chamber == "house" else ()
        command("python3", "-B", f"scripts/parliament-{chamber}-agenda.py", "--session", SESSION,
                *options, "--output", str(archive / MANIFEST), timeout=540)
        report["phase"] = "verify"
        report.update(verify(archive, chamber))
        if previous:
            for kind, row in report["latest"].items():
                prior = previous["latest"][kind]
                if (row["date"] < prior["date"]
                        or (row["number"], row.get("suffix", "")) < (prior["number"], prior.get("suffix", ""))):
                    raise ValueError("The publisher returned an older agenda edition")
        report["phase"] = "archive"
        state = storage.snapshot()
    except (OSError, RuntimeError, ValueError, AttributeError, KeyError, TypeError, TimeoutExpired) as error:
        reason = f"{report['phase']}: {error}"[-2600:]
        report.update(complete=False, reason=reason)
        return {"status": "failed", "reason": reason, "report": storage.document("reports", report)}
    report.update(complete=True, phase="complete", workspace=state)
    return {"state": state, "report": storage.document("reports", report)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-archive", type=Path, help="Verify an independently restored agenda archive")
    parser.add_argument("--chamber", choices=CHAMBERS, help="Specify the chamber of an independently restored archive")
    args = parser.parse_args()
    if args.verify_archive is not None and args.chamber:
        print(json.dumps(verify(args.verify_archive, args.chamber)))
    elif args.verify_archive is not None or args.chamber:
        parser.error("--verify-archive and --chamber must be supplied together")
    else:
        serve(refresh, identity)
