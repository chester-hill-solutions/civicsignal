# CivicSignal v1 release plan

This is the execution checklist for the v1 goal started on 2026-10-22. It reconciles
the code audit, the CHS package review, `docs/PLAN.md`, and section 9 of
`~/.civicsignal/HANDOFF.md`. The checklist records verified outcomes, not intentions.
Cloudflare is the only v1 deployment target. Keep the existing Vectorize index and vectors.
Existing Railway services are outside this release. Preserve unrelated work and the Bun/Postgres portability code.

Current hosted status: baseline restore, snapshot Workflow artifact parity and
14 serving smokes pass. Independent paused reads now confirm 792 of 1,112 target
changes and an empty pending outbox; 320 changes remain. The original 1,112-attempt
reconciliation failed its bound. The approved same-coordinator recovery has spent
1,304 cumulative document attempts and six extension calls; 448 document slots
and 14 calls remain. Its saved failure matches a GitHub source-head HTTP 403.
The earlier refusal reason remains unproved. A separate one-shot probe at
19:16 UTC returned HTTP 403 with anonymous GitHub quota 0/60. The current
stop-only version `40110049-9cf5-44c3-b23f-ed39e06da7b7` was independently checked
after a local disk failure interrupted its first verification. It retains the
suspended revision, no alarm and unchanged counters. The probe is consumed; the
prepared continuation refused qualification and was never deployed or resumed.
See the [progress proof](evidence/2026-10-22/stage-recovery-progress-1.json),
[earlier failure identification](evidence/2026-10-22/stage-recovery-source-403.json)
and [current quota observation](evidence/2026-10-22/stage-source-head-quota-exhausted.json).
Completed ingestion, retrieval evaluation and production migration remain pending.

## Release requirements

| ID | Outcome | Acceptance evidence | Status |
| --- | --- | --- | --- |
| V1-01 | One CHS identity and metering path for HTTP and MCP | Existing key hashes, customer IDs and counter identities survive migration; revoked/missing keys fail; capabilities apply; each successful retrieval consumes one confirmed unit; retrieval failures and protocol bookkeeping consume none; unresolved post-commit acknowledgements return an explicit uncertain 503 with operation ID for reconciliation | Local checks pass; hosted migration pending |
| V1-02 | Reproducible package installation and builds | Fresh tracked checkout installs with the frozen lockfile and imports every vendored export; package provenance recorded; Worker dry-run builds | Complete locally |
| V1-03 | Retrieval and BYOK correctness | Language and decision versions isolate cache entries; warm hits avoid reranking; input bounds, Google credentials and browser CORS pass regression tests | Complete locally |
| V1-04 | Recoverable ingestion | Injected faults between row/vector/feed/state writes recover without missing changes or duplicate events; Postgres transactions and D1 recovery cover the same contract | Local recovery fixes pass; 792/1,112 hosted changes verified; fresh source probe confirms exhausted anonymous quota |
| V1-05 | Automated immutable snapshots | Cloudflare Workflow creates bounded row parts and sorted index partitions per revision, publishes only complete manifests, and resumes after failure | Full local and hosted Workflow parity passes; scheduled dispatch remains unverified |
| V1-06 | Verified restore and corpus-text migration | Manifest/index/fingerprint integrity is enforced; backup and rollback exist; old/new reads and complete non-empty ingestion agree before live cutover | Full local and stage baseline audit passes; production cutover pending |
| V1-07 | Broad, measured retrieval quality | Held-out English/French answerable and unsupported cases; backend-specific acceptance calibration; reported false acceptance/rejection and end-to-end latency/throughput/freshness | Pending |
| V1-08 | Honest, complete v1 surfaces | Every advertised route/tool is usable; unavailable corpora and geography are explicit; change-feed and exact citation flows are verified | Local route checks pass; hosted checks pending |
| V1-09 | Complete engineering gates | Worker, Bun and scripts type-check; endpoint and recovery tests pass; CI validates clean checkouts and builds without production credentials | Local and Linux release gates pass |
| V1-10 | Reviewable release candidate | Current runbook, migration/restore/deploy/rollback commands, verified limitations, and item-by-item completion audit; required final approvals occur after preparation | Candidate prepared; hosted acceptance pending |

## Work order

