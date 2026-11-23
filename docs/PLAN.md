# CivicSignal master plan

Updated 2026-11-22. All four v1 release gates remain open.

CivicSignal will give applications and agents source-cited Canadian civic information.
The first release serves Canadian federal statutes and regulations in English and French.
The immediate objective is to close four release gates: scheduled first publication, serving acceptance, production migration, and the final release audit.

This file owns scope, priorities, dependencies, decisions, and next actions.
The [release evidence ledger](V1-RELEASE.md) owns detailed results and source-specific receipts.
Supporting documents supply contracts, procedures, historical evidence, or future designs.
They do not create another work order.

## Immediate work order

1. **Qualify one exact Cloudflare candidate under MP-01.** Review the worktree diff and include the new migration, vendored billing patch, and fixture inputs in the candidate. Run the full local gate and the existing Linux CI gate against the same source. Record the exact commit and receipts.
2. **Prepare MP-02 and MP-04 in parallel.** Draft the scheduled-publication packet and confirm its reference artifact storage budget. Prepare the production capture owner and writer maintenance packet. Bind each packet to its reviewed source and current target facts before requesting execution approval.
3. **Prepare MP-03 in parallel.** Record the replacement D-01 acceptance criteria. Preregister bilingual D-02 chat cases, including exact request hashes, and name an independent reviewer. Rebind the staging API, serving, and Zen packets to the qualified candidate. Confirm their separate request budgets.
4. **Collect hosted evidence.** Qualify scheduled first publication under MP-02. Run serving and chat acceptance under MP-03. Complete the approved MP-04 capture before the MP-05 protected-copy, switch, and rollback checks.
5. **Complete MP-06.** Audit all ten requirements. Review the production switch and rollback packet. Record the approved operation's actual result.

MP-01 supplies the exact candidate for each operation.
Local packet preparation can proceed while MP-01 qualification runs. Freeze and execute each hosted packet only after its source and dependencies qualify.
MP-04 capture must pass before MP-05's production-derived proof.
The final production decision waits for MP-02, MP-03, and MP-05 acceptance.
Named operators and approvers remain execution prerequisites; role assignments below do not select them.

## Release gates at a glance

