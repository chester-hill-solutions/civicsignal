# CivicSignal v1 release evidence ledger

The [master plan](PLAN.md) defines scope, priorities, dependencies, and next steps.
This ledger retains the ten requirement checks and dated evidence for the v1 goal started on 2026-10-22.
Its historical work order and progress entries do not create a separate roadmap.

The original checklist reconciles
the code audit, the CHS package review, `docs/PLAN-HISTORY.md`, and section 9 of
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

The subsequent local snapshot increment adds isolated first-publication
qualification and repairs a reproduced partial-archive publication defect in
the shared canonical path. It also adds the fixture-only KV/export/KV acquisition
core; no live production reader or maintenance control is enabled. Full local
checks pass **1,689 tests in 97 files**, 23 Python cases, all four compiler
projects and five Worker dry builds, with 448 unchanged source inputs. See the
[root validation](evidence/2026-10-24/snapshot-acquisition-local-root-validation.json).
These changes are not deployed. Hosted Cron proof, complete-corpus qualification,
safe failure diagnostics/operator preparation and actual production acquisition
remain pending; the original serving ledger remains 159/160. The prior
[documentation-only Linux CI](evidence/2026-10-24/release-closure-linux-ci.json)
passed on `9e2fe17`; it does not qualify this newer source.

## Release requirements

The status column distinguishes retained results from qualification of the newer working tree.
Use the dated entries below for source-specific outcomes.

