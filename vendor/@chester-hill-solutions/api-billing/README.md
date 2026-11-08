# `@chester-hill-solutions/api-billing`

Metering: the count, the fuse, and the meter event.

The house has `auth` — keys, sessions, OAuth, capabilities, workspaces. It does not
have this: **nothing in the repository counts what a customer has used, and decides
whether the next call is allowed.** Two products had each written their own, and
they had already disagreed about the one behaviour that matters.

## Install

```bash
bun add @chester-hill-solutions/api-billing
```

## What it is

A **usage ledger** — a counter per customer per period — and the **fuse** that
decides what happens when the counter reaches its limit.

The counter is the service's own record. A Stripe billing meter event is a *copy*
of it, and the copy is best-effort by design: a Stripe outage must not stop the
product serving.

```ts
import { InMemoryUsageLedger, recordSuccessfulBillable } from "@chester-hill-solutions/api-billing";

const ledger = new InMemoryUsageLedger();
const customer = {
  id: "cus_123",
  plan: "metered" as const,
  fuseLimit: 1000,
  fuseSoftWarn: false,
  stripeCustomerId: "cus_123",
};

const outcome = await recordSuccessfulBillable(
  customer,
  { freeFuseLimit: 1000, meterEventName: "api_call", stripeSecretKey: process.env.STRIPE_SECRET_KEY },
  { ledger },
);

if (!outcome.allowed) {
  // 429, with the fuse's own dialect.
  return new Response(JSON.stringify(outcome.body), { status: outcome.status });
}
```

## The three behaviours that are easy to get wrong

**A hard fuse fails closed.** If the counter cannot be read, the call is refused.
Free-tier abuse must be bounded even during an outage, and a limit that lifts when
the database is down is not a limit.

**A soft fuse fails open.** If the counter cannot be read, the call is allowed.
Availability must not depend on the counter, and the cost of a wrong answer here is
a few unbilled calls rather than a product that is down.

**An authoritative quota refusal is not counted.** Otherwise an attacker who keeps trying pushes
the counter up and makes the number meaningless. In the Postgres adapter this is
the `WHERE` clause on the upsert, and it is why the counter and the decision can be
one statement.

## Exports

| Export | What it is |
|---|---|
| `recordSuccessfulBillable` | Count a call, enforce the fuse, report it |
| `peekUsage` | Read the count without changing it |
| `billableDenialResponse` | The body for a refusal, in one dialect |
| `effectiveFuseLimit`, `enforcementLimit` | The limit that applies, and the limit that is enforced |
| `failClosed`, `failOpen` | The two failure policies |
| `UsageLedger` | The interface a store implements |
| `InMemoryUsageLedger`, `StaticUsageLedger` | Test doubles |
| `MeterConfig`, `MeteredCustomer`, `UsageLedgerResult` | The shapes |
| `./durable-object` | `ApiKeyUsageDO` and `DurableObjectUsageLedger` |
| `./postgres` | `PostgresUsageLedger` and its DDL |

## What it is not

- **Not a key store.** The house's `auth` package owns keys, sessions and OAuth.
  A customer here is identified by an id, and that id is whatever the product's
  auth layer calls it — for the house, a workspace.
- **Not a customer record.** `MeteredCustomer` is the narrow view the meter needs:
  an id, a plan, a limit, and whether the limit refuses or warns.
- **Not a price.** The unit price is the product's business. This package counts
  units; it does not know what they cost.
- **Not a rate limiter.** It is a monthly allowance, not a request-per-second
  limit. A rate limiter protects capacity; a fuse bounds spend.
- **Not a store.** The policy is here; the counters are in a Durable Object or a
  Postgres table.

## Develop in this repo

```bash
bun run --cwd packages/api-billing test
bun run --cwd packages/api-billing typecheck
bun run --cwd packages/api-billing build
```

The core is runtime-neutral: no `node:*`, no `Buffer`, no `process.env`, no SQL. The
stores are subpath exports, so a consumer that never touches Postgres never loads it.


## Counter and failure contracts

Limits and counts are nonnegative JavaScript safe integers. A limit of `0` means
unlimited; negative, fractional, infinite and NaN limits are rejected before any
counter request. Customer ids must be nonempty strings. The static ledger is an
explicit test/disabled-metering override; it does not enforce a quota.

