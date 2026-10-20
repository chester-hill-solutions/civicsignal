# The platform: one host

The decision, the shape, and the order it happens in.

## The decision

**CivicSignal runs on one host: Railway.** A Bun service, a Postgres database, the
encoder, the pipeline and the harness, all on one private network, one bill, one
deploy.

The API is not on Cloudflare Workers.

## Why

The split between Cloudflare and Railway was inherited rather than chosen. The
spine came from `riding-and-address`, a Workers product, and the corpus moved to
Railway because the encoder and the corpus repository could not live in a Worker.
Nobody ever asked whether the API had to go with the corpus. It did not.

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
                    │  RAILWAY — one project, one environment        │
                    │                                                 │
  browser ────────► │  api        Bun.serve — the REST API, the MCP   │
                    │              server, the chat, the match surface │
                    │    │                                            │
                    │    │  localhost                                  │
                    │    ├──► encoder   EmbeddingGemma 2, litert-lm,  │
                    │    │              behind a bearer-token proxy    │
                    │    │                                            │
                    │    └──► postgres  one database, one schema      │
                    │                 statute_provisions (rows +      │
                    │                 vectors), api_keys, customers,   │
                    │                 usage_counters, cache,           │
                    │                 corpus_state, corpus_runs,       │
                    │                 corpus_changes                   │
                    │                                                 │
                    │  harness    embedded OpenCode, one directory     │
                    │              per customer                       │
                    │                                                 │
                    │  pipeline   one-shot, on a schedule              │
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

The corpus plane has to be working first. If Postgres is wrong, the port is
wrong too — and the port is much easier to verify when there is a working
reference on both sides.

| # | Step | Risk |
|---|---|---|
| 0 | Railway is up; Postgres, the encoder and the pipeline work | — |
| 1 | **Extract the spine** into `@chester-hill-solutions/api-billing`, with the Cloudflare adapter only. CivicSignal keeps vendoring it; CanCoder is untouched. | none — a pure extraction |
| 2 | Add the Postgres adapter to the package, tested against a real Postgres | low |
| 3 | **CivicSignal's Bun server**, running alongside the Worker, the same tests pointed at it | low — two live implementations |
| 4 | Move the corpus store from D1 to the same Postgres | medium — the corpus, but it was moving anyway |
| 5 | Cut over DNS to Railway. Keep the Worker deployable for one release as the rollback | low |
| 6 | Delete the D1, KV and DO bindings and the wrangler config | none |
| 7 | The harness joins the same host | low |
| 8 | CanCoder migrates when it wants to; its Cloudflare adapter stays until then | none |

Step 1 is the one that makes the rest safe, and it is the one that is pure.

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