1. Establish reproducible CHS dependencies and secure the existing retrieval surfaces.
2. Fix runtime defects and the validation boundary while ingestion recovery is built.
3. Validate snapshot publication and restore locally, then prepare storage cutover.
4. Complete evaluation, honest coverage, change-feed access and operations.
5. Run the full release audit. Prepare the candidate before any final deployment approval.

No requirement is complete solely because a unit test or static invariant passes.
Live claims require live evidence. A deliberate v1 exclusion needs a recorded rationale;
it must not silently shrink the agreed goal or leave an advertised feature broken.

## Initial evidence

- Audit baseline: commit `717bf32`; clean working tree; 335 tests in 30 files pass.
- Configured type-check passes, but an expanded check found 27 diagnostics in 11 files.
- Confirmed probes: unauthenticated MCP retrieval; failed Bun calls consume quota;
  low-relevance Postgres results; cross-language refusal-cache collision; redundant
  rerank calls; missing Google key and BYOK CORS headers; lost change-feed entry on retry.
- The billing package's runtime is present locally but absent from tracked files.
- Handoff records production reranking, a Vectorize fallback floor of 0.62, exact
  agreement for 329 sampled stored/exported vectors, and 25 unsupported probes below
  the floor. These are historical measurements until rerun for the release candidate.

## Verification log

Append the affected requirement IDs, commands, outcomes and material limitations after
each reviewed implementation increment. Do not replace a failed check with a narrower
check without recording the reason.

## Current plan dispositions

| Earlier plan | v1 disposition | Reason and owner |
| --- | --- | --- |
| Shared commercial spine | Replace production copies with CHS auth, auth-d1, and api-billing | One identity, capability, and meter path; product keeps its billing profile |
| Railway API migration and Cloudflare deletion | Superseded | Cloudflare is the v1 target; retained Bun/Postgres portability does not require Railway hosting |
| Statute ingestion, snapshots, vector export, text move | Required | V1-04 through V1-07 remain release gates |
| News, GDELT, debates, bills | Excluded from v1 | No production ingestion; discovery omits them and routes refuse unsupported coverage |
| Riding, municipal, regional and provincial filters | Excluded from v1 | Federal statutes do not support these filters; requests fail explicitly |
| Coverage tone and geographic distribution | Excluded from v1 | Both require an ingested news corpus |
| Exact citations and observed change feed | Required | V1-08 covers both HTTP and MCP paths |
| External web search fallback | Deferred | v1 can refuse or report a route decision; it must not invent a web answer |
| OpenCode harness and customer processes | Deferred | v1 ships HTTP, MCP and BYOK chat; no customer process host |
| Portal, widget, daily briefing and commercial bulk licence | Deferred | Separate product surfaces; no implemented v1 user flow depends on them |
| Directory submissions, Apify Actor and OAuth | Deferred | Distribution and consent flows require a released API and explicit publication scope |
| Prepaid checkout and published unit price | Deferred | v1 enforces workspace allowance; paid pricing remains unconfigured |
| Retrieval experiments and historical price estimates | Historical evidence | Current policy requires new held-out results and measured serving-path performance |

The old plans remain as history. Their opening notices link to this checklist.
README and live discovery describe the current v1 scope.
No exclusion removes the snapshot, restore, text migration, evaluation, or recovery gates.

## Reviewed implementation evidence — 2026-10-22

- V1-01: Real SQLite plus CHS key verification tests preserve old secrets, workspace IDs, plans, and revocation.
  Conflicting hashes fail. Key issue, replacement, and scoped revocation tests pass.
- V1-01: Worker endpoint tests exercise the actual shared Durable Object class and ledger client.
  A successful MCP search consumes one unit. Discovery, invalid input, retrieval failures, and exhausted calls consume none.
  A lost usage acknowledgement is distinct: an uncertain 503 can coexist with a committed unit; operation IDs permit reconciliation without another increment.
  The fixture does not prove Cloudflare input-gate concurrency.
- V1-01: A real local workerd SQLite Durable Object preserves the legacy counter.
  Twelve concurrent requests with one operation ID consume one unit.
  Twenty competing new operations consume only the three remaining units.
  Accepted and refused receipt replays preserve the counter.
  This local test does not prove hosted availability or HTTP delivery.
