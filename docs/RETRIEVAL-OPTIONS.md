# Retrieval: the vector arm, and where the pieces actually run

This is the investigation behind one decision: **does a semantic retrieval arm earn
its running cost on top of the keyword search the product already has?**

Everything below was measured on 2026-10-19, against the real corpus.

## The corpus

| | |
|---|---|
| Sections | **191,025** |
| Instruments | 5,188 (971 Acts, 4,897 regulations) |
| Approximate tokens | **30.1M** |
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
| Vectorize storage, 191,025 × 768 dims | **$0.068/month** |
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
pgvector extension is a separate package, `@electric-sql/pglite-pgvector`, and its
export is named `vector`.

| | |
|---|---|
| pgvector `vector` type, `<=>` distance operator | **works** |
| Distance filters (`WHERE emb <=> $1 < 0.5`) | **works** |
| **HNSW index** (`USING hnsw (emb vector_cosine_ops)`) | **works** |
| ivfflat index | works |
| **FTS5** (`CREATE VIRTUAL TABLE … USING fts5`) | **not available** — "syntax error at or near VIRTUAL" |
| `ts_rank` | **not available** (core `to_tsvector` exists; the ranking function does not) |
| `pg_trgm`, `unaccent`, `cube`, `btree_gin`, `uuid-ossp` | **not available** — the contrib bundles ship in the package but the extensions are not built into the WASM binary |
| `PGliteWorker` (the official Workers build) | exists, takes a `Worker` for persistence |

So PGlite is **a vector store with a SQL front-end, not a hybrid search engine.** The
lexical arm has to live in the application — which is fine, because it now does: the
BM25 in `src/eval/bm25.ts` is about two hundred lines and is unit-tested.

### The memory wall for a Worker

A Worker has 128 MB. The statute index at full precision is:

| | |
|---|---|
| 191,025 × 768 dims, float32 | **587 MB** — 4.5× the limit |
| 191,025 × 256 dims, float32 | 196 MB — over the limit |
| 191,025 × 128 dims, float32 | 98 MB — fits, with no room for PGlite itself |
| 191,025 × 256 dims, int8 | 49 MB — fits, but `vector` is float4; `halfvec` gives 98 MB at fp16 |

**A Worker cannot hold the statute vector index at a useful dimensionality.** PGlite
on an ordinary server can — a 2 GB instance holds the 768-dim index in 587 MB with
room to spare, HNSW works, and it is one database for both the relational rows and
the vectors.

The two shapes are therefore:

- **Vectorize** — 768 dimensions, $0.068/month, no memory pressure, but a second
  service to keep consistent with D1.
- **PGlite on a small server** — one Postgres for the rows and the vectors, SQL
  joins between them, HNSW, no dimensional ceiling until the instance fills, but a
  running service to operate and a lexical arm built by hand.

Either way, **the vector index holds no text.** Only the embedding and metadata
(row id, jurisdiction, date, corpus) live in it; the canonical row, the text and the
licence policy stay in the relational store. That is what keeps the index from
becoming a second copy of the corpus that bypasses the policy gate.

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

**A caveat on Workers AI that is not in the model card.** The limit is on the whole
*request*, not on each document: a batch totalling more than 60,000 tokens is
rejected outright, however many documents it contains, and the error reads
`Max context reached 123700 tokens but model supports only 60000`. A hundred short
sections fit easily; ten long ones do not. Batches therefore have to be budgeted by
tokens rather than by count, and the section length distribution is heavy-tailed
enough that a count-based batch fails constantly. The corpus averages 157 tokens per
section and runs to 61,000.

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
fusion — over the full 191,025-section corpus, and prints a verdict:

- the vector arm earns its place, or
- it helps on concept questions and costs exact ones, in which case the vector arm
  should run only when the keyword arm scores weakly, or
- it does not earn its running cost, in which case the keyword index stays and the
  RAG stops here.

The set is 36 questions. Every gold answer is an Act and a section, both checked
against the corpus before anything is scored, so a mis-specified question is reported
rather than quietly counted as a miss.
