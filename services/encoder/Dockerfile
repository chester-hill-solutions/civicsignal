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

FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# litert-lm is the LiteRT-LM runtime and command line tool: Apache 2.0, and it
# serves a `.litertlm` bundle behind an OpenAI-compatible API.
RUN pip install --no-cache-dir litert-lm==0.18.1

# The model is fetched at build time so the image is the contract. A client that
# pins the encoder can pin the image digest and know exactly which file produced
# the vectors, and the index can be rebuilt from the same artefact years later.
ARG MODEL_REPO=litert-community/embeddinggemma-2-text-270m-litert-lm
ARG MODEL_FILE=embeddinggemma-2-text-270m.litertlm
ARG MODEL_ID=embeddinggemma-2-270m
RUN litert-lm import \
      --from-huggingface-repo "${MODEL_REPO}" \
      "${MODEL_FILE}" \
      "${MODEL_ID}"

# Railway sets PORT. The command is in shell form so the variable expands; the exec
# form would pass the literal string.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ['PORT']+'/v1/models', timeout=4).status==200 else 1)"

CMD litert-lm serve --host 0.0.0.0 --port $PORT