- V1-02: Five vendored CHS packages contain 117 checked files at source commit `9abf87ed3f47c83d1ddf9547d28bac979cd0c478`.
  API billing 0.1.1 adds atomic operation receipts and strict usage failure handling.
  The tracked patch reconstructs the pinned Git tree from base commit `853ffc5a606e5526cb64cf453238180223a39d12`.
  All five isolated package builds match the vendored runtime files.
  Local Bun workspaces prevent empty nested package copies during installation.
  The final fresh checkout installs the frozen lockfile and passes its gates.
- V1-03: Regression tests cover language and policy cache keys, warm-cache reuse, bounded inputs, Google credentials, and BYOK CORS.
  Citation titles now follow the database binding, source revision, and parser version.
- V1-04: Fault-injection tests cover D1 outbox recovery and Postgres transaction rollback.
  D1 handles both the live legacy lexical column and a clean post-migration schema.
  The single-writer coordinator joins concurrent calls and resumes pending work through alarms.
- V1-05: The final bounded pinned-source check processes 11,736 files and 277,857 rows.
  Independent checks compare every row, fingerprint, byte offset, and UTF-8 length.
  It writes 118 bounded source groups and 364,231,731 row bytes.
  The ordered index contains 26,147,151 bytes.
  Its fingerprint is `b9b9ad97092ae2c5b4a35580f0cafe73`.
- V1-05: Workers heap sampling exposed a 220.6 MB workload. Parser and builder changes reduced the largest sample to 104,218,517 bytes.
  Sampling supports the memory assessment; it does not prove an absolute hosted maximum.
  A real local workerd R2 binding also passes immutable-create checks.
- V1-06: Additive text references and immutable R2 text reads support D1, parity-check, fallback, and strict modes.
  The full local restore checks all 277,857 rows and 250,978,206 provision bytes.
  It finds zero metadata differences and preserves the original file's SHA-256.
  Both bilingual exact citations and shared semantic hydration samples pass.
  The original comparison store uses 416,051,200 bytes. The compact store uses 216,674,304 bytes.
  The local reduction is 199,376,896 bytes, or 47.92 percent.
  All 17,367 checked restore pages apply. The largest page uses 25,661 bytes and at most 34 statements.
  This source-derived local proof does not copy production auth/history or complete the live cutover.
- V1-07: 60 positive labels match 30 immutable source files. The held-out positive set covers 12 new Acts.
  The dataset also includes 24 scope negatives and two explicitly unverified exclusions.
  No new production quality or throughput result is claimed.
- V1-08: Coverage and change-feed checks use actual SQLite schema and actual MCP tool callbacks.
  HTTP exact citations work without an encoder. Unsupported corpora, geography, and dated statute searches return explicit errors without billing.
- V1-09: Separate Worker, Bun, tooling, and snapshot compiler projects cover the release code.
  All four compiler projects pass after the full fixture boundary fix.
  All five Worker dry-run builds pass, including the disabled stage restore Worker.
  No Worker or image was deployed.
  A fresh clone of `b3adaab08a2563cfd41c9ca6b94a02f14a96eb81` passes the complete local gate.
  It passes 693 tests across 68 files, both real workerd probes, all invariants, and five Worker builds.
  The local check uses Bun 1.3.5 and Node 25.9.0 on macOS.
  Linux Node 24.21.0 CI also passes the frozen install, all 693 tests, runtime probes, invariants and five builds.
  Corpus invariant checks skip absent historical SQL/JSONL artifacts; the separate full-corpus proof covers current snapshot data.
  One earlier parallel check exposed a timing assumption in a relay test.
  Deterministic checks now cover expiry before forwarding and cancellation after the request starts.
  Production timeout behavior did not change.
  The separate Railway plan action failed before planning because its v1 tag reinstalled dependencies with npm.
  A checked upstream commit supports reuse of the frozen Bun install. Its CLI version is pinned too.
  Automatic plan comments are disabled. The saved plan remains a review artifact; no apply occurred.
  The corrected action reaches planning, but CI supplies an empty `RAILWAY_TOKEN`.
  Railway refuses the plan. No apply occurs.
  The later scope correction removes this legacy workflow and credential requirement from the v1 release gate.
- Encoder: The local amd64 image builds from a pinned base and model artifact.
  Network-disabled smoke checks pass for artifact identity, health, authentication, invalid JSON, and empty batches.
  These checks do not measure inference quality or latency.
  An actual inference check hit the host's missing AVX support under amd64 emulation.
  The disposable container stopped. A compatible hosted inference check remains required.
