# V1 preparation and staging evidence

This run began on 2026-10-22 in Toronto and continued on 2026-10-23.
Observation timestamps use UTC. These files do not confirm a production release
or production data change.

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
| `clean-checkout.json` | Frozen install, four compiler checks, 693 tests, runtime probes and five dry-run builds | Local macOS evidence; hosted acceptance remains pending |
| `linux-ci.json` | Linux Node 24 frozen install, 693 tests and five builds | Historical candidate evidence; Railway was later removed from the v1 release gate |
| `stage-restore-protocol-handoff.json` | Isolated Worker binding readback, stopped prior owner, preserved checkpoint and replay of 63 uncertain objects | Full metadata publication and strict hosted audit remain incomplete |
| `stage-snapshot-0600-arming.json` | Actual renewal, checked deployment and live guards, confirmed singleton 06:00 UTC calendar | Arming does not prove scheduled dispatch, Workflow completion or artifact parity |
| `stage-oauth-renewal-050842.json` | One bounded read-only account check renewed OAuth through 06:08:42 UTC | No forced login, expiry edit or production probe |
| `exact-citation-section-preference.json` | Real bilingual source rows, SQLite/PostgreSQL regressions and 787-test full gate | Retrieval-only local proof; unknown URL formats keep fallback ambiguity |
| `stage-setup.json` | Approved limits, created resource identities and deployed stage versions | In-progress setup evidence; no completed hosted acceptance or production migration |
| `stage-fixes-validation.json` | 715 local tests, four compiler checks and five builds after reproduced staging fixes | Linux rerun follows the candidate update |
| `stage-vector-restore-complete.json` | All 277,857 source positions, exact readback of 254,671 vectors and independent final count; preserved visibility failure and readback-only recovery | Pinned legacy backup equality; hosted reconciliation and quality remain incomplete |
| `stage-vector-restore-first-window.json` | 10,200 source positions and 8,508 vectors checked through the bounded pending window | Full baseline copy remains in progress |
| `usage-workerd.json` | Real SQLite Durable Object transactions and concurrent receipt replay | Local runtime; no hosted availability claim |
| `evaluation-labels.json` | Sixty positive labels against thirty immutable source blobs | Source labels; no search quality measurement |
| `encoder-image.json` | Pinned artifact, local image, and HTTP smoke checks | Inference needs a compatible AVX host |
| `source-observation.json` | Source head and observed production state | Point-in-time freshness only |

The large source snapshots and restore files remain in ignored local `dist` paths.
Use the release runbook to reproduce them in new directories.
Never use these source-derived files as a substitute for a consistent production backup.
