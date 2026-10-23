# Snapshot and ingestion operations

The snapshot Worker has one R2 binding and one Workflow binding. It has no
Vectorize binding. It never rebuilds, clears or replaces the serving index.
The daily trigger creates one instance per parser version and corpus SHA.
It stages the pinned archive once, parses bounded file groups, sorts four index
partitions, verifies artifacts, and conditionally publishes the manifest last.
All step results are small artifact references; XML and rows remain in R2.

New artifacts live under `snapshots/statutes-v2/`. The manifest records the
parser identity. Legacy root objects remain readable with an explicit legacy
`SnapshotReader` and retain their original vector ordering. Parser changes must
increment `SNAPSHOT_PARSER_VERSION` before producing different row semantics for
an already-published corpus revision. Never overwrite old snapshot or vector
objects to make a digest check pass.

The pipeline records both corpus SHA and parser version. A parser mismatch
requires the matching versioned snapshot; the incremental-file fallback is
refused across parser versions. The existing index remains in place and only
provisions whose fingerprints changed are embedded and upserted.

## Checks before deployment

Run `bun run typecheck:snapshot`, `bun run build:snapshot` and the focused
snapshot/recovery tests. These commands do not deploy. Generate binding types
with `wrangler types services/snapshot/env.d.ts --config services/snapshot/wrangler.jsonc --include-runtime false --env-interface SnapshotEnv`.
Snapshot types use their own TypeScript project to keep generated global
Cloudflare bindings separate from the API and encoder projects.

Reproduce full XML, serialized-row and byte-offset parity from a clean local
corpus clone:

```sh
bun scripts/validate-snapshot-workflow.ts --corpus /path/to/laws-lois-xml --out dist/snapshot-validation
```

The verifier writes exact parser source hashes and a compact result JSON. It
checks every row against a separate direct XML pass, including language and
revision-date fields, and every UTF-8 offset and length. Use a fresh output
directory after changes to physical artifact layout; immutable conflicts are
intentional failures.

Local workerd checks require permission to bind localhost ports:

```sh
node scripts/check-r2-immutability.ts
node scripts/probe-snapshot-worker-memory.ts --file /path/to/laws-lois-xml/fra/lois/I-3.3.xml --path fra/lois/I-3.3.xml --out dist/snapshot-memory.json
```

The memory probe records sampled DevTools heap and backing storage. Worker
`node:v8` and `process.memoryUsage()` return zero values and cannot establish
memory safety. Local samples do not establish a hosted peak or CPU limit;
validate the full Workflow on a separate staging R2 bucket before production.

## Publication and recovery

Deployment and live schema changes require the release approval. The pipeline
needs additive D1 migrations 0006, 0007 and 0008 plus its
`PipelineCoordinator` Durable Object migration. Snapshot publication needs the
configured private R2 bucket and the Workflow binding. Do not apply historical
migration 0004 to the large live table as a shortcut for the text migration.
The writer supports both the existing and clean-migration schema.

After approval, an operator can trigger the pinned revision using the current
Wrangler syntax (replace the example SHA/date with verified source values):

```sh
wrangler workflows trigger civicsignal-snapshot '{"revision":{"commit":"<40-character-sha>","date":"YYYY-MM-DD"}}' --id statutes-v2-<sha> --config services/snapshot/wrangler.jsonc
```

Inspect instance status and retry the existing failed instance rather than
starting competing builders. Conditional creates permit byte-identical replay
and reject different bytes. Missing, corrupt, duplicate or misaligned parts
prevent publication. Staging cleanup deletes only this parser/revision's staging
prefix after successful publication. A failed job can leave staging objects;
retain them for diagnosis or remove only that exact staging prefix after its
instance has stopped.

Cron and manual ingestion requests go through one durable coordinator per
corpus. It joins overlapping requests without an expiring lease. A pending
checkpoint and watchdog alarm survive restarts, retry failed work with bounded
backoff, and continue catch-up slices until complete. Inspect Worker errors and
Durable Object status when progress stops; do not bypass the coordinator.

