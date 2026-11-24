# Federal funding programs

The funding API lets a policy analyst look up the actual terms of a federal call in English or French. It covers the NSERC College and Community Innovation (CCI) opportunity series and ESDC’s catalogue for jobs, skills and community projects. Each source is inventoried in both languages, including closed calls still on the current listings. NSERC’s separate archive filter is outside the forward intake. Award recipients, appropriations and historical calls that had disappeared before the first observation are outside these inventories. [NSERC English index](https://nserc-crsng.canada.ca/en/funding/funding-opportunity?field_program_type_unique%5B891%5D=891) · [NSERC French index](https://nserc-crsng.canada.ca/fr/financement/possibilite-de-financement?field_program_type_unique%5B891%5D=891) · [ESDC English index](https://www.canada.ca/en/employment-social-development/services/funding/programs.html) · [ESDC French index](https://www.canada.ca/fr/emploi-developpement-social/services/financement/programmes.html)

## Read the API

| GET | Parameters | Result |
| --- | --- | --- |
| `/api/funding-programs` | Required `source=nserc\|esdc` and `language=en\|fr`. Optional `query`, `status`, `limit`, `offset`, `revision` | Current editions with ID, title, status, availability, snippet and citation |
| `/api/funding-programs/{id}` | Required `language` | Current edition with cited sections, or `item: null` for an absent edition in a loaded catalogue |
| `/api/funding-programs/{id}/versions` | Required `language`. Optional `limit`, `offset`, `revision` | Observed editions, newest first. A removal retains the last published terms |
| `/api/funding-programs/coverage` | Required `source` | Observation time, revision, official indexes, edition counts per language, and individual coverage gaps |
| `/api/funding-programs/openapi.json` | Public | OpenAPI 3.1 with request, response and error schemas |

The public contract is available even when the preview is disabled. Data routes require a workspace bearer key with `civicsignal.retrieve`. Each successful data request uses one retrieval. Set `FUNDING_PREVIEW=on` and bind the populated local D1 database as `CIVIC_DB`. A separate `AUTH_DB` can hold workspace keys and billing settings. An authenticated request for a disabled preview or an unpublished source returns HTTP 501. The Worker serves the observed local catalogue without making publisher requests.

Search matches literal text in the selected language, ignoring case and accents. Search for a program title or a phrase used by the publisher. Read the exact edition to inspect its eligibility conditions, amounts, deadlines and partnership requirements together. Use the returned ID, including the publisher prefix, for related lookups. ESDC sometimes sends several calls to the same page. The intake preserves distinct catalogue entries and pairs languages only when publisher links identify a unique counterpart. An English or French result may therefore lack a verified counterpart. See `gaps` in the coverage response for the relevant language and identifier.

Status filters accept `open`, `closed`, `ongoing`, `upcoming`, `invitation-only` and `unknown`. Read `statusText` for the source’s wording, and the cited sections for dated exceptions. A metadata-only result can still match a catalogue title or description. Its presence alone cannot establish detailed eligibility. Browse and history default to 25 records and accept up to 100. Send `nextOffset` as `offset` with the response’s `revision` when paging. Restart at offset zero if the revision changes.

## Acquire, refresh and serve

Run from the repository root with Python 3, curl and the project’s pinned Bun. Use a fresh database to reproduce the first observation, or supply an existing **local** CivicSignal serving database to update the funding tables alongside its other corpora.

```sh
p=data/corpus/funding
python3 -B scripts/funding-nserc.py --output "$p/nserc.json"
python3 -B scripts/funding-esdc.py --output "$p/esdc.json"
bun scripts/materialize-funding.ts "$p/catalogue.sqlite" "$p/nserc.json" "$p/esdc.json"
```

Run the same commands for the next observation. Successful responses are archived by SHA-256 under `sources/objects` beside the packets. Each source keeps its own URL validators and immutable successful inventories under `sources/inventories/{source}`. An interrupted operator can reuse the validated originals on its next run. A failed acquisition leaves the previous packet available. An operator can replay any archived packet by passing its path to the materializer. To rebuild history, replay the accepted acquisition packets in observation order per source. Each packet identifies its source indexes and archived originals.

Publication is transactional per catalogue. Changed terms, new calls and removals produce edition history. A call can reappear after removal. An unchanged observation advances the catalogue cutoff and preserves the existing edition revisions. A removal records when the publisher listing disappeared from the observed inventory. Closure normally appears as a change of application status. The observed timestamp records when CivicSignal checked the source. Use a stated publisher date to determine when terms took effect. Hosted publication and refresh scheduling remain release work under D-08.

## Observed coverage

The November 23–24 Toronto intake reconciled both NSERC editions to the five calls reported by its current CCI filter. ESDC’s two independent catalogues each listed 98 calls. Counts below are language editions.

| Source | English listings | French listings | English with program terms | French with program terms | Verified bilingual pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| NSERC CCI | 5 | 5 | 5 | 5 | 5 |
| ESDC | 98 | 98 | 86 | 84 | 83 |

ESDC has 26 metadata-only editions. Eighteen share a detail page with another call in the same language. For example, New Horizons listings advertise different $25,000 and $50,000 limits at one destination. Each API record keeps its own catalogue terms, and the coverage report flags the shared page. For the other eight editions, six linked pages returned HTTP 404, one listing linked to an external preview host, and one French listing led to English content without a verified French detail page. Thirty catalogue editions have no unique cross-language match. Multiple calls can share a destination, and the two indexes sometimes link to different pages. All 196 listings remain queryable. Use the coverage response to inspect the affected identifiers and citations.

The accepted cutoffs were November 23 at 11:57 p.m. Toronto time for NSERC and November 24 at 12:08 a.m. for ESDC. Their receipts reference 12 and 416 source URLs respectively. Every captured section resolves to an archived source URL with verified bytes and SHA-256. Applying the last observation to each preceding inventory with the same parser produced zero added, changed or removed editions. Both policy checks passed through the authenticated Worker on the final database. The two catalogues cover application opportunities. A funding award, appropriation or change in apprenticeship wait times needs its own evidence.

## Verify the policy questions

The May 2026 Polytechnics Canada submission to the House finance committee lists both recommendations on PDF page 2. The local committee search returns that page’s location and official citation in each language. The funding API supplies the published federal terms for comparison. [English submission](https://www.ourcommons.ca/Content/Committee/451/FINA/Brief/BR14118467/br-external/PolytechnicsCanada-e.pdf) · [French submission](https://www.ourcommons.ca/Content/Committee/451/FINA/Brief/BR14118467/br-external/PolytechnicsCanada-067-260526-056-f.pdf)

| Recommendation | Queries against the funding API | What the federal source establishes |
| --- | --- | --- |
| Invest $100 million annually in applied AI research grants | Search `source=nserc` for `Applied Research and Development` in English and `recherche et développement appliquée` in French | The ARD grant supports eligible colleges, including polytechnics, working with partners. Its limit is $150,000 per year for up to three years per project. The grant is relevant to applied research. Its terms do not confirm a dedicated $100 million annual AI stream. [NSERC grant terms](https://nserc-crsng.canada.ca/en/funding-opportunity/applied-research-and-development-grants) |
| Eliminate apprentice waitlists by expanding capacity at the largest trainers | Search `source=esdc` for `infrastructure expansion` in English and `expansion des infrastructures` in French | ESDC’s union training infrastructure call funds added training capacity. Eligible applicants include Red Seal unions and organizations managing their training trust funds. The call closed November 12, 2026. Its published limits were $3 million for renovations and $10 million for expansion or construction. These terms do not establish that all large polytechnics qualify or that waitlists fell. [ESDC program terms](https://www.canada.ca/en/employment-social-development/services/funding/utip-infrastructure-expansion.html) |

For the original recommendations, use either of these authenticated searches. Both return the Polytechnics Canada submission and a page citation. Third-party briefs follow the committee API’s citation-only delivery policy.

```http
GET /api/committees/search?session=45-1&committeeId=house-fina&kind=brief&language=en&query=apprentice%20waitlists
GET /api/committees/search?session=45-1&committeeId=house-fina&kind=brief&language=fr&query=100%20millions%20artificielle%20appliqu%C3%A9e
```

To reproduce the bilingual acceptance check against acquired data, export `CIVICSIGNAL_COMMITTEES_D1` with the path to the 45-1 committee serving SQLite file. The test issues authenticated Worker requests against both databases. The fixture suites run independently of government sites.

```sh
python3 -B -m unittest discover -s test -p 'test_funding_*.py'
bun run test test/materialize-funding.test.ts test/funding-api.test.ts
CIVICSIGNAL_WORKERD_TESTS=1 bun run test test/funding-workerd.test.ts
CIVICSIGNAL_FUNDING_SQLITE=data/corpus/funding/catalogue.sqlite bun run test test/endpoints.test.ts -t 'Polytechnics Canada funding recommendations'
```
