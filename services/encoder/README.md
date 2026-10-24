# The encoder

The service runs EmbeddingGemma 2 through the LiteRT-LM embedding engine.
The API and pipeline use this service for one shared vector space.
Cloudflare calls it through a service binding and a container Durable Object.
Railway retains its existing service; this release does not change its deployment.

## Pinned artifact

| Field | Value |
| --- | --- |
| Model | `embeddinggemma-2-270m` |
| Source | `litert-community/embeddinggemma-2-text-270m-litert-lm` |
| Source revision | `9be6e8b90982095dc05c2bd162e4b954ee4dbac7` |
| File | `embeddinggemma-2-text-270m.litertlm` |
| Bytes | 164,626,432 |
| SHA-256 | `2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb` |
| Runtime | `litert-lm==0.18.1` |
| Dimensions | 768, L2 normalized |

The build checks the artifact SHA-256. It uses the pinned Python base image and `requirements.lock`.
The publisher metadata, previous local registry image, and cached local artifact agree on the model fingerprint.
This check does not replace the stored-vector parity check.

`src/encoder.ts` publishes the contract through API discovery.
A query uses `task: search result | query: {query}`.
A document uses `title: {title} | text: {content}`.
The server applies these templates. Clients send plain texts and separate document titles.

Long documents use `CHUNK_AND_AVERAGE` against the compiled token limit.
The server serializes engine access because the engine is not thread safe.
The API's outer Worker checks its encoder token before it calls the container.
The container also checks its configured token when present.

## Build and smoke check

Run these commands from the repository root:

```sh
docker build --platform linux/amd64 -t civicsignal-encoder:v1-candidate -f services/encoder/Dockerfile .
docker run --rm --network none -i -e ENCODER_TOKEN=candidate-local-fixture --entrypoint python civicsignal-encoder:v1-candidate - < services/encoder/smoke.py
```

The smoke check uses an internal loopback server. It exposes no host port.
It checks the artifact, health response, authorization, invalid JSON, and an empty batch.
An empty batch does not warm the engine or prove inference performance.
Use `python - --embed` instead of `python -` to check one real embedding on a compatible CPU.
The x86 runtime requires CPU instructions that an emulator may lack.
A production-shaped staging check must exercise the actual hosted CPU.

`/health` reports process health. It does not assert a warm model or corpus readiness.
Do not replace the model, task templates, dimension, or index without a measured compatibility check.
Keep the existing Vectorize index throughout v1 rollout.
