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
import threading
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
BACKEND = os.environ.get("ENCODER_BACKEND", "cpu").lower()


def build_engine() -> Any:
    """
    The engine, on the backend the machine has.

    The GPU backend is **6.6 times faster** on this hardware — 33 provisions a
    second against 5 — and it is the difference between embedding the corpus in
    two hours and embedding it in thirty-five.

    But the two backends do not produce identical vectors: the same text
    embedded on the CPU and on the GPU agrees to a cosine of **0.997**, with
    component differences of about 0.008. That is floating-point accumulation
    order, not quantisation, and it is small — but "small" is not "identical",
    and the corpus and the queries have to be in the same space.

    So the backend is a choice, not a default: `ENCODER_BACKEND=gpu` embeds on
    the GPU, `cpu` on the CPU, and the deployment decides which. The one place
    that must not vary is *within* a deployment.
    """
    if BACKEND == "gpu":
        return litert_lm.EmbeddingEngine(MODEL_PATH, backend=interfaces.Backend.GPU())
    return litert_lm.EmbeddingEngine(
        MODEL_PATH,
        backend=interfaces.Backend.CPU(thread_count=THREADS),
    )


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

# The LiteRT engine is **not thread-safe**.
#
# Two concurrent `compute_embedding_batch` calls collide inside the runtime and
# the second one fails with "Tensor buffer is already locked" — a 500 from an
# encoder that is merely busy, which is the worst possible answer to a busy
# encoder. The `ThreadingHTTPServer` serves requests on separate threads, so
# without this lock the first two callers of a cold service race.
#
# A lock is the right answer rather than a single-threaded server: the engine
# is the expensive part and it is serial anyway, so the lock costs nothing but
# the waiting, and the *waiting* is what the callers want — a queued request
# that succeeds in two seconds beats a refused one that succeeds if you retry.
ENGINE_LOCK = threading.Lock()

# How much text one call may carry.
#
# The compiled model's signature carries its own deadline, and a call that
# exceeds it dies **mid-flight** with `DEADLINE_EXCEEDED`. The corpus embed hit
# exactly that: the batches are sorted by length, so the last ones hold the
# longest provisions, and one of them ran past the deadline.
#
# The deadline is a property of the *model*, so it cannot be configured from
# here, and it is a wall-clock: the same batch passes on the GPU and fails on
# the CPU. So the work per call is bounded by **characters**, and the bound is
# set where the machine is known. 120,000 characters is about 30,000 tokens,
# which the GPU does in a few seconds and the CPU in well under a minute.
#
# Splitting a batch does not change the total work — it changes how much of it
# is in flight at once, which is what the deadline is about.
MAX_BATCH_CHARS = int(os.environ.get("ENCODER_MAX_BATCH_CHARS", "120000"))


def split_by_size(contents: list[str]) -> list[list[str]]:
    """
    Split a batch so no one call carries more than `MAX_BATCH_CHARS`.

    A text longer than the budget is alone in its batch: it cannot be split
    without changing what it means, and a caller that sends one enormous
    provision has already told us it is expensive.
    """
    batches: list[list[str]] = []
    current: list[str] = []
    current_chars = 0
    for content in contents:
        size = len(content)
        if current and current_chars + size > MAX_BATCH_CHARS:
            batches.append(current)
            current = []
            current_chars = 0
        current.append(content)
        current_chars += size
    if current:
        batches.append(current)
    return batches


def embed(contents: list[str]) -> list[list[float]]:
    """
    Embed a batch, on a rebuilt engine if the call fails.

    **A failed call can leave the engine's tensor buffer locked.** The runtime
    holds that buffer across the call, and a call that dies mid-flight — a
    deadline, a cancelled request, a GPU hiccup — does not release it. Every
    call after that fails with "Tensor buffer is already locked", forever: a
    dead encoder that answers 500 and looks alive, which is the failure mode
    that costs a corpus embed its last two hours.

    So a failure **drops the engine**. The buffer belongs to the model, so a
    fresh model has a fresh buffer, and the call is tried once more. The second
    failure is the real answer, and it is raised.
    """
    global ENGINE, OPTIONS
    vectors: list[list[float]] = []
    for batch in split_by_size(contents):
        vectors.extend(embed_batch(batch))
    return vectors


def embed_batch(contents: list[str]) -> list[list[float]]:
    global ENGINE, OPTIONS
    with ENGINE_LOCK:
        last_error: Exception | None = None
        for attempt in (1, 2):
            if ENGINE is None:
                ENGINE = build_engine()
                OPTIONS = build_options()
            try:
                responses = ENGINE.compute_embedding_batch(contents, options=OPTIONS)
                return [list(response.embedding) for response in responses]
            except Exception as error:  # noqa: BLE001 — the message is the diagnosis
                last_error = error
                ENGINE = None
                OPTIONS = None
                if attempt == 2:
                    raise
                print(
                    f"the embedding call failed ({error}); the engine is rebuilt and the "
                    f"batch is tried once more",
                    flush=True,
                )
        raise last_error  # unreachable, and the type checker wants it


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
        """
        Is this request allowed to embed?

        The token arrives in one of two places. Behind the Cloudflare Worker it
        arrives as `X-Encoder-Token`, because the Worker's own secret is what
        it forwards — a secret that is also in the container's configuration
        would be a secret in a configuration file, and a secret in a
        configuration file is a secret in a repository. Locally it arrives as
        `Authorization: Bearer …`, which is the ordinary way to carry one.

        Either way it is the same token, and it is compared in constant time.
        """
        header = self.headers.get("X-Encoder-Token")
        if not header:
            authorization = self.headers.get("Authorization") or ""
            header = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not header:
            # No token at all is a refusal, whatever else is true.
            return False
        if TOKEN and not hmac.compare_digest(header, TOKEN):
            return False
        # With no token in the environment, the token that arrived is the one the
        # front door checked. The front door is the only way in: the container's
        # port is reachable through the Durable Object and through nothing else,
        # and the object is behind the front door. So the comparison above is
        # defence in depth — and when the environment has no token to compare
        # against, refusing every request would only mean the encoder is down.
        return True

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