- Operations: A read-only production query returned 277,857 rows at source commit `0507465393c224c0491fc8c17c88340217acc656`.
  Before staging approval, no remote data, index, service, secret, or deployment changed.
  A later read confirms the authoritative source head matches this commit.
  This point-in-time match does not prove automated end-to-end freshness.
- Staging preparation: The checked legacy receipt covers every row fingerprint and all 277,857 finite vector positions.
  A fresh live sample matches 329/329 substantive vectors, with 27 verified placeholders.
  Full local preflight passes for the isolated vector restore.
  The stage text restore passes 24 focused checks, including four real local workerd D1/R2 checks.
  Source pins, a durable 1,112-document submission cap, and a shared 160-request relay constrain the proposed hosted checks.
  Standalone configs require observed stage resource identities.
  The user subsequently approved full bounded staging. Hosted execution is now in progress.
  The [stage setup receipt](evidence/2026-10-22/stage-setup.json) records the separate resources and observed versions.
  The first restore status refused hosted D1 bookkeeping before any initialization or upload.
  The vector copy exposed minute-scale eventual visibility; verified checkpoints remain distinct from acknowledgements.
  Production and Railway remain unchanged.
  The reproduced setup fixes pass 715 local tests in 69 files, all four compiler projects, runtime probes and five Worker builds.
  Linux release CI passes for commit `33c5a90df5fa76b3a64de8695161bdc06f251fa7`, run `39890354847`.
  The [fix receipt](evidence/2026-10-22/stage-fixes-validation.json) pins the tested source files.
- Hosted copy follow-up: The single-object text copy measured about 4.5 verified objects per second.
  An optional bounded binary transport keeps each object's immutable write and full readback.
  It permits 16 objects and 2 MiB per request, four network requests, and four object workers per request.
  Source-range acknowledgements preserve the existing journal's arrival-counter semantics.
  Local fault tests cover partial writes, lost replies, exact acknowledgements and replay from a paused checkpoint.
  Four concurrent maximum-size frames sampled 30,692,139 bytes of combined workerd heap/backing storage.
  This is a sampled local result, not a hosted memory maximum.
  The stage restore deployment retains the same eight isolated bindings and token.
  The vector verifier now checks at most four read-only groups at once before advancing a batch.
  A small exact-readback probe measured 1,647 ms serial and 602 ms at concurrency four.
  A transient host `ENOSPC` stopped a build and vector copy; all pending receipts survived.
  Disposable task installation caches were removed. Validation then passes 736 tests in 70 files,
  all four compiler projects, both runtime probes, all invariants and all five Worker builds.
  The [copy follow-up receipt](evidence/2026-10-22/stage-copy-fixes-validation.json) records source and log hashes.
  Both copies resume their existing journals; completed hosted audits remain pending.
  The first snapshot calendar attempt produced no observed event or Workflow instance.
  Its trigger was removed and independently checked. A controlled calendar retry uses the same deterministic instance ID.
  The approved JEV credential is prepared privately for stage reranking. No provider result is claimed.
- Release scope correction: Cloudflare is the v1 deployment target.
  The legacy Railway workflow and its credential requirement are removed from release CI.
  The default validation command no longer runs the optional legacy Railway graph check.
  Bun/Postgres portability remains available independently of Railway hosting.
  Existing Railway services have not been decommissioned; no Railway API apply occurred.
  Linux release CI passes for the copy-fix candidate `06f4c062cef6be0f9e95946005c2cef92f210678`, run `39892412999`.
- Hosted execution stop: Both copy monitors stopped their owned processes when
  local free space crossed the 1 GiB floor. Text has 21,332 verified objects and
  zero metadata pages; at most 64 objects in the last wave may need identical replay.
  Vectors have 79,200 verified source positions and 65,383 verified nonzero vectors.
  The vector journal retains 46 acknowledged batches and one uncertain batch.
  Checkpoints, source identities and pending receipts remain unchanged.
  Resume requires at least 5 GiB of stable local headroom and the existing guards.
  The user said they will free space; that reply does not establish available space.
  The snapshot calendar attempts at 02:45 and 03:25 UTC on 2026-10-23 produced no
  observed event or Workflow instance. This is not a completed hosted publication.
  Both schedules were removed and independently checked. The second cleanup also
  ran in memory so local disk failure could not prevent removal.
  The cause of the missing scheduled execution remains under investigation.
  No serving request or document embedding submission has been made.
  Linux release CI passes for the Cloudflare-only candidate
  `9cdcd745c0506eb1ad2f1bbc1a9cdd689406d05c`, run `39893197952`.
  The [stopped transfer receipt](evidence/2026-10-22/stage-transfer-stop-state.json)
  records exact checkpoints and remaining limits.
  The [snapshot receipt](evidence/2026-10-22/stage-snapshot.json) records both calendar
  windows, independent cleanup, empty instance reads and the trace-delivery limitation.
