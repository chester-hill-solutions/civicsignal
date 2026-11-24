# House written-questions preview

This is a local preview of the House of Commons written-questions corpus. The Worker routes read normalized rows and FTS5 indexes from the `CIVIC_DB` D1 binding; they do not fetch publisher pages at request time. Search and coverage counts describe rows in the materialized database, not the full House catalogue.

## Current source inventory

The House catalogue currently lists 16 sessions, from `37-1` through `45-1`. The `45-1` inventory contains 1,709 distinct question numbers in each official-language edition across all 86 published result pages. The EN and FR number sets match. Each edition retains the publisher's question text, member identity, asked date, current status, source ID, and published response references. The current question-status counts are 1,519 answered, 184 awaiting a response, and 6 withdrawn per edition.

These catalogue totals do not mean that every answer document or attachment is searchable. The local acquisition evidence records 1,518 of the 1,519 answered questions with searchable reply material in each edition, along with response and attachment gaps such as Q-105's unavailable file and Q-338's unavailable workbook. See the [parliamentary corpus evidence](evidence/2026-11-23/parliamentary-corpus.md) for the source inventory, coverage detail, examples, and replay commands.

## Acquire and materialize locally

From the repository root, build or refresh the official bilingual catalogue and acquire its published material into the local SQLite database and content-addressed `objects/` directory:

```sh
python3 -B scripts/lib/wq_catalog.py
python3 -B scripts/written-questions.py --verify-objects
```

The catalogue script follows the House's rendered English and French listings and detail pages. Its atomic checkpoint can resume after interruption; use `--recheck-details` to fetch every detail shell again when response metadata may have changed without a listing change. The second command reads `data/corpus/written-questions/catalogue.json`, acquires incomplete editions, writes the local corpus, updates `coverage.json`, and then verifies referenced object hashes. `--verify-objects` does not make the run read-only; acquisition still runs. The default local root is `data/corpus/written-questions/` and can be changed with `--root`.

To build an isolated local D1 candidate from a closed local source database:

```sh
bun scripts/materialize-written-questions.ts data/corpus/written-questions/questions.sqlite
```

The materializer invokes the `cf` CLI for D1 migrations with `--local` and stores state under `.wrangler/written-questions-final` by default. The optional second argument changes that local state directory. It stages the candidate, checks row/text/chunk/index counts against the source, swaps the serving tables transactionally, then exercises exact Q-1 and Q-1010 lookups and a Q-1010 FTS search. It reports the source SHA-256 and `target: isolated-local-d1`. It has no remote mode.

The candidate copies question and document text, metadata, FTS rows, and object hashes. It does not copy binary attachment/object bytes into D1. A searchable document has indexed text; `stored` means the source bytes were retained without searchable text; `gap` records an unavailable or incomplete source. The hash is the content-addressed object reference for local follow-up.

## Local entrypoints and hosted boundary

The materializer runs the actual written-question lookup and FTS handlers against the isolated local D1 candidate after swapping it, including exact Q-1 and Q-1010 lookups and a Q-1010 search. To inspect the acquired source SQLite directly, the verified read CLI supports:

```sh
bun scripts/written-questions-read.ts lookup data/corpus/written-questions/questions.sqlite 45-1 1010 fr
bun scripts/written-questions-read.ts search data/corpus/written-questions/questions.sqlite en "drinking water advisories" --session 45-1 --kind reply
bun scripts/written-questions-read.ts coverage data/corpus/written-questions/questions.sqlite 45-1
```

To test authenticated Worker requests against the full local collection, set `CIVICSIGNAL_WRITTEN_QUESTIONS_D1` to the generated CIVIC_DB SQLite file, then run the endpoint test.

```sh
bun run test test/endpoints.test.ts -t 'House written questions through the Worker'
```

The test exercises a Library of Parliament paper, a French departmental reply, a linked annex, French search, bilingual coverage and a second page of document text. It checks the workspace usage count after the requests.

The API route is opt-in. The deployed configuration leaves `WRITTEN_QUESTIONS_PREVIEW` unset, so hosted retrieval returns `501 UNSUPPORTED_COVERAGE`. The verified ingress, local `cf` D1 materializer, and read CLI do not publish a D1 candidate or enable the route on a hosted Worker. Hosted coverage needs a separately reviewed source, target, and verification.

The API uses the normal workspace bearer-key authentication, `civicsignal.retrieve` capability, and request accounting. See [`/api/written-questions/openapi.json`](../src/routes/written-questions-openapi.ts) for the generated OpenAPI contract.

## Endpoints

All routes are under `/api/written-questions`.

