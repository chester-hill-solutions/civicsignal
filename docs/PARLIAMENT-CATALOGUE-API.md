# Current parliamentary catalogues

The local Worker exposes the bilingual LEGISinfo catalogue for bills originating in either chamber and both chambers’ Journals, recorded-vote indexes and member voting records. Each lookup selects a session, language and record key. Every edition links to its parliamentary source. The bill trace API also provides a separate source-linked brief for S-5. [Bill trace](BILL-TRACE-API.md)

| Authenticated GET | Returns |
| --- | --- |
| `/api/parliament/bills` | Bill titles and statuses in the selected edition, LEGISinfo IDs and first-reading dates |
| `/api/parliament/house-votes` | Motion subjects, dates of decision, results and counts for yeas, nays and paired members |
| `/api/parliament/senate-votes` | Standing-vote subjects, decision dates, outcomes and counts for yeas, nays and abstentions |
| `/api/parliament/house-journals`, `/api/parliament/senate-journals` | Sitting editions, publication status and passage count |
| Either Journals path followed by `/passages` or `/{key}/passages` | Search proceedings across the session or read one sitting in source order, with citations and publisher links |
| `/api/parliament/house-roll-calls`, `/api/parliament/senate-roll-calls` | Recorded divisions, with the number of listed members in the chosen edition |
| Either roll-call path followed by `/members` or `/{key}/members` | Search a voting history or read one division’s member positions, with the vote’s official citation |
| Any collection path followed by `/{key}` | The cited edition or `item: null` if its number is absent from the selected inventory |
| Any collection path followed by `/coverage` | Collection, session, observation timestamp, latest indexed record date, content revision, record count per language and attribution |

The parliamentary OpenAPI specification describes 29 authenticated data operations. Use a workspace bearer key with `civicsignal.retrieve`. Each successful data request costs one retrieval. The public OpenAPI document is available at `/api/parliament/openapi.json`. Enable local reads with `PARLIAMENT_CATALOGUE_PREVIEW=on` and a populated `CIVIC_DB`. An unloaded session returns `501 UNSUPPORTED_COVERAGE`. The Worker reads only the materialized database during retrieval.

```http
GET /api/parliament/bills?language=fr&session=45-1&query=environnement
GET /api/parliament/bills/c-1?language=en
GET /api/parliament/house-votes/198?language=fr
GET /api/parliament/senate-votes/coverage?session=45-1
GET /api/parliament/house-journals/passages?language=en&query=recorded%20division
GET /api/parliament/senate-journals/passages?language=fr&query=motion
GET /api/parliament/house-roll-calls/198/members?language=en&position=paired
GET /api/parliament/senate-roll-calls/members?language=fr&position=nay
GET /api/parliament/senate-roll-calls/j16-3/members?language=en&position=yea
```

The list and lookup operations require `language=en|fr`; session defaults to `45-1`. List searches match a literal case- and accent-insensitive substring in the number, title or summary. Results sort by date descending, then key. A page contains up to 100 editions. Send `nextOffset` as `offset` and include `coverage.revision` as `revision` to detect a changed catalogue between pages. Exact bill keys use lowercase, such as `c-1`. House division numbers and Senate decision IDs are positive integers written in decimal. Senate decision IDs need not be consecutive. House Journal identifiers retain the publisher’s uppercase suffix for entries issued during an adjournment, such as `20A`.

The bill date is the earliest published House or Senate first-reading timestamp expressed as a UTC calendar date. House and Senate vote dates use the decision day in the corresponding publisher’s record. Missing publisher dates or individual tally fields return null. A vote result and its numeric tallies are available under `item.details`. The Senate catalogue covers standing votes indexed by the Senate. Journals supply additional decisions, including voice votes.

An indexed roll call shares its session and numeric key with its chamber’s vote index. For a named Senate vote found only in a Journal, the key is `j{issue}-{ordinal}`, where ordinal counts roll calls in source order within that issue. Its metadata includes `journalIssue`, `journalVoteOrdinal` and a `tally` with yeas, nays and abstentions. Coverage includes `journalOnlyRecordsPerLanguage`.