### Suspend the corpus writer before backup

The admission-control API below requires the reviewed coordinator version to
be deployed. Preparing this contract locally does not change an existing
deployment. Verify a 100% deployment of the reviewed Worker version and the original coordinator namespace
before using it; a new namespace cannot attest the original writer's state.

All three control routes require the existing `x-pipeline-secret` header.
Keep that secret in the operator's environment and out of command arguments
and evidence. `GET /control` retains the budget fields and adds `corpusId`,
`coordinatorId`, and `coordinator`. The latter reports `revision`, `suspended`,
`active`, `queued`, `alarmHandlersActive`, `alarmAt`, `pending`, `failures`,
and `quiescent`. `lastFailure` is null when `failures=0`; otherwise it contains
only an allowlisted `classification` and, for recognized encoder HTTP failures,
`encoderHttpStatus`. Categories are `encoder-http`, `encoder-deadline`,
`attempt-budget-exhausted`, `source-snapshot-mismatch`, `storage`, and `unknown`.
Only the encoder's known JSON failure wrapper with `DEADLINE_EXCEEDED` supports
the deadline category; a 504 or unrelated timeout alone does not. Unrecognized
or truncated bodies cannot establish that cause. Reading this diagnostic does
not clear failures or change recovery. Exception text, addresses, response
bodies, headers, SQL and credentials are never returned.
Starting a retry retains the previous failure diagnostic; a successful cycle
clears it with the failure count. The classification is evidence from the last
recognized failure signature, not a conclusion about an unobserved incident.
The legacy checkpoint is validated before use: `pending` must be boolean,
`failures` a non-negative safe integer, and optional `lastError` a string of at
most 500 characters. Malformed persisted state fails closed with a fixed error;
it is neither returned nor repaired or overwritten. A failure count already at
the safe-integer maximum stays there on another failure.

| Operation | Request | Result |
| --- | --- | --- |
| Observe | `GET /control` | Current budget and coordinator observations. |
| Suspend | `POST /control/suspend`, JSON `{"expectedRevision":0}` using the observed revision | Persists suspension and removes the alarm. HTTP 200 means quiescent; 202 means admitted work is still draining. |
| Resume | `POST /control/resume`, JSON containing the current suspended revision | Requires a drained coordinator. Arms pending recovery while still suspended, then opens the next admission revision. |

Control bodies are limited to 1 KiB and accept only `expectedRevision`, a
non-negative safe integer. Stale revisions or a busy resume return 409.
Invalid bodies return 400, oversized bodies 413, and missing/wrong secrets 403.
After an uncertain acknowledgement, read status; never reset the coordinator,
budget, pending checkpoint, or outbox. Repeating suspend with the current paused
revision repairs a failed alarm deletion without changing that revision.
Resume keeps alarm and admission writes inside the same short control lock;
external I/O never holds it. If either write fails or loses its acknowledgement,
read status before acting. A still-suspended revision may have an uncertain
recovery alarm: repeat suspend with that exact revision to remove it, wait for
quiescence, then retry resume. If status is already open at the next revision,
the resume committed; do not replay or overwrite it using the older revision.
A delivered alarm waits for the control lock and checks the persisted gate.
This ordering does not assume a transaction across alarm and key-value writes.

Suspension closes new manual and scheduled cycle admission. It does not cancel
an accepted encoder request: an already admitted cycle drains normally and may
make further requests before finishing. Its spent attempts remain charged.
Pending work and failures survive suspension and reconstruction, while alarm
callbacks delivered during suspension cannot start a cycle or rearm recovery.
Removing Cron triggers alone does not stop these callbacks.
An alarm observation is a point-in-time value; a later delivered callback is
safe because admission remains durably closed, not because delivery was cancelled.

Wait for the same suspended revision to report `quiescent=true`, `active=null`,
`queued=0`, `alarmHandlersActive=0`, and `alarmAt=null`. Then independently
verify the completed publication identity and empty D1 mutation outbox. A
quiescent coordinator may still have pending recovery; quiescence alone is not
a completed-revision or backup-parity claim. Preserve incomplete state and
resume normal recovery when required; do not clear it to pass the backup gate.
Keep other CLI, migration, and protected-identity writers stopped separately.

