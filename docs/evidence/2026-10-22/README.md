# V1 preparation and staging evidence

This run began on 2026-10-22 in Toronto and continued on 2026-10-23.
Observation timestamps use UTC. These files do not confirm a production release
or production data change.
Individual receipts retain the result and limits at their observation time.
Later completion receipts supersede earlier progress observations without erasing failures.

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
| `stage-snapshot-0600-outcome.json` | Exact source checks, both watchdog removals, independent empty-calendar and absent-instance/receipt reads | No scheduled dispatch was observed in that window |
| `stage-snapshot-artifact-parity.json` | All 127 Workflow steps and exact equality for 240 hosted artifacts; complete local verification | API-triggered canonical instance; scheduled dispatch remains unverified |
| `stage-text-restore-complete.json` | Full 277,857-row/250,978,206-byte strict audit and independent D1 baseline checks | Legacy parser baseline; production auth/history migration remains separate |
| `stage-serving-baseline.json` | Verified synthetic auth, deployed stage bindings, empty initial usage namespace and 14 passing HTTP/MCP/inference smokes | Baseline protocol proof; reconciliation and quality/performance measurements remain pending |
| `stage-dependencies-ready.json` | Pinned stage encoder/image/one-instance limit and exact Vectorize identity, count and language filter | Management identity proof; serving inference is recorded separately |
| `stage-pipeline-1200-arming.json` | Verified deployment, exact persisted source/cap, successful baseline encoder and both live cleanup guards; actual singleton calendar readback | Arming does not prove dispatch, reconciliation or final vector visibility |
| `stage-pipeline-1200-dashboard-reset.json` | Dashboard proves scheduled dispatch, 400 saved changes and a code-update reset exception | Specific management cause and subsequent failures are unproved |
| `stage-pipeline-1200-guard-shutdown.json` | Both cleanup guards and observer exited; schedules independently empty | Cron removal did not stop pending Durable Object recovery |
| `stage-pipeline-budget-stop.json` | Same coordinator durably paused, no alarm; 1,112 spent attempts, 600 target fingerprints and 512 remaining | Original bounded reconciliation failed; no extra allowance or completion claim |
| `stage-snapshot-1300-skipped.json` | Deadline refusal before arming; both guards exited after empty-calendar checks | No new scheduled event, Workflow or publication |
| `wrangler-trigger-mutation-code-review.json` | Locked CLI also POSTs subdomain settings during `triggers deploy` | Static code evidence does not prove reset causality |
| `snapshot-provider-batch-validation.json` | Red/green real-SQLite proof of committing each provider batch before the next call | An accepted uncertain call can still spend without a row |
| `protected-state-local-validation.json` | Private offline identity/history copy, sequence preservation, atomic replay and restricted SQL fixtures | No production acquisition, remote apply, text-reference/compact-marker parity or usage-object migration |
| `protected-state-format-validation.json` | Same format-1 hashes through the shared Worker-safe codec; 52 focused checks, exact 64 KiB boundary and real workerd Web Crypto | Format extraction only; no protected acquisition or remote D1 application |
| [`../2026-10-23/protected-state-d1-root-validation.json`](../2026-10-23/protected-state-d1-root-validation.json) | 81 focused tests, including 29 actual local D1/R2 cases for protected apply, fresh text admission, atomic guards, replay and sequence preservation | Synthetic local binding only; production acquisition and authenticated hosted transport remain pending |
| `recovery-candidate-local-validation.json` | Complete local gate: 944 tests, four compiler projects, runtime checks and five builds | Candidate at recorded source hashes; later fixes require fresh checks |
| `stage-recovery-extension-candidate.json` | Exact compiled same-object allowance, recovery/verify-only stop bundles and bounded operator packet | Local preparation only; extra usage requires explicit approval before deployment/initialization |
| `stage-recovery-extension-independent-review.json` | Frozen runtime/operator/input hashes, corrected failure/reconstruction and operator findings, independent scenario check | No hosted grant, identity or completion claim; execution remains unapproved |
| `stage-recovery-approved-attempt-1.json` | Subsequent user approval, exact hosted grant and safe pause after six calls/1,304 cumulative attempts | Unknown failure; completion and reported new row progress await independent checks |
| `stage-recovery-progress-1.json` | Independent paused D1 reads: 792 target fingerprints and matching feed/mutation identities, 320 remaining, empty outbox | Metadata proof; no completed publication or new full R2/vector-byte audit |
| `stage-recovery-source-403.json` | Stop-only diagnostic preserves same grant/state; exact saved-error hash matches GitHub source-head HTTP 403 | Refusal reason is unproved; no contingency resume or completed ingestion |
| `stage-source-head-quota-exhausted.json` | Fresh version/binding/control verification and one immutable probe: HTTP 403 with anonymous quota 0/60; unchanged 1,304 attempts/six calls | Current exhaustion only; historical 403 cause unproved, probe consumed and continuation never attempted |
| `source-head-local-validation.json` | Head-only deadline/size/cancellation/quota diagnostics; 1,070 tests in 83 files, four compilers and five builds | Local only; optional corpus-file skips recorded and historical 403 reason unproved |
| `vector-backup-client-local-validation.json` | Paused client/CLI protocol, request/privacy bounds and corrected journal durability; 75 focused checks | No hosted backup acquisition, independent vector-byte download or model attestation |
| `rollback-backup-local-release-gate.json` | AUTH_DB rollback isolation and backup client; final local gate with 1,018 tests and five builds | No deployed auth binding, protected production copy or hosted corpus rollback |
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
