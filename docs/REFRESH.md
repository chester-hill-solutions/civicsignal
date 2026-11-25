# Local intake refresh

The local collections refresh on a measured cadence. Fetches are public and local; hosted publication and scheduling remain release work under D-08.

## What runs daily

| Collection | Command | Measured (2026-11-24) |
| --- | --- | --- |
| Federal consultations | `bun run refresh:consultations` | ~5 s, 6.8 MB catalogue + schema |
| House committee calls | `bun run refresh:committee-calls` | ~30 s, 30 study pages + 8 Senate pages |
| Funding catalogues | NSERC + ESDC intake, then `materialize-funding.ts` | NSERC 9.6 s, ESDC 2 min 22 s, materialise 0.7 s |

`bun run refresh:daily` runs those three in sequence and writes one run report. Every step is independent: a failure stops that step, the rest continue, and the process exits non-zero so the scheduler surfaces it.

```sh
bun run refresh:daily
bun run refresh:daily --only consultations --report dist/refresh/one.json
```

Every invocation writes a dated report in `dist/refresh/`. Use `latest-full.json` for the most recent attempt covering all three intakes, including a failed attempt. Use `latest-successful-full.json` for the last successful full run. A selective retry updates `latest-partial.json`. The existing `latest.json` follows the latest invocation of either scope. For older reports, check the step names and whether serving verification was recorded.

The daily run checks consultations and funding in their local catalogue databases. It publishes House calls into the dedicated committee D1 database and checks the served editions against the intake. Each step records its exit status, elapsed time, acquisition summary, and serving checks. After all three pass, the daily job sends four authenticated Worker checks against those stores and records their result in `workerVerification` before publishing the full report. Use the dated report to look up an edition in the same database served by the Worker.

To verify the current consultation observation through authenticated Worker requests, point the endpoint test at the matching database and intake receipt. It checks both languages against the archived publisher files and verifies the usage charged for the requests.

```sh
CIVICSIGNAL_CONSULTATIONS_SQLITE=data/corpus/consultations/catalogue.sqlite \
CIVICSIGNAL_CONSULTATIONS_RECEIPT=dist/refresh/receipts/consultations.json \
bun run test test/endpoints.test.ts -t 'consultations through the Worker against the acquired catalogue'
```

For the committee and funding checks, set `CIVICSIGNAL_COMMITTEES_D1` to the serving database file identified in the full report. Set `CIVICSIGNAL_COMMITTEES_SOURCE_SQLITE` to the acquisition database (normally `data/corpus/committees/committee.sqlite`) and `CIVICSIGNAL_COMMITTEE_CALLS_RECEIPT` to `dist/refresh/receipts/committee-calls.json`. Set `CIVICSIGNAL_FUNDING_SQLITE` to `data/corpus/funding/catalogue.sqlite`. Its sibling `esdc.json` and `nserc.json` identify the acquired observations, and the archived copies verify the packet bytes. Run the same endpoint file with the test filter `committee calls through the Worker|Polytechnics Canada funding recommendations`.

A quiet day shows zero additions, removals and changes in each summary. A step that reports changes you did not expect is the signal to open its receipt and the collection's contract before trusting the serving data.

A lock file (`dist/refresh/lock.json`) stops two runs overlapping. A lock whose process is gone, or that is more than two hours old, is replaced.

## Scheduling on macOS

```sh
scripts/schedule/install-daily.sh     # launchd agent, daily at 06:15 local
scripts/schedule/uninstall-daily.sh   # remove it; local data stays
launchctl kickstart -k gui/$(id -u)/com.civicsignal.refresh-daily   # run now
```

The agent runs `bun scripts/refresh-daily.ts` with the repository as its working directory and appends to `~/Library/Logs/civicsignal-refresh.log`. It is a per-user agent that runs while the user is logged in. To verify the regular 06:15 Toronto event, correlate the agent's run count and exit status with the full report path in its own log, the dated report's start and finish, and the serving checks for all three intakes. A manual kickstart or a sibling job has its own evidence.

Inspect only the job status fields when troubleshooting. Launchd's full diagnostic can include inherited credentials.

```sh
launchctl print "gui/$(id -u)/com.civicsignal.refresh-daily" |
  awk '/^[[:space:]]*(state|runs|last exit code) = / { print }'
```

On Linux, use the same command from cron:

```
15 6 * * * cd /path/to/civicsignal && /path/to/bun run refresh:daily >> "$HOME/.local/state/civicsignal-refresh.log" 2>&1
```

