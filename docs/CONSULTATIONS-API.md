# Federal consultations API

The consultations preview serves the Government of Canada's published catalogue of departmental consultations in both languages. It is enabled only when `CONSULTATIONS_PREVIEW=on`; the tables live in `CIVIC_DB`.

The catalogue is [Open Dialogue – Consultations](https://open.canada.ca/data/en/dataset/7c03f039-3753-4093-af60-74b0f7b2385d) from the Open Government Portal. The intake reads the published CSV and the publisher's schema JSON:

- `https://open.canada.ca/static/consultations_open.csv`
- `https://open.canada.ca/data/recombinant-published-schema/consultations.json`

The November 24, 2026 observation holds 5,208 rows from 62 institutions, in English and French.

## Identity

A registration number is **not** unique: `C-0000001` alone appears on 13 unrelated consultations from different departments. The identity is the pair `(owner_org, registration_number)`, written `owner_registration`, for example `esdc-edsc_C-1235757`. The department code is lowercased; the registration keeps the publisher's case because one department published `c-ISC0016` and `c-isc0016` as separate consultations.

## Records

Each record carries:

| Field | Meaning |
| --- | --- |
| `editions.en` / `editions.fr` | Title, description, department profile link and "What we heard" report link in each edition |
| `dates.start` / `dates.end` | The published consultation window, as dates |
| `statusCode` | The publisher's code, unchanged: `O`, `P` or `C` |
| `status.label` | The published label from the schema dictionary. `C` is labelled Closed/Fermée and marked `inferred`; the schema lists only the longer closed variants |
| `subjects`, `partnerDepartments` | Publisher codes with the schema's bilingual labels when it defines them |
| `reportAvailableOnline` | The publisher's answer, or null when it is blank |
| `stateAtObservation`, `statusAgreesWithDates` | Derived from the dates at the time of the stored observation |
| `firstObservedAt`, `lastObservedAt`, `revision` | When CivicSignal first and last saw the record, and how many publisher changes it has made |
| `removedAt` | When a later full catalogue stopped listing the consultation; null while it is current |

A description may be missing in one language. It stays null; the API does not translate or borrow the other edition's text.

## Routes

| Route | Purpose |
| --- | --- |
| `/api/consultations?query=&language=` | Search titles and descriptions in one edition |
| `/api/consultations/{id}` | Inspect one consultation and its observed revisions |
| `/api/consultations/coverage` | Inspect counts, editions, links, reports and stale records |
| `/api/consultations/openapi.json` | Discover the contract |

Search accepts only current records; a removed consultation drops out of search but remains retrievable by ID with its history. Search accepts `query` (1–256 characters), `language` (`en` or `fr`), `state` (`open`, `planned`, `closed` or `unknown`), `institution` (department code), `subject` (publisher subject code), `asOf`, `offset` and `limit` (1–100, default 20). Title matches rank before description matches; the rest are ordered by start date and ID. Each hit gives the selected edition's title, a description excerpt of at most 400 characters, the dates, the computed state and a citation.

Lookup accepts `asOf` and returns the record with its revision history, newest first, including a `removed` event when the publisher dropped it. An unknown ID returns HTTP 200 with `item: null` so a client can distinguish a missing record from a failed request.

Coverage accepts `institution` and `asOf` and returns the observation and both source hashes, counts by state and status code, per-edition completeness, profile link kinds, the number of published reports, the revision row count, how many records a later catalogue dropped (`removed`), and how many current records are older than the current observation (`stale`).

## State on a date

`asOf` defaults to the request time. The state is computed from the dates, not from the status code:

| State | Rule |
| --- | --- |
| `planned` | `asOf` is before the start date, from 00:00 UTC |
| `open` | `asOf` is inside the window, end date included through 23:59:59.999 UTC |
| `closed` | `asOf` is after the end date |
| `unknown` | A date is missing |

The publisher's code and the dates disagree on 111 of the 5,208 rows, mostly `O` rows whose end date has passed. Both facts are returned; `statusAgreesWithDates` is false rather than one value silently replacing the other. At the November 24 observation the dates give **71 open, 10 planned, 5,127 closed**, while the codes give 122 `O`, 58 `P` and 5,028 `C`.

## Links

Profile and report links are normalized without rewriting the publisher's decision:

| `kind` | Meaning |
| --- | --- |
| `official` | An http(s) link to the department's notice |
| `third-party-wrapper` | An Outlook Safe Links wrapper; `unwrapped` holds the embedded target |
| `missing` | An empty value or `N/A` |
| `unparsable` | Published text that is not a URL, such as a description in the link cell |

A value without a scheme is retried as `https://…` when it looks like a host and path. The November 24 observation has 4,890 official, 3 wrapped, 209 missing and 106 unparsable English profile cells.

## Example

```http
GET /api/consultations?language=en&query=artificial%20intelligence&asOf=2026-11-24T17:00:00Z HTTP/1.1
Authorization: Bearer <workspace-key>
```

```json
{
  "source": "canada",
  "observedAt": "2026-11-24T18:00:00.000Z",
  "asOf": "2026-11-24T17:00:00.000Z",
  "items": [{
    "id": "esdc-edsc_C-1235757",
    "registrationNumber": "C-1235757",
    "ownerOrg": "esdc-edsc",
    "institution": {
      "en": "Employment and Social Development Canada",
      "fr": "Emploi et Développement social Canada"
    },
    "title": "Early Engagement on Phase 2 Digital Technologies Accessibility Regulations",
    "description": "…",
    "dates": { "start": "2026-10-27", "end": "2027-01-29" },
    "state": "open",
    "statusCode": "O",
    "status": { "en": "Open – Accepting Input", "fr": "Ouverte – Avis acceptés" },
    "editions": ["en", "fr"],
    "reportAvailableOnline": false,
    "match": { "field": "title", "snippet": "Early Engagement on Phase 2 Digital Technologies Accessibility Regulations" }
  }],
  "nextOffset": null
}
```

The same record is `closed` for `asOf=2027-03-01T00:00:00Z`. Citing it means citing the department's published notice through `editions.en.profile.url` or `editions.fr.profile.url`, together with the dates and the status code.

## Refresh and revisions

```sh
bun scripts/materialize-consultations.ts \
  --csv https://open.canada.ca/static/consultations_open.csv \
  --schema https://open.canada.ca/data/recombinant-published-schema/consultations.json \
  --db data/corpus/consultations/catalogue.sqlite \
  --observed-at 2026-11-24T17:00:00Z \
  --receipt dist/consultations/receipt.json
```

Run it on a cadence and keep the receipt. The November 24 refresh took about 5 seconds including the 6.8 MB download and the schema; measure the interval before scheduling it under D-08. `bun run refresh:consultations` runs the same command against the published URLs.

The materializer archives both originals under `sources/<sha256>`, validates the composite key and the dictionary labels, writes the catalogue and records in one transaction, and refuses an observation older than the stored one. A record's `revision` and a revision row appear only when the **publisher's** facts change: titles, descriptions, dates, links, report availability, subjects or partner departments. The state and its agreement with the status code are derived from the observation time, so a later observation that closes a record updates the row without inventing a publisher change.

Replaying the same CSV produces zero added, changed, removed or stale rows and the same catalogue revision. In the recorded run, extending one consultation's end date and adding its report produced a single `changed` event with `dates.end`, `report.url` and `report.available` paths; observing the same extended catalogue 20 days later produced no event. A row that disappears from a later full catalogue records a `removed` revision, keeps its last listing data, and is excluded from search; if it reappears it records an `added` revision and is current again.

Each run also writes a change digest to the receipt:

```json
"changes": {
  "added": 0,
  "removed": 1,
  "categories": { "end-extended": 0, "end-shortened": 0, "start-moved": 0,
    "status-changed": 0, "report-changed": 0, "edition-changed": 0, "other": 0 },
  "sample": [{ "id": "ic_C-0058", "event": "removed", "categories": [], "changedFields": [] }]
}
```

A record may appear in several categories; `sample` holds at most 50 entries ordered by ID. An unchanged run returns all zeros and an empty sample, which is the operational signal that the publisher has not moved.

The November 24 receipt and acceptance measurements are in
[consultations-catalogue.json](evidence/2026-11-24/consultations-catalogue.json).

## Known limits

- The intake reads the catalogue, not each department's notice. `who may participate` and `how to respond` remain on the linked page; only its URL is served. Parsing those notices is the next work item for this family.
- Profile cells published as prose are served as `unparsable` text rather than a guessed URL: 106 English and 124 French cells at this observation.
- The label for `C` is inferred. The publisher's schema defines `O`, `P` and the longer closed variants (`CA`, `CN`, `CR`, `NF`), but not the `C` the CSV uses.
- A row dropped from the catalogue is recorded as removed, but a formal withdrawal is not distinguished from a change in the catalogue's own scope.
