# GEDS API

The Worker serves these endpoints when `GEDS_PREVIEW=on` and `CIVIC_DB` contains
a published GEDS snapshot. Every operation uses the shared Bearer-key
authentication and retrieval billing path. The public OpenAPI document is
`GET /api/geds/openapi.json`.

## Search and traversal

Search endpoints accept `lang=en|fr` (default English), `asOf` as a date or ISO
8601 timestamp, `limit` (1–100) and `offset` (0–10,000). Search accepts `q` up
to 200 characters. Organization and person search accept `exact=true` for an
exact match. People search also accepts `organizationId`.

```sh
curl -H "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
  'http://localhost:8787/api/organizations?q=Corporate%20Management%20Branch&lang=en'
curl -H "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
  'http://localhost:8787/api/organizations?q=Direction%20g%C3%A9n%C3%A9rale%20de%20la%20gestion%20int%C3%A9gr%C3%A9e&lang=fr'
```

Both names resolve to one organization ID. Use it to traverse the hierarchy,
read an organization or list its people:

```text
GET /api/organizations/{id}
GET /api/organizations/{id}/hierarchy
GET /api/organizations/{id}/people?descendants=true&limit=20&offset=0
```

People can be searched and read with `GET /api/people`,
`GET /api/people/{id}`, and `GET /api/people/{id}/contact`. Contact results
preserve the publisher's field label, indicate whether a telephone reaches the
person or a general office, and cite the dataset, source resource, snapshot and
observed value.

Organization search returns the selected language, effective `asOf`, snapshot
metadata, a page object and rows with bilingual organization names and a
department. Representative response shape (the concrete values depend on the
published snapshot):

```json
{
  "language": "fr",
  "asOf": "2026-11-23T12:00:00.000Z",
  "snapshot": {
    "id": "snapshot-id",
    "seq": 4,
    "effectiveAt": "2026-11-23T12:00:00.000Z",
    "publishedAt": "2026-11-23T12:01:00.000Z",
    "sourceDate": null,
    "sourceUrl": "https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip",
    "datasetId": "8ec4a9df-b76b-4a67-8f93-cdbc2e040098",
    "datasetUrl": "https://open.canada.ca/data/dataset/8ec4a9df-b76b-4a67-8f93-cdbc2e040098",
    "original": { "sha256": "…", "csvSha256": "…", "archiveKey": "…" }
  },
  "query": "Direction générale de la gestion intégrée",
  "items": [{
    "id": "org_…",
    "name": "Direction générale de la gestion intégrée",
    "nameEn": "Corporate Management Branch",
    "nameFr": "Direction générale de la gestion intégrée",
    "acronym": "CMB-DGGI",
    "department": {
      "acronym": "EX-EX",
      "name": "Ministère des exemples",
      "nameEn": "Example Department",
      "nameFr": "Ministère des exemples"
    },
    "parent": {
      "id": "org_…",
      "name": "Ministère des exemples",
      "nameEn": "Example Department",
      "nameFr": "Ministère des exemples",
      "acronym": "EX-EX"
    },
    "level": 2,
    "path": "root/ou:ex ex/ou:cmb dggi"
  }],
  "page": { "limit": 20, "offset": 0, "total": 1, "hasMore": false }
}
```

## Local fixture replay

The focused fixtures include a person moving from Corporate Management Branch
to Programs Branch, two same-name people with distinct published contacts, and
a unit represented only by a general office number. The Vitest suite runs the refresh pipeline and prepared handlers against SQLite with the directory migration. Use Node 24 for Vitest.

```sh
bun run test test/geds-normalize.test.ts test/geds-refresh.test.ts test/geds-refresh-recovery.test.ts test/geds-csv-chunks.test.ts test/geds-api.test.ts
```

The tests verify English/French resolution, current traversal and cited contact,
historical lookup before the transfer, general-office labelling, validation,
not-found behavior, bilingual OpenAPI examples, and DDL application over both
fresh and existing CivicSignal schemas. Worker-level requests use the shared
authenticated dispatch. For local D1 schema replay, see
[GEDS pipeline](GEDS.md#source-and-refresh).
