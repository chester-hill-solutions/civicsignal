# The platform: one host

## Current v1 authority

Historical Railway migration proposal. Cloudflare remains the production target; Railway remains in place.
[The v1 release checklist](V1-RELEASE.md) takes precedence over the historical claims below.

The decision, the shape, and the order it happens in.

## The decision

**CivicSignal runs on Cloudflare.** The API is a Worker, the corpus rows are in
D1, the vectors are in Vectorize, the encoder is a container, and the keys and
the fuse are in KV and a Durable Object.

**The harness runs on Railway**, because it spawns processes and a Durable
Object cannot. That is the only thing on the second host.

This reverses the decision this document used to hold — "one host: Railway" —
and the reason is simple: **two platforms is two deploy pipelines and two
failure domains**, and the product is early enough that the complexity is
bigger than the thing it was buying. The port to Railway is kept, because the
code is written and the seam it proved is the reason the Cloudflare side was
quick to change; but the corpus plane it built is not deployed.

## Why

The split between Cloudflare and Railway was inherited rather than chosen. The
spine came from `riding-and-address`, a Workers product, and the corpus moved to
Railway because the encoder and the corpus repository could not live in a Worker.
Nobody ever asked whether the API had to go with the corpus. It did not.

That turned into a real question, and it was answered by building both: the
Railway plane was a complete API over a Postgres with pgvector, and the
Cloudflare plane was the same API over D1 and Vectorize. **Two answers to one
question is one too many**, and the deciding argument is not the bill and not
the latency. It is that a product with two hosts has two deploys, two failure
domains and two sets of credentials, and it has not earned either.

What the code actually depends on:

| | Where | What it becomes |
|---|---|---|
| `KVNamespace` | one namespace: API keys and a timestamped cache | a `KeyStore` interface and a Postgres table |
| `DurableObjectNamespace` | one Durable Object: the monthly usage counter | an atomic upsert |
| `ExecutionContext`, `waitUntil` | background work after the response | `ctx.waitUntil` — Bun has it |
| `env` | the binding bag | a plain object |

That is the entire Cloudflare surface. Everything else is web-standard —
`Request`, `Response`, `Headers`, `fetch`, `URL`, `crypto.subtle` — and native in
Bun. The licence gate, `@chester-hill-solutions/corpus`, has **no runtime imports
at all**, so it moves for free.

### What is actually lost

- **Cloudflare Access** for administrative routes. The spine already has a shared
  secret scheme (`BASIC_AUTH`); use it.
- **Edge rate limiting.** It moves into the application, next to the meter, where
  it arguably belongs — the API is metered per call, so the limit belongs next to
  the meter rather than at the edge of a different provider.
- **Workers' scale to zero.** See the next section, because it is smaller than it
  sounds.
- **Workers' 30-second CPU ceiling.** A loss, for the harness's sake.

### What is kept on Cloudflare

**DNS, and Turnstile.** Both are free and host-agnostic, and neither is a hosting
decision.

## What is actually running today

**The API is on Cloudflare Workers, with the corpus in D1 and the vectors in
Vectorize** — which is now the decision above rather than a half-port.

What is complete and verified on this plane: 277,857 corpus rows (138,750
English, 139,107 French) and 254,672 vectors, with the repair script — which
asks the index what it holds rather than trusting a checkpoint — reporting **0
missing** in each language.

**The pipeline is here too.** `services/pipeline/` is a second Worker with a
cron on it, and it is the corpus's own continuous ingest: it asks the corpus
repository what revision it is at, stops if the store is already there, and
otherwise ingests what changed. The corpus is the product's content, and a
pipeline that updates it from somebody else's platform is a second deploy
pipeline, a second failure domain and a second set of credentials for a loop
that sleeps most of the day.

Two things about it are worth knowing.

**It is incremental, because the whole corpus does not fit.** The corpus is
878 MB of tarball and about a hundred and sixty seconds of parsing, and a
Worker has thirty seconds of CPU — the first version of this cycle died on
exactly that, with Cloudflare's error 1102. So the cycle asks GitHub which
files changed between the revision the store holds and the revision the corpus
is at, and fetches only those — forty-eight files for the corpus's last
commit, which is two minutes and twenty-five provisions embedded. The changed
file is fetched **twice**, once at each revision, because that is where the
removals are: a provision that is no longer in the corpus is a provision that
*was* in the old copy, and nothing about it arrives with the new one.

**The corpus's rows are read over HTTPS**, not from a clone: there is no
working tree, no volume and no git binary in the path. And the rows are
**fingerprinted** — each provision carries a 128-bit hash of itself, so the
reconciliation can tell what moved without reading the corpus's text twice.

The gap is real and it is worth being honest about. The decision was one host
because the marginal cost of a request is about $0.0004 and the product's
infrastructure cost is dominated by *state* — a corpus database and a customer
database, both of which need backups and both of which are cheaper to keep
than to rebuild. Cloudflare's D1 is the corpus's rebuildable half, which is
exactly what it is good for, and the customer half is still KV, which is
neither.