Each member row carries the position as published. Use member identifiers within their chamber. House records also carry a separate `paired` flag. The `position=paired` filter includes every member marked as paired, including a member who also cast a yea or nay. Summing those three tally columns can count a member twice. A name query searches the published name, affiliation, constituency and province. Use `memberId` for an exact identifier when the source supplies one. A Journal-only list can supply a published surname without a member ID. That row is searchable by its printed name and has a null ID. An exact ID filter covers rows with that published identifier. Names alone can match different people. Position filters accept `yea`, `nay`, `paired` and `abstention`. Where the source omits a profile, affiliation or other field, the response uses null.

Journal and roll-call detail pages use the same language, revision, limit and offset parameters as the catalogue. The response includes the parent edition on every hit and a one-based source ordinal within that edition. A Journal lookup reports `details.status` and `details.passageCount`. Its coverage counts include unavailable sittings and give `unavailableEditions` separately for English and French. Passage searches cover the published text. A division without a recorded member list cannot establish an individual’s vote.

## Acquire and serve locally

Run the operators from the repository root. The Python operators run on macOS and Linux using the standard library. The catalogue and Journal operators archive publisher bytes by SHA-256 under `sources/objects` beside the output. Their receipts retain source URLs and hashes under `sources/inventories`. Roll-call operators retain source objects, conditional-request validators and successful manifests under the chamber-specific `sources/house-roll-calls` and `sources/senate-roll-calls` directories. The bill and House vote operators check the publisher’s aggregate against its listings. The Senate operator reads the two session indexes and reconciles their decision IDs, outcomes and tallies. They validate session, identifiers and completeness before replacing the JSON file. A publisher mismatch leaves the previous file available for retry.

```sh
python3 -B scripts/parliament-bills.py --session 45-1 --output data/corpus/parliament-intake/bills.json
python3 -B scripts/parliament-votes.py --session 45-1 --output data/corpus/parliament-intake/votes.json
python3 -B scripts/parliament-senate-votes.py --session 45-1 --output data/corpus/parliament-intake/senate-votes.json
p=data/corpus/parliament-intake
python3 -B scripts/parliament-house-journals.py --session 45-1 --output "$p/house-journals.json"
python3 -B scripts/parliament-senate-journals.py --session 45-1 --output "$p/senate-journals.json"
python3 -B scripts/parliament-roll-calls.py --votes "$p/votes.json" --output "$p/house-roll-calls.json"
python3 -B scripts/parliament-roll-calls.py --votes "$p/senate-votes.json" --output "$p/senate-roll-calls.json"
python3 -B scripts/parliament-journal-roll-calls.py --journals "$p/senate-journals.json" --votes "$p/senate-votes.json" --roll-calls "$p/senate-roll-calls.json" --output "$p/senate-roll-calls-complete.json"
bun scripts/materialize-parliament.ts "$p/catalogues.sqlite" "$p/bills.json" "$p/votes.json" "$p/senate-votes.json" "$p/house-journals.json" "$p/senate-journals.json" "$p/house-roll-calls.json" "$p/senate-roll-calls-complete.json"
CIVICSIGNAL_CHAMBERS_SQLITE="$p/catalogues.sqlite" CIVICSIGNAL_PARLIAMENT_SQLITE="$p/catalogues.sqlite" bun run test test/endpoints.test.ts -t 'current parliamentary catalogues through the Worker'
```

The materializer also accepts a local `CIVIC_DB` SQLite file as its first argument. It creates the dedicated parliamentary tables and publishes one complete bilingual collection per transaction. An unchanged observation advances the cutoff and keeps its content revision. An older observation or a conflicting snapshot at the same instant is rejected. The returned receipt records the revision and the per-language count. Publish the combined Senate roll-call packet after reconciling the Journal and vote index. The materializer rejects an index-only replacement for a session that already serves supplemental Journal roll calls.

