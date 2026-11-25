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

## Weekly local refresh

The weekly per-user LaunchAgent runs on Saturdays at 09:00 local time. The daily agent continues to run at 06:15. Both acquire the same kernel lock while publishing committees. A conflicting weekly or daily committee step exits with an error and can be retried independently. The other collections continue.

```sh
python3 -B scripts/schedule/weekly.py install
python3 -B scripts/refresh-weekly.py --help
python3 -B scripts/refresh-weekly.py --only geds
python3 -B scripts/schedule/weekly.py remove
```

Installation registers the job. It runs while the user is logged in. Removal unloads it and retains its databases and dated receipts. The installed command is `python3 -B scripts/refresh-weekly.py`. Read the dated report under `dist/refresh-weekly/` to see the command, exit status, disk headroom and serving checks for each source. A failed or skipped source makes the full run fail. `latest-full.json` records the last full attempt and `latest-successful-full.json` records the last complete success. A selective retry updates `latest-partial.json`.

| Collection | What the weekly operator does |
| --- | --- |
| Federal source register | Captures the 18 series' catalogue pages and structured resource metadata, including the original bytes and endpoint-specific failures. These are discovery receipts. |
| Departmental report directories | Refreshes linked institutional entries from the federal departmental plans, results and regulatory plan directories. |
| Government publications | Checks the three dated bibliography exports and retains their publisher snapshot date. |
| CanadaBuys procurement | Archives and verifies award notices and contract history for the current fiscal year. |
| Official institution titles, GC Service Inventory, grants and contributions awards, and access-request summaries | Streams the published CSV resources, validates their fields and records, and archives them by hash. Publishes a collection after all its resources pass. Use `python3 -B scripts/federal-bulk.py search service-inventory --query passport --limit 3` to read cited records locally. |
| Algorithmic impact assessments and briefing packages | Archives every result page from the five published portal collections, checks collection identity and totals, and publishes a local bilingual catalogue with the original resource links. Use `python3 -B scripts/federal-disclosures.py --lookup DATASET_ID`. |
| Treasury Board and IRCC guidance | Refreshes the bilingual active and archived policy indexes and the IRCC operational manuals index. |
| Consultation participation | Resolves linked notices for the current catalogue revision and retains source bytes, participation instructions and explicit gaps. |
| Briefing notes | Validates the official main and nil-return CSVs and schema. The source supplies briefing titles and metadata. Run `python3 -B scripts/briefing-notes.py --help` for archive replay and bilingual title search. |
| ECCC audits and evaluations | Captures the four index pages and referenced documents, then builds a separate passage database and checks the authenticated local API. Read `GET /api/departmental-publications/openapi.json`. Enable the preview with `DEPARTMENTAL_PUBLICATIONS_PREVIEW=on` and bind the completed `data/corpus/eccc/serving.sqlite` to `DEPARTMENTAL_PUBLICATIONS_DB` in the local Worker harness. PDF text extraction uses `pdftotext`. |
| Hansard and Canada Gazette | Captures both chambers for the most recent completed Toronto week and checks each listed edition against an authenticated exact lookup. Gazette discovers the newest regular Part I and Part II issues in both languages. A Gazette refresh covers those issue dates. Historical backfill and missed weeks remain visible as gaps. |
| GEDS, parliamentary catalogues, Journals and votes, written questions, and the full committee corpus | Runs their existing acquisition and publication commands against the local stores, then checks the corresponding Worker routes. An unchanged GEDS ZIP can replay even when the host lacks space to construct a new snapshot. |

The large rebuilds need room for the existing generation and its replacement. A disk refusal records the measured available and required space in the report. Resume with `--only` after making space. Federal bulk acquisitions keep the last fully published set while building its successor. Cloudflare staging credentials are used separately by the statutes publication runner.

## Failure handling

- A failed step keeps the previous serving data; every intake publishes transactionally and refuses an older observation.
- Re-run the same command after fixing the cause. Identical input adds no records and no change events.
- A publisher defect that the intake cannot resolve is reported, not hidden: committee calls expose `pendingChange` and `contentConflict`, and consultations expose `stale` and `removed` counts.
- Keep the receipts. They are the dated evidence that a quiet day was quiet, rather than a failed fetch.
