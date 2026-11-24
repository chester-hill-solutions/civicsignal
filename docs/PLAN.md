# CivicSignal master plan

Updated 2026-11-23. All four v1 release gates remain open.

CivicSignal will give applications and agents source-cited Canadian civic information.
The first release serves Canadian federal statutes and regulations in English and French.
The immediate objective is to close four release gates: scheduled first publication, serving acceptance, production migration, and the final release audit.

This file owns scope, priorities, dependencies, decisions, and next actions.
The [release evidence ledger](V1-RELEASE.md) owns detailed results and source-specific receipts.
Supporting documents supply contracts, procedures, historical evidence, or future designs.
They do not create another work order.

## Immediate work order

**Ready for staffer review.** Review the [five federal freshwater briefs for May 25–29, 2026](../preview/policy-files/freshwater-2026-05-25/BRIEFS.md). Check which events changed the file, whether the two deadlines reached the right owner, and whether the First Nations drinking-water funding and Charlo groundwater leads belong in the main brief. Use missed items and false positives to revise the watch terms, then replay the week. Phase 5 covers scheduling and shared delivery. [Pilot priorities](#parliament-monitor-workflow-benchmark)

**Parliamentary backend.** The local committee API serves bilingual 45-1 studies, meetings, proceedings, written submissions and the House calls for briefs across House, Senate and joint committees. Coverage reports distinguish searchable passages, stored originals and publisher gaps. [Committee execution plan and acceptance checks](#session-45-1-committee-corpus-execution-plan)

**Current corpus build.** Add source pipelines and the remaining backend APIs. The local parliamentary API covers session-wide bills, House and Senate Journals, recorded divisions and individual voting records. The local funding API now covers the current NSERC College and Community Innovation opportunities and ESDC’s jobs, skills and community funding catalogue in both languages. The House calls for briefs are indexed with their published deadlines and instructions; the Senate publishes no equivalent listing, which the intake records as a measured gap. The federal consultation catalogue is served with its published dates, status and department and report links, and a state computed for the queried date; 71 consultations are open and 111 rows carry a status that disagrees with their dates. Next, parse the linked department notices for who may participate and how to respond, then ECCC audit and evaluation publications. Connect each opening to its study or policy question and the evidence already published on that file. ECCC audit and evaluation publications follow. Retain official budget and spending-bill references when a source cites them. The GEDS directory serves the full October 25 export: 189,994 source rows, 21,874 organizations and 189,877 roles, and a replay adds no snapshot or change event. [Full import](evidence/2026-11-24/geds-full-import.json) Continue routine intake for collections already built. Historical session backfills are deferred. [Backend work order](#current-corpus-pipelines-and-apis)

**House written-questions baseline.** The local 45-1 inventory contains all 1,709 question numbers in English and French. Searchable government replies cover 1,518 of the 1,519 answered questions in each edition. The collection also retains 184 awaiting a response and six withdrawn questions. Follow the cited gaps for Q-105 and Q-338 on refresh. [Written-questions API](WRITTEN-QUESTIONS-PREVIEW.md) · [Collection reconciliation](evidence/2026-11-23/parliamentary-corpus.md)

Cloudflare base candidate `44ce56f` includes the incremental ingestion memory fix and guarded serving changes. It passed clean local checks and Linux CI. The isolated staging API now serves repaired hybrid candidate `65bd7ff` on Worker version `17dcf4a5`. It uses the November 16 corpus at `855cdfc` and a matching lexical index in R2. [Base candidate evidence](V1-RELEASE.md#november-23-clean-mp-03-candidate) · [Staging refresh](V1-RELEASE.md#november-23-isolated-staging-refresh) · [Repaired candidate](V1-RELEASE.md#november-23-repaired-hybrid-d-01)

Production is still on the October 15 corpus. Cloudflare recorded six consecutive memory failures after the November 16 upstream update. Prepare a snapshot-backed recovery through isolated staging and the guarded production rollout. [Live freshness observation](V1-RELEASE.md#november-22-live-source-freshness-audit)

1. **Finish MP-02 staging admission.** The November publication version was last observed active and unarmed with the staging R2 binding. The recorded setup cutoff for its `2026-11-23T03:47:00Z` event has passed. A new reviewed event and version need a schedules API credential valid through both guards' cleanup. [November staging publication version](V1-RELEASE.md#november-22-staging-publication-version)
2. **Prepare MP-04 in parallel.** Establish the production capture owner and writer authority, define the maintenance window, and complete sealed-input checks at handoff.
3. **Retain the serving and chat evidence under MP-03.** The product owner paused evaluation to start Hansard. The repaired holdout found 20 of 24 English and 23 of 24 French provisions. Three HTTP 502 responses stopped the run before the benchmark. D-01 remains open. The eight-case D-02 packet is ready for when evaluation resumes. [D-01 result](V1-RELEASE.md#november-23-repaired-hybrid-d-01) · [D-02 packet](V1-RELEASE.md#november-23-d-02-offline-packet)
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
| Add news, debates, bills, tone, and geography in the first product wave | Build the pre-alpha parliamentary corpus and its documented HTTP APIs now. News, tone analysis and geographic reporting remain later product decisions. Hosted publication follows the source-specific release review. |
| Ship a hosted OpenCode harness or portal | Defer both; v1 exposes HTTP, MCP, and BYOK chat |
| Publish public snapshots, paid credits, or a fixed unit price immediately | Make separate distribution and commercial decisions after the release |
| Treat old local or hosted passes as current release acceptance | Bind each accepted result to its actual source, target, and scope |

The [reference map](#reference-map) identifies each document's role.
Existing execution constraints still apply; a newer priority does not renew an expired approval or consumed marker.

The release ledger records hosted serving and corpus measurements for each candidate. Recheck the exact target, credential validity, and request allowance before each reviewed hosted operation.

## Product direction

The product's value is a maintained, cited corpus with usable search, exact provisions, language control, revision evidence, and observed changes.
Customers can use their existing applications and agent tools through HTTP and the Model Context Protocol, or MCP.
Bring your own key, or BYOK, chat uses the customer's generation provider.

The long-term product is an affordable Canadian policy research and monitoring service for policy analysts, political staffers, and government relations teams.
On each policy file, a staffer needs to know what changed, whether it requires action, and what they can cite.
Use [the competitor feature inventory](#competitor-feature-inventory) to connect those tasks to product scope.
Users can follow bills and regulatory developments, review what members said and how they voted, and trace the related law and news.
On the same file, they can trace how a [federal public service institution](#federal-public-service-corpus-scope) interpreted its mandate, delivered a program, spent funds and responded to findings.
They can keep their own notes and assemble briefs that cite the source records.
Each record type has its own table and remains available on its own. A brief brings the records together.
Build CivicSignal as a typed, documented backend first. AI agents are its primary clients and use the API to do research for staffers and policy teams.
Customer applications and the CivicSignal front end use the same API. Define the backend contracts before building the corresponding interface.
The pilot will test whether agents can complete useful work for those teams.
The Policorner wire keeps its own brand, accounts, and reader-facing product.

Release the federal foundation first. Test the staffer workflow with real files.
Build parliamentary search and Canada Gazette monitoring on that foundation. Develop the staffer front end once the API supports the core workflow.
Phase 1 owns the active federal v1 release. Local source previews are underway in Phase 4. Pilot and hosted rollout still require their stated entry evidence and decisions.
The parliamentary monitoring and staffer workflows in Phases 4 and 5 are roadmap items. The four v1 release gates remain the immediate work order.

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
| [MP-03](#mp-03-close-serving-acceptance) | API, pipeline, billing, and evaluation owners | MP-01 candidate, D-01 policy, and approved hosted scope | D-02 offline packet is ready. Approve the separate capture scope and have the product owner review the cases. D-01 remains an open release gate. |
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

The first hybrid candidate stopped at calibration. The repaired candidate completed calibration and stopped after the holdout with three HTTP 502 responses. D-02 requires independent claim-level review. The earlier positive Zen smoke qualifies its recorded version.
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
- [x] Verify the serving operator applies the approved D-01 criteria to the exact candidate's reports.
- [x] Confirm the product owner as the independent D-02 reviewer.
- [x] Seal the D-02 packet for the hosted target and use a separate capture operator.
- [ ] Finish and independently review the API deployment, serving, and Zen operators on the qualified source.
- [ ] Prepare fresh target provenance, reviewed request scopes, and any required label checks for that revision.
- [x] Deploy the reviewed staging API and verify its bundle, bindings, and health.
- [x] Reconcile the November staging corpus and verify the published row count and Vectorize watermark.
- [x] Run the November bilingual holdout and bounded benchmark and record the D-01 result.
- [x] Replay the staged raw candidates on the November calibration set and verify the named-statute fallback ranking change locally.
- [x] Record the labour-board staging probe and identify Canada Labour Code section 16 as the target for the explicit federal powers question.
- [x] Prototype a revision-bound lexical index over provision headings and opening text for explicitly named statutes. Measure top-five ranks, unresolved scope, and candidate returns for unsupported questions on the fresh bilingual development set.
- [x] Compare the lexical baseline with bounded DeepSeek query interpretation on the frozen bilingual prompts. Record ranking, clarification, unsupported routing, latency, and literal fallback. [Replay](V1-EVALUATION.md#november-23-deepseek-query-interpretation-replay)
- [x] Compare Mistral Small with DeepSeek on the same prompts. Keep DeepSeek as the reference after Mistral's section 16 and jurisdiction regressions. [Replay](V1-EVALUATION.md#november-23-mistral-small-query-interpretation-replay)
- [x] Compare Cohere Command R with DeepSeek on the same prompts. Keep DeepSeek as the reference after Command R's English recall, scope, and latency regressions. [Replay](V1-EVALUATION.md#november-23-cohere-command-r-query-interpretation-replay)
- [x] Compare Claude Haiku 5.5 with DeepSeek on the same prompts. Keep DeepSeek as the reference after Haiku's section 16 ranking and response-format regressions. [Replay](V1-EVALUATION.md#november-23-claude-haiku-55-query-interpretation-replay)
- [x] Measure Act identification and heading-style rewriting separately on a new bilingual development set. The heading phrase reached rank four for French section 16 and the exact-heading promotion reached rank one. Act identification supplied the new-set top-five gains. [Prototype](V1-EVALUATION.md#november-23-short-heading-phrase-prototype)
- [x] Compare staged Vectorize and scoped full-text on the same frozen prompts. The union of their top-20 pools contained all 30 development positives. Scope-gated fusion ranked 13/15 in the top five in each language. [Paired replay](V1-EVALUATION.md#november-23-paired-vectorize-and-full-text-comparison)
- [x] Prototype and replay the hybrid authority and evidence check with explicit jurisdiction conflicts and missing Act scope. No candidates were admitted on the 20 unsupported development prompts. [Scope replay](V1-EVALUATION.md#november-23-hybrid-jurisdiction-and-evidence-check)
- [x] Integrate the hybrid scope and evidence candidate into the Cloudflare serving path and pass fresh named and unnamed staging calibration. [Hosted candidate](V1-RELEASE.md#november-23-hybrid-serving-candidate)
- [x] Run formal D-01 calibration on `e48cedbc`. Retain the HTTP 502, English false refusal, and the stopped ledger. [Hybrid D-01 result](V1-RELEASE.md#november-23-hybrid-d-01-calibration)
- [x] Add one bounded retry for nonmatching evidence quotes. Reproduce the HTTP error locally and check recovery and repeat mismatch through the HTTP route.
- [x] Deploy repaired hybrid source `65bd7ff` to isolated staging and bind Worker version `17dcf4a5` to the fresh D-01 request scope.
- [x] Run formal calibration and holdout on the repaired version. Retain the 86-attempt ledger, results, and key revocation. [Repaired hybrid D-01 result](V1-RELEASE.md#november-23-repaired-hybrid-d-01)
- [ ] Resolve the outstanding D-01 release checks on a reviewed candidate. Retain provider-stage failures for that work. Defer further recall tuning.
- [x] Verify the eight-case D-02 packet, request hashes, and separate recorder and reviewer templates for `65bd7ff` on `17dcf4a5`.
- [ ] Approve a separate eight-attempt D-02 staging scope. To capture before D-01 closes, explicitly approve that sequence for staging evaluation.
- [ ] If hybrid search qualifies, publish its lexical index for each corpus revision before serving that revision. Check the index and R2 catalog against the exact served corpus under MP-02 and MP-05.
- [ ] Confirm that the answerable English election prompt retrieves its provision on the selected serving policy. Restore staging Jev if that policy uses its reranker.
- [ ] Review broad acceptance and refresh management target evidence.
- [x] Verify Zen recovery with one positive staging chat using `deepseek-v4.1-flash`.
- [ ] Capture the registered bilingual D-02 answers on the selected model and independently review every factual claim.
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
Formal calibration passes for the repaired hybrid candidate. The holdout showed better recall in both languages and found failures in interpretation and evidence checking. English recall and response completeness still need qualification.

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

The earlier hosted run used base candidate `44ce56f` with the DeepSeek adapter patch and migration `0009`. The hybrid successor uses the same verified November D1 corpus and Vectorize index at `855cdfc`. The successor assigns scope and checks excerpts with DeepSeek V4.1 Flash. Its staged lexical index uses that corpus revision. [Earlier acceptance run](V1-RELEASE.md#november-23-hosted-serving-and-chat-acceptance) · [Hybrid candidate](V1-RELEASE.md#november-23-hybrid-serving-candidate)

| Work | Owner | Dependency and completion evidence |
| --- | --- | --- |
| MP-03.1 API candidate | Release and API engineers | Repaired hybrid source `65bd7ff` serves on `17dcf4a5`. Module, bindings, publication state, and the matching lexical index passed readback. |
| MP-03.2 Serving run | Evaluation operator | The earlier vector run used 131 attempts. The first hybrid run stopped at 21 and the repaired run stopped at 86. Bind the next successor to fresh staging provenance, verified labels, the approved checker, and a new finite request scope. |
| MP-03.3 Chat, Zen, and route checks | API operator and product owner | The offline D-02 plan pins `65bd7ff`, `17dcf4a5`, and OpenCode Zen `deepseek-v4.1-flash`. Capture after D-01 qualification or with an explicit early-staging decision and separate budget approval. The product owner reviews each factual claim. Give HTTP/MCP checks their own reviewed scope. |

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
- Check whether the staffer can identify an actionable change and cite it from the same result.
- Test a monthly workspace price with teams that use the digest on a real file. Use paid renewals as evidence of demand.
- Check whether staffers want to repeat the workflow.

## Phase 3 Qualify the API for agents

**Entry:** the pilot identifies a repeatable job and the evidence needed to do it.

- Define typed request, result, and error schemas for each operation. Validate inputs at the API boundary. Keep the OpenAPI description, MCP tool schemas, and request and response examples aligned with the implementation through contract tests.
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

The local previews demonstrate retrieval from selected editions of House and Senate debates, Gazette issues, bills and committee records. The corpus work now expands each source by its official publication inventory. Policy files select records at query time and test the quality of search and attribution.

### Parliamentary research API

A Hill researcher should be able to assemble the published record for a file across both chambers. The first product is the backend. Clients need documented HTTP operations to find relevant passages, look up a cited record in the requested language, follow its official relationships and inspect gaps. Each collection needs a typed contract, a handler reachable through the Worker, an OpenAPI entry with examples, and tests through that entry point. Local acquisition and hosted availability are separate milestones.

| Research question | Records the API must connect |
| --- | --- |
| What did Parliament consider, change and decide? | Bill versions, stage events, amendments, recorded divisions, chamber Journals, Order Papers and Hansard. |
| What evidence or position was put before a committee? | Committee and study, meeting notice, witness and affiliation as published, oral evidence, minutes, written briefs, correspondence and exhibits. Preserve the submitting party, study and publication language. |
| What did a committee recommend, and how did government respond? | Report, presentation, request for response, published answer, departmental written-question replies, tables and attachments. |
| Who has worked on this file, and which office can I contact? | Connect named witnesses, credited submitters and responding departments to dated directory entries. Return the evidence for each match and the published work contact for the person or office. |
| Where can a researcher still contribute, and who has already put evidence on the record? | Link a call to its study or consultation, submission instructions, deadline and revisions. Retrieve witnesses, affiliations and submissions with citations to what each participant actually said. |
| What authority does the policy document cite? | Follow its references to a statute, Gazette instrument, budget measure or spending bill. Preserve the cited edition and passage. |
| How did a department administer a program, and what did its own review say should change? | Find the guidance applicable to the case date, the issuing office, the evaluation or audit finding, and management’s published response. [Departmental policy and program delivery](#departmental-policy-and-program-delivery) |

Use the session and official source identifiers for parliamentary acquisition. Inventory departmental publications by institution, series and the dates or fiscal years the publisher supplies. For each record expose its citation, edition, publication status and acquisition status. A staffer should be able to distinguish an unpublished answer, a submitted brief with an unavailable translation, and a search that covered every published item in the selected collection. Public statements and submissions retain their original author and affiliation.

### Current corpus pipelines and APIs

| Build order | Source and client operation | Acceptance |
| --- | --- | --- |
| 1. Parliamentary catalogues | Ingest the official 45-1 LEGISinfo bill inventories, House recorded divisions and Senate standing-vote indexes in both languages. Browse, search, look up an official number, and inspect coverage for each collection. | Reconcile editions to the official inventories. Return bill status or a vote decision and numeric tallies with a citation. Exercise both languages through the authenticated Worker. [Parliamentary catalogue API](PARLIAMENT-CATALOGUE-API.md) |
| 2. Federal directory, in parallel | Integrate the recovered GEDS intake and people, contact, organization, hierarchy and membership handlers with shared Worker authorization and metering. | Prove current and as-of lookup across a transfer and retain the full export import and replay receipt. [Directory work order](GEDS-WORK-ORDER.md) |
| 3. Chamber decisions, local preview | Bilingual House and Senate Journals supply cited passages and dispositions. All 198 House divisions have links from the Journals. Both chambers’ roll-call APIs expose individual positions and retain the citation for each vote. | Authenticated passage search, voting history, exact lookup and coverage with OpenAPI and bilingual Worker tests. [Verification and examples](PARLIAMENT-CATALOGUE-API.md#chamber-reconciliation) |
| 4. Funding programs and calls, local preview | Ingested all five current NSERC CCI calls and all 98 ESDC catalogue listings in each language, including closed and continuous intakes. | Typed, authenticated search, exact editions, observed versions and coverage. The English and French Worker checks trace both Polytechnics Canada recommendations from the finance committee brief to cited federal program terms. [Funding API](FUNDING-PROGRAMS-API.md) |
| 5. Committee calls for briefs, local preview | Reconcile current House, Senate and joint committee study listings in both languages. Capture published calls, submission instructions, deadlines and revisions. Link to the study, briefs and witness evidence already held. | For apprenticeship, return matching calls open as of the query date, or a dated zero with coverage gaps. Follow one real call to its instructions and study. Cite the speaker or submitter for each related position. |
| 6. Federal departmental consultations, local preview | Ingested both editions of the Open Dialogue catalogue (5,208 rows, 62 institutions) and serve the published policy question, dates, status, department and report links with a state computed for a queried date. The department notice is cited; its participation text is not parsed yet. | For applied AI, return matching opportunities and their status as of a specified date. Trace an extension or closure without losing the earlier notice. Expose missing dates, editions and outcomes. |
| 7. Departmental publications | Add ongoing ECCC audit and evaluation intake over both series, then expose the shared departmental publication API. | Search passages, retrieve a cited edition, inspect versions and coverage in both languages. [Departmental API and acceptance](#eccc-implementation-scope) |

The two participation intakes can be assigned separately. Use one typed opportunity contract for search, exact editions, status as of a date, revision history and deployment discovery. Each intake owns its publisher inventory and bilingual coverage receipt. An ongoing study alone does not establish that submissions are open. If the publisher omits a deadline, return it as unknown. Use apprenticeship and applied AI to test retrieval across the full collections.

**November 23 local result.** The official indexes yielded 201 bills, 198 House divisions and 36 Senate standing votes in each language. The latest indexed House vote is dated November 23. The latest indexed Senate vote is dated June 18. The Journals extend decision coverage through November 23 in the House and November 19 in the Senate. In Senate issue 102, the chamber adopted the report on S-216 on division. The Journal supplies the disposition without a named tally. The Journals-to-index comparison also found a named vote in June 2025 that the standing-vote index omits. The roll-call API serves those 80 named positions under `j16-3`, bringing the Senate total to 37 votes per language. [Verification receipt](PARLIAMENT-CATALOGUE-API.md#november-23-local-coverage)

**Funding intake result, November 23–24 (Toronto).** NSERC yielded five paired calls, with two open and three closed in each language. ESDC yielded 98 listings per language. The API serves detailed terms for 86 English and 84 French ESDC entries. Its coverage endpoint explains the 26 metadata-only entries and the 30 editions that could not be paired uniquely across languages. The applied AI and apprenticeship cases establish where a published program overlaps a proposal and what its funding and eligibility terms actually cover. Any claim about spending authority or an award requires a separate official citation. [Coverage and policy checks](FUNDING-PROGRAMS-API.md)

**Committee calls for briefs, November 24 (Toronto).** Both House editions list 15 studies that are currently seeking input across six committees. Seven studies publish a deadline in each edition; the rest publish instructions only. The API serves 30 call editions with the open state computed for the queried instant, links each to its study, and returns the study's published submissions, evidence and meeting counts. A query for apprenticeship on this list returns a dated zero rather than an inferred call. The intake also repaired 26 study titles that an earlier catalogue build had taken from a "Participate" button label. The Senate publishes briefs but no listing of studies currently inviting them; four pages per edition were checked and archived as that gap. [Calls contract](COMMITTEES-API.md#calls-for-briefs) · [Acquisition receipt](evidence/2026-11-24/committee-calls.json)

**Federal consultations, November 24 (Toronto).** The Open Dialogue catalogue imported 5,208 rows from 62 institutions in both languages. The published dates give 71 open, 10 planned and 5,127 closed at the observation; the publisher's own codes disagree with the dates on 111 rows, which the API reports rather than resolving silently. 772 rows publish a "What we heard" report and 8 lack the French description. The applied-AI query returns 12 consultations, one open, and the same record is closed on a later date. Extending one consultation's end date and adding its report produced a single recorded revision with the changed fields; replaying the catalogue adds nothing. The intake also repaired the identity rule found in the data: one department published `c-ISC0016` and `c-isc0016` as separate consultations. Department notices remain cited links; parsing who may participate and how to respond is the next item for this family. [Contract](CONSULTATIONS-API.md) · [Ingestion and acceptance receipt](evidence/2026-11-24/consultations-catalogue.json)

**Ongoing intake, November 24 (Toronto).** Both new collections run as refreshes, not one-off imports. The consultations intake archives each catalogue, records additions, removals and per-field changes in a digest an operator reads from the receipt, and keeps a removed notice retrievable with its history. The committee calls intake refetches both editions, marks a study that left the list without creating a revision, and holds publisher defects: a changed motion needs a second agreeing observation, and motion text that two study pages share in one run is never committed. Identical replays report zero changes in both pipelines. [Consultations refresh](CONSULTATIONS-API.md#refresh-and-revisions) · [Calls refresh](COMMITTEES-API.md#refresh-the-calls) · [Consultation receipt](evidence/2026-11-24/consultations-catalogue.json) · [Calls receipt](evidence/2026-11-24/committee-calls-refresh.json)

**Agent discovery, November 24 (Toronto).** The release candidate publishes deployment-specific source editions, dates, and English and French research requests through the capabilities manifest and agent guide. The apprenticeship check starts at discovery and follows the published steps to the Finance Committee submission, related testimony and ESDC program terms. A partial installation reports the missing source. Production rollout is a separate decision. [Agent discovery and acceptance test](AGENT-DISCOVERY.md)

**GEDS full export, November 24 (Toronto).** The October 25 bulk export imported and published from 189,994 source rows in 418 seconds: 189,877 roles, 188,816 people, 110 general-office listings and 21,874 organizations, with no unresolved record. Fifteen publisher rows carry an unescaped quote inside a quoted field; the reader now keeps them whole instead of splitting the record. A CSV replay re-read every row and added no snapshot or change event, and the published table digests were identical before and after. An authenticated Worker request resolves "Privy Council Office" and "Bureau du Conseil Privé" to one ID and returns a member's contact with the dataset and snapshot citation. [Import and replay receipt](evidence/2026-11-24/geds-full-import.json) · [Operators](GEDS.md)

### Routine current-session refresh

Use these checks in the operation of the collections already built. Each collection's dated evidence receipt provides its initial cutoff.

1. **Written questions.** Compare the full English and French 45-1 listings to the last successful inventory. Acquire new questions and newly tabled replies, including replies to previously pending questions. Recheck Q-105 and Q-338 and use the existing detail and reply recheck paths to catch revised attachments at the same URL. Record which gaps closed and which are still visible to API clients. [Acquisition commands](WRITTEN-QUESTIONS-PREVIEW.md#acquire-and-materialize-locally)
2. **Committees.** Rewalk the current House, Senate and joint indexes in both languages. Follow newly listed studies, meetings, evidence, submissions, reports and responses. Recheck previously listed material for corrected originals and late editions. Record a disappearance only after the relevant index was successfully read. [Committee operator guide](COMMITTEES-API.md)
3. **Journals and roll calls.** Rewalk both chambers’ Journal inventories. Refresh each vote index before fetching individual voting records, reconcile member positions and pairing flags to the official tallies, and compare later Senate Journal sittings with the last indexed standing vote. [Operators and API](PARLIAMENT-CATALOGUE-API.md)
4. **Funding programs.** Recheck the current NSERC CCI filter and ESDC’s full jobs and skills catalogue in both languages. Retain the original response behind each program section, keep unresolved language links visible in coverage, and publish each source transactionally. [Operators and policy checks](FUNDING-PROGRAMS-API.md)
5. **Committee calls for briefs.** Rewalk the House consultation list and every listed study page in both editions. Record a study that left the list as unlisted without a revision, hold a changed motion until a second observation agrees, and hold any motion that two studies published in the same run. Read `added`, `changed`, `dropped`, `pending` and `conflicts` from the receipt before trusting the collection. [Refresh and guards](COMMITTEES-API.md#refresh-the-calls)
6. **Federal consultations.** Download the published catalogue and its schema, materialize them, and read the change digest: added, removed, end-extended, end-shortened, start-moved, status-changed, report-changed, edition-changed. Recheck a removed record through exact lookup and confirm the earlier notice is still retrievable. [Refresh and digest](CONSULTATIONS-API.md#refresh-and-revisions)
7. **Verify each refresh.** Compare the two successful cutoffs by source and language. Record additions, revisions, confirmed removals and outstanding source IDs. Check a changed record through authenticated search or exact lookup in each available language. If the publisher has made no change, record that result and use fixtures to exercise a change. Interrupt and resume one run, replay identical inputs with zero new change events, and verify that a failed run leaves the previous serving data queryable. Publish the receipt with the repeatable commands and the last successful cutoff.

Use the existing local operators and typed API contracts. Once both collections pass, apply the same checks to current House and Senate Hansard and Canada Gazette intakes. Measure request volume, run duration and observed publication intervals before setting a hosted cadence under D-08.

### Collection backfill and refresh

| Collection | Acquisition boundary |
| --- | --- |
| House written questions and government replies | Enumerate parliamentary sessions from the House catalogue. Backfill questions, response sections and linked attachments by session. Question numbers restart each session. Key them by Parliament, session and question number. |
| House and Senate debates and Journals | Enumerate both chambers’ sitting calendars by session. Track every published sitting, document type and language edition, including editions published late. |
| Bills and votes | Enumerate LEGISinfo bills, versions, stage events and amendments, and both chambers’ published divisions for the selected session. Preserve official identifiers and source-evidenced links. |
| Committee proceedings | Inventory each chamber’s directory by session, including subcommittees and joint committees. Enumerate studies, meetings, notices, evidence, minutes, reports and government responses. Preserve appearances, authorship and chamber-specific identifiers. |
| Committee submissions | Walk every study’s House brief list and each Senate committee’s briefs and other documents table. Preserve submitter, organization, study, publication or receipt date, related appearance and every language/file link as published. Account separately for indexed links, stored originals and searchable text. |
| Fiscal references within policy records | When a committee, department or program publication cites a budget or spending bill, retain its official link, identifier and cited passage. Fiscal references are collected with the parent policy record. |
| Departmental policy and program delivery | Enumerate official policy suites, program manuals, departmental audit and evaluation indexes, and proactive briefing disclosures. Reconcile each declared collection and language edition to its publisher. [Sources and acceptance checks](#departmental-policy-and-program-delivery) |
| Canada Gazette | Walk the annual volume indexes for the supported parts, including extra editions. Reconcile every listed issue and its bilingual contents. Record which parts and years the corpus covers. |

The written-questions inventory starts with the House session list. The House links responses back to January 2001. Its own response-text search covers questions submitted after October 29, 2025. Inventory older attachments directly and record whether their text can be retrieved. [House catalogue](https://www.ourcommons.ca/written-questions/questions) · [House coverage notes](https://www.ourcommons.ca/written-questions/about)

For each backfill, record the source, scope, cutoff and discovered identifiers. Track question status separately from acquisition status. An unanswered question is a valid record. A missing French attachment or an unreadable answer is a coverage gap. Publish counts for discovered, stored and searchable records by session, document type and language, with outstanding IDs available for retry.

A completed local increment reconciles those counts to the official inventory, resumes after interruption, and replays unchanged input without duplicate records or change events. Refresh both new entries and older questions whose replies arrive later. Expose typed search, exact lookup and coverage with official citations and tests. Use Q-1010, S-5 and the freshwater week as retrieval regressions. Hosted source use and refresh cadence remain under D-08.

Use separate [source records](CORPUS.md#proposed-platform-corpus-model) for House speeches, committee interventions, members, bills, and meetings.
Report coverage and freshness for each committee. Track the event time, when the source publishes it, and when CivicSignal first sees it as separate facts where available.
Show gaps in language, transcripts, or media where they occur.

### Session 45-1 committee corpus execution plan

**Outcome.** Given a policy term in English or French, a client can find a written submission or witness passage, cite the author and original, follow it to the study and committee, and retrieve the report and government response where Parliament publishes those links. The acquisition boundary is every public 45-1 committee, subcommittee and joint committee through a recorded cutoff. Include completed, ongoing and inactive studies. Scheduled meetings and in-camera meetings retain whatever public notices or minutes exist.

**Starting evidence.** The November 23 inventory has 1,726 index entries across both languages. Each edition lists 61 House and joint directory entries and 29 Senate entries, including four shared joint committees. It found 666 House and joint study URLs, 4,803 House and joint submission file URLs and 1,709 Senate submission file URLs per edition. These counts describe discovered links. One PROC committee-business index returned 404 in both languages. The Senate adapter requests a page size of 250 and the House adapter parses links from the rendered work and meeting indexes. Proving that pagination and linked sections are exhausted is the first engineering task. [Acquisition evidence](evidence/2026-11-23/parliamentary-corpus.md) · [Catalogue adapter](../scripts/committee-catalogue.py)

#### Record and API contracts

| Record family | Acquire and expose |
| --- | --- |
| Committees and studies | Chamber or joint identity, subcommittee parent, session, bilingual titles, study or order of reference, related bills and official identifiers where published. |
| Meetings and oral evidence | Notice and revisions, public meeting status and date, minutes, evidence or transcript, witnesses, published affiliations and ordered speaking turns. Preserve official player and time links where supplied. |
| Written submissions | Briefs, correspondence, exhibits and attachments. Preserve each submitting person or organization as published, dates, study associations, edition, file language, original URL and file hash. |
| Findings and responses | Reports, recommendations, supplementary or dissenting opinions, presentation to a chamber, response request and government response. Cite the source for each relationship. Expose publication and response dates where available. |

Use the [existing corpus model](CORPUS.md#proposed-platform-corpus-model). Scope IDs by session and publisher identity. Retain both directory references for a joint committee. A shared file can serve multiple editions, authors or studies. Deduplicate its bytes by hash and retain each published association. Keep unknown speakers, affiliations, translations and relationships explicitly unknown. Preserve the source location of each passage, such as a speaking turn, page or section. Record source-use terms by publication class before enabling text delivery for that class. Keep the metadata and official link retrievable when delivery is limited.

The implemented operations below share the prefix `/api/committees`. List and search operations use bounded, deterministic pagination. Exact lookups and all passages carry official citations and edition information. Use the existing Worker access, metering, validation and error contracts. Extend the existing committee OpenAPI document and preserve the freshwater brief route.

| Client operation | GET paths |
| --- | --- |
| Enumerate the session and traverse the record | `/{session}`, `/{session}/{committeeId}`, `/{session}/{committeeId}/studies`, `/{session}/{committeeId}/meetings`. Committee IDs distinguish House, Senate and joint bodies. |
| Inspect a study or meeting | Append `/{studyId}` or `/{meetingId}` to the corresponding collection path. Return cited relationships and paged links to publications, appearances and outcomes. |
| Read a publication and its text | `/{session}/documents/{documentId}` and `/{session}/documents/{documentId}/passages`. Include document kind, credited parties, edition and file availability. |
| Search, inspect coverage and discover the contract | `/search`, `/coverage`, `/openapi.json`. Search supports language, session, chamber, committee, study and document kind. Coverage reports cutoff, counts and outstanding source IDs by committee, kind and edition. |

#### Work order and ownership

The implementation record below reconciles these work packages to the local release. The parent owns contracts, integration and acceptance. Use three persistent implementation owners when executing, each on `gpt-6-luna` at medium reasoning. Keep one owner per file. Each owner returns the changed paths, focused test results, source IDs or URLs, and unresolved coverage gaps.

| ID | Owner and dependencies | Deliverable and observable check |
| --- | --- | --- |
| CC-01 | Parent, first | Freeze resource IDs, relationships, route precedence, coverage states and publication kinds in the shared contract. Use a joint committee, a shared bilingual submission and a multi-study meeting as fixtures. The same official record resolves from each published parent. |
| CC-02 | Acquisition owner, after CC-01 | Extend `scripts/committee-catalogue.py` and `test/test_committee_catalogue.py`. Walk both language editions, Senate table continuations, House work and meeting histories, reports and their response links. Record source totals or terminal-page evidence per index, detect repeated pages, and distinguish a genuine empty list from a parser failure. Reconcile the November 23 baseline and explain additions, removals and count changes. |
| CC-03 | Storage owner, after CC-01 | Implement the local committee store under `scripts/lib/` and isolated D1 preview schema under `preview/committees/migrations/`. Reuse the written-questions object storage and chunking patterns. Round-trip one meeting, two studies referencing one file, and two editions sharing bytes. Verify interrupted writes can resume. |
| CC-04 | Acquisition owner, after CC-02 and CC-03 | In a proceedings adapter under `scripts/lib/`, acquire every inventoried study, meeting and linked notice, minutes, testimony, report and response. Preserve ordered turns and source-backed cross-links. Test House, Senate, joint, in-camera and unpublished-transcript cases. |
| CC-05 | Storage owner, after CC-02 and CC-03 | In a separate submissions adapter under `scripts/lib/`, acquire every discovered brief, exhibit, correspondence item and attachment. Verify original bytes, extract searchable text, retain page or section locations, and record unsupported, image-only and unavailable files by ID. Test one shared PDF, a missing edition and a changed file at the same URL. |
| CC-06 | API owner, after CC-01, integrate with CC-03 | Own committee contracts and handlers under `src/corpora/` and `src/routes/`, their OpenAPI examples, and focused route tests. Develop against fixtures while acquisition runs. Verify traversal, cited bilingual search, pagination, unavailable text and access errors. Parent owns mounting in `src/index.ts` and integration into `test/endpoints.test.ts`. |
| CC-07 | Parent with the three owners, after CC-04 through CC-06 | Run the full local backfill, materialize an isolated Cloudflare D1 candidate, exercise authenticated Worker requests, then interrupt, resume and refresh. Publish the coverage receipt, query examples and replay commands alongside the corpus evidence. Reconcile actual coverage and remaining work to this plan. |

#### Implementation record

| Work | Local result |
| --- | --- |
| CC-01 and CC-06 | The authenticated Worker serves typed committee, study, meeting, publication, passage, search and coverage operations. Its OpenAPI includes these paths alongside the earlier freshwater preview. [HTTP contract](COMMITTEES-API.md) |
| CC-02 | Both editions of all directories were walked. The acquisition reconciled 244 House and joint indexes, 1,332 House study pages, 200 Senate indexes and 3,108 Senate notice pages. The catalogue includes 238 contextual links to Senate orders of reference. |
| CC-03 through CC-05 | Source bytes are content-addressed. The database preserves explicit study and meeting relationships, cited report parts, bilingual originals and individual witness turns. Third-party submissions return attribution, location and the official link. |
| CC-07 | The full-size candidate is local. The dated receipt reports the snapshot cutoff, acquisition gaps, authenticated retrieval, replay and D1 integrity checks. [Verification and coverage](evidence/2026-11-23/parliamentary-corpus.md#committees-and-submissions) |

This inventory is the baseline for [routine current-session refresh](#routine-current-session-refresh). The [GEDS directory](#geds-people-organizations-and-contact-discovery) can proceed independently.

#### Acceptance and verification

1. **Coverage.** At the run cutoff every directory, index page and discovered publication has a disposition. Reconcile discovery, stored originals and searchable text separately by chamber, committee, kind and edition. Every gap has an official source, reason and last check. An unexplained missing page, silently truncated list or outstanding internal parser failure keeps the affected collection open. A documented publisher 404 can close as a source gap. Recheck the known PROC gap.
2. **Retrieval.** Through authenticated HTTP, retrieve a real House witness passage, Senate submission and joint committee record. Exercise English and French searches and follow a result to its study and original. Follow an officially linked report to its government response where available. Verify an unavailable edition, stable page traversal and a multi-page document. Record the query, expected source ID, citation and actual result for each case.
3. **Refresh.** Interrupt acquisition mid-collection and resume. Replay unchanged source data and verify stable IDs, hashes and zero duplicate rows or change events. Exercise a corrected notice, replaced file, late translation and removed link on deterministic fixtures. Confirm observed changes through a second live catalogue walk. Preserve the previous serving generation on a failed import and confirm it still answers queries.
4. **Integration.** Run `python3 -B test/test_committee_catalogue.py`, focused adapter and storage tests added by CC-03 through CC-05, `bun run test test/committee-study.test.ts test/endpoints.test.ts`, and `bun run validate`. Verify the documented authenticated calls against the session-sized candidate separately. Record checks and counts in the dated evidence ledger.

The completion artifact is a locally queryable, documented committee corpus with a reproducible coverage receipt. Pre-alpha priority is accurate attribution and visible gaps, then retrieval speed, then freshness. Historical-session backfills, hosted publication and client workflows are later milestones. If publisher structure makes a mapping ambiguous, return the affected source IDs to the parent, settle that mapping once, and rerun its focused check before integration.

#### Historical archive reuse

Older-session acquisition is deferred while current intakes take priority. When it resumes, start with the full **44-1 House committee evidence** manifest. Its 2,149 entries identify committee, meeting and evidence publication. The same session/committee/meeting lookup matched all 701 archived 45-1 entries to searchable English and French records in CivicSignal. Enumerate the official 44-1 listings, join both directions, verify edition-specific citations and originals, and publish counts for matched, archive-only, publisher-only and unavailable records. Exercise the resulting data through authenticated bilingual search and exact lookup. Include 41-2 in later publisher discovery because the local archive has no committee manifest for it. [Archive evidence and cross-check](evidence/2026-11-23/parliamentary-corpus.md#archive-sources-mapped-to-the-remaining-backend-work)

For later work, use the Gazette Part II URL ledger and House and Senate debate collections for historical discovery and replay. Seed budget and costing inventories from the federal budget and PBO ledgers. Check the archived federal CKAN PDFs against departmental publisher URLs and the Treasury Board policy IDs against the live policy catalogue. Keep the older Justice XML checkout for parser regression. Record official coverage and source-use decisions per collection. The private backup spans 16 dataset repositories and its September 27 audit recovered 57 previously failed sources. Per-source backup dates and hashes still need comparison if restoring from those repositories. [Federal public service engineering handover](FEDERAL-PUBLIC-SERVICE-HANDOVER.md) · [Historical acquisition and restore code](https://github.com/wra-sol/gpt-from-scratch/tree/3900d593c1a650772533794879e5775ddd9de569)

### GEDS people, organizations and contact discovery

**Directory recovery baseline.** Local branch `aboiteau/geds` at `a5adddc` contains 23 files verified against the R2 checkpoint, including the importer, migration, typed routes, OpenAPI builder and fixtures. On that revision, 16 of 18 focused tests pass under Bun. Two API tests look for a transferred employee in their former unit. The hosted run later processed 189,994 source rows and passed 18 tests. Its later revision and full-import receipt still need to be reproduced. [Recovery evidence](https://github.com/chester-hill-solutions/cf-opencode/issues/141)

**Current directory integration.** The working tree includes the importer and an isolated preview migration `preview/geds/migrations/0010_geds.sql`. Seven documented data routes use the current Worker’s workspace authorization and retrieval billing. Fixture tests cover a person moving between units and a query against the earlier snapshot. The full October 25 export is imported and replayed: 189,994 source rows, 21,874 organizations, 189,877 roles, no unresolved record, and an authenticated lookup that resolves one unit from both published names and cites its contact. The 15 malformed publisher rows and the reader rule that recovers them are recorded with the receipt. Then use the verified directory IDs for the parliamentary links below. [Directory API](GEDS-API.md) · [Full import](evidence/2026-11-24/geds-full-import.json) · [Standalone acceptance criteria](GEDS-WORK-ORDER.md)

A staffer can start with a policy topic, a name, a title or an office and find whom to contact. Use the Government Electronic Directory Services (GEDS) bulk export for federal public servants and organizational units. Committee records also identify external witnesses and submitters. Keep those stakeholders discoverable through their published appearances and submissions.

1. **Acquire dated directory snapshots.** Check the bilingual bulk export daily and retain each changed snapshot. Give people and organizational units stable CivicSignal IDs. Preserve published names, titles, department and unit names, parent units, professional contact details, source citation and observation date. Departments maintain their own entries and some list only managers or office numbers. Represent missing contact details and show when the listing was last observed. [Official bulk dataset](https://open.canada.ca/data/en/dataset/8ec4a9df-b76b-4a67-8f93-cdbc2e040098) · [GEDS coverage notes](https://geds-sage.gc.ca/en/GEDS/?pgid=005)
2. **Connect people and offices to parliamentary evidence.** Link a departmental reply to the organization that signed it. For a named witness or submission author, require corroborating evidence such as a matching published affiliation and title before linking a directory identity. Keep ambiguous candidates separate. Label why each topic search matched, cite the passage or directory entry, and preserve the role as published on the event date alongside the latest observed role.
3. **Serve typed, documented Worker endpoints.** Provide people search and lookup at `GET /api/people` and `GET /api/people/{id}`. Support organization search, parent and child lookup by `asOf`, and traversal through `GET /api/organizations/{id}/people` and `GET /api/organizations/{id}/appearances`. Return a published work email or telephone where available, identifying whether it reaches the person or a general office. Include English and French OpenAPI examples and tests through the authenticated handlers.

**Acceptance.** Starting with drinking water and no known name, search in English and French, resolve the same federal unit, retrieve a cited appearance and a written reply linked to that unit, and follow a published contact route. Test a same-name ambiguity, a witness who later moved branches, and a unit with only a general office number. The result must show why the person or office is relevant and which source supports the contact details.

### First monitoring workflow

This is a future client of the parliamentary research API. Current implementation priority is source ingestion, storage, typed handlers and API documentation.

| Staffer task | API result |
| --- | --- |
| Check what changed on a file | Search using the file's terms and filters on each request. Filter by member, committee, bill, date, and language. Allow clients to fetch new and corrected results after a cursor. |
| Track keywords and similar terms | Support exact phrases and optional related-term matching. Return the matching phrase or passage and how it matched. Apply explicit filters to every match. |
| See who spoke and what they said | Return the speaker, topic, meeting or sitting, published time or sequence, linked bills, transcript citation, and permitted excerpt. Distinguish the bill under debate from bills that were mentioned. |
| Watch the relevant moment | Return a verified link to the moment in the official player when the source supports one. Report whether a recording is audio only, available without a verified offset, or unavailable. |
| Track regulatory proposals and instruments | Search and retrieve Gazette records by topic, part, and date. Return the source citation, publication date, and any consultation deadline or effective date the source states. |
| Understand why it matters | Show which part of the file matched and cite the records that relate the event to the file. Cite the procedural rule when an interpretation depends on it. Label possible next steps and state their conditions. |

Use caller-supplied search criteria for the first monitoring API. Saved watchlists, scheduled checks, and delivery follow the search API.
Give an agent a real policy file and a completed sitting week. Ask it to find relevant remarks and report any confirmed changes to the linked bills.
Compare the underlying search results and the agent's brief against the staffer's review of that week.
Check attribution, English and French search, related-term matches, official video links, source gaps, and missed events.
Record whether each gap came from the source, the API, or the agent's use of the results.

The [House publication viewer guide](https://www.ourcommons.ca/Content/Guides/DocumentViewer/hansardguide-E.pdf) describes playback links to individual interventions.
Check actual link behavior and source coverage in both languages. Check media and excerpt use against the [House source terms](https://www.ourcommons.ca/en/important-notices).

### Competitor feature inventory

#### Parliament Monitor workflow benchmark

The November 23, 2026 comparison describes Parliament Monitor, a tool built for Polytechnics Canada, alongside Gnowit, Hill Monitor, Page, PoliAlerts, PoliTraQ, MyParliament, and Track My MP. Its 18 of 32 leading rows reflect the capabilities selected for that team's work. The comparison used vendor descriptions for competitor entries, with a hands-on check of PoliTraQ's public connector. Use the findings to choose pilot workflows and verify any vendor capability that affects a product decision. [Parliament Monitor comparison map](https://claude.ai/artifact/WWVP8vuksa14rRZeFvUmV1)

| Roadmap priority | CivicSignal pilot evidence |
| --- | --- |
| **Follow a committee study through its next action.** | Local historical preview. ENVI's freshwater brief links a meeting notice, minutes, the report presentation and the government response. Its dated views show when the response became due and when the government fulfilled the request. [Committee action](BILL-TRACE-API.md#committee-study-action) |
| **Carry official-record corrections into the next brief.** | Local replay. A simulated correction to bilingual Gazette metadata drops a watched term. The next brief identifies each corrected edition once, cites the official record and retains the feed cursor. A later live-caption pilot would also need to reconcile provisional observations against published Debates or Evidence. [Change reader](SOURCE-CHANGE-FEEDS.md#read-the-next-bilingual-brief) |
| **Deliver a daily policy-file brief to the team.** | The [freshwater review packet](../preview/policy-files/freshwater-2026-05-25/BRIEFS.md) covers one completed House sitting week. Staffer review is pending. The replay uses published records and cannot reconstruct late corrections or original delivery times. A separate correction replay covers that behavior. Scheduled checks and team delivery remain Phase 5 work. |

The freshwater packet contains six direct events and two related leads. The House floor check covered 2,486 interventions per language across sittings 121–125. All six Senate debate editions for sittings 74–76 returned zero direct matches. The packet also covers five House Journals, ENVI’s two meetings and Gazette index titles. Other committees and departmental releases remain coverage gaps. The C-241 amendment cutoff and the Report 5 response deadline have separate owners. [Daily briefs](../preview/policy-files/freshwater-2026-05-25/BRIEFS.md) · [Offline replay](../scripts/freshwater-week.ts) · [Date and coverage tests](../test/freshwater-week.test.ts)

The November 23 local validation of the freshwater week passed 2,472 tests across 132 files with Workerd enabled, four TypeScript projects and all 13 Ratchet Strap rules. The separate Python operator suite passed 31 tests. The corpus invariant check skipped three absent generated statute ingest files. Hosted Phase 4 publication still depends on D-08. [Historical study tests](../test/committee-study.test.ts) · [Bilingual replay test](../test/bilingual-brief.test.ts)

The comparison reports 30–60 seconds for proceedings Parliament Monitor watches live. Treat that figure as an external benchmark for a future live-alert pilot. Measure latency, missed mentions, and attribution against published records before setting a CivicSignal target. Expand live capture, provincial coverage, lobbying registries, and media sources when recurring pilot needs and source availability justify them.

#### Published vendor capabilities

The November 23, 2026 review uses Gnowit as the benchmark for broad Canadian coverage and Hill Monitor for federal monitoring.
Government Radar, PoliTraQ, and Legislative Pulse supply examples of digests, briefings, and alerts tied to an Act.
The sources describe vendor offerings. The CivicSignal scope column records how each feature fits this plan.

| # | Feature and the job it serves | CivicSignal scope |
| --- | --- | --- |
| 1 | **Saved monitoring projects.** Keep sources, terms, and recipients together for an issue or client. [Gnowit guide](https://www.gnowit.com/wp-content/uploads/2022/10/Guide-Getting-Started-with-Gnowits-vAnalyst-1.pdf) | Phase 5 policy file and watchlist. |
| 2 | **Keyword, phrase, and Boolean matching.** Limit results to the terms, people, and institutions that matter to a file. [Gnowit FAQ](https://www.gnowit.com/faqs/) | Phase 4 phrase search and structured filters in English and French. Add Boolean expressions if pilot files need them. |
| 3 | **Historical search.** Find previous mentions and open the matching passage. [Gnowit Parliamentary Live](https://www.gnowit.com/products/parliamentary-live/) · [Hill Monitor](https://hillmonitor.ca/) | Phase 4 search and exact lookup. Set history depth per source under D-08. |
| 4 | **Follow a person.** See when a selected MP or senator speaks. [Hill Monitor](https://hillmonitor.ca/) | Phase 4 member filter. Phase 5 watchlist alerts. Consider social posts with wider source coverage. |
| 5 | **Duplicate suppression.** Reduce repeated alerts about the same development. [Gnowit FAQ](https://www.gnowit.com/faqs/) | Use stable event identity for replay and delivery. Group linked editions in one digest entry and show material corrections. |
| 6 | **Bill tracking.** Follow introductions, referrals, amendments, votes, and Royal Assent. [Gnowit bill tracking](https://www.gnowit.com/government-bill-tracking-software-canada/) | The [S-5 replay](BILL-TRACE-API.md) covers one bill through both chambers. Expand federal coverage from that slice. |
| 7 | **Alerts on affected law.** Follow an Act when a bill proposes to amend it or an instrument appears under it. [Legislative Pulse guide](https://www.lexisnexis.ca/pdf/products/clp/canadian-legislative-pulse-quick-reference-card.pdf) | Link affected Acts and provisions where the source establishes the relationship. Add Act-based alerts after the links are available. |
| 8 | **Bill text and amendment analysis.** Find matching bill text and see summaries of amendments and affected Acts. [Hill Monitor](https://hillmonitor.ca/) · [Gnowit plans](https://www.gnowit.com/pricing/) | Preserve bill versions and amendment evidence in Phase 4. Test comparisons of published versions on a pilot file. |
| 9 | **Chamber and committee search.** Find who said what and see published decisions and reports. [Gnowit coverage](https://www.gnowit.com/coverage/) · [Hill Monitor](https://hillmonitor.ca/) | Build on the floor previews. Add committee evidence, minutes, and reports in both languages. |
| 10 | **Live transcripts and shareable clips.** Find a speaker, witness, motion, or moment in a broadcast. [Gnowit Parliamentary Live](https://www.gnowit.com/products/parliamentary-live/) · [Gnowit plans](https://www.gnowit.com/pricing/) | Start with verified official playback links. Use pilot demand and source rights to decide whether to add live transcription and clipping. |
| 11 | **Regulatory and consultation monitoring.** Find proposals, final instruments, and comment deadlines. [Gnowit coverage](https://www.gnowit.com/coverage/) · [Hill Monitor](https://hillmonitor.ca/) | Start with Gazette Parts I and II. Follow the regulatory lifecycle expansion for consultations, Orders in Council, and commencement evidence. |
| 12 | **Wider government and media coverage.** Monitor written questions, announcements, provincial and municipal activity, procurement, and news. [Hill Monitor](https://hillmonitor.ca/) · [Gnowit sources](https://www.gnowit.com/sources/) | Add federal procedural and accountability sources in Phase 4. Use recurring pilot needs to choose wider jurisdictions and sources. |
| 13 | **Scheduled digests and urgent alerts.** Read routine updates together and get selected events as they occur. [Government Radar](https://www.govradar.ca/) · [Gnowit guide](https://www.gnowit.com/wp-content/uploads/2022/10/Guide-Getting-Started-with-Gnowits-vAnalyst-1.pdf) | Phase 5 daily digest from the change feeds. Let the team choose urgent event types and recipients. |
| 14 | **Cited research and briefings.** Explain the change and let the reader open the evidence. [PoliTraQ FINLAI](https://politraq.ca/finlai/) | Qualify the brief through the existing policy-file scenario. Cite factual claims and give the source and coverage for each result. |
| 15 | **Stakeholder reporting.** Share selected records, clips, and concise reports with clients or colleagues. [Gnowit Legislative Monitoring](https://www.gnowit.com/products/legislative-monitoring/) · [PoliTraQ](https://politraq.ca/pricing/) | Start with a shareable, cited brief. Let pilot users establish demand for branded reports and document exports. |
| 16 | **API and structured export.** Bring matches and source records into existing systems. [Gnowit API](https://www.gnowit.com/gnowit-api-custom-monitoring/) · [Hill Monitor](https://hillmonitor.ca/) | Use typed HTTP and MCP contracts and paginated change feeds. Let integration demand determine export formats. |
| 17 | **Government relations operations.** Prepare for meetings, manage contacts, log engagements, and assemble lobbying returns. [PoliTraQ](https://politraq.ca/pricing/) | Treat these as separate expansions after the monitoring pilot. |

### Federal source expansion

House Hansard includes chamber debates and Committee of the Whole. House and Senate committees publish their own records. Evidence records what was said, Minutes of Proceedings record what happened and what was decided, and reports record findings and recommendations. Treat meeting notices, published witness briefs and government responses as linked records with their own provenance. [House parliamentary record](https://www.ourcommons.ca/procedure/procedure-and-practice-4/ch24-2-e.html) · [Senate committee publications](https://sencanada.ca/en/committees/about/fundamentals/)

The local S-5 preview follows the 44th Parliament’s environmental protection bill from first reading in the Senate to Royal Assent. It links the three published versions to the Senate ENEV and House ENVI studies, selected witness testimony, minutes, reports and adopted amendments. House division 338 on third reading is linked to sitting 202 of the Journals. The Senate Journals document concurrence in the Commons amendments. The brief identifies the bill by Parliament, session, number and LEGISinfo ID and serves either language at a typed HTTP endpoint. [Replay and API](BILL-TRACE-API.md) · [Official bill history](https://www.parl.ca/legisinfo/en/bill/44-1/s-5)

ENVI recorded no request for a government response to its S-5 report. The deadline preview follows the same committee’s freshwater study in the 45th Parliament. ENVI voted to request a response on May 5, 2026. It presented Report 5 to the House on May 28. Standing Order 109 gave the government 120 days from presentation, making September 25 the deadline. The House recorded the response that day. The freshwater study and S-5 have separate identities and citations. [S-5 study record](https://www.ourcommons.ca/Committees/en/ENVI/StudyActivity?studyActivityId=11908825) · [Freshwater report presentation](https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-124/hansard) · [Standing Order 109](https://www.ourcommons.ca/procedure/standing-orders/chap13-e.html#109) · [Committee publications](https://www.ourcommons.ca/committees/en/ENVI/Work)

On November 23 the local replay stored 35 linked records. Both language editions matched the original XML for three publication identifiers, 12 stage events and the 324 participants in House vote 338. Replaying the packet produced zero new events. Local validation passed 2,460 tests and all 13 Ratchet Strap rules. If a selected source is missing, the brief names it and marks links to its records unavailable. Hosted source coverage and refresh remain open under D-08. [Replay tests](../test/bill-trace.test.ts)

Expand each source through the collection backfill and refresh work order. Use the examples below to test relationships and retrieval after acquisition. Case law needs its own source inventory and coverage boundaries. Fiscal references travel with the policy records that cite them.

| Expansion | Sources and acceptance evidence |
| --- | --- |
| **Parliamentary business and procedure** | Expand Journals and recorded votes in both chambers for decisions. Add Order Paper and Notice Paper editions for pending business, plus House Standing Orders, Senate Rules and Speakers' rulings for procedural citations. Show when an item was listed, acted on or decided, and cite the rule or ruling used to explain it. [House publications](https://www.ourcommons.ca/procedure/our-procedure/ParliamentaryPublications/c_g_parliamentarypublications-e.html) · [Senate chamber documents](https://sencanada.ca/en/about/procedural-references/notes/n13/) |
| **Regulatory lifecycle** | Add departmental Forward Regulatory Plans and public consultation listings for early notice and comment deadlines. Add Orders in Council, Gazette Part I and II extra editions, and Part III public Acts and related proclamations and orders. For a pilot regulation, link the proposed and final instruments and their impact analysis statements where the sources support the link. Verify Royal Assent, publication, commencement and consultation dates as separate facts with citations. [Cabinet Directive on Regulation](https://www.canada.ca/en/government/system/laws/developing-improving-federal-regulations/requirements-developing-managing-reviewing-regulations/cabinet-directive-regulation.html) · [Consultations](https://www.canada.ca/en/government/system/consultations/consultingcanadians.html) · [Orders in Council](https://www.canada.ca/en/privy-council/services/orders-in-council.html) · [Gazette editions](https://gazette.gc.ca/cg-gc/lm-sp-eng.html) |
| **Written accountability records** | Index written questions, government replies, tabled papers and, where useful to the pilot, public petitions and their responses. Link a reply to the original question or petition, the responding institution and any tabled attachment. Prove that search can surface an answer contained in a tabled paper. [House written questions](https://www.ourcommons.ca/written-questions/about) · [House petitions and responses](https://www.ourcommons.ca/petitions/Documents/PI-Paper%20Petitions-Guide%20for%20Members.pdf) |
| **Case law and administrative decisions** | Start with Canada Industrial Relations Board decisions tied to the Canada Labour Code. Prove that retrieval can find a decision that applies a specific provision and cite the relevant passage. Expand to federal courts, the Supreme Court and other tribunals in response to pilot demand. Retain the deciding body, decision date, citation, cited provisions and any verified appeal or review relationship. [CIRB decisions](https://cirb-ccri.gc.ca/en/decisions/decisions) |
| **Spending and oversight** | Retain a department’s or committee’s explicit reference to a budget measure or spending bill. Link an audit finding or recommendation to the responsible office and published response. A standalone spending catalogue is outside the current build order. [Federal financial cycle](https://www.canada.ca/en/environment-climate-change/corporate/transparency/briefing-materials/corporate-book/departmental-financial-budget-cycle.html) · [Auditor General guide](https://www.canada.ca/en/auditor-general/our-work/other-resources/examining-public-spending-estimates-review-a-guide-for-parliamentarians.html) · [Proactive disclosure](https://open.canada.ca/en/proactive-disclosure) |

Keep typed source records and cite links to the primary publication. Represent links such as a bill under study, a provision cited in a decision, or an order establishing commencement only when a source supports that relationship. Record the publisher, edition language, version and coverage, plus the event date, publication time and first observation where available. Choose source-specific history, refresh cadence, permitted excerpts and redistribution under D-08 before advertising hosted coverage. Record the disposition in the [licence register](LICENCE-REGISTER.md).

### Departmental policy and program delivery

#### Federal public service corpus scope

Engineering starts from the [federal public service handover](FEDERAL-PUBLIC-SERVICE-HANDOVER.md), which includes the dated bilingual schedule roster, source entry points, census worksheet generator and bilingual acceptance cases.

**Institutional boundary.** Cover the publicly available administrative record of every institution in the federal core public administration and every federal separate agency. Build the dated roster from schedules I, IV and V of the Financial Administration Act and reconcile names against Treasury Board’s departmental series. Use the Canada.ca directory to find publishers. Track machinery-of-government changes, former names, predecessor and successor institutions, and jointly authored works. A public servant’s briefing to a minister belongs to the authoring institution. A parliamentary proceeding, external audit or court ruling can be linked evidence under its existing corpus. Membership in the dated roster determines which institutions receive a full administrative backfill. [Financial Administration Act and schedules](https://laws-lois.justice.gc.ca/eng/acts/F-11/) · [Treasury Board institutional series](https://www.canada.ca/en/treasury-board-secretariat/services/innovation/human-resources-statistics/population-federal-public-service-department.html) · [Publisher directory](https://www.canada.ca/en/government/dept.html)

**Acquisition unit.** For each institution, inventory every official publication series in the families below, with its bilingual index URLs, publisher, earliest and latest listed period, identifiers, formats, release pattern and source terms. Include closed series and published archives. Discover series through departmental sites, the Open Government Portal and Government of Canada Publications. Cross-check the federated catalogues against the institution’s own holdings. Register a newly discovered series even when it requires a new adapter. Preserve references to disclosed but unavailable records, including redacted and title-only entries. [Federal publications catalogue and checklists](https://publications.gc.ca/site/eng/browse/index.html) · [Open Government disclosures](https://open.canada.ca/en/proactive-disclosure)

| Record family | Published records to acquire | Question the API should answer |
| --- | --- | --- |
| Mandates, organization and responsibility | Mandates, delegations, organizational charts, departmental results frameworks, program inventories, service inventories and dated directory entries. Preserve the office responsible at the time. | Which branch owned this program or had the delegated authority on a given date? |
| Administrative policy and service delivery | Central and departmental policies, directives, standards, procedures, guidance, manuals, operational bulletins, program terms, eligibility criteria, application guides, forms, service standards and published performance against them. | Which instructions applied to this case, who issued them, and what changed? |
| Management of the public service | Published workforce and staffing plans, employer guidance and agreements, values and ethics instruments, official languages and accessibility plans and progress reports, privacy and algorithmic impact assessments, and departmental digital and information-management plans. | What commitments govern the institution’s own operations, which office owns them, and what progress has it published? |
| Staff analysis and advice | Published staff reports, options and discussion papers, briefing-note disclosures, question period notes, transition and committee-appearance binders, technical advice, and released memoranda and annexes. Index completed access-request summaries and attach released documents when publicly available. | What did officials recommend, what evidence did they cite, and how much of the advice is public? |
| Research, consultation and engagement | Departmental research and technical reports, scientific assessments, statistical releases, methods, published datasets supporting findings, consultation notices, available submissions, response summaries and final departmental positions. Preserve authorship and relevant dataset versions, units and periods. | What evidence and submissions informed the department’s position, and where did it explain its response? |
| Regulation and administration | Forward regulatory plans, stock reviews, impact analyses, orders, implementation guidance, published administrative decisions, interpretations, compliance and enforcement reports from in-scope issuers. Use existing statute, Gazette and decision records for cited instruments. | How did an announced change reach a published decision or instruction, and when did each take effect? |
| Plans, resources and delivery | Departmental plans and results reports, business and implementation plans, service performance reports, Estimates and Public Accounts references, disclosed grants and contributions, procurement notices, awards and amendments. Preserve program, fiscal period, recipient and transaction identifiers as published. | What did the department plan, what authority and resources did it receive, what did it spend, and what results did it report? |
| Assurance, review and follow-up | Internal audits, program evaluations, inspections, public reviews, management responses, action plans, progress tables and public responses to independent oversight. Keep each finding, responsible office, due date and attributed assessment. | What failed, who agreed to address it, and what later evidence supports or contests completion? |

Use official structured sources where available. The federal service inventory provides a starting point for program delivery. CanadaBuys exposes award notices and contract history. The completed access-request catalogue identifies public summaries and documents gaps in institutional participation. Register their different coverage and update cycles independently. [GC Service Inventory](https://open.canada.ca/data/en/dataset/3ac0d080-6149-499a-8b06-7ce5f00ec56c) · [CanadaBuys awards and contract history](https://canadabuys.canada.ca/en/support/searching-award-notices-and-contract-history) · [Completed access-request summaries](https://open.canada.ca/data/en/dataset/0797e893-751e-4695-8229-a5066e4fe43c)

**Backend contract across collections.** Give clients typed, authenticated operations to enumerate institutions, programs, series and date-bounded coverage, search passages or structured records, retrieve an edition and its history, follow cited relationships and consume a paginated change feed. Preserve the original bytes or catalogue record according to source terms. Return citations down to the section, edition-specific page, table row or dataset record. Distinguish author, decision maker, accountable office and reviewer. Record the applicable date, publication date and first observation separately. Link advice to a decision, a program to its cited budget measure, or a response to completion only where the publication supports that relationship. Reuse departmental publication search, GEDS, Gazette and parliamentary contracts at their existing boundaries. Document OpenAPI examples and handler tests for every public operation.

| Delivery milestone | Work at federal scale | Evidence to close |
| --- | --- | --- |
| 1. Institutional and source inventory | Enumerate the entire roster and map each institution against the eight families. Record official series, archives, central bulk sources, ownership changes and unresolved discovery. | A dated coverage matrix showing the institutions examined, known series, history, languages and open discovery work. Preserve the evidence for an empty listing. |
| 2. Shared acquisition and first working collections | Build common catalogue, original-file, edition, passage, table, structured-row and change storage. Run the ECCC report collections, IRCC guidance, the briefing register with nil returns, and the Treasury Board policy suite as its indexes become accessible. | Bilingual end-to-end checks exercise conflicting assessments, receipt-date applicability, title-only advice, and current and retired instruments. Report each collection independently. |
| 3. Government-wide backfill | Ingest central bulk collections once and partition coverage by issuing institution. Roll out departmental adapters by publication system and format across the roster. Include partner-hosted reports, linked annexes, old sites and late translations. Capture the earliest available indexed period for each series. | Reconcile each series to a dated manifest. Expose independent counts for discovered works, editions, originals, searchable material, publisher gaps and recoverable failures. Re-run every affected collection after parser or source corrections. |
| 4. Cross-collection recall | Join separate source records through published identifiers, citations and dated organizational relationships. Test retrieval across institutions and through transfers of responsibility. | In both languages, trace an operating rule to its authority, a program commitment to its cited authority and reported results, and a recommendation through the responsible office and latest published follow-up. Return identifiable gaps along each trace. |
| 5. Maintained hosted service | Use published feeds for incremental updates and periodically rewalk complete indexes for corrections, withdrawals and missed editions. Set cadence and storage budgets from observed publication intervals, payload sizes and refresh traffic. Stage candidate generations and verify restore, retry and rollback under D-08. | Publish source-specific history, freshness, permitted output, last successful reconciliation and remaining gaps. Test the hosted API against the same references used locally. |

**Completion and sizing.** Close a historical backfill for a named roster, source manifest and cutoff. Every roster member must have a discovery disposition for each family, and every discovered series must have a documented history boundary. Keep outstanding discovery and retryable acquisition work visible alongside any qualified coverage claim. Continue discovery and refresh after that cutoff. Size engineering by distinct publisher templates, record formats and extraction exceptions, and size operations by editions, source bytes, indexed text, peak build space and refresh requests. The ECCC estimate below covers one implementation. Produce a federal estimate after the roster census and measured runs for bulk records, HTML and PDFs, including a sample of scanned reports and complex tables.

#### Initial source adapters

These first adapters exercise four publication patterns. The federal inventory above determines the rest of the backfill.

| Collection | First backfill and evidence |
| --- | --- |
| Treasury Board policy instruments | Enumerate the policy suite, including inactive instruments, in both languages. Keep the instrument type, scope of application, effective dates, cited authority and explicit replacement links. The digital policy index provides a second source for checking relationships. Direct requests to the central index returned a rejection during this review. Verify catalogue traversal before reporting totals. [Policy suite](https://www.tbs-sct.canada.ca/pol/index-eng.aspx) · [French catalogue](https://www.tbs-sct.canada.ca/pol/index-fra.aspx) · [Digital policy index](https://www.canada.ca/en/government/system/digital-government/policies-standards.html) |
| Departmental operating policy and guidance | Start with Immigration, Refugees and Citizenship Canada (IRCC). Walk every program category, manual chapter and listed bulletin year in each language. Follow the instruction updates and RSS feed on refresh, and periodically reconcile the full indexes. Preserve the published conditions that determine which version applies to a case. [IRCC English index](https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/operational-bulletins-manuals.html) · [IRCC French index](https://www.canada.ca/fr/immigration-refugies-citoyennete/organisation/publications-guides/bulletins-guides-operationnels.html) |
| Departmental staff reports, evaluations and internal audits | Start with every listed fiscal year in Environment and Climate Change Canada’s two indexes. Acquire each published summary, full report, annex and management action plan. Give recommendations and responses separate citations, retaining the authoring unit, responsible office, deliverable and target date where stated. Link subsequent evidence of completion when published. [Evaluation index](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations.html) · [Internal audit index](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits.html) |
| Staff briefings and disclosed advice | Ingest the federal monthly briefing-note register and its companion file for institutions reporting no entries. Preserve institution, reference number, reporting period and titles as disclosed, including redactions. Inventory published transition and committee-appearance packages separately. A register entry supports title search. Passage search requires a published document with retrievable text. [Bilingual bulk files and schema](https://open.canada.ca/data/en/dataset/ee9bd7e8-90a5-45db-9287-85c8cf3589b6) · [Briefing package collections](https://open.canada.ca/en/proactive-disclosure) |

**API and coverage.** Provide typed, authenticated search, exact edition lookup, version history and coverage through documented Worker handlers. Support institution, program, document kind, language and as-of date. Return the cited section or page and the publisher’s applicability conditions. If the historical text or effective date is unknown, expose that gap. Count indexed records, archived originals, searchable editions and metadata-only disclosures separately by institution and series. Record corrections, replacements and withdrawals on refresh. Apply the existing D-08 source-use review before hosted publication.

**Acceptance through the API.** Run each retrieval in English and French against the completed source inventories.

1. For the IRCC self-employed persons class, compare an application received on May 2, 2017 with one received on May 3. Retrieve the OP 8 manual for the first and the successor instructions for the second, citing the publisher’s receipt-date rule. [IRCC manual index](https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/operational-bulletins-manuals.html)
2. For Lake Winnipeg, retrieve recommendation 1 on sustaining the in-lake research platform, the departmental response, the office assigned to the funding-model deliverable and its March 31, 2027 target. Return completion status only when a follow-up publication establishes it. [Departmental evaluation, section 3.2](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations/freshwater-action-plan-lake-winnipeg-basin.html)
3. Retrieve a briefing-note title and reference number from the bulk register and show its text availability. Verify counts against both monthly files. Test a missing translation, a revised manual, an interrupted backfill and unchanged replay through the existing collection checks.

#### Source feasibility and first backfill

**November 23 feasibility review.** Start with the complete published ECCC evaluation and internal-audit indexes. Both are bounded by fiscal year, and the Lake Winnipeg example shows that the English and French HTML editions carry the recommendation, response, assigned office and target date. This makes it possible to test the value of passage search while reconciling two entire series. Report unique works, language editions, full reports, summaries and missing files separately. [Evaluation index](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations.html) · [Audit index](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits.html) · [Lake Winnipeg English report](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations/freshwater-action-plan-lake-winnipeg-basin.html) · [French report](https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/evaluations/plan-action-eau-douce-bassin-lac-winnipeg.html)

- **Bulk discovery.** Public Services and Procurement Canada offers downloadable bibliographic records for monographs, periodicals and series. The listed files are dated November 20, 2025. Seed the inventory from a dated export, then reconcile subsequent weekly checklists and departmental indexes. MARC fields 791/792 identify English and French counterparts where supplied, 794/795 link later and earlier editions, and 590 records the checklist number and date. A catalogue entry establishes discovery. Count searchable coverage after retrieving the linked publication. [Bulk dataset](https://open.canada.ca/data/en/dataset/30f7114d-4b3f-4201-8dc7-0d71eb769617) · [Publisher’s field documentation](https://donnees-data.tpsgc-pwgsc.gc.ca/bi1/pub-pub/soutien-support-eng.html)
- **Operational guidance.** Both IRCC indexes give the OP 8 receipt-date rule. The English PDF has 36 pages and the French PDF has 40, so cite the page in the retrieved edition. Each index also lists an OP 1 retirement date with only the year specified. Preserve that precision. For an as-of query, distinguish the rule governing a case from evidence of the actual wording published on a past date. The existing D-08 review must account for IRCC’s terms on commercial redistribution of passages. [English manual](https://www.canada.ca/content/dam/ircc/migration/ircc/english/resources/manuals/op/op08-eng.pdf) · [French manual](https://www.canada.ca/content/dam/ircc/migration/ircc/francais/ressources/guides/op/op08-fra.pdf) · [Manual index and dates](https://www.canada.ca/en/immigration-refugees-citizenship/corporate/publications-manuals/operational-bulletins-manuals.html) · [IRCC terms](https://www.canada.ca/en/immigration-refugees-citizenship/corporate/terms-conditions.html)
- **Remaining access checks.** The briefing register documents two CSV resources. This review could read the catalogue and search results, but could not retrieve the files through the research client. Verify both downloads and reconcile one reporting period before estimating volume. Published deputy-head committee briefing packages have their own catalogue filter and linked resources. For Treasury Board, verify that the acquisition environment can enumerate both current and inactive instruments before claiming suite-wide coverage. [Briefing register](https://open.canada.ca/data/en/dataset/ee9bd7e8-90a5-45db-9287-85c8cf3589b6) · [Deputy-head packages](https://search.open.canada.ca/opendata/?collection=parliament_committee_deputy) · [Policy suite](https://www.tbs-sct.canada.ca/pol/index-eng.aspx)

Reuse the local written-questions pipeline’s checkpoint, content-addressed originals and full-text index. During the ECCC backfill, measure downloaded bytes, extractable pages, bilingual gaps and index size, then repeat the inventory and verify that unchanged records produce zero new versions. Those measurements establish the storage and refresh budget for adding departments. [Existing local acquisition and serving model](WRITTEN-QUESTIONS-PREVIEW.md)

**ECCC inventory baseline, November 23.** Counts below come from the available publisher index snapshots. Count each titled entry under a fiscal year once per index and each link under that entry once per appearance, including summaries, plans and repeated targets. A work can appear in both series. Reconcile fresh copies of all four indexes together on the first acquisition run.

| Index | Fiscal years displayed | Title entries EN / FR | Link appearances EN / FR |
| --- | --- | ---: | ---: |
| Internal audits | 2015–16 through 2026–27 | 46 / 46 | 73 / 73 |
| Evaluations | 2019–20 through 2025–26 | 45 / 44 | 86 / 84 |

The French evaluation snapshot was older than the English snapshot. The extra English entry was the freshwater quality science evaluation. Its French report was reachable from the English report’s language selector. Discover editions from both the indexes and the documents, record the discovery path, and count a translation gap only after checking both paths. [Audit index EN](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits.html) · [FR](https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/audits-internes.html) · [Evaluation index EN](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations.html) · [FR](https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/evaluations.html) · [French freshwater report](https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/evaluations/evaluation-execution-science-qualite-eau-douce-eccc-preliminaire-rapport-avr-2026.html)

**Follow-up retrieval test.** Ask in each language whether ECCC implemented the Appendix K guidance from its 2021 grants and contributions review. Table 1 of the June 2024 progress report records two assessments. The Centre of Expertise reported completion. The auditors assessed the action as in progress because the guidance had been withdrawn after questions arose. Return both assessments with their authors, the report date and the table row. Preserve the link to the 2021 review so the action is attributed to its originating recommendation. [English progress report, table 1](https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits/audit-administration-grants-contributions-eccc-2024/progress-2021-review-insights.html) · [French progress report, tableau 1](https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/audits-internes/audit-administration-subventions-contributions-eccc-2024/progres-2021-examen-observations.html)

#### ECCC implementation scope

**Deliverable.** A researcher using the authenticated local Worker API can search either language across both ECCC series, open the cited report edition, and follow a finding to the published response or follow-up. Ship a repeatable backfill and refresh command, a local serving database, OpenAPI examples, handler tests and a dated coverage report. This is the first departmental increment in Phase 4.

**Acquisition boundary.** Walk every fiscal-year group on all four live indexes at the run cutoff. The research snapshots contained 181 title appearances and 316 link appearances across English and French. These are planning counts before deduplication. Follow each listed work to its published summary, report, progress report, action plan, annex, alternate format and language edition, including an official partner department when it publishes the indexed report. Follow child pages that make up the publication. Record ordinary references to other works as citations. List publisher-reported but unavailable files with their URL and the acquisition outcome. Historical coverage begins with the years enumerated on each index.

| Work package | Dependencies | Deliverable and completion check |
| --- | --- | --- |
| 1. Inventory and identity | Four official index URLs | Save dated copies and parse each edition independently. Assign stable IDs for works, editions and component documents. Keep each index appearance and discovery path, including cross-listed plans and documents found through a language selector. Reconcile counts by series, fiscal year and language and explain differences from the research baseline. |
| 2. Originals and refresh | Inventory IDs | Archive bytes by content hash and retain source URL, format, language, retrieval time and publisher date where supplied. Checkpoint each item. Test interrupted download, unchanged replay, corrected content at the same URL and a late translation. Retain the previous edition when a link disappears. Recheck transient failures before recording a publisher gap. |
| 3. Passage and table extraction | Representative originals from both series | Index HTML sections and text-bearing PDF pages. Preserve table captions, column headers and row labels with each cited cell. Keep management responses and auditors’ assessments attributable to the speaker or issuing unit. Store image-only or unreadable pages with an explicit searchability gap. Prove the three bilingual retrieval cases below against the final inventory. |
| 4. Typed API and local serving | Stable record shapes from 1, extracted passages from 3 for integration | Provide the four read operations below with the existing Worker authorization, request validation, pagination and error conventions. Build a candidate with local `cf` D1 tooling, verify counts and index lookups, and switch the local serving generation atomically. Test that a failed build leaves the previous generation queryable. |
| 5. Reconciliation and handoff | 1–4 integrated | Rewalk the four indexes, classify changes since the first cutoff and replay the unchanged inputs. Publish counts for appearances, unique works, language editions, originals, searchable documents and unresolved gaps. Include source bytes, peak build disk, final index size, request count, failed fetches and run times for acquisition and refresh. Supply commands to rebuild, resume, refresh and run the HTTP acceptance cases. |

Use the existing [written-questions materializer](../scripts/materialize-written-questions.ts) and [HTTP preview](WRITTEN-QUESTIONS-PREVIEW.md) as implementation references. The [committee acquisition code](../scripts/lib/committee_files.py) demonstrates content verification and checkpoints. Keep departmental identity independent of a parliamentary session. Build the API fixtures while acquisition runs.

**Proposed HTTP contract.** Use `GET /api/departmental-publications` for passage search with query, language, institution, series, fiscal year, document kind and optional program. Use a stable cursor. Return work and edition IDs, matched text, source URL, section or edition-specific page, and table coordinates where applicable. Use `GET /api/departmental-publications/{id}` for exact retrieval with edition language, components and source-supported relationships. Use `GET /api/departmental-publications/{id}/versions` for dated evidence and `GET /api/departmental-publications/coverage` for the inventory cutoff, totals and paginated gaps. An as-of lookup must identify whether the date comes from the publisher or from a CivicSignal observation. Represent an unknown historical edition explicitly. Document the static coverage route and test its precedence over ID lookup.

**Release evidence.** Exercise the real local HTTP handlers in English and French. The Lake Winnipeg query must return recommendation 1, its response, owner and target date. The Appendix K query must return both attributed assessments from the same table row. The freshwater quality science lookup must reach the French edition through the publisher’s language link. Include an unsupported edition, an unreadable file and stable cursor traversal in the contract tests. Every discovered item needs a recorded disposition. Report outstanding fetch or extraction failures separately from confirmed publisher gaps. A complete inventory can still have partial searchable coverage.

**Effort and sequencing.** Allow roughly 1–2 engineering days for inventory and identity, 2–4 for archival and extraction, and 2–4 for API integration, reconciliation and documentation. This 5–10 day estimate assumes one engineer reusing the local preview tooling, with ordinary HTML and text-bearing PDFs, and excludes unattended download time. Re-estimate after the first inventory and representative extraction. OCR, production scheduling and hosted redistribution are separately sized increments. For the following collections, reuse the inventory, edition, passage and coverage contracts. IRCC adds receipt-date applicability and manual replacement, briefing disclosures add bulk metadata and nil reports, and Treasury Board adds current/inactive instrument reconciliation once traversal is verified.

### Local Hansard speech slice

The existing cite-only adapter searches stored speech excerpts with a topic or keywords and inclusive sitting-date filters. A result keeps the stored speech ID, speaker, sitting date, and House citation link. The adapter checks that a search term appears in the permitted excerpt. Matching folds accents and case. The response preserves the source spelling and follows the existing 400-character limit. [Synthetic fixture tests](../test/hansard.test.ts)

The local CLI imports a sitting from normalized JSON into SQLite. It derives a stable speech ID from the language, sitting ID, and intervention ID. English and French records can share a source intervention ID. Re-imports apply corrections to that language's record and its search text in one transaction. Search accepts a language and returns cite-only results. Show takes an exact speech ID.

```sh
hansard_db="$(mktemp -d)/hansard.sqlite"
bun scripts/hansard-local.ts import "$hansard_db" test/fixtures/hansard/sitting.json
bun scripts/hansard-local.ts search "$hansard_db" fr reglement
bun scripts/hansard-local.ts show "$hansard_db" hansard:fr:fixture-123:fixture-turn-1
```

The local sample uses synthetic records. A November 23 check of House sitting 109, dated April 23, 2026, confirmed the XML mapping. Both editions use publication ID `13463391` and have the same 361 unique `Intervention/@id` values. Each value maps to a `#Int-<id>` anchor in both official transcripts. The XML root identifies the edition with `xml:lang`. Store the language of the published edition separately from the language spoken on the floor. [House open data](https://www.ourcommons.ca/en/open-data) · [English XML](https://www.ourcommons.ca/Content/House/451/Debates/109/HAN109-E.XML) · [French XML](https://www.ourcommons.ca/Content/House/451/Debates/109/HAN109-F.XML)

The XML parser derives the sitting identity from Parliament, session, and sitting number. It preserves each intervention ID across language editions and builds the edition's transcript link. It reads spoken paragraphs in order and passes a short excerpt to the SQLite importer. The importer records edition language. Floor language remains future metadata. [XML parser](../src/ingest/hansard.ts)

```sh
hansard_db="$(mktemp -d)/hansard.sqlite"
bun scripts/hansard-local.ts import-xml "$hansard_db" test/fixtures/hansard/sitting-en.xml
bun scripts/hansard-local.ts import-xml "$hansard_db" test/fixtures/hansard/sitting-fr.xml
bun scripts/hansard-local.ts search "$hansard_db" fr reglement
bun scripts/hansard-local.ts show "$hansard_db" hansard:fr:45-1-999:99002
```

The parser read all 361 interventions in each official sitting 109 edition in memory. The two ordered ID lists matched, and every excerpt fit the 400-character cap. Local persistence and retrieval use synthetic fixtures. This check covers one actual sitting. Commercial excerpt use and source coverage remain D-08 decisions. [English intervention](https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-109/hansard#Int-13463397) · [French intervention](https://www.ourcommons.ca/DocumentViewer/fr/45-1/chambre/seance-109/debats#Int-13463397) · [House terms](https://www.ourcommons.ca/en/important-notices)

### One-week House Hansard replay

The local CLI can replay a manifest of saved XML files. It can also discover one completed week in a specified Parliament and session. It reads the official calendar, checks that it covers all seven days, and requests both XML editions for each sitting. The local SQLite store commits each edition with its exact-byte digest and parser version. A replay skips identical editions. Corrections update existing speech IDs and remove superseded speeches within that edition. Missing and failed editions appear separately in the run report. [House calendar](https://www.ourcommons.ca/documentviewer/en/SessionPublicationCalendarsWidget?organization=HOC&publicationTypeId=37&parliament=45&session=1)

```sh
hansard_db="$(mktemp -d)/hansard.sqlite"
bun scripts/hansard-local.ts replay-week "$hansard_db" test/fixtures/hansard/week.json
bun scripts/hansard-local.ts replay-week "$hansard_db" test/fixtures/hansard/week.json
```

For approved House source use, `sync-week "$hansard_db" 45-1 2026-04-20` uses the same replay path. The read-only check discovered sittings 106 through 110 for April 20–26, 2026. The parser verified all ten source files in memory and read 1,455 interventions per edition language across the week. Synthetic records verified SQLite writes, correction replay, and recovery from a missing edition.

A scheduled Cloudflare run needs a durable edition state design, an approved request budget, and the D-08 source-use disposition.

### Senate debates

Senate floor debates have a local bilingual replay and search path. The importer shares the House edition checksum and correction logic and keeps Senate records under their own IDs and source policy. The official calendar listed three sittings for April 20–26, 2026. The parser verified the six official editions in memory and read 415 speaker-labelled opening paragraphs per language across issues 65–67. SQLite persistence, correction replay, and search use synthetic editions. [Senate calendar](https://sencanada.ca/en/in-the-chamber/debates/) · [English issue 67](https://sencanada.ca/en/content/sen/chamber/451/debates/067db_2026-04-23-e) · [French issue 67](https://sencanada.ca/fr/content/sen/chamber/451/debates/067db_2026-04-23-f)

Results link to official transcript sections. Each local speech ID uses the section and speaker-turn position within that edition. Structural corrections can shift these positions. Search covers up to 400 characters of each speaker-labelled opening paragraph. Senate source use for a hosted or commercial feature remains part of D-08. [Senate terms](https://sencanada.ca/en/intellectual-property/)

```sh
hansard_db="$(mktemp -d)/hansard.sqlite"
bun scripts/hansard-local.ts replay-senate-week "$hansard_db" test/fixtures/senate-hansard/week.json
bun scripts/hansard-local.ts search-senate "$hansard_db" fr reseau
bun scripts/hansard-local.ts show "$hansard_db" senate-hansard:fr:45-1-67:8-1
```

### Hansard HTTP preview

The Worker exposes chamber-specific search and exact speech lookup with typed request, response, and error schemas, workspace authorization and usage, and a generated OpenAPI description. Both chambers use the same search and lookup logic. The data routes are disabled by default. Local tests proved the contract with fixture rows, and Workerd served OpenAPI and enforced workspace authentication. Each chamber now also has a typed change feed. MCP operations and scheduled publication remain open. Hosted source use remains part of D-08. [Hansard API contract](HANSARD-API.md) · [Contract tests](../test/endpoints.test.ts)

Ratchet Strap enforces the 13 rules in Callcaster's lint ratchet against CivicSignal's baseline. The CI workflow supplies the prior revision for baseline comparison. Local `bun run validate` passed all 2,403 tests, with Workerd checks enabled. [Rule profile](../house-rules/index.mjs) · [Validation workflow](../.github/workflows/validate.yml)

### Canada Gazette

Include Part I proposals and notices and Part II official regulations in regulatory monitoring. [Canada Gazette publications](https://gazette.gc.ca/rp-pr/publications-eng.html)
Give Gazette records their own IDs, citations, and change feed. Report the feed's coverage and freshness separately from Parliament and the current-law corpus.
Link a proposal to its final instrument and link an instrument to affected provisions where official sources establish those relationships.
Return metadata and official links under the [Gazette publication policy](LICENCE-REGISTER.md#the-gazette). Keep the published instrument and any verified effective date available as separate facts.

#### First Gazette backend slice

The preview covers the same April 20–26, 2026 week as Hansard. For each language, Part I volume 160, number 17 (April 25) yielded 20 notices and two proposals. Part II volume 160, number 8 (April 22) yielded three instruments. The English and French lists reorder entries. All 25 source identifiers matched across the two languages using linked record pages, fragments or instrument identifiers. Each language edition retains its own ID, title and citation. [Part I English](https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/index-eng.html) · [Part I French](https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/index-fra.html) · [Part II English](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/index-eng.html) · [Part II French](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/index-fra.html)

The local sync reads the four indexes and stores their metadata in SQLite for offline recall. Part II records preserve the published registration number and registration date. These indexes supplied no consultation deadline or effective date. Replay commits corrections per edition, removes superseded rows and skips identical inputs. The separate `verify-live` command checks the official indexes in memory. [Sync and replay](../scripts/gazette-local.ts) · [Storage tests](../test/gazette-store.test.ts)

The CLI and authenticated Worker use the same search and exact lookup code. Typed HTTP responses identify the issue coverage and distinguish an unavailable edition from an available edition with zero hits. Local tests exercise the ingestion-to-HTTP path with fixture indexes. The data routes are disabled by default. Hosted publication and proposal-to-instrument links remain open. [API and replay guide](GAZETTE-API.md) · [Contract tests](../test/gazette-api.test.ts) · [Worker integration tests](../test/endpoints.test.ts)

The November 23 local sync persisted 50 records. A second sync of the same metadata wrote zero rows. After reopening the database, accent-folded title search and exact lookup returned the same record and official citation for all 50. This check establishes recall of known titles in the two April issues. Free-form topical recall and other weeks require separate evaluation.

#### Source changes for a policy file

The Gazette, House and Senate previews now journal additions, corrections and removals in the transaction that updates an edition. Existing editions acquire an initial baseline on replay. The November 23 Gazette sync established 50 baseline events across four editions. At seven events per page, each language returned 25 unique record IDs over four pages. Resuming at the final cursor returned zero events in both languages. A French Part II feed query for `DORS/2026-65` returned the April 22 instrument. Each event distinguishes publication from observation and retains the official citation. [Feed guide](SOURCE-CHANGE-FEEDS.md) · [Journal schema](../preview/source-feed/migrations/0001_source_feed.sql)

Each source exposes a typed, authenticated GET with its own cursor scope, coverage and attribution. Fixture replays exercise corrections that drop the watched term, removals, unchanged input and rollback. The Worker tests cover paging, resumption, workspace usage and source isolation. Local validation passed 2,444 tests with Workerd enabled, all 13 Ratchet Strap rules and 31 separate Python operator tests. Hosted refresh and source-use approval remain open under D-08. The [S-5 committee brief](BILL-TRACE-API.md) extends source-linked recall to one bill. [Importer-to-HTTP tests](../test/endpoints.test.ts) · [Cursor and coverage tests](../test/source-feed-api.test.ts) · [Workerd D1 test](../test/source-feed-workerd.test.ts)

The local bilingual brief now consumes those feeds. A replay of the official Gazette metadata found SOR/2026-65 in English and DORS/2026-65 in French. The next poll returned zero changes across four stored Gazette editions and marked both chambers unknown. A separate test changed both titles in a disposable database. It returned each correction once, kept the official citations and showed that both records had lost their match. [Reader and replay instructions](SOURCE-CHANGE-FEEDS.md#read-the-next-bilingual-brief) · [Correction regression](../test/bilingual-brief.test.ts)

### Daily cosmetics policy file

Use this scenario to qualify the agent workflow as each source becomes available.
A government relations staffer follows animal testing and chemical rules that could affect a cosmetics client.
The team gives its agent the file's terms in English and French, plus any ingredients, bills, committees, or members to follow.
The team's agent runs the check each day and keeps a cursor for each supported change feed.

| Task | Expected result |
| --- | --- |
| Pull the current law | Return the relevant federal provisions, their status, the corpus revision, and exact citations. |
| Check what happened since the last run | Find relevant chamber and committee remarks, bill developments, formal decisions, and updates to the published law. Cite each change or correction and state which sources the run covered. |
| Check for committee action | As committee coverage expands, follow a relevant study and surface an open call for briefs or a government response deadline. Cite the official notice, report, or applicable procedural rule that supports the date. |
| Identify a regulatory development | As coverage expands, check Forward Regulatory Plans, public consultations and Gazette editions for upcoming changes, comment deadlines, and final instruments. Cite each record and give publication, consultation and commencement dates where the sources establish them. |
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
Extend the workspace API with saved watchlists, scheduled checks, and recipient preferences.
Group digest entries by policy file. Show the event, its date, the matching passage, and the official link.
Show why each event matched. Let staffers change terms or exclusions and preview the effect on the previous week.
Show the last successful check by source. Distinguish a quiet day from an unavailable edition and show late corrections.
Use one real policy file over a complete sitting week to check the view and digest with a staffer.

| Surface | Direction and condition |
| --- | --- |
| Developer console | Add workspace access, key lifecycle, usage, and payment controls when manual operation blocks demand |
| Hosted OpenCode harness | Reuse OpenCode and the existing plugin; qualify customer isolation, credentials, process cost, and host choice |
| External web answers | Keep search in the harness; fetch publisher passages with provenance and source policy checks |

Customers can continue to use their own agent harness through MCP.
A hosted harness needs a separate runtime and pricing decision.
It does not reopen the v1 platform choice automatically.

### Agent-assisted policy-file onboarding

**Roadmap pilot.** Take a staffer from a policy question to a reviewed watchlist and a first cited brief. Use the [daily cosmetics policy file](#daily-cosmetics-policy-file) for the first walkthrough.

Campaign Brain saves a setup draft and uses structured questions with room for free text in its discovery chat. It records affirmed answers and checks readiness before the user confirms the move to research. Adagio's Launch Brief design lets the agent suggest sourced values from intake notes for an operator to review before they drive a launch plan. [Campaign Brain setup](https://github.com/chester-hill-solutions/campaign-brain/blob/main/web/src/pages/OnboardingWizard.tsx) · [Campaign Brain discovery](https://github.com/chester-hill-solutions/campaign-brain/blob/main/api/src/prompts.ts) · [Adagio Launch Brief](https://github.com/chester-hill-solutions/chester-hill-solutions/blob/main/packages/adagio/ADAGIO_MVP_PLAN.md)

1. Start with the staffer's description, pasted notes, or optional files. Support direct uploads and use the CHS connector package for selected Google Drive files.
2. Offer an editable draft with topics, bilingual terms, exclusions, relevant bills, committees or people, and proposed source coverage. Link suggestions to the staffer's answer, attached file, or cited record. Ask one focused question at a time where an answer changes the watchlist. Save progress so the staffer can resume or edit the draft directly.
3. Preview the watchlist against a recent sitting week. Show why records matched, what coverage was available, and how a proposed exclusion changes the results. Let the staffer correct the draft and review a sample brief before confirming the watchlist, delivery schedule, and recipients.
4. After confirmation, open the saved policy file and start any checks and delivery the staffer enabled. In the pilot, resume a draft, correct a sourced suggestion, and retry confirmation. Verify that the saved file reflects the reviewed settings and that confirming twice leaves exactly one watchlist and one schedule when scheduling is enabled.

### Proposed CHS Agent Assisted Onboarding package

Prototype a shared workflow in CHS with Campaign Brain discovery and CivicSignal policy-file setup as candidate consumers. Use Adagio intake as a reference for sourced suggestions and review. Validate the same contract in two host flows before extracting and publishing a package.

The shared contract should cover structured questions and answers, resumable drafts, source references on suggested fields, readiness checks, and the review and confirmation flow. Reuse CHS UI Kit components for messages, questionnaires, and file inputs. Each host supplies its own field schema, prompts, source permissions, storage and commit handlers. The host validates the reviewed draft and applies the confirmed action once, including on retry. CivicSignal owns policy-file matching, citations, schedules, and delivery. [CHS UI Kit](https://github.com/chester-hill-solutions/chester-hill-solutions/blob/main/packages/ui-kit/README.md)

## Decisions still required

Record each open decision and its supporting evidence before the dependent work.

Source commit age and last successful ingestion age do not measure the latest upstream check.
The approved D-01 policy allows the observed head or an explicitly approved, recent ancestor. Use the current checker for the fresh packet. The older operator's age caps apply to its historical packet. [Approved serving bar](V1-EVALUATION.md#d-01-serving-decision)

| ID | Decision and next action | Responsible role | Blocks |
| --- | --- | --- | --- |
| D-02 | Collect the eight staging cases and have the product owner independently verify every factual claim before chat release. | API and evaluation owners for capture, product owner for review | MP-03 chat acceptance |
| D-03 | Accept concrete budgets, finite windows, and residual provider uncertainty for each operation | Operator and approving user | The respective hosted execution |
| D-04 | Identify writer authorities and approve actual maintenance, capture, reconciliation, and resume controls | Release engineer and writer owners | MP-04 acquisition and MP-05 migration |
| D-05 | Review the complete release evidence and production switch/rollback candidate | Product owner and release engineer | MP-06 production release |
| D-06 | Select audience, task, public name, experiment window, and stop criteria | Product owner | Phase 2 distribution |
| D-07 | Confirm the API's usage unit, retry behavior, and reconciliation contract | API and billing owners | Phase 3 API qualification |
| D-08 | Confirm history, refresh cadence, bilingual coverage and permitted source use per corpus, starting with the House and Senate floors and committees, bills, chamber records and the Canada Gazette. Apply the same review as later federal sources enter scope. | Product owner with API and source owners | Hosted release of each Phase 4 corpus |

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