Official sources include the [English LEGISinfo export](https://www.parl.ca/legisinfo/en/bills/json), [French LEGISinfo export](https://www.parl.ca/legisinfo/fr/projets-de-loi/json), [English House vote listing](https://www.ourcommons.ca/Members/en/votes), [French House vote listing](https://www.ourcommons.ca/deputes/fr/votes) and the [Senate standing-vote index](https://sencanada.ca/en/in-the-chamber/votes/45-1).

## November 23 local coverage

The November 23 Toronto run reconciled 201 bills, 198 House divisions and 36 Senate standing votes in each official language. The House listing and XML contained divisions 1 through 198. The two Senate indexes contained the same 36 decision IDs, including 19 adopted and 17 defeated votes. June 18 was the latest vote date in those indexes. The later Journals cover parliamentary decisions through November 19. See the chamber reconciliation below.

| 45-1 collection | Toronto observation on Nov 23 | Latest indexed record date | SHA-256 of normalized editions |
| --- | --- | --- | --- |
| LEGISinfo bills | 10:10:42 PM EST | 2026-11-23 | `6e32b200a977fe8930c4c2184ccd6d4cf76593216615fec242c42e4244b20d60` |
| House divisions | 10:10:39 PM EST | 2026-11-23 | `a65d1c64025c1f53c7e39379371bb8822c2488ba581fa7737650d7a49384f21d` |
| Senate standing votes | 10:13:17 PM EST | 2026-06-18 | `4a2a6a7bb8937c17bc82472f06c3774032c8bb5f07e4f2a7bea92cfb7b559573` |

The three inventories retained ten official source files. Each archived original passed its SHA-256 and byte-length checks. The same packets replayed with unchanged content revisions. Authenticated Worker requests retrieved each collection in both languages from the materialized database.

For example, division 198 records an adopted motion to proceed to Orders of the Day, with 166 yeas, 150 nays and 12 paired members. [House division 198 in English](https://www.ourcommons.ca/Members/en/votes/45/1/198) · [Division 198 in French](https://www.ourcommons.ca/deputes/fr/votes/45/1/198)

## Chamber reconciliation

The November 23 local 45-1 intake found **180 House Journal entries** in each language, including ten lettered entries during adjournments, and **104 Senate Journal issues** in each language. Every indexed edition was available. House sitting 170 is dated November 23. Senate issue 104 is dated November 19. All 198 House divisions have a cited link from the House Journal in both languages. For example, sitting 170 links divisions 197 and 198. [House sitting 170](https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-170/journals) · [Senate issue 104](https://sencanada.ca/en/content/sen/chamber/451/journals/104jr_2026-11-19-e)

| Local 45-1 collection | Records per language | English passages or positions | French passages or positions |
| --- | ---: | ---: | ---: |
| House Journals | 180 | 9,354 | 9,357 |
| Senate Journals | 104 | 15,635 | 15,958 |
| House roll calls | 198 | 66,517 | 66,517 |
| Senate roll calls, including one Journal-only vote | 37 | 2,673 | 2,673 |

The four source operators retained 1,039 source responses. The archived bytes matched their recorded lengths and SHA-256 hashes. Replaying the seven serving inventories preserved every content revision. SQLite passed its integrity check. Authenticated Worker requests returned the French Journal link to House division 198, its overlapping yea and pairing record, and the six yeas in Senate vote `j16-3` in both languages.

The Senate published 18 Journal issues after the June 18 standing-vote cutoff. Issue 102 records adoption on division of the committee report on S-216. It gives no individual votes for that decision. Search Journal passages for the disposition and read the adjacent entries for the motion and mover. A member’s voting history covers recorded votes. [Senate issue 102](https://sencanada.ca/en/content/sen/chamber/451/journals/102jr_2026-11-17-e) · [Senate standing votes](https://sencanada.ca/en/in-the-chamber/votes/45-1)

The session-wide comparison matches the date and yeas, nays and abstentions of all 36 indexed standing votes in each language. The June 18 positive control matches all five indexed votes. The Journals also contain an additional recorded amendment vote on June 26, 2025, with 6 yeas, 67 nays and 7 abstentions. It is the third roll call in issue 16. An index-only voting history misses these 80 positions. [Issue 16 in English](https://sencanada.ca/en/content/sen/chamber/451/journals/016jr_2025-06-26-e) · [Fascicule 16 en français](https://sencanada.ca/fr/content/sen/chamber/451/journals/016jr_2025-06-26-f)

Reproduce the comparison from the two captured inventories. The report checks named-vote tally blocks by date and language and lists differences for review. Exit code 1 identifies a difference between the publisher’s two source inventories, including a Journal-only vote covered by the supplemental intake.

```sh
p=data/corpus/parliament-intake
python3 -B scripts/reconcile-parliament-senate-journals.py --journals "$p/senate-journals.json" --votes "$p/senate-votes.json" --cutoff 2026-06-18 --positive-control 2026-06-18
```
