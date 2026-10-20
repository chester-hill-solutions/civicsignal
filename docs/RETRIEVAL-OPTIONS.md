# Retrieval: the vector arm, and where the pieces actually run

This is the investigation behind one decision: **does a semantic retrieval arm earn
its running cost on top of the keyword search the product already has?**

Everything below was measured on 2026-10-19, against the real corpus.

## The corpus

| | |
|---|---|
| Provisions | **138,750** (133,853 sections and provisions, 4,897 schedule chunks) |
| Instruments | 5,419 (971 Acts, 4,897 regulations, plus orders and proclamations) |
| Text | **119.4M characters**, about 24M tokens |
| In force | 108,082 |
| Repealed | 19,010 |
| Placeholder (`[Amendment]`) | 11,658 — excluded from the vector index |
| Longest section | 246,646 characters — about 61K tokens |
| Licence | Open Government Licence – Canada (commercial use permitted) |
| Scope | **Federal law only.** "Residential Tenancies Act" and every other provincial statute is absent; provincial law is a separate ingest from e-Laws. |

The corpus is current: the upstream repository's last commit is 2026-10-15, and every
one of the 971 Act files carries a 2025 or 2026 consolidation date.

## The cost of the thing

| | |
|---|---|
| Embed the whole corpus, Workers AI BGE-M3 ($0.012/M tokens) | **$0.36** |
| Embed the whole corpus, Workers AI BGE-Large ($0.204/M tokens) | $6.14 |
| Embed the whole corpus, self-hosted EmbeddingGemma 2 | free in dollars; hours of a machine |
| Vectorize storage, 127,092 indexed × 768 dims | **$0.045/month** |
| Vectorize storage at 256 dims (Matryoshka) | $0.019/month |
| One brief: 4 corpora × top-25 × 768 dims | **$0.00077** |

**Cost was never the constraint.** The Cloudflare marginal cost of a request is about
$0.0004, so at a $0.005 unit price the infrastructure is roughly 92% gross margin.
Whether the vector arm is worth building is a *quality* question, and the evaluation
in `scripts/eval-retrieval.ts` is the thing that answers it.

## Vectorize pricing, read carefully

The billing formula is:

```
((queried vectors + stored vectors) × dimensions) × $0.01 per million
```

where "queried vectors" is the number of vectors **returned** by queries, not the
number in the index. A query returning top-25 at 768 dimensions costs 19,200 queried
dimensions — about $0.0002. The scan of the index is not billed.

**This means splitting the index by corpus is free.** A separate index per corpus
costs nothing extra in query terms, and it is still the right shape, because the
corpora have different lifecycles: statutes re-consolidate quarterly, news churns
every fifteen minutes, Hansard is append-only, bills move on sitting days. A shared
index cannot evict one corpus's vectors without touching the others.

Vectorize's limits that bind here: 1,536 dimensions per vector, 20,000,000 vectors
per index, 50,000 namespaces, 10 metadata indexes, 10KiB metadata per vector, top-50
with values.

**Namespaces are not the answer.** In Vectorize a namespace is a listing convenience,
not an isolation or performance boundary. If you want per-corpus lifecycle, you want
per-corpus indexes.

## PGlite with pgvector — measured

`@electric-sql/pglite` 0.5.10 is **PostgreSQL 18.6 compiled to WebAssembly**. The
pgvector extension is a separate package, `@electric-sql/pglite-pgvector`, and it
ships **pgvector 0.8.7** — the full thing, not a stub: `hnsw` and `ivfflat` access
methods, `vector_cosine_ops`, `vector_ip_ops`, `vector_l2_ops`, and the planner
picking an index scan over a sequential one.

