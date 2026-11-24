# GEDS directory pipeline

CivicSignal's Government Electronic Directory Services (GEDS) pipeline imports the
official bilingual employee and organization export into versioned SQLite/D1
tables. The source CSV has no employee or unit primary key, so CivicSignal IDs are
derived from the published identity facts. They distinguish same-name listings
and keep a person's ID stable when their role moves between units, provided the
identity fields used by the normalizer remain stable. They are CivicSignal IDs,
not identifiers issued by GEDS.

## Source and refresh

The dataset is [Government of Canada Employee Contact Information](https://open.canada.ca/data/dataset/8ec4a9df-b76b-4a67-8f93-cdbc2e040098),
published by Shared Services Canada under the Open Government Licence – Canada.
The usable resource is the bilingual CSV inside
[`gedsOpenData.zip`](https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip)
and is encoded as ISO-8859-1. The importer records the official URL, observation
time, source date where available, content hashes, coverage and omissions. Each
changed original is archived under its SHA-256. It builds a candidate snapshot
and publishes it atomically; readers continue to see the last published snapshot
if refresh stops part-way through.

Refresh from the official resource (downloads only; no hosted operation):

```sh
mkdir -p dist/geds
bun scripts/geds-import.ts --download \
  --db dist/geds/geds.sqlite \
  --archive dist/geds/archive \
  --as-of "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

For a saved source file, use `--csv /path/to/gedsOpenData.csv`; the importer
accepts `--source-date` when the catalogue supplies one. `--db`, `--archive`,
and `--report` can point to a separate data volume. The report defaults to
`dist/geds/receipt.json`; `--receipt /path/to/receipt.json` writes an additional
copy only when requested. Each report states whether the run published a
snapshot or replayed one, with the rows it added, changed, removed and verified.

To apply the schema to isolated local D1 state, use the repository Cloudflare
CLI (`cf`):

```sh
cf d1 migrations apply 8056b1a0-f858-4f89-a332-91f7f350eb7b \
  --local --persist-to .wrangler/geds --dir preview/geds/migrations --table geds_preview_migrations
```

To populate that isolated state, close the local server and pass its D1 SQLite file to the importer. In a fresh directory containing this single database, the commands below identify the application file and exercise both transfer fixtures. Use the fixture timestamps shown so historical queries select the intended edition.

```sh
geds_db=$(rg --files --hidden --no-ignore .wrangler/geds/v3/d1/miniflare-D1DatabaseObject | rg '/[0-9a-f]{64}\.sqlite$')
bun scripts/geds-import.ts --csv test/fixtures/geds/snapshot-a.csv --as-of 2026-01-01T00:00:00Z --db "$geds_db" --archive dist/geds/fixtures/archive --report dist/geds/fixtures/receipt-a.json
bun scripts/geds-import.ts --csv test/fixtures/geds/snapshot-b.csv --as-of 2026-02-01T00:00:00Z --db "$geds_db" --archive dist/geds/fixtures/archive --report dist/geds/fixtures/receipt-b.json
CIVICSIGNAL_GEDS_FIXTURE_SQLITE="$geds_db" bun run test test/endpoints.test.ts -t 'GEDS directory through the Worker'
```

The integration test uses a local workspace key and checks membership in English and French against the SQLite file just populated. Use separate local state for an official bulk import.

The accepted export is checked through the same authenticated routes. The test
resolves "Privy Council Office" and its published French name to one ID, reads a
member of that unit, and requires the returned contact to cite the dataset and the
snapshot it came from. It also requires an `asOf` date before the first snapshot
to fail rather than answer:

```sh
CIVICSIGNAL_GEDS_SQLITE=dist/geds/geds.sqlite \
  bun run test test/endpoints.test.ts -t 'real unit from both published names'
```

### Full October 25 export

The November 24, 2026 import downloaded the published archive (11,457,488 bytes,
`Last-Modified` 2026-10-25T14:55:39Z), archived it under SHA-256
`8f6f075f63e1d40a51da444417c35ce5f2f2de86dafa44f0c998ab9463313751`, and published
snapshot `snap_5eb69f7b8a23b19c66f29b96cbc7a3cb` in 418 seconds of importer time.

| Published | Count |
| --- | ---: |
| Source rows | 189,994 |
| Distinct roles | 189,877 |
| People | 188,816 |
| General-office listings | 110 |
| Organizations | 21,874 |
| Change events | 211,751 |
| Unresolved records | 0 |

English titles are published on 180,460 rows and French titles on 180,147.
Department and organization names cover every row in both languages. Telephone
is absent from 62,983 rows, email from 76,387, and 20,183 rows publish neither.
One row has no surname or given name; it is retained as a general office. The
export repeats 117 identities within itself, so 189,994 source rows produce
189,877 distinct roles. The 110 general-office listings are stored as person rows
for contact fallback but excluded from the people count.

Replaying the same CSV re-read every row, found every identity unchanged, and
added no snapshot and no change event. The published table digests were identical
before and after. A replay of the same ZIP compares the archive SHA-256 and
completes its refresh in 26 milliseconds without re-reading the CSV; the download
dominates its wall time. The receipt for this run and both replays is
[geds-full-import.json](evidence/2026-11-24/geds-full-import.json);
[geds-published-digest.py](evidence/2026-11-24/geds-published-digest.py) recomputes
the published digests.

The export is not entirely well formed. Fifteen of its 189,994 records repeat an
unescaped quote inside a quoted field, such as
`"... SERVICES D"IDENTITÉ NUMÉrique"`. A strict reader ends that field at the
second quote and splits the record into as many as 51 columns. The reader in
`src/geds/csv.ts` treats a quote that no delimiter follows as text, so all 189,994
records keep the 44 published columns. The archived original preserves the
publisher's bytes.

## Historical data model

An `asOf` date selects the latest published snapshot observed on or before that
date. Roles, organization names and contacts are read from that snapshot, so a
person who moved units retains their earlier role and contact on historical
queries. A date before the first published snapshot returns `NO_SNAPSHOT_AS_OF`.
Missing source fields remain missing. A listing without a person's name can be
returned as a general-office contact and is labelled as such.

See [GEDS API](GEDS-API.md) for the endpoint contract and bilingual examples.