### Search passages

```http
GET /api/written-questions?query=drinking%20water%20advisories&language=en&session=45-1&kind=reply&limit=20
```

`query` and `language=en|fr` are required. Search terms are tokenized and combined with AND. Optional filters are `session`, `kind=question|reply|cover_page|attachment`, and `limit` (default 20, maximum 100). A result is a verbatim question or document passage with its record edition, question number, document key, matching text, source hash, citation URL, attribution, and document availability. Large document matches include `chunkIndex`, `chunkCount`, `textChars`, and `hasMore`.

Representative response shape:

```json
{
  "items": [{
    "kind": "reply",
    "session": "45-1",
    "number": 1010,
    "language": "en",
    "documentKey": "reply-document-key",
    "fileLanguage": null,
    "text": "Matching source passage …",
    "citationUrl": "https://www.ourcommons.ca/written-questions/45-1/q-1010/14112405",
    "availability": "searchable",
    "hasMore": false
  }],
  "count": 1,
  "language": "en",
  "coverageBasis": "materialized-records"
}
```

The example document key and passage are illustrative. Every result cites the actual row selected from the local materialization.

### Exact question and documents

```http
GET /api/written-questions/45-1/1010/en
```

A materialized edition returns `state: "found"`, the question record, every recorded response document (including empty or gap documents), and `answerState`: `available`, `partial`, `pending`, `gap`, or `no-reply`. A language edition absent from the local store returns `state: "not-found"` in the HTTP 200 response. `acquisition` on the question is `pending`, `complete`, or `gap`; each document's `availability` is `searchable`, `stored`, or `gap`.

### Read later text chunks

```http
GET /api/written-questions/45-1/1010/en/chunks?documentKey=reply-document-key&offset=0&limit=10
```

`documentKey` is required. `offset` defaults to 0; `limit` defaults to 10 and is capped at 20. Each returned `text` chunk is at most 8,192 characters. The response also includes the total chunk count, `hasMore`, source hash, citation, attribution, and `fileLanguage`. Search indexing uses a 64-character boundary overlap; display chunks concatenate without overlap.

### Coverage

```http
GET /api/written-questions/coverage?session=45-1
```

The response has `basis: "materialized-records"` and rows by session and edition language. Counts include questions, complete/pending/gap question acquisitions, searchable/stored/gap replies, and searchable/stored/gap attachments. These are local row counts; use the House inventory totals above to compare with the published source list.

### OpenAPI

```http
GET /api/written-questions/openapi.json
```

## Edition language and file language

`language` in a route, record, or search result selects the English or French question edition. `fileLanguage` describes the physical response file when the source reports it: `e` for English, `f` for French, `b` for bilingual, or `null` when unknown. A shared bilingual PDF may contribute the same source text to both question editions; `language: "en"` does not imply `fileLanguage: "e"`. Citation URL, source hash, and attribution travel with the passage so the retrieved language and the file's own language stay distinct.

## HTTP and availability states

- `200`: search passages, coverage rows, chunks, or an exact lookup. A missing exact edition is represented by `state: "not-found"`, not an HTTP 404.
- `400 INVALID_ARGUMENT`: malformed, repeated, unsupported, or out-of-range query parameters.
- `401 KEY_REQUIRED` / `KEY_INVALID`; `403 WRONG_KEY_KIND`, `CAPABILITY_REQUIRED`, or `WORKSPACE_DISABLED`; `429 FUSE_EXCEEDED`: normal workspace access controls.
- `404 NOT_FOUND`: the requested chunk document key does not exist for that edition.
- `405 METHOD_NOT_ALLOWED`: unsupported HTTP method.
- `501 UNSUPPORTED_COVERAGE`: the preview flag is off; this is the configured deployed state.
- `503 RETRIEVAL_UNAVAILABLE` (or the shared `AUTH_UNAVAILABLE` / `USAGE_UNAVAILABLE` errors): missing or unreadable local D1 data, invalid stored metadata, or an untrusted citation.

The shared error contract also defines `502 UPSTREAM_UNAVAILABLE`; written-question retrieval itself reads the materialized D1 rows and does not call the House upstream during a request.

## Local operator references

- [Catalogue acquisition and corpus replay](evidence/2026-11-23/parliamentary-corpus.md#replay-locally)
- [Coverage, response types, and known source gaps](evidence/2026-11-23/parliamentary-corpus.md#house-written-questions)
- [API route](../src/routes/written-questions.ts), [request/response schemas](../src/routes/written-questions-contract.ts), and [local D1 materializer](../scripts/materialize-written-questions.ts)
