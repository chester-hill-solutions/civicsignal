# CivicSignal master plan

Updated 2026-10-31. Status: v1 remains incomplete.

CivicSignal will give applications and agents source-cited Canadian civic information.
The first release serves Canadian federal statutes and regulations in English and French.
The immediate objective is to close four release gates: scheduled first publication, serving acceptance, production migration, and the final release audit.

This file owns scope, priorities, dependencies, decisions, and next actions.
The [release evidence ledger](V1-RELEASE.md) owns detailed results and source-specific receipts.
Supporting documents supply contracts, procedures, historical evidence, or future designs.
They do not create another work order.

## Immediate work order

1. **Finish operation source linkage under MP-01.** Connect the qualified source-loader repair and its receipts to each operator.
2. **Finish local preparation.** Complete, check, and review the scheduled-publication, API, serving, and Zen operators under MP-02 and MP-03.
3. **Resolve execution inputs.** Record the acceptance policy, chat disposition, operation budgets, fresh target facts, and production writer authorities.
4. **Close the first three gates.** Complete MP-02 and MP-03; acquire a consistent production capture through MP-04 before MP-05's copy proof.
5. **Complete MP-06.** Audit all ten requirements, review the production switch and rollback, then record the approved operation's actual result.

MP-01 supplies the exact candidate for each operation.
MP-02, MP-03, and MP-04 preparation can proceed independently.
MP-04 capture must pass before MP-05's production-derived proof.
The final production decision waits for MP-02, MP-03, and MP-05 acceptance.
Named operators and approvers remain execution prerequisites; role assignments below do not select them.

## Release gates at a glance

