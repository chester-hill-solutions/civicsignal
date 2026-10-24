# CivicSignal v1 release plan

This is the execution checklist for the v1 goal started on 2026-10-22. It reconciles
the code audit, the CHS package review, `docs/PLAN.md`, and section 9 of
`~/.civicsignal/HANDOFF.md`. The checklist records verified outcomes, not intentions.
Cloudflare is the only v1 deployment target. Keep the existing Vectorize index and vectors.
Existing Railway services are outside this release. Preserve unrelated work and the Bun/Postgres portability code.

Current hosted status: baseline restore, snapshot Workflow artifact parity and
21 serving smokes pass, including seven checks after reconciliation. The dedicated, expiring public-read-only GitHub token was
created through the browser. Its sole binding PUT remains unacknowledged; an
independent five-GET readback established its name/type and deployment identity.
The authenticated source probe then passed at 22:28:24 UTC on October 23:
HTTP 200, the approved source commit/date and reported quota 4,999/5,000.
No second secret PUT occurred.

The approved recovery resumed once and completed its monitor at 22:34:18 UTC.
The original coordinator is suspended and drained at revision 5. It retains
1,624 cumulative document attempts and 16 extension calls, leaving 128 attempts
and four calls under the unchanged 1,752/20 limits.

The independent final metadata proof passed at **23:27:06 UTC**: all **277,857
rows**, **1,112 target changes**, **276,745 unchanged rows**, exact feed/mutation
identities and an empty pending outbox. It made 2,237 bounded read requests with
zero query writes. The revision is published as `statutes-v2` at the approved
source commit/date. The 84-request changed-text proof then passed: **74 unique
objects / 24,836 bytes** cover all 1,112 changed references. Unchanged references
use current full metadata parity and the earlier full baseline byte proof; this
is a composite proof, not a fresh whole-store byte audit. A fresh five-GET read
and independent proof publication passed at 23:28 UTC. The bounded vector backup
completed at **00:25:45 UTC on October 24**: **277,857 vector positions**, including
**254,671 substantive vectors** and **23,186 placeholders**, in an **853,576,720-byte**
verified store. Export, manifest read and part downloads used **60 cumulative
requests**. An initial manifest-byte comparison failed because JSON property order
differed; the failed run remains preserved. A separately reviewed download-only
continuation verified semantic equality, durably retained the exact remote manifest,
and downloaded the existing 28 immutable parts. It did not repeat export or model work.
Legacy vector model provenance remains unattested.

The updated staging API passed deployment/binding verification at **00:27:57 UTC**.
Its `AUTH_DB` alias uses the same staging D1, strict R2 reads remain enabled, and
the original usage namespace is preserved. Post-reconciliation checks passed for
increasing change-feed pages, cold retrieval, warm cache reuse without another
encoder/vector/reranker query, French cache isolation, and the original exhausted
HTTP/MCP quota. The 20 fresh calibration queries then completed without request or
provider errors: Hit@1/5/10 is **11/12**, with **0/8** unsupported false accepts.
No threshold or serving policy was changed. The held-out run completed at
**00:42:23 UTC** with **63/64** valid responses: Hit@1 **35/48**, Hit@5/10
**40/48**, **3/48** false refusals and five accepted answerable queries without
their gold provision. English Hit@5 is **21/24** and French **19/24**; both
languages succeed for **18/24** provision pairs. Of 15 completed unsupported
queries, one was accepted. The remaining unsupported query returned an
encoder-related 502 and is an error, not a correct refusal. This run exited
unsuccessfully and remains release-blocking evidence; it was not retried or
used to change policy. The planned benchmark also exited unsuccessfully: serial
measurement completed **19/20** requests with one row-hydration 502; each concurrency
level lost one of two warm-ups. Concurrency four completed **20/20** measured
requests from cache. Completed client p95 was **4.602 s** serial and **1.924 s**
at concurrency four, with different cache populations; these are bounded staging
observations, not production capacity. The original approved 128-token Zen attempt
failed acceptance at reservation 153. Its generic receipt cannot distinguish
provider failure from response/citation mismatch; that attempt and its clean
153-reservation relay shutdown remain preserved in the
[original retrieval/generation receipt](evidence/2026-10-23/staging-retrieval-generation-root-validation.json).

