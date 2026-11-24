# Hansard HTTP preview

Search the House of Commons or Senate in one published edition, then retrieve a cited excerpt by its ID. The Worker serves the OpenAPI 3.1 document at `GET /api/debates/openapi.json` without a key. The [contract schemas](../src/routes/hansard-contract.ts) validate runtime data and generate the [OpenAPI document](../src/routes/hansard-openapi.ts).

| Operation | House of Commons | Senate |
| --- | --- | --- |
| Search | `GET /api/debates/house` | `GET /api/debates/senate` |
| Follow [observed changes](SOURCE-CHANGE-FEEDS.md) | `GET /api/debates/house/changes?language=en` | `GET /api/debates/senate/changes?language=fr` |
| Exact lookup | `GET /api/debates/house/{speechId}` | `GET /api/debates/senate/{speechId}` |

Data routes use a workspace Bearer API key with `civicsignal.retrieve`. They are disabled by default. For a local or isolated fixture environment, set `HANSARD_PREVIEW=on` and load fixture rows into `CIVIC_DB` using the existing `hansard_speeches` schema. Hosted source use remains a [D-08 decision](PLAN.md#decisions-still-required).

```sh
curl --get "$CIVICSIGNAL_URL/api/debates/senate" \
  --header "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
  --data-urlencode 'topic=réseau ferroviaire' \
  --data-urlencode 'language=fr' \
  --data-urlencode 'since=2026-04-20' \
  --data-urlencode 'until=2026-04-26'
```

Search requires `topic` and `language` (`en` or `fr`). The phrase is matched literally after folding accents and case. The optional `since` and `until` parameters use inclusive `YYYY-MM-DD` sitting dates. The optional `limit` is 1–100 and defaults to 25. Results are ordered by sitting date descending, then speech ID descending. An exact lookup takes the ID returned by search as its only input. Use `encodeURIComponent` when inserting the ID into the path.

A search returns `items` and `count`. An exact lookup returns `item`. Each item carries its chamber, edition language, sitting date, speaker, permitted excerpt, and official source citation and attribution. House citations open interventions. Senate citations open transcript sections. Senate IDs use the heading and turn position, which can shift after structural corrections.

An available edition with no matches returns `200` with an empty `items` list. An unpopulated edition returns `503 RETRIEVAL_UNAVAILABLE`. A missing ID in an available edition returns `404 NOT_FOUND`. Disabled data routes return `501 UNSUPPORTED_COVERAGE` after authentication. Each successful retrieval, including an empty search, consumes one workspace unit. Failed retrievals consume no units. For an uncertain usage acknowledgement, retain the `operationId` and `month` from the `503 USAGE_UNAVAILABLE` response for reconciliation.

To export the OpenAPI document directly from a checkout, run the following command.

```sh
bun --no-env-file -e 'import { hansardOpenApi } from "./src/routes/hansard-openapi"; console.log(JSON.stringify(hansardOpenApi(), null, 2))' > hansard.openapi.json
```

## Current-session local intake

For November 16–22, 2026, the local store contains all ten House editions and six Senate editions listed for that week. Each language has 1,409 House interventions and 343 Senate speaker turns. House results cite the intervention. Senate results cite the transcript section and expose an excerpt from the opening paragraph.

Use the same SQLite path for both chambers. Each command checks the official calendar for a completed Monday–Sunday week and imports the available editions.

```sh
mkdir -p dist/hansard
bun --no-env-file scripts/hansard-local.ts sync-week dist/hansard/session-45-1.sqlite 45-1 2026-11-16
bun --no-env-file scripts/hansard-local.ts sync-senate-week dist/hansard/session-45-1.sqlite 45-1 2026-11-16
CIVICSIGNAL_HANSARD_SQLITE=dist/hansard/session-45-1.sqlite bun run test test/endpoints.test.ts -t 'November 16 week'
```

The authenticated checks cover search, exact lookup, and two cursor pages per language and chamber. On a second live check, all ten House XML files matched their previous hashes. The Senate pages changed bytes and produced the same indexed turns. Neither chamber produced a new change event. Compare the source hashes and change feed when checking later weeks. [House receipt](evidence/2026-11-24/hansard-house.json) · [Senate receipt](evidence/2026-11-24/hansard-senate.json)

The November 2–8 replay added House sittings 160–164 and Senate issues 99–101 to the same local store. To rebuild that week, repeat both sync commands above with `2026-11-02`. The two weeks together have 32 language editions, 7,348 cited excerpts, and 7,348 initial change events. Replaying all 16 saved November 2 editions left the combined database byte-identical. The November 16 authenticated route checks also passed against this larger store. [November 2 House receipt](evidence/2026-11-24/hansard-house-2026-11-02.json) · [November 2 Senate receipt](evidence/2026-11-24/hansard-senate-2026-11-02.json)
