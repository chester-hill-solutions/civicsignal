"""Refresh the bilingual Parliament catalogue in a private Cloudflare archive."""
from contextlib import closing
from datetime import datetime
from hashlib import file_digest
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, command, serve  # noqa: E402

PREFIX = "weekly/parliament"
WORKSPACE = Path("/parliament")
SESSION = "45-1"
DATABASE = "catalogues.sqlite"
INVENTORIES = (
    ("parliament-bills.py", "bills.json", "bills"),
    ("parliament-votes.py", "votes.json", "house-votes"),
    ("parliament-senate-votes.py", "senate-votes.json", "senate-votes"),
    ("parliament-house-journals.py", "house-journals.json", "house-journals"),
    ("parliament-senate-journals.py", "senate-journals.json", "senate-journals"),
)
COLLECTIONS = {name: collection for _, name, collection in INVENTORIES} | {
    "house-roll-calls.json": "house-roll-calls",
    "senate-roll-calls-complete.json": "senate-roll-calls",
}
PACKETS = COLLECTIONS | {"senate-roll-calls.json": "senate-roll-calls"}
SERVING_TESTS = (
    "serves the materialized official inventories in both languages|"
    "retrieves a cited decision and an individual vote from each official chamber edition"
)


def verify_archive(archive):
    """Check the retained official bytes and the corresponding bilingual SQLite editions."""
    source_store = archive / "sources"
    roots = (source_store, source_store / "house-roll-calls", source_store / "senate-roll-calls")
    verified_sources = {}
    catalogue = {}
    database = archive / DATABASE
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("The Parliament store failed SQLite verification.")
        for name, collection in PACKETS.items():
            packet = json.loads((archive / name).read_bytes())
            if packet["collection"] != collection or packet["session"] != SESSION or not packet["sources"]:
                raise ValueError(f"Unexpected or incomplete Parliament inventory: {name}.")
            for source in packet["sources"]:
                digest, size = source["sha256"], source["bytes"]
                if not re.fullmatch(r"[a-f0-9]{64}", digest) or type(size) is not int or size <= 0:
                    raise ValueError(f"Invalid official source receipt in {name}.")
                if digest in verified_sources:
                    if verified_sources[digest] != size:
                        raise ValueError(f"Conflicting official source receipt in {name}: {digest}.")
                    continue
                matches = [root / "objects" / digest[:2] / digest for root in roots]
                paths = [path for path in matches if path.is_file()]
                if not paths:
                    raise ValueError(f"Missing official source in {name}: {digest}.")
                for path in paths:
                    with path.open("rb") as stream:
                        if path.stat().st_size != size or file_digest(stream, "sha256").hexdigest() != digest:
                            raise ValueError(f"Corrupt official source in {name}: {digest}.")
                verified_sources[digest] = size
            if name not in COLLECTIONS:
                continue
            observed_at = datetime.fromisoformat(packet["observedAt"]).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            row = db.execute("""SELECT observed_at, revision, records_per_language
                FROM parliament_catalogues WHERE collection=? AND session=?""", (collection, SESSION)).fetchone()
            counts = dict(db.execute("""SELECT language, count(*) FROM parliament_editions
                WHERE collection=? AND session=? GROUP BY language""", (collection, SESSION)))
            total = len(packet["records"])
            if (not row or row[0] != observed_at or row[2] <= 0 or total != 2 * row[2]
                    or counts != {"en": row[2], "fr": row[2]}):
                raise ValueError(f"SQLite editions differ from the acquired Parliament inventory: {name}.")
            catalogue[collection] = {"observedAt": row[0], "revision": row[1], "recordsPerLanguage": row[2]}
    return catalogue, len(verified_sources)


def acquire(archive):
    for script, name, _ in INVENTORIES:
        command("python3", "-B", f"scripts/{script}", "--session", SESSION, "--output", str(archive / name))
    for chamber, name in (("house", "votes.json"), ("senate", "senate-votes.json")):
        command("python3", "-B", "scripts/parliament-roll-calls.py", "--votes", str(archive / name),
                "--output", str(archive / f"{chamber}-roll-calls.json"))
    command("python3", "-B", "scripts/parliament-journal-roll-calls.py",
            "--journals", str(archive / "senate-journals.json"), "--votes", str(archive / "senate-votes.json"),
            "--roll-calls", str(archive / "senate-roll-calls.json"), "--output", str(archive / "senate-roll-calls-complete.json"))
    command("bun", "scripts/materialize-parliament.ts", str(archive / DATABASE),
            *(str(archive / name) for name in COLLECTIONS))


def check_serving(database, result_path):
    env = {**os.environ, "CIVICSIGNAL_PARLIAMENT_SQLITE": str(database), "CIVICSIGNAL_CHAMBERS_SQLITE": str(database)}
    command("bun", "run", "test", "test/endpoints.test.ts", "-t", SERVING_TESTS,
            "--reporter=json", f"--outputFile={result_path}", env=env, timeout=180)
    result = json.loads(result_path.read_bytes())
    if result["numPassedTests"] != 2 or result["numFailedTests"] != 0:
        raise ValueError("Parliament serving verification did not pass both selected tests.")
    return 2


def refresh(request):
    storage = Archive("http://archive.parliament.internal/", WORKSPACE, PREFIX)
    storage.restore(request["inputState"])
    archive = WORKSPACE / "archive"
    acquire(archive)
    collections, verified_sources = verify_archive(archive)
    checked = check_serving(archive / DATABASE, WORKSPACE / "parliament-vitest.json")
    report = {"complete": True, "session": SESSION, "scheduledTime": request["scheduledTime"],
              "servingTestsPassed": checked, "verifiedCollections": len(collections),
              "sourceObjectsVerified": verified_sources, "collections": collections}
    return {"state": storage.snapshot(), "report": storage.document("reports", report)}


def identity(request):
    return f"parliament-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    serve(refresh, identity)
