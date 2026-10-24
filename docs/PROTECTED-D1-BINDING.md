# Local protected-state D1 binding

The fixed-table binding helper and its staging-only HTTP adapter are implemented
and tested against synthetic local workerd D1/R2. The checked-in restore config
remains disabled with no bindings. Both initial and full-phase clients below are
locally verified. There is no acquisition code or production target configuration. `checkedTarget` remains staging-only. Local
transport tests do not authorize or establish an actual hosted restore.

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
getProtectedD1Status(db, identity)
checkProtectedD1CorpusPage(db, compactPage, identity)
checkProtectedD1Text(db, textBucket, identity, expectedSessionVersion)
applyProtectedD1Page(db, protectedPage, identity)
verifyProtectedD1Page(db, protectedPage, identity)
finishProtectedD1(db, identity)
```

The identity is `{admissionSha256, manifestSha256, target}`. Table names, column
names, migrations and SQL statements are fixed in code. The only optional auth
DDL is byte-identical to migration 0005, enforced by a test. Responses contain
phase, session version, page ordinals, counts and chain hashes. They omit cursor
keys, raw IDs, publication rows and auth values; raw D1 failures become a fixed
error code. Status reads the matching session/preimage without advancing it.

## Staging HTTP adapter

`services/restore/protected.ts` extends the existing restore Worker. Every route
first uses its existing `RESTORE_TOKEN` timing-safe bearer check, exact resource
headers, `checkedTarget` and checked compact-plan session. That compact session
must be complete. Production D1/bucket identities and non-staging origins remain
refused. Protected operations also require `RESTORE_PROTECTED_ENABLED=staging-only`
and both server pins, `RESTORE_PROTECTED_MANIFEST_SHA256` and
`RESTORE_PROTECTED_ADMISSION_SHA256`. Missing pins keep the routes disabled.
`x-protected-manifest` and `x-protected-admission` must match those pins on every
request, in addition to the existing `x-restore-*` headers. Begin binds the supplied
admission to the same checked compact plan. No body can override the target.

The fixed routes below are under `/v1/restore/protected/`; no SQL, table selector,
arbitrary migration, credential or resource-creation interface is accepted.

| Method/path | Exact JSON body |
| --- | --- |
| `GET status` | No body |
| `POST begin` | `{manifest, admission}` |
| `POST corpus` | `{page}` (initial and final compact scans) |
| `POST text` | `{expectedSessionVersion}` |
| `POST page` | `{page}` (protected load or exact replay) |
| `POST verify` | `{page}` (protected verification or exact replay) |
| `POST finish` | `{}` |

Unknown top-level fields, query parameters and methods are refused. JSON bodies
require UTF-8 `application/json`, with a five-second total body-read deadline.
Begin is capped at 16 KiB; corpus/page/verify requests at 64 KiB plus a 1 KiB
envelope, with the helper still enforcing the page's own 64 KiB bound; text/finish
at 1 KiB. These are input bounds, not an end-to-end D1/R2 wall deadline. No detached
binding work or generic automatic retry is introduced.

After an uncertain acknowledgement, stop and read status for the same pinned
session. Compare its version, phase, page ordinals and chain hashes to the exact
submitted input and previously observed status; do not erase receipts, switch plans
or blindly advance. Protected page replay remains read-only and compares every
actual value. Compact checks advance once and require status reconciliation rather
than blind same-page replay. Text requires the exact previously observed version
inside the domain helper before any R2 read; its existing in-batch CAS also rejects
a version change during those reads. A committed text request's stale replay is
refused without further R2 reads. Completed begin/finish and exact protected page
replays stay read-only. Fixed failure responses never promise an automatic retry.

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

## Initial-admission client

`scripts/protected-state-d1.ts` defaults to local inspection. It seals the original
protected manifest/pages, compact bundle, sidecar file and logical hashes, exact
target and page prefixes before any credential callback or network request.
`--execute-window` additionally requires a private `--journal` directory and lazily
selects `RESTORE_TOKEN`. Inspection does not create a journal or select a token.

One explicit window performs status, begin when needed, then compact corpus
admission pages. Its default initial mode stops at `checking-text`. Adding
`--full-phases` selects the separately sealed `full-copy-v1` plan and journal.
Full mode continues through eight-row text audits, protected-page loading and
verification, a second complete compact scan, and finalization. It derives exact
row/byte/page/chain/version prefixes from the sealed input before credentials.
Initial and full journals cannot be substituted or promoted into one another.
Each window permits at most 64 attempts and 300 seconds, including input sealing.
Requests have a 15-second total deadline, 16 KiB response cap and one in flight.
Those limits can be reduced, never raised, by CLI options.

Private exclusive intent and terminal files are fsynced and linked by hashes.
A subsequent window requires the complete accepted receipt prefix and an exact
fresh status. A lost POST reply can be reconciled only by its exact expected
committed progress. An unchanged or ambiguous status cannot fence a late POST:
that journal remains unresolved and refuses automatic resumption. Pending response
cancellation also prevents a reconciliation request. There is no automatic write
retry or journal reset.

Local filesystem calls cannot be preempted. Checks after those calls reject an
observed deadline overrun while preserving durable acknowledgements and progress.
The CLI itself does not own its process or startup environment. Use the reviewed
operator below for those controls. These tests establish protocol behavior
against synthetic local D1/R2, not a hosted copy.

## Single-window process operator

`scripts/build-protected-state-d1-owned.mjs --inputs /ABS/private/inputs.json
--bun /ABS/physical/bun` prepares a fixed CLI bundle and an unapproved review
template. Preparation can also resolve Bun from PATH. It seals the actual Bun
1.3.5 path, bytes and hash; execution uses that reviewed runtime directly.
The template binds the source, target, journal, credential-file metadata, bundle
and limits. A trusted review must approve exactly one window and set a finite
expiry. Then run:

```sh
env -i PATH=/usr/bin:/bin python3 -I -B \
  scripts/protected-state-d1-owned.py --execute-reviewed-window \
  --review /ABS/journal.owned/window-000001.reviewed.json
