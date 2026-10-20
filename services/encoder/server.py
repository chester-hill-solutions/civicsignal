#!/usr/bin/env python3
"""
The encoder.

EmbeddingGemma 2, text 270M, served from the artefact itself.

This is the LiteRT-LM runtime driven directly rather than through
`litert-lm serve`, for one reason: **the runtime can chunk a long input and
average the embeddings**, and the OpenAI-compatible server does not expose that
option. Its `EmbeddingOptions` carry `input_overflow_strategy`, and the HTTP
handler passes only `normalize` and `insert_special_tokens`.

That matters because the runtime's compiled signature is **1,024 tokens**, not the
8,192 the bundle's metadata advertises, and it refuses an input that is longer
rather than truncating it. Measured on the corpus: the densest provision needs
1,183 tokens for 5,680 characters, so a character limit is a guess about the
tokenizer.

With `CHUNK_AND_AVERAGE`, a provision of any length is chunked to the signature
and the chunk embeddings are averaged into one vector. No provision loses its
tail, and the corpus stays one row per provision — one vector per provision —
rather than growing a row per chunk. `TRUNCATE` would be simpler and would throw
away most of a long provision.

The task instructions are applied here too, because they are part of how the model
was trained and the OpenAI-compatible server has no place to put them:

    query     task: search result | query: {query}
    document  title: {title} | text: {content}

## The front door

`litert-lm serve` has no authentication, and an unauthenticated embedding
endpoint on somebody's Railway bill is a liability: the model is public and the
endpoint is cheap to abuse, and a scraping job pointed at it costs the owner
money without doing anything useful. So this service checks a bearer token, in
constant time, before it does anything else.

    python server.py --port 8080
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import litert_lm
from litert_lm import interfaces

# The task instructions, from the model's card. EmbeddingGemma 2 was trained with
# them and they are not decoration: using the wrong one measurably degrades the
# ranking, and omitting them still works but reduces precision.
QUERY_TEMPLATE = "task: search result | query: {query}"
DOCUMENT_TEMPLATE = "title: {title} | text: {content}"

MODEL_PATH = os.environ.get(
    "LITERT_MODEL_PATH",
    os.path.expanduser("~/.litert-lm/models/embeddinggemma-2-270m/model.litertlm"),
)
TOKEN = os.environ.get("ENCODER_TOKEN", "")
OUTPUT_SIZE = int(os.environ.get("ENCODER_DIMENSIONS", "768"))
THREADS = int(os.environ.get("ENCODER_THREADS", "8"))


def build_engine() -> Any:
    engine = litert_lm.EmbeddingEngine(
        MODEL_PATH,
        backend=interfaces.Backend.CPU(thread_count=THREADS),
    )
    return engine


def build_options() -> Any:
    return litert_lm.EmbeddingOptions(
        normalize=True,
        insert_special_tokens=True,
        # The input is longer than the signature. Chunk it and average the
        # embeddings, rather than refusing it or throwing the tail away.
        input_overflow_strategy=litert_lm.InputOverflowStrategy.CHUNK_AND_AVERAGE,
        output_size=OUTPUT_SIZE,
    )


ENGINE = None
OPTIONS = None


def embed(contents: list[str]) -> list[list[float]]:
    global ENGINE, OPTIONS
    if ENGINE is None:
        ENGINE = build_engine()
        OPTIONS = build_options()
    responses = ENGINE.compute_embedding_batch(contents, options=OPTIONS)
    return [list(response.embedding) for response in responses]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter, and on stderr
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorised(self) -> bool:
        if not TOKEN:
            # No token configured is a deployment error, not an open door.
            return False
        header = self.headers.get("Authorization") or ""
        presented = header[7:] if header.startswith("Bearer ") else ""
        return hmac.compare_digest(presented, TOKEN)

    def do_GET(self) -> None:  # noqa: N802 — the name is the framework's
        if self.path.split("?")[0] == "/health":
            # Unauthenticated, and it says nothing about the model.
            self._send(200, {"ok": True})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path not in ("/embed", "/embed-query"):
            self._send(404, {"error": "not found"})
            return
        # The body is read before anything else, including the refusal.
        #
        # On a keep-alive connection an unread body *is* the next request. Refusing
        # without draining it leaves the body in the socket, and the server parses
        # the corpus as a request line and answers 400 — so one unauthorised
        # request poisons every request that follows it on that connection. The
        # refusal is not the failure; the connection is.
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "the body must be JSON"})
            return

        if not self._authorised():
            self._send(401, {"error": "a bearer token is required"})
            return

        texts: list[str] = body.get("texts") or []
        titles: list[str] = body.get("titles") or []
        mode = "query" if path.endswith("/embed-query") else "document"
        if not texts:
            self._send(200, {"vectors": []})
            return

        if mode == "query":
            contents = [QUERY_TEMPLATE.replace("{query}", text) for text in texts]
        else:
            contents = [
                DOCUMENT_TEMPLATE.replace("{title}", titles[i] if i < len(titles) else "").replace(
                    "{content}", text
                )
                for i, text in enumerate(texts)
            ]

        try:
            vectors = embed(contents)
        except Exception as error:  # noqa: BLE001 — the message is the diagnosis
            self._send(500, {"error": f"the encoder failed: {error}"})
            return

        self._send(200, {"vectors": vectors})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"the encoder is listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
