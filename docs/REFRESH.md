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

The daily run checks consultations and funding in their local catalogue databases. It publishes House calls into the dedicated committee D1 database and checks the served editions against the intake. Each step records its exit status, elapsed time, acquisition summary, and serving checks. Use the dated report to look up an edition in the same database served by the Worker.

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

## What stays off the daily job

| Collection | Cadence | Why |
| --- | --- | --- |
| GEDS directory | Weekly, or change-triggered | The export's `Last-Modified` was 2026-10-25 when imported on November 24; a full import takes ~7 minutes and the snapshot is ~1.1 GB |
| Full committee corpus (catalogue, download, expand, corpus) | Weekly | Walks thousands of originals; the calls intake already refreshes the time-sensitive surface |
| Parliamentary catalogues, Journals, written questions | Weekly operator run | Follow the routine checks in [the plan](PLAN.md#routine-current-session-refresh) |
| ECCC departmental publications | Weekly, currently manual | `python3 -B scripts/eccc-intake.py --workers 1`; 155 entries, 246 documents, ~9 minutes and 22 MB. [Intake](DEPARTMENTAL-PUBLICATIONS.md) |

Use the daily report as the reliable signal for the three fast collections, and run the weekly sets by hand until their publication intervals are measured the same way.

## Failure handling

- A failed step keeps the previous serving data; every intake publishes transactionally and refuses an older observation.
- Re-run the same command after fixing the cause. Identical input adds no records and no change events.
- A publisher defect that the intake cannot resolve is reported, not hidden: committee calls expose `pendingChange` and `contentConflict`, and consultations expose `stale` and `removed` counts.
- Keep the receipts. They are the dated evidence that a quiet day was quiet, rather than a failed fetch.