A separately user-approved, one-request diagnostic then consumed reservation
**154/160** at **01:18:50 UTC**, with the same 128-token cap and original ledger.
It returned staging **HTTP 502 / `UPSTREAM_UNAVAILABLE`**, correlation
`req_mvlpnc3f3csiit1oeq`, and failed acceptance without retry. The response does not
establish whether Zen was called, the key was valid, or which upstream stage
failed. No raw body, answer or key-derived hash is retained in the public receipt.
The restarted relay's owner timed out with cleanup uncertainty; a separate check
at **01:24:41 UTC** found its PID and listener absent. That later observation does
not qualify or rewrite the uncertain owner result. At that point the ledger was
**154/160**, with six unspent reservations and no reset. See the
[diagnostic and shutdown evidence](evidence/2026-10-23/opencode-zen-diagnostic-v2-root-observation.json).

See the [completed metadata/text validation](evidence/2026-10-23/staging-completed-metadata-text-root-validation.json),
[source/recovery validation](evidence/2026-10-23/staging-source-recovery-root-validation.json)
and [binding recovery record](V1-STAGING-BINDING-RECOVERY.md). The
[backup/API/smoke receipt](evidence/2026-10-23/staging-vector-backup-api-smokes-root-validation.json)
records the completed gates and their limitations.
The separately armed **01:40 UTC** staging Cron experiment finished its guarded
window with both independent cleanup pairs passing at **01:45 UTC**. The final
seven-request read passed at **01:45:38 UTC**, returning no scheduled rows and
HTTP 404 for the entered, completed and failed event objects. Its historical
health control showed one success and zero errors; the calendar was empty and
the prior API-created Workflow and manifest were unchanged. Scheduled discovery
and publication remain unverified. These absences do not establish non-dispatch
or a platform cause. The reader made no source/model/serving calls; the runtime
ceiling was one possible source call, whose actual execution is unattested. See
the [new Cron outcome](evidence/2026-10-23/staging-cron-0140-root-observation.json).
Retrieval acceptance and production migration remain pending. Production and
Railway are unchanged.

The provider-boundary and cache-error diagnostics are now deployed to staging.
At **03:28:25 UTC on October 24**, version
`f512cf84-fbcc-4990-bad0-13cdc0678c71` passed independent postverification of
the same 13 bindings, runtime, original usage namespace and empty schedule.
The frozen API source is `f4960c3`; the newer protected-copy tools are in
`638303a`. Deployment used one CLI invocation and eight explicit management
proof GETs; the CLI's internal protocol calls are not included in that count.
It used no serving or generation reservation; the ledger was then **154/160**.
A token response with a valid 3,599-second lifetime exposed an overly strict
3,600-second minimum in the local renewal validator. That failed attempt is
preserved. A separately reviewed local recovery persisted the retained reply,
with the original 28 scopes, without another token request. See the
[staging deployment receipt](evidence/2026-10-24/staging-api-v5-root-observation.json).
At **03:44 UTC**, the retrieval-only probe consumed reservations **155 and 156**.
The exact original Zen topic returned HTTP 200 and the expected Canada Health
Act section 8 citation without inference. The calibration query also returned
HTTP 200, but reranking failed and the existing vector fallback placed its gold
provision sixth. The probe stopped there: no warm third request or KV wait ran.
Its child and owner settled and the ledger closed. After that probe the ledger
retained **156/160**, four unspent, with its original prefix preserved. Failure
phase/status, Zen key validity and positive chat acceptance remain unknown.
This is diagnosis, not new quality acceptance. See the
[retrieval probe receipt](evidence/2026-10-24/staging-api-v5-retrieval-root-observation.json).