- Guarded resume: Five disk samples over two minutes all exceeded 5 GiB.
  The one permitted automatic resume used the same pinned inputs, targets and journals.
  Both copies continue with their 1 GiB stop guards. The text restore replayed 55
  remotely committed objects beyond its earlier local checkpoint. The vector copy
  drained 46 acknowledged batches and identically replayed one uncertain batch.
  The [resume receipt](evidence/2026-10-22/stage-transfer-resume-state.json) records a
  measured progress sample; full hosted copy/audit acceptance remains incomplete.
  A stage-only health and immutable event-receipt wrapper passes 19 focused checks,
  including actual local scheduled dispatch and Workflow publication/replay.
  The production snapshot entrypoint is unchanged. The full release gate passes
  755 tests in 72 files, all compiler projects, runtime probes and invariants.
  The isolated diagnostic config and dry-run build are checked; deployment is pending.
  The [diagnostic validation receipt](evidence/2026-10-22/stage-snapshot-probe-validation.json)
  records source hashes, local checks and request/storage bounds.
  No further calendar trigger, serving request or document embedding has run.
  Linux release CI passes for `3fc097a8056c90058e8dc3a524e97fde78e54715`, run `39896055623`.


- Diagnostic deployment: The isolated snapshot wrapper returned the exact health
  marker and a matching successful live fetch trace. The 05:00 UTC calendar was
  never armed: deadline preflight sent zero provider requests. Both original
  guards confirmed empty schedules and stopped. A 06:00 UTC candidate is local
  preparation only, pending real renewal and guard review. Hosted scheduled
  publication remains unverified. The [diagnostic state receipt](evidence/2026-10-22/stage-snapshot-probe-state.json)
  records these distinct outcomes. Linux CI passes for `c25dcc197a5272b825fad84d2befbc316b8d5eec`, run `39898743213`.
- Restore transport follow-up: Optional four-page metadata requests retain full
  prevalidation/readback and the original sequential atomic page transactions.
  Sixteen-checkpoint audit requests retain every existing eight-row check and CAS.
  A partial remote prefix replays from the local durable cursor before exact
  acknowledgements advance it. Calculated metadata/audit HTTP calls decrease
  from 26,051 to 6,513; row/text checks are unchanged. The full local gate passes
  766 tests in 73 files, all compiler projects, runtime probes, invariants and five
  Worker builds. The [validation receipt](evidence/2026-10-22/stage-metadata-audit-validation.json)
  records source hashes, full-bundle verification and sampled local memory.
  The reviewed Worker is deployed at version `d3d642b6-f598-4a4e-ab1c-d411d06c79a7`.
  Its eight bindings and runtime match the prior isolated deployment. The old
  client stopped before replacement; the new client retains the same source,
  plan, target and durable checkpoint. It replayed 63 uncertain objects before
  advancing. The [handoff receipt](evidence/2026-10-22/stage-restore-protocol-handoff.json)
  records initial progress beyond 80,000 objects. Full metadata publication and
  strict hosted audit remain incomplete. Linux release CI passes for
  `c93c8fa9955907db24233803a8261a30118dd239`, run `39900965703`.


- Vector baseline accepted: Every one of the 254,671 substantive vectors passed
  exact float32, ID, language, jurisdiction and fingerprint readback. All 277,857
  source positions are verified, including 23,186 zero placeholders. The durable
  journal is complete with no pending batches. An independent descriptor and
  count read confirms the original stage index identity, 768 dimensions, cosine
  metric and 254,671 vectors. The last visibility timeout and its readback-only
  recovery remain in the [completion receipt](evidence/2026-10-22/stage-vector-restore-complete.json).
  This proves equality with the pinned backup; it does not attest the legacy
  embedding model or replace the separate hosted quality and reconciliation gates.