The Postgres adapter uses a single atomic upsert and bound customer/period/limit
values. Its default table is `usage_counters`; a custom name may be `table` or
`schema.table`, with SQL identifiers only. The initial DDL uses `BIGINT` and a
check constraint limiting stored counts to `0..Number.MAX_SAFE_INTEGER`. The DDL
is exported, and the host applies it. `CREATE TABLE IF NOT EXISTS` does not migrate
an existing prototype table: an old `INTEGER` counter needs an explicit
`ALTER COLUMN count TYPE BIGINT` and matching check constraint before upgrading.

The Durable Object is one object per customer. Its storage transaction includes
the limit check, increment and daily retention. Use a SQLite-backed class with
`new_sqlite_classes: ["ApiKeyUsageDO"]` in the host's Wrangler migrations; its KV
storage API also works with existing legacy KV-backed objects. Install the
optional `@cloudflare/workers-types` peer when consuming the typed DO subpath;
use the host's generated namespace binding as the ledger constructor argument.
Do not expose its raw counter endpoint without host authorization: customer
routing, billing periods and policy limits are supplied by trusted application
code, not by a public caller.

The counter endpoint is `GET /consume` (read) or `POST /consume` (consume one).
Supply either `month=YYYY-MM` or `day=YYYY-MM-DD`; omitted periods default to the
current UTC month. `limit` defaults to zero. Other methods are rejected without
mutating state. Monthly rows are retained; successful daily writes remove rows
older than seven UTC days in pages/deletion batches of at most 128 keys.

DO requests have a five-second deadline; wire replies are capped at 4096 bytes
and validated for count, period, limit and decision consistency. Malformed 2xx
replies are failures. Both DO and SQL adapters refuse a hard-limit call on store
or decoding failure, and allow unlimited/soft use with a fallback count of zero.
That fallback is availability policy, not evidence that no calls occurred. Invalid
caller configuration throws instead of being treated as an outage. Configure
connection/query timeouts on the injected SQL runner; the adapter does not cancel
queries already issued to Postgres.

This helper does not implement a reservation/rollback protocol. It records a
completed unit and returns a decision; it cannot undo work or side effects the
host already performed. The host must choose a suitable gate before releasing
billable output or causing irreversible effects. A lost or late DO/SQL response may leave a
count committed even when the caller conservatively receives a refusal; do not blindly retry a
billable operation. Atomic counters are not exactly-once request processing.

## Stripe delivery boundary

Stripe reporting is best-effort, with a ten-second request deadline. An error
status or transport failure is logged and does not revoke an allowed call. A
refused call is never reported. Pass `waitUntil: task => ctx.waitUntil(task)` in a
Worker to extend the reporting task's lifetime; otherwise it is awaited.

There is no durable event outbox, automatic retry, reconciliation or exactly-once
reporting here. Each attempt has a fresh UUID identifier, independent of customer-id length; event
names must contain 1 to 100 characters. The supplied clock determines both the
ledger period and Stripe event timestamp; Stripe still enforces its own accepted
timestamp window. An aggregate counter
cannot reconstruct individual failed meter events or their delivery status; the
host must supply any stronger billing-delivery guarantees it needs.

## Local development and conformance

No service is required for ordinary package tests: PGlite exercises the Postgres
statement and Miniflare/workerd runs the real DO class with transactional storage.
Tests include simultaneous requests for the last unit, corrupt counters and
retention of more than 128 old daily keys. Node 22+ is required for the local
Miniflare test runtime; production consumers use the runtime appropriate to their
chosen adapter.

For a zero-infrastructure Postgres development ledger:

```ts
import { PGlite } from "@electric-sql/pglite";
import { PostgresUsageLedger, USAGE_COUNTERS_DDL } from "@chester-hill-solutions/api-billing/postgres";

const db = new PGlite("./.pglite-api-billing");
await db.exec(USAGE_COUNTERS_DDL);
const ledger = new PostgresUsageLedger({
  unsafe: async (query, params) => (await db.query(query, params)).rows,
});
```

Real Postgres tests use two independent connections and an isolated temporary
schema, dropped after the run:

```bash
API_BILLING_POSTGRES_TEST_URL=postgres://user:password@127.0.0.1:5432/test_database \
  bun run --cwd packages/api-billing test:integration
```

The CI Postgres 17/18 matrix runs that conformance test in addition to the
self-contained package suite. Do not point it at a production database.
