# Snapshot and recovery validation — 2026-10-22

The local full-corpus check used clean Justice Canada revision
`0507465393c224c0491fc8c17c88340217acc656`, dated 2026-10-15, with parser
`statutes-v2`. It checked **11,736 files and all 277,857 serialized rows** against
an independent direct XML pass, including every UTF-8 byte offset and length.
No live Cloudflare, Vectorize or Railway resources were changed.

| Measurement | Result |
|---|---:|
| Bounded staged groups | 118 |
| Serialized row bytes | 364,231,731 |
| Index bytes | 26,147,151 |
| Full build, local wall time | 173.37 s |
| Build plus complete reference parity | 277.98 s |
| Added/removed IDs against the legacy snapshot | 0 / 0 |
| Changed row fingerprints against the legacy snapshot | 1,112 |

The 1,112 differences include labelled enacting clauses, not only the two known
unlabelled examples. They require incremental re-embedding after an approved
snapshot reconciliation; they do not require recreating the existing index.
Local timing had concurrent compiler contention and is not a hosted CPU, latency
or throughput measurement.

The full check's parser-source identity is
`89408196d74cf05331562ed80676adf84675e153dec98cb9f8065c9e3fb24cb8`.
Its component SHA-256 hashes are:

- `statutes.ts`: `3fa48710fca608f6f09489f7dce474029cd3f88f15f47c36599228214127f043`
- `corpus-rows.ts`: `f30f9bef944daa1aed1e4806f8f8a33b5229d5093ec4638f77eb163efee53dd7`
- `reconcile.ts`: `6c4e581fa32aab7a6574e4757542c8cb59605ca3b8181bf11e7fa79e116cac8b`

The index's ordered ID/fingerprint digest is
`b9b9ad97092ae2c5b4a35580f0cafe73`; its byte SHA-256 is
`24fc30cfc427d5231c24fce911de198e92b7ada8b429aa4c6341ccb4f0159feb`.
The result artifact is locally available at
`dist/workflow-validation-v2-bounded/validation-result.json`. Reproduce it with
`scripts/validate-snapshot-workflow.ts`; generated corpus artifacts stay ignored.

## Runtime memory evidence

DevTools `Runtime.getHeapUsage` sampled the actual `buildGroup` function in local
workerd while processing the largest instrument, French `I-3.3.xml`
(14,877,873 input bytes; 764 resulting rows). The original group builder sampled
220.6 MB of combined used heap/backing storage. Restricting XML DOM parsing to
identification metadata, retaining only required structural spans, staging large
files as raw XML, and using 2 MiB row parts reduced the final recorded maximum to
**104,218,517 bytes** (86,797,684 bytes of used JS heap).

This is sampled local evidence with margin below the hosted 128 MiB budget. It
does not prove every instantaneous peak or the hosted limit. `node:v8` and
`process.memoryUsage()` returned zeroes inside workerd and were discarded as
measurement methods. The reproducible probe records source hashes and raw
samples in `dist/workflow-validation-v2-bounded/workerd-group-heap-final.json`.
A complete Workflow run against an isolated staging bucket remains required
before production deployment.

A real local workerd R2 binding also verified that conditional
`onlyIf: { etagDoesNotMatch: '*' }` returns `null` on an existing key and preserves
the first bytes. The equivalent `If-None-Match: *` header behaved identically.
Reproduce this safety precondition with `scripts/check-r2-immutability.ts`.

## Fault and contract checks

The focused suite passed **139 tests across 14 files**. Actual SQLite statements
verified rollback on feed-insert failure, recovery after row/feed commit before
vector acknowledgement, removal replay, immutable text-upload failure, atomic
row/reference updates, both live and clean D1 schema shapes, and run/state
publication. Actual embedded PostgreSQL/pgvector verified the corresponding
transaction and duplicate-event suppression. Coordinator tests covered
concurrent requests across long awaits, restart checkpoints, alarms, failed work
and bounded catch-up continuation.

Snapshot tests verified file-order rows with sorted index partitions, complete
bilingual ingestion, retry identity, immutable conflicts, missing/corrupt parts,
duplicate IDs, malformed manifests, whole-index checks before mutation, row
fingerprint checks and positional vector index identity. Worker, Bun and snapshot
TypeScript projects passed; pipeline and snapshot dry-run bundles succeeded.
These are local release-candidate checks, not deployment approval or proof of
live corpus freshness, hosted memory/CPU limits or production text cutover.


The final vector-backup checks exercised server-derived index ordering, current
D1 state/fingerprints and empty-outbox gates, indexed fingerprint visibility for
new mutations, finite float32 values, verified placeholder gaps, immutable
retry/conflict behavior and readback SHA-256. A real SQLite test matched the
JSON mutation identity used by D1. Both restore/check CLIs rejected same-count
changed fingerprints before loading credentials or making a remote request,
for current and explicit legacy parser layouts. The legacy local rebuild now
checks exact index identity and optional part hashes before atomically naming
its output; sampled live-vector mismatches produce an unsuccessful exit.

The final pipeline dry-run bundle was 182.51 KiB (42.24 KiB gzip), and the
snapshot bundle 127.96 KiB (28.27 KiB gzip). All four TypeScript projects passed.
The current-parser export CLI completed an offline full-index dry run at the
verified corpus identity: 277,857 positions, 28 fixed parts and 853,576,704 bytes.
The retired local publisher verified all source snapshot part hashes and index
identity without remote access. A fresh live legacy backup, hosted staging
execution and approved production deployment remain unperformed gates.