Normal `POST /vectors` exports keep their existing JSON and receipt formats
while admission is open. During suspension, backup exports require the header
`X-Pipeline-Suspension-Revision` with the current revision and a drained queue.
The admitted export echoes that header. It still verifies the matching
publication, fingerprints and empty vector outbox and uses the original
serialized queue. Missing/stale revision or a busy coordinator returns 409.
An export response attests admission for that operation, not an entire backup.
Verify the same suspended revision and corpus identity again after every
backup component is complete; reject the consistency claim if admission
changed. Resume only after the backup has passed its own verification.

D1 commits each bounded group of rows, change events, optional text references
and Vectorize outbox entries together. Recovery replays idempotent vector
operations before reconciliation reads fingerprints. PostgreSQL includes row,
vector, event and idempotency identity in one transaction. Final run logging and
revision publication are atomic in each store. Run counts describe each
invocation; the change feed and row mutation identities preserve changes across
failed attempts and different batch boundaries.

Text uploads are verified before the D1 transaction. The pipeline initially
retains D1 text while writing immutable R2 text and matching references. Failed
SQL commits can leave an unreferenced R2 object; they cannot switch an existing
row to unmatched text. Removing D1 text is a separate approved cutover after
complete reference/object parity and a verified backup. Keep the D1 fallback and
all immutable snapshot/vector artifacts available for rollback.

For rollback, first stop new scheduled/manual writes, preserve pending outbox
and coordinator state, and restore the serving text mode to its verified D1
fallback while that fallback remains populated. Do not remove a deployed Durable
Object class or namespace, clear mutation identities, delete old snapshots, or
rebuild Vectorize. A corpus rollback must restore matching row fingerprints,
text references and vectors from one verified revision/parser identity; never
combine positional vector bytes with an index whose digest differs.

## Ordered release commands and stop points

These are an operator runbook, not a record of deployed resources. No staging
resources, live schema migrations or production deployments were performed by
this work. Production configs currently name the serving D1, R2 and Vectorize
resources. There is no configured `--env staging`; that flag must not be used as
an isolation mechanism.

1. Finish local gates and retain the evidence before approval:

   ```sh
   bun run typecheck
   bunx vitest run test/corpus-recovery.test.ts test/postgres-corpus-recovery.test.ts test/pipeline-coordinator.test.ts test/snapshot-workflow.test.ts test/snapshot-format.test.ts test/snapshot-source.test.ts test/vector-export.test.ts test/vector-export-state.test.ts test/vector-restore-cli.test.ts
   bun run build:pipeline
   bun run build:snapshot
   bun scripts/publish-snapshot.ts --commit 0507465393c224c0491fc8c17c88340217acc656 --dir dist/workflow-validation-v2-bounded
   bun scripts/export-vectors.ts --revision 0507465393c224c0491fc8c17c88340217acc656 --dir dist/workflow-validation-v2-bounded --dry-run
   ```

   `publish-snapshot.ts` is now a local integrity verifier. It performs no
   remote operation. Its old unconditional upload/replacement behavior is
   retired; snapshots publish through the Workflow and vector manifests through
   the authenticated export endpoint. The dry-run export validates all ordered
   index entries without loading a credential or making a request.