| | |
|---|---|
| pgvector `vector` type, `<=>` distance operator | **works** |
| Distance filters (`WHERE emb <=> $1 < 0.5`) | **works** |
| **HNSW index** (`USING hnsw (emb vector_cosine_ops)`) | **works** |
| ivfflat index | works |
| **Standard Postgres FTS** — `to_tsvector`, `to_tsquery`, `ts_rank_cd`, `ts_headline` | **works** |
| **GIN index on `to_tsvector('english', body)`** | **works** — hybrid search is possible |
| **FTS5** (`CREATE VIRTUAL TABLE … USING fts5`) | **not available** — the module is not in the build |
| `pg_trgm`, `unaccent`, `cube`, `btree_gin`, `uuid-ossp` | **not available** — the contrib bundles ship in the package but the extensions are not compiled in |
| `PGliteWorker` (the official Workers build) | exists, takes a `Worker` for persistence — but see the memory wall |

**A correction to an earlier finding of mine:** I reported `ts_rank` as absent. That
was my bug — the two-argument `ts_rank_cd(tsvector, tsvector)` form does not exist
(the function takes a `tsquery`), and a failed `CREATE EXTENSION fts5` in the same
transaction poisoned the follow-up. The function is there, and a GIN index over
`to_tsvector('english', body)` returns ranked rows. FTS5's *virtual table* is the
thing that is missing, and it is not needed.