- V1-08 exact-citation correction: A lower-ID preamble can share the real
  section's numeric label and win the old `LIMIT 1` lookup. Both storage adapters
  now prefer rows with the numbered-section URL that `buildRows` generates for
  actual sections. Selection occurs before the limit and text hydration. The
  real bilingual Canada Health Act section 8 rows pass regression checks on
  SQLite and PostgreSQL. Repealed sections, multiple canonical matches and
  noncanonical, amending, lettered or schedule fallbacks remain available.
  Unknown URL formats retain fallback ambiguity; numeric fallback may use one
  additional bounded query. No parser, corpus artifact, vector or semantic policy
  changed. The [validation receipt](evidence/2026-10-22/exact-citation-section-preference.json)
  records 21 new behavior checks and the complete passing gate: 787 tests in
  74 files, four compiler projects, runtime probes, invariants and five builds.
- Snapshot calendar: Actual OAuth renewal and fresh scoped deployment/source
  checks passed. The reviewed driver armed the single 06:00 UTC calendar and
  confirmed it at 05:12:16 UTC, with both same live guards still ready after the
  mutation. No scheduled trace, diagnostic receipt or Workflow instance appeared
  before the 06:05 UTC watchdog. Both guards removed the schedule and checked an
  empty calendar. A separate read confirmed the absent instance and receipts.
  The [outcome receipt](evidence/2026-10-22/stage-snapshot-0600-outcome.json)
  retains these observations without a provider root-cause claim. The
  [arming receipt](evidence/2026-10-22/stage-snapshot-0600-arming.json) does not
  establish dispatch, Workflow completion or hosted artifact parity.

- Hosted baseline and Workflow acceptance: The complete strict text audit passed
  all 277,857 rows and 250,978,206 bytes. An independent D1 read confirms legacy
  parser NULL, complete compact references, empty retained text and no pending
  vector mutations. The canonical snapshot Workflow completed all 127 steps.
  All 240 hosted artifacts match the frozen reference; local verification passes
  all 277,857 rows. Scheduled dispatch remains an unmet gate.
  See the [text receipt](evidence/2026-10-22/stage-text-restore-complete.json) and
  [artifact receipt](evidence/2026-10-22/stage-snapshot-artifact-parity.json).
- Hosted serving baseline: Only migration 0005 and synthetic fixtures were
  applied. All four test key hashes, capabilities, statuses and fuses passed
  independent private comparison. The isolated API's bindings and fresh empty
  usage namespace were checked before serving. All 14 baseline smokes passed,
  including exact English/French sections, HTTP auth refusals, MCP and actual
  encoder/vector/reranker/R2 execution. The ledger reserves 14 of 160 requests.
  The pipeline control persists the exact source tuple and cap 1,112 with zero
  submissions. Its single noon calendar was armed with both live cleanup guards.
  Reconciliation and measured retrieval quality remain incomplete. See the
  [baseline receipt](evidence/2026-10-22/stage-serving-baseline.json).

- Hosted reconciliation failure and safe stop: The noon scheduled invocation
  saved changes, then reported a Durable Object code-update reset. The exact
  triggering management operation is unproved. Recovery spent the entire
  1,112-document allowance while saving 600 expected changes. The remaining
  512 fingerprints do not match the target parser revision. The original
  coordinator is now durably suspended at revision 1 with no alarm, preserving
  its spent count, checkpoint, publication and completed outbox. No new run is
  published. See the [stop receipt](evidence/2026-10-22/stage-pipeline-budget-stop.json).
- Local recovery and backup preparation: Snapshot ingestion now commits each
  successful provider batch before submitting the next. A real SQLite failure
  regression proves committed rows survive a later provider failure and are
  skipped on restart. Coordinator controls validate persisted state, drain
  admitted work, preserve failure diagnostics and recover uncertain pause/resume
  acknowledgements. Actual workerd tests cover due alarms and reconstruction.
  The offline protected-state copier preserves covered identity/history rows and
  sequence high-water marks; remote acquisition/apply and text parity remain
  separate gates. The [complete local gate](evidence/2026-10-22/recovery-candidate-local-validation.json)
  passes 944 tests in 79 files, four compiler projects, runtime probes,
  invariants, 117 vendored files and five builds.
- Snapshot follow-up: The 13:00 candidate missed its arming margin and was never
  armed. Both guard sessions exited successfully after confirming schedules
  empty. No alternate calendar or second full publication was started.
