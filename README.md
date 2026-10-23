# CivicSignal

CivicSignal retrieves cited Canadian federal statutes and regulations in English and French.
The production API uses Cloudflare Workers, D1, Vectorize, and an encoder container.
The Bun/Postgres code remains an undeployed portability implementation. Railway services remain in place.

The v1 candidate adds workspace keys, shared usage limits, exact citations, semantic search, BYOK chat, and an observed change feed.
News, debates, bills, provincial law, tone, geographic filters, OAuth, and a portal are outside v1.
The API reports these limits explicitly. It does not claim that an empty result proves no applicable law exists.

## Current release state

Read [the release checklist](docs/V1-RELEASE.md) for acceptance evidence and open requirements.
Read [the operations procedure](docs/V1-OPERATIONS.md) before any remote migration or deployment.
Local tests do not establish production accuracy or performance.

## Check the candidate

Use Bun 1.3.5 and Node 24 or later.

```sh
bun install --frozen-lockfile
bun run validate
bun run build
```

CI runs these commands without production credentials.
Vendored CHS packages include their runtime files and a pinned [file manifest](vendor/chs-manifest.json).
Run `bun run check:vendor` to check their fingerprints.

The manifest pins the CHS revision and complete source tree. The billing fix is
also retained as a hash-verified [source patch](vendor/patches/api-billing-0.1.1.patch)
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

Every search route requires `Authorization: Bearer <workspace API key>` with capability `civicsignal.retrieve`.
A successful search consumes one workspace unit. Validation and retrieval failures, plus MCP protocol messages, consume none.
A lost usage acknowledgement can return `503/USAGE_UNAVAILABLE` with `uncertain:true` after a unit was committed.
Retain `operationId` and `month` for [reconciliation](docs/V1-OPERATIONS.md#uncertain-usage-acknowledgements); a new request starts a new operation.
Keep API keys in server code. Public `pk_` keys cannot authorize v1 calls.

| Route | Behavior |
| --- | --- |
| `GET /health` | Process health; no corpus readiness claim |
| `GET /.well-known/civicsignal.json` | Live population, revision, configured routes, tools and limits |
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
The only supported jurisdiction is `CA`. Use `/api/changes` for dated source changes.
The change feed accepts `after`, `limit` (1–100), `since`, `until`, and `change`.
Its dates describe source revisions, not legal commencement dates.

MCP lists tools only when their corpus and backends are available:
`cite_provision`, `statute_changes`, `statute_lookup`, and `brief_topic`.

BYOK chat also requires `X-CivicSignal-BYOK-Provider` and `X-CivicSignal-BYOK-Key`.
Supported providers are Anthropic, OpenAI, Google, and OpenCode Zen (`opencode-zen`).
The initial Zen adapter supports `claude-haiku-4-5` through the
[OpenCode Messages API](https://opencode.ai/v2/docs/console/api/inference).
That model is listed in the [paid model table](https://opencode.ai/v2/docs/console/models/).
The generation key goes only to the selected provider.
The CivicSignal key authorizes corpus access separately.

## Corpus and search checks

[The evaluation procedure](docs/V1-EVALUATION.md) describes held-out bilingual labels and measured serving-path checks.
[The snapshot procedure](docs/SNAPSHOT.md) describes immutable row parts, fingerprints, and recovery.
The current [release checklist](docs/V1-RELEASE.md) takes precedence over historical plans and measurements.

The product applies each corpus policy through `@chester-hill-solutions/corpus` before it emits content.
Read [the licence register](docs/LICENCE-REGISTER.md) for source terms.
Results are not an official version of the law. Consult their linked official sources.
