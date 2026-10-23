# Provision-text compact-store validation — 2026-10-22

The complete pinned federal corpus was exported to a verified packed-text bundle and restored into a separate metadata-only SQLite store. Strict R2-style hydration verified **every one of the 277,857 current rows** against its content SHA-256 and full row fingerprint. All metadata columns matched the retained original. Its file SHA-256 remained unchanged after the proof.

Source identity: `0507465393c224c0491fc8c17c88340217acc656:statutes-v2`. Preparation reused the checked index and parts in `dist/workflow-validation-v2-bounded`; it did not reparse XML or call the encoder. See [snapshot validation](SNAPSHOT-VALIDATION.md) and the [saved restore evidence](evidence/2026-10-22/text-cutover-restore.json).

| Check | Result |
| --- | ---: |
| Verified metadata/text pairs | 277,857 |
| Verified provision bytes | 250,978,206 |
| Unique content-addressed objects | 208,396 |
| Packed unique text bytes | 244,470,986 |
| Metadata differences | 0 |
| Original local store | 416,051,200 bytes |
| Compact local store, including references and restore journal | 216,674,304 bytes |
| Physical reduction | 199,376,896 bytes / **47.92%** |
| Bound restore pages | 17,367 |
| Largest serialized restore page | 25,661 bytes |
| Maximum statements per atomic page | 34 |

Exact bilingual reads preserved Canada Health Act section 8 (`acts-en-151510`, `acts-fr-147900`), including its text and citations. Shared semantic retrieval hydrated the same two sample rows with controlled vector results. These samples verify adapter behavior; they do not measure encoder relevance. Separate HTTP regression coverage verifies strict-R2 exact and semantic routes, retained workspace usage history, missing-object failure, and binding rollback.

The compact schema retains a blank `text` column for serving/ingestion compatibility, omits `search_text`, and preserves all identifiers, fingerprints, citations, language, schedule and part metadata. Pages use bound values, plain inserts, a bundle identity and an atomic page journal. Regression checks cover page replay, ordering, wrong target identity, populated-store refusal, SQL rollback, source corruption, stale references, UTF-8 boundaries and corrupted retained D1 fallback. Hydration bounds individual objects to 2 MiB, the retained candidate set to 16 MiB, and simultaneous object reads to eight.

## Reproduce locally

```sh
bun scripts/prepare-text-cutover.ts --snapshot dist/workflow-validation-v2-bounded --output dist/text-cutover-new --revision 0507465393c224c0491fc8c17c88340217acc656:statutes-v2 --objects pack
bun build scripts/verify-text-restore.ts --target=node --packages=external --outfile=dist/verify-text-restore.mjs
node dist/verify-text-restore.mjs --bundle dist/text-cutover-new --output dist/text-restore-new
```

The earlier v2 bundle has been archived after integrity checking; its completed proof remains `dist/text-restore-full-20261022-v2/report.json`. The audit ran under Node.js v25.9.0 after the local store files were prepared. A completed restore can be rechecked with the last command plus `--resume`; it checks the same bundle/page identity and every original row against the verified backup before auditing. Output directories are never silently replaced. Interrupted sealing also has a checked `--recover` path documented by the preparation CLI.

The three completed local proof stores now use lossless `.sqlite.gz` archives in
that same directory to preserve disk headroom. Their decompressed SHA-256 values
were checked before compression replaced the local uncompressed copies.
The adjacent `compression-receipt.json` records both sets of hashes.
Decompress those three files before a resume check against this retained proof.

## Verified legacy staging input

The retained archive is `dist/text-cutover-full-20261022-v2.tar.gz`.
Its SHA-256 is `260f06adff3f03a563a503c8e3644bde088473c9836d86d260f45f12d163715a`.
Extract it with `tar -xzf dist/text-cutover-full-20261022-v2.tar.gz -C dist`.
The [archive receipt](evidence/2026-10-22/v2-artifact-archive.json) records its checked contents.

