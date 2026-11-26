# CivicSignal

CivicSignal retrieves cited Canadian federal statutes and regulations in English and French.
The production API uses Cloudflare Workers, D1, Vectorize, and an encoder container.
Cloudflare is the sole v1 deployment target. The Bun/Postgres code and Railway configuration describe an alternative deployment.

The v1 candidate adds workspace keys, shared usage limits, exact citations, semantic search, BYOK chat, and an observed change feed.
News, debates, bills, provincial law, tone, geographic filters, OAuth, and a portal are outside v1.
The API reports these limits explicitly. It does not claim that an empty result proves no applicable law exists.

## Current release state

Start with [the master plan](docs/PLAN.md) for scope, priorities, release gates, and future phases.
Use its [work order](docs/PLAN.md#immediate-work-order), [package checklist](docs/PLAN.md#phase-1-close-the-v1-release), and [decision register](docs/PLAN.md#decisions-still-required).
Read [the release evidence ledger](docs/V1-RELEASE.md) for requirement checks and dated outcomes.
Read [the operations procedure](docs/V1-OPERATIONS.md) before any remote migration or deployment.
Local tests do not establish production accuracy or performance.

## Check the candidate

Use Bun 1.3.5 and Node 24 or later.

```sh
bun install --frozen-lockfile
bun run validate
python3 -I -B test/protected-state-d1-owned.test.py
bun run build
```

Refresh the local source previews with `bun run refresh:consultations`, `bun run refresh:committee-calls` or `bun run refresh:daily`; each writes a receipt with additions, removals and field-level changes. [Refresh runbook](docs/REFRESH.md)

CI runs these commands without production credentials.
Vendored CHS packages include their runtime files and a pinned [file manifest](vendor/chs-manifest.json).
Run `bun run check:vendor` to check their fingerprints.

`bun run check:lint-ratchet` runs ESLint with the [Callcaster lint rules](house-rules/index.mjs) and compares findings against CivicSignal's [identity baseline](.ratchet-strap.json). Callcaster's console exemptions for tests, operational scripts, and services and its function-length exemption for tests apply here too. After removing violations, run `bun run tools:lint-ratchet:tighten` to remove their allowances. CI compares the baseline against the PR base or previous main revision to catch growth.

The manifest pins the CHS revision and complete source tree. The billing fix is
also retained as a hash-verified [source patch](vendor/patches/api-billing-0.1.2.patch)
over its recorded base, so refresh works from the original CHS checkout before
that isolated commit is available upstream:

```sh
CHS_REPO=/path/to/chs-corpus bun scripts/vendor-corpus.ts --verify-source
CHS_REPO=/path/to/chs-corpus bun scripts/vendor-corpus.ts
```

Source verification reconstructs the exact pinned Git tree without changing the
source checkout or vendored files. Refresh installs frozen build dependencies for
the five selected packages in a temporary checkout, builds all five, then replaces
the vendored output and records revision, source tree, base and patch fingerprints.
The local source patch is not a published upstream release.

## HTTP and MCP

Start with the deployment’s `/.well-known/civicsignal.json` or `/llms.txt`. The source inventory reports which editions you can query, their dates and the requests an agent can run for questions such as apprenticeship training capacity. [Agent discovery contract](docs/AGENT-DISCOVERY.md)

The preview contracts below describe the Worker in this checkout. Check the discovery version and the advertised routes before calling a preview on a deployed hostname. The federal institution coverage report is a private Cloudflare staging artifact. Operators read it from R2. [Coverage runbook](docs/REFRESH.md#institution-coverage-report)

The separate [Hansard HTTP preview](docs/HANSARD-API.md) documents House and Senate search and exact retrieval.
The [Canada Gazette preview](docs/GAZETTE-API.md) covers local replay, bilingual metadata search and exact lookup for Parts I and II.
The [parliamentary catalogues](docs/PARLIAMENT-CATALOGUE-API.md) cover current-session bills, House and Senate Journals, vote totals and member-by-member voting records. Staff can search a Journal passage or a voting history and open the cited parliamentary edition.

The [funding programs API](docs/FUNDING-PROGRAMS-API.md) serves bilingual NSERC College and Community Innovation and ESDC funding catalogues, with cited program terms, edition history and coverage.
The [consultations API](docs/CONSULTATIONS-API.md) serves the federal Open Dialogue catalogue in both languages, with the published dates, status, department and report links and an open state computed for a queried date.
The [departmental publications preview](docs/DEPARTMENTAL-PUBLICATIONS.md#http-preview) searches ECCC audits and evaluations, retrieves cited editions and lists their observed versions.
The [written-questions preview](docs/WRITTEN-QUESTIONS-PREVIEW.md#openapi) searches House questions and retrieves bilingual replies and their cited documents.
The [federal directory](docs/GEDS-API.md) provides dated people, contact, organization and hierarchy lookups from GEDS snapshots.
The [bilingual bill and committee brief](docs/BILL-TRACE-API.md) follows S-5 through both chambers, committee amendments, a recorded division and Royal Assent.
The [committee study brief](docs/BILL-TRACE-API.md#committee-study-action) follows ENVI's freshwater report and government response as of a selected date.
The [committee corpus API](docs/COMMITTEES-API.md) searches 45-1 House, Senate and joint proceedings and submissions in English and French. It links each result to its official source, exposes coverage by committee and edition, and lists the House studies currently seeking briefs with the published deadline, instructions and open state for a queried date.
Use the [source change feeds](docs/SOURCE-CHANGE-FEEDS.md) to follow a topic through additions, corrections and removals in the Gazette or either chamber.

Every search route requires `Authorization: Bearer <workspace API key>` with capability `civicsignal.retrieve`.
A successful search consumes one workspace unit. Validation and retrieval failures, plus MCP protocol messages, consume none.
A lost usage acknowledgement can return `503/USAGE_UNAVAILABLE` with `uncertain:true` after the usage ledger commits a unit.
Retain `operationId` and `month` for [reconciliation](docs/V1-OPERATIONS.md#uncertain-usage-acknowledgements); a new request starts a new operation.
Keep API keys in server code. Public `pk_` keys cannot authorize v1 calls.

| Route | Behavior |
| --- | --- |
| `GET /health` | Process health; no corpus readiness claim |
| `GET /.well-known/civicsignal.json` | Queryable source editions, freshness, research questions, routes and tools |
| `GET /llms.txt` | Agent instructions |
| `GET /api/statutes?topic=...&language=fr` | Semantic search over the current federal corpus |
| `GET /api/statutes?act=Canada%20Health%20Act&section=8&language=en` | Exact provision; no encoder required |
| `GET /api/brief?act=Canada%20Health%20Act&section=8` | Federal statute brief with explicit coverage states |
| `GET /api/changes?after=0&limit=50` | Observed additions, changes and removals; metadata and citations |
| `POST /api/chat` | Cited answers with the caller's generation key |
| `POST /api/match` | Nearest vectors under the published encoder contract; no answerability claim |
| `/mcp` | Streamable HTTP; authenticated tool calls |

Search parameters accept `topic`, repeated `keyword`, `language`, `limit`, `act`, and `section`.
Supply `act` and `section` together. The HTTP limit is 1–50.
The only supported jurisdiction is `CA`. Use `/api/changes` for dated changes to federal statutes and regulations.
The change feed accepts `after`, `limit` (1–100), `since`, `until`, and `change`.
Its dates describe source revisions, not legal commencement dates.

MCP lists tools only when their corpus and backends are available:
`cite_provision`, `statute_changes`, `statute_lookup`, and `brief_topic`.

BYOK chat also requires `X-CivicSignal-BYOK-Provider` and `X-CivicSignal-BYOK-Key`.
Supported providers are Anthropic, OpenAI, Google, and OpenCode Zen (`opencode-zen`).
The initial Zen adapter supports `claude-haiku-4-5` through the
[OpenCode Messages API](https://opencode.ai/v2/docs/console/api/inference).
The [paid model table](https://opencode.ai/v2/docs/console/models/) lists that model.
The generation key goes only to the selected provider.
The CivicSignal key authorizes corpus access separately.

For chat retrieval, an explicit `topic` takes precedence. For “And how long is it?”, chat can use the previous user question when it identifies one subject. Semantic search sends both questions to its search providers in one query. Supply a topic when the conversation compares subjects or changes language. Chat uses the final question alone when it cannot identify suitable context.

The chat response keeps `answer` as text and lists retrieved material in `cited`.
That list does not establish factual support for each generated statement.
Independent answer-support acceptance remains open under [the chat evidence decision](docs/PLAN.md#decisions-still-required).

For nonempty material, answers must contain at least one retrieved HTTP(S) source link.
Every recognized destination must match a retrieved source link exactly.
Supported forms are bare URLs, inline Markdown links, and angle autolinks.
Reference-style links, HTML, images, nested links, and multiline code fall outside the supported format.
Unsupported or ambiguous link forms fail before successful usage consumption.
Simple inline code can surround a separate citation, but code text supplies no citation.

When retrieval returns no material, chat gives a fixed insufficient-evidence answer and skips generation.
This successful retrieval consumes one unit.
The response includes `generation: {"status":"skipped","reason":"no-retrieved-material"}`.
The `provider` and `model` fields identify the selection, even when chat skips generation.

## Corpus and search checks

[The evaluation procedure](docs/V1-EVALUATION.md) describes held-out bilingual labels and measured serving-path checks.
[The snapshot procedure](docs/SNAPSHOT.md) describes immutable row parts, fingerprints, and recovery.
The [master plan](docs/PLAN.md) governs current work. The release ledger retains historical measurements and their limits.

The product applies each corpus policy through `@chester-hill-solutions/corpus` before it emits content.
Read [the licence register](docs/LICENCE-REGISTER.md) for source terms.
Results are not an official version of the law. Consult their linked official sources.