The subsequent diagnostics-only staging version
`e33f3256-b9be-43c9-a5e3-d7d0bc1451b9` passed the same binding/runtime/usage/calendar
checks. Its single fresh calibration query captured a reranker `transport`
failure without an upstream HTTP status; fallback again placed the gold sixth.
After that diagnosis the ledger was **157/160**, three unspent, and closed cleanly.
Local workerd reproduction identifies an unsupported `redirect: "error"` option
in the shared provider wrapper before outbound I/O. See the
[deployment](evidence/2026-10-24/staging-api-v6-root-observation.json) and
[fresh diagnostic](evidence/2026-10-24/staging-api-v6-reranker-diagnosis-root-observation.json).

That compatibility defect is repaired in source `78e0c2f`, deployed as staging
version `3efd1935-39ea-41da-b19c-e8bbf495b50d`. `manual` mode preserves redirect
refusal without credential forwarding. The native runtime regressions and full
local/Linux release checks pass **1,566 tests in 93 files**; Linux also passes
**23 Python cases**. Same-binding postverification passed at **04:20:11 UTC**.
The calibration cold/warm pair at **158/159** then passed: all providers succeeded
cold, the expected provision ranked first, and warm reused identical result and
score provenance without inference. Worker retrieval elapsed times were
**2,301 / 1,450 ms**, not a capacity benchmark. The original ledger is closed at
**159/160**, one unspent. Positive Zen generation and broad held-out acceptance
remain open; no new generation call is approved. See the
[repair](evidence/2026-10-24/provider-redirect-root-validation.json),
[CI](evidence/2026-10-24/provider-redirect-linux-ci.json),
[deployment](evidence/2026-10-24/staging-api-v7-root-observation.json) and
[cold/warm result](evidence/2026-10-24/staging-api-v7-calibration-recheck-root-observation.json).

## Release requirements

| ID | Outcome | Acceptance evidence | Status |
| --- | --- | --- | --- |
| V1-01 | One CHS identity and metering path for HTTP and MCP | Existing key hashes, customer IDs and counter identities survive migration; revoked/missing keys fail; capabilities apply; each successful retrieval consumes one confirmed unit; retrieval failures and protocol bookkeeping consume none; unresolved post-commit acknowledgements return an explicit uncertain 503 with operation ID for reconciliation | Local checks pass; hosted migration pending |
| V1-02 | Reproducible package installation and builds | Fresh tracked checkout installs with the frozen lockfile and imports every vendored export; package provenance recorded; Worker dry-run builds | Complete locally |
| V1-03 | Retrieval and BYOK correctness | Language and decision versions isolate cache entries; warm hits avoid reranking; input bounds, Google credentials and browser CORS pass regression tests | Complete locally |
| V1-04 | Recoverable ingestion | Injected faults between row/vector/feed/state writes recover without missing changes or duplicate events; Postgres transactions and D1 recovery cover the same contract | Full hosted metadata, composite changed-text proof and complete vector backup pass |
| V1-05 | Automated immutable snapshots | Cloudflare Workflow creates bounded row parts and sorted index partitions per revision, publishes only complete manifests, and resumes after failure | Full local and hosted Workflow parity passes; scheduled discovery and first publication remain unverified |
| V1-06 | Verified restore and corpus-text migration | Manifest/index/fingerprint integrity is enforced; backup and rollback exist; old/new reads and complete non-empty ingestion agree before live cutover | Full local and stage baseline audit passes; production cutover pending |
| V1-07 | Broad, measured retrieval quality | Held-out English/French answerable and unsupported cases; backend-specific acceptance calibration; reported false acceptance/rejection and end-to-end latency/throughput/freshness | Calibration collected; holdout measured with misses, false accept and one encoder error; acceptance unresolved |
| V1-08 | Honest, complete v1 surfaces | Every advertised route/tool is usable; unavailable corpora and geography are explicit; change-feed and exact citation flows are verified | Local routes and 21 hosted smokes pass; both bounded Zen attempts failed acceptance |
| V1-09 | Complete engineering gates | Worker, Bun and scripts type-check; endpoint and recovery tests pass; CI validates clean checkouts and builds without production credentials | Local and Linux release gates pass |
| V1-10 | Reviewable release candidate | Current runbook, migration/restore/deploy/rollback commands, verified limitations, and item-by-item completion audit; required final approvals occur after preparation | Draft candidate; production acquisition, hosted acceptance and final audit pending |

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

