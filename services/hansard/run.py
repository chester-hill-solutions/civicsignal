"""Run the existing chamber intake and serving checks in a private container."""
from contextlib import closing
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path("/app")
sys.path.insert(0, str(ROOT / "services/institution-coverage/container"))
from snapshot import CHUNK_SIZE, canonical, capture, digest, restore  # noqa: E402

GATEWAY = "http://archive.hansard.internal/"
WORKSPACE = Path("/hansard")
SESSION = "45-1"


def pointer(prefix, folder, data):
    checksum = digest(data)
    key = f"{prefix}/{folder}/{checksum}.json"
    put(key, data)
    return {"key": key, "sha256": checksum, "bytes": len(data)}


def read(key):
    with urllib.request.urlopen(GATEWAY + key, timeout=120) as response:
        return response.read(CHUNK_SIZE + 1)


def put(key, data):
    request = urllib.request.Request(GATEWAY + key, data=data, method="PUT")
    with urllib.request.urlopen(request, timeout=120):
        pass


def command(*args, env=None, timeout=900):
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()[-8:]
        raise RuntimeError(f"{Path(args[1]).name} exited {result.returncode}: " + "\n".join(detail)[-2400:])
    return result.stdout


def last_completed_week(milliseconds):
    toronto = dt.datetime.fromtimestamp(milliseconds / 1000, ZoneInfo("America/Toronto")).date()
    sunday = toronto - dt.timedelta(days=toronto.weekday() + 1)
    return sunday - dt.timedelta(days=6), sunday


def store_status(database):
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("The Hansard store failed SQLite verification.")
        journal = db.execute("SELECT journal_id FROM source_feed_identity").fetchone()
        feed = {lang: {"count": count, "highWater": high} for lang, count, high in db.execute(
            "SELECT language, count(*), max(seq) FROM source_feed_events GROUP BY language")}
        speeches = db.execute("SELECT count(*) FROM hansard_speeches").fetchone()[0]
    if not journal or set(feed) != {"en", "fr"} or not speeches:
        raise ValueError("Incomplete Hansard speech store or change journal.")
    return {"journal": journal[0], "feed": feed, "speeches": speeches}


def refresh(request):
    chamber = request["chamber"]
    prefix = f"weekly/hansard/{chamber}"
    initial = request["inputState"]
    body = read(initial["key"])
    if len(body) != initial["bytes"] or digest(body) != initial["sha256"]:
        raise ValueError("Hansard workspace manifest failed verification.")
    WORKSPACE.mkdir(exist_ok=True)
    restore(WORKSPACE, json.loads(body), read, allowed=("archive",), prefix=prefix)
    archive = WORKSPACE / "archive"
    database = archive / f"session-{SESSION}.sqlite"
    weekly = archive / "weekly"
    monday, sunday = last_completed_week(request["scheduledTime"])
    capture_out = json.loads(command("bun", "scripts/capture-hansard-week.ts", chamber, SESSION,
                                     str(monday), str(weekly / str(monday))))
    before = store_status(database)
    replay = "replay-week" if chamber == "house" else "replay-senate-week"
    observed = json.loads(command("bun", "scripts/hansard-local.ts", replay, str(database),
                                  str(weekly / str(monday) / "current/week.json")))
    reconciliation = json.loads(command("bun", "scripts/hansard-session-reconcile.ts", chamber, SESSION,
                                        str(database), str(weekly), str(sunday), str(archive / "reconciliation")))
    if not reconciliation["complete"] or not reconciliation["workerChecks"] or observed.get("complete") is False:
        raise ValueError("The restored Hansard session or its authenticated serving checks are incomplete.")
    after = store_status(database)
    if before["journal"] != after["journal"] or any(
            after["feed"][lang][field] < before["feed"][lang][field]
            for lang in ("en", "fr") for field in ("count", "highWater")):
        raise ValueError("The Hansard refresh regressed the change journal.")
    # The existing authenticated integration check pages the real change feed
    # and compares a bilingual search hit with its exact speech lookup.
    serving_file = WORKSPACE / "serving.json"
    command("bun", "run", "test", "test/endpoints.test.ts", "-t",
            f"reads the November 16 week from the acquired {chamber} Hansard",
            "--reporter=json", f"--outputFile={serving_file}",
            env={**os.environ, "CIVICSIGNAL_HANSARD_SQLITE": str(database)}, timeout=180)
    serving = json.loads(serving_file.read_bytes())
    if serving["numPassedTests"] != 1 or serving["numFailedTests"] != 0:
        raise ValueError("The authenticated Hansard search and change-feed check did not pass.")
    manifest = capture(WORKSPACE, ("archive",), put, allowed=("archive",), prefix=prefix)
    state = pointer(prefix, "manifests", canonical(manifest))
    report = {
        "session": SESSION, "chamber": chamber, "weekOf": str(monday), "cutoff": str(sunday),
        "capturedEditions": capture_out["editions"], "replayCounts": observed["counts"],
        "counts": reconciliation["counts"], "workerChecks": reconciliation["workerChecks"],
        "verifiedByServingCheck": True, "before": before, "after": after,
    }
    return {"state": state, "report": pointer(prefix, "reports", canonical(report))}


class Handler(BaseHTTPRequestHandler):
    lock = threading.Lock()
    job = None

    def respond(self, status, body):
        raw = canonical(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            return self.respond(200, {"ready": True})
        if self.path == "/status":
            with self.lock:
                return self.respond(200, type(self).job or {"status": "empty"})
        return self.respond(404, {"status": "unknown-route"})

    @classmethod
    def run(cls, request):
        try:
            result = {"status": "complete", **refresh(request)}
        except Exception as error:
            result = {"status": "failed", "reason": str(error)[-2600:]}
        with cls.lock:
            cls.job = {"instanceId": request["instanceId"], **result}
        print(json.dumps(cls.job), flush=True)

    def do_POST(self):
        if self.path != "/start":
            return self.respond(404, {"status": "unknown-route"})
        try:
            length = int(self.headers["Content-Length"])
            if not 0 < length <= 16_384:
                raise ValueError("invalid request length")
            request = json.loads(self.rfile.read(length))
            chamber, scheduled = request["chamber"], request["scheduledTime"]
            state = request["inputState"]
            if (chamber not in ("house", "senate") or type(scheduled) is not int or not 0 < scheduled < 4102444800000
                    or request["instanceId"] != f"hansard-{chamber}-{scheduled}"
                    or not re.fullmatch("[0-9a-f]{64}", state["sha256"])
                    or state["key"] != f"weekly/hansard/{chamber}/manifests/{state['sha256']}.json"):
                raise ValueError("invalid identity")
        except (ValueError, KeyError, TypeError):
            return self.respond(400, {"status": "invalid-request"})
        with self.lock:
            current = type(self).job
            if current:
                return self.respond(202 if current["instanceId"] == request["instanceId"] else 409, current)
            type(self).job = {"instanceId": request["instanceId"], "status": "running"}
            threading.Thread(target=self.run, args=(request,), daemon=True).start()
        return self.respond(202, type(self).job)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
