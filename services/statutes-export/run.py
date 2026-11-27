"""Build and verify a private bilingual export from the official Justice Canada repository."""
from hashlib import file_digest, sha256
import json
from pathlib import Path
import re
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-archive"))
from runtime import Archive, command, serve  # noqa: E402

PREFIX = "weekly/statutes-export"
WORKSPACE = Path("/statutes-export")
SOURCE = "https://github.com/justicecanada/laws-lois-xml.git"
FILES = {"act-titles-fr.json", "act-titles.json", "statutes-fr.jsonl", "statutes-fr.sql", "statutes.jsonl", "statutes.sql"}


def verify_export(root):
    pointer = root / "current"
    generation = str(pointer.readlink())
    if not re.fullmatch(r"[a-f0-9]{64}", generation):
        raise ValueError("Invalid statutes export generation pointer.")
    directory = root / generation
    if directory.is_symlink() or {path.name for path in directory.iterdir()} != FILES | {"receipt.json"}:
        raise ValueError("The statutes generation has unexpected or missing files.")
    receipt_path = directory / "receipt.json"
    if receipt_path.is_symlink() or not receipt_path.is_file():
        raise ValueError("The statutes export receipt must be a regular file.")
    body = receipt_path.read_bytes()
    receipt = json.loads(body)
    if (sha256(body).hexdigest() != generation or receipt["source"] != SOURCE
            or not re.fullmatch(r"[a-f0-9]{40}", receipt["revision"]) or set(receipt["files"]) != FILES):
        raise ValueError("The statutes export receipt failed verification.")
    for name, checksum in receipt["files"].items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
            raise ValueError(f"Missing regular statutes export: {name}.")
        with path.open("rb") as stream:
            if file_digest(stream, "sha256").hexdigest() != checksum:
                raise ValueError(f"Statutes export checksum mismatch: {name}.")
    return {"generation": generation, "source": receipt["source"], "revision": receipt["revision"], "files": receipt["files"]}


def official_head():
    lines = command("git", "ls-remote", SOURCE, "HEAD", "refs/heads/main", timeout=120).splitlines()
    refs = {name: commit for commit, name in (line.split("\t", 1) for line in lines)}
    head = refs.get("HEAD", "")
    if not re.fullmatch(r"[a-f0-9]{40}", head) or refs.get("refs/heads/main") != head:
        raise ValueError("Justice Canada HEAD does not identify the advertised main revision.")
    return head


def refresh(request):
    storage = Archive("http://archive.statutes-export.internal/", WORKSPACE, PREFIX)
    storage.restore(request["inputState"])
    archive = WORKSPACE / "archive"
    previous = verify_export(archive)
    head = official_head()
    command("bun", "scripts/ingest-statutes.ts", "--corpus", str(WORKSPACE / "justice-laws-xml"),
            "--out", str(archive), "--publish-current")
    verified = verify_export(archive)
    if verified["revision"] != head:
        raise ValueError("Justice Canada main changed between the source check and the export.")
    if previous["revision"] == head and previous["generation"] != verified["generation"]:
        raise ValueError("The unchanged Justice Canada revision produced a different export.")
    state = request["inputState"]
    if previous["generation"] != verified["generation"]:
        shutil.rmtree(archive / previous["generation"])
        state = storage.snapshot()
    report = {"complete": True, "scheduledTime": request["scheduledTime"],
              "previousRevision": previous["revision"], **verified}
    return {"state": state, "report": storage.document("reports", report)}


def identity(request):
    return f"statutes-export-{request['scheduledTime']}", PREFIX


if __name__ == "__main__":
    serve(refresh, identity)