## Current closure crosswalk — 2026-10-24

This crosswalk separates completed implementation from remaining release evidence.
It does not supersede the failed observations or authorize another hosted operation.
The deployed API source is `78e0c2f`; later documentation commits do not imply a
different deployed bundle. The original serving ledger remains **159/160**.

| Requirement | Completed evidence to preserve | Remaining release work |
| --- | --- | --- |
| V1-01 | CHS auth/auth-d1/api-billing integration, shared HTTP/MCP metering, key lifecycle and quota tests; local full protected-copy client and owned operator | Establish actual production auth authority and a common maintenance interval; acquire a consistent backup; prove hosted identity/history preservation before switching bindings. See [acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md). |
| V1-02 | Frozen clean-checkout installation, vendored exports and provenance, Worker/Bun/scripts compilation and five dry builds in [Linux CI](evidence/2026-10-24/provider-redirect-linux-ci.json) | Preserve these checks on the final source candidate. |
| V1-03 | Cache language/decision isolation, no reranking on a warm hit, input limits, Google authentication and browser CORS regressions; native provider redirect repair and [hosted cold/warm recheck](evidence/2026-10-24/staging-api-v7-calibration-recheck-root-observation.json) | Positive OpenCode Zen generation remains unverified. The sealed one-request proposal needs separate approval; the two earlier generation attempts are spent. |
| V1-04 | Completed non-empty reconciliation, all 277,857 metadata rows, 1,112 changed targets, empty outbox, composite changed-text verification and complete vector backup | Preserve the paused original coordinator and cumulative usage; no recovery replay is required for this completed gate. Legacy vector model provenance remains an explicit limitation. |
| V1-05 | Manual hosted Workflow: 127 steps and byte parity for all 240 artifacts / 390,423,509 bytes | Qualify actual scheduled discovery and first publication. The existing-publication probe cannot establish first publication. See [qualification review](V1-SCHEDULED-PUBLICATION-REVIEW.md). |
| V1-06 | Full staging baseline restore, strict text audit, manifest/index/fingerprint enforcement, complete vector backup and local protected-copy schema/sequence admission | Qualify production acquisition, isolated hosted protected copy, the production target adapter and the eventual migration/rollback. Staging rows cannot prove original production schema. |
| V1-07 | Calibration, held-out bilingual results and bounded latency/cache observations are retained in [evaluation evidence](V1-EVALUATION.md) | Investigate held-out misses, false acceptance and provider/hydration errors; prepare new acceptance/performance validation within separately approved usage. A successful single calibration pair does not replace the failed holdout or benchmark. |
| V1-08 | Explicit scope exclusions, HTTP/MCP discovery, exact citations, change-feed paging and 21 hosted smokes | Close positive BYOK chat acceptance; repeat affected advertised-route checks on the final candidate if its source or bindings change. |
| V1-09 | 1,566 tests in 93 files, 23 Linux Python cases, runtime regressions, expanded compilers, invariant checks and dry builds | Keep source-specific receipts and rerun required gates after substantive changes. Preserve the earlier local log-cap failure and its uncertainty rather than rewriting it as a pass. |
| V1-10 | Current operations, restore/copy tools, scope dispositions and draft PR #1 | Complete the four remaining gates below, reconcile the exact release source/bindings and obtain any required final production approval after the concrete switch/rollback candidate is reviewable. |

The held-out runner fails on request errors or missing responses; it does not
enforce a numeric Hit@5 or false-acceptance release threshold. The observed
40/48 Hit@5 and one false acceptance among 15 completed unsupported queries are
quality findings, not an implemented automatic acceptance rule. The benchmark
runner does reject incomplete measurements or failed warm-ups. Neither historical
run becomes accepted because the later calibration pair passed. Do not choose
thresholds by tuning on those held-out answers.

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