2. Record and approve the isolated staging inventory and standalone configs.
   Suggested resource names are `civicsignal-v1-stage-<role>-20261022`, with roles
   `snapshot`, `pipeline`, `api`, `encoder`, `corpus`, `d1`, `statutes` and `cache`.
   Record actual returned resource IDs; names alone are not isolation evidence.
   Put reviewed standalone configs at
   `dist/release/staging/snapshot.json` and
   `dist/release/staging/pipeline.json`. Resolve `main` to the repository source;
   retain the production compatibility flags and limits. Snapshot must bind
   only the staging R2 bucket and staging Workflow. Pipeline must bind only the
   staging D1, separate Vectorize index, staging encoder and staging R2, and
   use its own `PipelineCoordinator` namespace/migration. Disable all staging
   crons initially. Use distinct secrets and explicit staging service URLs.
   Review every binding before executing these deployment commands:

   ```sh
   bunx wrangler deploy --config dist/release/staging/snapshot.json
   bunx wrangler deploy --config dist/release/staging/pipeline.json
   ```

   The following is the alternative full-schema path for a fresh empty staging
   D1. Do not combine it blindly with the compact-schema/page restore: that path
   needs its own reviewed supporting state/auth/history/outbox/parser schema and
   import plan. Applying all migrations is suitable only to the empty full-schema
   target:

   ```sh
   bunx wrangler d1 migrations list civicsignal-v1-stage-d1-20261022 --remote --config dist/release/staging/pipeline.json
   bunx wrangler d1 migrations apply civicsignal-v1-stage-d1-20261022 --remote --config dist/release/staging/pipeline.json
   ```

   A live legacy D1 must not run an indiscriminate `migrations apply`: pending
   historical 0004 rebuilds its large table. For an approved additive rollout,
   prepare a reviewed release-only `migrations_dir` containing 0005–0008 and
   retain Wrangler's migration bookkeeping. List exactly that directory against
   the target before applying it. Production D1 capacity and the fresh compact
   database restore/cutover have separate backup/parity gates; never use 0004
   as that migration.

3. Run the complete pinned Workflow in the isolated bucket, then inspect every
   step and artifact. The known local parity revision is the full SHA below;
   verify its source commit date before triggering:

   ```sh
   bunx wrangler workflows trigger civicsignal-v1-stage-snapshot-20261022 '{"revision":{"commit":"0507465393c224c0491fc8c17c88340217acc656","date":"2026-10-15"}}' --id statutes-v2-0507465393c224c0491fc8c17c88340217acc656 --config dist/release/staging/snapshot.json
   bunx wrangler workflows instances describe civicsignal-v1-stage-snapshot-20261022 statutes-v2-0507465393c224c0491fc8c17c88340217acc656 --config dist/release/staging/snapshot.json
   ```

   If a transient failure occurs, first inspect the failed step, then restart
   that same instance after correcting the cause:

   ```sh
   bunx wrangler workflows instances restart civicsignal-v1-stage-snapshot-20261022 statutes-v2-0507465393c224c0491fc8c17c88340217acc656 --config dist/release/staging/snapshot.json
   ```

   The staging acceptance artifact must record full downloaded index SHA-256
   and ordered ID/fingerprint digest, all row-part hashes/counts, all source-row
   parity, hosted CPU/error observations, retry behavior and final instance
   status. Do not substitute the local build's wall time or sampled heap for a
   successful hosted run.

4. Close the **legacy vector backup gate before any parser reconciliation**.
   Historical handoff evidence of 329 sampled exact vectors is not a fresh
   backup verification. No complete legacy artifact set is currently present
   at `dist/snapshot`. Use read-only `wrangler r2 object get ... --remote --file
   ...` to download the legacy root `<sha>.manifest.json`, `<sha>.index.jsonl`
   and `<sha>.vectors.manifest.json`, plus all row parts needed to verify
   placeholders. Record the legacy revision and preserve its original bytes.
   With that root layout in `dist/snapshot`, these commands verify the whole
   ordered index before accessing vector objects and compare fresh samples to
   the serving index:

   ```sh
   bun scripts/build-vector-store.ts --revision 0507465393c224c0491fc8c17c88340217acc656 --parser legacy --dir dist/snapshot
   bun scripts/check-stored-vectors.ts --revision 0507465393c224c0491fc8c17c88340217acc656 --parser legacy --dir dist/snapshot --sample 329
   ```

   Assembly downloads all vector parts, checks sizes and any recorded hashes,
   and only renames the local output after success. Legacy manifests may lack
   per-part SHA-256; record new download hashes as evidence instead of claiming
   a historical digest that does not exist. Sample equality demonstrates the
   sampled positions; it does not prove every vector equals today's index.
   The check now exits unsuccessfully for missing substantive vectors or any
   mismatch. It does not write Vectorize or R2.

