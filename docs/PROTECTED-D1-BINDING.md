# Local protected-state D1 binding

The fixed-table binding helper is implemented and tested against synthetic local
workerd D1/R2. It has no hosted route, credentials, acquisition code or production
target configuration. `checkedTarget` remains staging-only. This completes the
local apply/verification slice; it does not authorize a hosted restore.

## Inputs and interface

`prepareProtectedD1Admission` in `scripts/lib/protected-state-d1.ts` calls the
existing private-file `loadProtectedStatePlan` and text-cutover validator. It
checks every original page, whole-file SHA and table digest, adds strict primary
key ordering using SQLite UTF-8 BINARY order, and records exact source sequence
presence/values. Nonempty history without source sequence facts is refused.
The new sidecar is written exclusively with mode 0600 and file/directory fsync.
Original format 1 manifest/pages are not rewritten.

The sidecar pins the original manifest/pages, canonical manifest, protected page
chain, checked compact restore plan and explicit staging target. The old
`manifest.targetSha256` remains provenance for a local SQLite file; it is not a
claim about D1 physical bytes. The initial publication must have exactly the
seven fixed scalar columns and equal the checked compact plan publication.

`src/corpora/protected-state-d1.ts` exposes only these binding functions:

```ts
beginProtectedD1(db, {manifest, admission, identity})
checkProtectedD1CorpusPage(db, compactPage, identity)
checkProtectedD1Text(db, textBucket, identity)
applyProtectedD1Page(db, protectedPage, identity)
verifyProtectedD1Page(db, protectedPage, identity)
finishProtectedD1(db, identity)
```

The identity is `{admissionSha256, manifestSha256, target}`. Table names, column
names, migrations and SQL statements are fixed in code. The only optional auth
DDL is byte-identical to migration 0005, enforced by a test. Responses contain
phase and progress counts; raw D1 failures become a fixed error code.

## Admission and completion

The durable phases are `checking-corpus`, `checking-text`, `loading`,
`checking-protected`, `checking-corpus-final`, and `complete`.

Admission accepts only the exact compact/restore schema and absent or exact empty
auth tables. It rejects partial/populated auth, unknown tables/indexes/triggers/
views, generated columns and altered constraints. Known D1 bookkeeping is matched
against the existing exact allowlist. The schema inventory has a 64-object sentinel;
column inspection follows a known fixed schema match. Initial history/mutations
must be empty and both initial history sequence entries must be absent.

The existing stage restore receipt must be complete and match the exact compact
plan, staging identities, page cursor and chain. Its prior audit checkpoint is
never used as the protected helper's text proof. Every compact page is checked
against actual D1 metadata, all seven text-reference columns and its original
journal entry. Full chains/counts exclude missing or extra rows. A separate
session-owned strict R2 audit starts without a checkpoint and reads every text
object before the first protected row can be inserted.

Each protected page uses plain INSERTs. The original source publication replaces
the exact saved baseline in its own guarded page batch. Sequence restoration
preserves deleted-ID highwaters and the distinction between absent and explicit
zero entries. Intermediate automatically generated entries are tracked separately
from the count of sealed sequence rows already loaded.

A fail-on-false-or-NULL constraint guard, row statements, receipt and session CAS
share one D1 batch. The guard binds the full seven-column publication, counts,
sequence presence/values, restore proof, immutable session identity and exact
prior state/version. A late failure rolls back the entire page. Replaying a
committed page is read-only and checks its receipt and every actual stored value.

After loading, unchanged sealed pages must be presented again in order and match
actual rows, receipts, counts and the full pinned chain. A second complete compact
metadata/reference scan is required before finalization. Final checks include
saved publication/sequences, no pending mutations and a foreign-key first-violation
query using `SELECT * FROM pragma_foreign_key_check LIMIT 1`. Completion and exact
completed replay are read-only after the final atomic marker update.

## Bounds and proof limits

Both input page types are capped at 64 KiB before cloning/hashing; protected and
compact pages have at most 16 rows. The metadata scan returns at most 17 rows and
one reference per supplied row; text audit pages hydrate at most 8 objects. Each
protected row statement has at most 14 bound values. Scalar count queries return
fixed-size results, but the database may inspect table/index pages internally.
There is no whole-table protected readback response or caller-supplied SQL.

A page hash alone does not prove membership in the sealed file. A validly hashed
wrong page may poison an incomplete unserved target; the full chain prevents it
from becoming complete. Receipts must never be erased to repair such a target.

All other D1 and R2 writers must remain stopped for this multi-step proof. The
helper does not provide a transactional snapshot across calls or detect arbitrary
same-count tampering to a page after it was verified. Completed replay verifies
the supplied page, rather than rescanning the whole corpus. The helper never
writes corpus metadata, text references, R2, Vectorize or usage Durable Objects.

## Local validation and remaining release gates

`test/protected-state-d1.test.ts` builds a test-only inline Worker, disables
outbound networking, restores synthetic compact data through the existing restore
Worker and exercises the binding helper through actual local D1/R2. Its 29 cases
cover all eight protected tables against the SQLite oracle, exact highwaters
(next IDs 121/1001), zero/absent sequence facts, fresh R2 failures, schema rejection,
late SQL rollback, CAS races, replay corruption, wrong-chain refusal, final
reference drift and completed read-only behavior. Existing 35 protected copier
tests and 17 shared-format tests preserve original format 1 canonical bytes.

Production still requires a consistent authenticated D1/KV backup under a common
writer/auth freeze, verified private acquisition receipts, a separately reviewed
exact-target authenticated transport and operator retry/intent policy, production
binding/resource review, and the `AUTH_DB` rollback/usage-namespace gate. None is
implemented or approved by this local helper. Existing frozen recovery, backup
and completion operators remain unchanged.