- Local migration preparation: Explicit `AUTH_DB` keeps CHS keys and billing
  authoritative while `CIVIC_DB` changes during a corpus rollback. Ten new
  HTTP/MCP contracts cover revocation, capabilities, disabled/tightened billing,
  replacement keys, shared usage and explicit-store failure. The paused vector
  export client checks the original object/revision, complete suspension,
  index/part digests and response bounds, with exclusive durable local intents.
  Independent review found and fixed a journal-parent durability gap. The
  [final local gate](evidence/2026-10-22/rollback-backup-local-release-gate.json)
  passes 1,018 tests across 82 files, all four compiler projects, runtime probes,
  invariants, 117 vendored files and five dry-run builds. No deployed auth
  binding or production backup is established by these local checks.
- Approved staging recovery: The exact preserved-counter extension was approved
  and initialized on the original coordinator. Its first explicit resume reported
  192 changed rows before pausing on an unknown failure. Counters retain all
  1,304 cumulative attempts and six extension calls. There is no alarm or automatic
  contingency resume. The [attempt receipt](evidence/2026-10-22/stage-recovery-approved-attempt-1.json)
  retains the original failed bound and the incomplete recovered result.
  Subsequent [independent paused reads](evidence/2026-10-22/stage-recovery-progress-1.json)
  verify 792 target fingerprints and matching feed/mutation identities, with 320
  remaining and no pending outbox. The [stop-only diagnostic](evidence/2026-10-22/stage-recovery-source-403.json)
  preserves the same counters and identifies the saved source-head HTTP 403 by
  exact error hash. It does not establish the refusal reason or completed ingestion.

- Source-head reliability: the candidate now requests one commit-list metadata
  item, with a total deadline, streamed size bound and safe persisted HTTP/quota
  diagnostics. It follows no redirects and performs no retry. Independent review
  clears the head-only change. The [new full local gate](evidence/2026-10-22/source-head-local-validation.json)
  passes 1,070 tests in 83 files, all four compiler projects, runtime/vendor checks
  and five builds. The optional corpus checker paths absent from this checkout
  are recorded as skips. Existing hosted bundles remain unchanged by this fix.

- Protected-copy format: the offline copier now shares its fixed table/column,
  scalar and format-1 page codec with a Worker-safe module. All original golden
  page hashes remain unchanged, including Unicode and exact 64 KiB boundaries.
  The focused 52-test check includes actual local workerd without Node
  compatibility. This prepares the D1 binding implementation; it does not
  implement a hosted protected-data copy or establish production-backup consistency.
  See the [format validation](evidence/2026-10-22/protected-state-format-validation.json).

- Protected D1 copy: a fixed-table binding helper now checks the matching complete
  compact-restore receipt, actual corpus metadata and text references, and a fresh
  full R2 audit before protected inserts. Page receipts, row inserts, publication
  and sequence guards share a D1 batch; exact replay is read-only. The 81 focused
  tests include 29 synthetic local D1/R2 cases for rollback, competing pages,
  tampering and original sequence highwaters. This completes the local binding
  slice, with no hosted route, production acquisition or deployment. See the
  [binding interface and limits](PROTECTED-D1-BINDING.md) and
  [validation receipt](evidence/2026-10-23/protected-state-d1-root-validation.json).

Small evidence files live in [evidence/2026-10-22](evidence/2026-10-22/).
The large local artifacts remain outside Git. The commands can reproduce them from pinned source.

## Remaining release gates

1. Finish the authenticated source-access remedy, complete ingestion within the approved cumulative limits, then verify text bytes, vector visibility and the resulting backup.
2. Verify scheduled snapshot discovery/publication. The manually recovered hosted Workflow and complete artifact parity already pass.
3. Run post-reconciliation flows, fresh calibration, held-out retrieval, and bounded performance checks against the coherent serving target; verify positive BYOK generation with an approved provider key.
4. Check text migration and the protected-table copy against a consistent production backup. The D1 binding helper is locally verified, including actual target metadata/references, compact markers and fresh R2 bytes. Production acquisition and authenticated hosted application remain pending.
5. Finish the migration/deploy/rollback candidate and item-by-item release audit before requesting required production approval.

See [V1-OPERATIONS.md](V1-OPERATIONS.md) and [V1-EVALUATION.md](V1-EVALUATION.md) for procedures.
