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