All four gates remain open. The ten [release requirements](V1-RELEASE.md#release-requirements) retain their individual acceptance checks.

| Gate | Packages | Completion evidence |
| --- | --- | --- |
| Scheduled first publication | MP-02 | A scheduled event creates a distinct instance and first complete publication; all artifacts match; canonical state and cleanup pass |
| Serving acceptance | MP-03 | Bilingual search and benchmark meet D-01. Positive hosted Zen chat, independent claim review under D-02, and advertised route checks pass for the qualified candidate. |
| Production migration | MP-04, MP-05 | Consistent production capture, hosted protected-copy proof, compatible switch, and authorization-preserving rollback |
| Final release | MP-06 | The exact final source passes engineering checks; all requirements reconcile; the approved production switch passes |

## Plan authority

The former product plan remains in [PLAN-HISTORY.md](PLAN-HISTORY.md).
The following dispositions resolve conflicts among the planning documents.

| Earlier proposal | Current disposition |
| --- | --- |
| Move the API to Railway and remove Cloudflare services | Use Cloudflare as the sole v1 runtime. Railway is an alternative deployment choice. |
| Drop reranking after the early retrieval experiment | Retain the current Jev authority policy and vector fallback; require new serving evidence for changes |
| Add news, debates, bills, tone, and geography in the first product wave | Defer expansion until the federal release and external demand supply entry evidence |
| Ship a hosted OpenCode harness or portal | Defer both; v1 exposes HTTP, MCP, and BYOK chat |
| Publish public snapshots, paid credits, or a fixed unit price immediately | Make separate distribution and commercial decisions after the release |
| Treat old local or hosted passes as current release acceptance | Bind each accepted result to its actual source, target, and scope |

The [reference map](#reference-map) identifies each document's role.
Existing execution constraints still apply; a newer priority does not renew an expired approval or consumed marker.

The latest corpus and serving observations date from October 24.
This document does not establish fresh remote state, credential validity, or a new request allowance.
Engineering must reconcile actual state before any separately authorized hosted work.

## Product direction

The product's value is a maintained, cited corpus with usable search, exact provisions, language control, revision evidence, and observed changes.
Customers can use their existing applications and agent tools through HTTP and the Model Context Protocol, or MCP.
Bring your own key, or BYOK, chat uses the customer's generation provider.

The longer-term direction joins legislation, bills, debates, news, and geography into a cited brief.
Candidate users include developers, government-affairs teams, researchers, campaigns, and newsrooms.
Demand must determine the first customer group and the next paid surface.
The Policorner wire keeps its own brand, accounts, and reader-facing product.

The sequence is: release the federal foundation, test external demand, select a paid use, then expand supported sources and surfaces.
A portal or hosted agent is a later product decision.
Phase 1 is the active implementation scope. Phases 2–5 require their stated entry evidence and decisions.

## Current release scope

| Included in v1 | Required behavior |
| --- | --- |
| Federal statutes and regulations | Exact provisions and semantic search in English and French; explicit status and source links |
| HTTP and MCP | Authenticated retrieval, live capability discovery, exact citation tools, and explicit unsupported coverage |
| Observed change feed | Bounded pagination over additions, changes, and removals; distinguish source dates from legal commencement |
| BYOK chat | Existing Anthropic, OpenAI, Google, and OpenCode Zen adapters; provider validation before successful usage consumption |
| Bring your own vector | `POST /api/match` accepts the published encoder contract; nearest matches do not establish answerability |
| Workspace authorization and usage | Shared CHS capability checks, key lifecycle, monthly allowance, and operation receipts |
| Corpus operations | Immutable snapshots, recoverable ingestion, verified provision text, complete backups, and a safe restore path |
| Production migration | Preserve current authorization, history, usage identities, vectors, and a compatible corpus rollback |

V1 excludes news, GDELT, debates, bills, provincial law, and riding, municipal, regional, or provincial filters.
It also excludes coverage tone and geographic distribution.
Requests and discovery must state these limits.

The following work remains deferred: external web answers, the hosted OpenCode harness, a portal, widgets, daily briefs, and commercial bulk licences.
OAuth, directory submissions, an Apify Actor, prepaid checkout, and a published unit price also remain deferred.
These exclusions do not remove snapshot, restore, migration, recovery, or serving-quality requirements.

## Decisions and invariants

1. **Use Cloudflare as the sole v1 runtime.** Keep the API, corpus pipeline, D1, R2, Vectorize, and encoder container in the existing account.
2. **Keep the alternative stack outside the release.** The Bun/Postgres code is a portability reference. The v1 dependency and acceptance lists contain only Cloudflare. Any future platform switch or change to legacy infrastructure requires its own decision.
3. **Preserve the encoder and index.** Keep the existing 768-dimension index and pinned encoder artifact, templates, and vector ordering.
4. **Separate exact citations from search.** Resolve named provisions structurally; a nearby provision cannot replace a missing exact provision.
5. **Keep language in identity and search.** English and French rows have distinct identifiers; apply the language filter before candidate selection.
6. **Keep the current rerank policy.** Jev authority decisions and the observed vector-floor fallback supersede the historical no-reranker proposal.
7. **Version semantic changes.** Bind cache entries and snapshots to source, parser, language, and decision contracts; retain immutable historical artifacts.
8. **Reuse CHS packages.** Extend shared auth, auth-d1, api-billing, and corpus emission paths instead of creating parallel implementations.
9. **Keep authorization independent of corpus rollback.** Retain the authoritative `AUTH_DB`, current keys and billing, and the original usage namespace.
10. **Preserve uncertain outcomes.** A usage acknowledgement failure can coexist with a committed unit; retain its operation ID and month.
11. **Separate faults from refusals.** Provider errors, unsupported coverage, and successful empty results require distinct evidence.
12. **Keep evidence claims narrow.** Local checks do not prove hosted behavior; a manual Workflow does not prove scheduled first publication.

Existing licence policies govern every source before emission.
A new source needs its own terms check and policy tests.
Historical legal, competitor, price, and margin statements do not establish current facts.

## Recorded baseline

Preserve these completed checks; do not repeat them merely to simplify the plan.
The [October 24 crosswalk](V1-RELEASE.md#current-closure-crosswalk--2026-10-24) retains their exact evidence and limitations.

- Shared identity, HTTP/MCP metering, key lifecycle, quota, and receipt checks pass locally.
- Staging reconciliation checks all 277,857 metadata rows, including 1,112 changes, and an empty pending outbox.
- The full staging text baseline, composite changed-text proof, and complete vector backup pass their retained checks.
- Manual hosted Workflow publication and all 240 artifacts pass parity; scheduled first publication remains open.
- Twenty-one serving smokes and the later cold/warm calibration pair pass; broad serving acceptance remains open.
- Protected-copy, schema, sequence, binding, client, and rollback mechanisms pass local checks; production-derived hosted proof remains open.

The retained holdout records 63/64 valid responses, Hit@5 of 40/48, and one false accept among 15 completed unsupported questions.
The benchmark retains a hydration failure and failed warm-ups.
Both failed runs remain evidence; later calibration does not replace them.
Composite text checks do not establish a fresh full-store byte audit.
The complete vector backup does not establish legacy embedding-model provenance.

The recorded serving ledger is **159/160**, with no new generation approval.
The recorded reconciliation use is **1,624 document attempts and 16 extension calls**, under cumulative limits of 1,752 and 20.
These balances describe the original bounded operations only.
Unspent slots do not authorize another operation, reset, retry, or replacement ledger.

## Implementation progress

The latest runtime source with matching local and clean Linux qualification is **`9771a8b`**.
Its [local gate](evidence/2026-10-31/integrated-candidate-local-validation-v11.json) and [clean Linux gate](evidence/2026-10-31/candidate-9771a8b-linux-ci-validation.json) cover 2,192 tests and 477 source and fixture inputs.
The assessment at **`518aab0`** used the same runtime and test inputs. Its local probes added five findings to [the release ledger](V1-RELEASE.md#november-22-local-code-assessment).
The local publication, search, cache, and quota regressions pass. The [integrated run](V1-RELEASE.md#november-22-integrated-v1-local-work) and the [later focused run](V1-RELEASE.md#november-22-cloudflare-release-preparation) checked different worktree snapshots.
Run one complete gate on the final source before it qualifies.
The qualified [source-loader repair closes issue 14](https://github.com/chester-hill-solutions/civicsignal/issues/14).
It compiles the exact checked source bytes; Python cache flags alone do not establish that identity.
The [release ledger](V1-RELEASE.md#october-31-implementation-progress) preserves earlier candidates, repairs, failed checks, and exact receipts.

| Package | Responsible role | Dependency | Current position and next deliverable |
| --- | --- | --- | --- |
| [MP-01](#mp-01-reconcile-the-exact-candidate) | Release engineer | Exact source for each operation | Review and freeze the current worktree. Obtain a complete local gate and its matching Linux CI receipt. |
| [MP-02](#mp-02-qualify-scheduled-first-publication) | Pipeline engineer and operator | MP-01 before execution | The offline verifier checks the pinned reference. Rebind the operator and confirm current calendars, resource identities, artifact storage, and the event budget. |
| [MP-03](#mp-03-close-serving-acceptance) | API, pipeline, billing, and evaluation owners | MP-01 candidate, D-01 policy, and approved hosted scope | Local corpus and chat quota regressions pass. Finish serving and Zen preparation. Collect independent claim evidence under D-02. |
| [MP-04](#mp-04-qualify-consistent-production-acquisition) | Release engineer and writer owners | Actual authority and common maintenance | The composed offline capture passes. Prepare the hosted owner, establish writer control, and acquire consistent production inputs. |
| [MP-05](#mp-05-qualify-protected-copy-and-production-rollback) | Migration engineer | MP-04 capture for production-derived proof | Local mechanisms pass; qualify hosted copy, production target, and rollback |
| [MP-06](#mp-06-qualify-the-final-source-and-release-packet) | Release engineer and product owner | MP-02, MP-03, and MP-05 acceptance | Draft candidate; complete final checks, requirement audit, and production decision |

The [runtime accounting](evidence/2026-10-31/snapshot-reference-accounting-runtime-v2.json) preserves the original successful-path baseline and records conditional callback bounds.
Those bounds do not establish a global provider ceiling or guarantee cancellation of stalled binding requests.

The first-publication and staging API operator successors passed local checks, source admission, and independent review for the earlier qualified candidate.
The earlier serving successor corrects a fixture-admission defect; its targeted checks and independent review pass for its recorded source.
Its unchanged mechanisms retain ten owned fixture cases and four lease checks; the successor does not repeat them.
The October 31 chat candidate passed the full local gate, matching clean Linux checks, and independent review.
All 477 inputs match the committed source and CI's actual merge checkout.
The earlier publication and API reviews qualify their recorded inputs. Recheck the parts that change for this candidate.

Serving preparation passes source binding for the earlier qualified runtime. Bind the new search policy and its producer under MP-01.
The serving freeze awaits the final candidate and the replacement D-01 criteria.
The Zen preparation retains the earlier source wrapper and skipped-generation regression. Its final bundle and review await the qualified serving producer.
Earlier fixture passes do not qualify later draft edits.
Scheduled-publication acceptance must inspect all nine settled owner chains and both completed cleanup guards.
Canonical artifact proof alone is insufficient.
The retained native Workflow calendar remains unknown; current admission refuses before deployment until an actual empty observation exists.

The [earlier local EPIPE failure](evidence/2026-10-31/integrated-candidate-local-observation-v7.json) and [inconclusive diagnostic](evidence/2026-10-31/restore-frame-diagnostic-observation.json) remain intact.
Later full passes do not explain that failure. [Issue 12](https://github.com/chester-hill-solutions/civicsignal/issues/12) remains open.
The repair, independent review, and complete local/Linux checks close the reproduced [relay abort defect, issue 13](https://github.com/chester-hill-solutions/civicsignal/issues/13).
Open public decisions also include [chat evidence, issue 4](https://github.com/chester-hill-solutions/civicsignal/issues/4) and [scheduled operation accounting, issue 6](https://github.com/chester-hill-solutions/civicsignal/issues/6).
The release ledger retains closed findings and their source-specific qualification.

A bounded read-only production inventory completes; its detailed evidence and maintenance finding remain private.
Deployed-source correspondence, auth authority, common maintenance, and actual acquisition remain open.
Source qualification supplies no new deployment, scheduled event, generation, maintenance interval, or migration approval.
Local storage headroom later recovers; the earlier storage refusal remains intact.
Preserve verified fixture archives, passing logs, failed observations, and unfinished candidates through continuation.

## Phase 1 Close the v1 release

Engineering owns implementation, source pins, checks, and the evidence packet.
The product owner decides acceptance policy, material scope changes, and separately bounded hosted or production actions.
Local preparation for MP-02, MP-03, and MP-04 can proceed alongside MP-01. Each operation must have its own source binding before execution.
Production cutover waits for all required evidence and the final decision.

### MP-01 Reconcile the exact candidate

The October 31 chat candidate retains its local and clean Linux receipts. The November 22 worktree has integrated and focused local evidence for its recorded snapshots.
**Requirements:** V1-02, V1-09, V1-10.

- [x] Retain the earlier source's complete local and clean Linux receipts.
- [x] Repair the helper loader and pass the complete successor local gate.
- [x] Retain matching clean Linux evidence for the successor's exact source and fixture inputs.
- [x] Pass the complete local gate and independent review for the changed chat candidate.
- [x] Retain matching clean Linux checks for the changed chat candidate.
- [ ] Review the worktree diff and freeze the exact source, including new migration, vendor patch, and fixture files.
- [ ] Run the complete local gate and matching Linux CI. Record the commit and any distinct CI merge checkout identity.
- [ ] Bind each operator, bundle, dependency, and source receipt to the qualified source it uses.
- [ ] Connect actual deployed identities and current requirement dispositions to the operation packet.

Retain the [whole-plan local verification](V1-RELEASE.md#november-22-integrated-v1-local-work) by source.
Preserve unrelated work, failed receipts, accepted artifacts, and consumed execution markers.
Distinguish deployed provider repairs from newer local code and unfinished private drafts.

**Exit evidence:** one source-specific inventory connects the ten release requirements to their current receipts and remaining tasks.
Use the [release evidence ledger](V1-RELEASE.md), [operations procedure](V1-OPERATIONS.md), and [writing rules](WRITING.md).

### MP-02 Qualify scheduled first publication

The shared runtime controls and offline reference check pass locally. Source rebinding, current execution inputs, and hosted qualification remain open.
**Requirements:** V1-04, V1-05, V1-09.

- [x] Reuse the Workflow, parser, builder, archive checks, and manifest-last publication path.
- [x] Qualify safe diagnostics and qualification-only retry, time, object, and progress controls.
- [x] Retain the predecessor operator's fixture and full-artifact comparison evidence.
- [x] Finish the operator successor's fixture repairs, complete checks, source linkage, and independent review.
- [x] Retain the earlier chat candidate's publication-operator rebinding and independent preparation review.
- [x] Check downloaded artifacts against the exact frozen reference manifest in the offline verifier.
- [ ] Rebind the publication operator to the MP-01 candidate and review the changed inputs.
- [ ] Freeze its bundle and configuration with a fresh namespace and distinct instance.
- [ ] Resolve calendar facts and residual platform uncertainty before selecting the executable event and budgets.
- [ ] Prepare finite admission windows, credential checks, stop conditions, and independent cleanup guards.
- [ ] Reserve enough scratch storage to download and check the complete reference artifact set.
- [ ] Execute the separately reviewed event and complete all publication, artifact, canonical-state, and cleanup checks.

Keep the genuine source and parser identity.
Budget source, management, R2, storage, and full artifact checks separately.
Caller-enforced bounds do not establish a global provider ceiling or cancellation of stalled requests.

**Exit evidence:** connect the scheduled event to the new instance and its first complete publication.
Compare the full corpus and every artifact with the pinned reference.
Show the canonical backup unchanged and the calendar empty.
Health requests, manual creation, existing-publication no-ops, and absent metrics cannot substitute for this result.

Use the [qualification review](V1-SCHEDULED-PUBLICATION-REVIEW.md), [shared Workflow](../services/snapshot/snapshot-workflow.ts), and [snapshot operations](../services/snapshot/OPERATIONS.md).
The [preparation CLI](../scripts/prepare-snapshot-qualification.ts) checks a pinned proposal; it has no execution mode.
The [offline snapshot verifier](../scripts/publish-snapshot.ts) checks a downloaded snapshot against the exact reference manifest hash.
The retained October 24 existing-publication probe has consumed arming markers and an expired review.
It cannot authorize another event or prove first publication.
The [authority audit](evidence/2026-10-31/scheduled-readiness-authority-audit.json) and [readiness observation](evidence/2026-10-31/scheduled-readiness-management-observation.json) retain the later bounded checks.
The October 31 observation finds an empty Worker calendar; it does not establish the optional native Workflow calendar or first publication.
Namespace and instance absence, current credentials, source freshness, and final execution admission remain separate checks.
The exploratory meter, binding, and generic operator drafts remain held and unvalidated.
The release ledger retains the expired credential refusal, separately reviewed refresh, and consumed readiness packets.
Prepare a fresh successor from existing owned helpers; preserve every consumed marker and admission failure.

### MP-03 Close serving acceptance

Local citation-link checks qualify. D-02 now requires independent claim-level review. Broad serving acceptance and positive Zen acceptance remain open.
**Requirements** V1-01, V1-03, V1-04, V1-07, V1-08.

- [x] Qualify provider dispatch, brief policy, shared-object byte checks, allocation limits, and relay abort handling.
- [x] Check the new [bilingual questions](../src/eval/data/v1-successor-questions.json) against their full immutable source proof.
- [x] Add chat citation-link checks before successful usage; preserve the response shape and check all four provider adapters.
- [x] Return a fixed insufficient-evidence answer for empty retrieval, with zero generation calls and one successful retrieval unit.
- [x] Pass local regressions for revision integrity, search eligibility, cache faults, and chat quota admission.
- [x] Bind offline D-02 evidence to the exact preregistered request, captured answer, and retrieved text.
- [ ] Record the replacement D-01 criteria before the serving acceptance run.
- [ ] Preregister the hosted D-02 cases and name the independent reviewer.
- [ ] Finish and independently review the API deployment, serving, and Zen operators on the qualified source.
- [ ] Prepare fresh target provenance, reviewed request scopes, and any required label checks for that revision.
- [ ] Deploy and check the reviewed staging API; complete the independent bilingual holdout and bounded benchmark.
- [ ] Review broad acceptance and refresh management target evidence.
- [ ] Qualify positive Zen chat and separately verify every factual claim in the predeclared bilingual chat cases under D-02.
- [ ] Recheck affected advertised HTTP/MCP routes and reconcile serving and usage receipts.

Preserve the held-out and benchmark failures; do not tune against their answers.
Separate misses, wrong results, scope errors, false refusals, provider errors, and text-hydration failures.
State cache behavior, language splits, provider observations, latency, throughput, and freshness.
Extend the existing eval, benchmark, relay, and CHS emission paths.
Operator fixture passes do not establish actual target provenance or serving acceptance.

#### Local serving prerequisites

Retain the [November 22 probes](V1-RELEASE.md#november-22-local-code-assessment) as regressions in the MP-01 candidate checks.
Search eligibility and cache failure handling pass the local regressions for the [new search policy](V1-RELEASE.md#november-22-search-eligibility-and-cache-repair).
Coherent revision and chat quota admission pass [integrated local checks](V1-RELEASE.md#november-22-integrated-v1-local-work).
Hosted visibility, calibration, and the bilingual holdout remain open.

| Work | Owner | Implementation and acceptance |
| --- | --- | --- |
| Coherent revision | Pipeline and API engineers | Extend the [mutation outbox](../src/corpora/d1-store.ts), [publication checkpoint](../src/ingest/snapshot-pipeline.ts), and [serving readiness](../src/corpora/registry.ts). Serve one revision across rows, text, vectors, cache, and change events. If a request cannot read a coherent revision, return a bounded unavailable result. Test a failed vector write, requests that overlap the first write, and reads between cycles. Check exact lookup, cold and warm search, chat evidence, raw match, discovery, and change cursors through replay. Check vector visibility before serving the new revision. |
| Search eligibility | API engineer and evaluation owner | Extend the [shared search adapter](../src/corpora/adapters.ts). Apply the fallback floor using eligible rows after keyword checks. Test a filtered-out leader and a below-floor survivor with Jev disabled and with a Jev failure. Preserve the Jev authority policy. Version the decision and cache contract. Calibrate the serving backend under D-01 before its independent holdout. |
| Chat quota admission | Billing and API owners | Extend [shared CHS metering](../src/metering.ts) with atomic admission for provider work against the workspace hard limit. Preserve monthly counters and operation IDs. Test two chats and a competing retrieval at the last unit. A chat must hold a unit before it calls the provider. Charge one unit on success. Test release on failure, safe expiry, and lost acknowledgements. Hosted request budgets under D-03 are separate. |
| Cache failure handling | API engineer | Extend the [search cache path](../src/corpora/adapters.ts). Continue fresh search after a cache read failure. Return a valid result after a cache write failure. Check read and write faults, bounded diagnostics, usage counts, and propagation of provider and text hydration failures. |

Keep HTTP and MCP response shapes and successful empty results compatible. Raw `/api/match` continues to return nearest vectors.
Run hosted v1 acceptance only on Cloudflare. Bun/Postgres tests exercise the shared search adapter as local portability checks.
Follow D-02 for any change to the public chat answer contract.

The sealed [one-request Zen proposal](V1-ZEN-RECHECK.md) remains a separate decision.
Its previous generation approvals are spent; the final recorded serving slot does not grant a new approval.
The relay repair changes a file pinned by the retained packet. Preserve it and qualify a fresh source-bound successor before execution.
New broad measurements need their own reviewed usage scope.

**Exit evidence** includes passing local regressions, accepted bilingual retrieval and performance reports, positive hosted chat, and route checks for the exact candidate.
Chat also requires independent support review of every factual claim in its predeclared acceptance cases. Keep this evidence separate from provision retrieval metrics.
The reproduced byte-length defect does not establish the cause of the historical hosted hydration failure.
Use the existing [evaluation procedure](V1-EVALUATION.md), [runner](../scripts/eval-v1.ts), and [request ledger procedure](STAGING-REQUEST-BUDGET.md).

### MP-04 Qualify consistent production acquisition

**Status:** fixture mechanisms and private preparation pass their retained checks; actual maintenance and production capture remain open.
**Requirements:** V1-01, V1-04, V1-06.

- [x] Qualify the fixture capture core, transport, schema and sequence checks, and final file-integrity checks.
- [x] Compose before and after source facts, both KV views, the continued export, and the signed SQL download under one offline fixture owner.
- [x] Retain bounded inventory observations and private maintenance preparation without claiming a production freeze.
- [ ] Identify actual versions, bindings, auth authority, source schema, writer owners, and active work.
- [ ] Define common maintenance, drain evidence, stop conditions, and explicit reconciliation or resume authority.
- [ ] Qualify authenticated transport and the production process owner for the fixture-proven read sequence.
- [ ] Include source facts, signed download, private persistence, and complete request, storage, time, and cleanup budgets.
- [ ] Acquire and check the consistent capture under the separately reviewed maintenance and execution packet.

Do not substitute the staging coordinator for production writer control.
Keep provider credentials separate from the signed-download origin.
Keep detailed production observations and held findings private until their publication decision permits disclosure.

The fixture core's 2,080-exchange bound covers only its partial protocol.
It does not establish that a complete acquisition fits the older 2,200-call proposal.
Matching KV views alone do not prove a common writer freeze.
The [offline session](../scripts/lib/protected-acquisition-session.ts) tests the complete read sequence. The hosted owner still needs authenticated transport, a settled maintenance interval, and a reviewed total budget.

**Exit evidence:** authentic raw inputs, declared source schema, original sequence highwaters, and a consistent production capture.
Absent sequence values and explicit zero must remain distinct.
Never reconstruct deleted highwaters from surviving row IDs.
Use the [acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md) and [existing capture core](../scripts/lib/protected-acquisition.ts).

### MP-05 Qualify protected copy and production rollback

**Status:** local copy mechanisms pass; production-derived hosted qualification remains open.
**Requirements:** V1-01, V1-06, V1-08. **Dependency:** MP-04 capture for production-derived proof.

- [x] Qualify the local codec, restricted importer, source-schema admission, sequence bridge, D1 binding, client, and rollback behavior.
- [ ] Recheck the owned operator's source loader and final source qualification before execution.
- [ ] Check corpus, parser, text, vector, publication, and source-schema compatibility against MP-04's authentic capture.
- [ ] Complete the isolated hosted protected copy with identity, revocation, capability, billing, history, and sequence checks.
- [ ] Prepare and qualify the production target adapter as a separate change.
- [ ] Check the actual production switch and rollback targets; preserve authoritative authorization and usage throughout.
- [ ] Apply the MP-03 revision check to both targets. Check row, text, and vector alignment and change cursors before and after the switch.

Retain staging-only admission until the production adapter qualifies.
Earlier production use does not establish the rollback target's current compatibility.

**Exit evidence:** qualified hosted copy and a concrete production switch/rollback procedure that preserves identities and usage history.
Use [protected copy](PROTECTED-STATE-COPY.md), [D1 admission](PROTECTED-D1-BINDING.md), and [corpus rollback](CORPUS-ROLLBACK.md).

### MP-06 Qualify the final source and release packet

**Status:** open for the final candidate. **Requirements:** V1-01 through V1-10.
**Dependencies:** MP-02, MP-03, and MP-05 acceptance before production release.

- [ ] Confirm the final release source matches the local and clean Linux receipts from MP-01. Repeat qualification on any later source.
- [ ] Reconcile all ten requirements with accepted evidence, limitations, and actual source and binding identities.
- [ ] Complete production commands, maintenance, post-switch checks, stop conditions, and authorization-preserving rollback.
- [ ] Present the complete candidate for the final production decision.
- [ ] Execute that approved scope and record actual outcomes before declaring v1 complete.

**Exit evidence:** the exact source passes local and clean CI checks, required hosted gates close, and the approved production switch passes its checks.
Use the [release evidence ledger](V1-RELEASE.md) and [operations procedure](V1-OPERATIONS.md).

## Phase 2 Test external demand

**Entry:** the federal v1 release qualifies. Distribution and publication need an explicit scope.

- Choose one initial customer group and one repeatable task.
- Confirm the public product name before distribution; the historical naming question remains open.
- Give a small external cohort a working key, a copyable HTTP example, and an MCP configuration.
- Keep the free allowance usage-limited rather than time-limited; manual pilot provisioning can remain sufficient.
- Measure time to a useful result, failed requests, repeat workspace use, and willingness to pay.
- Select relevant discovery channels; prepare directory or Apify work only after checking each channel's current requirements.
- Set an experiment start, review date, and decision before launch.

The earlier snapshot design also proposes public row/index artifacts on Hugging Face.
Treat that as a separate publication decision after artifact and source-policy checks.
Public dataset distribution and a commercial bulk licence are distinct choices.

The historical plan proposed a 60-day demand test and a stop decision if nobody used the API.
Reconfirm that window and success criteria before launch; no experiment clock starts through this consolidation.

**Exit decision:** continue a repeatable use, change the audience or task, or stop expansion.
More infrastructure cannot substitute for this decision.

## Phase 3 Select and qualify the paid use

**Entry:** external use identifies a repeatable job and a buyer.

Measure actual encoder, rerank, storage, cache, and support costs before setting prices.
The original direction favors metered use and prepaid credits; v1 does not configure checkout or a public unit price.
Decide the paid model explicitly rather than assuming subscriptions or reusing historical margin estimates.

Select one initial paid surface from the established candidates:

| Candidate | Evidence needed before implementation |
| --- | --- |
| Paid API use | Integrators repeat a useful task and accept a measured price |
| Policy briefing | A defined audience needs a recurring or on-demand cited brief |
| Embeddable widget | Customers need a supported publishing surface with source and browser-key rules |
| Commercial bulk snapshot | Buyers need a reproducible artifact and clear licence, update, and support terms |

Extend shared billing and operation receipts for the selected model.
Qualify payment, usage visibility, event delivery, and reconciliation before relying on paid automation.
Stripe delivery is currently best effort; there is no durable Stripe outbox or product-result journal.
Later delivery work must preserve the existing operation and month identities.

**Exit evidence:** a buyer completes the selected paid workflow, and support can reconcile usage and payment failures.

## Phase 4 Expand the civic brief from demand

**Entry:** repeat use supports a specific source or workflow expansion.

- Select the next corpus from news, debates, bills, or another licensed source.
- Reuse existing source products and CHS corpus policies where appropriate.
- Check source terms, attribution, permitted text, freshness, provenance, and failure behavior before ingestion.
- Add source-specific tests and explicit coverage states before advertising support.
- Add caller-selected geography only where source joins and permitted boundary data support it.
- Measure the complete brief across supported sources and languages.

The broader product joins cited sources into one useful answer.
It must preserve source-specific limits and distinguish no results from unavailable coverage.
Provincial expansion needs its own source and terms review.

## Phase 5 Add optional customer surfaces

**Entry:** a customer need justifies the surface and its ongoing cost.

| Surface | Direction and condition |
| --- | --- |
| Developer console | Add workspace access, key lifecycle, usage, and payment controls when manual operation blocks demand |
| Hosted OpenCode harness | Reuse OpenCode and the existing plugin; qualify customer isolation, credentials, process cost, and host choice |
| External web answers | Keep search in the harness; fetch publisher passages with provenance and source policy checks |
| Portal and research sessions | Use the existing design studies as references; define an approved product contract before implementation |
| Watches and notifications | Build only for an observed recurring workflow, with delivery and subscription semantics |

Customers can continue to use their own agent harness through MCP.
A hosted harness needs a separate runtime and pricing decision.
It does not reopen the v1 platform choice automatically.

## Decisions still required

No numerical serving policy, new generation allowance, or production maintenance authority follows from this consolidation.
Record each decision and its supporting evidence before the dependent work.

Source commit age and last successful ingestion age do not measure the latest upstream check.
Record whether acceptance requires the observed upstream head or a bounded historical snapshot before applying age limits.
The current operator enforces three age caps; the upstream-head option requires an explicit policy-contract change.

The product owner requested a different D-01 bar. The earlier draft proposed 21/24 top-five hits in each language and zero unsupported accepts across 16 negative cases.
It also proposed complete requests and warm-ups, a completed-client p95 of at most five seconds, and a fresh match to the upstream head.
Record the replacement criteria before the acceptance run. Report false refusals and provider fallbacks by language.
The operator still needs a compatible freshness rule and a separate request budget.

| ID | Decision and next action | Responsible role | Blocks |
| --- | --- | --- | --- |
| D-01 | Select numerical bilingual search, refusal, error, fallback, latency, and freshness criteria before the run | Product owner with evaluation owner | MP-03 execution |
| D-02 | Verify every factual claim before chat release, as selected by the product owner. Define and collect the claim-level evidence. | API and evaluation owners | MP-03 chat acceptance |
| D-03 | Accept concrete budgets, finite windows, and residual provider uncertainty for each operation | Operator and approving user | The respective hosted execution |
| D-04 | Identify writer authorities and approve actual maintenance, capture, reconciliation, and resume controls | Release engineer and writer owners | MP-04 acquisition and MP-05 migration |
| D-05 | Review the complete release evidence and production switch/rollback candidate | Product owner and release engineer | MP-06 production release |
| D-06 | Select audience, task, public name, experiment window, and stop criteria | Product owner | Phase 2 distribution |
| D-07 | Select the paid surface, price, payment model, and reconciliation requirements | Product owner with cost evidence | Phase 3 paid automation |
| D-08 | Select the next corpus, geography, harness, or portal from observed demand | Product owner | Phase 4 or 5 implementation |

The October 31 repair added a citation URL check. The November 22 probe returned an unsupported claim with a valid retrieved link.
The current response exposes `answer: string` and a separate `cited` array.
The product owner chose claim-by-claim verification before release on November 22.
Bind the bilingual case list, generated answers, retrieved provisions, and independent review to the exact candidate.
The reviewer must account for the full answer. Each factual claim needs evidence from the retrieved text.
Any unsupported or unreviewed claim blocks chat acceptance.
The finite release review measures the candidate on those cases. A runtime verification claim needs its own control and evidence.
Use the [offline evidence checker](../scripts/check-chat-claim-evidence.ts) with the preregistered plan, private capture, and independent review.
Put the SHA-256 of the exact serialized request body in each planned case. Keep the body with the private capture and keep authorization headers outside the evidence.
Create a separate evidence set for each provider and model that the release qualifies.

Keep any added validator inside the successful-usage boundary.
Preserve the response contract through internal checks or additive metadata; a new structured response needs an explicit compatibility decision.
A matching source ID or quotation does not alone establish factual support.

When no material passes the licence gate, the fixed insufficient-evidence response skips generation and consumes one successful retrieval unit.
The response identifies skipped generation and retains the answer, sources, provider, model, and scope fields.

Include both answerable and refusal cases in English and French. Keep the bilingual provision holdout and positive Zen smoke as separate acceptance checks.

## Reference map

This map accounts for the repository's planning documents and related procedures.
Use each reference for its stated role; use this file for the next task.

| Role | Documents |
| --- | --- |
| Entry point and history | [README](../README.md), [former product plan](PLAN-HISTORY.md) |
| Requirement evidence and operations | [release ledger](V1-RELEASE.md), [v1 operations](V1-OPERATIONS.md), [evaluation](V1-EVALUATION.md) |
| Scheduled publication | [qualification review](V1-SCHEDULED-PUBLICATION-REVIEW.md), [snapshot operations](../services/snapshot/OPERATIONS.md) |
| Production acquisition and copy | [acquisition review](PROTECTED-PRODUCTION-ACQUISITION-REVIEW.md), [offline copy](PROTECTED-STATE-COPY.md), [D1 binding](PROTECTED-D1-BINDING.md), [rollback](CORPUS-ROLLBACK.md) |
| Staging procedures and chronology | [staging](V1-STAGING.md), [recovery](V1-STAGING-RECOVERY.md), [binding recovery](V1-STAGING-BINDING-RECOVERY.md), [source access](V1-STAGING-SOURCE-ACCESS.md) |
| Bounded serving work | [request budget](STAGING-REQUEST-BUDGET.md), [sealed Zen proposal](V1-ZEN-RECHECK.md) |
| Data and prior checks | [corpus model](CORPUS.md), [snapshot format history](SNAPSHOT.md), [snapshot checks](SNAPSHOT-VALIDATION.md), [text-cutover checks](TEXT-CUTOVER-VALIDATION.md), [evidence index](evidence/2026-10-22/README.md) |
| Shared policy and encoder | [licence register](LICENCE-REGISTER.md), [encoder contract](../services/encoder/README.md) |
| Historical architecture and future designs | [retrieval studies](RETRIEVAL-OPTIONS.md), [platform history](PLATFORM.md), [harness](HARNESS.md), [web fallback](WEB-FALLBACK.md) |
| Proposed interfaces | [mockups](design/mockups/2026-10-20/README.md), [art directions](design/mockups/2026-10-20/art-directions/README.md) |
| Document conventions | [writing rules](WRITING.md) |

Reference procedures retain their exact operational constraints and evidence.
Their historical status paragraphs do not override a newer source-specific receipt or this plan's current scope.

## Plan maintenance

Update this plan when scope, priority, dependencies, or requirement disposition changes.
Keep scope, priorities, dependencies, and next actions in this file.
Append detailed execution evidence to the release ledger and link the exact source and receipt.
Update package status here without copying the execution log.
Mark a gate complete only from its required evidence.
Keep local, hosted, and production outcomes distinct.

Preserve historical failures and completed proofs.
Do not replay completed recovery or backup work merely to simplify the narrative.
Keep exact execution packets and accepted receipts intact.
If an edit changes an input pinned by an unconsumed packet, prepare a reviewed successor before execution.
Check completed boxes only for their stated local or hosted scope.
A later draft edit needs its own final checks before it inherits any preparation status.

A documentation change supplies no new deployment, source request, generation, maintenance, acquisition, or production approval.
Record each future execution decision against its concrete packet and cumulative limits.