- Protected-copy staging transport: fixed HTTP routes now require the original
  restore bearer/resource/plan/session guards plus server-pinned protected
  manifest and admission hashes. Bounded request parsing, safe status output,
  lost-response replay and text-version checks pass 119 focused tests, including
  49 protected-D1 checks. The default configuration keeps these routes disabled.
  The initial and full-phase clients now have 171 focused local checks. Both
  seal inputs before credentials and durably journal bounded windows. Explicit
  `--full-phases` uses a distinct plan and completes text/load/verify/final scan/finish;
  independent review clears 39 new full-flow cases. The single-window process
  operator passes 21 Python regressions and four bundled Bun/workerd fixtures.
  Review found and fixed acceptance-file persistence uncertainty before release.
  Actual hosted copy and consistent production acquisition remain pending; this does not
  enable a production target. See the
  [full-client validation](evidence/2026-10-23/protected-state-full-client-root-validation.json). See the
  [transport validation](evidence/2026-10-23/protected-state-http-root-validation.json).

- OpenCode Zen: the explicit `opencode-zen` adapter supports the reviewed
  `claude-haiku-4-5` Messages model, reusing the Anthropic protocol. A fixed
  endpoint, total generation deadline, body bound and no redirects/retries
  preserve one provider call. All 88 focused checks and Worker/tooling compilers
  pass. Independent review reproduced and fixed late-response cleanup and
  parsing-deadline gaps before the staging bundle was frozen. The user approved
  one positive hosted check capped at 128 output tokens. That attempt failed at
  reservation 153; the separately approved diagnostic at 154 returned staging
  HTTP 502 and also failed acceptance. Hosted generation remains unverified. See the
  [Zen validation](evidence/2026-10-23/opencode-zen-root-validation.json).
  The [later diagnostic receipt](evidence/2026-10-23/opencode-zen-diagnostic-v2-root-observation.json)
  preserves both attempts' distinct evidence and the relay-owner uncertainty.
  The expanded Bun compiler check then found that its reader interface also
  requires `readMany`. A structural type for the three methods used fixes this
  without changing the compiled Worker bytes. All four compiler projects now
  pass; the new staging candidate preserves the earlier bundle exactly.
  See the [Bun compatibility validation](evidence/2026-10-23/opencode-zen-bun-compatibility-root-validation.json).

- Fresh local release gate: 1,233 tests in 86 files, all four compiler projects,
  117 vendored files, both real workerd runtime probes, billing/corpus invariants
  and all five Worker dry-run builds pass. The separate owned-process Python
  suite passes 21 cases and is now a Linux CI step. Historical corpus invariant
  artifacts remain explicitly skipped when absent; hosted corpus proofs are
  separate. Clean Linux CI then passes on `57a3222`, including the portable
  Python fixtures, frozen install and all builds. See the
  [local release validation](evidence/2026-10-23/release-local-gates-post-recovery.json)
  and [Linux CI receipt](evidence/2026-10-23/release-linux-ci-57a3222.json).

- Historical Cron observation: six bounded read-only requests returned the
  known health scope control, no scheduled rows, no diagnostic objects, and
  the unchanged API-created Workflow/manifest. This does not establish a
  Cloudflare cause or scheduled publication. The Cron gate stays open. See the
  [observation and limits](evidence/2026-10-23/staging-cron-historical-root-observation.json).

- October 24 claimed Cron experiment: immutable staging runtime
  `f00194fb-5062-4b0a-930b-b2aa12ded3f5` passed empty-calendar deployment and exact
  binding/runtime postverify before the single 01:40 event. Arming was confirmed
  at 01:05:21 UTC. Primary made 20 R2 observations, then both independent guards
  completed unconditional T+5 `PUT[]`/`GET[]` cleanup with settled success.
  The final seven-request observation returned zero scheduled rows and three
  absent event receipts, with the health control and prior API publication
  intact. Empty-calendar confirmations are point-in-time evidence; the Cron
  gate remains open without an inferred platform cause or source-call count.
  See the [actual outcome](evidence/2026-10-23/staging-cron-0140-root-observation.json).

