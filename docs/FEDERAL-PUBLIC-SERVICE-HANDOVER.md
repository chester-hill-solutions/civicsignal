# Federal public service corpus engineering handover

**Start here.** Build a local, reproducible census of federal public service publishers and their series. In parallel, implement the first departmental reads against frozen evidence. The first integrated build should answer a bilingual research question against a reconciled collection and account for everything its publisher listed. Scale by publication system and format across the whole federal roster. The [master plan](PLAN.md#federal-public-service-corpus-scope) defines the eight record families and the federal completion criteria.

## Inputs ready for engineering

| Artifact | What it establishes | First engineering use |
| --- | --- | --- |
| [Bilingual schedule roster](evidence/2026-11-23/federal-public-service-roster.csv) | 110 schedule entries, with English and French legal names, annotations, law consolidation date and source URL. Schedule I has 23 entries, IV has 61, and V has 26. | Reproduce from the consolidated Act, resolve institutional identities and attach dated publisher names. |
| [Publisher name crosswalk](evidence/2026-11-23/federal-public-service-publisher-names.csv) | 89 Public Service Commission name mappings cover 88 schedule entries. The shared Information and Privacy Commissioners entry has two separately identified offices. Three entries carry an explicit inactive note. | Resolve publishers by cited legal name, retain the published organization code, and distinguish one-to-many mappings. A blank inactive field indicates no explicit inactive note was captured. |
| [Source series register](evidence/2026-11-23/federal-public-service-sources.csv) | 18 named entry points covering all eight families and the cross-government publications catalogue. Each row records the acquisition method, evidence state and first check. | Import as discovery seeds. Capture each index or data dictionary in the intended acquisition environment before reporting live coverage. |
| [Bilingual acceptance cases](evidence/2026-11-23/federal-public-service-cases.json) | Paired research questions, primary sources, expected evidence and failure conditions for real records. | Turn into handler-level assertions against local materialized data. Keep deterministic fixtures for publisher changes and failure paths. |

**Roster provenance.** On November 23, 2026 the three Justice pages reviewed carried the same consolidation date, October 29, 2026. The CSV keeps schedule order and both names from each entry. CBSA appears twice in Schedule IV with different legislative annotations, yielding 109 distinct English legal-name strings. A schedule may name part of an organization. The ordinal identifies a row in this snapshot only. [Schedule I](https://laws-lois.justice.gc.ca/eng/acts/f-11/page-19.html) · [Schedule IV](https://laws-lois.justice.gc.ca/eng/acts/f-11/page-23.html) · [Schedule V](https://laws-lois.justice.gc.ca/eng/acts/f-11/page-24.html)

The Treasury Board comparison column contains 41 schedule entries whose English names matched a row in its 2015–2026 departmental population table after case and apostrophe normalization. Another 37 entries match through the Commission’s explicit legal-title mapping, for a total of 78. The other 32 require further reconciliation, including agencies for which the payroll table omits data. Use the Federal Identity Program’s legal and applied titles, dated departmental publications and organization history to resolve them. Preserve separate mappings for the Treasury Board and its Secretariat, and for a department, an agency, and a unit publishing on their behalf. [Population table and exclusions](https://www.canada.ca/en/treasury-board-secretariat/services/innovation/human-resources-statistics/population-federal-public-service-department.html) · [Commission reference list](https://www.canada.ca/en/public-service-commission/services/public-service-hiring-guides/information-staffing-obligations/reference-list-organizations.html) · [Official title register and dictionary](https://open.canada.ca/data/en/dataset/83320390-7715-43bc-a281-2049bf5d4232)

## Work to assign

Run the [offline census preparation tool](evidence/2026-11-23/prepare-public-service-census.py) from the repository root. Its default mode checks the dated inputs, counts and references. With `--matrix` it writes a starter CSV to standard output, one row per provisional statutory name and family. Of 872 cells, seven have a dated record and publisher evidence from ECCC, IRCC or CFIA. The other 865 are unexamined. A located series starts discovery for its cell. A source owner must still enumerate the institution’s other series and record history and cutoff. Keep the dated inputs with the receipt when fresh schedules or agency indexes change.

```sh
python3 -B docs/evidence/2026-11-23/prepare-public-service-census.py
python3 -B docs/evidence/2026-11-23/prepare-public-service-census.py --matrix > /tmp/civicsignal-public-service-census.csv
```

| Package and owner role | Depends on | Deliverable and review evidence |
| --- | --- | --- |
| 1. Roster and publisher identity — acquisition | Dated legal roster | Snapshot the Justice XML and title register, preserve hashes, reproduce the three schedules, map verified aliases and relationships, and list unresolved rows. Demonstrate the CBSA duplicate and a statutory portion of an office. Admit historical predecessors with dated evidence. |
| 2. Institution and series census — acquisition | 1 for institution IDs | For each institution examine its official publications and transparency indexes, departmental plans, the central catalogue and portal. Record a disposition for all eight families. Produce a dated CSV or JSON manifest with evidence URLs, earliest/latest periods, languages, format, refresh signal, source terms and remaining work. One institution can have many series within a family. Pilot seeds supply entry points. |
| 3. Archive, extract and index — corpus storage | Agreed IDs and a manifest for any series | Build resumable downloads and content-addressed originals, section/page/table extraction, structured-row ingestion, version history and a local search index. Publish per-edition dispositions. Start with the four ECCC indexes, then IRCC guidance, briefing and nil CSVs, and Treasury Board instruments as source access permits. |
| 4. Contracts and serving — Worker API | Contract agreement with 1–3; frozen fixtures suffice to start | Implement the operations below with typed request and response schemas, OpenAPI examples and authenticated entry-point tests. Use a local D1 candidate for integrated retrieval. Exercise failure before promotion and verify that the prior candidate still serves. |
| 5. Roll out by source family — source owners | 2 and the relevant adapters in 3 | Backfill the complete indexed history of each manifest series. Begin with reusable central bulk sources, then common departmental templates and exceptional formats. Capture science, operating guidance, workforce management, funding, regulation and oversight series even when a document exists only as a catalogue entry. Publish actual history and outstanding IDs per series. |
| 6. Verification and hosted readiness — integration | 3–5 per collection | Run bilingual corpus queries and refresh/rollback tests, publish the coverage and resource receipt, register per-source output rights and assign an operator. Admit hosted collections individually through D-08. Keep local integration moving for collections with pending hosted decisions. |

## Identity, storage and refresh

| Record | Identity and required evidence |
| --- | --- |
| Institution / office / program | Stable internal ID, dated external IDs and names in each published language, parent or successor relation with a cited source. Keep the issuer, host, author, accountable office and reviewer as distinct roles. |
| Series / inventory appearance | Publisher, official root and source key, declared collection boundary, snapshot and raw entry. Use fiscal period, source reference and discovery path as supplied. Two indexes may point to one work. |
| Work / edition / component | Publisher identifier if available, otherwise a persistent local mapping with recorded URL aliases. One work can have independent EN/FR editions, a joint bilingual edition, summaries, annexes and later reports. Require an official counterpart link, catalogue relationship or reviewed evidence to merge identities. |
| Original / observation / version | Store raw bytes by SHA-256, request and final URL, retrieval time, media type and source response. Preserve changed bytes and prior versions. A new URL, a disappeared index link and a formal withdrawal are different observations. Track effective date, publication date and first observation separately, including partial or unknown dates. |
| Passage / structured record / relationship | Each hit identifies the edition and version and cites an HTML heading, PDF page, table row and column, or bulk resource and record key. Keep label, unit, period and value together. A relationship has a type, direction and source locator. Metadata-only records support discovery. A claim about document contents requires text or row evidence. |

For census cells use `unexamined`, `series-found`, `no-series-found-in-checked-sources` or `discovery-blocked`, with the date and sources checked. For materialization count discovered editions, retained originals, searchable editions, metadata-only entries, confirmed publisher gaps and retryable failures. Counts can overlap across stages. Return the denominator and its unit for each count. A nil-report row is positive evidence for its institution and reporting period. An absent bulk row is ambiguous.

Take the manifest and its source snapshots before extraction. Write a document and its passages atomically. A partial or failed index walk cannot establish removal. Recheck missing entries after a complete walk, record the observation and retain the prior material. Publish a verified candidate generation and cursor boundary together. Unchanged input must leave identity, content versions and feed events stable. OCR and historical recovery can advance individual availability states in later generations.

## Proposed HTTP contract

Paths below are engineering targets. Reconcile names with existing organization and source-feed routes before freezing the contract. Use `/api/departmental-publications` as the publication resource.

| Operation | Request and expected response |
| --- | --- |
| Enumerate scope | Use the organization directory for institutions and offices. Add paginated series and programs with institution, family and observation cutoff. Return a stable ID and official evidence per result. |
| Search | `GET /api/departmental-publications?query=...&language=fr` with optional institution, program, series, kind, fiscal year, as-of date, limit and cursor. Return hit kind, work/edition/version IDs, evidence, date basis and the coverage generation. |
| Retrieve and trace | `GET /api/departmental-publications/{id}?language=en` returns the work, selected edition and availability, components, originals and cited relationships. `/{id}/versions` returns dated observations and publisher-effective intervals when established. Paginate long lists and passage reads. |
| Inspect coverage | `GET /api/departmental-publications/coverage` returns the scope, inventory cutoff, generation, discovery and materialization counts by series/edition and pageable unresolved items with reasons and retry status. |
| Observe changes | `GET /api/departmental-publications/changes` returns additions, corrections and removals within the declared series/edition scope. Return before/after evidence and distinguish source withdrawal from removal of a listing. Bind cursors to the scope and handle stale cursors explicitly. |

Reserve literal paths such as `coverage`, `changes` and `openapi.json` before matching IDs. Test an authenticated empty result, absent edition, disabled corpus, unavailable database, malformed cursor, cursor reused with different filters and exact lookup after correction. Follow the Worker's established error, authorization and usage conventions. Preserve citation language on every result.

## Repository integration

| Existing component | What to reuse or adapt |
| --- | --- |
| [Committee downloads](../scripts/lib/committee_files.py) | Content-addressed gzip objects, hash verification and checkpoints. Its approved hosts and inventory shape are parliamentary. Give departmental sources their own official-host policy, including redirect targets and linked official repositories. |
| [Written-questions materializer](../scripts/materialize-written-questions.ts) and [local serving guide](WRITTEN-QUESTIONS-PREVIEW.md) | Candidate staging, FTS checks, transactional publication and the established `cf` CLI. Keep large original files out of D1. Use a dedicated local state path and account for peak disk while building. |
| [Worker router](../src/index.ts), [contract](../src/routes/written-questions-contract.ts) and [OpenAPI builder](../src/routes/written-questions-openapi.ts) | Register typed schemas and real handler paths together. Reuse workspace auth, capability checks and metering. Adapt passage retrieval to retain page, section and table context. |
| [Source feed](../src/corpora/source-feed.ts) and [feed contract](../src/routes/source-feed-contract.ts) | Existing feeds have a closed source union and chamber/Gazette-specific edition assumptions. Reuse pagination and replay behavior where compatible. Add a departmental scope and regression-test existing feeds. |

Existing regression checks from the repository root:

```sh
python3 -B -m unittest discover -s test -p 'test_wq_store.py'
bun run test test/materialize-written-questions.test.ts test/written-questions-api.test.ts
bun run validate
```

Add source-specific parser, store, refresh and endpoint tests in their implementation packages. Live source reconciliation is separate from deterministic CI. Record the source cutoff, code revision, schema version and actual command results with the materialized candidate.

## Release receipt and unresolved work

For each generation, report roster and series cutoffs, published and observed periods, EN/FR counts at each stage, deduplicated bytes, searchable characters/pages, peak disk, D1 index size, request/retry counts, elapsed acquisition and refresh time, change counts, previous generation and restoration result. Include exact unresolved IDs and a reason. A second identical run, an interrupted run, and a changed fixture must all have predictable results. Run paired acceptance queries through authenticated handlers and save the returned IDs and locators.

The first operator run must establish central policy-index access, retrieve both briefing CSVs and the schema, reconcile the dated bulk publications export to subsequent weekly lists, and measure at least one complex table and one image-only publication. Assign each issue to its source adapter. Pending alias mappings, scanned documents, source rights and unverified series should remain visible in coverage. Use measured publisher-template counts and resource receipts to size the nationwide backfill. The [licence register](LICENCE-REGISTER.md) governs source-specific hosted output decisions.
