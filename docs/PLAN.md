# CivicSignal master plan

Updated 2026-10-31. Status: v1 remains incomplete.

CivicSignal will give applications and agents source-cited Canadian civic information.
The first release serves Canadian federal statutes and regulations in English and French.
The immediate objective is to close four release gates: scheduled first publication, serving acceptance, production migration, and the final release audit.

## Immediate work order

1. **Qualify the MP-02 runtime increment.** Diagnose the native restore-frame failure; preserve the reviewed controls and accounting; complete local/Linux checks.
2. **Prepare the three open evidence paths.** Make the scheduled packet executable; prepare serving acceptance and consistent production acquisition alongside it.
3. **Close the corresponding hosted gates.** Use fresh target evidence and the reviewed limits for each concrete operation.
4. **Complete MP-05 after acquisition.** Qualify the protected copy, production target, and authorization-preserving rollback.
5. **Complete MP-06.** Reconcile all ten requirements, review the production switch, execute its approved checks, and record the actual result.

MP-01 supplies the exact candidate for each operation.
MP-02, MP-03, and MP-04 preparation can proceed independently.
MP-04 capture must pass before MP-05's production-derived proof.
The final production decision waits for MP-02, MP-03, and MP-05 acceptance.

## Release gates at a glance

All four gates remain open. The ten [release requirements](V1-RELEASE.md#release-requirements) retain their individual acceptance checks.

| Gate | Packages | Completion evidence |
| --- | --- | --- |
| Scheduled first publication | MP-02 | A scheduled event creates a distinct instance and first complete publication; all artifacts match; canonical state and cleanup pass |
| Serving acceptance | MP-03 | Accepted bilingual quality and performance reports, positive hosted Zen chat, and advertised route checks |
| Production migration | MP-04, MP-05 | Consistent production capture, hosted protected-copy proof, compatible switch, and authorization-preserving rollback |
| Final release | MP-06 | The exact final source passes engineering checks; all requirements reconcile; the approved production switch passes |

## Plan authority

This is the single master plan for scope, decisions, work order, and future phases.
The [release evidence ledger](V1-RELEASE.md) retains requirement checks, completed results, failures, and source-specific receipts.
Detailed procedures and reviews remain references for their respective work packages.
They do not create separate product roadmaps or authorize execution.

The former product plan remains in [PLAN-HISTORY.md](PLAN-HISTORY.md).
Earlier Railway, model, rerank, pricing, and product-wave discussions remain history where they conflict with this plan.
The [reference map](#reference-map) identifies each document's role.

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

This table retains the October 24 baseline without qualifying today's working tree or production.
The [release crosswalk](V1-RELEASE.md#current-closure-crosswalk--2026-10-24) links the underlying evidence.
The [implementation progress](#implementation-progress) records later source checks.

| Area | Recorded outcome | Remaining limit |
| --- | --- | --- |
| Shared identity and metering | Local HTTP/MCP, key, quota, and receipt checks pass | Hosted production identity/history preservation remains open |
| Reproducible builds | Prior clean Linux installation, compiler, runtime, invariant, and build checks pass | These earlier receipts do not qualify later source changes |
| Non-empty reconciliation | All 277,857 metadata rows agree; 1,112 changed and 276,745 unchanged; pending outbox is empty | Preserve the original paused coordinator and completed evidence |
| Provision text | Full staging baseline audit and later composite changed-text proof pass | The composite proof is not a fresh full-store byte audit |
| Vector backup | All 277,857 positions, including 254,671 substantive vectors and 23,186 placeholders, pass the retained backup checks | Legacy embedding-model provenance remains unattested |
| Manual snapshot publication | Hosted Workflow and all 240 artifacts pass parity | Scheduled discovery and first publication remain open |
| Snapshot/acquisition increment | Local receipt records 1,689 tests in 97 files, 23 Python cases, four compiler projects, and five dry builds | Source is undeployed; fixture proofs do not establish full hosted operation |
| Serving surfaces | 21 hosted smokes and a later cold/warm calibration pair pass | Positive Zen generation and broad quality/performance acceptance remain open |
| Held-out retrieval | 63/64 valid responses; Hit@5 is 40/48; one false accept among 15 completed unsupported questions | Preserve the failed run; later calibration does not replace it |
| Performance | Benchmark retains a hydration failure and failed warm-ups | Different cache populations do not establish capacity or uncached latency |
| Protected production copy | Local codec, schema admission, sequence bridge, binding, client, and owned operator checks pass | Actual production acquisition, hosted copy, and production target support remain open |

The recorded serving ledger is **159/160**, with no new generation approval.
The recorded reconciliation use is **1,624 document attempts and 16 extension calls**, under cumulative limits of 1,752 and 20.
These balances describe the original bounded operations only.
Unspent slots do not authorize another operation, reset, retry, or replacement ledger.

## Implementation progress

The latest qualified implementation is **`26d5049`**.
Its [complete local gate](evidence/2026-10-31/integrated-candidate-local-validation-v5.json) and [clean Linux gate](evidence/2026-10-31/candidate-26d-linux-ci-validation.json) pass with 472 source and fixture inputs.
Those checks cover 1,925 tests, 27 Python cases, four compiler projects, runtime checks, invariants, and five dry builds.
Later source changes need their own complete checks.
The [release ledger](V1-RELEASE.md#october-31-implementation-progress) preserves earlier candidates, repairs, failed checks, and exact receipts.

| Package | Current position | Next deliverable |
| --- | --- | --- |
| MP-01 | Qualified source and requirement inventory retained | Refresh the candidate inventory after the current source increment |
| MP-02 | Runtime controls pass focused checks and source review; successor accounting exists; fixed operator preparation remains non-live | Complete full source checks and the executable operation packet |
| MP-03 | Brief and text-hydration repairs qualify; successor bilingual labels have full source checks | Record acceptance policy and prepare the bounded serving packet |
| MP-04 | Fixture acquisition, transport, and schema/sequence collectors qualify | Complete actual authority, writer, maintenance, and acquisition evidence |
| MP-05 | Local copy, sequence, binding, and rollback mechanisms pass | Qualify production-derived hosted copy and the production target |
| MP-06 | Engineering checks pass for `26d5049`; the PR remains a draft | Check the final source and reconcile all required release evidence |

The qualification-runtime increment remains in progress.
Its reference policies, retry limits, deadlines, and cleanup controls pass focused checks and independent source review.
The [successor accounting](evidence/2026-10-31/snapshot-reference-accounting-runtime-v2.json) preserves the original successful-path baseline and records the conditional runtime bounds.
The [complete local check](evidence/2026-10-31/integrated-candidate-local-observation-v7.json) fails one native restore-frame test after 1,971 passes.
The named isolated probe passes on unchanged source; the cause remains unknown. Full local and clean Linux checks remain open.
Caller-enforced bounds do not establish a global provider ceiling or guarantee cancellation of stalled binding requests.
The fixed operator preparation remains non-live until a fresh successor consumes the qualified runtime and its reviewed accounting disposition.

A bounded read-only production inventory completes; its detailed evidence and maintenance finding remain private.
Deployed-source correspondence, auth authority, common maintenance, and actual acquisition remain open.
No new deployment, scheduled event, generation, maintenance interval, or migration follows from these preparations.

Open public findings are [chat evidence contract, issue 4](https://github.com/chester-hill-solutions/civicsignal/issues/4) and [scheduled operation accounting, issue 6](https://github.com/chester-hill-solutions/civicsignal/issues/6).
The [native restore-frame finding, issue 12](https://github.com/chester-hill-solutions/civicsignal/issues/12), tracks the current full-check failure.
The release ledger retains closed findings and their source-specific qualification.

## Phase 1 Close the v1 release

Engineering owns implementation, source pins, checks, and the evidence packet.
The product owner decides acceptance policy, material scope changes, and separately bounded hosted or production actions.
Local preparation for MP-02, MP-03, and MP-04 can proceed independently after MP-01.
Production cutover waits for all required evidence and the final decision.

### MP-01 Reconcile the exact candidate

**Status:** local inventory recorded; final candidate and fresh hosted identity remain open. **Requirements:** V1-02, V1-09, V1-10.

- Record the candidate source, working-tree changes, dependencies, bindings, and deployed versions.
- Preserve unrelated work, failed receipts, accepted artifacts, and consumed execution markers.
- Distinguish previously deployed provider repairs from newer local snapshot and acquisition code.
- Record each requirement as locally checked, hosted checked, pending, or explicitly excluded.

**Exit evidence:** one source-specific inventory connects the ten release requirements to their current receipts and remaining tasks.
Use the [release evidence ledger](V1-RELEASE.md), [operations procedure](V1-OPERATIONS.md), and [writing rules](WRITING.md).

### MP-02 Qualify scheduled first publication

**Status:** runtime controls pass focused checks and source review; full source checks, the executable operator, and hosted qualification remain open. **Requirements:** V1-04, V1-05, V1-09.

- Retain the shared Workflow, parser, builder, archive checks, and manifest-last publication path.
- Preserve safe source failure diagnostics without raw provider bodies or exception text.
- Extend existing owned request manifests, transport, cleanup guards, and artifact checks to cover the prepared proposal.
- Set explicit qualification retry, time, and object policies while preserving canonical behavior.
- Distinguish caller-enforced limits from unqualified platform delivery or reconstruction work.
- Freeze the qualification bundle, configuration, and owned operator.
- Use a fresh physical namespace and a distinct Workflow instance; keep the genuine source and parser identity.
- Budget source, management, R2, storage, and complete artifact checks separately.
- Prepare one future event, finite admission windows, valid credentials, stop conditions, and independent cleanup guards.
- Execute only within the separately approved packet.

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

**Status:** local provider and brief-policy repairs pass; the earlier hosted calibration pair passes; broad acceptance remains open.
**Requirements:** V1-03, V1-07, V1-08.

- Preserve the held-out and benchmark failures and investigate their retained evidence.
- Separate candidate misses, wrong-result acceptance, scope errors, false refusals, provider errors, and text-hydration failures.
- Repair the reproduced shared-object byte-length mismatch and allocation undercount; qualify its serving and usage regressions.
- Define the next run's acceptance criteria before execution; do not tune against the retained holdout answers.
- Record numerical criteria as an explicit policy decision before adding automatic quality gates to the existing runner.
- Retain the new [bilingual questions](../src/eval/data/v1-successor-questions.json) and their full source proof.
- Prepare fresh target provenance for the next independent acceptance run; recheck labels if its source revision changes.
- State request budgets, cache behavior, language splits, provider observations, latency, throughput, and freshness.
- Qualify positive Zen chat through the existing authenticated retrieval, generation, citation, and metering path.
- Check brief emission against the shared CHS corpus policy gate; extend existing checks where response paths diverge.
- Recheck affected advertised HTTP/MCP routes when their source or bindings change.

The sealed [one-request Zen proposal](V1-ZEN-RECHECK.md) remains a separate decision.
Its previous generation approvals are spent; the final recorded serving slot does not grant a new approval.
New broad measurements need their own reviewed usage scope.

**Exit evidence:** accepted bilingual retrieval and performance reports, positive hosted chat, and complete route checks for the exact candidate.
Retrieval labels do not grade generated claims; any answer-support claim needs separate reviewed evidence.
The reproduced byte-length defect does not establish the cause of the historical hosted hydration failure.
Use the existing [evaluation procedure](V1-EVALUATION.md), [runner](../scripts/eval-v1.ts), and [request ledger procedure](STAGING-REQUEST-BUDGET.md).

### MP-04 Qualify consistent production acquisition

**Status:** fixture capture core and injected transport pass focused and clean Linux checks; live acquisition and common maintenance remain open.
**Requirements:** V1-01, V1-04, V1-06.

- Retain the locally checked fixed schema and sequence collector, its shared owner, and final file-integrity checks.
- Establish actual production versions, bindings, auth authority, schema, and every relevant writer.
- Define a common maintenance interval for ingestion, auth, billing, and covered timestamp writes.
- Do not substitute the staging coordinator for production writer control.
- Extend the existing KV view A, continued D1 export, and KV view B capture protocol.
- Complete credential ownership, bounded transport, signed download, schema and sequence facts, and durable private capture.
- Keep provider credentials separate from the signed-download origin.
- Enumerate the complete request, storage, time, and cleanup budgets before the acquisition proposal.
- Acquire only under the separately reviewed maintenance and execution packet.

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

- Reuse the codec, restricted SQL importer, source-schema admission, sequence bridge, D1 binding, client, and owned operator.
- Check corpus, parser, text, vector, publication, and source-schema compatibility before copy admission.
- Complete the isolated hosted protected-copy checks with the qualified source.
- Check key hashes, revocation, capabilities, billing limits, history, and sequence highwaters.
- Prepare and review the production target adapter separately; retain staging-only checks until that change qualifies.
- Keep authoritative authorization and usage fixed through corpus migration and rollback.
- Check the rollback target's actual compatibility; its earlier production use does not establish current readiness.

**Exit evidence:** qualified hosted copy and a concrete production switch/rollback procedure that preserves identities and usage history.
Use [protected copy](PROTECTED-STATE-COPY.md), [D1 admission](PROTECTED-D1-BINDING.md), and [corpus rollback](CORPUS-ROLLBACK.md).

### MP-06 Qualify the final source and release packet

**Status:** open for the final candidate. **Requirements:** V1-01 through V1-10.
**Dependencies:** MP-02, MP-03, and MP-05 acceptance before production release.

- Run the frozen installation, all compiler projects, full tests, Python checks, runtime probes, invariants, and five dry builds.
- Run clean Linux CI for the exact final source; earlier source receipts cannot qualify later changes.
- Reconcile all ten requirements with their accepted evidence, limitations, and source/binding identities.
- Prepare production commands, maintenance, post-switch checks, stop conditions, and authorization-preserving rollback.
- Present the complete candidate for the required final production decision.
- Execute only that approved scope; retain actual outcomes before declaring v1 complete.

**Exit evidence:** the exact source passes local and clean CI checks, required hosted gates close, and the approved production switch passes its checks.
Use the [release evidence ledger](V1-RELEASE.md) and [operations procedure](V1-OPERATIONS.md).

## Phase 2 Test external demand

**Entry:** the federal v1 release qualifies. Distribution and publication need an explicit scope.

- Choose one initial customer group and one repeatable task.
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

| Decision | Owner | Needed before |
| --- | --- | --- |
| Numerical search, scope-refusal, language, and latency criteria | Product owner with engineering evidence | The next independent serving acceptance run |
| Chat grounding scope | Product owner and API owner | Any answer-contract change or new grounding claim |
| Hosted budgets and residual provider-bound uncertainty | Operation owner and approving user | The respective hosted execution |
| Actual production authority, schema, and maintenance controls | Release engineer | Production acquisition or migration |
| Initial customer group, demand window, and stop criteria | Product owner | External distribution experiment |
| Paid surface, price, and payment model | Product owner with cost evidence | Paid automation |
| Next corpus, geography, harness, or portal | Product owner | Expansion implementation |

The October 31 code review found that chat can accept an uncited, nonempty model answer.
The current response exposes `answer: string` and a separate `cited` array.
Keep any added validator inside the successful-usage boundary.
Preserve the response contract through internal checks or additive metadata; a new structured response needs an explicit compatibility decision.
A matching source ID or quotation does not alone establish factual support.
This finding needs a recorded disposition; it does not silently replace the existing release requirements.

## Reference map

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

A documentation change supplies no new deployment, source request, generation, maintenance, acquisition, or production approval.
Record each future execution decision against its concrete packet and cumulative limits.
