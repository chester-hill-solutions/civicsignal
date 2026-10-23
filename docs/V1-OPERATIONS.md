# CivicSignal v1 operations

This procedure describes the release candidate. It does not confirm a production deployment.
The release checklist records the completed checks and remaining gates.

## Platform and identity

Use Cloudflare for the production API and corpus pipeline.
Keep the current Vectorize index, encoder artifact, usage namespace, and account identity.
Keep existing Railway services unchanged during this release. Keep the Bun API as undeployed portability code.
Railway is outside the v1 deployment and release gate. The old Railway workflow
has been removed. Retained Railway configuration is inactive legacy material;
the Bun/Postgres implementation does not depend on Railway hosting.
Existing Railway services have not been decommissioned. Any change to those
services requires a separate decision.

| Resource | Identity |
| --- | --- |
| Account | `ad5ec479b9a421faa2ed06c3d1c2b23a` |
| D1 store | `civicsignal`, `8056b1a0-f858-4f89-a332-91f7f350eb7b` |
| Vectorize | `civicsignal-statutes-gemma`, 768 dimensions |
| Corpus R2 bucket | `civicsignal-corpus` |
| API Worker | `civicsignal` |
| Pipeline Worker | `civicsignal-pipeline` |
| Workspace usage | Existing `API_KEY_USAGE`; object name `customer:<workspace id>` |

The CHS workspace ID equals the former customer ID.
A new key shares the workspace allowance. A key rotation must preserve that workspace.

The candidate supports an optional `AUTH_DB` binding for CHS keys and workspace
billing. Without it, both use `CIVIC_DB`. Before a future corpus switch, explicitly
pin `AUTH_DB` to the authoritative identity store and keep that binding fixed
through corpus rollback. An unavailable explicit auth store returns 503. See the
[corpus rollback procedure](CORPUS-ROLLBACK.md); no deployed binding has changed.

## Local release gates

Use Bun 1.3.5 and Node 24 or later.
Run these commands from the repository root.

```sh
bun install --frozen-lockfile
bun run validate
bun run build
```

The build commands create local bundles. They do not deploy Workers or containers.
Use a clean checkout for the final check. Retain its commit, lockfile, logs, and package manifest.
The package manifest pins CHS source commit `9abf87ed3f47c83d1ddf9547d28bac979cd0c478`.
It includes the API billing 0.1.1 source patch over base commit `853ffc5a606e5526cb64cf453238180223a39d12`.
The manifest also pins the reconstructed Git tree and each built file.
The five built packages use local Bun workspaces.
The runtime package files must pass `bun run check:vendor`.

To refresh the packages, set `CHS_REPO` to a local CHS repository.
The refresh command builds a pinned archive in a temporary directory.
It does not modify the source worktree.

```sh
bun scripts/vendor-corpus.ts
bun install
bun run validate
```

Use `bun scripts/vendor-corpus.ts --verify-source` to check source recovery without a package replacement.
The command can reconstruct the pinned tree from the base commit and checked source patch.
It refuses a different tree or altered patch.

The full local checks include a SQLite Durable Object test in workerd.
It checks concurrent allowance enforcement, legacy counters, and accepted/refused receipt replay.
It also checks immutable R2 creation in workerd.

The [protected-state copier](PROTECTED-STATE-COPY.md) prepares and checks local
SQLite copies of auth, billing, publication and completed history. It preserves
explicit IDs and sequence high-water marks. It does not acquire a consistent
production backup, apply to remote D1, or verify the target's text references,
compact markers or text objects. Those remain separate cutover checks.

The separate [D1 binding helper](PROTECTED-D1-BINDING.md) now verifies those
actual metadata/reference/marker inputs and performs a fresh full R2 audit before
copying protected rows. All 81 focused tests pass, including 29 cases using
synthetic local D1/R2. This is local binding implementation evidence; consistent
production acquisition and authenticated hosted transport remain pending.

