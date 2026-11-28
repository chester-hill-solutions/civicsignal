"""Acquire and replay the bilingual Senate committee directory for session 45-1."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import runpy
import sys
import tempfile
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, ROOT, canonical, command, digest, serve  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
CATALOGUE = runpy.run_path(str(ROOT / "scripts/committee-catalogue.py"))
PREFIX = "weekly/committee-senate"
GATEWAY = "http://archive.committee-senate.internal/"
WORKSPACE = Path("/committee-senate")
SESSION = "45-1"
SCOPE = "bilingual-senate-committee-directory"
LANGUAGES = ("en", "fr")
MAX_SOURCE_BYTES = 1024 * 1024


def fetch_directory(language):
    url = CATALOGUE["senate_directory_url"](language)
    with tempfile.TemporaryDirectory(prefix="senate-directory-") as temporary:
        original = Path(temporary) / "directory.html"
        status = command(
            "curl", "--silent", "--show-error", "--max-time", "30", "--proto", "=https",
            "--max-filesize", str(MAX_SOURCE_BYTES), "--user-agent", "CivicSignal committee catalogue/1.0",
            "--output", str(original), "--write-out", "%{http_code}", url, timeout=35,
        )
        if status != "200" or not 0 < original.stat().st_size <= MAX_SOURCE_BYTES:
            raise ValueError(f"Invalid Senate directory response for {language}: HTTP {status}")
        return original.read_bytes()


def records(raw, language):
    source = CATALOGUE["senate_directory_url"](language)
    rows = CATALOGUE["parse_senate_directory"](raw.decode("utf-8-sig"), source)
    codes = {row["code"] for row in rows}
    path = "/en/committees/" if language == "en" else "/fr/comites/"
    if (not rows or len(codes) != len(rows) or any(
        not row["name"].strip() or urlsplit(row["url"]).scheme != "https"
        or urlsplit(row["url"]).netloc != "sencanada.ca" or not urlsplit(row["url"]).path.startswith(path)
        for row in rows
    )):
        raise ValueError(f"Invalid or duplicate Senate directory entries for {language}")
    return sorted(rows, key=lambda row: row["code"])


def directory_document(originals):
    sources, editions = {}, {}
    for language in LANGUAGES:
        raw = originals[language]
        if not 0 < len(raw) <= MAX_SOURCE_BYTES:
            raise ValueError(f"Invalid Senate directory original size for {language}")
        editions[language] = records(raw, language)
        sources[language] = {
            "url": CATALOGUE["senate_directory_url"](language), "httpStatus": 200,
            "file": f"{language}.html", "sha256": digest(raw), "bytes": len(raw),
            "committees": len(editions[language]),
        }
    if [row["code"] for row in editions["en"]] != [row["code"] for row in editions["fr"]]:
        raise ValueError("Senate committee codes differ between the published language editions")
    return {"schemaVersion": 1, "session": SESSION, "scope": SCOPE, "sources": sources, "editions": editions}


def verify_directory(directory):
    originals = {}
    for language in LANGUAGES:
        original = directory / f"{language}.html"
        if not 0 < original.stat().st_size <= MAX_SOURCE_BYTES:
            raise ValueError(f"Invalid Senate directory original size for {language}")
        originals[language] = original.read_bytes()
    expected = directory_document(originals)
    body = canonical(expected)
    if (directory / "directory.json").read_bytes() != body:
        raise ValueError("Senate directory differs from the archived publisher originals")
    return {"catalogueSha256": digest(body), "sources": expected["sources"]}


def acquire(directory):
    originals = {language: fetch_directory(language) for language in LANGUAGES}
    document = directory_document(originals)
    directory.mkdir(exist_ok=True)
    for language, raw in originals.items():
        (directory / f"{language}.html").write_bytes(raw)
    (directory / "directory.json").write_bytes(canonical(document))
    return verify_directory(directory)


def identity(request):
    return f"committee-senate-{request['scheduledTime']}", PREFIX


def refresh(request):
    storage = Archive(GATEWAY, WORKSPACE, PREFIX)
    report = {"scope": SCOPE, "session": SESSION, "scheduledTime": request["scheduledTime"], "phase": "restore"}
    try:
        storage.restore(request["inputState"])
        report["phase"] = "acquire-directories"
        report.update(acquire(WORKSPACE / "archive" / "directory"))
        report["observedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        report["phase"] = "archive-directories"
        state = storage.snapshot()
    except (OSError, RuntimeError, ValueError, AttributeError, KeyError) as error:
        reason = f"{report['phase']}: {error}"[-2600:]
        report.update(complete=False, reason=reason)
        return {"status": "failed", "reason": reason, "report": storage.document("reports", report)}
    report.update(complete=True, phase="complete")
    return {"state": state, "report": storage.document("reports", report)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-directory", type=Path, help="Replay an independently restored directory archive")
    args = parser.parse_args()
    if args.verify_directory:
        print(json.dumps(verify_directory(args.verify_directory)))
    else:
        serve(refresh, identity)