```

The operator checks startup-file absence by metadata and supplies a fixed child
environment. A five-second runtime proof and source-only inspection precede the
durable execution intent and credential selection. Inspection is bounded to 300
seconds and execution to 330 seconds, each with at most ten seconds of cleanup;
all child logs together are capped at 2 MiB. The CLI's smaller request/window
limits still apply. Local filesystem calls remain nonpreemptible; observed
expiry or persistence uncertainty prevents acceptance.

Owner receipts live under the journal-derived `.owned` directory. Pending or
uncertain attempts block a later window, including an acceptance file written
before its fsync failed. Preserve its permanent uncertainty fence and all
original receipts. No window starts another window automatically. The operator
has 21 Python regression checks and four actual bundled Bun/workerd fixtures;
this is local evidence, with hosted application still pending. See the
[operator validation](evidence/2026-10-23/protected-state-owned-root-validation.json).

## Local validation and remaining release gates

`test/protected-state-d1.test.ts` builds a test-only inline Worker, disables
outbound networking, restores synthetic compact data through the existing restore
Worker and exercises the binding helper through actual local D1/R2. Its original 29 cases
cover all eight protected tables against the SQLite oracle, exact highwaters
(next IDs 121/1001), zero/absent sequence facts, fresh R2 failures, schema rejection,
late SQL rollback, CAS races, replay corruption, wrong-chain refusal, final
reference drift and completed read-only behavior. Additional HTTP cases exercise
the real restore handler, disabled/missing pins, authentication/resource identities,
known production refusal, all durable phases, bounded/invalid input, discarded text
acknowledgement with status reconciliation, stale text refusal before R2 reads and
exact page replay. A text-specific late version fault after R2 reads proves its
audit checkpoint does not commit. Parser tests cover a declared oversize, stalled stream cancellation and
fulfilled chunks that delay timer delivery. Target identities use canonical
field order. Schema checks compare SQL token sequences, rejecting split type
names that alter SQLite affinity while allowing harmless spacing/comments. Existing 35 protected copier tests and 17 shared-format tests
preserve original format 1 canonical bytes. The initial-admission client brings
the focused total to 132 checks (80 D1/client, 35 copier and 17 format), including
interruption, pending cancellation, lost replies, deadline overruns, journal
corruption and pre-read input bounds. See the
[client validation](evidence/2026-10-23/protected-state-client-root-validation.json).

The full-phase client brings the focused suite to **171 tests** (119 D1/client,
35 copier and 17 format). Independent review passes all **39 new full-flow
cases**, including lost text/load/verify/final acknowledgements, final compact
reset, sequence facts, exact byte prefixes and durable-ack deadline overruns.
All three relevant compiler projects pass. See the
[full-client validation](evidence/2026-10-23/protected-state-full-client-root-validation.json).

Production still requires a consistent authenticated D1/KV backup under a common
writer/auth freeze, verified private acquisition receipts, actual hosted staging
copy evidence, production-specific exact-target transport/resource review, and the
`AUTH_DB` rollback/usage-namespace gate. None is
closed or approved by these local tests. Existing frozen recovery, backup
and completion operators remain unchanged.

## Synthetic fixture preparation

`scripts/prepare-protected-state-d1-fixture.ts` prepares a private 18-row fixture
using the existing cutover, protected-state, admission and full-client tooling.
It checks target and credential metadata before reading either payload and never
reads credential contents. It refuses target/credential aliases and the populated
original staging resources. Its config and owner inputs are explicitly unapproved.

```sh
bun --no-env-file scripts/prepare-protected-state-d1-fixture.ts \
  --output /absolute/private/new-fixture \
  --target /absolute/private/returned-target.json \
  --credential-file /absolute/private/restore-token.json