5. Restore/copy that verified baseline to the separate staging vector index and
   metadata D1, with exact index/fingerprint identity. A reviewed baseline
   vector restore writer remains a prerequisite before enabling staging
   ingestion. Configure these three variables together in the standalone
   staging pipeline config; there are no request-body overrides:

   ```json
   {
     "PIPELINE_PINNED_COMMIT": "0507465393c224c0491fc8c17c88340217acc656",
     "PIPELINE_PINNED_DATE": "2026-10-15",
     "PIPELINE_EMBEDDING_ATTEMPT_CAP": "1112"
   }
   ```

   Keep staging cron disabled. The coordinator persists the exact
   commit/date/parser/cap tuple and one cumulative submitted-document count.
   Changed, removed or increased controls fail on that coordinator; deployment,
   process restart, alarm retries and repeated `/run` calls do not reset it.
   Before each actual encoder HTTP request, the send boundary rechecks upstream
   head and the matching versioned snapshot, then durably reserves the complete
   request's `texts.length` before invoking the service binding. Failed and
   uncertain calls retain the charge, and retries spend additional allowance.
   If the next complete chunk exceeds the remainder it is refused before HTTP;
   a 1,112-attempt limit is not a guarantee of 1,112 successful embeddings after
   failures. Exhaustion requires operator review, not an automatic budget reset.

   Set the explicit staging `PIPELINE_URL` and `PIPELINE_SECRET` in the operator
   environment. Inspect the initial persisted policy without placing its secret
   in a command argument:

   ```sh
   bun -e 'if (!process.env.PIPELINE_URL || !process.env.PIPELINE_SECRET) throw new Error("explicit staging environment required"); const r = await fetch(new URL("/control", process.env.PIPELINE_URL), { headers: { "x-pipeline-secret": process.env.PIPELINE_SECRET } }); if (!r.ok) throw new Error(`control status HTTP ${r.status}`); console.log(await r.text());'
   ```

   Require the exact pin/current parser, `cap:1112`, `submitted:0` and
   `remaining:1112` before the first controlled invocation. Verify the live
   upstream head still equals the pin; mismatch fails closed. After the
   isolated baseline restore/parity gate, invoke the controlled cycle:

   ```sh
   bun -e 'if (!process.env.PIPELINE_URL || !process.env.PIPELINE_SECRET) throw new Error("explicit staging environment required"); const r = await fetch(new URL("/run", process.env.PIPELINE_URL), { method: "POST", headers: { "x-pipeline-secret": process.env.PIPELINE_SECRET } }); const body = await r.text(); console.log(body); if (!r.ok) process.exitCode = 1;'
   ```

   Repeat the authenticated `/control` read to record actual document attempts
   and remaining allowance after every slice, error and restart probe. No
   controlled invocation can fall back to unversioned snapshots or changed-file
   ingestion. The known v2 delta is 1,112 changed fingerprints, zero
   added/removed IDs. Preserve the baseline index and upsert only the verified
   changes; never recreate the serving Vectorize index. Production retains its
   existing unbounded head-following policy only when all three controls are
   absent and that coordinator has no persisted controlled budget.

6. After the approved bounded reconciliation completes, create the new-parser
   vector backup against the explicit staging URL. Supply `PIPELINE_SECRET`
   through the operator's existing environment, never in a command argument or
   log. Replace the example URL with the reviewed staging URL:

   ```sh
   bun scripts/export-vectors.ts --revision 0507465393c224c0491fc8c17c88340217acc656 --dir dist/workflow-validation-v2-bounded --url https://STAGING-PIPELINE-HOST
   ```

   The server reads its published index; clients cannot supply IDs or choose
   arbitrary part sizes. Each request requires matching completed D1 revision,
   parser, row count, selected fingerprints and an empty outbox. It shares the
   coordinator's exclusive queue with ingestion. Every vector mutated at this
   revision must expose matching indexed `metadata.fingerprint`; an upsert
   acknowledgement alone does not prove Vectorize visibility. Untouched legacy
   vectors may omit that metadata. Parts contain finite 768-dimensional
   float32 values in published index order; absent vectors are allowed only
   for verified placeholder rows. Conditional creates and actual stream
   readback hashes protect parts, receipts and the final manifest. Repeating
   the command resumes through byte-identical artifacts; changed bytes fail.
   The driver publishes the manifest itself after server verification and
   saves a local copy; no separate mutable upload step is needed.

