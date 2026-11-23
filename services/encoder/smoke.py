"""Run inside the encoder image with network=none; optional --embed warms the model."""
import hashlib
import json
import math
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, "/app")
import server

expected = "2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb"
fingerprint = hashlib.sha256()
with open(server.MODEL_PATH, "rb") as artifact:
    for block in iter(lambda: artifact.read(1024 * 1024), b""):
        fingerprint.update(block)
assert fingerprint.hexdigest() == expected
assert server.TOKEN, "Use a disposable fixture token for the smoke check."
http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
http.daemon_threads = True
thread = threading.Thread(target=http.serve_forever, daemon=True)
thread.start()

def request(path, data=None, authorized=True):
    headers = {"Content-Type": "application/json"}
    if authorized:
        headers["Authorization"] = "Bearer " + server.TOKEN
    payload = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("http://127.0.0.1:" + str(http.server_port) + path, data=payload, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

try:
    assert request("/health")[0] == 200
    assert request("/embed-query", {"texts": []}, authorized=False)[0] == 401
    assert request("/embed-query", b"{")[0] == 400
    assert request("/embed-query", {"texts": []}) == (200, {"vectors": []})
    if "--embed" in sys.argv:
        status, body = request("/embed-query", {"texts": ["Canadian federal employment standards"]})
        assert status == 200, body
        vector = body["vectors"][0]
        assert len(vector) == 768 and all(math.isfinite(value) for value in vector)
        assert abs(math.sqrt(sum(value * value for value in vector)) - 1) < 0.01
    print(json.dumps({"artifactSha256": expected, "httpChecks": 4, "modelInference": "--embed" in sys.argv}))
finally:
    http.shutdown()
    http.server_close()
