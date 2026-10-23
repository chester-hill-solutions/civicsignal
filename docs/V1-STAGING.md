# CivicSignal v1 isolated hosted validation plan

The user approved full bounded staging on 2026-10-22, Toronto time.
Execution is in progress. The [setup receipt](evidence/2026-10-22/stage-setup.json) records observed identities, versions and current limits.
Hosted acceptance remains incomplete until each phase has its required evidence.
The production release decision remains [V1-RELEASE.md](V1-RELEASE.md).

The goal is to close hosted snapshot, restore, ingestion, inference and retrieval
checks with an isolated candidate. Use the detailed snapshot commands and stop
points in [snapshot operations](../services/snapshot/OPERATIONS.md#ordered-release-commands-and-stop-points)
and the backup/cutover rules in [V1-OPERATIONS.md](V1-OPERATIONS.md).
Staging acceptance does not switch production bindings or complete the later
protected production auth/history migration.

## Proposed inventory and isolation

Use account `ad5ec479b9a421faa2ed06c3d1c2b23a`, after an operator verifies account
access. These are proposed exact names, not returned resource IDs:

| Role | Proposed name | Required binding and isolation |
| --- | --- | --- |
| Snapshot Worker and Workflow | `civicsignal-v1-stage-snapshot-20261022` | Workflow `SNAPSHOT`; R2 `CORPUS` only; no D1, Vectorize or encoder binding |
| R2 | `civicsignal-v1-stage-corpus-20261022` | Snapshot artifacts and immutable provision text; private bucket |
| Restore Worker | `civicsignal-v1-stage-restore-20261022` | Authenticated stage-only `RESTORE_DB`/`RESTORE_TEXTS`; exact account, D1 and R2 identity checks |
| Fresh compact D1 | `civicsignal-v1-stage-d1-20261022` | API/pipeline `CIVIC_DB`; verified compact corpus restore and separate supporting tables |
| Vectorize | `civicsignal-v1-stage-statutes-20261022` | API/pipeline `VECTORIZE`; 768 dimensions, source-index metric verified before creation |
| API Worker | `civicsignal-v1-stage-api-20261022` | Stage D1/R2/index/cache/encoder; its own `API_KEY_USAGE` namespace |
| Pipeline Worker | `civicsignal-v1-stage-pipeline-20261022` | Stage D1/R2/index/encoder; its own `PIPELINE_COORDINATOR` namespace |
| Encoder Worker/container | `civicsignal-v1-stage-encoder-20261022` | Dedicated service binding and DO/container; pinned artifact; maximum one instance |
| Cache KV | `civicsignal-v1-stage-cache-20261022` | API `CIVIC_CACHE`; no production cache or legacy key KV binding |

Capture each creation response and independently read its descriptor. Enter the
actual D1 UUID and KV ID into configs only after the names/account match this
inventory. Record Workflow identity, index dimensions/metric and R2 identity too.
Do not substitute an invented UUID, a production ID, or an assumed workers.dev
hostname. DO namespaces created by the stage Worker migrations are recorded and
checked after deployment, before calls; their IDs are not known beforehand.
Neither DO binding may reference a production Worker through `script_name`.

Prepare standalone, operator-reviewed configs at
`dist/release/staging/{resources,snapshot,pipeline,api,encoder,restore}.json`.
The offline `prepare-staging-config.ts` generator requires the actual checked
inventory for D1/R2/KV/Vectorize; it creates no resources or secrets. Its source
pins and empty cron lists must remain in the reviewed output.
`resources.json` is a resource-creation bootstrap with the verified account and
stage name, without production bindings. All `main`, migration, Dockerfile and
build-context paths must resolve from the standalone config location. All crons
start disabled. API routes have no production/custom-domain route;
`PUBLIC_API_BASE_URL` is set from its actual returned stage URL. There is no
configured `--env staging`: do not use that flag, `--name` alone, or inherited
production configs as an isolation shortcut.

Keep these resources unchanged throughout staging: API `civicsignal` and
`api.civicsignal.chesterhillsolutions.ca`; D1 `civicsignal`
(`8056b1a0-f858-4f89-a332-91f7f350eb7b`); R2 `civicsignal-corpus`;
Vectorize `civicsignal-statutes-gemma`; existing production usage objects, keys,
encoder configuration, pipeline deployment and Railway services. Any writer in
this plan binds only the separate stage index. Production vector access is
read-only backup verification, never upsert/delete/rebuild.

## Bounds to approve

The source/parser pair under review is
`0507465393c224c0491fc8c17c88340217acc656:statutes-v2`, with source date
`2026-10-15`, subject to a fresh authoritative head/date check. Local evidence
records 277,857 rows and a legacy-to-v2 delta of 1,112 changed fingerprints,
zero added/removed IDs. These are prerequisites to verify again against the
selected baseline, not hosted results.

- One complete non-empty hosted snapshot publication, with bounded Workflow
  steps, into the stage bucket. Retry the same instance after diagnosis; do not
  start competing builders or silently approve repeated full runs.
- **At most 1,112 document embeddings in total** for the parser reconciliation,
  across requests, slices, alarms and retries. This allowance is conditional on
  a verified legacy row/vector baseline being copied and restored first. Copying
  existing vectors is not re-embedding. Stop if the calculated delta is larger,
  the baseline is missing, or the source revision changes. Never bootstrap an
  empty writer by embedding roughly 254,000 provisions.
- **At most 160 serving requests** to the single explicit stage API origin,
  including MCP, discovery, failed attempts and retries. Allocate 20 calibration,
  64 holdout, and 44 benchmark retrievals
  (20 measured plus two warmups at each concurrency level 1 and 4). Their three
  automatic capabilities requests bring the subtotal to 131. Allow 21 manual
  smoke/protocol requests, giving 152 planned requests; the remaining eight are
  a shared retry/diagnostic reserve. Route every serving request through the
  [durable local request-budget relay](STAGING-REQUEST-BUDGET.md); its ledger
  reserves an attempt before each upstream send and refuses attempt 161.
- Manual smokes include one proxied semantic stage API query after the baseline
  restore and before reconciliation, plus discovery and
  invalid/missing/revoked/capability-limited keys,
  English/French exact citations, MCP initialization/discovery/citation calls,
  change-feed paging, warm-cache/language separation and a separate tiny-quota
  workspace. Count MCP notifications and protocol messages in the request budget
  even when they consume no usage units. One optional BYOK chat smoke fits within
  the 21 calls, only with an operator-approved provider/key and `maxTokens:128`;
  otherwise leave that call unused and mark hosted chat verification pending.
- Query embeddings and any configured reranking belong to the serving-request
  budget, separately from the 1,112 document embeddings. No additional embedding
  experiment is included. Use stored-value comparisons for vector backup checks;
  the re-embedding `check-vectors.ts` experiment is outside this allowance.

Request limits are not a monetary quote. Approval must also cover one stage
encoder instance, the full artifact download/copy/storage, Workflow/R2/D1/Vectorize
operations and any chosen reranker/BYOK provider. Retain the measured usage and
storage report. Stage billing uses synthetic free workspaces and no Stripe secret.

## Phase 0 — finish the local, reviewable prerequisites

Retain the final candidate commit, frozen lockfile, validation/build logs and
[evidence](evidence/2026-10-22/). Record the pinned encoder model/revision/SHA-256
from `src/encoder.ts`; hosted inference remains a check to perform, not an inference
result established by the local amd64 smoke.

The following local controls are implemented. They make the proposed hosted work
reviewable; they do not establish a hosted result:

1. `restore-stage-vectors.ts` and its helper verify the pinned receipt, every
   artifact hash, ordered row/index/fingerprint identity and all 277,857 positional
   vectors before any credential or network access. The explicit stage account,
   index prefix, live descriptor, dimensions and metric guards precede writes.
   Restores preserve IDs, float32 values and language/jurisdiction/fingerprint
   metadata, skip only independently verified all-zero placeholders, and check
   readback before journal checkpoints. Twelve fixture tests cover corruption,
   wrong targets, acknowledgement loss, bounded resume and stale journals.
   The complete real local preflight passed; no stage copy has run.
2. The isolated `services/restore/worker.ts` and `restore-text-staging.ts` client
   implement a fresh compact-D1/R2 restore protocol with exact resource identity
   headers, binary text uploads with hash readback, ordered checked pages, source
   publication state and a full strict-text audit. The disabled source config has
   no resource bindings. A full legacy compact bundle has been prepared and
   verified locally using the pinned source receipt; hosted deployment and audit
   remain pending. Review the final focused runtime test evidence before approval.
3. Snapshot configs pin `SNAPSHOT_PINNED_COMMIT` and `SNAPSHOT_PINNED_DATE`.
   Pipeline configs set all three values together:
   `PIPELINE_PINNED_COMMIT=0507465393c224c0491fc8c17c88340217acc656`,
   `PIPELINE_PINNED_DATE=2026-10-15`, and
   `PIPELINE_EMBEDDING_ATTEMPT_CAP=1112`. The coordinator persists this exact
   tuple/parser and reserves the number of documents before every encoder send,
   retaining failed or uncertain attempts. Restarts, alarms and slices cannot
   remove, increase or reset the persisted ceiling. Source head/date and immutable
   snapshot identity are rechecked before submissions. Local budget tests cover
   these paths. The authenticated stage `GET /control` must show the same tuple,
   cap, submitted and remaining counts before its schedule is enabled; do not
   invent `/run` body overrides or substitute an invocation slice limit.
4. Legacy preparation now takes an explicit checked `--receipt` and reads the
   original root layout with publication parser `null`. It preserves the actual
   old fingerprints beside the copied old vectors. Never use the v2 compact
   bundle for this baseline: doing so would falsely skip the 1,112 changed
   embeddings. Confirm the baseline bundle's receipt pin, publication and full
   local verification before restoring it.
5. `prepare-staging-config.ts` emits standalone configs from checked returned
   resource identities. The request-budget relay binds one actual stage API
   origin and one cumulative 160-attempt ledger across clean restarts. Neither
   tool creates resources, deploys a Worker or makes a serving call on startup.

Restore initialization must receive an empty stage D1 store.
Only SQLite internals and the exact observed `_cf_KV` or `_cf_METADATA` bookkeeping schemas can exist.
The restore creates the compact corpus and supporting publication/run/change/outbox/parser tables.
After the full corpus audit, apply only `migrations/0005_workspace_auth.sql` for synthetic stage access.
Do not apply the root migrations before restore initialization.
Do not combine `COMPACT_CORPUS_SCHEMA` with all historical migrations.
Snapshot operations' fresh-default-schema example is an alternative schema path.
Do not run historical migration 0004 against the production store.

Phase 1 and the snapshot-only check can be approved separately. No pipeline
`/run`, cron or alarm-driven work is allowed before the hosted baseline restore,
strict text audit, vector readback, actual encoder smoke and persisted control
checks pass. Local code/tests do not substitute for these stop points.

## Phase 1 — create and check the isolated resources

Prepare the resource-creation bootstrap offline:

```sh
bun scripts/prepare-staging-config.ts --bootstrap 20261022 --out dist/release/staging
```

The approved execution used the reviewed config for these creation commands.
Saved responses and independent readbacks supply the actual resource identities:

```sh
bun x --no-install wrangler r2 bucket create civicsignal-v1-stage-corpus-20261022 --config dist/release/staging/resources.json --update-config=false
bun x --no-install wrangler d1 create civicsignal-v1-stage-d1-20261022 --config dist/release/staging/resources.json --update-config=false
bun x --no-install wrangler kv namespace create civicsignal-v1-stage-cache-20261022 --config dist/release/staging/resources.json --update-config=false
```

After obtaining the source index's descriptor, set `STAGE_VECTOR_METRIC` to that
verified metric, then create the separate index:

```sh
bun x --no-install wrangler vectorize create civicsignal-v1-stage-statutes-20261022 --dimensions 768 --metric "$STAGE_VECTOR_METRIC" --config dist/release/staging/resources.json --update-config=false --json
```

The stage also needs the source index's language metadata filter before vector writes:

```sh
bun x --no-install wrangler vectorize create-metadata-index civicsignal-v1-stage-statutes-20261022 --propertyName language --type string --config dist/release/staging/resources.json
```

The source and stage readbacks both report `language` with type `String`.
Set `CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a` for account-specific commands.
Some R2 commands do not use the config's account selection in this Wrangler release.

Save the returned and independently checked resource descriptors in an inventory
JSON matching the generator's strict format: `format:1`, the exact `accountId`,
`suffix:"20261022"`, observed ISO timestamp, `d1:{name,id}`, `r2:{name}`,
`cache:{title,id}` and `vectorize:{name,dimensions:768,metric}`. Resource IDs are
required; this plan supplies none. Prepare the complete configs offline:

```sh
bun scripts/prepare-staging-config.ts --inventory dist/release/staging/inventory.json --out dist/release/staging
```

Review every completed binding, service name, source pin, DO migration, container
image/build context, empty cron list and actual resource ID before any deploy.
The generator refuses differing existing output; review a new directory instead
of silently overwriting the prior candidate. Deploy snapshot/encoder/restore only
when their bindings/image and compute/storage budget are approved. Use a dedicated
stage encoder token. Configure secrets with interactive
Wrangler/operator input, for example:

```sh
bun x --no-install wrangler secret put ENCODER_TOKEN --config dist/release/staging/encoder.json
bun x --no-install wrangler secret put ENCODER_TOKEN --config dist/release/staging/api.json
bun x --no-install wrangler secret put ENCODER_TOKEN --config dist/release/staging/pipeline.json
bun x --no-install wrangler secret put PIPELINE_SECRET --config dist/release/staging/pipeline.json
bun x --no-install wrangler secret put RESTORE_TOKEN --config dist/release/staging/restore.json
```

Generate new stage-only encoder, pipeline and restore secrets after approval,
and pass each matching value through private process input. Never read
`~/.civicsignal/encoder-token` or `~/.civicsignal/pipeline-secret`, copy them into
configs, echo them, or put them in command arguments/logs. Generate synthetic
stage API keys through the preparation-only key tool. Supply optional
provider/reranker keys only through approved private input.
Do not set Stripe credentials. Do not make a direct encoder-origin HTTP smoke.
After the baseline restore, one budget-relayed semantic stage API query must
record successful query embedding through the actual stage encoder service and
secret before a pipeline embedding run. Verify the deployed image/model pin
separately through read-only deployment metadata.

## Phase 2 — publish a complete hosted snapshot

Use [the pinned Workflow trigger/status/recovery commands](../services/snapshot/OPERATIONS.md#ordered-release-commands-and-stop-points)
with the standalone snapshot config and selected stage Workflow name. Capture
source commit/date, discovery time, instance/version, every step outcome and final
manifest/index/row-part identities. Download and verify every index/row part and
its source/offset/fingerprint parity; a successful Workflow status alone is
insufficient. Compare with the checked local source/parser artifacts.

For the end-to-end automation gate, the first publication must originate from the
actual scheduled discovery path, with source head verified to match the approved
revision before enabling the one controlled stage schedule. Record its event and
created instance. Keep pipeline scheduling disabled. Remove the temporary schedule
after its approved event. A manual pinned trigger proves hosted Workflow execution
but does not, by itself, prove scheduled discovery/publication. If manual recovery
is needed, distinguish it in the evidence rather than calling the whole run
unattended. A different source head stops the planned reconciliation/evaluation.

## Phase 3 — verify and restore the legacy baseline

The fresh read-only legacy backup is locally verified: 277,857 rows, all vector
positions finite, 254,671 substantive vectors and 23,186 all-zero placeholders.
The assembled store has 853,576,704 payload bytes plus its 16-byte header. The
[tracked receipt](evidence/2026-10-22/legacy-backup-receipt.json) pins the two
manifests, ordered index, all six row parts and store. Its SHA-256 is
`600dd529e48cf8209a444455cfe5e5e2a36d9cc530273176d18782d6954d70fc`.
A separate fresh live stored-value sample matched 329/329 substantive positions
among 356 selected positions, with 27 placeholders; this is sampled live equality,
not a check of every live stored value. Retain that sample's separate evidence.
No stage baseline copy, hosted compact restore or stage pipeline run is claimed.

Read the original legacy R2 manifest, complete ordered ID/fingerprint index, all
row parts and all positional vector parts. Retain original bytes, record fresh
hashes and validate sizes/counts, parser/model/dimensions, placeholders and ordered
index identity. Use the explicit `--parser legacy` assembly/stored-value checks in
snapshot operations. Historical 329-position equality is not a fresh backup;
the fresh sample establishes only the sampled positions. Legacy parts without old
hashes get fresh download hashes, not invented historical checksums.

The new `/vectors` exporter requires completed v2 state and cannot supply this
pre-reconciliation legacy backup gate. Do not relabel legacy bytes as v2, mix
index orderings or publish new legacy objects over old ones.

For the vector baseline, the following completed local preflight reads no
credentials and makes no network request. `cosine` here is an explicitly requested
metric only; this local command did not verify a remote index descriptor:

```sh
bun scripts/restore-stage-vectors.ts --dir dist/legacy-preflight --revision 0507465393c224c0491fc8c17c88340217acc656 --receipt dist/legacy-preflight/legacy-receipt.json --receipt-sha256 600dd529e48cf8209a444455cfe5e5e2a36d9cc530273176d18782d6954d70fc --account ad5ec479b9a421faa2ed06c3d1c2b23a --index civicsignal-v1-stage-statutes-20261022 --metric cosine
```

After the separate index's actual metric and creation descriptor have been
checked, the proposed write command is the same pinned preflight plus `--apply`,
a stage journal and a bounded allowance. Use the verified source/destination
metric, not the locally requested metric above:

```sh
bun scripts/restore-stage-vectors.ts --dir dist/legacy-preflight --revision 0507465393c224c0491fc8c17c88340217acc656 --receipt dist/legacy-preflight/legacy-receipt.json --receipt-sha256 600dd529e48cf8209a444455cfe5e5e2a36d9cc530273176d18782d6954d70fc --account ad5ec479b9a421faa2ed06c3d1c2b23a --index civicsignal-v1-stage-statutes-20261022 --metric "$STAGE_VECTOR_METRIC" --apply --journal dist/release/staging/legacy-vector-restore.json --max-batches 100 --pending-window 100
```

This future command requires an empty stage index on its first invocation. Each
batch covers at most 100 source positions; upserts use the Cloudflare REST v2
NDJSON endpoint, and readback checks every non-placeholder vector in groups of at
most 20 IDs. Repeat only with the same artifacts, target and journal until
`complete:true`, `nextPosition:277857` and `verifiedVectors:254671`; the full copy
has 2,779 positional batches. A lost acknowledgement can replay identical
upserts. An acknowledged pending batch is read back before it advances. The
journal binds the receipt, store, source, account, index, metric and index creation
time. Hold exclusive ownership of the stage index through this copy; pipeline
and other writers remain disabled. The final stage count must be 254,671. This
copies stored values and performs zero document embeddings. Retain checkpoints,
completion output and descriptor with the acceptance packet.

Hosted checks exposed minute-scale visibility delay after an acknowledged upsert.
The bounded pending window holds at most 100 batches, each with 100 source positions.
Format 2 preserves each intended batch and acknowledgement before any later write.
Every checkpoint still requires complete value and metadata readback.
The existing format 1 journal migrates without changing its identity or verified counts.
`--max-batches` limits logical submissions, including uncertain replay.
Each submission retains its separate maximum of three identical REST transport tries.
Twelve bounded visibility checks remain unchanged. A failure stops the writer with its pending receipts intact.

The CLI uses an existing Wrangler login or operator-supplied
`CLOUDFLARE_API_TOKEN`; it does not read CivicSignal secret files or refresh a
credential through a production-resource query. Its exclusive `.lock` prevents
two processes sharing one journal. After a crash, inspect the owning process and
journal before removing that exact stale lock; do not delete/reset a journal to
continue an uncertain copy. A completed-journal replay only reverifies the full
current legacy values/metadata and count. After v2 reconciliation changes the
index, it must refuse the stale baseline rather than overwrite the newer vectors.

Prepare and verify the real legacy compact bundle with its explicit receipt;
review its source publication and page-chain identities. Configure the restore
client's target JSON using the actual deployed restore origin and exact generated
`stageId`, `accountId`, `d1Id` and `r2Bucket`; never guess an origin or UUID. Plan
mode makes no request:

```sh
bun scripts/restore-text-staging.ts --bundle dist/text-cutover-legacy-20261022 --target dist/release/staging/restore-target.json
```

Only after the bundle path, target identities, schema, token and write budget are
reviewed, execute the remote restore with `RESTORE_TOKEN` supplied privately in
the environment:

```sh
bun scripts/restore-text-staging.ts --bundle dist/text-cutover-legacy-20261022 --target dist/release/staging/restore-target.json --execute --checkpoint dist/release/staging/legacy-text-restore.json --concurrency 4
```

Confirm all metadata/text pairs, non-null old fingerprints, vector IDs/counts,
completed baseline publication parser `null` (`SHA:legacy`), full strict-text audit
and an empty vector mutation outbox. The stage must not claim v2 state yet.
Compute and retain the exact legacy-to-v2 ID/fingerprint diff: 1,112 changed,
zero added/removed for this approved revision. Any disagreement stops the writer.

Seed synthetic stage workspaces/keys with capability `civicsignal.retrieve`, plus
separate revoked/capability-limited and tiny-quota fixtures. Do not expose production
keys in staging or point stage usage at production objects. Preserve authentic
production identity/history migration checks as a separate protected release gate.
Use the existing preparation-only `mint-key.ts` against an operator-created stage
workspace; apply its reviewed SQL only to the returned stage D1 ID. Record the
stage API namespace IDs and zero starting synthetic usage before serving tests.

After baseline restore and synthetic-auth preparation, deploy the reviewed stage
API with strict `CORPUS_TEXT_MODE=r2`, its isolated usage DO and stage encoder
service binding. Record the actual stage API origin and namespace identities.
Start the single-origin request-budget relay described below before its first
serving call. Use one of the 21 manual slots for a semantic query through that
relay; require its actual serving observation to report `providers.encoder:"ok"`
for the pinned model. The serving encoder client validates a finite
768-dimensional result before reporting success. This is the hosted inference
stop point before pipeline reconciliation; local encoder tests cannot close it.

## Phase 4 — one non-empty automated reconciliation

Only after the restored-baseline evidence and hard controls pass, deploy the
reviewed stage pipeline config with its separate coordinator and Vectorize binding.
For the compact target, verify the strict R2 text path first, then use
`CORPUS_RETAIN_D1_TEXT=false`; never pretend blank compact text supports a D1
fallback. Confirm authenticated `GET /control` reports the approved source tuple,
`cap:1112`, `submitted:0` and `remaining:1112` on the new stage coordinator. The
configured pin/cap must persist unchanged through every continuation; failed or
uncertain encoder attempts consume the allowance. The unchanged original
production D1 remains outside this stage test.

Enable one controlled pipeline schedule after the stage v2 manifest is complete.
Do not consume the non-empty diff through a manual `/run` first. Observe discovery,
coordinator ownership, cumulative document submissions, vector outbox recovery,
indexed mutation visibility, change events and atomic final state/run publication.
Stop on a wrong revision, unexpected additional ID, missing baseline, count above
1,112, or repeated recovery without progress. Disable the temporary stage schedule
after completion; do not clear pending state to hide a failure.

Acceptance requires the real non-empty cycle, no more than 1,112 document
embeddings, row/vector/text/fingerprint parity, empty pending outbox and matching
published source/parser state. Record source date, discovery/publication/ingestion
timestamps and observed lag. A metadata timestamp or subsequent no-op cron is not
proof of the non-empty automated path. Then use the approved explicit stage URL
and authenticated `export-vectors.ts` procedure to produce/readback-check the v2
vector manifest; that procedure itself performs no document embeddings.

## Phase 5 — bounded serving verification

Use the same stage API origin and request-budget ledger started after the legacy
restore. Confirm it now serves the completed v2 state with strict
`CORPUS_TEXT_MODE=r2`, synthetic auth and its own usage DO. Freeze
source/index/parser/encoder/decision policy for the run. Capture
actual deployment IDs, live capabilities, corpus state, upstream observation and
encoder artifact evidence in a staging provenance JSON as required by
[V1-EVALUATION.md](V1-EVALUATION.md#target-provenance). Do not fill unknown fields
with guessed values. Set `STAGE_API_ORIGIN` to the actual returned origin. Start
one relay for the entire serving allowance, before the Phase 3 semantic smoke:

```sh
bun scripts/staging-request-proxy.ts --target "$STAGE_API_ORIGIN" --ledger dist/release/staging/serving-requests.jsonl --limit 160 --port 8788 --timeout-ms 60000
```

Use its printed loopback origin as `STAGE_API_URL` for **every** serving request,
including MCP notifications, discovery, manual smokes and retries. Keep the same
ledger and limit across restarts; do not call deployment links directly. Use the
checked provenance path as `STAGE_PROVENANCE`, with real `environment:"staging"`
and `backend:"vectorize"` metadata, even though the target is loopback. The relay's
startup output, durable ledger and `x-civicsignal-staging-target` response header
link reports to the actual hosted stage origin. See
[request-budget operations](STAGING-REQUEST-BUDGET.md) for inspection and crash
recovery. No additional origin or direct encoder proxy is approved.

After the budgeted smokes, run exactly:

```sh
bun scripts/eval-v1.ts --target "$STAGE_API_URL" --provenance "$STAGE_PROVENANCE" --split calibration --calibrate-observed true --concurrency 1 --timeout-ms 65000 --output dist/evaluation/v1-stage-20261022-calibration.json
bun scripts/eval-v1.ts --target "$STAGE_API_URL" --provenance "$STAGE_PROVENANCE" --split holdout --concurrency 1 --timeout-ms 65000 --output dist/evaluation/v1-stage-20261022-holdout.json
bun scripts/bench-v1.ts --target "$STAGE_API_URL" --provenance "$STAGE_PROVENANCE" --requests 20 --warmup 2 --concurrency 1,4 --timeout-ms 65000 --output dist/evaluation/v1-stage-20261022-benchmark.json
```

Calibration must retain all 20 fresh, language-filtered pre-refusal serving
observations; no raw `/api/match` substitution or manual scores. It reports a
candidate floor and applies nothing. Hold the existing policy fixed for the
holdout. If calibration prompts a policy change, stop and obtain a new request
budget and independent holdout plan; do not spend another 64 calls silently.
Benchmark results describe the explicit warmup/cache state and bounded closed-loop
mix, not maximum capacity or production performance. These are hosted serving-path
measurements through the local relay; latency includes its filesystem reservation
and proxy overhead. Retain its preparation timing as context without subtracting
it to claim an independently measured direct-Worker latency.

Keep success, retrieval failure, provider fallback and usage uncertainty separate.
A permanent post-commit acknowledgement partition can return an uncertain
`503/USAGE_UNAVAILABLE` after a unit was recorded. Preserve `operationId` and
`month` for reconciliation rather than retrying with a fresh operation indefinitely.
The eight-request reserve and 160 overall ceiling still apply.

## Acceptance packet and next approval

Retain actual inventory/binding descriptors, stage version IDs, artifact hashes,
legacy restore/readback evidence, cumulative embedding/request ledgers, namespace
usage checks, hosted Workflow/cycle logs, source-to-publication-to-serving times,
and raw measurement reports without credentials. Record failed or manually
recovered steps explicitly. Report any unmet gate as pending.

Only after this packet is reviewed should a separate production migration/deploy
proposal be prepared. It must include fresh protected backups and auth/history
copy checks, preserve the production index/usage identities and Railway services,
and provide a rollback retaining the CHS authorization path. Approval of staging
is not approval to deploy production or delete any stage/production resource.