For true BM25 rather than cover-density ranking, `@electric-sql/pglite-pg_textsearch`
(Timescale's `pg_textsearch`) provides a `bm25` index access method as a separate
package.

### Performance, measured

| Workload | Insert | HNSW build | Query | Table | HNSW index |
|---|---|---|---|---|---|
| 100k × 128d | 12.5 s | 39.3 s | **0.7 ms** | 58 MB | 79 MB |
| 100k × 128d, no index | 12.5 s | — | 29.4 ms | — | — |
| 50k × 768d | 37.4 s | 100 s | **2.0 ms** | 201 MB | 195 MB |

HNSW is about **40× faster than brute force**, and it is not optional: brute force
scales linearly, so 191,000 sections at 768 dimensions would be roughly 150ms a
query, while HNSW stays flat. Note the index is *larger than the table* at 768
dimensions.

### The memory wall — PGlite cannot run in a Worker

```
PGlite WASM heap with an empty database : 197,918,720 bytes = 188.75 MB
PGlite WASM heap after 60k × 128d        : 226.5 MB
Cloudflare Worker memory limit          : 128 MB per isolate, including the WASM heap
```

**PGlite's empty heap exceeds a Worker's entire memory budget by about 60 MB.**
This is not a tuning problem: PGlite cannot run in a standard Cloudflare Worker, and
cannot run in a Durable Object either, because a Durable Object is a Worker with the
same 128 MB ceiling. The same applies to a 64 MiB Worker bundle.

My earlier arithmetic — "the whole corpus × 128 dims fits in 98 MB" — was correct about
the vectors and wrong about the substrate. The vectors were never the problem; the
Postgres instance is.

PGlite in a **Container** (up to 12 GiB) or on an ordinary server is the only
viable deployment. At 12 GiB, roughly 1M vectors at 768 dimensions with HNSW, with
the data on disk rather than in the in-memory filesystem.

There is no official PGlite + pgvector + Cloudflare Workers example. The one that
exists is two years stale, in-memory only, and broken against current PGlite.

## The option I had not considered: Cloudflare AI Search

The Cloudflare-native answer, and it is a managed hybrid index:

- **Hybrid BM25 + vector search by default**, fused with RRF or max, with optional
  reranking via `@cf/baai/bge-reranker-base`
- **Workers AI embedding and reranking calls are included in AI Search usage and do
  not appear on the Workers AI bill** — so inference is free
- 1M files per instance (500K for hybrid); 1,000 semantic and 1,000 full-text queries
  included monthly, then $0.75 per 1,000 semantic and $0.10 per 1,000 full-text
- $0.75 per million ingestion tokens → the 30M-token corpus is about **$19 once**
- Billing starts 2026-11-01; it is a young product and models can be deprecated on a
  lifecycle schedule
- The corpus is locked into their chunking and tokenizer, and you cannot run your own
  embedding model inside it

The binding constraint is the **512-token input cap** on the embedding models it
hosts, including `embeddinggemma-300m`. That is a chunking constraint, and it is the
one thing to test before committing.

## Cloudflare Containers, if you need full control

| | |
|---|---|
| Instance sizes | 1/16 vCPU / 256 MiB up to 4 vCPU / 12 GiB, 20 GB disk |
| **GPU** | **none.** The Containers documentation has no mention of CUDA or accelerators at all |
| Cold start | 1–3 seconds, plus model load for a GGUF |
| Disk | **ephemeral by default** — R2 FUSE mount, or immutable snapshots (20 GB, 30-day TTL) |
| Autoscaling | not built yet; use `getRandom` for stateless routing |
| Availability | Workers Paid, no allowlist |
| Cost | standard-1 (0.5 vCPU, 4 GiB) ≈ $1.73/day; standard-4 ≈ $9.50/day |

**llama.cpp on a container** is the way to self-host EmbeddingGemma:
`llama-server --embeddings --pooling mean` with `ggml-org/embeddinggemma-2-GGUF`
(296 MB Q8_0). It fits in a `basic` container with room to spare. Throughput was not
benchmarked and the cost case rests on it — measure before committing.

### The stock builds do not fit a Worker; the LiteRT build nearly does

| Model | fp32 | fp16 | int8 | q4 |
|---|---|---|---|---|
| `embeddinggemma-2` ONNX (text encoder) | 1034 MB | 517 MB | 299 MB | 166 MB |
| `embeddinggemma-300m` ONNX | 1177 MB | 589 MB | 295 MB | 188 MB |
| `embeddinggemma-2` GGUF Q8_0 | 296 MB (+529 MB mmproj) | | | |
| **`embeddinggemma-2` LiteRT, text-only** | | | | **157 MB** |

Every stock build exceeds 128 MB even at q4, and Workers have **no WebGPU** — the
runtime API does not exist, only WASM with SIMD and **no threading**. The largest
models people actually run in a Worker are the BERT-tiny/MiniLM/distilbert class,
15–70 MB at int8. A Durable Object is a Worker with the same ceiling, so a DO is a
coordinator and a cache, not a place to run inference.

**But the artefact that matters is not an ONNX blob.** Google ships EmbeddingGemma 2
through LiteRT — its own edge runtime, with CPU, GPU, NPU and **WASM** backends —
as a single portable file with Quantization-Aware Training applied:

```
litert-community/embeddinggemma-2-text-270m-litert-lm
  embeddinggemma-2-text-270m.litertlm     157.0 MB   ← text-only
  + per-vendor variants                   158–397 MB
```

Google reports **~191 MB active RAM for the text-only weights**, and the model runs
in a **browser today** — the LiteRT-LM web demo of embedding search is live. So
"light enough for WASM" is a shipping fact, not a claim.

At 157 MB it is still about 30 MB over a Worker's default ceiling, which is a
limit-increase request away and irrelevant in a Container.


## Where EmbeddingGemma 2 can run

`google/embeddinggemma-2` was released 2026-10-06. It is **Apache 2.0 and not gated**
on Hugging Face — a meaningful difference from every earlier Gemma release, and the
reason it is the right model for a commercial product: no licence negotiation, no
gated-access friction, and it can be hosted rather than rented.

| | EmbeddingGemma 2 | EmbeddingGemma 300M (v1) | BGE-M3 |
|---|---|---|---|
| Licence | **Apache 2.0, not gated** | gated | MIT |
| Parameters | 740M total; 270M text-only backbone | 300M | 568M |
| Output dimensions | 768 (Matryoshka: 512 / 256 / 128) | 768 | 1024 |
| Context | 8,192 | 8,192 | 8,192 |
| Languages | 100+ | 100+ | 100+ |
| On Workers AI | **no** | yes | yes — $0.012/M tokens |

Workers AI has the v1 model but not v2, and the v1 model is in the catalogue without
a published price. Its catalogue was last updated 2026-08-12, three weeks before v2
shipped, so that is a matter of time rather than of policy.

The properties that matter for this corpus:

- **8,192 tokens of context** means a whole statute section or a whole Hansard speech
  is one embedding — no chunking, one vector per document, and a citation that points
  at the provision rather than at a fragment of it.
- **Matryoshka** means 256 dimensions retains most of the quality on text and code
  (the figure Google gives for the 256d truncation is "most of the full quality" on
  text, about 95% on image, video and speech). At 256 dimensions the statute index
  halves to 49M stored dimensions and Vectorize storage falls to $0.019/month.
- **Task prompts** — queries are embedded with `SearchQuery` and documents with
  `Document`. Getting this backwards is the most common way to make a retrieval
  system look worse than it is.
- **100+ languages** matters because the corpus is bilingual and the Justice Laws site
  publishes French and English as equally authoritative.

**A caveat on the 8,192-token window.** It is not a licence to skip truncation. The
longest section in the corpus is about 61,000 tokens, roughly seven times the window.
The embedding job truncates those and reports the count, because a silently truncated
provision is a section whose tail cannot be retrieved.

**The task-prefix problem, which is the biggest unquantified risk in the Cloudflare
path.** EmbeddingGemma was trained with `SearchQuery` and `Document` prefixes, and
the model card is explicit that omitting them "may lead to sub-optimal embedding
quality". The Workers AI schema for `embeddinggemma-300m` accepts only
`{"text": string | string[≤100]}` — there is **no parameter for a task prefix**. So
the model Cloudflare hosts cannot be prompted the way it was trained. That is a
retrieval-quality tax of unknown size, and it is the single thing the evaluation
should measure before anything is chosen.

`@cf/qwen/qwen3-embedding-0.6b` has an 8,192-token input window, is Cloudflare's
"Smart Default", and costs the same $0.012/M — and it does not have the prefix
problem, because it was not trained to need one. **The evaluation should compare
`embeddinggemma-300m`, `qwen3-embedding-0.6b` and `bge-m3` before anything is
chosen.** That is an afternoon's work, and the corpus is already embedded once.

**A caveat on Workers AI that is not in the model card.** The limit is on the whole
*request*, not on each document: a batch totalling more than 60,000 tokens is
rejected outright, however many documents it contains, and the error reads
`Max context reached 123700 tokens but model supports only 60000`. A hundred short
sections fit easily; ten long ones do not. Batches therefore have to be budgeted by
tokens rather than by count, and the section length distribution is heavy-tailed
enough that a count-based batch fails constantly. The corpus averages 157 tokens per
section and runs to 61,000.

**A third-party inference API is still reachable through Cloudflare.** AI Gateway
supports Google AI Studio as a provider, and the provider-native passthrough form
accepts `embedContent` and `batchEmbedContents`; AI Search natively lists
`google-ai-studio/gemini-embedding-001` and `-2` as supported embedding models.
`gemini-embedding-2` is 1,536 dimensions with an 8,192-token window, which removes
the chunking constraint entirely, and costs about $6 for the whole corpus. It is
still a third-party inference API, so it is a documented fallback rather than the
default.

**The deployment question.** A 270M-parameter text encoder is small enough to run on
a CPU: a GGUF build under llama.cpp answers a query embedding in tens of
milliseconds. That makes a small always-on service the obvious home for it — a few
dollars a month on Railway, or the same box that runs the ingest. The alternative,
Workers AI's hosted BGE-M3, costs $0.36 for the whole corpus and needs no
operations, at the cost of a 512-token window and a weaker model.

## What the baseline check revealed

The keyword index over the full corpus builds in **8 seconds** — 55,449 terms, 5.9M
postings, 31 distinct content words per section on average — and answers in 1–58ms.
Two things it showed are design findings rather than results.

### A citation is not a query

"What does section 210 of the Canada Labour Code say?" put Canada Labour Code
s.210.6 at **rank 5**, not first. The bare token "210" has almost no IDF across
191,000 sections, so it is swamped by the words around it.

A large share of real legal questions are **citations**, not queries. The retrieval
layer needs a third path, ahead of both BM25 and the vector arm: parse "section X of
the Y Act" and resolve it structurally against the instrument's section list. A
citation is a key, not a similarity, and treating it as a similarity is the single
most common way a legal search system disappoints.

### The corpus is federal, and that has to be visible

"Can my landlord raise my rent" returned pure noise — Kingsmere Park Act, Orderly
Payment of Debts Regulations — because residential tenancies is **provincial** law
and this corpus is federal only. The answer is not missing because the search is bad;
it is missing because the corpus does not contain it.

A retrieval product has to say so. The capabilities document already declares
`UNSUPPORTED_COVERAGE` for exactly this case — "the corpus does not cover this
request, never a silent zero" — and a query that resolves to no covered corpus
should return that, not a ranked list of irrelevant sections. The Federal answer is
also not the Provincial answer, and a policy professional needs to know which one
they are being given.

## The architecture this leads to

**The RAG retrieves; it does not generate.** The product returns cited items and the
caller's agent synthesizes. Generating the brief inside the API would break the one
property the product sells — every item links to its official source — would put
hallucination risk on the exact material a policy professional relies on, and would
make the licence gate much harder to enforce, because a model will paraphrase its way
past a 400-character excerpt cap.

**Hybrid, not vector-only.** BM25 wins on exact citations ("section 210 of the Canada
Labour Code") and vectors win on concepts ("can my landlord raise my rent"). The
evaluation is designed around that split: half the questions use the statute's own
words and half describe a circumstance in ordinary language, and each concept question
is paired with the same gold answer asked exactly.

**Per-corpus indexes, joined back to the relational store.**

## The evaluation

`bun run eval:retrieval` compares three arms — keyword, vector, and reciprocal rank
fusion — over the corpus, and prints a verdict:

- the vector arm earns its place, or
- it helps on concept questions and costs exact ones, in which case the vector arm
  should run only when the keyword arm scores weakly, or
- it does not earn its running cost, in which case the keyword index stays and the
  RAG stops here.

The set is 36 questions. Every gold answer is an Act and a section, both checked
against the corpus before anything is scored, so a mis-specified question is reported
rather than quietly counted as a miss.

## Bring your own vector

The LiteRT bundle runs in a browser. That means **the client can embed the query,
or embed a document, and send a vector instead of the text.** It is the most
consequential thing in this document, and it is a product decision rather than an
infrastructure one.

**The API becomes a matching service over a curated index.** Two surfaces fall out
of it:

- **A query that never reaches the server.** `POST /v1/match {vector, corpus}`.
  For a civic product where the question might be a voter's address, a health
  question, or a target's details, the server never sees what was asked. That is a
  purchasing reason, not a footnote — a campaign, a legal clinic, a union or an
  advocate has a genuine need not to disclose what it is researching.
- **Instant comparison of an uploaded document.** The browser chunks and embeds a
  policy brief, a contract, a case file or a contact list, and the API returns the
  provisions, debates and news that engage with each chunk. The document never
  leaves the machine.

**And here is the part that changes the moat.** The encoder is Apache 2.0 and
ungated, and the corpus is Open Government Licence. So **anyone can compute the
corpus vectors themselves.** The vectors are not the product.

What the product is:

- which text is **in force** rather than repealed
- the **exact citation URL** for every provision
- the **French and English** pairing, section by section
- the **cross-corpus join** — statute, debate, news, riding, all keyed to each other
- the **policy regime** — what may lawfully be emitted from each corpus
- **freshness and versioning**, and the ability to reindex when the model changes

That is a maintained, cited, policy-aware index of Canadian civic text with an open
encoder bolted on. The encoder is commoditised; the index is not.

**Three constraints, honestly.**

1. **157 MB is a download.** Fine for an installed desktop tool, a browser
   extension, or the API's own portal, which loads it once and caches it. Not fine
   for a public web form on a slow connection. So client-side embedding is a
   power-user path, not the default — the server still has to embed for the common
   case.
2. **The prompt contract is load-bearing.** Queries embed with `SearchQuery`,
   documents with `Document`. Get it wrong and retrieval degrades silently, with no
   error. The API therefore has to publish the contract precisely and ship a client
   SDK that honours it — chunking, prompts, dimension, normalisation. A two-kilobyte
   SDK that removes four ways to get it wrong is a real reason to use the API
   rather than compute your own vectors.
3. **Quantisation drift.** The client runs a QAT-quantised build; the server may run
   something else. Small differences, but they can flip near-ties. **The fix is a
   decision, not a bug: embed the corpus with the exact artefact you ship to
   clients**, so client-side and server-side vectors are in one space.

**One segmentation falls out of this.** Client-side embedding helps the *legal
research* surface — a law-firm tool, a compliance checker, a contract-review
integration — far more than it helps the brief. The brief's answer is time-sensitive
(news, sentiment, bills in flight) and a topic string is not really a vector
query. The statute and debate corpora are where a question is a question, and those
are the queries a sensitive organisation would not want to send.


Ranked, for a Canadian-civic corpus on a Cloudflare-centric stack.

**1. Cloudflare AI Search** — the managed answer. Hybrid BM25 + vector with RRF
fusion, reranking available, and **Workers AI embedding calls are free inside it**.
The 30M-token corpus is about $19 to ingest. The binding constraint is the
**512-token input cap** on the models it hosts, which is a chunking constraint, and
the task-prefix problem on `embeddinggemma-300m`, which is a quality risk. Lowest
operational burden; a young product; the corpus is locked into its chunking.

**2. Containers, with llama.cpp and PGlite** — the full-control answer. No
third-party inference, the embedding model can be changed without re-platforming,
and the 8,192-token window is available. The cost is operational: you own the
image, the GGUF, the HNSW tuning, the index rebuilds, and R2-FUSE persistence.
**PGlite goes in the container, never in a Worker.**

**3. Vectorize plus your own lexical arm** — raw vectors with metadata filters, no
ranking beyond cosine, no BM25. Effectively free ($0.04–0.07 a month for this
corpus). Right only if there is already a hybrid-search layer to plug into — and
there now is, in `src/eval/bm25.ts`.

**4. A third-party inference API through AI Gateway** — the escape hatch.
`gemini-embedding-2` is 1,536 dimensions, 8,192-token window, about $6 for the
corpus.

**Not viable, and worth recording so nobody tries them again:**

- **PGlite in a Worker or a Durable Object.** The empty WASM heap is 188.75 MB
  against a 128 MB ceiling. Dead before it stores a row.
- **Any Gemma-class model inside a Worker.** The smallest is 166 MB at q4; Workers
  have no WebGPU, only WASM.
- **A Durable Object as an inference service.** A DO is a Worker. It can hold a hot
  shard of a few thousand vectors; it cannot be a system of record.

**The decision does not need to be made yet.** The corpus is already embedded once
with `bge-m3`; the evaluation compares the arms; and the three models worth
comparing — `embeddinggemma-300m`, `qwen3-embedding-0.6b`, `bge-m3` — cost
$0.36 each for the whole corpus. That is an afternoon.

## The evaluation result

Run against the corrected corpus — 19,021 provisions (every provision of the six
Acts the labelled set touches, plus 15,000 sampled distractors), 36 questions, 18
phrased in the statute's own words and 18 in ordinary language.

```
  keyword           hits  21/36  R@1 22.2%  R@5 47.2%  R@10 50.0%  MRR 0.310
    exact                   18/18   R@5 83.3%  MRR 0.586
    concept                  3/18   R@5 11.1%  MRR 0.034

  keyword-reranked  hits  21/36  R@1 47.2%  R@5 55.6%  R@10 55.6%  MRR 0.508
    exact                   18/18   R@5 100.0% MRR 0.903
    concept                  3/18   R@5 11.1%  MRR 0.113

  vector            hits  32/36  R@1 55.6%  R@5 66.7%  R@10 69.4%  MRR 0.617
    exact                   18/18   R@5 100.0% MRR 0.903
    concept                 14/18   R@5 33.3%  MRR 0.331

  vector-reranked   hits  32/36  R@1 47.2%  R@5 61.1%  R@10 75.0%  MRR 0.560
    exact                   18/18   R@5 100.0% MRR 0.903
    concept                 14/18   R@5 22.2%  MRR 0.217

  hybrid (equal)    hits  30/36  R@1 38.9%  R@5 63.9%  R@10 66.7%  MRR 0.501
```

### What it says

**The vector arm earns its place.** 14 of 18 concept questions against 3 for the
keyword baseline, and MRR 0.617 against 0.310. The keyword arm cannot find a
provision described in ordinary language, and no amount of tuning changes that: it
found "Motor Vehicle Safety Regulations s.6" for *"I had a couple of drinks at
dinner and then drove my car home."*

**Fusing the two arms is worse than using the vector arm alone.** Equal-weight
reciprocal rank fusion gets 12/18 concept questions and MRR 0.501 — it drags the
strong arm down to meet the weak one. A sweep over the fusion constant and the
weight finds settings that match pure vector (best MRR 0.619 against 0.617) and
none that beat it. The architecture is **vector-first**, not a fusion.

**The reranker earns nothing on top of the vector arm.** Vector-then-rerank scores
MRR 0.560 against vector's 0.617 — reranking *lowers* MRR and R@1 while nudging
R@10 from 69.4% to 75.0%. It is a precision tool with a hard ceiling: it can only
reorder what the first stage returned, and the vector stage already returns the
answer in the top five for every exact question. Its real value is on the
*keyword* path, where it lifts exact questions from R@5 83.3% to 100% — but the
vector arm reaches 100% on its own.

**So: build the vector index, drop the reranker, do not fuse.** And the citation
path stays structural — resolved, not ranked.

### The four questions nobody found

Four concept questions were missed by every arm:

| Question | Gold |
|---|---|
| A department gave my name to a private company without asking | Privacy Act s.8 — Disclosure of personal information |
| Two grocery stores met and agreed not to undercut each other | Competition Act s.45 — Conspiracies between competitors |
| I moved to Ottawa last year — which riding can I vote in? | Canada Elections Act s.8 — Place of ordinary residence |
| Who decides who runs the polls in my district? | Canada Elections Act s.24 — Appointment of returning officers |

Three of them are answered by a provision whose text is a **heading and a
cross-reference rather than a rule** — s.8 of the Privacy Act says the department
"shall disclose" and then lists the exceptions; the reasoning is in the shape of
the section, not in a phrase that matches the question. That is a real limit of
embedding-based retrieval over legal text, and it argues for the citation path and
for the reranker as a *second stage over the vector candidates* on exactly these
questions, not as a general arm.

## Where the encoder runs

The verdict makes the encoder a requirement, and the requirement picks the host.

EmbeddingGemma 2 — the 270M text checkpoint, Apache 2.0, ungated — **cannot be
served by Workers AI**. What Cloudflare hosts is `embeddinggemma-300m`, a different
checkpoint, and its schema accepts no task prefix, so it cannot be prompted the way
the model was trained.

The artefact that *is* the model is a single portable file:

```
litert-community/embeddinggemma-2-text-270m-litert-lm
  └── embeddinggemma-2-text-270m.litertlm      157.0 MB
```

`litert-lm` (PyPI, Apache 2.0) serves it behind an OpenAI-compatible
`POST /v1/embeddings`. **The same file runs in the browser**, through the LiteRT-LM
WASM build, today.

That is the whole argument for hosting the encoder yourself: the corpus can be
embedded with the *exact artefact the client embeds with*, so the two are in the
same space by construction rather than by approximation. A server running fp32
PyTorch weights and a browser running the QAT bundle would produce vectors that
differ by quantisation drift, and drift flips near-ties — which is precisely the
case where a citation either resolves or does not.

| | |
|---|---|
| Model | `embeddinggemma-2-text-270m.litertlm` |
| Licence | Apache 2.0, ungated |
| Dimensions | 768, with Matryoshka truncation available |
| Task prefixes | `SearchQuery:` / `SearchDocument:` — supported, because the bundle carries its own preprocessor |
| Host | Railway, `litert-lm serve` |
| Client | the browser, same file, LiteRT-LM WASM |
