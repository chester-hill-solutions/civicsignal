# Local v1 evidence

These files record checks from the v1 preparation on 2026-10-22 in Toronto.
Some observation timestamps use the next UTC date.
They do not confirm a release or a production data change.

| File | Evidence | Limit |
| --- | --- | --- |
| `chs-source-proof.json` | Exact source tree, checked patch, five package builds, 117 matching files | Full upstream monorepo gates remain unconfirmed |
| `snapshot-parity.json` | All 277,857 rows, fingerprints, offsets, and UTF-8 lengths | Local source check; no hosted Workflow claim |
| `snapshot-workerd-memory.json` | Largest instrument in local workerd | Sampled memory; no absolute hosted peak claim |
| `parser-fingerprint-delta.json` | 1,112 changed fingerprints; no added or removed IDs | Production reconciliation remains pending |
| `text-cutover-manifest.json` | Checked local restore artifacts and packed text | No production auth/history backup |
| `text-cutover-restore.json` | All 277,857 restored rows; zero metadata differences; 47.92% local size reduction | Source-derived local stores, not a live migration |
| `legacy-text-restore.json` | Checked legacy bundle with original fingerprints and NULL parser publication | Hosted restore remains pending |
| `legacy-backup-receipt.json` | All source artifact hashes, row fingerprints and 277,857 finite vector positions | Does not compare every value with the live index |
| `legacy-vector-live-sample.json` | Fresh 329/329 substantive stored vectors match; 27 verified placeholders | Sampled live equality only |
| `vector-index-descriptor.json` | Observed source index dimensions and cosine metric | Read-only point-in-time descriptor |
| `v2-artifact-archive.json` | Retained compressed bundle hash and extraction command | Large archive remains outside Git |
| `usage-workerd.json` | Real SQLite Durable Object transactions and concurrent receipt replay | Local runtime; no hosted availability claim |
| `evaluation-labels.json` | Sixty positive labels against thirty immutable source blobs | Source labels; no search quality measurement |
| `encoder-image.json` | Pinned artifact, local image, and HTTP smoke checks | Inference needs a compatible AVX host |
| `source-observation.json` | Source head and observed production state | Point-in-time freshness only |

The large source snapshots and restore files remain in ignored local `dist` paths.
Use the release runbook to reproduce them in new directories.
Never use these source-derived files as a substitute for a consistent production backup.