On November 24 a temporary calendar job with the installed command, standard process priority, working directory and PATH finished the full intake in 16m 49.643s. Four authenticated Worker checks passed against the refreshed stores. The 06:15 job uses those same settings. [Calendar verification](evidence/2026-11-24/daily-calendar-refresh.json)

Capture a baseline before the regular occurrence. After it finishes, supply that baseline and the Toronto date to correlate the installed agent’s extra run, appended log, dated full report and serving checks. The verifier exits unsuccessfully if the evidence is incomplete.

```sh
python3 -B scripts/schedule/verify-daily-calendar.py > dist/refresh/calendar-before.json
python3 -B scripts/schedule/verify-daily-calendar.py --baseline dist/refresh/calendar-before.json --date 2026-11-25
```

## Weekly local refresh

The weekly per-user LaunchAgent runs on Saturdays at 09:00 local time. The daily agent continues to run at 06:15. Both acquire the same kernel lock while publishing committees. A conflicting weekly or daily committee step exits with an error and can be retried independently. The other collections continue.

```sh
python3 -B scripts/schedule/weekly.py install
python3 -B scripts/refresh-weekly.py --help
python3 -B scripts/refresh-weekly.py --status
python3 -B scripts/refresh-weekly.py --only geds
python3 -B scripts/schedule/weekly.py remove
```

Installation registers the job. It runs while the user is logged in. Removal unloads it and retains its databases and dated receipts. The installed command is `python3 -B scripts/refresh-weekly.py`. Read the dated report under `dist/refresh-weekly/` to see the command, exit status, disk headroom and serving checks for each source. A failed or skipped source makes the full run fail. A partial archive can still have successful verification of its available contents. The per-source command results retain both outcomes. `latest-full.json` records the last full attempt and `latest-successful-full.json` records the last complete success. A selective retry updates `latest-partial.json`. For an interrupted committee catalogue, `python3 -B scripts/refresh-weekly.py --only committees --resume-committee-catalogue` continues its saved acquisition and then runs the remaining publication and Worker checks. Scheduled runs begin a fresh catalogue.