So the plane today is a **half-port**: the corpus is where it should be for
the cheap half, the API is where the code already was, and the customer
database is still in the KV namespace the spine came with.

What is *not* in doubt is that the port is worth doing. Railway's deploys
were paused, and a product that cannot be deployed is a product that cannot
be tested, and a product that cannot be tested is a product whose corpus is
never loaded — which is exactly what happened here for a month.

**The order does not change because the plane did.** The extraction is the same
either way, and the extraction is what makes the port cheap: once the metering
is a package and the keys are the house's, the Bun service is a thin shell
over code that has been tested on two planes already.

## Scale to zero, honestly

The argument for keeping the API on Workers is that it costs nothing when idle.
It is real. It is also smaller than it looks, because the corpus plane has to run
either way.

| Service | Has to be always on? |
|---|---|
| Postgres | **yes** — it is the data |
| The API | **yes** — it is the product |
| The encoder | **yes** — every query embedding goes through it |
| The pipeline | **no** — it is a cron job, and can be a one-shot task |
| The harness | ideally not — but a cold start per session is worse than a warm process |

So the floor is three services, and it is a floor the corpus plane already
implies. The API's own traffic would need about 100,000 calls a month before it
mattered against a $0.0004-per-query Workers bill — a long way off in a market
this thin.

### And the decisive argument

The harness **has** to run on Railway: it spawns processes, and a Durable Object
cannot. So the harness and the corpus are on the critical path together, and
splitting the API away from them puts a provider boundary in the middle of every
turn. One host removes that boundary, and with it a second failure domain, a
second deploy pipeline and a second bill.

## The shape

```
                    ┌─────────────────────────────────────────────────┐
                    │  CLOUDFLARE — one account, one deploy          │
                    │                                                 │
  browser ────────► │  api        Worker — the REST API, the MCP     │
                    │              server, the chat, the match surface │
                    │    │                                            │
                    │    ├──► encoder   a container, EmbeddingGemma   │
                    │    │              2, litert-lm, behind a         │
                    │    │              bearer-token proxy             │
                    │    │                                            │
                    │    ├──► D1        statute_sections (the rows)    │
                    │    │              corpus_state, corpus_runs,      │
                    │    │              corpus_changes                  │
                    │    │                                            │
                    │    ├──► Vectorize 254,672 vectors, with a      │
                    │    │              language index                 │
                    │    │                                            │
                    │    └──► KV + DO    the keys, the customers, the  │
                    │                 monthly counter                 │
                    │                                                 │
                    │  pipeline   a scheduled Worker, on a cron        │
                    └─────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────┐
                    │  RAILWAY — the harness, and nothing else      │
                    │                                                 │
                    │  harness    embedded OpenCode, one directory     │
                    │              per customer. It spawns processes,  │
                    │              so it cannot be a Durable Object.   │
                    └─────────────────────────────────────────────────┘
```

The licence gate runs in the API, on the way out. It is the only path from
stored text to a caller, and it stays that way.

## The extraction

The spine is shared with `riding-and-address`, so this is an **extraction, not a
fork**. Two products sharing a spine that has forked is the thing the spine
exists to prevent.

### `@chester-hill-solutions/api-billing`

```
packages/api-billing/
  src/
    types.ts          KeyRecord, CustomerRecord, KeyAuthResult, UsageLedgerResult
    key-store.ts      interface KeyStore { get, put, delete, list }
    usage-ledger.ts   interface UsageLedger { consumeMonthly, peekMonthly }
    keys.ts           verifyServerKey(store, secret)      — core logic
    customers.ts      customer projection
    billing.ts        recordBillable(ledger, customer)   — core logic
    policy.ts         the price, the free allowance, the meter event
  adapters/
    cloudflare/       KVKeyStore, DurableUsageLedger
    postgres/         PostgresKeyStore, PostgresUsageLedger
```

The core takes the interfaces. Each adapter implements them. `Env` leaves the
core entirely; each adapter has its own binding type.

This is the shape the house conventions already call for — a runtime-neutral
core, adapters at the edges — and the shape the spine's own comments already
name as its extraction target.

### The two adapters

**The Postgres usage counter.** The Durable Object was per-customer and strongly
ordered. Postgres gives the property that actually matters — atomicity — in one
statement:

```sql
INSERT INTO usage_counters (customer_id, month, count)
VALUES ($1, $2, 1)
ON CONFLICT (customer_id, month) DO UPDATE
   SET count = usage_counters.count + 1
 WHERE usage_counters.count < $3
RETURNING count;
```

No row comes back when the limit is passed, which is the denial. One round trip,
no single-threaded bottleneck, and the counter becomes queryable for the billing
report — which the Durable Object never was.

