# CivicSignal v1 release plan

This is the execution checklist for the v1 goal started on 2026-10-22. It reconciles
the code audit, the CHS package review, `docs/PLAN.md`, and section 9 of
`~/.civicsignal/HANDOFF.md`. The checklist records verified outcomes, not intentions.
The production target is Cloudflare. Keep the existing Vectorize index and vectors.
Keep Railway running. Preserve unrelated work and the Postgres portability code.

## Release requirements

| ID | Outcome | Acceptance evidence | Status |
| --- | --- | --- | --- |
| V1-01 | One CHS identity and metering path for HTTP and MCP | Existing key hashes, customer IDs and counter identities survive migration; revoked/missing keys fail; capabilities apply; each successful retrieval consumes one confirmed unit; retrieval failures and protocol bookkeeping consume none; unresolved post-commit acknowledgements return an explicit uncertain 503 with operation ID for reconciliation | Local checks pass; hosted migration pending |
| V1-02 | Reproducible package installation and builds | Fresh tracked checkout installs with the frozen lockfile and imports every vendored export; package provenance recorded; Worker dry-run builds | Complete locally |
| V1-03 | Retrieval and BYOK correctness | Language and decision versions isolate cache entries; warm hits avoid reranking; input bounds, Google credentials and browser CORS pass regression tests | Complete locally |
| V1-04 | Recoverable ingestion | Injected faults between row/vector/feed/state writes recover without missing changes or duplicate events; Postgres transactions and D1 recovery cover the same contract | Local checks pass; hosted cycle pending |
| V1-05 | Automated immutable snapshots | Cloudflare Workflow creates bounded row parts and sorted index partitions per revision, publishes only complete manifests, and resumes after failure | Full local parity passes; hosted Workflow pending |
| V1-06 | Verified restore and corpus-text migration | Manifest/index/fingerprint integrity is enforced; backup and rollback exist; old/new reads and complete non-empty ingestion agree before live cutover | Local proof complete; live cutover pending |
| V1-07 | Broad, measured retrieval quality | Held-out English/French answerable and unsupported cases; backend-specific acceptance calibration; reported false acceptance/rejection and end-to-end latency/throughput/freshness | Pending |
| V1-08 | Honest, complete v1 surfaces | Every advertised route/tool is usable; unavailable corpora and geography are explicit; change-feed and exact citation flows are verified | Local route checks pass; hosted checks pending |
| V1-09 | Complete engineering gates | Worker, Bun, scripts and IaC type-check; endpoint and recovery tests pass; CI validates clean checkouts and builds without production credentials | Local and Linux release gates pass; Railway plan needs CI credential |
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
| Railway API migration and Cloudflare deletion | Superseded | The current handoff selects Cloudflare; keep Railway and portability code |
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
  Railway refuses the plan. Configure an authorized repository Actions secret before a future merge or apply decision.
  Never commit or print the token. This credential dependency does not change any Railway service.
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

Small evidence files live in [evidence/2026-10-22](evidence/2026-10-22/).
The large local artifacts remain outside Git. The commands can reproduce them from pinned source.

## Remaining release gates

1. Complete the approved hosted Workflow and compare every published artifact with the checked local source.
2. Check the approved live text migration and protected-table copy against a consistent production backup.
3. Configure the missing Railway CI project credential and check its read-only plan before any merge/apply decision.
   Local and Linux release gates pass. Keep Railway unchanged.
4. Run fresh calibration, held-out retrieval, and bounded performance checks against a verified serving target.
5. Check one non-empty automated publication and ingestion cycle with observed freshness.
6. Review the prepared migration and release candidate before any required deployment approval.

See [V1-OPERATIONS.md](V1-OPERATIONS.md) and [V1-EVALUATION.md](V1-EVALUATION.md) for procedures.
