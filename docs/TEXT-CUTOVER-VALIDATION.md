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

The bounded protocol initializes a fresh database, conditionally creates immutable text objects with byte/hash readback, applies checked 16-row pages transactionally, checks their ordered SHA-256 chain in 64-page steps, publishes source-derived baseline state, and audits all current rows in persisted eight-row checkpoints (up to four per request). Object uploads and page application can be retried; client checkpoints pin the exact target and plan. Upload counters use indexed journal positions, avoiding a full corpus count for every object/audit step. Completed restores reject further writes. The only accepted pre-existing bookkeeping table is D1's automatically created `_cf_METADATA`.

Plan mode is offline and does not read the token. Execution requires the explicit switch, an isolated target generated from observed resource inventory, an operator-injected environment secret and a local checkpoint path:

```sh
bun build scripts/restore-text-staging.ts --target=node --packages=external --outfile=dist/restore-text-staging.mjs
node dist/restore-text-staging.mjs --bundle dist/text-cutover-legacy-20261022 --target <generated-restore-target.json>
# Only after the isolated staging operation is approved and RESTORE_TOKEN is injected:
node dist/restore-text-staging.mjs --bundle dist/text-cutover-legacy-20261022 --target <generated-restore-target.json> --execute --checkpoint <local-progress.json>
```

Do not put the token in arguments or config files. Restore initialization must run on the empty D1 **before any root migrations**. The Worker creates compatible corpus state/run/change/mutation tables; runs and changes remain empty. It does not fabricate production auth, workspace or history records. After the corpus audit, apply **only `migrations/0005_workspace_auth.sql`** for isolated staging API access; do not reapply the corpus migrations to the restored schema. Production protected-state copying remains a later operation from a consistent backup.

Verification: `CIVICSIGNAL_WORKERD_TESTS=1 bun run test test/staging-text-restore.test.ts test/legacy-text-input.test.ts test/text-cutover.test.ts test/text-store.test.ts` passed **24/24**, including the real local workerd D1/R2 driver, injected row/reference failure and transaction rollback, immutable overwrite refusal, corrupted-text refusal and successful audit after fixture repair, page-chain tampering, populated/production-target refusal, source receipt pinning and legacy NULL publication. Worker, Bun and tooling typechecks passed. Hosted restore/audit remains pending approval.

The physical-size comparison above covers the serving-compatible compact corpus and page journal. The staging upload journal and future protected-state copy add metadata; hosted D1 size must be measured after the approved complete restore.

## Production boundary

This proves a concrete local storage reduction and complete corpus parity. It performs no live D1/R2/Vectorize writes. Production auth, workspace, publication state and change/run history must be copied and checked from one protected backup before changing the binding; those protected records are outside this corpus-only size comparison. Keep the existing Vectorize index and usage Durable Object namespace.

For the fresh-store path, retain the original database unchanged and **do not apply `clear-text.sql` to it**. The bundle's clear/rollback SQL belongs to the optional in-place path. Fresh-store rollback restores the original binding. Upload and verify immutable objects, restore/check the fresh database, set API strict R2 serving and pipeline `CORPUS_RETAIN_D1_TEXT=false` only for the approved cutover, and follow [V1 operations](V1-OPERATIONS.md). Current defaults retain D1 text.
