# The encoder.
#
# EmbeddingGemma 2, text 270M, served from the artefact itself.
#
# The whole reason this service exists rather than a call to a hosted API is that
# the file a client embeds with has to be the file the server embeds with. The
# browser runs `embeddinggemma-2-text-270m.litertlm` through the LiteRT-LM WASM
# build; the corpus is embedded here with the same file. Both vectors are in the
# same space by construction rather than by approximation.
#
# A server running fp32 PyTorch weights and a browser running the QAT bundle
# would produce vectors that differ by quantisation drift, and drift flips
# near-ties — which is exactly the case where a citation either resolves or does
# not.
#
# The bundle also carries its own preprocessor and tokenizer, and it honours the
# `SearchQuery:` / `SearchDocument:` task prefixes the model was trained with.
# Workers AI's `embeddinggemma-300m` accepts no prefix parameter, so it cannot be
# prompted the way the model was trained; this can.

FROM oven/bun:1.3 AS proxy

# The front door: `litert-lm serve` has no authentication, and an open embedding
# endpoint on somebody's bill is a liability. The runtime listens on the loopback
# interface and this proxies it, checking a bearer token in constant time.
WORKDIR /app
COPY proxy.ts ./proxy.ts


# The runtime is Debian-based, so the proxy's Bun has to be the glibc build. The
# Alpine build is musl and will not run here.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# litert-lm is the LiteRT-LM runtime and command line tool: Apache 2.0, and it
# serves a `.litertlm` bundle behind an OpenAI-compatible API.
RUN pip install --no-cache-dir litert-lm==0.18.1

# Bun's Debian image ships a self-contained binary; it needs nothing but glibc.
COPY --from=proxy /usr/local/bin/bun /usr/local/bin/bun

# The front door comes with it.
RUN mkdir -p /app
COPY proxy.ts /app/proxy.ts

# The model is fetched at build time, with curl, rather than with `litert-lm
# import`.
#
# That is not a style preference. The `litert-lm` command line tool is a Go
# binary compiled with AVX, so *running* it needs a CPU with AVX — and the
# x86_64 build of an image cannot be produced on a machine without it. Fetching
# the file with curl means the image builds anywhere; the runtime still needs AVX
# to serve, which every current x86_64 cloud CPU has, and the aarch64 build does
# not need it at all.
#
# The model is discovered by scanning this directory, so the file and the
# directory name are the whole configuration. The directory name is the model id
# the service serves.
ARG MODEL_REPO=litert-community/embeddinggemma-2-text-270m-litert-lm
ARG MODEL_FILE=embeddinggemma-2-text-270m.litertlm
ARG MODEL_ID=embeddinggemma-2-270m
ENV LITERT_MODEL_DIR=/root/.litert-lm/models
RUN mkdir -p "${LITERT_MODEL_DIR}/${MODEL_ID}" \
 && curl -fsSL --retry 3 \
      "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}?download=true" \
      -o "${LITERT_MODEL_DIR}/${MODEL_ID}/model.litertlm" \
 && test -s "${LITERT_MODEL_DIR}/${MODEL_ID}/model.litertlm" \
 && echo "the model is ${MODEL_FILE} in ${MODEL_ID}"

# The runtime listens on the loopback interface only. The proxy is the only way in.
ENV UPSTREAM_PORT=9379
EXPOSE 8080

# Railway sets PORT. The command is in shell form so the variables expand; the exec
# form would pass the literal strings.
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ['PORT']+'/health', timeout=4).status==200 else 1)"

CMD litert-lm serve --host 127.0.0.1 --port $UPSTREAM_PORT & \
    sleep 8 && bun /app/proxy.ts
