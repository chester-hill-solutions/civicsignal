# Committee corpus API

The committee corpus preview uses the shared authenticated CivicSignal API. It is enabled only when `COMMITTEE_CORPUS_PREVIEW=on` and the isolated committee database is bound as `COMMITTEE_DB`. The coverage endpoint describes materialized indexes; it does not imply complete acquisition.

Every operation is GET and returns JSON. Search and list operations use stable ID and language ordering with `offset` (default `0`) and `limit` (default `20`, maximum `100`). Use only `en` or `fr`; the language filter applies before text matching. Committee identifiers are source-scoped slugs such as `house-envi`.

## Routes

| Route | Purpose |
| --- | --- |
| `/api/committees/{session}` | List session committees |
| `/api/committees/{session}/{committeeId}` | Inspect a committee and its linked records |
| `/api/committees/{session}/{committeeId}/studies` | List studies |
| `/api/committees/{session}/{committeeId}/studies/{studyId}` | Inspect a study under its committee |
| `/api/committees/{session}/{committeeId}/meetings` | List meetings |
| `/api/committees/{session}/{committeeId}/meetings/{meetingId}` | Inspect a meeting under its committee |
| `/api/committees/{session}/documents/{documentId}` | Inspect publication metadata and links |
| `/api/committees/{session}/documents/{documentId}/passages?language=en` | Read ordered cited passages |
| `/api/committees/search?query=water&language=en` | Search indexed passages |
| `/api/committees/coverage` | Inspect cutoff, counts and paged outstanding IDs |
| `/api/committees/openapi.json` | Discover the OpenAPI contract |

Search accepts optional `session`, `chamber`, `committeeId`, `studyId`, `kind`, `offset`, and `limit`. It returns citations, source locations, published speaker, affiliation, authors and credits, parent references, and `hasMore`. Search response `coverageBasis` is `materialized-records`. `language` is mandatory on search, detail, document and passage routes; list routes can filter by language. Each detail relationship includes the related record's `kind`, the source relation label, and `direction` (`parent` or `child`) so clients can move in either direction.

Coverage accepts optional `session` (default `45-1`), `chamber`, `committeeId`, `language`, `kind`, `offset`, and `limit`. The `counts` array groups materialized records by committee, chamber, language, kind and acquisition status. `outstanding` enumerates IDs with `stored`, `pending`, `unavailable` or `removed` status in deterministic pages and reports its total; `stored` records have an original but may still lack searchable text. Counts and outstanding rows include the committee's published `metadata.directoryCutoffs` when recorded. The top-level cutoff is the recorded snapshot cutoff for the selected session.

## Rights and disclosure

The database may hold text for indexing even when delivery is restricted. A record with `metadata.delivery="metadata-only"` can produce a search hit, but the response contains no matching text. Passage retrieval likewise returns `text: null`. Its citation, title, author or speaker metadata, affiliation, and location remain available where published. Missing or unknown delivery policy is treated as metadata-only.

Only a record explicitly marked `metadata.delivery="excerpt"` may return body text. Each search hit and passage is limited to 400 characters, regardless of passage size or pagination; callers cannot reconstruct a long passage by requesting adjacent offsets. This cap applies to proceedings too. Original official URLs and hashes remain metadata and are not a grant to redistribute file bytes. The preview does not provide original PDF downloads.

The committee records link to the published use terms for their chamber. Third-party submissions return their citation and location. [House notices](https://apps.ourcommons.ca/en/important-notices) · [Senate intellectual property](https://sencanada.ca/en/intellectual-property/)

## Example

```http
GET /api/committees/search?query=drinking%20water&language=en&session=45-1&limit=10 HTTP/1.1
Authorization: Bearer <workspace-key>
```

```json
{
  "items": [
    {
      "citation": {
        "id": "house-envi-submission-123",
        "title": "Submission on drinking water",
        "url": "https://www.ourcommons.ca/Content/Committee/451/ENVI/Brief/BR12345678/br-external/example-e.pdf",
        "language": "en",
        "kind": "submission"
      },
      "position": 0,
      "location": "page 2",
      "text": null,
      "speaker": null,
      "affiliation": "Example organization",
      "authors": ["A. Writer"],
      "credits": [{"organization": "Committee publishing service"}],
      "parents": [
        {"id": "house-envi", "kind": "committee", "relation": "committee", "direction": "parent"},
        {"id": "freshwater-study", "kind": "study", "relation": "submission", "direction": "parent"}
      ]
    }
  ],
  "language": "en",
  "offset": 0,
  "limit": 10,
  "hasMore": false,
  "coverageBasis": "materialized-records"
}
```

The example submission demonstrates a metadata-only search hit: matching happened against privately indexed text, while the body remains undisclosed. Cite its original URL. Use the document and committee links to follow relationships rather than inferring them from titles.

## Local use examples

These are workflow illustrations, not statements that a source permits a particular use. A local noncommercial researcher can search metadata-only submissions, follow the official citation and prepare internal notes without copying indexed body text. A staff analyst can review an explicitly permitted short excerpt, preserve the published submitter and organization credits, and link the study and committee. In either case, confirm each publication class's source terms before enabling delivery or republishing material.

## States

Each record retains its publication `kind` and acquisition `status`, including `indexed`, `searchable`, `stored`, `unavailable`, `removed`, `superseded`, or `pending`. Index coverage and text availability are separate: an indexed record may not have stored bytes, and a stored original may have no searchable text. `unavailable` and `removed` records still carry metadata and citations when the publisher provided them. A superseded record lists the replacement IDs for the same source URL in `metadata.replacementIds`. A missing exact record returns `state: "not-found"`; it does not substitute a nearby record.

Errors use the shared API envelope. Malformed arguments return 400, disabled preview returns 501, and a missing/unavailable database returns 503. Authentication and workspace capability checks are applied by the common Worker middleware. This preview does not add a separate authorization path.

## Rebuild the local collection

Run the following from the repository root with Python 3, curl and Poppler's `pdftotext`. The catalogue, compressed originals, URL checkpoints, acquisition database and coverage receipt live under `data/corpus/committees/`.

```sh
python3 -B scripts/committee-catalogue.py
python3 -B scripts/committee-download.py
python3 -B scripts/committee-expand.py
python3 -B scripts/committee-corpus.py
python3 -B scripts/committee-download.py --verify-only
```

An interrupted download resumes from its last committed URLs. The default pass retries missing originals. Use `--refresh` to check previously stored files for replacements, or `--url` to bound a refresh to specific publications. Run expansion after refreshing the catalogue or its originals. It follows the files cited inside a report or response and retains events, linked bills and meetings from the study page. The corpus builder checkpoints each batch. It seals the session cutoff after reconciling its records and relationships.

Initialize the dedicated local D1 candidate and materialize the sealed collection. The UUID below identifies this local preview.

```sh
cf d1 migrations apply 2e6f6b5d-bddd-4ae9-b879-92114cc37799 --local --persist-to .wrangler/committees-45-1 --dir preview/committees/migrations
python3 -B scripts/materialize-committee-corpus.py
```

On macOS with an offline APFS candidate, `python3 -B scripts/materialize-committee-corpus.py --clone-local` shares unchanged disk blocks with the acquired SQLite database. Both paths verify the serving rows, text lengths and search index before publishing the local candidate. The previous generation remains readable after a failed verification. Set `CIVICSIGNAL_COMMITTEES_D1` to the generated database file to run the authenticated integration test.

```sh
bun run test test/endpoints.test.ts -t 'session committee corpus through the Worker'
```