All four gates remain open. The ten [release requirements](V1-RELEASE.md#release-requirements) retain their individual acceptance checks.

| Gate | Packages | Completion evidence |
| --- | --- | --- |
| Scheduled first publication | MP-02 | A scheduled event creates a distinct instance and first complete publication; all artifacts match; canonical state and cleanup pass |
| Serving acceptance | MP-03 | Accepted bilingual quality and performance reports, positive hosted Zen chat, and advertised route checks |
| Production migration | MP-04, MP-05 | Consistent production capture, hosted protected-copy proof, compatible switch, and authorization-preserving rollback |
| Final release | MP-06 | The exact final source passes engineering checks; all requirements reconcile; the approved production switch passes |

## Plan authority

The former product plan remains in [PLAN-HISTORY.md](PLAN-HISTORY.md).
The following dispositions resolve conflicts among the planning documents.

| Earlier proposal | Current disposition |
| --- | --- |
| Move the API to Railway and remove Cloudflare services | Use Cloudflare for v1; preserve Railway services and portability code |
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

1. **Use Cloudflare for v1.** Keep the API, corpus pipeline, D1, R2, Vectorize, and encoder container in the existing account.
2. **Preserve Railway services.** Keep the Bun/Postgres portability implementation; this release does not migrate to Railway or decommission it.
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

The latest qualified implementation is **`5d4915c`**.
Its [complete local gate](evidence/2026-10-31/integrated-candidate-local-validation-v9.json) and [clean Linux gate](evidence/2026-10-31/candidate-5d4915c-linux-ci-validation.json) pass with 477 source and fixture inputs.
Those checks cover 1,975 tests, 31 Python cases, four compiler projects, runtime checks, invariants, and five dry builds.
Later source changes need their own complete checks.
The qualified [source-loader repair closes issue 14](https://github.com/chester-hill-solutions/civicsignal/issues/14).
It compiles the exact checked source bytes; Python cache flags alone do not establish that identity.
The [release ledger](V1-RELEASE.md#october-31-implementation-progress) preserves earlier candidates, repairs, failed checks, and exact receipts.

| Package | Responsible role | Dependency | Current position and next deliverable |
| --- | --- | --- | --- |
| [MP-01](#mp-01-reconcile-the-exact-candidate) | Release engineer | Current source | Complete local and Linux gates pass; finish operation source linkage and fresh hosted identities |
| [MP-02](#mp-02-qualify-scheduled-first-publication) | Pipeline engineer and operator | MP-01 before execution | Runtime controls qualify; finish the operator successor, calendar facts, event, budgets, and hosted first publication |
| [MP-03](#mp-03-close-serving-acceptance) | API engineer and evaluation owner | MP-01 and product acceptance decisions | Repairs and labels qualify; finish API/serving/Zen operators, then complete hosted acceptance |
| [MP-04](#mp-04-qualify-consistent-production-acquisition) | Release engineer and writer owners | Actual authority and common maintenance | Fixture mechanisms pass; establish writer control and acquire consistent production inputs |
| [MP-05](#mp-05-qualify-protected-copy-and-production-rollback) | Migration engineer | MP-04 capture for production-derived proof | Local mechanisms pass; qualify hosted copy, production target, and rollback |
| [MP-06](#mp-06-qualify-the-final-source-and-release-packet) | Release engineer and product owner | MP-02, MP-03, and MP-05 acceptance | Draft candidate; complete final checks, requirement audit, and production decision |

The [runtime accounting](evidence/2026-10-31/snapshot-reference-accounting-runtime-v2.json) preserves the original successful-path baseline and records conditional callback bounds.
Those bounds do not establish a global provider ceiling or guarantee cancellation of stalled binding requests.
The predecessor first-publication operator links actual local/Linux source proof; its owner requires a source-loader successor before execution.
The API, serving, Zen, and publication operator successors remain drafts until their final checks, source linkage, and reviews pass.
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

## Phase 1 Close the v1 release

Engineering owns implementation, source pins, checks, and the evidence packet.
The product owner decides acceptance policy, material scope changes, and separately bounded hosted or production actions.
Local preparation for MP-02, MP-03, and MP-04 can proceed independently after MP-01.
Production cutover waits for all required evidence and the final decision.

### MP-01 Reconcile the exact candidate

**Status:** exact successor local and Linux checks pass; operator linkage and fresh hosted identity remain open.
**Requirements:** V1-02, V1-09, V1-10.

- [x] Retain the earlier source's complete local and clean Linux receipts.
- [x] Repair the helper loader and pass the complete successor local gate.
- [x] Retain matching clean Linux evidence for the successor's exact source and fixture inputs.
- [ ] Bind each operator, bundle, dependency, and source receipt to that qualified candidate.
- [ ] Connect actual deployed identities and current requirement dispositions to the operation packet.

Preserve unrelated work, failed receipts, accepted artifacts, and consumed execution markers.
Distinguish deployed provider repairs from newer local code and unfinished private drafts.

**Exit evidence:** one source-specific inventory connects the ten release requirements to their current receipts and remaining tasks.
Use the [release evidence ledger](V1-RELEASE.md), [operations procedure](V1-OPERATIONS.md), and [writing rules](WRITING.md).

### MP-02 Qualify scheduled first publication

**Status:** shared runtime controls and predecessor preparation pass; the operator successor and hosted qualification remain open.
**Requirements:** V1-04, V1-05, V1-09.

- [x] Reuse the Workflow, parser, builder, archive checks, and manifest-last publication path.
- [x] Qualify safe diagnostics and qualification-only retry, time, object, and progress controls.
- [x] Retain the predecessor operator's fixture and full-artifact comparison evidence.
- [ ] Finish the operator successor's fixture repairs, complete checks, source linkage, and independent review.
- [ ] Freeze its bundle and configuration with a fresh namespace and distinct instance.
- [ ] Resolve calendar facts and residual platform uncertainty before selecting the executable event and budgets.
- [ ] Prepare finite admission windows, credential checks, stop conditions, and independent cleanup guards.
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
The retained October 24 existing-publication probe has consumed arming markers and an expired review.
It cannot authorize another event or prove first publication.
The [authority audit](evidence/2026-10-31/scheduled-readiness-authority-audit.json) and [readiness observation](evidence/2026-10-31/scheduled-readiness-management-observation.json) retain the later bounded checks.
The October 31 observation finds an empty Worker calendar; it does not establish the optional native Workflow calendar or first publication.
Namespace and instance absence, current credentials, source freshness, and final execution admission remain separate checks.
The exploratory meter, binding, and generic operator drafts remain held and unvalidated.
The release ledger retains the expired credential refusal, separately reviewed refresh, and consumed readiness packets.
Prepare a fresh successor from existing owned helpers; preserve every consumed marker and admission failure.

### MP-03 Close serving acceptance

**Status:** provider, brief, hydration, and relay repairs qualify; broad serving and positive Zen acceptance remain open.
**Requirements:** V1-03, V1-07, V1-08.

- [x] Qualify provider dispatch, brief policy, shared-object byte checks, allocation limits, and relay abort handling.
- [x] Check the new [bilingual questions](../src/eval/data/v1-successor-questions.json) against their full immutable source proof.
- [ ] Finish and independently review the API deployment, serving, and Zen operators on the common qualified source.
- [ ] Record numerical acceptance criteria and the chat-contract disposition before the next independent run.
- [ ] Prepare fresh target provenance, reviewed request scopes, and any required label checks for that revision.
- [ ] Deploy and check the reviewed staging API; complete the independent bilingual holdout and bounded benchmark.
- [ ] Review broad acceptance, refresh management target evidence, then qualify the separately reviewed positive Zen chat.
- [ ] Recheck affected advertised HTTP/MCP routes and reconcile serving and usage receipts.

Preserve the held-out and benchmark failures; do not tune against their answers.
Separate misses, wrong results, scope errors, false refusals, provider errors, and text-hydration failures.
State cache behavior, language splits, provider observations, latency, throughput, and freshness.
Extend the existing eval, benchmark, relay, and CHS emission paths.
Operator fixture passes do not establish actual target provenance or serving acceptance.

The sealed [one-request Zen proposal](V1-ZEN-RECHECK.md) remains a separate decision.
Its previous generation approvals are spent; the final recorded serving slot does not grant a new approval.
The relay repair changes a file pinned by the retained packet. Preserve it and qualify a fresh source-bound successor before execution.
New broad measurements need their own reviewed usage scope.

**Exit evidence:** accepted bilingual retrieval and performance reports, positive hosted chat, and complete route checks for the exact candidate.
Retrieval labels do not grade generated claims; any answer-support claim needs separate reviewed evidence.
The reproduced byte-length defect does not establish the cause of the historical hosted hydration failure.
Use the existing [evaluation procedure](V1-EVALUATION.md), [runner](../scripts/eval-v1.ts), and [request ledger procedure](STAGING-REQUEST-BUDGET.md).

### MP-04 Qualify consistent production acquisition

**Status:** fixture mechanisms and private preparation pass their retained checks; actual maintenance and production capture remain open.
**Requirements:** V1-01, V1-04, V1-06.

- [x] Qualify the fixture capture core, transport, schema and sequence checks, and final file-integrity checks.
- [x] Retain bounded inventory observations and private maintenance preparation without claiming a production freeze.
- [ ] Identify actual versions, bindings, auth authority, source schema, writer owners, and active work.
- [ ] Define common maintenance, drain evidence, stop conditions, and explicit reconciliation or resume authority.
- [ ] Complete the owned acquisition client around KV view A, continued D1 export, and KV view B.
- [ ] Include source facts, signed download, private persistence, and complete request, storage, time, and cleanup budgets.
- [ ] Acquire and check the consistent capture under the separately reviewed maintenance and execution packet.

Do not substitute the staging coordinator for production writer control.
Keep provider credentials separate from the signed-download origin.
Keep detailed production observations and held findings private until their publication decision permits disclosure.

The fixture core's 2,080-exchange bound covers only its partial protocol.
It does not establish that a complete acquisition fits the older 2,200-call proposal.
Matching KV views alone do not prove a common writer freeze.

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

Retain staging-only admission until the production adapter qualifies.
Earlier production use does not establish the rollback target's current compatibility.

**Exit evidence:** qualified hosted copy and a concrete production switch/rollback procedure that preserves identities and usage history.
Use [protected copy](PROTECTED-STATE-COPY.md), [D1 admission](PROTECTED-D1-BINDING.md), and [corpus rollback](CORPUS-ROLLBACK.md).

### MP-06 Qualify the final source and release packet

**Status:** open for the final candidate. **Requirements:** V1-01 through V1-10.
**Dependencies:** MP-02, MP-03, and MP-05 acceptance before production release.

- [ ] Pass frozen installation, all compilers, full tests, Python checks, runtime probes, invariants, and five dry builds on the final source.
- [ ] Retain matching clean Linux CI; earlier source receipts cannot qualify later changes.
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

| ID | Decision and next action | Responsible role | Blocks |
| --- | --- | --- | --- |
| D-01 | Select numerical bilingual search, refusal, error, fallback, latency, and freshness criteria before the run | Product owner with evaluation owner | MP-03 execution |
| D-02 | Record the chat-grounding disposition and compatible verification scope | Product owner and API owner | MP-03 chat acceptance and any answer-contract change |
| D-03 | Accept concrete budgets, finite windows, and residual provider uncertainty for each operation | Operator and approving user | The respective hosted execution |
| D-04 | Identify writer authorities and approve actual maintenance, capture, reconciliation, and resume controls | Release engineer and writer owners | MP-04 acquisition and MP-05 migration |
| D-05 | Review the complete release evidence and production switch/rollback candidate | Product owner and release engineer | MP-06 production release |
| D-06 | Select audience, task, public name, experiment window, and stop criteria | Product owner | Phase 2 distribution |
| D-07 | Select the paid surface, price, payment model, and reconciliation requirements | Product owner with cost evidence | Phase 3 paid automation |
| D-08 | Select the next corpus, geography, harness, or portal from observed demand | Product owner | Phase 4 or 5 implementation |

The October 31 code review found that chat can accept an uncited, nonempty model answer.
The current response exposes `answer: string` and a separate `cited` array.
Keep any added validator inside the successful-usage boundary.
Preserve the response contract through internal checks or additive metadata; a new structured response needs an explicit compatibility decision.
A matching source ID or quotation does not alone establish factual support.
This finding needs a recorded disposition; it does not silently replace the existing release requirements.

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
