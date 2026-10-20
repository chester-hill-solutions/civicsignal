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
# near-ties — exactly the case where a citation either resolves or does not.
#
# And EmbeddingGemma was trained with task instructions, which Workers AI's
# `embeddinggemma-300m` accepts no parameter for. This can, because the bundle
# carries its own preprocessor.

FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# litert-lm is the LiteRT-LM runtime: Apache 2.0, and it runs a `.litertlm` bundle
# on CPU or GPU.
RUN pip install --no-cache-dir litert-lm==0.18.1

# The model is fetched at build time with curl, not with `litert-lm import`.
#
# That is not a style preference. The `litert-lm` command line tool is a Go binary
# compiled with AVX, so *running* it needs a CPU with AVX — which means an x86_64
# image cannot be built on a machine without it. Fetching the file with curl means
# the image builds anywhere; the runtime still needs AVX to serve, which every
# current x86_64 cloud CPU has and the aarch64 build does not need at all.
#
# The model is discovered by scanning this directory, so the file and the directory
# name are the whole configuration. The directory name is the model id the service
# serves.
ARG MODEL_REPO=litert-community/embeddinggemma-2-text-270m-litert-lm
ARG MODEL_FILE=embeddinggemma-2-text-270m.litertlm
ARG MODEL_ID=embeddinggemma-2-270m
ENV LITERT_MODEL_PATH=/models/${MODEL_ID}/model.litertlm
RUN mkdir -p "/models/${MODEL_ID}" \
 && curl -fsSL --retry 3 \
      "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}?download=true" \
      -o "${LITERT_MODEL_PATH}" \
 && test -s "${LITERT_MODEL_PATH}" \
 && echo "the model is ${MODEL_FILE} in ${MODEL_ID}"

COPY services/encoder/server.py /app/server.py

# Railway sets PORT. The service listens on it and nowhere else.
ENV PORT=8080
ENV ENCODER_DIMENSIONS=768
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ['PORT']+'/health', timeout=4).status==200 else 1)"

CMD ["python", "/app/server.py"]
