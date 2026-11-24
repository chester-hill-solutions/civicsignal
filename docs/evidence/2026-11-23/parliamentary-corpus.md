# Parliamentary corpus, November 23, 2026

## House written questions

The House catalogue lists 16 sessions from 37-1 through 45-1. For 45-1, all 86 result pages in each language yielded 1,709 distinct question numbers. The English and French identifier sets agree, and page 86 contains nine questions in each language. The overview identified November 20 as the latest answer date at the time of acquisition. [House catalogue](https://www.ourcommons.ca/written-questions/questions) · [Overview](https://www.ourcommons.ca/written-questions/overview) · [Publisher's coverage notes](https://www.ourcommons.ca/written-questions/about)

| Measure | English | French |
| --- | ---: | ---: |
| Published questions acquired | 1,709 | 1,709 |
| Publisher status of answered | 1,519 | 1,519 |
| Publisher status of awaiting response | 184 | 184 |
| Publisher status of withdrawn | 6 | 6 |
| Published response references | 1,523 | 1,523 |
| Answered questions with searchable reply material | 1,518 | 1,518 |

- Q-1 links to a tabled paper. The Library of Parliament supplies one bilingual PDF, stored once by hash and cited from both editions. Searchable PDF text retains its publication languages. [House record](https://www.ourcommons.ca/written-questions/45-1/q-1) · [Library PDF](https://na01.alma.exlibrisgroup.com/view/delivery/01CALP_INST/12177592950002616/13177592940002616)
- Q-3 links to Hansard. The importer indexes the answer within that sitting and keeps the official citation. [English sitting](https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-21/hansard) · [French sitting](https://www.noscommunes.ca/DocumentViewer/fr/45-1/chambre/seance-21/debats)
- Q-1010 tests whether a search can retrieve Indigenous Services’ response, including the table, in each language. Cover pages have their own document kind. [English response](https://www.ourcommons.ca/written-questions/45-1/q-1010/14112405) · [French response](https://www.ourcommons.ca/questions-ecrites/45-1/q-1010/14112405)
- Q-105 was answered. The Library record matching its title and paper number, MMS 99665539002616, returned HTTP 404 for its digital file manifest. The catalogue citation is available for follow-up. [House record](https://www.ourcommons.ca/written-questions/45-1/q-105) · [Library holdings](https://parl-gc.primo.exlibrisgroup.com/discovery/fulldisplay?docid=alma99665539002616&vid=01CALP_INST:01CALP)
- Q-338 has searchable departmental responses. A PrairiesCan spreadsheet linked from the published material returned HTTP 404. The attachment retains its URL and the edition retains a partial acquisition status. [House response](https://www.ourcommons.ca/written-questions/45-1/q-338/13716811)

## Resume and refresh checks

The repeat catalogue run walked all 86 pages in each language and reused all 3,418 previously acquired question detail records. Both lists matched the publisher's reported total. Reapplying that inventory produced zero catalogue changes. A full reply refresh revisited all 3,418 editions. Two subsequent live rechecks of Q-1 and Q-1010 each fetched four editions. Their second pass left the change journal at the same sequence. All 15,709 referenced original objects matched their SHA-256 hashes.

Each language edition has 1,240 modern viewer response references, 195 tabled-paper references and 88 responses published in Hansard. The index contains 5,586 searchable reply documents or fragments in each edition, plus cover pages. Source-linked annexes are edition-specific. The English records have five searchable linked attachments and the French records have ten. Each language also records Q-338’s unavailable workbook.

## Written-questions API verification

The local D1 serving database contains 3,418 question editions and 13,669 document records. Its 56,138 document chunks and the question texts yield 59,556 indexed passages. The materializer reconciled counts and text lengths against the acquired SQLite source (`09bb13cd898bb7e1718a5fde70cce03fda9fb94994518945dc02151e1d575771`). The English search for “drinking water advisories” returned Q-1010.

Seven authenticated requests through the Worker verified Q-1's Library attribution, the French departmental reply to Q-1010, a budget annex linked from Q-1204, French reply search, both editions' coverage, and lookup and pagination of Q-280's tabled paper. The seven requests consumed seven units. A separate test verified rejection of an unauthenticated lookup. This run used the isolated local database. [API and replay instructions](../../WRITTEN-QUESTIONS-PREVIEW.md)

## Committees and submissions

The acquisition walked the public English and French directories for session 45-1. The House and joint directory has 61 entries per language and the Senate directory has 29. These totals include subcommittees. Four joint committees appear in both directories and point to shared parliamentary publications. [House directory](https://www.ourcommons.ca/Committees/en/List?parl=45&session=1) · [Senate directory](https://sencanada.ca/en/committees/)

| Indexed publication links | English | French |
| --- | ---: | ---: |
| House and joint study URLs | 666 | 666 |
| House and joint submission file URLs | 4,803 | 4,803 |
| Senate submission file URLs | 1,709 | 1,709 |

These are distinct URLs within each collection and edition. A bilingual file can have the same URL in both editions. The Senate lists correspondence and exhibits alongside briefs. Each indexed submission points to its publication context and identifies the submitting party where given. The House PROC meeting index linked to study activity 13086260, labelled committee business, whose study page returned HTTP 404 in both languages. The meeting links remain in the catalogue. [Senate publication practice](https://sencanada.ca/en/committees/SOCI/briefs/45-1) · [House PROC meeting index](https://www.ourcommons.ca/Committees/en/PROC/Meetings?parl=45&session=1)

These discovery counts formed the input to the 45-1 session backfill. Its Worker exposes attributed search, committee, study, meeting and document lookups, passage pagination and coverage. The freshwater study preview has a separate route. [Session API and replay guide](../../COMMITTEES-API.md)

## Reconciled session coverage

The local session snapshot closed at **19:07:12 Eastern on November 23**, or `2026-11-24T00:07:12Z`. The two chambers list four joint bodies in common. Deduplication yields 86 committees and subcommittees, each with an English and a French record. The walk covered 244 House and joint work and meeting indexes, 1,332 study pages, 200 Senate indexes and 3,108 Senate notice pages. The Senate listings yielded 1,716 distinct submission URLs in each edition, seven above the initial inventory. The House and joint total held at 4,803 per edition. The Senate study pages supplied 238 contextual links to orders of reference.

| Serving measure | English | French | Total |
| --- | ---: | ---: | ---: |
| Current records, including cited gaps | 16,496 | 16,496 | 32,992 |
| Records with searchable text | 13,291 | 13,344 | 26,635 |
| Indexed passages | 874,776 | 880,860 | 1,755,636 |

The current records include 1,648 study editions, 4,436 meeting editions, 3,406 evidence editions, 13,038 written submission editions, 730 reports and 210 government responses. Every written submission has a published study association. A Senate brief can cite an order missing from the separate study index. The importer keeps that association and follows the cited order. The database retains 88,728 relationships, 481 earlier records absent from the reconciled inventory and 391 superseded identifiers.

Three current records returned HTTP 404: both editions of PROC study 13086260 and the French minutes of SECU meeting 12. Another 98 records have stored originals without searchable text. Of these, 89 are image-only PDFs. Eight cited Senate order URLs and one French minutes URL returned HTML without a publication body. The separately published French RIDR meeting 13 minutes are searchable. Individual IDs and official citations can be retrieved through the coverage and document endpoints. [SECU French minutes](https://www.ourcommons.ca/DocumentViewer/fr/45-1/SECU/reunion-12/proces-verbal) · [RIDR French minutes](https://sencanada.ca/fr/content/sen/committee/451/ridr/13mn-57568con-f)

The download resumed after interruption and all 29,416 distinct archived originals passed SHA-256 and byte-length verification. The coverage receipt has zero pending records. An unchanged rebuild extracted zero publications, kept all passage and relationship counts stable, and added zero record or relationship events. The code also exercises corrections, late editions, removals and a failed D1 refresh against fixtures. [API, coverage filters and rebuild commands](../../COMMITTEES-API.md)

The isolated Cloudflare D1 candidate matched the acquisition store on all 33,864 retained record rows, all 88,728 relationship rows and all 1,755,636 passage rows. The passage fingerprint was `6abed42f028a2a8375b32a42b7ad1f8ee655dea9f2cc0375474bca536652e43f`, covering 565,239,803 text characters plus passage keys, locations and speakers. FTS5 passed its integrity check. The authenticated Worker integration made 12 successful metered reads against that file, including traversal from the SOCI brief to its S-5 study. The full repository suite passed 2,490 tests with two opt-in tests skipped. The separate committee integration passed both tests, and all 46 Python committee tests passed.

The `cf` CLI applied the local D1 migration. Its local explorer returned 404 for `cf d1 query --local`, reporting that this operation has no local equivalent in the installed version. Row verification used the local D1 file and the authenticated Worker handler. Hosted D1 was outside this run.

## What the committee API retrieved

| Request against the acquired 45-1 collection | Observed result |
| --- | --- |
| Search House ENVI evidence for `water` in English | Returned Dr. Amil Shapka at passage 109 of meeting 54. [English evidence](https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-54/evidence) |
| Search the same committee for `eau` in French | Returned Wade Grant at passage 86 of meeting 4. [French evidence](https://www.ourcommons.ca/DocumentViewer/fr/45-1/ENVI/reunion-4/temoignages) |
| Open joint REGS meeting 1 in each edition | The originals have 112 ordered passages per language. Both begin with joint clerk Melissa Doyle. [English evidence](https://www.parl.ca/DocumentViewer/en/45-1/REGS/meeting-1/evidence) · [French evidence](https://www.parl.ca/DocumentViewer/fr/45-1/REGS/reunion-1/temoignages) |
| Open the SOCI S-5 brief from the Digital Research Alliance of Canada | Credited organization, original PDF and successive passage locations are retrievable. The API withholds third-party body text. [Senate brief](https://sencanada.ca/Content/Sen/Committee/451/SOCI/briefs/2025-03-25_SOCI_S-5_Brief_DRAC_b.pdf) |
| Follow ENVI report 2 to its response | The published edge resolves to `house-envi-government-response-8512-451-66`. [House response](https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/report-2/response-8512-451-66) |
| Look up the French SECU meeting 12 minutes | Returns a cited record with `status=unavailable`, the observed HTTP 404 and the check time. [House minutes](https://www.ourcommons.ca/DocumentViewer/fr/45-1/SECU/reunion-12/proces-verbal) |

Two live file rechecks retained their original SHA-256 hashes. The SOCI brief matched `a5087caa1fe18f7b67552824256a9a38bf97b7812217039782e749c577eea23c`. The English FINA brief BR13581575 matched `d8a36d99c86f3f9d824f5e36ec6b5305d539e727e44bba5e80f49f7e18b0a2d8` after URL-encoding a literal number sign in its published filename. The record retains Parliament’s listed URL. [FINA original](https://www.ourcommons.ca/Content/Committee/451/FINA/Brief/BR13581575/br-external/MedecinsDuQuebecContreLeGenocideAGaza-%23067-250807-003-e.pdf)

## Historical archive inventory

The host uses three disks. Its USB boot volume holds the checkout, the SATA volume at `/mnt/corpus` holds the committee archive, and the internal NVMe at `/mnt/scratch` holds the training outputs. The NVMe provenance ledger has 20,266 records with fields for text path, checksum, source, retrieval date and licence. Field completeness still needs a per-record check. Its 64k-tokenizer shard manifest has 769,693 entries. Four filenames contained the letters “geds”; all four belonged to unrelated documents. Neither inspected manifest identified a GEDS directory export.

The archive host's `gpt-from-scratch` checkout and the GitHub `master` branch both resolved to `3900d593c1a650772533794879e5775ddd9de569`. The host also had local changes to the restore and acquisition code. The linked committee directory occupied 2.0 GiB and contained 10,464 manifest rows across 11 sessions. The manifests cover 39-1, 39-2, 40-1, 40-2, 40-3, 41-1, 42-1, 43-1, 43-2, 44-1 and 45-1. Session 41-2 had no manifest in this directory. [GitHub code revision](https://github.com/wra-sol/gpt-from-scratch/tree/3900d593c1a650772533794879e5775ddd9de569)

Session 44-1 has 2,149 manifest rows. Sampled records identify Parliament, session, committee acronym, meeting number and the House evidence publication ID. The session text directory contains English and French files and per-committee statistics. Use those identifiers to reconcile the official listings before counting bilingual coverage. The separate government-response collection contains a 22-row fetch ledger. This inspection checked the directory and manifest inventory only.

### Archive sources mapped to the remaining backend work

**House committee backfill.** The 45-1 archive manifest contained 701 distinct committee/meeting pairs and 701 distinct evidence IDs. A read-only join using session, committee acronym and meeting number found a searchable English and French evidence record for every pair in the local CivicSignal database. This tests the lookup key on a known session. It establishes neither byte equivalence nor the completeness of an older session. Start the historical run with all 2,149 rows of 44-1 and independently enumerate the House catalogue to find omissions on either side.

| Planned work | Observed archive material | How to use it |
| --- | --- | --- |
| Canada Gazette | The Part II ledger in `browserfetch/gazette-p2` has 9,017 rows, 4,656 English and 4,361 French. Sampled fields include official source URL, edition, issue date, instrument number and local text filename. A separate issue ledger lists 791 distinct Part I dates and 393 Part II dates. | Reconcile issue dates and item URLs with the publisher. Check both language editions independently. The issue ledger had entries for Parts I and II only. |
| Chamber debates | House session text and acquisition scripts are present. Senate has 20 session directories from 36-1 through 45-1, with 40 text files and 20 statistics files. The 44-1 statistics include sitting and French fetch counts. | Compare against each chamber’s calendars and use the texts to test historical retrieval. Acquire or verify edition-specific sources and turn anchors before serving citations. The archive’s top-level `journals` directory contains scholarly journals. Parliamentary Journals still require their own source. |
| Finance and costing | `browserfetch/fed-budget` has 126 distinct URL records for 2021–2025, 63 per language. The PBO ledger has 1,711 distinct URLs. It marks 1,536 successful and 175 failed. | Seed the federal budget and PBO series inventories, retaining failed URLs for recheck. Estimates, appropriations and Public Accounts require separate publisher reconciliation. |
| Departmental publications | The federal CKAN directory contains 18,246 PDF files. Its fetch ledger records 30,430 attempts with 18,326 successes. The Treasury Board policy archive has English and French text and an 824-row integer-ID ledger. | Match CKAN URLs or package IDs to items on the ECCC and other departmental indexes, then verify candidate files. Use the Treasury Board IDs to check the live current and inactive instrument inventories. Provincial auditor files have separate jurisdictional scope. |
| Statutes and regulations | The bilingual Justice XML checkout is at `a782c13dbf0c710f33d8b2adc3e42377c94d0626`, dated August 24, 2026. | Use it as a dated parser-regression input. The hosted release gates require their recorded upstream revision, serving candidate and operational checks. |

The NVMe provenance ledger has populated checksum, retrieval time and licence fields on all 20,266 rows. A source URL field is populated on 20,265. One referenced local text file matched its recorded SHA-256. These observations support finding and checking individual files. The 769,693 training-shard entries measure tokenization and do not establish counts of official publications, permission for hosted excerpts, or coverage of the official indexes.

## Replay locally

Run from the repository root with Python 3 and Poppler's `pdftotext`. The House and Senate public sites and the Library's public catalogue must be reachable.

```sh
python3 -B scripts/lib/wq_catalog.py
python3 -B scripts/written-questions.py --verify-objects
python3 -B scripts/committee-catalogue.py
bun scripts/written-questions-read.ts lookup data/corpus/written-questions/questions.sqlite 45-1 1010 fr
```

The first command compares the bilingual listings and updates their detail records. Use `--recheck-details` to discover changes inside a response inventory when its listing metadata stays the same. The second command commits each question edition independently and retries incomplete editions. Add `--recheck` to retrieve and compare previously stored reply bodies. Use `--number 1010` to bound a live recheck. The local coverage receipt lists the checked source objects and outstanding IDs. For a committee run interrupted partway, `--resume` reuses the indexes already captured. Omit it for a new snapshot. [Worker HTTP guide](../../WRITTEN-QUESTIONS-PREVIEW.md)