7. Repeat the approved same gates in production only after staging acceptance,
   fresh rollback artifacts and reviewed bindings. Production snapshot commands
   use `services/snapshot/wrangler.jsonc` and Workflow `civicsignal-snapshot`.
   Production pipeline config is `services/pipeline/wrangler.jsonc`. Deploying
   the pipeline adds the SQLite Durable Object class once with migration tag
   `v1-pipeline-coordinator`; preserve that tag/class/namespace on later
   releases and rollback. Stop old cron/manual writers and let old executions
   finish before starting the coordinated release. Do not attempt to enforce
   exclusivity by a timed lease or run a long cycle inside
   `blockConcurrencyWhile`.

   Initial writer configuration is `CORPUS_RETAIN_D1_TEXT="true"`; the API
   initially serves `CORPUS_TEXT_MODE="d1"`. Only after the separately approved
   fresh compact-D1 binding and full R2 reference/object/rollback proof should
   the pipeline change to `CORPUS_RETAIN_D1_TEXT="false"` and the API to strict
   `CORPUS_TEXT_MODE="r2"`. The writer rejects misspelled values and refuses
   blank-text writes without its R2 binding. Reverting serving mode to D1 is
   valid only while a complete populated D1 fallback still exists; retain the
   original database for rollback after the compact cutover.

## Bounds and remaining acceptance evidence

The Workflow stages at most 128 small files or an 8 MiB group target; large
instruments use a raw single-file stage and fail above 16 MiB. Row parts target
2 MiB with whole-row boundaries; a single oversized row can be larger, up to the
16 MiB row ceiling. Four independent sorted index partitions each have a 16 MiB
ceiling and the final index a 32 MiB ceiling. The verified corpus used 118 groups,
277,857 rows and a 26,147,151-byte index. Step results hold artifact references,
not XML or serialized rows. The configured paid Worker limits are 300,000 ms
CPU and 100,000 subrequests for the Workflow, and 300,000 ms/10,000 subrequests
for the pipeline. These settings do not enlarge the 128 MiB memory limit. See
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[the configurable subrequest limit](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).

Ingestion writes at most 2,000 changed/removal units per slice in bounded D1
batches of 16. Each vector-export part has at most 10,000 positions (30,720,000
binary bytes), and binding responses hold at most 20 vectors at once. Part
readback and manifest finalization hash streams instead of holding a second
part. Finalization validates every receipt's ordered fingerprint identity and
current D1 fingerprint before publishing. Restarts can lose an in-flight export
request but cannot replace an artifact; repeat the driver. Pipeline writes have
a durable pending checkpoint/alarm and durable D1 outbox replay.

Remaining live acceptance gates are the full hosted staging Workflow and its
memory/CPU observations, fresh legacy backup verification, isolated baseline
restore, hosted verification of the implemented revision/embedding controls, approved additive migrations/DO
creation, and the separately approved compact-text cutover. Local dry runs,
full XML parity, fault-injection tests and conditional-R2 workerd evidence do not
close those live gates.

The shared 160-request stage API/MCP serving allowance is enforced by the local
loopback relay and durable attempt ledger in
[STAGING-REQUEST-BUDGET.md](../../docs/STAGING-REQUEST-BUDGET.md). Use that one
relay for manual smokes, discovery, eval, benchmark warmups and retries; retain
its actual-target ledger and report latency as including relay/fsync overhead.
