# Corpus rollback without authorization rollback

`CIVIC_DB` selects corpus rows and publication history. Optional `AUTH_DB` selects
both CHS workspace keys and `civic_workspace_billing`. When `AUTH_DB` is omitted,
authorization uses `CIVIC_DB` for compatibility. A configured auth database failure
returns `503/AUTH_UNAVAILABLE`; it never falls back to stale keys or billing in the
corpus database.

A corpus-only rollback must retain an **explicit, unchanged `AUTH_DB` binding**.
Keeping the CHS authorization code alone does not preserve revocations if its
backing store changes. A post-copy revocation, capability removal, disabled
workspace, tightened fuse or replacement key must continue to use the current
authoritative store.

## Binding plan

Record the actual account, Worker versions, D1 IDs and usage namespace before
approval. Let `F` be the fresh store containing the current authoritative auth
state, and `O` the intact original corpus store. These are existing stores; this
procedure requires no new resource.

| Binding | Fresh serving configuration | Corpus rollback configuration |
| --- | --- | --- |
| `CIVIC_DB` | `F` | `O` |
| `AUTH_DB` | Explicitly `F` | Same explicit `F` |
| `CORPUS_TEXT_MODE` | Verified `r2` mode | `d1`, with intact verified text in `O` |
| `API_KEY_USAGE` | Existing script/class/namespace | Exactly the same script/class/namespace |
| Vectorize | Existing verified index | Same index, compatible with `O` |

Both D1 aliases can initially name the same physical fresh database. Declare and
verify `AUTH_DB` before relying on this rollback. Omitting it on rollback would
silently select `O` for authorization. Keeping a different existing store as the
authority is also possible, but its exact identity must be selected and retained
through the whole procedure; a corpus switch must never select it implicitly.

Retain the same API Worker identity, `ApiKeyUsageDO` export, binding/namespace ID,
workspace IDs and `customer:<workspace id>` names. Preserve monthly counters and
operation receipts. Replacing a namespace or moving to another Worker with a new
local namespace would reset enforcement even if the binding name stayed the same.
Key issuance, revocation and billing SQL must target the recorded `AUTH_DB`,
regardless of which store currently serves corpus rows.

## Independent corpus readiness gate

The intact original store is not automatically a valid rollback target. Before a
fresh copy and switch, establish that its full rows, parser identity, publication
state, schema and fingerprints are compatible with the retained vectors and
serving build. Complete the approved parser reconciliation on the original store
while retaining its D1 text, and verify actual vector visibility/alignment; an
upsert acknowledgement or empty mutation outbox alone is insufficient. The
`statutes-v2` snapshot and legacy parser cannot be treated as interchangeable just
because provision IDs or source commits match.

Use only reviewed additive migrations on the existing store; do not replay all
historical migrations or retry the failed `0004` live column drop. An empty-store
all-migration fixture does not establish live migration compatibility. Verify
publication/history and required serving columns on the actual rollback store.
Keep the original text intact and check its bytes before selecting `d1` mode.
This authorization change supplies none of that hosted corpus/vector evidence.

## Reviewed rollback procedure

1. Suspend and drain the corpus writer using the existing coordinator maintenance
   protocol; keep its namespace and suspension revision. Removing Cron schedules
   alone does not stop recovery alarms. Do not redirect a pending checkpoint to a
   different corpus store or automatically resume ingestion after a serving switch.
2. Retain consistent backups and actual binding descriptors. Record the current
   `AUTH_DB` identity and current key/capability/billing state separately from the
   original corpus backup. CHS key verification writes `last_used_at` and
   `updated_at`; public authentication is not a read-only auth acquisition method.
3. Prepare and review a build that retains the CHS authorization path. Change only
   the corpus binding and its matching text mode according to the table. Keep
   `AUTH_DB`, the API Worker/usage namespace, workspace identity and vectors fixed.
   Review actual returned descriptors after the approved switch.
4. Check an active replacement key, a post-copy revoked key, a removed capability,
   a disabled workspace and a tightened fuse through HTTP and MCP. Drain MCP
   JSON/SSE results before claiming success or checking usage. Denied requests must
   consume no unit; successful HTTP/MCP retrievals must share the existing allowance
   and preserve prior operation receipts. Use separately approved bounded hosted
   requests; the local tests below do not spend or replace that budget.
5. Keep the writer suspended until a separate recovery plan validates its corpus
   target, checkpoint, parser and vector state. No automatic reverse auth copy,
   usage reset, old KV-auth Worker, or alternate scheduled run is part of rollback.

This is a corpus-binding rollback, not an auth-store disaster-recovery procedure.
Restoring the entire physical `AUTH_DB` from an older D1 snapshot/Time Travel
bookmark can still reverse revocations and billing changes. A failed or restored
auth store requires a separate checked recovery of its current authoritative
state; serving fails closed until then.

## Why the current copy tools are not reverse synchronization

The offline protected-state copier preserves auth and history from a sealed
consistent source into an empty protected target. It refuses populated targets
and conflicts; it does not synchronize current auth back into an older populated
corpus store. The legacy auth migration also deliberately keeps existing billing
on conflict and cannot propagate arbitrary current CHS capabilities or profile
changes. Neither command establishes safe reverse auth synchronization.

Freezing all security/billing changes for the lifetime of a rollback window would
avoid divergence only while that freeze actually holds; it cannot support normal
revocations and rotations. Explicitly retaining the authoritative binding avoids
that dependency. After corpus/auth bindings diverge, backups must identify both
sources. A corpus backup must not be presented as a current auth backup.

## Local regression evidence

```sh
node node_modules/vitest/vitest.mjs run test/corpus-rollback.test.ts test/access.test.ts test/endpoints.test.ts test/auth-migration.test.ts test/key-operations.test.ts
bun run typecheck
node scripts/check-billing-invariants.mjs
node scripts/check-corpus-invariants.mjs
```

The rollback tests exercise the real API handler, CHS verification, billing lookup,
HTTP/MCP retrieval and shared usage DO protocol with synthetic in-memory SQLite
and durable-storage fixtures. They mutate auth after the initial clone, then
switch only `CIVIC_DB`. They prove the selector and allowance/receipt behavior;
they do not prove deployed bindings, real provider durability or full corpus/vector
compatibility. No Cloudflare configuration, resource or default binding is changed
by this implementation.