| ID | Outcome | Acceptance evidence | Status |
| --- | --- | --- | --- |
| V1-01 | One CHS identity and metering path for HTTP and MCP | Existing key hashes, customer IDs and counter identities survive migration; revoked/missing keys fail; capabilities apply; each successful retrieval consumes one confirmed unit; retrieval failures and protocol bookkeeping consume none; unresolved post-commit acknowledgements return an explicit uncertain 503 with operation ID for reconciliation | Local counter, receipt, and pre-generation admission checks pass. Hosted migration remains open. |
| V1-02 | Reproducible package installation and builds | Fresh tracked checkout installs with the frozen lockfile and imports every vendored export; package provenance recorded; Worker dry-run builds | Clean Linux install, package checks, and dry-run builds pass for `3f16f93`. |
| V1-03 | Retrieval and BYOK correctness | Language and decision versions isolate cache entries. Warm hits avoid reranking. Search survives a cache fault. Chat checks input and citation links and admits provider work within the hard limit. Check input bounds, Google credentials, and browser CORS. | Search, cache, and concurrent BYOK admission regressions pass locally. Hosted acceptance remains open. |
| V1-04 | Recoverable ingestion | Injected faults between row, vector, feed, and state writes recover with complete change history and unique events. Serving reads a coherent revision or reports unavailability during the transition. | Local publication, interrupted serving, and watermark retry checks pass. Hosted vector visibility and coherent serving remain open for this candidate. |
| V1-05 | Automated immutable snapshots | Cloudflare Workflow creates bounded row parts and sorted index partitions per revision, publishes only complete manifests, and resumes after failure | Earlier manual hosted parity and local native qualification pass. The exact-reference verifier passes locally. Hosted scheduled discovery and first publication remain open. |
| V1-06 | Verified restore and corpus-text migration | Manifest/index/fingerprint integrity is enforced; backup and rollback exist; old/new reads and complete non-empty ingestion agree before live cutover | Full local and stage baseline audit passes; production cutover pending |
| V1-07 | Broad, measured retrieval quality | Test held-out English and French answerable and unsupported cases. Calibrate the Cloudflare serving backend and report false accepts, false refusals, latency, throughput, and freshness. | Vector fallback and repaired hybrid failed D-01 on their recorded staging targets. The hybrid run stopped before the benchmark. [November comparison](#november-24-code-assessment-reconciliation) |
| V1-08 | Honest, complete v1 surfaces | Every advertised route and tool works and states coverage limits. Check change-feed and exact citation flows. Verify every factual claim in the predeclared chat cases under D-02. | A positive DeepSeek Zen smoke passed on an earlier staging version. Candidate-specific route checks and the independent D-02 claim review remain open. [Zen receipt](#november-23-staging-deepseek-zen-recovery) · [D-02 packet](#november-23-d-02-offline-packet) |
| V1-09 | Complete engineering gates | Worker, Bun and scripts type-check; endpoint and recovery tests pass; CI validates clean checkouts and builds without production credentials | The complete clean Linux gate and affected local checks pass for `3f16f93`. |
| V1-10 | Reviewable release candidate | Current runbook, migration/restore/deploy/rollback commands, verified limitations, and item-by-item completion audit; required final approvals occur after preparation | Draft candidate; production acquisition, hosted acceptance and final audit pending |

## Original work order — 2026-10-22

This list retains the initial sequence. Use the [master work order](PLAN.md#immediate-work-order) for current work.

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

## Recorded scope decisions

This table retains the v1 decisions behind the evidence checklist.
The [master plan](PLAN.md#current-release-scope) owns current scope and future phases.

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

The old plans remain as history. Their opening notices link to the master plan.
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
| V1-05 | Manual hosted Workflow: 127 steps and byte parity for all 240 artifacts / 390,423,509 bytes; isolated native first-publication/restart qualification and shared partial-archive rejection now pass | Prepare the remaining diagnostics/operator and qualify actual hosted scheduled discovery and first publication against the complete corpus. The older existing-publication probe cannot establish first publication. See [qualification review](V1-SCHEDULED-PUBLICATION-REVIEW.md). |
| V1-06 | Full staging baseline restore, strict text audit, manifest/index/fingerprint enforcement, complete vector backup and local protected-copy schema/sequence admission | Qualify production acquisition, isolated hosted protected copy, the production target adapter and the eventual migration/rollback. Staging rows cannot prove original production schema. |
| V1-07 | Calibration, held-out bilingual results and bounded latency/cache observations are retained in [evaluation evidence](V1-EVALUATION.md) | Investigate held-out misses, false acceptance and provider/hydration errors; prepare new acceptance/performance validation within separately approved usage. A successful single calibration pair does not replace the failed holdout or benchmark. |
| V1-08 | Explicit scope exclusions, HTTP/MCP discovery, exact citations, change-feed paging and 21 hosted smokes | Close positive BYOK chat acceptance; repeat affected advertised-route checks on the final candidate if its source or bindings change. |
| V1-09 | Prior Linux release checks pass; the latest local snapshot/acquisition increment passes 1,689 tests in 97 files, 23 Python cases, runtime regressions, expanded compilers, invariant checks and dry builds | Keep source-specific receipts and qualify the latest source in clean Linux CI. Preserve the earlier local log-cap failure and its uncertainty rather than rewriting it as a pass. |
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

## October 31 implementation progress

The [candidate inventory](evidence/2026-10-31/v1-candidate-inventory.json) records the worktree, published source, draft PR, and ten requirement dispositions.
GitHub confirms successful CI for published head `9e2fe17` in run `40064459109`.
That result does not qualify the newer uncommitted source or establish fresh cloud state.

V1-03 / V1-08: briefs now reuse the shared CHS corpus emitter on both emission paths.
Before repair, missing required citations and corpus mismatches produced successful HTTP/MCP briefs and consumed one unit each.
All four serving regressions now fail safely with zero units; 190 focused checks pass.
The response shape stays unchanged; per-item attribution now includes the shared licence and conditions.
See [issue 2](https://github.com/chester-hill-solutions/civicsignal/issues/2) and the [local receipt](evidence/2026-10-31/brief-policy-local-validation.json).

V1-05 / V1-09: scheduled qualification retains typed source failure codes and actual observed HTTP status.
Safe discovery quota facts and archive failure codes survive receipt and Workflow error serialization.
The three source phases, durable claims, receipt bound, and canonical retry policy stay unchanged.
The local slice passes 119 pure checks and 11 native checks.
Its initial socket failure and corrected R2 test assertions remain in the retained reports.
See [issue 3](https://github.com/chester-hill-solutions/civicsignal/issues/3) and the [local receipt](evidence/2026-10-31/snapshot-diagnostics-local-validation.json).

[Issue 4](https://github.com/chester-hill-solutions/civicsignal/issues/4) records the generated-answer evidence gap and required compatibility decision.
It does not change the current chat response or add an unrecorded release criterion.
Integrated checks and clean Linux CI for this increment remain pending.
No hosted serving, source, embedding, schedule, or production operation occurred in this increment.

The local Python aggregate failed its deadline/capture case once, then passed all 23 cases after safe assertion diagnostics were added.
The capture helper remains unchanged; a separate synthetic deadline probe also passed.
Later exact process reads found the three observed owned test PIDs absent.
These later results do not qualify the earlier inner capture or establish its cause.
See [issue 5](https://github.com/chester-hill-solutions/civicsignal/issues/5) and the [retained observation](evidence/2026-10-31/owned-python-qualification-observation.json).

The old Cron operator and evidence reader prove existing publication and cannot qualify a new first publication.
[Issue 6](https://github.com/chester-hill-solutions/civicsignal/issues/6) tracks the successor operator and complete accounting contract.
The new acquisition boundary also exposed [settlement](https://github.com/chester-hill-solutions/civicsignal/issues/7) and [saved-byte integrity](https://github.com/chester-hill-solutions/civicsignal/issues/8) defects during review.
Both local repairs now pass independent review and 124 focused checks across the transport and original capture core.
The Bun and tooling compiler checks also pass; integrated qualification remains open.
These fixture results establish no provider authentication, common writer freeze, or production acquisition.

The [latest integrated observation](evidence/2026-10-31/integrated-candidate-local-observation.json) retains both full attempts.
The first attempt fails six geography fixtures; their news rows carried the wrong corpus identity.
The fixture repair preserves the stricter shared emission policy, and its 116 focused checks pass.
The successor passes full validation: **1,780 tests in 98 files**, four compiler projects, native runtime probes, vendor checks, and invariants.
Its separate Python suite passes **22/23** and fails `ownedProcessSettled` in the actual log-cap case.
The inner capture reports timeout, log-cap overflow, and `owned-process-cleanup-uncertain`; the outer monitor settles.
A later exact process read finds the recorded child absent; this does not qualify the failed inner capture.
The sequence stops before dry builds, and all 462 source pins stay unchanged.
The capture helper remains unchanged, the cause remains unknown, and issue 5 stays open.
The final source still needs complete local qualification and clean Linux CI.

The [successor process-owner receipt](evidence/2026-10-31/process-owner-local-repair.json) records a focused reproduction on iteration 13.
The group probe returns `PermissionError` / `EPERM`; the former broad cleanup handler then skips direct-child completion and stdout closure.
The repaired helper treats that error as uncertainty and continues within the same five-second TERM and five-second KILL windows.
It requires affirmative group absence and direct-child reap, and always tries pipe closure.
Persistent probe failure still returns unsettled status.
Two of three deterministic regressions fail before repair; all pass afterward.
A later 20-case exact loop settles every process, including one naturally observed probe error with retained recovery metadata.
That loop precedes final errno allowlist tightening; the final frozen source separately passes **27/27 Python cases**, without ResourceWarnings.
The operator pins the new helper; provenance retains the original source and records the successor.
The historical integrated failures retain unknown causes. Full successor integration and clean Linux CI remain open.

The [snapshot proposal receipt](evidence/2026-10-31/snapshot-proposal-local-validation.json) records **45 passing preparation checks** and passing Bun/tooling compilers.
The library reuses the qualification identity, checks actual bundle correspondence, and pins configuration, references, resource observations, and named budgets.
It separates local metadata sidecars from logical R2 objects and rejects reference, storage, verification, and timing undercounts.
Its exact manifest and staging-receipt copies now reside in tracked evidence for clean-checkout checks.
Outputs remain private, exclusively new, and unapproved, with an empty calendar and `executionReady:false`.
No credentials, network requests, runtime changes, actual event, or allowance changes occur.
This completes a local preparation slice; issue 6 and hosted scheduled first publication remain open.

Independent review then reproduces acceptance of a one-byte metadata allowance.
The [successor proposal receipt](evidence/2026-10-31/snapshot-proposal-local-validation-v2.json) records its repair and **48 passing checks**.
The known custom-metadata key/value floor is **483 × (6 + 64) = 33,810 bytes**.
It remains distinct from **18,711 local sidecar bytes** and unmeasured provider overhead.
Independent replay rejects one byte and 33,809 bytes, accepts the exact known floor, and retains `executionReady:false`.
The original 45-case report remains intact. Exact-source integration and clean Linux CI remain open.

The [successor question receipt](evidence/2026-10-31/successor-serving-label-local-validation.json) records **64 new holdout questions**.
All **48 positive labels** pass the full immutable-source verifier across **24 XML blobs**, with zero rejected labels.
The set has 24 provision pairs across 12 Acts outside the stored formal question sets, plus eight excluded-source pairs.
All positive questions avoid an exact-provision parse. Its 21 new tests and 14 existing evaluation tests pass; Bun/tooling compilers pass.
The original dataset, default selection, serving policy, prompts, and thresholds stay unchanged.
This source proof establishes no hosted quality, deployment freshness, or generated-answer support.
Acceptance policy, fresh target provenance, and a separately bounded serving run remain open.

The [full successor local gate](evidence/2026-10-31/integrated-candidate-local-validation-v3.json) now passes all phases.
It records **1,849 tests in 100 files**, **27 Python cases**, four compiler projects, native runtime probes, invariants, and five dry builds.
All **470 source and fixture inputs** stay unchanged; each owned phase settles with exit zero and no deadline or log-limit failure.
The [successor candidate inventory](evidence/2026-10-31/v1-candidate-inventory-v3.json) maps all ten requirements to their local results and remaining evidence.
The corpus invariant script explicitly skips absent local ingest SQL/JSONL artifacts; separate hosted corpus proofs remain necessary.
This run inherits no cloud credentials, makes no real provider call, and deploys nothing.
Earlier failed runs remain intact. Exact-source clean Linux CI and the four hosted/production release gates remain open.

Source **3377cb8** now appears in draft PR 1.
Its [first clean Linux run](evidence/2026-10-31/candidate-3377-linux-ci-failure.json) passes frozen installation and all four compiler projects, then fails **23/1,849 tests**.
All failures occur in proposal source metadata admission; 99 other files pass.
Python and dry builds are skipped after validation fails.
The reader requires one link per public source file as well as private input.
[Bun documents](https://bun.com/docs/pm/global-cache) hardlinks as the Linux default and clonefile as the macOS default.
This suggests the admission cause; the CI log retains no inode facts.
[Issue 9](https://github.com/chester-hill-solutions/civicsignal/issues/9) tracks a same-seam reproduction and a repair that preserves private-file checks.
The failed run remains intact. No unchanged rerun occurs.

The [local admission repair](evidence/2026-10-31/proposal-public-hardlink-local-repair.json) reproduces failure by adding a real hardlink to copied dependency bytes.
The successor permits stable public hardlinks while retaining canonical paths, ownership, bounded bytes, hashes, and descriptor checks.
Private inputs remain single-link and private at both admission and final recheck.
All **60 focused cases** and both Bun/tooling compilers pass.
Only the proposal library and its tests differ from the 470-input passing local gate; the other 468 inputs match.
The historical CI inode facts remain unknown. Exact-source clean Linux qualification remains open.

Source **08cf10c** now passes [clean Linux CI](evidence/2026-10-31/candidate-08cf-linux-ci-validation.json).
Run **41242587226** checks merge **21553a8c10e074f264ded410541cfd226990aaa4**, containing that exact head and base **717bf329**.
Frozen installation, **1,861 tests in 100 files**, all **27 Python cases**, four compiler projects, runtime checks, invariants, and five dry builds pass.
The receipt pins all **470 source and fixture inputs** and retains the failed predecessor separately.
Issues **2, 3, 5, 7, 8, and 9** close for verified source repairs.
Issue 4 remains a product/API decision; issue 6 retains the owned operator and accounting work.
No hosted serving, generation, source, calendar, acquisition, production, or Railway operation follows from this CI result.
All four hosted/production release gates remain open; PR 1 stays a draft.

The [readiness authority audit](evidence/2026-10-31/scheduled-readiness-authority-audit.json) checks the retained staging packet before further execution work.
Its October 24 review has expired, and both one-time arming markers exist with accepted arming and cleanup receipts.
That packet checks existing-publication discovery; it cannot establish first publication or authorize a new event.
The audit finds no newer approved first-publication packet in its searched scope.
Five exploratory control-framework drafts remain preserved outside the active source tree, unvalidated and without prerequisite status.
All 470 qualified implementation and fixture inputs remain unchanged.
The next step reuses existing owned-read helpers for one bounded readiness check and preserves every refusal.
No credential contents or account requests occur during this audit.

The [local readiness receipt](evidence/2026-10-31/scheduled-readiness-local-validation.json) records 27 passing checks, packet compilation, owned inspection, and independent review.
Root checks all 17 frozen file hashes and four command-log hashes; the owned inspection checks 34 manifest inputs.
The failure regressions retain credential access, wire attempts, response bytes, and observed status without false success after journal-close uncertainty.
The frozen packet permits at most six read-only management GETs; no execution review or operational intent exists.
No real credential read, account request, or hosted qualification occurred. All 470 qualified implementation and fixture inputs remain unchanged.

The [one-time readiness observation](evidence/2026-10-31/scheduled-readiness-admission-refusal.json) then refuses credential admission with `oauth-lifetime-insufficient`.
The eligible file reports expiry `2026-10-27T22:26:55.876Z`. Its single stable read uses 801 bytes; token selections and wire requests both remain zero.
The owned child exits with failure and settles; no timeout, log overflow, or receipt-persistence uncertainty occurs.
The review, intent, journal, and permanent refusal remain intact. No retry or credential refresh follows.
Current account state, scheduled publication, serving acceptance, and production qualification remain unproved.
Credential recovery now precedes any reviewed successor readiness check. Issue 6 retains this finding.

The [separate credential recovery](evidence/2026-10-31/credential-recovery-observation.json) then passes one explicit refresh POST with HTTP 200.
The frozen packet passes 45 synthetic core cases, 20 owner cases, an optimized owner replay, compiler checks, and independent review.
Root checks all 37 frozen inputs before execution and observes no matching Wrangler or OAuth writer process.
The reply preserves the exact 28 stored scopes. Private recovery copies precede guarded replacement of the shared Wrangler configuration.
The new access expiry is `2026-10-31T23:05:52.847Z`; child and owner pass with confirmed settlement and no persistence or refresh uncertainty.
No retry, login, account API, source, serving, generation, deployment, or calendar action follows this operation.
The original readiness refusal remains intact. A separately reviewed successor must establish current resource state.

The [separate readiness successor](evidence/2026-10-31/scheduled-readiness-management-observation.json) passes at `2026-10-31T22:08:56.116Z` after exactly six management GETs.
All six replies return HTTP 200 and total 6,513 bytes. The deployed version and settings agree on bindings and runtime.
The Worker calendar is empty. The optional native Workflow schedule field is absent, so that calendar remains unknown.
The owned process settles and rechecks all source pins; no refusal or persistence uncertainty occurs.
The snapshot namespace and instance absence, current source, canonical artifacts, and first publication remain unverified.
No mutation, source, serving, or generation request follows. The prior consumed packets remain unchanged.

The offline serving investigation reproduces a separate text-reference defect in `src/corpora/text-store.ts`.
Two rows share one content-addressed object but declare different byte lengths; the promise cache accepts both after one object read.
The allocation preflight also lets a later smaller declaration replace the larger value for that object.
[Issue 10](https://github.com/chester-hill-solutions/civicsignal/issues/10) tracks the narrow repair and serving regressions.
This reproduction does not establish the cause of the retained hosted hydration failure. No new serving request occurs.

The [hydration repair receipt](evidence/2026-10-31/hydration-contract-local-validation.json) retains five failing new regressions before the repair and 138 passing focused checks after it.
The nine new cases cover both reference orders, conflicting lengths, concurrent sharing and settlement, verified fallback, allocation limits, and cached HTTP usage.
The maximum declared size now controls allocation; a cached text promise also binds its checked byte length.
Worker, Bun, and tooling compiler checks pass. Root checks all source, historical report, and test-log pins in the receipt.
The retained holdout 502 reports an encoder failure before row access; the benchmark failure reports row access without a retained substage or reason.
The original benchmark cause remains unknown. Full candidate integration and clean Linux qualification remain open for the new source.

The [next full local observation](evidence/2026-10-31/integrated-candidate-local-observation-v4.json) passes frozen installation and all four compiler projects, then fails 356 tests across seven protected-data suites.
Its temporary directory resides inside the repository. Protected inputs correctly reject that location with private-path admission errors.
The aggregate passes 1,556 tests; all 472 source inputs remain unchanged and both owned processes settle.
Python and dry-build phases do not run. Preserve this result and use external private temporary data in the successor.
Independent review also reproduces a retained raw-file drift defect in the new acquisition facts collector.
[Issue 11](https://github.com/chester-hill-solutions/civicsignal/issues/11) tracks final identity and byte checks under the same finite owner.
The new source remains unqualified until that repair and its complete successor checks pass.

The [facts integrity repair](evidence/2026-10-31/acquisition-facts-local-validation.json) retains the [166-case predecessor](evidence/2026-10-31/acquisition-facts-local-predecessor.json) and ten failing targeted regressions.
The final focused set passes 179 cases, including thirteen new file-drift and acceptance-boundary regressions. Bun and tooling compiler checks pass.
The collector rechecks every original file identity and complete bounded content after all durability operations, under the same finite owner.
Independent review repeats the original failure: capture now refuses file drift, retains its failure, and permanently fences later owner work.
A valid control succeeds; the reviewer also passes all 179 focused checks and confirms the final pins.
These observations establish no authenticated acquisition, common writer freeze, source-schema classification, or production qualification.
The corrected full candidate check uses private temporary data outside the checkout; its result remains pending.

The [corrected complete local gate](evidence/2026-10-31/integrated-candidate-local-validation-v5.json) passes frozen installation, all four compiler projects, and 1,925 tests in 101 files.
All 27 Python checks, native runtime probes, invariants, and five dry builds pass. All four owned phases settle with exit zero.
The 472 source and fixture inputs remain unchanged across the complete check; root also rechecks them before the public receipt.
Temporary protected data stays outside the checkout. The earlier failed aggregate remains intact.
The source now needs clean Linux qualification. All hosted and production gates remain open; no deployment follows from these local checks.

Source **`26d50490d7213750d360973d9c55b6b75aaeac7b`** then passes [clean Linux run 41247844391](evidence/2026-10-31/candidate-26d-linux-ci-validation.json), job **124674891186**.
The job checks out merge `31b1db0ea3ce0921677e8db7a43a34372b63a641`, containing that head and base `717bf3299701d06ec6d85add276e1ed546c69387`.
Frozen installation, 1,925 tests in 101 files, 27 Python checks, four compilers, runtime/invariant checks, and five dry builds pass.
All 472 source and fixture inputs match the passing local gate and current tree. The actual Node version is v24.22.1; Bun is 1.3.5.
Issues 10 and 11 close for their qualified source repairs. Issues 4 and 6 and all four hosted/production gates remain open.
The PR remains a draft. No deployment, source, serving, generation, calendar, production, or Railway action follows from this CI result.

A bounded read-only production inventory then completes with settled ownership and no data or writer-control changes.
Its detailed observation and maintenance finding remain in the private local operation packet under a publication hold.
No public issue or artifact link carries those details. Deployed-source correspondence, auth authority, common maintenance, and production acquisition remain open.

The private fixed publication preparation passes 47 local cases across controller, owner, and artifact checks, plus compilation and offline inspection.
Its complete fixture covers 720 captures, 1,171,270,527 bytes, and all 277,857 logical rows in each of three comparison sets.
The packet remains unapproved and non-live. Its 912 REST slots and four local guard reads do not establish a global provider ceiling.
Source review identifies default qualification retries and unbounded cleanup as concrete remaining controls in the shared runtime.
The next increment adds qualification-only retry, deadline, fixed object, and progress limits while retaining canonical behavior.
This later source still needs full local and clean Linux qualification. No new event, deployment, corpus request, or generation follows from preparation.

The recovery, full metadata, composite changed-text byte verification and complete
vector backup gate is closed within the approved limits. Preserve the original
paused coordinator and backup evidence.

The master plan consolidates the current package status and next actions.
This ledger retains the detailed execution history, including the [acquisition transport receipt](evidence/2026-10-31/acquisition-transport-local-validation.json).
The original [snapshot reference accounting](evidence/2026-10-31/snapshot-reference-accounting.json) retains its 986-operation successful-path baseline.
Its older source pins and excluded work do not establish a current runtime ceiling.
The qualification-runtime increment then passes 176 focused checks and independent source review. All four compiler projects pass.
The [successor accounting](evidence/2026-10-31/snapshot-reference-accounting-runtime-v2.json) pins all thirteen required runtime sources and both original references.
It preserves the 986-operation baseline and records separate callback bounds; it claims no global provider ceiling or binding cancellation guarantee.
All eighteen reviewed source/test pins remain unchanged after the 64-case proposal suite. Full local and clean Linux qualification remain open.

The [focused runtime receipt](evidence/2026-10-31/snapshot-qualification-runtime-local-validation.json) retains the 176-case result, four compiler checks, and eighteen source/test pins.
The [v6 sandbox observation](evidence/2026-10-31/integrated-candidate-local-observation-v6.json) retains local loopback refusals and an explicit root stop.
Root checks the exact owned process before SIGTERM; its original capture owner settles. All 477 inputs remain unchanged.
The separate [v7 complete observation](evidence/2026-10-31/integrated-candidate-local-observation-v7.json) passes installation and all four compiler projects.
Tests finish with 1,971 passes and one failure across 102 files. Undici reports terminated/EPIPE in the four-frame native restore test.
Its owner settles with exit one; Python and dry builds do not run. All 477 inputs remain unchanged.
The exact named test then passes in isolation, with seventeen tests skipped and settled ownership. That result does not qualify the failed aggregate.
[Issue 12](https://github.com/chester-hill-solutions/civicsignal/issues/12) tracks diagnosis; the cause remains unknown. Full source and clean Linux qualification remain open.

Source **`dba19d3679727863f2fb1fc0fe6b38a53d2a9eff`** then passes the [complete Linux comparison](evidence/2026-10-31/candidate-dba19d3-linux-ci-observation.json).
Run 41253330453, job 124691204672, checks out merge `964cee4814b86df5590157765c2e6f2e593ebaa3` against base `717bf32`.
All 1,972 tests in 102 files, 27 Python cases, four compiler projects, runtime checks, invariants, and five dry builds pass.
All 477 source/fixture inputs match that exact Git commit. Node is v24.22.1; Bun is 1.3.5.
The Linux pass does not repair or explain the local EPIPE failure. Issue 12 remains open.

Serving preparation then reproduces a separate relay defect through the actual source and a fresh one-request synthetic ledger.
A send callback aborts synchronously and rejects; abortable returns another rejection without observing the original promise.
The relay returns 499 with one spent reservation and one send, then Bun exits one with an unhandled rejection.
[Issue 13](https://github.com/chester-hill-solutions/civicsignal/issues/13) records the defect. Two control cases distinguish it from cleanup and AbortController dispatch.
The tracked subprocess regression fails before repair. The source repair remains in progress and needs complete successor qualification.
No real request, credential, original-ledger change, or historical hosted-cause claim follows from this local reproduction.

The [native diagnostic](evidence/2026-10-31/restore-frame-diagnostic-observation.json) retains 59 artifact pins and an inconclusive result.
The full restore file, 61 original-buffered triggers, and ten controlled cadence variants pass with their original assertions.
No EPIPE cause or repair is established. Expected relay-source drift stops the next probe before launch; the diagnostic keeps its original fence.

The relay repair observes the already-created promise before its immediate abort rejection. It adds no retry or ledger change.
The actual subprocess seam fails before repair and passes after repair; two controls exclude cleanup and AbortController dispatch as causes.
Independent review accepts the exact source and final test pins. The final regression preserves 499, one send, one spent reservation, and no unhandled rejection.
The [complete v8 local gate](evidence/2026-10-31/integrated-candidate-local-validation-v8.json) passes installation, all four compiler projects, and 1,975 tests in 102 files.
All 27 Python cases, runtime/invariant checks, and five dry builds pass. All four owned phases settle with exit zero.
All 477 source/fixture inputs stay unchanged. The original native restore test passes here; its earlier EPIPE cause remains unknown.
Exact successor clean Linux and all hosted/production gates remain open. The earlier failed aggregates remain intact.

Source **`eee91b2db9eef3dde8b6d0a404eba1256434debc`** then passes [exact clean Linux qualification](evidence/2026-10-31/candidate-eee91b2-linux-ci-validation.json).
Run 41254554237, job 124694845357, checks out merge `3e4acb7496613c4034a26002f074f57882760f7f` against base `717bf32`.
All 1,975 tests in 102 files, 27 Python cases, four compiler projects, runtime/invariant checks, and five dry builds pass.
All 477 inputs match the committed source and passing local v8 gate. The compiler/runtime builds use no production secrets or deployment.
[Issue 13](https://github.com/chester-hill-solutions/civicsignal/issues/13) closes for the qualified relay repair. Issue 12 remains open with no EPIPE cause or repair claim.

The first-publication successor receives the actual local/Linux source wrapper. Its real offline admission accepts all 25 required source/accounting/reference pins.
Credential reads and network calls remain zero. Execution, event, fresh calendar/resource facts, and operation admission remain absent.
Independent preparation review requires final acceptance of all nine settled owner chains and both actual cleanup completions, beyond canonical artifact proof.
The staged API update, broad serving launcher, and exact-source Zen successor remain in local implementation. Their real execution inputs remain absent.

A local source-integrity probe then reproduces a Python helper-loader gap under `-I -B`.
A timestamp-valid bytecode cache executes older fixture code after the current source hash passes. No actual workspace cache is executed by the probe.
[Issue 14](https://github.com/chester-hill-solutions/civicsignal/issues/14) records the source defect; the [local repair receipt](evidence/2026-10-31/pinned-python-helper-local-repair.json) retains its proof.
Two targeted regressions fail before repair: stale cached code and a source change after hashing. The hash-mismatch control passes.
The repaired operator reads a bounded regular file, checks that buffer, then compiles the same bytes without a cache lookup or source reopen.
Its default execution path uses that loader. The test bootstrap also compiles source directly.
Independent review accepts the final pins. Three sharp regressions pass; the complete successor gate remains in progress.
The shared capture helper stays unchanged. New private owners adopt the same checked-buffer rule; frozen predecessors remain intact for historical evidence.

The [complete v9 local gate](evidence/2026-10-31/integrated-candidate-local-validation-v9.json) passes frozen installation, 1,975 tests in 102 files, and all four compiler projects.
All 31 Python cases, runtime/invariant checks, and five dry builds pass. All four owned phases settle with exit zero.
All 477 source/fixture inputs stay unchanged. The driver, production helper loader, and final test bootstrap execute checked source buffers without cache loaders.
The capture helper retains its original source bytes. Issue 14 remains open until exact successor Linux qualification completes.
The API JavaScript artifact remains unchanged; shared operation packets must bind the newly qualified source before execution.

Source **`5d4915c1fd2ed16aba4d550aaf4ac367366b95b7`** then passes [exact clean Linux qualification](evidence/2026-10-31/candidate-5d4915c-linux-ci-validation.json).
Run 41258949605, job 124708002957, checks out merge `fccbb74e74a7eb057bb4c4794abbb262060b9dbd` against base `717bf32`.
All 1,975 tests in 102 files, 31 Python cases, four compilers, vendor/runtime/invariant checks, and five dry builds pass.
All 477 source and fixture inputs match local v9, the exact committed source, and current files.
Root also checks all eleven retained local artifacts. Node is v24.22.1; Bun is 1.3.5.
The exact checked-buffer repair closes [issue 14](https://github.com/chester-hill-solutions/civicsignal/issues/14).
The shared capture helper stays unchanged. Operator successors must use the current source and both complete receipts.
Issue 12 remains open; the earlier EPIPE cause remains unknown. All four hosted and production gates remain open.

The publication and staging API operator successors then pass local preparation and independent review.
Their source admission uses the actual current local and Linux receipts; neither result supplies execution approval.
Private API review records and repairs freshness and binding-order defects in unexecuted drafts.
The latest serving logs record ten owned fixture cases and four lease checks; final packaging and independent review remain open.
Zen final integration remains incomplete. No actual serving, generation, source, deployment, or production operation follows.
Verified lossless archives retain closed synthetic fixtures and their metadata without altering frozen source or accepted evidence files.
Local storage and workspace credits constrain further work; preserve the unfinished candidates and exact logs for continuation.

Continuation restores local storage headroom and completes the serving successor's independent preparation review on the earlier qualified source.
That successor refuses fixture-only inputs during live admission and completed-proof checks.
It retains earlier owned-runner evidence through exact mechanism comparisons; it does not claim new hosted serving results.

The next product increment checks generated citation destinations before successful usage consumption.
It preserves the answer text and retrieved source list; link equality does not establish factual support.
The user selects a fixed insufficient-evidence answer for empty retrieval, with zero generation calls and one successful retrieval unit.
Additive response metadata identifies skipped generation and retains the selected provider and model.

The first chat candidate passes 2,129 tests, but independent review reproduces a reference-definition bypass inside quote and list containers.
Its [v10 observation](evidence/2026-10-31/integrated-candidate-local-observation-v10.json) remains review-blocked and cannot qualify the repaired source.

The repaired source adds actual endpoint regressions for all four providers and refuses those reference forms before usage consumption.
Independent review accepts all five final source/test pins after 52 pure checks.
The [complete successor local gate](evidence/2026-10-31/integrated-candidate-local-validation-v11.json) passes 2,192 tests in 102 files, 31 Python cases, four compilers, and five dry builds.
Vendor checks, native runtime probes, and invariants pass; all 477 source inputs remain unchanged and all four owned phases settle.
The corpus invariant command still skips absent local ingest files; this result supplies no new corpus proof.

The [chat receipt](evidence/2026-10-31/chat-citation-binding-local-validation.json) records the scoped behavior, regressions, source pins, and independent review.
[Issue 4](https://github.com/chester-hill-solutions/civicsignal/issues/4) remains open for independent factual-support evidence and the wider answer contract.
All four release gates remain open. No hosted generation, serving, deployment, source, or production operation follows from this increment.

Source **`9771a8bad2b8a2321ed3f43f7629af4040a39c1c`** then passes [matching clean Linux qualification](evidence/2026-10-31/candidate-9771a8b-linux-ci-validation.json).
Run 41269877038, job 124740273155, checks out merge `2036385dbbe564cd4ccafca40ad8c178748068ad` against base `717bf32`.
All 2,192 tests, 31 Python cases, four compilers, vendor/runtime/invariant checks, and five dry builds pass.
Root checks all 477 inputs against the local receipt, committed source, current files, and actual CI merge blobs.

Node is v24.22.1; Bun is 1.3.5.
Operation source and artifact rebinding remains open; the earlier EPIPE cause and independent factual-support acceptance remain unresolved.

The publication and API operator successors then bind the current source wrapper and pass their local checks and independent reviews.
Exact source and compiled comparisons retain unchanged predecessor mechanisms without a new full artifact or protocol replay.
Serving source binding, types, and unchanged evaluation/benchmark graph checks pass; final policy checks and freeze await D-01.
Zen contains the current source wrapper and a skipped-generation regression; its final integration remains pending.
No execution approval or current hosted target proof follows. All four release gates remain open.

## November 22 local code assessment

The audit used a tracked copy of `518aab0912858d48a405c7060ae91951ec908894` on macOS arm64 with Node 24.22.3, Bun 1.3.5, and Python 3.14.3.
The runtime and test inputs match the earlier qualified `9771a8b` source.
The commands below ran against local fixtures and disposable resources.

| Command | Observed result |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | Bun 1.4.4 installed the locked dependencies in the temporary copy. The suite and builds used Bun 1.3.5. |
| `CIVICSIGNAL_WORKERD_TESTS=1 bun run test --maxWorkers=4 --minWorkers=1` | 2,192 tests passed in 102 files in 106.72 seconds. |
| `python3 -I -B test/protected-state-d1-owned.test.py` | 31 tests passed. |
| `bun run typecheck` and `bun run build` | Four compiler projects and five Worker dry-run builds passed. |
| `bun run check:vendor`, `bun run check:billing-invariants`, `bun run check:corpus-invariants` | 117 vendored files matched. Both invariant checks passed. The corpus check skipped absent SQL and both language JSONL artifacts. |
| `bun run check:runtime` | In local workerd, 12 calls with one operation ID consumed one unit. Three of 20 competing operations consumed the remaining three units. R2 duplicate writes preserved the original bytes. |

Five separate probes exercised the real HTTP handler against fixture state. The generation, encoder, and index responses used test doubles.

| Requirement | Trigger and observation | Source |
| --- | --- | --- |
| V1-04 | Seed a published revision. Update a provision and fail the vector write after the row commit. Exact HTTP lookup returned `200` with the changed text and the previous revision. | [D1 write order](../src/corpora/d1-store.ts#L94), [API revision read](../src/index.ts#L138) |
| V1-03, V1-07 | Disable Jev. For a topic plus keyword, return scores `0.90` and `0.10`. Only the lower match contains the keyword. The API returned that match with `decision: answer` and a floor of `0.62`. | [Vector floor](../src/corpora/adapters.ts#L259), [keyword filter](../src/corpora/adapters.ts#L309) |
| V1-01, V1-03 | Start two chats with one workspace unit left. Hold both provider replies until both calls start. Complete one request first. HTTP results were `200` and `429`. The provider stub received two calls and the ledger recorded one unit. | [Chat handler](../src/index.ts#L71), [usage order](../src/metering.ts#L61) |
| V1-08 | Return an invented entitlement with a valid retrieved link from the generation stub. Chat accepted the unsupported claim with HTTP `200`. | [Citation URL check](../src/routes/chat.ts#L168) |
| V1-03 | Fail a KV read and keep the encoder and index healthy. Normal search returned `502`. A repeat with cache bypass returned `200` and used the index once. | [Cache read path](../src/corpora/adapters.ts#L233) |

These checks add local evidence for the [serving prerequisites](PLAN.md#local-serving-prerequisites). Hosted quality, charges, freshness, and performance remain open.
The existing hosted results, failures, and request ledger retain their scope. Hosted execution still requires its own approval.

## November 22 search eligibility and cache repair

The local patch on `518aab0` introduces `federal-authority-v4-eligible-floor` for the shared search adapter.
With Jev off or failed, at least one returned provision must meet the backend floor.
A valid Jev authority decision still uses the existing rerank path.
The new policy changes the cache key. A cache read fault triggers fresh search. A write fault preserves the result.
Evaluation reports count both faults separately. The raw pre-refusal score retains its definition.

The Worker cache-fault regression returns HTTP `200` with the provision and consumes one workspace unit.
The Bun/Postgres brief rejects a weak provision if its stronger candidate fails the keyword filter.
Both tests reproduced the defect before the repair. Further fixtures cover the Jev fallback, missing rows, cache write faults, and retained text hydration errors.

The first full run found two failures in a benchmark fixture that expected the old policy. The fixture now uses the serving policy constant.
The full rerun passed 2,203 tests in 102 files with local workerd enabled.
The same runtime patch passed 31 Python tests, four compiler projects, both native runtime probes, and five Worker dry-run builds.
Vendor and invariant checks passed. The corpus check skipped the three absent generated artifacts.
The local checks used Node 24.22.3 and Bun 1.3.5.
The SHA-256 of `git diff --binary HEAD -- src test` at verification was `5b3d5204605826565aef2a473052d1109c3ba643adfd74d183e90e08abd7b2c9`.

The patch changes the retrieval policy and adds optional cache diagnostics. It uses the existing store schema and cache expiry.
The earlier build retains its original policy when selected for rollback.
Coherent revision, BYOK hard-limit admission, hosted calibration, and independent holdout remain open.

## November 22 integrated v1 local work

The local worktree on `518aab0` adds publication and quota guards. It also composes the offline production capture and checks claim-review evidence.
The [rollout procedure](V1-OPERATIONS.md#authorization-migration) requires a drained writer and coherent corpus and index before it applies migration 0009.

| Package | Verified increment | Evidence still required |
| --- | --- | --- |
| MP-01 and MP-06 | Frozen install, all four compilers, five dry-run bundles, and local tests passed. | Exact final source, clean Linux CI, operation binding, and the final release decision. |
| MP-02 | The local workerd scheduled-publication tests passed in the integrated suite. | Fresh namespace, distinct instance, both calendar checks, bounded event, and hosted artifacts and cleanup. |
| MP-03 | A request crossing a publication returns unavailable without a usage charge. The writer waits for its vector mutation and resumes finalization without encoding the same rows again. | Hosted visibility, decision D-01, fresh bilingual holdout, benchmark, and positive Zen. |
| MP-03 | The existing usage object admits one generation hold for one remaining unit. Mixed requests share that limit. Failed work releases capacity and repeated settlement charges one unit. | Qualify this version in hosted staging with the same usage identities. |
| MP-03 and D-02 | The offline checker binds a complete independent review to each captured answer, retrieved text, candidate, revision, provider, and model. | Preregister real bilingual answer and refusal cases. Capture them on the candidate and independently verify every factual claim. |
| MP-04 | The offline owner checks D1 facts before and after both KV views and export. It downloads the exact signed SQL under the same budget. | Live owner, actual writer controls and freeze, credential lifetime, and approved capture budget. |
| MP-05 | Local text audits, vector export, and protected restore refuse conflicting publication state. | Authentic capture and isolated hosted copy. Qualify the production adapter and both switch targets. |

The integrated run passed 2,219 tests in 103 files, 31 Python tests, and both native runtime probes.
The independent claim checker passed 17 fixture tests. The command-line check accepted a complete synthetic review and refused a review with one unsupported claim.
The vendor and invariant checks passed. The corpus check skipped three absent generated artifacts.
The local runtime used Node 24.22.3 and Bun 1.3.5.
No hosted operation ran. Existing hosted measurements and consumed budgets retain their scope.

## November 22 Cloudflare release preparation

| Package | Local evidence |
| --- | --- |
| MP-02 | The offline snapshot check pins the exact reference manifest before it reads the artifact set. The CLI fixture refuses a different, internally valid snapshot with the same source revision. |
| MP-03 and D-02 | The case plan pins the hash of the exact chat request body. The review also pins the captured request, answer, and retrieved text. The CLI accepts the complete synthetic review and refuses a substituted request under the same case ID. |
| MP-04 and MP-05 | Repair dry runs issue read-only D1 statements even with `--prune`. The old D1 load, repair, and fingerprint backfill paths refuse writes after migration 0009. The old index loader refuses the configured API and pipeline indexes. |

The affected suites passed 213 tests in 11 files, with local workerd enabled.
Four TypeScript projects, five Worker dry-run builds, vendor checks, and both invariant commands passed.
The corpus invariant check skipped the three absent local ingest artifacts.
The exact candidate still needed a clean Linux CI receipt at this checkpoint.
Hosted publication and serving acceptance still need their own execution evidence.

## November 22 draft candidate qualification

Draft PR #1 is pinned to [`711b4f8`](https://github.com/chester-hill-solutions/civicsignal/commit/711b4f8c80ce60a6e2d65857c8608cd75726e0ad).
The independent review checked the D1 and Vectorize writer boundaries, CHS quota and chat evidence, and snapshot and restore operations.
Legacy bootstrap checks now catch alternate spellings of the D1 guard and generated staging index names.
Claim reviews bind to the provider's effective supported model and the exact candidate and corpus revision.
The ordinary pipeline can finish an already indexed publication during a GitHub outage. A later cycle checks upstream freshness.
Fresh isolated restores create their guard during initialization. Existing stores use the reviewed additive migration.

The complete local gate passed on macOS with Node 24.22.3 and Bun 1.3.5.
The frozen-lockfile check reused the previously installed dependency graph. All 117 vendor files matched.
Four compiler projects, 2,261 Vitest cases in 106 files, 31 Python cases, native Durable Object and R2 probes, both invariant commands, and five Worker dry-run builds passed.
The corpus invariant check skipped the three absent generated ingest artifacts.
An earlier run exposed a multi-line SQL setup error in the native fixture. The fixed fixture passed the complete rerun.
Local native checks used disposable localhost bindings.

[Linux CI run 45090204686](https://github.com/chester-hill-solutions/civicsignal/actions/runs/45090204686) uses PR merge commit `8f0df91a0806af1e8abd62db92ef50f95134bea8`.
Its Git tree `91d8f2988d8879e835def7c461f5652b87bb97c7` matches all 697 tracked files in the candidate.
The job log confirms checkout of that merge commit. Clean frozen install, the full validation command, the 31 Python checks, and all five Worker dry-run builds passed.

## November 22 live source freshness audit

Cloudflare management reads on November 23 UTC confirm the production pipeline calendar `23 11 * * *` and an empty staging snapshot Worker calendar. The configured production snapshot Worker and Workflow both return 404. The account inventory shows only the October staging snapshot Workflow, whose native schedule field is absent.

Production D1 records 277,857 federal provisions at `0507465`, dated October 15, with its last completed cycle on October 22. The live schema has no parser version, vector mutation journal, immutable text-reference table, or publication guard. The audit used read-only D1 queries.

Justice Canada published `855cdfc` on November 16. A read of the seven-day pipeline invocation metrics found one success before that revision appeared and one `exceededMemory` outcome at the daily run time on each of November 17–22. Detailed Workers Logs access returned 403. The observed memory failures establish why those runs stopped. Their internal allocation site remains unverified.

The exact public Git comparison has one commit and 274 changed files. An offline replay with the candidate parser, a counting store, and a stub encoder projects 1,027 added, 471 changed, and 1,218 removed provisions. That replay requested 1,450 document embeddings across 46 batches. These counts describe the source delta. A production allowance needs the actual target fingerprint and parser state.

The complete November 16 `statutes-v2` reference was built locally from the pinned Justice Canada Git tree using the candidate's snapshot builder. A separate source pass checked all 277,666 serialized rows and UTF-8 index offsets and lengths. The offline verifier also checked all 238 published-format artifacts totaling 389,760,843 bytes and pinned the manifest at SHA-256 `43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34`. The independently hashed local staging inventory contains 243 logical objects totaling 760,573,309 bytes. These artifacts remain local.

The stage qualification entry was rebuilt from `711b4f8`. Its 260,281-byte bundle hashes to `1a6e7a090cda96876f91bebb9eab6b3aa57926bf8db6ae7c940e3c2f9ac49f20` across 29 build inputs. That bundle embeds the retained October reference. The next stage packet needs a rebuilt runtime policy pinned to the new inventory, fresh resource evidence, and a bounded execution window. Production recovery also needs the guarded reader and writer rollout.

## November 22 incremental ingestion memory fix

[Draft candidate `3f16f93`](https://github.com/chester-hill-solutions/civicsignal/commit/3f16f933e1806d0a9327db00c36ff31e13b9c6a5) reads and parses one changed XML file at a time. The comparison retains prior fingerprints, unchanged IDs, and changed rows. Cross-file moves and duplicate precedence retain their existing behavior. The cycle finishes reading the source before it requests embeddings or writes row changes.

The local workerd replay used the same 274 changed files and 520 file responses from the two exact Git trees. With a 113 MiB V8 old-space limit and 2 MiB semispaces, the preceding candidate exhausted the heap and the fix completed. The fixed run's 1,257 DevTools samples measured a maximum combined heap and backing storage of 114,797,988 bytes. It produced the same provision changes and sent 1,450 documents to a local stub encoder. Earlier four-file and two-file trials failed under more tightly constrained heaps. The local sample supports the memory repair. Hosted execution and latency still need their own evidence.

All 46 affected regression tests, all four TypeScript checks, and the pipeline dry-run bundle passed locally. [Linux CI run 45093819484](https://github.com/chester-hill-solutions/civicsignal/actions/runs/45093819484) passed 2,261 tests, 31 Python checks, native runtime probes, and five Worker dry runs. The CI checkout `64f2eb49fb8f6a9b7eea9388c4f2310bd99d9fb1` has the exact candidate source tree.

The snapshot-backed recovery rehearsal derived all 277,857 predecessor fingerprints from the pinned October source. It applied the verified November snapshot across two bounded cycles, with 2,000 then 716 provision writes and 1,450 synthetic embeddings. The first cycle left publication open. The second published once, and all 277,666 resulting fingerprints matched the November index. This evidence uses local counting storage and synthetic vectors. Hosted staging and the coordinated production rollout remain open.

## November 22 scheduled-publication preparation

An isolated staging source commit `07689eb09e2593c27dc0d1566a2509d0873c0054` builds on qualified candidate `3f16f93`. It binds the stage-only qualifier and proposal checker to the November 16 reference. The October source and receipts remain available for historical verification.

An independent whole-archive local replay reproduced all 481 staged and final payload hashes from the pinned Git tree. The final 238 artifacts cover 277,666 provisions. The resulting successful-pass estimate is 982 logical R2 operations. The callback policy permits at most 1,937 R2 operations per Workflow traversal and 16 per scheduled callback. These numerators describe different execution scopes. Delivery, reconstruction, and in-flight operations still need reviewed handling.

The offline proposal passed, including refusal of the October source under the November pin. All 105 proposal and runtime tests and all four compiler checks passed. The stage-only dry build preserved the exact bundle SHA-256 `79fffe09dad44a47dc78568f52af9fc7ec83ffc889d40ebef8d8218fb3aa38c8`. Its configuration has an empty Worker cron list and only the isolated Workflow and R2 bindings. The proposal file marks the illustrative event and budget as prepared and unapproved.

November 23 UTC read-only Cloudflare observations confirmed the staging deployment and bindings, an empty Worker cron list, an unused proposal namespace, and a 404 for the proposed Workflow instance. The retained October staging manifest's size and SHA-256 metadata matched the existing reference. The API omitted the native Workflow schedule field, so its calendar remains unknown. The observed credential expires before the illustrative event and cleanup. The earlier hosted operator and guards must be rebound to an approved live window and credential before deployment or arming.

Wrangler subsequently refreshed the existing OAuth login through 02:59:31 UTC. The illustrative event is later, so reissue the packet for the actual window with a credential valid through cleanup. The local Chester Hill Solutions checkout, available Git history, and organization code searches returned no matching operator or cleanup-guard source. The dashboard was at sign-in and did not resolve the native calendar. The disk had less free space than a duplicate artifact download. A streaming checker verified all 238 retained artifacts in place and rejected substituted, truncated, and oversized bodies in local tests. Hosted publication remains open.

The `cf` CLI authenticated using its own profile. The `cf workflows get` read reached the intended staging Workflow and again found the native schedule field absent.

The tracked calendar runner now owns singleton arming, two detached cleanup guards, and independent final readback. Its local tests include both guard entry points in separate Bun processes and a lost arming response that still leads to cleanup. The latest `cf` read again omitted the native schedule field. Hosted admission and publication remain open. [Calendar runner and guard evidence](V1-SCHEDULED-PUBLICATION-REVIEW.md#before-a-hosted-proposal-is-executable)

## November 22 isolated Cloudflare staging bootstrap

At 02:29 UTC on November 23, `cf` deployed `civicsignal-v1-stage-nov16-snapshot` as a new Worker and Workflow after confirming both names returned 404. The [preparation command](../scripts/prepare-snapshot-cf-stage.ts) uses the exact 259,948-byte November bundle with SHA-256 `79fffe09dad44a47dc78568f52af9fc7ec83ffc889d40ebef8d8218fb3aa38c8`. The prepared Worker config hashes to `900d2be16bb66ab8c03f700efbcf12cbeabfb8debf2ff0635cde6ca5f79b9908`. It binds only its own Workflow and configures zero Worker crons, native schedules, public routes, and R2 bindings. Preview and `workers.dev` URLs are disabled in that configuration.

`cf` confirmed deployment `f538622c-74d8-4d50-93c6-7e27b9481b0a` serves version `4f24cb2f-cbf9-46d0-85ee-7749282ebd84` at 100%. The new Workflow is `c8ba63d3-a002-4c62-8669-45c7c4c2bf40`. Its creation and modification timestamps match, and its instance list returned zero entries. The 02:30:42 UTC read still omitted `schedules`. The creation configuration proves zero schedules were configured by this deployment. Direct provider confirmation of an empty native calendar remains open. The publication runner still needs to bind to the new identities and a reviewed staging event. [Hosted preflight](../scripts/check-snapshot-hosted.ts)

At 02:36:07 UTC, the strict read-only `cf` check passed for the pinned deployment and version. Both Workflow timestamps and its ID matched the [creation record](evidence/2026-11-22/november-workflow-creation.json), yielding `unscheduled-creation` evidence. The API still omitted the schedule field. The calendar runner and both guards now accept the exact fresh Worker target. The publication runtime configuration and concrete event remain pending.

## November 22 staging publication version

`cf workers versions create` uploaded the publication configuration, and `cf workers deployments create` activated it at 100% without applying triggers. Deployment `4cbfc139-4d85-416d-967c-f90ea4e9b343` serves version `ce6deccb-c345-43ca-9fe5-b6c7d0b04836`. A `cf` version read independently hashed the 259,948-byte module and matched `79fffe09dad44a47dc78568f52af9fc7ec83ffc889d40ebef8d8218fb3aa38c8`. The nine bindings include `CORPUS` on `civicsignal-v1-stage-corpus-20261022`, the isolated November Workflow, and seven pinned qualification controls. The version reports zero public URLs. The strict `cf` admission check still matched the Workflow's unscheduled creation record after activation.

The [publication preparation command](../scripts/prepare-snapshot-cf-stage.ts) pinned November 23 at **03:47 UTC** (`47 3 23 11 *`), calendar cleanup at **04:07 UTC** with a **04:10 UTC** deadline, and the Workflow runtime deadline at **05:47 UTC**. Its prebuilt configuration hashes to `0f2f1287701e64a5b7bb8829267f241f9eb616af005f55787ac9422b8335a5a5`. The qualification digest `b2b763a9599803fe0ed7aa1c8dd2575cbf78590ed666f755a48f2308e6a55b54` links the distinct Workflow instance and R2 namespace. `cf` observed zero namespace objects and a 404 for that instance. The canonical October manifest size, ETag, and SHA-256 metadata matched before and after deployment.

The Worker is unarmed. The observed `cf` credential expires at 03:16:39 UTC, and the schedules API guards have no supplied `CLOUDFLARE_API_TOKEN` valid through cleanup and final readback. If the propagation cutoff passes, prepare a new event and version. No snapshot publication ran in this window as part of deployment verification.

Cloudflare rejected a single-Worker user token with `1001` because granular roles require an account-owned token. The account-owned attempt with the default identity returned `9109`. The existing provisioning profile also returned `9109`, and its permission listing marked `Individual Workers Editor` as unavailable. Automatic approval review refused a new OAuth profile with broader write access. No credential was issued. Each November guard now verifies token expiry with Cloudflare and requires an acknowledged empty calendar write before it reports readiness.

## November 22 streaming snapshot verification

The [tracked streaming command](../scripts/verify-staged-snapshot.ts) verified the full retained November reference locally. All 238 artifacts totaled 389,760,843 bytes, and the row parts and checked index agreed on 277,666 rows. Both canonical reads matched the 44,627-byte October manifest pinned at `78c979e9a36ecd2215e4c16c9b0ab6df3ad7dfe6f5efe20addf4f471ac3e3e1e`. The staging request path also passed an offline replay using the actual prepared packet and reference bytes, with exactly 240 logical GETs. All 198 affected tests and four TypeScript checks passed. Hosted artifact verification remains open until the qualified November instance publishes its output. [Verification procedure](V1-SCHEDULED-PUBLICATION-REVIEW.md#before-a-hosted-proposal-is-executable)

## November 22 serving and acquisition preparation

The November serving dataset combines 20 original calibration cases and 64 independent holdout cases. The existing label verifier checked 30 immutable November XML blobs and all 60 positive labels. Four blobs changed. The questions, gold identifiers, row text digests, source excerpts, and 24 scope exclusions were preserved. A separate local check matched all 60 positive rows in the retained November snapshot. [November label proof](evidence/2026-11-22/november-serving-label-verification.json)

The D-02 suite contains eight English and French answer and refusal cases. The offline preparation command pins the target and named reviewer and hashes each serialized request body. The checker refuses reviewer substitution and requires the reviewer to record the answer language and account for the entire answer. The shared chat route localizes empty-material refusals with no generation call. The cases need a hosted target, named independent reviewer, and reviewed request budget before capture. [Chat acceptance procedure](V1-EVALUATION.md#d-02-bilingual-chat-claim-review)

The MP-04 fixture session checks the capture producer's sizes and digests, then reopens the sealed source facts, raw capture, normalized auth, and downloaded SQL before issuing its receipt. Nine fault cases cover same-size edits during and after capture phases, including a changed export descriptor during the second KV view and SQL changed just after download acknowledgement. The tests preserve failure evidence and the existing request budget. Production ownership, maintenance controls, and authenticated acquisition remain open. [Acquisition seal checks](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md#offline-session-seal-checks--2026-11-22)

The 466 serving and chat tests, 193 acquisition tests, all four TypeScript checks, and both local workerd probes passed. Local disk exhaustion interrupted the full suite and subsequent combined reruns. The protected-copy case that failed during the serial run passed in isolation. The corpus invariant check skipped three absent generated artifacts.

After disk cleanup, the full local suite passed **2,342 tests in 111 files** with workerd enabled and the repository-pinned Bun 1.3.5. All four TypeScript checks passed on the same runtime. The first post-cleanup run used the machine's default Bun 1.4.4 and failed the exact runtime check in five protected-copy cases. The pinned rerun passed those cases. This evidence covers the local working tree. The release still requires clean-source qualification and hosted acceptance.

The product owner approved D-01 with accuracy first, speed second, and freshness third. The approved limits cover both official languages and distinguish the currently observed head from a separately approved recent ancestor. The offline acceptance checker now recomputes quality, latency, and freshness from the reviewed inputs and report observations. All 74 focused tests and four TypeScript checks passed. The hosted serving packet still needs exact candidate binding, integration with the approved freshness check, and its reviewed request budget. [Approved serving bar and checker](V1-EVALUATION.md#d-01-serving-decision)

## November 22 MP-03 staging packet preparation

The [request packet](STAGING-REQUEST-BUDGET.md#november-d-01-run-packet) accounts for 131 relay attempts across calibration, holdout, and benchmark, including three discovery requests. The commands select the verified November dataset explicitly. Its offline source check again matched all 60 positive labels and retained all 24 scope controls. The D-01 checker now requires the reviewed encoder model and dimensions in all three discovery responses. All 124 focused tests and four TypeScript checks passed.

The retained November Git source makes the Linux-qualified `3f16f93` commit available for comparison. Its fixed empty chat reply predates the French response in the current worktree. The previously reviewed API and serving operator source was absent from the checked local and Chester Hill Solutions packet locations. MP-03 still needs a clean exact candidate, a reviewed successor operator, current API and corpus provenance, and finite approved request windows. The role-separated D-02 capture and one-request Zen diagnosis have their own scope.

## November 23 clean MP-03 candidate

The isolated candidate `44ce56fb7cf3a23c7cc22b88d42221b10dd9c6a3` freezes the current release inputs on `3f16f93`. Its source tree is `0a4fdd0a888d43fdaf7b570a30dae7f3469ba031`. The verified Git bundle and successor review archive are retained locally under `dist/release/mp03-44ce56f/`. The checkout remained clean after validation.

The frozen Bun 1.3.5 install and Node 24.22.3 rerun passed 2,356 tests across 112 files, 31 Python process-owner tests, all four TypeScript projects, both workerd probes, and 117 vendored file checks. Billing and corpus invariant checks passed. The latter skipped three generated ingest files absent from the checkout. The first run used Node 26 and failed two Unicode citation cases. Both passed on Node 24.

All five Worker modules bundled locally with esbuild. The exact API module hashes to `744a275609a49838942b99118a5cfbb45508a19c3d1d792f864611a8344b13a2` and passed its local workerd health, encoder discovery, and authentication smoke with outbound access disabled. The D-02 draft binds this candidate and November source with the product owner as reviewer and proposes Zen `claude-haiku-4-5`.

Draft PR #1 fast-forwarded to `44ce56f`, and its [Linux validation run](https://github.com/chester-hill-solutions/civicsignal/actions/runs/45171176702) passed. Before the staging upgrade, version `3efd1935-39ea-41da-b19c-e8bbf495b50d` served 100% of isolated staging traffic. Its D1 database reported October revision `0507465`, parser `statutes-v2`, 277,857 rows, and no publication guard table. The upstream head was the verified November revision `855cdfc`.

## November 23 isolated staging refresh

Cloudflare acknowledged migration `0009` on staging D1, and a schema query confirmed `corpus_publication_guard`. Staging deployment `fb86549b-9c48-4043-8e6f-70f251352942` routes 100% of traffic to API version `5e17cb94-2365-40c8-a0e0-6418e26cd3cb`. The uploaded module matches the reviewed `44ce56f` bundle by SHA-256. All 13 existing bindings matched, including the authorization database and usage Durable Object namespace. The staging health endpoint returned success.

The staging R2 bucket returned all 238 verified November objects, totaling 389,760,843 bytes. The November manifest was written after the data and matched SHA-256 `43fdb9961b0980769552df1993e106beba8f3a354ecf9bd3fbd11091ea25ba34`. An independent read matched the October manifest byte for byte.

The November pipeline uses a separate coordinator instance with a 1,450-document embedding cap. The original October coordinator stayed paused. The initial run stopped before any embedding or corpus writes because GitHub returned HTTP 401 for the inherited credential. A staging-only probe confirmed that the public source returned the pinned revision and that R2 returned the matching manifest. Pipeline version `78e326dc-39be-4a7b-bc96-deff1a493359` resumed from the public source with the same commit and date checks. The November coordinator resumed at revision 2 with its budget intact.

The staging encoder spent several minutes on each of its first full embedding batches at 0.5 vCPU. The November coordinator closed admission at revision 3. Container rollout `e43f42de-6544-4103-b4b5-76987128fb9e` routed the single staging instance to the same image with 4 vCPUs. Staging-only pipeline version `d6c68e65-1e23-4b9a-85ad-a1e79869305a` limits each reconciliation cycle to 384 row changes. The drained checkpoint contained 96 row changes and 72 written document vectors, matching all 72 reservations. The same coordinator resumed at revision 4 with the original 1,450-document cap.

The next cycle committed its 25 submitted document vectors before GitHub's anonymous REST quota returned HTTP 403. Version `96022882-378f-4aec-9b33-07fdb8b91ce6` checks Justice Canada's public Git advertisement at the same boundaries. It verifies that both `HEAD` and `refs/heads/main` identify the pinned commit. The hosted probe passed. The coordinator resumed at revision 6 from 97 written vectors and 128 row changes with its original budget. [Git HTTP ref discovery](https://git-scm.com/docs/gitprotocol-http)

At 13:53 UTC the staging publication finished at `855cdfc65207a6906c414e09a77d7f93267c5356` with parser `statutes-v2`. D1 reported 277,666 physical rows and 1,027 added, 471 changed, and 1,218 removed provisions. All 1,450 submitted document embeddings were written. The 768-dimensional Vectorize index held 254,478 vectors and processed the exact final mutation, `aa10c074-8753-4846-9a19-ba3c82da9455`. The guard cleared, the outbox was empty, and the coordinator was suspended at revision 7 with no active work or alarm. Bilingual serving and independent claim verification remain open.

Container rollout `d37230d2-53b3-427d-805f-cf1b0c73d8cf` returned the staging encoder to its original 0.5 vCPU and 4 GiB configuration. Cloudflare reported all traffic on that configuration with the same image.

## November 23 hosted serving and chat acceptance

The isolated staging API served candidate `44ce56f`, Worker version `5e17cb94-2365-40c8-a0e0-6418e26cd3cb`, and corpus `855cdfc`. The upstream observation matched the published revision. The run verified the deployed bundle and bindings, settled D1 publication, a matching R2 provision sample, the Vectorize watermark, and the existing encoder image. The local relay used Bun 1.4.4.

D-01 spent all 131 relay attempts. The three discovery requests and 128 retrieval requests completed, including 20 fresh calibration cases and all benchmark warm-ups. Jev returned upstream HTTP 402 on all 128 retrieval calls, which used uncached vector fallback. The offline checker accepted freshness and the completed-client benchmark p95 of 2.17 seconds at concurrency 1 and 2.46 seconds at concurrency 4. It rejected accuracy in both languages.

| Holdout measure | English | French |
| --- | ---: | ---: |
| Correct provision at rank 1 | 13/24 | 10/24 |
| Correct provision in the top 5 | 17/24 | 15/24 |
| False refusals | 4/24 | 6/24 |
| Nonempty results missing the correct provision | 3/24 | 3/24 |
| Unsupported cases accepted | 0/8 | 0/8 |

Both languages found the correct provision in 11 of 24 answerable pairs. The held-out answers remain evaluation evidence for this candidate.

D-02 used a separate eight-attempt relay and the fixed bilingual plan for OpenCode Zen `claude-haiku-4-5`, with product owner review. All four unsupported questions returned the fixed refusal without generation. The answerable English federal election question also refused because retrieval returned no material. The other three answerable requests reached Zen and returned staging HTTP 502 with provider HTTP 402. There were no generated answers for independent factual claim review. The operator revoked and verified the temporary staging retrieval key. The local reports, bounded ledgers, exact chat captures, and review template are in `dist/evaluation/2026-11-23-mp03/`.

## November 23 labour-board query probe

Two English searches used the November staging corpus `855cdfc` and returned HTTP 200 through vector fallback. “labour board law” returned zero results. Its best vector score was `0.61503243`, below the `0.62` floor. The phrase leaves the board, jurisdiction, and legal issue open.

“What powers does the Canada Industrial Relations Board have under the Canada Labour Code?” returned five results. Section 9 of the Code ranked first and establishes the Board. The other four results were from its regulations. Section 16, which sets out the Board's powers in proceedings, was absent from the top five. This search reached the right federal instrument and missed the provision that answers the question. [Canada Labour Code, section 9](https://laws-lois.justice.gc.ca/eng/acts/L-2/section-9.html) · [Canada Labour Code, section 16](https://laws-lois.justice.gc.ca/eng/acts/L-2/section-16.html)

The two responses are preserved locally in `dist/evaluation/2026-11-23-recall-hillclimb/labour-board-staging.json`. Use them as separate development cases for scope clarification and provision ranking. [Query interpretation experiment](V1-EVALUATION.md#plain-language-query-interpretation-experiment)

## November 23 staging DeepSeek Zen recovery

At 10:19 a.m. Toronto time, one approved `/api/chat` request on OpenCode Zen `deepseek-v4.1-flash` returned HTTP 200 under the 128-output-token cap. The answer named the Canada Health Act and used the retrieved section 8 citation. Exact retrieval used the November corpus `855cdfc`, parser `statutes-v2`, and no encoder, Vectorize, or Jev calls. The relay recorded one attempt and the temporary staging retrieval key was revoked. [Canada Health Act section 8](https://laws-lois.justice.gc.ca/en/acts/C-6/section-8.html)

Staging deployment `8161714d-4f9f-433b-84a7-cf89e1a4d7cb` serves version `43b5ef59-48dc-4de5-94e6-08da3e410fa6` at 100%. The verified bundle adds the DeepSeek adapter to the `44ce56f` base and preserves the 13 staging bindings. The local acceptance receipt is under `dist/evaluation/2026-11-23-zen-deepseek/`. The eight-case bilingual claim review remains open.

## November 23 hybrid serving candidate

The isolated staging API served Worker version `e48cedbc-d147-4113-99e7-c3fd266a2aab` at 100% through deployment `3f445cb8-cd9c-4079-ad41-d5d80f55d7b7`. The module readback matched SHA-256 `0d632b725f822bc39cd27822142df513e051fac9ed50637463b70a00dfa11173`. The existing 13 staging bindings matched. The version added a staging-only hybrid toggle and an encrypted retrieval-provider credential. The November corpus uses the same staged D1, R2, encoder, and Vectorize resources. A two-object R2 lexical index contains 84,285 canonical in-force provisions across 1,781 Act-language scopes.

The first hybrid HTTP calibration found all ten expected provisions and refused all four unsupported cases. A French clarification returned HTTP 502, and client p95 was 8.687 seconds. The second version added a jurisdiction guard for personal employment questions, shortened the requested evidence quote, and recorded stage timings. Its authenticated replay completed all 16 requests, found all ten expected provisions, refused all four unsupported requests, and recorded both clarifications. Client p95 was 6.069 seconds at concurrency four. The exact-citation smoke used the existing exact path. Both temporary retrieval keys were revoked and verified. The replay used the same calibration prompts. D-01 still requires the independent holdout and two-level benchmark.

All four TypeScript projects and all 2,364 tests passed on the repository's pinned Bun and Node runtime with local workerd enabled. The bundle, source, deployment proof, both calibration reports, and frozen calibration inputs are recorded in `dist/evaluation/2026-11-23-hybrid-serving/`. [Hybrid evaluation](V1-EVALUATION.md#november-23-hybrid-jurisdiction-and-evidence-check)

## November 23 hybrid D-01 calibration

The formal run opened at 17:14 UTC for Worker version `e48cedbc` and source `3d2c6af`. The module, bindings, settled D1 publication, R2 provision sample, both lexical index objects, encoder image, and Vectorize watermark passed readback. The November dataset matched Justice Canada's upstream head `855cdfc` at 17:13 UTC.

The relay reserved 21 of 131 attempts. Discovery passed. Nineteen of 20 fresh searches completed. Top-five results covered four of six English and all six French answerable cases. All eight unsupported questions returned no provisions.

The English Criminal Code provision 334 question returned HTTP 502 after the evidence quote failed the source-text check. The English Privacy Act provision 8 question returned an insufficient-evidence refusal. An offline replay put the Privacy Act provision first in literal lexical ranking. The hosted candidate set and evidence decision need separate diagnosis. The operator stopped before holdout and benchmark. It verified temporary key revocation and relay shutdown.

The local repair retries a nonmatching quote once within the existing five-second evidence deadline. It still requires a literal match before it returns a provision. The HTTP regression reproduced the 502, then confirmed recovery with matching evidence and continued failure for a second mismatch. All four TypeScript checks passed.

The first clean-checkout run found a stale Postgres fixture and two protected-state test timeouts. The successor includes the existing fixture correction and rebuilds the same Worker module. The isolated recheck passed all 337 tests across the two affected suites and the HTTP endpoint suite. The repair needs fresh staging evidence.

The report, provenance, calibration ledger, and revocation receipt are in `dist/evaluation/2026-11-23-hybrid-serving/`. Its `evidence-retry/` directory holds repaired source `65bd7ff`, module, staging dry run, and proposed request scope. The eight-case D-02 draft pins this successor and needs a D-01 pass before capture. [D-01 criteria](V1-EVALUATION.md#d-01-serving-decision)

## November 23 repaired hybrid D-01

Isolated staging deployment `6942c513-3556-4ee9-b28e-1a80320745fe` serves version `17dcf4a5-a750-417f-b8f2-8736d053a659` at 100%. Source `65bd7ff` uses the new evidence retry policy. Readback matched module SHA-256 `74745d0ad135bfd4df3095848b7a629af794e638ae60d75a48c807e1ca2f07a6` and all 15 staging bindings.

The served November revision `855cdfc` matched the observed Justice Canada head. D1 publication was settled. The provision text sample, both R2 lexical objects, the Vectorize watermark, and the encoder image matched the approved inputs. The D-01 packet uses a new ledger for 131 attempts over 20 minutes. It binds the frozen source, exact Worker version, and unchanged evaluation labels. [Request budget](STAGING-REQUEST-BUDGET.md#november-d-01-run-packet)

All 20 fresh calibration searches completed with valid observations. Top-five results covered five of six English and six of six French answerable cases. All eight unsupported cases returned no provisions. The Criminal Code provision 334 case returned the expected English provision on the first evidence call. The English Privacy Act provision 8 case still refused.

The independent holdout attempted all 64 searches and completed 61. Discovery passed. Both languages found the correct provision in 20 of 24 answerable pairs, up from 11 pairs on the earlier vector run.

| Holdout measure | English | French |
| --- | ---: | ---: |
| Correct provision at rank 1 | 20/24 | 23/24 |
| Correct provision in the top 5 | 20/24 | 23/24 |
| Earlier vector run, top 5 | 17/24 | 15/24 |
| False refusals | 1 | 0 |
| Nonempty results missing the correct provision | 1 | 0 |
| HTTP 502 responses | 2 | 1 |
| Unsupported cases accepted | 0/8 | 0/8 |

One failure reached the five-second interpretation deadline. One evidence exchange failed before returning a valid decision. One quote mismatch triggered the retry and reached the five-second evidence deadline. Encoder and Vectorize calls succeeded on all 64 requests.

D-01 failed completeness and missed the English top-five bar of 22 of 24. The relay stopped at 86 of 131 attempts before either benchmark level. Completed holdout p95 was 6.14 seconds at concurrency one. That measure applies to the holdout. The operator closed the relay and verified temporary key revocation at 17:57 UTC.

The deployment readback, provenance, reports, relay ledger, and cleanup receipt are in `dist/evaluation/2026-11-23-hybrid-serving/evidence-retry/`. Keep these holdout results separate from development input. D-02 remains open. [D-01 criteria](V1-EVALUATION.md#d-01-serving-decision)

## November 23 D-02 offline packet

The product owner accepted the measured recall for continued pre-alpha work and deferred further recall tuning. The D-01 result and release checks remain open.

The packet pins source `65bd7ff`, staging version `17dcf4a5`, corpus `855cdfc`, and OpenCode Zen `deepseek-v4.1-flash`. Offline checks reproduced all eight request bodies and hashes from the frozen source. The checker rejected the empty capture and review templates. All 390 focused local tests passed.

The proposed scope is eight chat POSTs in 12 minutes with a 256-token generation cap per case and a new ledger. No hosted window opened. Execution needs separate budget approval. Capturing before D-01 qualification also needs an explicit staging sequencing decision. The independent product owner reviews every factual claim against literal excerpts from the same request's retrieved material.

The plan, requests, proposed scope, templates, and offline checker receipt are in `dist/evaluation/2026-11-23-hybrid-serving/evidence-retry/d02-offline/`. [D-02 procedure](V1-EVALUATION.md#d-02-bilingual-chat-claim-review)

## November 24 citation boundary repair

The MP-03 packet recorded two citation tests that failed only on Node 26. The destination check compared the two code units before a URL, so an astral character such as U+10400 or U+1D7D9 passed as a separate prefix instead of a word character glued to the link. V8 also mis-evaluates the anchored Unicode property class that rule used. The check now reads one code point and tests the class without the anchor.

All 146 citation cases pass on Node 26.3.1, where they previously failed, and the complete `bun run validate` passes on the pinned Bun 1.3.5: 146 test files, 2,541 passed and 8 skipped, four TypeScript projects, both workerd probes, and the runtime, billing and corpus invariants. This source is not the reviewed MP-03 candidate; a hosted operation still needs its own refresh and approval.

## November 24 code assessment reconciliation

The audit checked local source `8302892` with disposable fixtures and read-only archives. It made no new hosted requests. The [master plan](PLAN.md#immediate-work-order) owns the resulting work order.

| Local check | Observation |
| --- | --- |
| Vitest and runtime | On macOS arm64, Node 24.22.3 and Bun 1.4.4 with loopback access, 2,559 tests passed, five failed, and ten skipped across 149 files. All five failures passed in a 41-test rerun with the CI-pinned Bun 1.3.5. The Workerd usage and R2 checks passed. |
| Type, bundle and static checks | Four typechecks, five Worker dry-run bundles, the lint ratchet, vendor integrity, and billing and corpus invariant scripts passed. The corpus script skipped three absent statute exports. |
| Archive-backed HTTP | Seven checks passed using local archives. They cover bilingual committee and funding research, parliamentary catalogues, committee calls, consultations, and directory lookup. These checks corroborate local preview status. |
| Python | On Python 3.14.3, the 159-case discovery suite recorded two errors. The separate parliamentary vote suite passed eight tests. The protected-copy Python suite passed 31 tests with Bun 1.3.5. |

These runs do not form a single full pass on the pinned runtime. Matching clean Linux evidence is source-specific.

| Finding | Trigger and observed result |
| --- | --- |
| Exact citation parity | A synthetic named provision returned through HTTP `/api/brief` and MCP `cite_provision`. MCP `brief_topic` sent the same question to an empty vector stub and returned zero provisions. [HTTP resolver](../src/index.ts#L259) · [MCP topic handler](../src/mcp/server.ts#L74) |
| Chat follow-up | After a turn named the Act, chat sent only “And how long is it?” to the encoder. Empty results skipped generation. An explicit `topic` recovered the provision. [Chat query](../src/routes/chat.ts#L329) |
| Chat claim support | A fake provider asserted an unsupported 99-day minimum with a valid retrieved link. Chat returned HTTP 200. This repeats the [November 22 finding](#november-22-local-code-assessment) on newer local source. [Citation check](../src/routes/chat.ts#L353) |
| Committee clone | The clone refused four intake tables in the prior store. An empty target with the documented preview migration reproduced the refusal and retained zero served rows. Standard materialization and identical replay passed on a separate target with the same migration. [Migration](../preview/committees/migrations/0001_committee_preview.sql#L61) · [Clone guard](../scripts/materialize-committee-corpus.py#L337) |
| House Journals replay | The fixture's live clock admitted sitting 171. Its fake fetch supplied sitting 122. The replay passed when `date.today()` returned November 23, 2026. [Replay test](../test/test_parliament_house_journals.py#L112) · [Collector](../scripts/parliament-house-journals.py#L349) |

The audit reproduced the two November 23 holdout scores offline. Both ran 64 fresh `/api/statutes` requests at concurrency one. They used the same corpus revision and [labeled cases](../src/eval/data/v1-november-questions.json).

| Staging policy | Rank 1 | Top five | HTTP 502 | Holdout p95 across all attempts |
| --- | ---: | ---: | ---: | ---: |
| Uncached vector fallback | 23/48 | 32/48 | 0/64 | 5.11 s |
| Repaired hybrid | 43/48 | 43/48 | 3/64 | 6.57 s |

Jev returned HTTP 402 in the earlier run. The vector figures measure fallback. Both policies accepted zero of 16 unsupported questions. Hybrid reached 20/24 in English and 23/24 in French. Its 502s occurred in interpretation, evidence exchange, and evidence retry. Hybrid stopped before the D-01 benchmark. Its completed holdout p95 was 6.14 seconds. [Vector fallback run](#november-23-hosted-serving-and-chat-acceptance) · [Hybrid run](#november-23-repaired-hybrid-d-01)

The prior positive Zen smoke covers one exact question on its recorded target. Live answer quality, current hosted availability, and production freshness remain open for the assessed source.

## November 24 offline readiness for MP-02 and MP-04

The focused check used tracked runtime source `8302892491f4dda2cf8871bd0b001805abbca3e4`.
All 413 tests in 12 files passed on macOS arm64 with Node 24.22.3 and Bun 1.3.5.
MP-02 accounted for 220 checks across proposal, calendar, admission, runtime, and artifact verification.
MP-04 accounted for 193 checks across capture, source facts, transport, and session sealing.
The tests used local fixtures and synthetic credentials. The two hosted gates remain open.

### MP-02 scheduled first publication

The last recorded staged deployment is `4cbfc139-4d85-416d-967c-f90ea4e9b343` with version `ce6deccb-c345-43ca-9fe5-b6c7d0b04836`.
Its November 23 cutoff passed. The recorded account-token requests failed, and automatic approval review refused broader OAuth access.
The next packet needs a new UTC event and a version that binds its exact tuple and runtime deadline.
The account administrator must confirm authority for the isolated Worker Script Schedules API.
Provide operator and cleanup guard credentials that remain valid beyond the cleanup deadline plus the final request bound.
Budget the arming lead and both independent guard readiness checks before the propagation cutoff.
[Prior publication version](#november-22-staging-publication-version) · [Calendar admission](../scripts/lib/snapshot-calendar-window.ts#L152)

The retained packaging command and artifact verifier pin the November `855cdfc` reference and its exact stage bundle.
Reuse those pins only if the reviewed source and the upstream head at admission still match. A new reference requires corresponding candidate and verifier pins.
Complete the owned connection between the calendar runner, publication admission, and the artifact verifier.
That owner needs current deployment and Workflow evidence, an unused instance and namespace, and the canonical backup observation.
The November procedure counts 18 calendar requests and 240 artifact GETs separately from source, management, and other R2 operations.
Acceptance needs the scheduled event, first complete snapshot, canonical preservation, and both guards' cleanup receipts.
[Hosted calendar wrapper](../scripts/lib/snapshot-hosted-admission.ts#L69) · [Verifier](../scripts/verify-staged-snapshot.ts#L74) · [Qualification procedure](V1-SCHEDULED-PUBLICATION-REVIEW.md#before-a-hosted-proposal-is-executable)

### MP-04 consistent production acquisition

The offline fixture checked source facts before and after KV view A, one continued D1 export, and KV view B.
It downloaded the signed SQL from the pinned origin and checked raw data and SQL seals before receipt.
The current transport admits only injected fixture IO and synthetic credentials. A production process owner and authenticated transport remain open.
[Session implementation](../scripts/lib/protected-acquisition-session.ts#L102) · [Transport admission](../scripts/lib/protected-acquisition-transport.ts#L144)

The previous inventory is historical. The release engineer must privately confirm current versions, bindings, actual schema, and the authoritative stores for corpus, keys, and billing.
The pipeline owner must account for scheduled, manual, and any alarm-driven writes and show that in-flight work drained.
The identity and billing owners must identify request-driven and administrative writers. The candidate key verification writes both key timestamps.
Include any operator scripts, migrations, and other jobs that write the captured stores.
Named writer owners must agree on one interval and record drain evidence, abort conditions, and who can reconcile or resume writes.
Keep the original usage namespace bound to its own identity and record the verified control for each writer.
[Prior inventory scope](#october-31-implementation-progress) · [Candidate key writes](../vendor/@chester-hill-solutions/auth-d1/dist/api-key.js#L55) · [Production acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md#gaps-conflicts-or-redundancies-to-fix)

The approved packet must bind the exact owner, resource identities, maintenance observation, and signed-download rules.
Count preflight, writer control, both source-facts reads, export, KV, download, local seal checks, and cleanup in the complete budget.
The earlier 2,080-exchange bound covers the partial collector. It does not qualify the older 2,200-call proposal.
Confirm the sealed inputs at handoff before MP-05 uses the production capture.
[Acquisition accounting and handoff](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md#gaps-conflicts-or-redundancies-to-fix)

## November 24 local serving and intake repairs

This local worktree starts at `8302892491f4dda2cf8871bd0b001805abbca3e4`. The code and test patch has SHA-256 `e3fc2c872896786b79e2a6eb01a0af97fb554069fac54f8592c102dd9bede655`. Reproduce it with `git diff --no-ext-diff --binary --full-index 8302892 -- scripts src test | shasum -a 256`. Final Linux and hosted qualification remain open.

| Change | Local evidence |
| --- | --- |
| Exact citations | HTTP `/api/brief` and MCP `brief_topic` and `statute_lookup` used the same revision-bound resolver. Each successful request used one unit and made zero encoder or vector calls. The English and French tests used `section` for present and missing provisions. The shared parser still needs support for French `article` in free text. Structured exact lookup accepts an Act title and section number in either language. [Endpoint tests](../test/endpoints.test.ts) |
| Chat follow-ups | The owner selected one previous user question as context for a short follow-up. The bounded query uses both questions. In the HTTP regression, the follow-up retrieved section 1 and called the fixture provider once. An explicit topic requested missing section 99 and skipped generation. Each request used one unit. [Chat tests](../test/chat.test.ts) · [HTTP tests](../test/endpoints.test.ts) |
| Committee publication | A native APFS clone accepted a fresh migrated target and a legacy serving-only target. A second clone preserved target bookkeeping, migration sequence values and file permissions. An unknown schema or migration left the previous generation intact. The standard materializer passed its replay and rollback tests. [Native and standard tests](../test/test_materialize_committee_corpus.py) |
| House Journals | The bilingual fixture used the November 23 cutoff and exact edition URLs. A failed edition fetch retained the complete prior inventory. The next successful replay returned the same records. [Journals tests](../test/test_parliament_house_journals.py) |
| Freshwater staffer packet | The offline replay reproduced all five published briefs byte-for-byte. The staffer still needs to review the two deadlines, Q-1010, and the Charlo lead. [Review packet](../preview/policy-files/freshwater-2026-05-25/BRIEFS.md#staffer-review) |

A separate APFS run used disposable copies of the acquired committee store and the existing local D1 target. For the November 24 00:07:12 UTC cutoff, the clone verified 33,894 records, 88,788 links, and 1,755,636 passages. The full-text probe matched 8,025 passages. Four authenticated Worker checks passed against the clone, including English and French funding research.

Six additional local HTTP checks passed against the parliamentary catalogues, GEDS, consultations, and written questions, including the GEDS transfer fixture. These ten checks require database paths and skip in the default suite.

On macOS arm64, Node 24.22.3 and Bun 1.3.5 passed 2,587 Vitest tests across 149 files with Workerd enabled. Ten database-dependent tests skipped in that run and passed separately. Python discovery passed 162 tests. The separate protected-copy and House vote suites passed 31 and eight tests, respectively.

All four TypeScript projects, the lint ratchet, vendor verification, billing checks, and five Worker dry-run builds passed. The Workerd usage and R2 checks passed. The corpus invariant check skipped three absent generated statute exports.

## November 24 staging publication readback

The isolated November Worker still served the pinned version at 100%. Its Workflow listed zero instances. The staging backup matched the pinned October manifest byte for byte. The source revision remained `855cdfc`. The local operator now checks both cleanup acknowledgements, the scheduled event and Workflow receipts, and the reference artifacts. No staging event was armed during this observation. [Live cf receipt](evidence/2026-11-24/staging-publication-cf-baseline.json) · [Acceptance checks](evidence/2026-11-24/snapshot-publication-composition.md) · [Master plan](PLAN.md#mp-02-qualify-scheduled-first-publication)

## Remaining release gates

All four gates remain open: scheduled first publication, serving acceptance, production migration, and the final release audit.
MP-01 receipts qualify the sources they identify. Bind each hosted operation to its reviewed source and target under the [MP-01 checklist](PLAN.md#mp-01-reconcile-the-exact-candidate).
The [master gate table](PLAN.md#release-gates-at-a-glance) defines completion evidence.
The [master package checklist](PLAN.md#phase-1-close-the-v1-release) defines remaining work, dependencies, and responsible roles.
The [decision register](PLAN.md#decisions-still-required) records the required dispositions before execution.

Keep dated observations and failures in this ledger; update priorities and next actions only in the master plan.
Use [v1 operations](V1-OPERATIONS.md), [evaluation](V1-EVALUATION.md), and the [acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md) for their detailed procedures.


### November 24 evening local pipeline runs

The installed daily job completed its first kickstart in 186.556 seconds. All three intake and serving checks passed. Four authenticated Worker cases passed against the acquired databases. A second kickstart reached a funding acquisition failure before the new in-process Worker verification. At 21:52 Toronto the installed job passed all three sources and all four embedded authenticated Worker cases in 181.502 seconds. The regular 06:15 Toronto occurrence remains to be verified.

The weekly job is installed for Saturdays at 09:00 Toronto. November 24 kickstarts exposed insufficient free space for the heavy rebuilds. The second attempt also exhausted space while writing its final JSON. The job log retains its source outcomes. The two approved scratch directories were idle at removal. The immediate post-cleanup reading was 223 MiB free.

The [local activation evidence](evidence/2026-11-25/pipeline-activation.json) records per-source results, the institutional coverage sample, ECCC passages, and acquired federal disclosures. The [House](evidence/2026-11-25/hansard-house-2026-10-19.json) and [Senate](evidence/2026-11-25/hansard-senate-2026-10-19.json) receipts carry source hashes and citation samples for all 16 additional Hansard editions.

### November 25 weekly full run and selective retries

The full weekly LaunchAgent kickstart ran from 02:52:28 to 03:45:05 UTC and ended with 17 of 20 sources passed. The dated [full receipt](../dist/refresh-weekly/2026-11-25T03-45-05.917391Z.json) has SHA-256 `2c7468dc4ecb8e720f2404e7ca92946553a85cf2e0c680cd9e470fa576f309b6`. Federal discovery and guidance, all four federal bulk collections, ECCC and its two Worker checks, Gazette, briefing notes, report directories, publications, procurement and its object verification, Parliament, both current Hansard weeks, written questions, and GEDS passed. The full run is terminal and is not a release-wide unattended schedule qualification.

Three steps failed. Consultation notices archived 95 of 142 language editions, then exited on four official-page failures: CRTC English and French returned HTTP 403; CTA English reset the connection, and CTA French failed local certificate-chain verification. The federal-disclosures request timed out while reading from Open Canada. Committee catalogue acquisition stopped while checkpointing with `Too many open files`, after 444/444 and 1,338/1,338 indexes, then 200/3,116 in the next group. The existing published committee catalogue and database were preserved; the partial catalogue records 1,982 indexes and is incomplete. The [notice receipt](../data/corpus/consultations/notice-receipts/latest.json) and [partial committee catalogue](../data/corpus/committees/catalogue.partial.json) retain these remaining gaps.

The retries are distinct from that full run. The 02:48:31–02:49:21 UTC six-source selective retry passed federal disclosures, Gazette, briefing notes, both Hansard steps, and GEDS; see its [receipt](../dist/refresh-weekly/2026-11-25T02-49-21.474699Z.json). The subsequent 03:47:50–03:48:34 UTC two-source retry passed federal disclosures, but consultation notices again reported the same four page failures; its [receipt](../dist/refresh-weekly/2026-11-25T03-48-34.707300Z.json) is not a full-run success. The latest disclosures receipt is [receipt.json](../data/corpus/federal-disclosures/receipt.json), observed at 03:48:22 UTC with 1,339 records. A separate committee-only resume started around 03:56 UTC with a 256-descriptor limit; no terminal result was recorded by 03:57 UTC. The remaining completed-run gaps are the four consultation fetches and the incomplete committee catalogue.

Separately, current-session Hansard backfill captured October 5–9 (10 House and six Senate editions) and verified October 12–18 as quiet in both chambers. This historical October batch added 16 editions and 4,852 speech records. A later backfill verified the Senate quiet week of September 21–27 and the House quiet week of September 28–October 4, then added 10 House editions and 3,152 speech records for September 21–25 plus six Senate editions and 592 speech records for September 28, 29, and October 1. Those earlier packets passed authenticated Worker checks and their second replays changed zero editions; their counts are historical checkpoints. The completed backfill then reconciled the remaining 450 edition identities across 57 chamber-week records to the registered 45-1 calendar through November 22. Every newly archived original matched its recorded source hash, each weekly receipt contains one serving lookup sample per edition, and per-week replays left all imported editions unchanged. The canonical store now covers all 546 registered editions (338 House and 208 Senate) and contains 140,916 speech rows (111,332 House and 29,584 Senate). Four zero-edition receipts are documented separately as calendar-verified quiet weeks. The [complete session ledger](evidence/2026-11-25/hansard-session-backfill.json) contains per-week generation, manifest, receipt and source hashes, counts and checks. The earlier checkpoint receipts remain in the [activation evidence](evidence/2026-11-25/pipeline-activation.json); archives are under `../dist/hansard/weekly/` and the canonical store is `../dist/hansard/session-45-1.sqlite`.