- Fresh local gate on October 24: **1,276 tests in 88 files**, 21 owned-process
  Python cases, four compilers, 117 vendor files, two real runtime probes,
  invariants and five Worker dry-run builds pass with stable source hashes.
  The isolated test/build environment received no cloud/provider credentials.
  This covers the claimed staging snapshot probe and synthetic protected-copy
  preparer; it does not turn failed hosted retrieval/generation into acceptance.
  See the [gate receipt](evidence/2026-10-23/release-local-gates-20261024.json).

- Retained failure diagnostics: selecting a cached answer now records a cache hit
  before D1/R2 hydration, including a later hydration failure. Missing rows still
  use the existing stale-entry search path; failed hydration invents no cached
  score. Benchmark reports retain provenance-checked warm-up observations and
  correlation IDs with the same request count. All 54 focused checks, three
  affected compiler projects and the API dry-run build pass. This source is
  undeployed; the earlier hosted reports remain unchanged. See the
  [observability validation](evidence/2026-10-23/retrieval-observability-root-validation.json).

- Earlier clean Linux CI: the pull-request merge candidate including exact head
  `520c102da791795de7b03577f46c42dfb65cb886` passes **1,281 tests in 89 files**,
  21 Python cases, all four compilers, 117 vendor files, two real runtime probes,
  invariants and five Worker dry-run builds. GitHub tested merge `4bce33c`, which
  includes that head and base `717bf329`; this is not a detached-head checkout
  claim. The newer API diagnostics source is undeployed and does not change the
  failed hosted results. See the
  [CI successor receipt](evidence/2026-10-23/release-linux-ci-520c102.json) and
  [successful run](https://github.com/chester-hill-solutions/civicsignal/actions/runs/40048032415).

- Offline original-sequence bridge: **94 focused tests**, including actual local
  workerd, tooling TypeScript and independent peer review pass. The bridge
  preserves original highwaters from separate pinned evidence and refuses
  conflicting qualified sequence writes. The original strict importer remains
  unchanged. This local result does not qualify production acquisition, global
  quiescence or hosted protected copy. See the
  [bridge validation](evidence/2026-10-23/protected-original-sequence-bridge-root-validation.json).

- V1-03 / V1-07 / V1-08 / V1-09, provider-boundary follow-up at **02:26 UTC on
  October 24**: all four BYOK providers now use one 30-second / 256 KiB exchange
  with no redirects, retries or fallback. Empty, malformed and key-echoing answers
  fail before usage is consumed. Optional generation metadata preserves the
  observed status and safe failure phase while retaining the existing HTTP 502
  contract; retrieval errors do not imply generation was attempted. Jev now
  requires every requested typed, finite probability in [0,1] and uses a
  15-second / 256 KiB response / 1 MiB request boundary. Invalid responses take
  the existing fallback. Its prompt, model, decision rule and thresholds are
  unchanged. Only Jev-enabled cache identities change, preventing old permissive
  responses from bypassing validation. Root and independent peer reviews pass.
  The stable source passes **1,492 tests in 92 files**, **21 Python cases**, all
  four compilers, 117 vendor files, two actual local workerd probes, invariants
  and five Worker dry-run builds. All **433 source pins** match before and after.
  Earlier red regressions, a timing-fixture failure and the first full run's
  obsolete parser assertion remain recorded; the corrected run uses separate
  settled receipts. This source is **not deployed**, adds **zero hosted requests**
  and does not explain the historical failures or close hosted acceptance.
  Ledger use remains **154/160**. See the
  [source, regression and full-gate receipt](evidence/2026-10-24/provider-boundary-root-validation.json).

- Earlier completed Linux CI includes exact provider-repair head
  `f4960c373efd54423000ceb743071a935f679782` in merge `f85982c562f637e8fb23d8814c1aea9403868897`:
  **1,492 tests in 92 files**, 21 Python cases, all four compilers, 117 vendor
  files, two actual local runtime probes, invariants, frozen installation and
  all five dry builds pass in [run 40054293590](https://github.com/chester-hill-solutions/civicsignal/actions/runs/40054293590).
  This CI result predates the source-schema repair below.

- V1-04 / protected-copy source admission at **03:11 UTC on October 24**:
  preparation now checks complete declared schemas against pinned, coherent
  public migration prefixes 0003–0008, rejecting unsupported or mixed schemas
  before plan output. Every new executable plan requires a private schema
  sidecar linked to the sealed source and manifest; its SHA is bound to the
  owned D1 plan and checked before credentials are selected. The strict SQL
  importer permits only the internal reindex callback for the exact index
  being created. Standalone `REINDEX` remains forbidden. Format-1 manifests and
  hosted wire data are unchanged; historical receiptless plans cannot execute
  through the new client. Root validation passes **1,537 tests in 92 files**,
  **23 Python cases**, all four compilers, 117 vendor files, two actual local
  workerd probes, invariants and all five dry builds, with **435 source pins**
  unchanged. Independent review passes. Production schema classification,
  authenticated acquisition, common freeze and hosted copy remain open. See the
  [schema validation](evidence/2026-10-24/protected-source-schema-root-validation.json).

- Latest completed Linux CI includes exact schema-repair head
  `638303af586658a2cf00f0ffbceea3456c5ba18f` in generated PR merge
  `dfd7c3b8c2554c78cd10e69d922995c791fc2521`. The clean frozen installation,
  **1,537 tests in 92 files**, **23 Python cases**, all four compilers, 117
  vendor files, two local runtime probes, invariants and all five dry builds
  pass. See [run 40057475781](https://github.com/chester-hill-solutions/civicsignal/actions/runs/40057475781)
  and the [root CI observation](evidence/2026-10-24/protected-source-schema-linux-ci.json).

- Reranker failure observations in source `07587e4` preserve only fixed phase,
  observed status and coarse bounded validation counts. Independent review,
  167 focused regressions, **1,561 tests in 92 files**, all compiler/vendor/runtime
  and invariant checks, and five dry builds pass. The original local Python
  aggregate failed one capture log-cap test; its cause remains unknown. A
  separately retained instrumented qualification passed all **23** unchanged
  cases and bounds. Clean Linux CI independently passes **1,561/92** and **23**
  Python cases on merge `c46d0de4aed9722fd0b93a7a7b0d2005f2fe3d06` in
  [run 40060555944](https://github.com/chester-hill-solutions/civicsignal/actions/runs/40060555944).
  These checks did not exercise the newly reproduced native provider redirect
  defect. See [local qualification](evidence/2026-10-24/jev-diagnostics-root-validation.json)
  and [CI evidence](evidence/2026-10-24/jev-diagnostics-linux-ci.json).

Small evidence files live in the dated `docs/evidence/` directories.
The large local artifacts remain outside Git. The commands can reproduce them from pinned source.

The recovery, full metadata, composite changed-text byte verification and complete
vector backup gate is closed within the approved limits. Preserve the original
paused coordinator and backup evidence.

## Remaining release gates

1. Verify scheduled snapshot discovery and first publication. The manually recovered hosted Workflow and complete artifact parity already pass. The claimed probe requires an already published revision; its existing-publication no-op cannot establish scheduled first publication.
2. Investigate the retained retrieval/scope/provider/hydration failures and both failed Zen attempts. Post-reconciliation flows pass; calibration, holdout and benchmark attempts are complete, with acceptance unresolved. Do not silently retry, tune on holdout, or extend the approved generation/request limits.
3. Check text migration and the protected-table copy against a consistent production backup. The D1 binding helper, staging-only HTTP adapter, initial/full-phase client and single-window process operator are locally verified. Consistent production acquisition, actual hosted application and a separately reviewed production target adapter remain pending. The [production acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md) and [binding metadata receipt](evidence/2026-10-23/production-binding-metadata-root-validation.json) record preparation and remaining acquisition limits.
4. Finish the migration/deploy/rollback candidate and item-by-item release audit before requesting required production approval.

See [V1-OPERATIONS.md](V1-OPERATIONS.md) and [V1-EVALUATION.md](V1-EVALUATION.md) for procedures.