The current staging candidate is **`dist/text-cutover-legacy-20261022`**, revision `0507465393c224c0491fc8c17c88340217acc656:legacy`. It was prepared from the six original root-level row parts and sorted index, using the checked receipt `dist/legacy-preflight/legacy-receipt.json` (SHA-256 `600dd529e48cf8209a444455cfe5e5e2a36d9cc530273176d18782d6954d70fc`). Every source artifact was hashed before use and every source row fingerprint was rechecked. Preparation preserves all 277,857 legacy IDs, fingerprints and labels; it does not relabel data as `statutes-v2` or rewrite vectors. Publication uses `parser_version=NULL`, commit date/as-of `2026-10-15`.

The receipt records every vector position as finite, including 254,671 embedded rows and 23,186 zero placeholders. Vector validation/restoration is separate from this text path. The legacy text pack is byte-identical to the v2 text pack; its metadata-page hashes differ. See [legacy staging evidence](evidence/2026-10-22/legacy-text-restore.json).

```sh
bun build scripts/prepare-text-cutover.ts --target=node --packages=external --outfile=dist/prepare-text-cutover.mjs
node dist/prepare-text-cutover.mjs --snapshot dist/legacy-preflight --receipt dist/legacy-preflight/legacy-receipt.json --output dist/text-cutover-legacy-new --revision 0507465393c224c0491fc8c17c88340217acc656:legacy --objects pack
```

Legacy input requires the explicit receipt and exact pinned SHA. Missing checks, changed source artifacts, a different source index or attempts to attach the legacy receipt to a parser-versioned snapshot fail before preparation.

## Concrete staging restore protocol

`services/restore/worker.ts` is an isolated admin Worker. Its checked-in config is disabled and has no resource bindings. An approved generated config supplies only `RESTORE_DB`, `RESTORE_TEXTS`, explicit staging resource identity vars and the `RESTORE_TOKEN` secret. Both client and server refuse the known production D1 ID/bucket; remote admin origins must match `civicsignal-v1-stage-restore-*.<account>.workers.dev`. Loopback origins are allowed for local workerd fixtures. Every authenticated request repeats account, stage, D1, R2 and checked plan identities. There is no SQL execution endpoint or production application route.

The bounded protocol initializes a fresh store and conditionally creates immutable text objects with byte/hash readback.
It applies checked 16-row pages transactionally and checks their ordered SHA-256 chain in 64-page steps.
It publishes source-derived baseline state and audits all rows in persisted eight-row checkpoints, with four checkpoints per request.
Object uploads and page application permit identical retries. Client checkpoints pin the exact target and plan.
Upload counters use indexed journal positions. Completed restores reject further writes.

The default transport still uploads one object per request. The optional
`--upload-batch-size 16` transport sends at most 16 objects in one binary frame,
including headers and payload within **2 MiB**. Its eight-byte header identifies
the version/count; each 40-byte descriptor contains a SHA-256, byte length and
`sourceOrdinal`. Source ordinals must be positive, contiguous, unique and within
the pinned object-index count. Every object's SHA-256 and UTF-8 validate before
the first write. Descriptors and acknowledgements bind the client's source range;
they do not replace the existing upload journal's arrival-counter ordinal.
This preserves already committed objects whose arrival order differs from source order.

Each batch has at most four object workers. Every object still receives its own
conditional immutable R2 create, full byte/hash readback and checked journal entry.
All in-flight workers settle before either success or failure is returned.
The client permits at most four simultaneous batch requests and verifies the
complete source-ordinal/SHA/byte acknowledgement set before checkpointing a wave.
Failed or uncertain waves replay identically; a wave can contain at most 64 objects.
An individual object too large to fit with framing uses the compatible single-object path.
Metadata pages, publication and the full strict-row audit are unchanged.

Hosted D1 created `_cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID` in the otherwise empty stage store.
Local workerd creates `_cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)`.
The shared freshness guard accepts only these observed names and exact schema shapes, plus SQLite internals.
It rejects unknown or malformed `_cf_*` objects, application tables/views and prefix lookalikes.
The initial hosted refusal preserved all data and sent no initialization, upload or page write.
The corrected deployed guard returned `fresh:true` before the approved restore began.

