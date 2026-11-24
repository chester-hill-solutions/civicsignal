# Canada Gazette metadata preview

Search Part I notices and proposed regulations or Part II registered instruments in English or French. This local preview covers the April 25 and April 22 issues respectively. Each result identifies its issue, kind, language, title and official citation. Registration, consultation and effective dates have distinct fields. An absent date means the issue index supplied no verified value for that field.

## Search the official April issues locally

From the repository root, sync the four issue indexes into a local metadata database. Subsequent searches work offline.

```sh
mkdir -p data/corpus
gazette_db=data/corpus/gazette-preview.sqlite
bun scripts/gazette-local.ts sync "$gazette_db"
bun scripts/gazette-local.ts search "$gazette_db" fr I "exportation"
bun scripts/gazette-local.ts search "$gazette_db" en II "SOR/2026-65"
bun scripts/gazette-local.ts show "$gazette_db" "gazette:pii:fr:2026-04-22:v160:n8:sor-65"
```

The French Part I search finds the export-control proposal. The Part II lookup returns the published French title and `DORS/2026-65`, registered March 31 and published April 22. A sync reads all four official indexes before writing and stores metadata only. Each edition is committed atomically. Re-running the command skips identical editions. [Part I proposal](https://gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/reg1-fra.html) · [Part II issue index](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/index-fra.html)

## Replay fixtures

The fixture manifest names four synthetic issue indexes. Replay writes a SQLite database. Search and exact lookup open that file read-only and use the Worker's query code.

```sh
gazette_db="$(mktemp -d)/gazette.sqlite"
bun scripts/gazette-local.ts replay "$gazette_db" test/fixtures/gazette/week.json
bun scripts/gazette-local.ts replay "$gazette_db" test/fixtures/gazette/week.json
```

The second replay should report four unchanged editions. To verify the four official indexes against the parser in memory, run `bun scripts/gazette-local.ts verify-live`. The command fetches the issue indexes on demand. The preview has no scheduled refresh.

## HTTP contract

| Operation | Request |
| --- | --- |
| Search a published edition | `GET /api/gazette?topic=dindon&language=fr&part=II` |
| Follow [observed changes](SOURCE-CHANGE-FEEDS.md) | `GET /api/gazette/changes?language=fr&part=II` |
| Retrieve a record | `GET /api/gazette/{id}` |
| Read the OpenAPI 3.1 document | `GET /api/gazette/openapi.json` |

Data routes require a workspace Bearer key with `civicsignal.retrieve`. For fixture-backed Worker use, enable `GAZETTE_PREVIEW=on` and bind the separate Gazette preview database as `GAZETTE_DB`. The preview schema lives outside the federal corpus migrations. OpenAPI is public. [Preview migration](../preview/gazette/migrations/0001_gazette.sql) · [Runtime schemas](../src/routes/gazette-contract.ts)

Search requires a `topic` and edition `language` (`en` or `fr`). Add `part=I` or `part=II` to restrict the source, and `since` and `until` for inclusive publication-date bounds. Matching folds case and accents and preserves the published spelling in the result. Search returns `items`, `count` and the issue coverage used. Exact lookup accepts the ID returned by search as a single URL-encoded path segment. It returns `item` and its coverage.

An available edition with no matches returns `200` and an empty list. A missing record in an available edition returns `404`. A missing required edition returns `503 RETRIEVAL_UNAVAILABLE`. Disabled data routes and requests wholly outside the preview issues return `501 UNSUPPORTED_COVERAGE` after authentication. Each successful search or lookup consumes one workspace unit, including a search with zero hits. Validation errors, unavailable coverage and failed lookups consume zero units.
