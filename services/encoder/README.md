# The encoder

EmbeddingGemma 2, text 270M, served from the artefact itself.

## What it is

| | |
|---|---|
| Model | `embeddinggemma-2-270m` |
| Artefact | `litert-community/embeddinggemma-2-text-270m-litert-lm` → `embeddinggemma-2-text-270m.litertlm` |
| Size | 157.0 MB |
| Licence | Apache 2.0, ungated |
| Dimensions | 768 — and 128, 256, 512 by Matryoshka truncation |
| Normalised | yes, L2 |
| Runtime | `litert-lm serve`, an OpenAI-compatible API |
| Quantisation | int4 per-channel QAT for both the transformer and the embeddings |

## Why it is hosted rather than called

The reason is narrow and it is the whole reason.

**The client and the server must be in the same vector space.** A browser that
embeds with the LiteRT bundle and a server that embeds with fp32 PyTorch weights
produce vectors that differ by quantisation drift, and drift flips near-ties —
which is exactly the case where a citation either resolves or does not.

The bundle is one portable file. It runs in a browser today, through the LiteRT-LM
WASM build, and it runs here. So the corpus is embedded with the same file a
client embeds with, and the two are identical by construction rather than by
approximation.

There is a second reason, and it is the one that rules out the hosted option
entirely: **EmbeddingGemma was trained with `SearchQuery` and `Document` task
prefixes**, and Workers AI's `embeddinggemma-300m` accepts no parameter for them.
The hosted model cannot be prompted the way it was trained. This one can, because
the bundle carries its own preprocessor.

Measured on this corpus:

```
cosine(query, document)                  = 0.7346   (no prefixes)
cosine(SearchQuery:, SearchDocument:)    = 0.7545   (prefixed)
cosine(plain, prefixed)                  = 0.9700   (the prefix changes the vector)
```

## The contract

A client that embeds locally must match this exactly.

```json
{
  "model": "embeddinggemma-2-270m",
  "artefact": "litert-community/embeddinggemma-2-text-270m-litert-lm",
  "file": "embeddinggemma-2-text-270m.litertlm",
  "dimensions": 768,
  "queryPrefix": "SearchQuery: ",
  "documentPrefix": "SearchDocument: ",
  "matryoshkaDimensions": [128, 256, 512, 768],
  "normalised": true
}
```

It is published at `/.well-known/civicsignal.json` from the product API, so a
client can read it rather than be told it. `src/encoder.ts` is the single
definition; the serving path and the pipeline both read it, so the model, the
dimension and the prefixes cannot drift apart.

**The prefixes are not decoration.** A query is embedded with `SearchQuery: ` and
a document with `SearchDocument: `. Embedding a query with the document prefix
degrades the ranking measurably, and it is the kind of mistake that looks like
"the search is just not very good".

## Measured

On an Apple M1 Pro, CPU backend, single process:

| Batch | Total | Each |
|---|---|---|
| 1 | 274 ms | 274 ms |
| 8 | 1,167 ms | 146 ms |
| 32 | 4,138 ms | 129 ms |
| 64 | 6,971 ms | 109 ms |

The corpus is 127,092 indexable provisions, so a full embed is roughly four hours
on one core — a one-off. The pipeline re-embeds only what changed: a typical
corpus commit changes **56 provisions**, which is six seconds.

## The endpoint

The service is **the LiteRT-LM runtime driven directly**, not `litert-lm serve`,
for one reason: the runtime can **chunk an over-long input and average the
embeddings**, and the OpenAI-compatible server does not expose that option.

That matters because the runtime's compiled signature is **1,024 tokens**, not the
8,192 the bundle's metadata advertises, and it refuses an input that is longer
rather than truncating it. Measured on the corpus: the densest provision needs
1,183 tokens for 5,680 characters.

With `CHUNK_AND_AVERAGE`, a provision of any length is chunked to the signature
and the chunk embeddings averaged into one vector. **No provision loses its tail**,
and the corpus stays one row per provision — one vector per provision — rather
than growing a row per chunk. `TRUNCATE` would be simpler and would throw away
most of a long provision.

The service keeps the OpenAI-shaped call so the client is ordinary HTTP:

```bash
curl -X POST https://<service>/embed \
  -H 'Authorization: Bearer $ENCODER_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"texts":["what does s. 210 say?"]}'
```

`GET /health` is the health check, and it is unauthenticated — it says nothing
about the model.

## Running it

```bash
docker build -t civicsignal-encoder services/encoder
docker run -p 8080:8080 civicsignal-encoder
```

The model is fetched at build time, so the image is the contract: a client that
pins the encoder can pin the image digest and know exactly which file produced
the vectors. The index can be rebuilt from the same artefact years later.