Plan mode is offline and does not read the token. Execution requires the explicit switch, an isolated target generated from observed resource inventory, an operator-injected environment secret and a local checkpoint path:

```sh
bun build scripts/restore-text-staging.ts --target=node --packages=external --outfile=dist/restore-text-staging.mjs
node dist/restore-text-staging.mjs --bundle dist/text-cutover-legacy-20261022 --target <generated-restore-target.json>
# Only after the isolated staging operation is approved and RESTORE_TOKEN is injected:
node dist/restore-text-staging.mjs --bundle dist/text-cutover-legacy-20261022 --target <generated-restore-target.json> --execute --checkpoint <local-progress.json> --concurrency 4 --upload-batch-size 16
```

Do not put the token in arguments or config files. Restore initialization must run on the empty D1 **before any root migrations**. The Worker creates compatible corpus state/run/change/mutation tables; runs and changes remain empty. It does not fabricate production auth, workspace or history records. After the corpus audit, apply **only `migrations/0005_workspace_auth.sql`** for isolated staging API access; do not reapply the corpus migrations to the restored schema. Production protected-state copying remains a later operation from a consistent backup.

The focused gate covers six restore/text test files, including binary framing and
fresh-schema checks. All **58/58** focused tests pass, including eleven real local
workerd tests. They cover out-of-order arrival counters, uncertain prefix replay,
lost and malformed acknowledgements, zero-write prevalidation failures, partial
immutable failure, near-limit single-object fallback, and four concurrent full-size
frames. Worker, Bun and tooling typechecks pass. The complete frozen candidate
passes **736 tests across 70 files**, including the local runtime and invariant gates.

A local workerd/DevTools probe exercised four simultaneous 2 MiB frames containing
16 objects each, with server parallelism four. All 64 acknowledgements verified;
the idempotent journal retained 16 unique objects. Nine heap samples recorded
maximum combined JS/backing/embedder usage of **30,692,139 bytes (29.27 MiB)**.
The raw report is `dist/release/staging/legacy-text-restore-evidence/upload-batch-heap.json`;
the probe source and bundled runner are
`dist/release/staging/probe-restore-batch-memory.{ts,mjs}`.
Sampling can miss instantaneous peaks and does not prove a hosted memory limit.
The batch path performs at most 66 binding operations per request (32 R2,
32 journal SQL, two session SQL), with at most four active object operations.
These are below the current documented internal-service and connection limits
for the reviewed deployment. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The approved hosted single-object run was deliberately paused at a durable
checkpoint of **1,236 objects and zero metadata pages** after measuring about
4.5 verified objects/second. Its exact process was verified before SIGINT;
at most four subsequent identical puts may already have committed. Its logs and
checkpoint remain in `dist/release/staging/legacy-text-restore-evidence/attempt-2`.
The batch deployment and independent binding readback passed for stage version
`aec00122-16a2-4e69-940b-437d6efae525`. The copy resumes the
same target, source plan and checkpoint. No reset, deletion or ordinal relabel is required.
The hosted restore and full strict audit are not yet complete.

The physical-size comparison above covers the serving-compatible compact corpus and page journal. The staging upload journal and future protected-state copy add metadata; hosted D1 size must be measured after the approved complete restore.

## Production boundary

The local proof shows a concrete storage reduction and complete corpus parity.
Approved hosted staging is now in progress; production remains unchanged.
Production auth, workspace, publication state and change/run history must come from one protected backup before the binding switch.
Those protected records are outside this corpus-only size comparison. Keep the existing Vectorize index and usage Durable Object namespace.

For the fresh-store path, retain the original database unchanged and **do not apply `clear-text.sql` to it**. The bundle's clear/rollback SQL belongs to the optional in-place path. Fresh-store rollback restores the original binding. Upload and verify immutable objects, restore/check the fresh database, set API strict R2 serving and pipeline `CORPUS_RETAIN_D1_TEXT=false` only for the approved cutover, and follow [V1 operations](V1-OPERATIONS.md). Current defaults retain D1 text.