node scripts/build-protected-state-d1-owned.mjs \
  --inputs /absolute/private/new-fixture/owned-inputs.json \
  --bun /absolute/physical/bun
```

The 12 focused checks include an actual local workerd full copy in 26 requests
(25 POSTs and one status GET). All eight tables, Unicode, active/revoked keys and
sequence highwaters 120/1000 survive, above surviving IDs 2/10. These checks also
pass within the 1,276-test release gate. See the
[fixture validation](evidence/2026-10-23/protected-fixture-preparation-root-validation.json).
New isolated hosted resources, independent emptiness checks and separately
reviewed deployment/window execution remain necessary. This fixture establishes
no production backup, common freeze or production identity migration.

## Offline original-sequence evidence bridge

`scripts/lib/protected-sql-import.mjs` provides the explicit library function
`importProtectedSqlWithOriginalSequenceEvidence(source, destination, {path, sha256})`.
The original two-argument importer and its CLI remain strict: an ordinary SQL
dump without both literal sequence facts is still refused. No CLI flag or
format-1 protected manifest change is added.

The bridge accepts unchanged private SQL plus seven separate, hash-pinned JSON
files, each at most 16 KiB: the evidence envelope, common-freeze and export
attestations, before/after observations and their original raw D1 responses.
They must use the fixed production account/database identity and exact two-name
query, agree on provenance and freeze, and establish complete equal before/after
facts. Each sequence is explicitly present with its original nonnegative safe
integer or absent. Missing, failed or partial queries do not establish absence.
Inputs must be canonical owner-only files outside the repository; aliases,
hardlinks and existing output paths are refused.

Materialization reuses the streaming parser, SQLite authorizer and transaction.
It hashes the SQL bytes actually consumed before COMMIT, rejects contradictory
literal facts and unrecognized writes to `sqlite_sequence`, and restores only
the two original observed sequence facts. An absent fact with surviving history
is refused. `MAX(id)` is used only to reject an invalid supplied highwater; it
does not reconstruct one. Integrity and FK checks run before COMMIT. Pre-commit
refusals roll back imported DDL and data. A post-commit close/hash failure refuses
acceptance and retains the private file.

The result supplies the derived SQLite, original SQL and evidence digests for
the existing `sourceKind: 'sqlite'` copier input. It always reports
`providerAuthenticated: false`, `globalQuiescenceEstablished: false` and
`productionAcquisitionQualified: false`. These private attestations establish
local consistency only. The caller must provide a bounded owned process; this
library adds no deadline or remote acquisition behavior.

The [production acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md)
records the actual deployed binding differences, missing maintenance procedure,
source-schema admission gap and remaining acquisition/hosted-copy gates.
All **94 focused copier/bridge/format tests**, including the optional actual local
workerd check, pass in the corrected root run. Tooling TypeScript and independent
peer review also pass. The first root run omitted Bun from its clean PATH; its
two CLI-spawn failures remain preserved separately. See the
[bridge validation](evidence/2026-10-23/protected-original-sequence-bridge-root-validation.json).