| Collection | What the weekly operator does |
| --- | --- |
| Federal source register | Captures the 18 series' catalogue pages and structured resource metadata, including the original bytes and endpoint-specific failures. These are discovery receipts. |
| Departmental report directories and editions | Refreshes the federal plans and results directories, Treasury Board’s plan cycles, and both editions of the government-wide list of institutional regulatory pages. The separate `departmental-report-editions` step archives issuer landing pages, records year-labelled plan and result links, and tracks discovery links from regulators. Its current report retains the last verified content and the latest attempt for each issuer. |
| Departmental report documents | Verifies the year, language and type of directly linked report PDFs. A separate step checks 40 publisher-labelled HTML targets per weekly run and records the issuer, year, language, identity decision and source hash for each citation. |
| Institutional regulatory plans | Follows forward-plan links from the government-wide directory to issuer pages, verifies the target, and records the original, named initiatives and stated plan cycles. |
| Government publications | Checks the three dated bibliography exports and retains their publisher snapshot date. The separate `federal-publication-checklists` step captures every subsequent bilingual weekly issue, independently hashes language variants and records gaps and overlaps with the base snapshot. It builds the combined SQLite catalogue. Use `python3 -B scripts/federal-publication-catalogue.py search --id 9.843674` to retrieve a dated record and source hash. |
| CanadaBuys procurement | Archives and verifies award notices and contract history for the current fiscal year. |
| Federal institution coverage | Attributes records from the acquired collections to statutory institutions using published legal names, applied titles and bilingual aliases. Read matched and unresolved record counts for each input, plus the eight-family breakdown for each statutory institution, in `dist/refresh-weekly/federal-institutions.json`. |
| Federal statutes and regulations | Refreshes the official Justice Canada checkout, produces English and French SQL, JSONL and title files, and runs the corpus checks before switching `dist/statutes-local/current` to the verified generation. The receipt identifies the Git revision and the six file hashes. |
| Official institution titles, GC Service Inventory, grants and contributions awards, and access-request summaries | Streams the published CSV resources, validates their fields and records, and archives them by hash. Publishes a collection after all its resources pass. Use `python3 -B scripts/federal-bulk.py search service-inventory --query passport --limit 3` to read cited records locally. |
| Algorithmic impact assessments and briefing packages | Archives every result page from the five published portal collections, checks collection identity and totals, and publishes a local bilingual catalogue with the original resource links. Use `python3 -B scripts/federal-disclosures.py --lookup DATASET_ID`. |
| Treasury Board and IRCC guidance | Refreshes the bilingual active and archived Treasury Board policy indexes. Captures the original IRCC manual indexes and their four bilingual instruction and update feeds. Archives listed manuals and guidance pages, preserves the publisher’s row and target language, and replays the cited text. Use `python3 -B scripts/ircc-guidance-documents.py lookup --code 'OP 8' --language fr --query 'travailleurs autonomes'` for an edition-specific lookup. |
| Dated Treasury Board policy documents | Matches exact registered policy IDs in the official government bibliography and archives linked PDFs. A title or catalogue-language mismatch goes to review. Read `python3 -B scripts/federal-policy-editions.py lookup --policy-id 30682 --language en --query communications` for a dated source and page citation. |
| Consultation participation | Resolves linked notices for the current catalogue revision and retains source bytes, participation instructions and explicit gaps. |
| Briefing notes | Validates the official main and nil-return CSVs and schema. The source supplies briefing titles and metadata. Run `python3 -B scripts/briefing-notes.py --help` for archive replay and bilingual title search. |
| ECCC audits and evaluations | Captures the four index pages and referenced documents, then builds a separate passage database and checks the authenticated local API. Read `GET /api/departmental-publications/openapi.json`. Enable the preview with `DEPARTMENTAL_PUBLICATIONS_PREVIEW=on` and bind the completed `data/corpus/eccc/serving.sqlite` to `DEPARTMENTAL_PUBLICATIONS_DB` in the local Worker harness. PDF text extraction uses `pdftotext`. |
| Hansard and Canada Gazette | Captures the most recent completed Toronto week in each chamber and reconciles the full current-session calendars, serving databases, feeds, and archive hashes. Missing week packets are captured and replayed, then checked by authenticated exact lookup. Gazette discovers the newest regular Part I and Part II issues in both languages. The separate `gazette-year` step checks the annual listings through the Toronto run date and archives missing regular and separately numbered extra issues. Search and exact lookup preserve the part, extra number and language. |
| GEDS, parliamentary catalogues, Journals and votes, and written questions | Runs their acquisition and publication commands against the local stores, then checks the corresponding Worker routes. An unchanged GEDS ZIP can replay even when the host lacks space to construct a new snapshot. |
| Committee corpus | Refreshes Senate meeting notices before extracting their publication links. The downloader checks the digest and timestamp of each parsed notice and fetches the other linked originals. The operator then builds the corpus, verifies its archived files, publishes to local D1, and tests bilingual retrieval. |

The large rebuilds need room for the existing generation and its replacement. A disk refusal records the measured available and required space in the report. Resume with `--only` after making space. Federal bulk acquisitions keep the last fully published set while building its successor. Cloudflare staging credentials are used separately by the statutes publication runner.

To reconcile an individual session or inventory outside the weekly run, use the same local stores:

```sh
bun scripts/hansard-session-reconcile.ts house 45-1 dist/hansard/session-45-1.sqlite dist/hansard/weekly/house
bun scripts/hansard-session-reconcile.ts senate 45-1 dist/hansard/session-45-1.sqlite dist/hansard/weekly/senate
bun scripts/gazette-local.ts sync-year-catchup data/corpus/gazette-preview.sqlite 2026 2026-11-25
python3 -B scripts/departmental-report-editions.py current
python3 -B scripts/federal-publication-checklists.py replay
```

Use `--status` to see each configured source’s most recent result and dated receipt. Where the operator emits structured coverage counts, the status includes the acquired and unresolved records from that attempt. A passing ECCC serving check, for example, can still show fewer extracted documents than the publisher lists. The full-attempt entry gives the pass count, failed step names and any sources added since that run. A successful retry updates that source's standing while preserving the earlier full report.

## Failure handling

- Use the dated result to identify the last completed stage. Acquisition can checkpoint new source bytes before a serving generation is ready. The notice intake can retain successful editions and still return an error for other publisher URLs. Check its acquisition receipt and the Worker result separately.
- Re-run the same command after fixing the cause. Identical input adds no records and no change events.
- A publisher defect that the intake cannot resolve is reported, not hidden: committee calls expose `pendingChange` and `contentConflict`, and consultations expose `stale` and `removed` counts.
- Keep the receipts. They are the dated evidence that a quiet day was quiet, rather than a failed fetch.
