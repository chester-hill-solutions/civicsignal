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
| `/api/committees/{session}/calls` | List the studies currently seeking briefs, with a state for the queried date |
| `/api/committees/{session}/calls/{callId}` | Inspect one call, its deadline and submission instructions |
| `/api/committees/search?query=water&language=en` | Search indexed passages |
| `/api/committees/coverage` | Inspect cutoff, counts and paged outstanding IDs |
| `/api/committees/openapi.json` | Discover the OpenAPI contract |

Search accepts optional `session`, `chamber`, `committeeId`, `studyId`, `kind`, `offset`, and `limit`. It returns citations, source locations, published speaker, affiliation, authors and credits, parent references, and `hasMore`. Search response `coverageBasis` is `materialized-records`. `language` is mandatory on search, detail, document and passage routes; list routes can filter by language. Each detail relationship includes the related record's `kind`, the source relation label, and `direction` (`parent` or `child`) so clients can move in either direction.

Coverage accepts optional `session` (default `45-1`), `chamber`, `committeeId`, `language`, `kind`, `offset`, and `limit`. The `counts` array groups materialized records by committee, chamber, language, kind and acquisition status. `outstanding` enumerates IDs with `stored`, `pending`, `unavailable` or `removed` status in deterministic pages and reports its total; `stored` records have an original but may still lack searchable text. Counts and outstanding rows include the committee's published `metadata.directoryCutoffs` when recorded. The top-level cutoff is the recorded snapshot cutoff for the selected session.

## Calls for briefs

A call is a committee study that the publisher lists as currently seeking input.
One record exists per language edition. The House publishes the current list at
`/Committees/{en|fr}/Participate`; each listed study page carries a participation
button, an optional deadline and the published submission instructions.

The Senate publishes briefs and other documents, but the committee index, a
committee page and its briefs and studies pages returned no listing of studies
currently inviting briefs. The intake archives each page it checked and records
that gap. It does not infer Senate calls from the existence of briefs.

| Route | Returns |
| --- | --- |
| `/api/committees/{session}/calls` | Calls that match, each with its state for `asOf`, the deadline, and a short instructions excerpt |
| `/api/committees/{session}/calls/{callId}` | The same call plus counts of the linked study's published submissions, evidence and meetings |

`calls` accepts `language` (optional; without it both editions are returned),
`query` (title and published instructions), `committeeId`, `status`
(`open`, `closed`, `unknown`), `asOf` and the usual `offset`/`limit`. `language`
is required on the exact route.

### State on a date

`status` is computed for `asOf`, which defaults to the request time, and
`statusBasis` says which fact decided it.

| Basis | Meaning |
| --- | --- |
| `deadline` | The publisher published a deadline that names a zone, a date and a weekday. The call is open through that instant. |
| `listing-observation` | No deadline was published. The last observation that listed the call vouches for it on that day; before the first observation the state is `unknown`, and without a refresh the next day it returns to `unknown`. A call that left the current list keeps an older `lastListedAt`, so it does not stay open on a stale stamp. |
| `unobserved` | The query date precedes every observation. The answer is unknown, not closed. |

Each call also reports whether the latest observation still lists it (`listed`, `lastListedAt`), whether a published change is waiting for a second agreeing observation (`pendingChange`), and whether another study published the same motion text in that run (`contentConflict`). The last two are publisher-integrity signals; the call's published content is held until it is consistent.

`deadline.text` is the publisher's phrase verbatim, for example
`before 11:59 p.m. (EST) on Monday, November 30, 2026`. `deadline.instant` is
present only when the phrase, its date and its weekday agree; `timeZone` keeps
the published label. A phrase the intake cannot place stays text-only and the
state falls back to the observation.

Instructions are published text under the same delivery rule as every other
committee excerpt: at most 400 characters with `instructionsTruncated` telling
the client to open `instructionUrl` for the rest. A publisher content warning is
kept separate in `contentWarningText` rather than merged into the instructions.

### Example

```http
GET /api/committees/45-1/calls?language=en&status=open&asOf=2026-11-24T18:00:00Z HTTP/1.1
Authorization: Bearer <workspace-key>
```

```json
{
  "session": "45-1",
  "asOf": "2026-11-24T18:00:00.000Z",
  "items": [{
    "id": "house-hesa-call-13632808",
    "language": "en",
    "title": "Diagnostic Imaging Capacity",
    "url": "https://www.ourcommons.ca/committees/en/HESA/StudyActivity?studyActivityId=13632808",
    "status": "open",
    "statusBasis": "listing-observation",
    "deadline": null,
    "instructions": "Written submissions of no more than 2,000 words can be submitted to the committee.",
    "instructionsTruncated": true,
    "instructionUrl": "https://www.ourcommons.ca/committee-participation/en/submit-brief/hesa/13632808",
    "committee": { "id": "house-hesa", "name": "Health" },
    "study": { "id": "house-hesa-study-13632808", "title": "Diagnostic Imaging Capacity",
      "url": "https://www.ourcommons.ca/committees/en/HESA/StudyActivity?studyActivityId=13632808" },
    "listingUrl": "https://www.ourcommons.ca/Committees/en/Participate",
    "contentWarning": false,
    "contentWarningText": null,
    "listed": true,
    "lastListedAt": "2026-11-24T16:17:46.000Z",
    "pendingChange": false,
    "contentConflict": false,
    "observedAt": "2026-11-24T16:17:46.000Z",
    "firstObservedAt": "2026-11-24T16:17:46.000Z"
  }],
  "offset": 0,
  "limit": 20,
  "hasMore": false,
  "coverageBasis": "materialized-records"
}
```

Follow `url` or `study` to the study page for its order of reference and its
published briefs, or use the committee routes to list that study's meetings and
evidence. A position belongs to the submitter or speaker the committee published;
the call itself has no author.

### Refresh the calls

```sh
bun run refresh:committee-calls --receipt dist/committee-calls/receipt.json
```

The intake fetches both editions with the shared committee download cache and archives each original by SHA-256. `--from-cache` re-parses archived pages for an offline rerun; it is off by default because an earlier corpus copy is not the current call.

The receipt reports `added`, `changed`, `unchanged`, `pending`, `conflicts` and `dropped`. A study that leaves the current list is marked `listed: false` with its `lastListedAt` unchanged; that is an observation, not a publisher change, so it creates no revision. A run whose pages are unchanged reports zero added, changed and dropped.

Two publisher-defect guards run on every refresh:

1. **Confirm before commit.** A changed motion or instruction block replaces the stored content only after two consecutive observations agree. One contradictory page load records `pendingChange` and keeps the confirmed text.
2. **Shared motion text.** A committee's standard submission block is legitimately shared, so only study-specific motion text is compared. When two study IDs publish the same motion in one run, the House has served one study's block on the other's page; both are held and reported as `contentConflict` until the publisher is consistent.

Measure request volume, run duration and the observed publication interval before setting a hosted cadence under D-08. The November 24 run fetched 30 study pages and eight Senate pages in about 30 seconds.

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
