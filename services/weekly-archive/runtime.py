"""Transport for isolated Linux intake workspaces and verified R2 archives."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/institution-coverage/container"))
from snapshot import CHUNK_SIZE, canonical, capture, digest, restore  # noqa: E402


class Archive:
    def __init__(self, gateway, workspace, prefix):
        self.gateway = gateway
        self.workspace = workspace
        self.prefix = prefix

    def read(self, key):
        with urllib.request.urlopen(self.gateway + key, timeout=120) as response:
            return response.read(CHUNK_SIZE + 1)

    def put(self, key, data):
        request = urllib.request.Request(self.gateway + key, data=data, method="PUT")
        with urllib.request.urlopen(request, timeout=120):
            pass

    def document(self, folder, data):
        body = canonical(data)
        checksum = digest(body)
        key = f"{self.prefix}/{folder}/{checksum}.json"
        self.put(key, body)
        return {"key": key, "sha256": checksum, "bytes": len(body)}

    def restore(self, state):
        body = self.read(state["key"])
        if len(body) != state["bytes"] or digest(body) != state["sha256"]:
            raise ValueError("Workspace manifest failed verification.")
        self.workspace.mkdir(exist_ok=True)
        restore(self.workspace, json.loads(body), self.read, allowed=("archive",), prefix=self.prefix)

    def snapshot(self):
        manifest = capture(self.workspace, ("archive",), self.put, allowed=("archive",), prefix=self.prefix)
        return self.document("manifests", manifest)


def run(*args, cwd=ROOT, env=None, timeout=900, accepted=(0,)):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode not in accepted:
        detail = (result.stderr or result.stdout).strip().splitlines()[-8:]
        raise RuntimeError(f"{Path(args[1]).name} exited {result.returncode}: " + "\n".join(detail)[-2400:])
    return result


def command(*args, **options):
    return run(*args, **options).stdout


def serve(refresh, identity):
    class Handler(BaseHTTPRequestHandler):
        lock = threading.Lock()
        job = None

        def respond(self, code, body):
            raw = canonical(body)
            self.send_response(code)
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
        def execute(cls, request):
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
                scheduled, state = request["scheduledTime"], request["inputState"]
                instance, prefix = identity(request)
                if (type(scheduled) is not int or not 0 < scheduled < 4102444800000
                        or request["instanceId"] != instance or not re.fullmatch("[0-9a-f]{64}", state["sha256"])
                        or type(state["bytes"]) is not int or not 0 < state["bytes"] <= CHUNK_SIZE
                        or state["key"] != f"{prefix}/manifests/{state['sha256']}.json"):
                    raise ValueError("invalid identity")
            except (ValueError, KeyError, TypeError):
                return self.respond(400, {"status": "invalid-request"})
            with self.lock:
                current = type(self).job
                if current:
                    return self.respond(202 if current["instanceId"] == request["instanceId"] else 409, current)
                type(self).job = {"instanceId": request["instanceId"], "status": "running"}
                threading.Thread(target=self.execute, args=(request,), daemon=True).start()
            return self.respond(202, type(self).job)

    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
