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

Cloudflare candidate `3f16f93` includes the incremental ingestion memory fix. The affected local checks and complete clean Linux CI pass. [Candidate evidence](V1-RELEASE.md#november-22-incremental-ingestion-memory-fix)

Production is still on the October 15 corpus. Cloudflare recorded six consecutive memory failures after the November 16 upstream update. Prepare a snapshot-backed recovery through isolated staging and the guarded production rollout. [Live freshness observation](V1-RELEASE.md#november-22-live-source-freshness-audit)

1. **Finish MP-02 staging admission.** The November publication version was last observed active and unarmed with the staging R2 binding. The recorded setup cutoff for its `2026-11-23T03:47:00Z` event has passed. A new reviewed event and version need a schedules API credential valid through both guards' cleanup. [November staging publication version](V1-RELEASE.md#november-22-staging-publication-version)
2. **Prepare MP-04 in parallel.** Establish the production capture owner and writer authority, define the maintenance window, and complete sealed-input checks at handoff.
3. **Prepare MP-03 in parallel.** Use the verified November labels for the November corpus and bind the approved D-01 criteria to the serving packet. Seal the D-02 suite with the exact candidate, revision, provider, model, and the product owner as independent reviewer. Rebind the staging API, serving, and Zen packets to the qualified candidate. Confirm their separate request budgets. [Serving and chat procedure](V1-EVALUATION.md#d-01-serving-decision)
4. **Collect hosted evidence.** Qualify scheduled first publication under MP-02. Run serving and chat acceptance under MP-03. Complete the approved MP-04 capture before the MP-05 protected-copy, switch, and rollback checks.
5. **Complete MP-06.** Audit all ten requirements. Review the production switch and rollback packet. Record the approved operation's actual result.

Bind each hosted packet to the exact reviewed source it uses and close its dependencies before execution.
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

The latest hosted serving measurements date from October 24. The release ledger records later corpus and staging observations. Recheck the exact target, credential validity, and request allowance before each reviewed hosted operation.

## Product direction

The product's value is a maintained, cited corpus with usable search, exact provisions, language control, revision evidence, and observed changes.
Customers can use their existing applications and agent tools through HTTP and the Model Context Protocol, or MCP.
Bring your own key, or BYOK, chat uses the customer's generation provider.

The long-term product is a policy research and monitoring platform for policy analysts, political staffers, and government relations teams.
Users can follow bills and regulatory developments, review what members said and how they voted, and trace the related law and news.
They can keep their own notes and assemble briefs that cite the source records.
Each record type has its own table and remains available on its own. A brief brings the records together.
The API is the product. AI agents are its primary clients. They use it to do research for staffers and policy teams.
Customer applications and the CivicSignal front end use the same API.
The pilot will test whether agents can complete useful work for those teams.
The Policorner wire keeps its own brand, accounts, and reader-facing product.

Release the federal foundation first. Test the staffer workflow with real files.
Build parliamentary search and Canada Gazette monitoring on that foundation. Develop the staffer front end once the API supports the core workflow.
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

The current draft source is **`3f16f93`**. The [memory fix evidence](V1-RELEASE.md#november-22-incremental-ingestion-memory-fix) records the affected local checks and matching clean Linux gate. The preceding [`711b4f8` candidate](V1-RELEASE.md#november-22-draft-candidate-qualification) has both complete local and Linux receipts.
The earlier **`9771a8b`** [local gate](evidence/2026-10-31/integrated-candidate-local-validation-v11.json) and [clean Linux gate](evidence/2026-10-31/candidate-9771a8b-linux-ci-validation.json) cover 2,192 tests and 477 source and fixture inputs.
The assessment at **`518aab0`** used the same runtime and test inputs. Its local probes added five findings to [the release ledger](V1-RELEASE.md#november-22-local-code-assessment).
The local publication, search, cache, and quota regressions pass. The [integrated run](V1-RELEASE.md#november-22-integrated-v1-local-work) and the [later focused run](V1-RELEASE.md#november-22-cloudflare-release-preparation) checked different worktree snapshots.
The qualified [source-loader repair closes issue 14](https://github.com/chester-hill-solutions/civicsignal/issues/14).
It compiles the exact checked source bytes; Python cache flags alone do not establish that identity.
The [release ledger](V1-RELEASE.md#october-31-implementation-progress) preserves earlier candidates, repairs, failed checks, and exact receipts.

| Package | Responsible role | Dependency | Current position and next deliverable |
| --- | --- | --- | --- |
| [MP-01](#mp-01-reconcile-the-exact-candidate) | Release engineer | Exact source for each operation | Affected local and clean Linux checks pass at `3f16f93`. Bind each operator and its deployment identities to the reviewed source. |
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
The serving freeze awaits the final candidate and validation against the approved D-01 criteria.
The Zen preparation retains the earlier source wrapper and skipped-generation regression. Its final bundle and review await the qualified serving producer.
Earlier fixture passes do not qualify later draft edits.
Scheduled-publication acceptance must inspect all nine settled owner chains and both completed cleanup guards.
Canonical artifact proof alone is insufficient.
The retained October Workflow calendar remains unknown. The November Workflow qualifies through its recorded creation without schedules and a fresh match to the Workflow ID and timestamps.

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
- [x] Review the worktree diff and freeze `711b4f8`, including the new migration, vendor patch, and fixture files.
- [x] Pass the complete local gate on the exact source.
- [x] Record the successful Linux CI run and match its exact merge tree to the candidate.
- [x] Qualify the memory fix with local targeted checks, the pinned November replay, and matching complete Linux CI on `3f16f93`.
- [ ] Bind each operator, bundle, dependency, and source receipt to the qualified source it uses.
- [ ] Connect actual deployed identities and current requirement dispositions to the operation packet.

Retain the [whole-plan local verification](V1-RELEASE.md#november-22-integrated-v1-local-work) by source.
Preserve unrelated work, failed receipts, accepted artifacts, and consumed execution markers.
Distinguish deployed provider repairs from newer local code and unfinished private drafts.

**Exit evidence:** one source-specific inventory connects the ten release requirements to their current receipts and remaining tasks.
Use the [release evidence ledger](V1-RELEASE.md), [operations procedure](V1-OPERATIONS.md), and [writing rules](WRITING.md).

### MP-02 Qualify scheduled first publication

The November runtime and offline proposal pass in an isolated checkout of `3f16f93` with the updated qualification reference. Hosted operator rebinding, execution admission, and hosted qualification remain open.
The retained October reference is historical. The November 16 reference passed local byte and row checks. The qualification admits only the current upstream head at execution, so the next proposal must bind the verified reference and confirm that head again at admission.
**Requirements:** V1-04, V1-05, V1-09.

- [x] Reuse the Workflow, parser, builder, archive checks, and manifest-last publication path.
- [x] Qualify safe diagnostics and qualification-only retry, time, object, and progress controls.
- [x] Retain the predecessor operator's fixture and full-artifact comparison evidence.
- [x] Finish the operator successor's fixture repairs, complete checks, source linkage, and independent review.
- [x] Retain the earlier chat candidate's publication-operator rebinding and independent preparation review.
- [x] Check downloaded artifacts against the exact frozen reference manifest in the offline verifier.
- [x] Track the streaming November verifier. Reproduce the pinned artifact bytes, physical row count, checked index, and canonical manifest against the retained local reference.
- [x] Build and verify the November 16 reference from Justice Canada's pinned Git tree, including the staged object inventory. Rehearse two-cycle reconciliation locally against the complete October fingerprint set.
- [x] Bind the qualification bundle and offline proposal to the November 16 inventory, with an isolated staging configuration and a distinct namespace and instance.
- [x] Add the staging calendar cleanup and independent readback commands using Cloudflare's schedules API.
- [x] Wire the staging calendar runner to two detached cleanup guards and exercise arming, ambiguous writes, and independent readback locally.
- [x] Attach a read-only `cf` check to calendar admission for the reviewed deployment ID, its sole active version, Workflow identity, and explicit native calendar state.
- [x] Create and independently read back the new isolated November staging Worker and Workflow. The bootstrap has zero Workflow instances and no configured schedules or R2 bindings.
- [x] Verify the new native calendar from its creation record and live metadata. Bind Worker calendar arming, both guards, and final readback to the selected staging identity.
- [x] Upload and activate the November publication Worker version with the staging R2 binding and concrete UTC controls. Verify the deployed bytes, exact bindings, empty qualification prefix, unused instance, and preserved Workflow definition.
- [ ] Bind a schedules API credential valid through both guards and final observation. Confirm the event can still be armed within its propagation window or prepare a fresh version for a later event.
- [ ] Bind the calendar runner to hosted publication admission and artifact verification. Recheck the bundle, namespace, instance, canonical backup, and native Workflow calendar before execution.
- [ ] Qualify exact Worker calendar arming and cleanup, including an independent empty readback, before selecting the executable event and budgets. Keep the native Workflow calendar empty.
- [ ] Prepare finite admission windows, credential checks, stop conditions, and independent cleanup guards.
- [ ] Run the tracked read-only verifier against the admitted staging namespace and retain the artifact and canonical-manifest result.
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
- [x] Reverify the calibration and independent holdout source labels for the November corpus.
- [x] Author the eight bilingual D-02 cases, generate hashed request packets offline, and validate the registered reviewer.
- [x] Record the approved replacement D-01 criteria.
- [x] Verify the approved D-01 criteria offline against fixture reports, including the exact Git ancestry rule for an approved older revision.
- [x] Prepare the November D-01 request schedule and verify that the checker requires the reviewed encoder in all three discovery responses.
- [ ] Verify the serving operator applies the approved D-01 criteria to the exact candidate's reports.
- [x] Confirm the product owner as the independent D-02 reviewer.
- [ ] Seal the D-02 packet for the hosted target and designate a separate capture operator.
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

#### Staging work order

The retained November source contains the Linux-qualified `3f16f93` commit. Its empty chat reply is English only. The current worktree adds the French reply and the D-01 checker, so the combined candidate needs its own clean-source qualification. The previously reviewed API and serving operators were absent from the documented local packet locations and the checked Chester Hill Solutions archive paths. Assemble the successor from the tracked config, relay, and evaluation tools unless the reviewed originals become available. [Preparation evidence](V1-RELEASE.md#november-22-mp-03-staging-packet-preparation)

| Work | Owner | Dependency and completion evidence |
| --- | --- | --- |
| MP-03.1 API candidate | Release and API engineers | Freeze and qualify the exact source under MP-01. Generate the stage-only config from the checked inventory. Review the exact bundle, active version, binding inventory, and coherent served revision before the request runs. |
| MP-03.2 Serving run | Evaluation operator | After MP-03.1, bind the November labels, approved D-01 checker, provenance, and the reviewed 131-attempt ledger. Retain calibration, the independent bilingual holdout, and benchmark reports from the same policy and candidate. |
| MP-03.3 Chat, Zen, and route checks | API operator and product owner | After MP-03.1, seal the eight-case D-02 plan for the selected provider/model with a separate capture operator and the product owner as reviewer. Bind the one-request Zen diagnostic and HTTP/MCP checks to their own reviewed scopes. |

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
- [x] Revalidate the sealed facts, raw capture, normalized auth, and SQL before the offline session receipt.
- [x] Retain bounded inventory observations and private maintenance preparation without claiming a production freeze.
- [ ] Identify actual versions, bindings, auth authority, source schema, writer owners, and active work.
- [ ] Define common maintenance, drain evidence, stop conditions, and explicit reconciliation or resume authority.
- [ ] Qualify authenticated transport and the production process owner for the fixture-proven read sequence.
- [ ] Include source facts, signed download, private persistence, and complete request, storage, time, and cleanup budgets.
- [ ] Revalidate every sealed input at the production-owner handoff before accepting the capture.
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
- Give a small external cohort a workspace key, an MCP configuration, and a copyable HTTP example for their agents.
- Keep the free allowance usage-limited rather than time-limited; manual pilot provisioning can remain sufficient.
- Measure task success, citation accuracy, time to a useful result, and whether teams repeat the task.
- Select relevant discovery channels; prepare directory or Apify work only after checking each channel's current requirements.
- Set an experiment start, review date, and decision before launch.

The earlier snapshot design also proposes public row/index artifacts on Hugging Face.
Treat that as a separate publication decision after artifact and source-policy checks.
Public dataset distribution and a commercial bulk licence are distinct choices.

The historical plan proposed a 60-day demand test and a stop decision if nobody used the API.
Reconfirm that window and success criteria before launch; no experiment clock starts through this consolidation.

**Exit decision:** continue a repeatable use, change the audience or task, or stop expansion.
More infrastructure cannot substitute for this decision.

### Parliamentary monitoring pilot candidate

One political staffer built a monitor around their own keywords, committees, and people.
They cited cost and inbox volume as barriers. They wanted detailed coverage of parliamentary procedure.
They troubleshoot the monitor themselves.

Test one recurring task with staffers. Identify what changed on their files, why it matters, and what could happen next.
Use the team's keywords, committees, bills, and people to prioritise a short list. Cite the event and the relevant Standing Order when procedure matters.
State which events the source confirms. Explain any possible next step and the conditions it depends on.
Show times where the source gives them. Test a ranked list or digest for routine updates and reserve alerts for changes the team marks urgent.

- Replay one completed sitting week against a staffer's existing workflow.
- Record which changes they acted on, which they missed, and which they would mute.
- Measure time to find a useful change and effort to set up and maintain the monitor.
- Check whether staffers want to repeat the workflow.

## Phase 3 Qualify the API for agents

**Entry:** the pilot identifies a repeatable job and the evidence needed to do it.

- Document the HTTP contract with an OpenAPI description. Give MCP tools typed inputs and structured results.
- Publish tool descriptions and live capabilities that tell agents which operation to call and what that workspace can access.
- Use the same search, coverage, and citation rules through HTTP and MCP.
- Give each record type stable IDs, direct retrieval, citations, and revision information.
- Return compact pages with a cursor, the matched passage or permitted excerpt, and source links. Let agents fetch full record detail by ID.
- Return machine-readable states for empty results, unsupported coverage, stale sources, partial results, and retryable failures.
- Keep ranking and match evidence in the API. Give agents the records they need to make a brief in the format their team uses.
- Reuse workspace keys, usage limits, and operation receipts. Document the usage unit and how clients can reconcile a failed acknowledgement.

**Exit evidence:** an agent in an external team's workspace discovers the right operation and returns a brief that cites the source records.
Check the result against the task and test how the agent handles a coverage gap and a resumed search.
Use the [daily cosmetics policy file](#daily-cosmetics-policy-file) to test current federal law lookup and the change feed before Parliament and Gazette coverage come online.

## Phase 4 Build parliamentary and regulatory monitoring

**Entry:** repeat use supports a specific source or workflow expansion.

Start with House of Commons debates (Hansard). The complete monitoring workflow requires the House floor, every House committee's public proceedings, and Canada Gazette Parts I and II.
Use separate [source records](CORPUS.md#proposed-platform-corpus-model) for House speeches, committee interventions, members, bills, and meetings.
Report coverage and freshness for each committee. Track the event time, when the source publishes it, and when CivicSignal first sees it as separate facts where available.
Show gaps in language, transcripts, or media where they occur.

### First monitoring workflow

| Staffer task | API result |
| --- | --- |
| Check what changed on a file | Search using the file's terms and filters on each request. Filter by member, committee, bill, date, and language. Allow clients to fetch new and corrected results after a cursor. |
| Track keywords and similar terms | Support exact phrases and optional related-term matching. Return the matching phrase or passage and how it matched. Apply explicit filters to every match. |
| See who spoke and what they said | Return the speaker, topic, meeting or sitting, published time or sequence, linked bills, transcript citation, and permitted excerpt. Distinguish the bill under debate from bills that were mentioned. |
| Watch the relevant moment | Return a verified link to the moment in the official player when the source supports one. Report whether a recording is audio only, available without a verified offset, or unavailable. |
| Track regulatory proposals and instruments | Search and retrieve Gazette records by topic, part, and date. Return the source citation, publication date, and any consultation deadline or effective date the source states. |
| Understand why it matters | Show which part of the file matched and cite the records that relate the event to the file. Cite the procedural rule when an interpretation depends on it. Label possible next steps and state their conditions. |

Use caller-supplied search criteria for the first release. Saved watches, scheduled checks, and delivery follow the search API.
Give an agent a real policy file and a completed sitting week. Ask it to find relevant remarks and report any confirmed changes to the linked bills.
Compare the underlying search results and the agent's brief against the staffer's review of that week.
Check attribution, English and French search, related-term matches, official video links, source gaps, and missed events.
Record whether each gap came from the source, the API, or the agent's use of the results.

The [House publication viewer guide](https://www.ourcommons.ca/Content/Guides/DocumentViewer/hansardguide-E.pdf) describes playback links to individual interventions.
Check actual link behavior and source coverage in both languages. Check media and excerpt use against the [House source terms](https://www.ourcommons.ca/en/important-notices).

Use the monitoring pilot to identify which procedural records the workflow needs after Hansard.
Candidate records include Standing Order provisions, Order Paper items, and committee notices and reports.
Give each record type its own table and preserve the official citation for each record.
Review the [Hansard adapter](../src/corpora/adapters.ts) and [source policy](LICENCE-REGISTER.md#debates--the-boundary-that-shapes-the-design) before implementation.

### Canada Gazette

Include Part I proposals and notices and Part II official regulations in regulatory monitoring. [Canada Gazette publications](https://gazette.gc.ca/rp-pr/publications-eng.html)
Give Gazette records their own IDs, citations, and change feed. Report the feed's coverage and freshness separately from Parliament and the current-law corpus.
Link a proposal to its final instrument and link an instrument to affected provisions where official sources establish those relationships.
Return metadata and official links under the [Gazette publication policy](LICENCE-REGISTER.md#the-gazette). Keep the published instrument and any verified effective date available as separate facts.

### Daily cosmetics policy file

Use this scenario to qualify the agent workflow as each source becomes available.
A government relations staffer follows animal testing and chemical rules that could affect a cosmetics client.
The team gives its agent the file's terms in English and French, plus any ingredients, bills, committees, or members to follow.
The team's agent runs the check each day and keeps a cursor for each supported change feed.

| Task | Expected result |
| --- | --- |
| Pull the current law | Return the relevant federal provisions, their status, the corpus revision, and exact citations. |
| Check what happened since the last run | Find relevant House and committee remarks, bill developments, and updates to the published law. Return each change or correction with a source link. |
| Identify a regulatory development | Check Canada Gazette Parts I and II for proposals, consultation deadlines, and published regulations. Give each record its own citation. Report publication and effective dates as distinct facts where the source gives them. |
| Give the staffer a daily brief | State what changed, why it relates to the file, and any deadline or next step the records support. When there are no relevant changes, name the sources checked and flag any coverage gaps. |

The brief must distinguish parliamentary remarks, proposed changes, and changes to the law in force.
The agent advances a source's cursor after it processes that source's results. It can retry a partial check from the last processed cursor.
Test consecutive days with a relevant change, an unrelated result, a late correction, a source gap, and a day with no relevant changes.
Include a Part I proposal and a Part II regulation with a later effective date. Check that the brief identifies the law in force during each run.
Check each source's coverage and publication policy before the API advertises support.

## Phase 5 Develop the staffer front end

**Entry:** the public search API supports the core staffer workflow end to end.

Start with a policy file view. Staffers can flag records, set terms and filters, and review what changed.
Let them open the official transcript or video moment, add a note, and gather cited results for a brief.
Use the same documented API for search, ranking, evidence, and source links. Add workspace APIs for flags and notes as the front end needs them.
Extend the workspace API with saved watches and delivery once the team chooses when and how to receive updates.

| Surface | Direction and condition |
| --- | --- |
| Developer console | Add workspace access, key lifecycle, usage, and payment controls when manual operation blocks demand |
| Hosted OpenCode harness | Reuse OpenCode and the existing plugin; qualify customer isolation, credentials, process cost, and host choice |
| External web answers | Keep search in the harness; fetch publisher passages with provenance and source policy checks |

Customers can continue to use their own agent harness through MCP.
A hosted harness needs a separate runtime and pricing decision.
It does not reopen the v1 platform choice automatically.

## Decisions still required

Record each open decision and its supporting evidence before the dependent work.

Source commit age and last successful ingestion age do not measure the latest upstream check.
The approved D-01 policy allows the observed head or an explicitly approved, recent ancestor. The current operator's unconditional age caps need to support that rule before the new serving packet is frozen. [Approved serving bar](V1-EVALUATION.md#d-01-serving-decision)

| ID | Decision and next action | Responsible role | Blocks |
| --- | --- | --- | --- |
| D-02 | Collect the eight staging cases and have the product owner independently verify every factual claim before chat release. | API and evaluation owners for capture, product owner for review | MP-03 chat acceptance |
| D-03 | Accept concrete budgets, finite windows, and residual provider uncertainty for each operation | Operator and approving user | The respective hosted execution |
| D-04 | Identify writer authorities and approve actual maintenance, capture, reconciliation, and resume controls | Release engineer and writer owners | MP-04 acquisition and MP-05 migration |
| D-05 | Review the complete release evidence and production switch/rollback candidate | Product owner and release engineer | MP-06 production release |
| D-06 | Select audience, task, public name, experiment window, and stop criteria | Product owner | Phase 2 distribution |
| D-07 | Confirm the API's usage unit, retry behavior, and reconciliation contract | API and billing owners | Phase 3 API qualification |
| D-08 | Confirm history, freshness, and source use for the House floor, every House committee, and Canada Gazette Parts I and II | Product owner with API and source owners | Phase 4 monitoring release |

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
| Domain terminology | [CivicSignal glossary](../CONTEXT.md) |
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