**The failure policy is preserved exactly.** The Durable Object adapter fails
*closed* on a hard fuse and *open* on a soft one, so free-tier abuse is bounded
during an outage and availability never depends on the counter. The Postgres
adapter fails the same way. This is the part of the port that must not drift,
because it is billing behaviour and it is invisible when it is wrong.

## The order

**The port to Railway is not deleted; it is stopped.** The Bun server, the
Postgres adapters and the customer store are written and tested, and they stay
in the tree — they are the evidence that the seam works, and the second
implementation is what made the reversal cheap. What goes is the *deployment*:
the Railway corpus plane and the Railway pipeline.

| # | Step | Where it is |
|---|---|---|
| 0 | The API, the corpus and the encoder on Cloudflare | **done** — 277,857 rows, 254,672 vectors, the Worker serving |
| 1 | The pipeline's store on D1 and Vectorize | **done** — the second `CorpusStore`, verified against the live D1 |
| 2 | The pipeline as a scheduled Worker | **done** — the incremental cycle, the cron trigger, the fingerprints backfilled |
| 3 | The Railway corpus plane and the Railway pipeline are torn down | waits on a `railway login` |
| 4 | The Railway project keeps only the harness | with the harness |
| 5 | `docs/PLATFORM.md` and the handoff record the decision | **done** |

**What step 2 got right.** The cycle is **incremental**: GitHub's compare
endpoint names the files that changed, and only those are fetched and parsed.
The removals fall out of fetching the changed file at *both* revisions, rather
than out of diffing the whole corpus. The tarball reader is still there and
still uses `DecompressionStream` — `node:zlib` is not in the Workers runtime's
guaranteed surface, so a module that imported it could never be bundled for
one — and the store's rows go out as **one batch**, because a statement sent
on its own is one subrequest and a Worker has a ceiling of a thousand.

**What step 2 did not get right, and it is one thing.** GitHub's compare
endpoint names **at most 300 files**, and it does not say that it has stopped
early — so a commit that moves more than three hundred files cannot be
ingested incrementally, and the cycle says so rather than quietly skipping the
rest of the corpus's changes. The corpus's last commit moved forty-eight
files; a re-consolidation would move thousands. **That case is not handled**:
it needs the full tree, chunked across invocations, with the checkpoint in D1.
The streamed cycle (`src/ingest/streaming-pipeline.ts`) is written and tested
for it, and it is not wired up.

## The corpus stack, decided

Where each piece of the corpus lives, and why. Decided 2026-10-22; the
reasoning and the arithmetic are in the handoff.

| | | |
|---|---|---|
| **The snapshot** — the corpus as rows, with a fingerprint per row | **R2** privately, **Hugging Face** publicly | The diff is the store's fingerprints against the snapshot's index, ~25 MB, merged rather than held. The rows are read by byte range, and are **parts** because a single object cannot be published (the 300 MB ceiling on both wrangler and the API). R2 is in the same account, so there is no egress and no third-party rate limit; the corpus is public law, so the row-level artefact is worth publishing. |
| **The serving rows** — what the API reads, licence-gated | **D1** | The licence gate reads the canonical row and its policy, and the citation path resolves against it. The lexical arm's `LIKE` is going away with `search_text`; what remains is point reads, citations and the gate. |
| **The vectors** | **Vectorize** | $1.55/month at 1,000 queries, $0.0077 per 1,000 more, free when idle. The crossover with a keep-warm container is ~3.3M queries/month. The snapshot carries the vectors as an *export*, so the rebuild is a copy — ownership without giving up a free-when-idle index. |
| **The model** | **EmbeddingGemma 2**, in a container | The browser and the server share one vector space, by construction rather than approximately. |

The corpus's text is stored **once**. `search_text` — a 250.9 MB folded copy
of the corpus's 232.5 MB of text, searched with a full table scan per query,
and the one column no fingerprint covers — is being deleted rather than
indexed. The keyword input becomes a filter over the semantic hits instead of
a filter over the whole corpus.

## The risks

**Billing correctness is the whole risk.** The ledger's fail-closed and fail-open
policy is behaviour, not plumbing, and it is invisible when it is wrong. The
mitigation is that step 1 changes nothing and step 2 is a second implementation
of an interface that already has three.

**The port is the largest piece of work left.** It lands on top of a heavy week.
It is worth doing — but not before step 0, and not while two things are broken
at once.

**One Postgres is a single point of failure.** Today the corpus is on Railway and
the customers are on D1, so a Railway outage takes the corpus but not the
customer records. One host means one outage takes everything. That is the price
of one bill, and for a single-operator product with a nightly-ish corpus it is
the right trade — but it should be a decision rather than an accident.

## What does not change

- The retrieval architecture. Vector-first, no reranker, citations resolved
  structurally.
- The encoder. EmbeddingGemma 2, self-hosted, the same file the client runs.
- The corpus model. In force and repealed, with the citation that resolves.
- The licence regime. Three regimes, enforced at emission, now enforced again in
  the harness as a hook.
- BYOK. The customer's key, in the customer's store.