Before a corpus backup, use the deployed coordinator's
[suspend/drain protocol](../services/snapshot/OPERATIONS.md#suspend-the-corpus-writer-before-backup)
and verify the same original namespace and suspension revision afterward.
Removing Cron schedules alone leaves Durable Object recovery alarms active.
Use exact schedules PUT/GET for temporary calendar changes: the locked Wrangler
`triggers deploy` also updates subdomain settings. See the
[CLI inspection](evidence/2026-10-22/wrangler-trigger-mutation-code-review.json).

## Read-only production preflight

Check the selected account before any remote command.
Keep credentials in Wrangler or the process environment. Do not copy them into this repository.

```sh
bun x --no-install wrangler whoami --json
bun x --no-install wrangler d1 list --json
bun x --no-install wrangler d1 execute civicsignal --remote --json --command "SELECT corpus_id,commit_sha,as_of,row_count,last_run_at FROM corpus_state"
```

Check the live capabilities document.
Compare its corpus revision and configured tools with the intended candidate.
A successful `/health` response only shows process health.

On 2026-10-23 UTC, the query returned 277,857 rows at commit `0507465393c224c0491fc8c17c88340217acc656`.
The source date was 2026-10-15. The last cycle timestamp was `2026-10-22T16:37:09.355Z`.
The store size was 1,165,287,424 bytes. These values are a point-in-time observation.
An initial query returned account error 7403. Account discovery and a later query succeeded.
At `2026-10-23T00:52:52.966Z`, the authoritative source head still matched that commit.
The source commit date was `2026-10-15T18:08:27Z`.
The latest observed API version was `4c06fcd8-db2e-47b9-92ad-fc214522e73e`.
Read the deployed versions again before release. Do not assume these values remain current.

## Backups before remote changes

Record the deployed API version and pipeline version.
Record the D1 Time Travel bookmark through Wrangler.
Export D1 to a protected directory outside the repository.
Retain the current snapshot manifests, index fingerprints, and vector manifest.
Check the snapshot's row counts, offsets, fingerprints, and vector index digest.

Freeze legacy key changes before the KV export.
The export checks each server key against its secret-hash index.
It refuses inconsistent identities. It treats either disabled flag as revoked.

```sh
bun scripts/export-workspace-auth.ts --remote --output /protected/path/legacy-auth.json
bun scripts/migrate-workspace-auth.ts --input /protected/path/legacy-auth.json --output /protected/path/workspace-auth.sql
```

Both files contain sensitive account metadata. The commands create new files with mode 0600.
They do not print raw keys. The SQL preparation command changes no remote data.
Keep the existing usage namespace. Do not delete or replace any usage object.

## Authorization migration

Review the prepared SQL and backup evidence before deployment approval.
Apply `migrations/0005_workspace_auth.sql` before the prepared identity SQL.
Apply each reviewed additive migration explicitly.
Do not run all historical migrations against the live store.

`0004_drop_search_text.sql` failed on the live table because its rewrite exceeded D1 memory.
It remains a historical migration for empty stores. The text migration must supersede its live operation.
Do not retry the standalone column drop.

The candidate also requires these additive migrations:

- `0006_corpus_mutations.sql`: recovery journal.
- `0007_provision_text_refs.sql`: immutable text references.
- `0008_corpus_parser.sql`: parser identity in state and cycle logs.

None removes provision text or changes vectors.
Remote application remains a release action after review.

After migration, check an existing key before the API switch.
Check its workspace ID, capability, plan, and current usage count.
Check a revoked key. It must remain revoked after a repeated migration.
A conflicting key hash must stop the migration. It must not move the key between workspaces.

## Key lifecycle

Issue keys only for an existing workspace with an enabled billing profile.
Prepare a new key with this command:

```sh
bun scripts/mint-key.ts --workspace existing_customer_id --name "Server access" --output /protected/path/new-key.sql
```

The command prints the raw key once. It writes only the hash to the prepared SQL.
The key becomes valid after an operator applies the reviewed SQL.
Check the new key through an authenticated search.

For rotation, issue the replacement in the same workspace.
Check the replacement before you revoke the old key.
Prepare the revocation with this command:

```sh
bun scripts/mint-key.ts --workspace existing_customer_id --revoke wak_existing_id --output /protected/path/revoke-key.sql
```

Apply the reviewed revocation SQL. Check that the old key returns 401.
Check that the replacement still uses the same workspace allowance.
The key commands never write legacy KV keys.

## Snapshot and pipeline release

The snapshot Workflow pins a source commit and parser version.
It stages the source once, parses bounded groups, sorts index partitions, and publishes the manifest last.
The current namespace is `snapshots/statutes-v2/`. Keep legacy snapshots intact.
A parser change must use a new snapshot identity. Never overwrite an immutable snapshot.

The pipeline accepts only one writer through its Durable Object coordinator.
Manual and scheduled requests share that coordinator. A pending checkpoint survives a restart.
The recovery outbox must drain before a new diff starts.
A completed state requires agreement on both source commit and parser version.

Source discovery in the new candidate uses GitHub's commit-list endpoint with
`per_page=1`, rather than downloading changed-file patches. It makes one attempt,
with a 15-second deadline and 1 MiB streamed response bound. Redirects, malformed
revision/date metadata and oversized bodies fail closed. Safe errors retain the
HTTP status, fixed failure code and validated numeric quota fields within the
coordinator's 500-character saved-error limit. They exclude response bodies,
addresses, credentials and underlying transport errors. This local change is not
a claim that an existing hosted Worker uses the new helper.

Treat HTTP 403 alone as a refusal with an unproved cause. A 403/429 with
`remaining:0` identifies an exhausted primary request allowance. Respect any
reported `retryAfterSeconds` and UTC `reset` before an operator continuation.
The helper performs no retry. In bounded staging, review the same source pin,
coordinator revision and remaining cumulative document/call counters before any
explicit resume. Never reset the ledger or substitute a different source to
recover from a refusal. See [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

Check a full non-empty snapshot and restore before the production switch.
Check every index offset and row fingerprint against the pinned source.
Check the largest parser group in the Workers runtime.
A Bun process measurement does not prove the Workers memory limit.
A local dry-run build does not prove Workflow execution.

Deploy the Workflow and coordinator only after their candidate checks pass.
Observe one non-empty revision through source discovery, snapshot publication, and completed ingestion.
Record the source date, discovery time, publication time, and completed cycle time.
Do not describe a metadata timestamp alone as an end-to-end freshness result.

## Text migration and rollback

Keep D1 text during initial R2 preparation and byte-parity checks.
Use immutable content-addressed text objects and fingerprint-bound references.
Check every reference and text object before strict R2 mode.
The serving mode defaults to D1. Rollback can select D1 while its text remains intact.

The preferred physical reduction path creates a fresh store after approval.
It leaves the original store unchanged. It keeps the existing Vectorize index and usage namespace.
Do not run `clear-text.sql` against the original store on this path.
The optional in-place path has separate clear/restore plans. It does not reduce physical D1 storage.

Prepare a checked local snapshot with these commands:

```sh
bun scripts/prepare-text-cutover.ts --snapshot dist/workflow-validation-v2-bounded --output dist/text-cutover-candidate --revision 0507465393c224c0491fc8c17c88340217acc656:statutes-v2 --objects pack
bun scripts/prepare-text-cutover.ts --verify dist/text-cutover-candidate
bun scripts/verify-text-restore.ts --bundle dist/text-cutover-candidate --output dist/text-restore-candidate
```

Use a new output path for each preparation or restore check.
The tool checks every text object, row fingerprint, backup, and executable plan.
The fresh schema has no lexical column. Each metadata row keeps a blank required text field.
The checked bound-write pages contain at most 16 rows and 34 statements.
Their journal permits identical retries. It refuses a populated source store or a different snapshot identity.

After approval, upload each content-addressed object with conditional creation.
Check each remote object's bytes and SHA-256.
Apply the fresh schema and checked pages to the new D1 store.
Copy protected workspace/key tables, publication state, run/change history, and completed mutation identities from one consistent backup.
The pending mutation journal must be empty before that backup and binding switch.
Check every copied identity, allowance, revision, row count, and history count.
Check all metadata/text pairs through strict R2 mode on the fresh store.
Set API `CORPUS_TEXT_MODE=r2` and pipeline `CORPUS_RETAIN_D1_TEXT=false` for the fresh binding.
Check exact citations, semantic results, change feed, and HTTP/MCP usage before the switch.
Fresh-store rollback restores only `CIVIC_DB` and its matching text mode after
the original corpus passes the parser/vector compatibility checks. Keep the
authoritative `AUTH_DB` binding and existing usage namespace fixed; switching
authorization back to a stale copy could reactivate revoked keys or allowances.
Never reset usage objects or replace the Vectorize index.

The local full snapshot uses parser `statutes-v2`.
The production store still uses the legacy parser.
The parser change alters 1,112 fingerprints and preserves every provision ID.
Complete the approved normal reconciliation before a production snapshot copy claims matching parser/vector identity.
A local source snapshot is not a protected backup of production auth or history.
The live upload, complete D1 restore, protected-table copy, and binding switch remain release gates.

## Search quality and release decision

Run the held-out suite and bounded benchmark through the actual serving route.
Use the commands and provenance schema in `V1-EVALUATION.md`.
Keep calibration cases separate from held-out cases.
Use separate Vectorize and Postgres floor evidence.
Record encoder, reranker, fallback, and cache observations with the result.
Do not infer production throughput from test timing.

Approve deployment only after every required checklist gate has evidence.
Retain the previous Worker version, store backup, snapshot, and key backup for rollback.
After deployment, repeat key, quota, citation, search, change-feed, chat, and MCP checks.
If checks fail, use a reviewed rollback build that retains the CHS authorization path.
The old Worker uses legacy KV authorization.
It can reactivate a key revoked only in the new workspace table.
Do not switch to that Worker after workspace key changes without a checked legacy revocation reconciliation.
Restore corpus data or select the intact previous corpus store through the
reviewed recovery procedure, retaining current authorization and billing in
`AUTH_DB` and the same usage objects.
Never reset usage counters or delete operation receipts as part of rollback.


## Uncertain usage acknowledgements

Validation failures, retrieval failures, exhausted quota decisions, and MCP
protocol bookkeeping do not consume units. A storage acknowledgement failure is
different. If the counter commits but its reply is lost, the bounded retry can
recover the operation receipt and return success with one unit. If connectivity
remains unavailable, the service returns `503/USAGE_UNAVAILABLE`; `uncertain:true`
means the unit may already be committed. Keep the returned `operationId`, `month`,
correlation ID and authenticated workspace identity. This error does not prove
that the counter stayed unchanged.

After connectivity recovers, read the receipt for the same workspace, operation ID, and original UTC month.
For the Durable Object, use an authenticated operator binding and its read-only `GET` receipt protocol.
Supply `X-Usage-Operation` with the original operation ID and `month` with the original UTC month.
For Postgres, read `usage_operations` by `customer_id`, `period`, and `operation_id`.
An accepted receipt confirms the committed unit. An absent receipt does not authorize another increment.
Do not blindly call `consumeMonthly` to inspect a missing receipt.
Keep the returned correlation ID with the receipt evidence.
V1 exposes no public reconciliation endpoint.

The DO namespace and `month:<YYYY-MM>` keys stay unchanged. DO operation receipts
use `operation:month:<YYYY-MM>:<operationId>`. PG requires the additive
`USAGE_OPERATIONS_DDL` receipt table and a transaction-capable runner on one
connection before operation-aware consumption. Keep receipts during migrations
and rollback. Any later retention policy must preserve the reconciliation window.

Stripe delivery remains best effort. A recovered copy must reuse the operation ID
and month so its event identifier is stable. There is no durable Stripe outbox or
product result journal. A permanent partition cannot make the response and counter
commit atomic, and reconciling usage does not recover a lost product result.
A new HTTP request starts a new operation and can consume another unit; do not
describe an uncertain response as an ordinary unbilled retrieval failure.
