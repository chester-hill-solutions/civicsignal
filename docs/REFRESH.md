# Intake refresh

Use the Cloudflare sections to operate private staging from any authorized host. The local commands reproduce reference runs during migration. The [master plan](PLAN.md#pipeline-verification-priorities) tracks each source through its hosted calendar test and cutover. D-08 governs hosted publication and cadence per corpus.

## Cloudflare consultations staging

The [staging Worker configuration](../services/consultations/wrangler.jsonc) identifies the private Worker, its calendar and its dedicated D1, R2 and Workflow bindings. Each calendar occurrence creates the Workflow instance `consultations-<scheduledTime>`, where the suffix is the Unix time in milliseconds. Operators can inspect that instance in Cloudflare Workflows from any authorized host. A completed instance returns the revision, row count and R2 receipt key. Inspect the failed step and its error for an incomplete instance.

The [Workflow](../services/consultations/worker.ts) archives the public CSV and dictionary by SHA-256 before publication. A retry of the publication step reads those checkpointed objects. The D1 transaction publishes record changes and their history together. A private service binding then uses the same lookup function as the product API to verify a source row's English and French titles. Its dated receipt in `consultations/runs/` identifies the original bytes, catalogue revision, D1 publication rows read and written, and the verified record. Request these objects through authenticated Cloudflare access. Customer workspace authorization and billing belong to the product API.

For an operator-triggered staging check, select the project account in `cf` and run the command below. It creates one manual instance with the current time. For calendar evidence, correlate the Worker's scheduled event with the Workflow instance and its R2 receipt. The deployed calendar is also readable with `wrangler init --from-dash civicsignal-stage-consultations --no-delegate-c3` from an empty temporary directory.

```sh
consultations_ms=$(node -p 'Date.now()')
cf workflows instances create civicsignal-stage-consultations \
  --body "{\"instance_id\":\"consultations-$consultations_ms\",\"params\":{\"scheduledTime\":$consultations_ms}}"
```

To compare Worker execution with an acquired catalogue, run the following from the repository root. The test reads the receipt and content-addressed originals under `data/corpus/consultations/sources/`. It checks the revision, repeats the same trigger, advances the calendar one day, and verifies the unchanged replay in isolated local storage.

```sh
CIVICSIGNAL_WORKERD_TESTS=1 \
CIVICSIGNAL_CONSULTATIONS_REFRESH_REFERENCE=dist/refresh/receipts/consultations.json \
bun run test test/consultations-refresh-workerd.test.ts
```

## Cloudflare NSERC funding staging

The [private funding Worker](../services/funding/wrangler.jsonc) runs daily at **22:40 UTC**. Each calendar occurrence starts a Workflow with instance ID `nserc-<scheduledTime>` in Unix milliseconds. Its [private Python collector](../services/funding/collector/wrangler.jsonc) runs the same bilingual CCI catalogue parser as the local operator and preserves the official HTML pages and the dated inventory in the dedicated funding R2 bucket. Cloudflare performs the publisher fetches and all storage operations.

Use the instance status and `funding/nserc/runs/<instanceId>.json` in R2 to check the outcome. The receipt identifies the inventory by SHA-256, the number and size of the sources, and the serving revision. It also records publication row counts and private English and French lookups with hashes of the served terms. A later observation can capture changed HTML while leaving the edition history unchanged. Check the publication revision and edition events to establish whether program terms changed.

For a manual staging check, select the project account in `cf` and use the same numeric time in the instance ID and payload.

```sh
nserc_ms=$(node -p 'Date.now()')
cf workflows instances create civicsignal-stage-funding \
  --body "{\"instance_id\":\"nserc-$nserc_ms\",\"params\":{\"scheduledTime\":$nserc_ms}}"
```

The following checks exercise the scheduled publisher locally against an acquired inventory and its archived HTML.

```sh
CIVICSIGNAL_WORKERD_TESTS=1 \
CIVICSIGNAL_NSERC_REFRESH_REFERENCE=data/corpus/funding/nserc.json \
CIVICSIGNAL_NSERC_FUNDING_REFERENCE=data/corpus/funding/nserc.json \
bun run test test/funding-refresh-workerd.test.ts test/funding-hosted-publish.test.ts
```

## Cloudflare ESDC funding staging

The [ESDC Workflow](../services/funding/esdc/wrangler.jsonc) runs daily at **23:15 UTC** with a [private collector](../services/funding/esdc-collector/wrangler.jsonc). The two Workers share the funding D1 and R2 resources with NSERC. The Workflow accepts only ESDC inventory, writes ESDC catalogue rows, and verifies an English and a French edition through the private lookup service.

The following command starts a manual observation in the staging account.

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
esdc_ms=$(node -p 'Date.now()')
cf workflows instances create civicsignal-stage-esdc \
  --body "{\"instance_id\":\"esdc-$esdc_ms\",\"params\":{\"scheduledTime\":$esdc_ms}}"
```

Check the instance status, then read `funding/esdc/runs/<instanceId>.json` in the staging funding bucket. The receipt links the dated capture with its catalogue revision, edition and gap counts, D1 publication rows read and written, and bilingual lookup hashes. For a scheduled run, match the calendar event's millisecond timestamp to the instance ID. A retry of an interrupted acquisition uses the same observation time to recover verified pages. A new calendar occurrence rechecks the publisher.

From an authorized checkout, use the timestamp of the occurrence you want to inspect in the following read-only commands.

```sh
cf workflows instances get "esdc-$esdc_ms" --workflow-name civicsignal-stage-esdc --simple true
bunx wrangler r2 object get "civicsignal-stage-funding/funding/esdc/runs/esdc-$esdc_ms.json" \
  --config services/funding/esdc/wrangler.jsonc --remote --pipe
```

If acquisition stops before publication, inspect the failing URL in the collector log and the saved page references under `funding/esdc/observations/<observedAt>/pages/`. Restart the same Workflow instance to continue that observation. The collector's `esdc-acquisition-complete` log records how many URLs it fetched and how many it recovered from checkpoints, including confirmed missing pages. The Workflow checks archived originals and terminal HTTP evidence before committing the catalogue to D1.

## Cloudflare House committee calls staging

The private House Workflow refreshes session 45-1 daily at **00:15 UTC**. This is 19:15 the preceding day in Toronto during standard time and 20:15 during daylight time. It captures the two official participation indexes, their linked study pages and eight Senate coverage probes. The Workflow retains each original and its request timestamp in R2. The publication transaction applies the dated call and study-link changes to the sealed committee database. The last full corpus cutoff still identifies the base corpus. The authenticated product check confirms the served English and French calls, linked studies and related counts. [Workflow configuration](../services/house/wrangler.jsonc) · [Collector configuration](../services/house-collector/wrangler.jsonc)

Each occurrence uses an instance ID of the form `house-calls-<scheduledTime>`, with the UTC event timestamp in Unix milliseconds. To inspect an occurrence and read its completion receipt, select the staging account and use its instance ID.

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
cf workflows instances get "$house_instance" --workflow-name civicsignal-stage-house --simple true
cf r2 objects get "committee/house-calls/runs/$house_instance.json" --bucket-name civicsignal-stage-funding
```

If acquisition stops before publication, restart the same incomplete instance to reuse verified originals and request timestamps. Use the dated receipt when investigating a completed occurrence. A new calendar occurrence makes fresh publisher requests. The Cloudflare Workflow status names the failed step. The completion receipt records the R2 inventory digest, committed call counts, both language checks, and product usage. If a Senate probe is unreadable, its checkpoint records that outcome. A missing House page fails acquisition.

For the latest completed D1 observation, compare all hosted call rows with a replay through the local intake operator using the hosted originals and the prepublication snapshot. The command writes its replay database to a temporary directory.

```sh
python3 -B scripts/verify-house-staging.py "$house_instance"
```

## Private daily product checks

The private Workflow calls the product Worker with a retrieval-only key for the staging workspace. It verifies consultation search and history, House calls and study links, and the English and French paths from the Finance Committee brief to NSERC and ESDC program terms. It also checks public discovery, unauthenticated rejection and the exact change in the workspace's usage count. Run one verification at a time to keep the usage comparison attributable to that run. [Worker configuration](../services/daily-checks/wrangler.jsonc)

Select the three completed source observations and the SHA-256 of the committee reference for the sealed session. The following example targets November 25 staging data. For a later run, update all four inputs to match the published catalogues.

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
daily_id="daily-$(node -p 'Date.now()')"
params='{"consultations":"consultations-1795644602710","nserc":"nserc-1795646402601","esdc":"esdc-1795648539258","committee":"8748ad16ba57dd3d5db5a4a7bcfee9b72c64f7092451b9391ce31ee003643607"}'
cf workflows instances create civicsignal-stage-daily-checks \
  --body "$(jq -cn --arg id "$daily_id" --argjson params "$params" '{instance_id:$id,params:$params}')"
cf workflows instances get "$daily_id" --workflow-name civicsignal-stage-daily-checks --simple true
bunx wrangler r2 object get "civicsignal-stage-funding/daily/serving/$daily_id.json" \
  --config services/daily-checks/wrangler.jsonc --remote --pipe
```

The Workflow writes the receipt after every case passes. It records each request path, status and correlation ID, the usage counter before and after each case, and the source references used for comparison. For an incomplete instance, the Workflow status identifies the failing step. [Verification code](../services/daily-checks/worker.ts)

## What runs daily

| Collection | Command | Measured (2026-11-24) |
| --- | --- | --- |
| Federal consultations | `bun run refresh:consultations` | ~5 s, 6.8 MB catalogue + schema |
| House committee calls | `bun run refresh:committee-calls` | ~30 s, 30 study pages + 8 Senate pages |
| Funding catalogues | NSERC + ESDC intake, then `materialize-funding.ts` | NSERC 9.6 s, ESDC 2 min 22 s, materialise 0.7 s |

After an interrupted local ESDC capture, run `python3 -B scripts/funding-esdc.py --output data/corpus/funding/esdc.json --resume` before the next regular capture. This resumes that observation, verifies archived pages, and reuses confirmed missing detail pages. A fresh invocation begins a new observation and checks the publisher again. The full-size recovery test withheld one page, then recovered it while preserving the 196 editions and 56 reported gaps. [Checkpoint evidence](evidence/2026-11-25/esdc-checkpoint.json)

To verify the ESDC publisher separately, run the following against a completed inventory. It publishes into isolated local D1, repeats the observation with a later timestamp, and compares every row in the four serving tables with the SQLite reference. [Recorded ESDC result](evidence/2026-11-25/esdc-d1-local.json)

```sh
CIVICSIGNAL_WORKERD_TESTS=1 \
CIVICSIGNAL_ESDC_FUNDING_REFERENCE=data/corpus/funding/esdc.json \
bun run test test/funding-acquired-publish-workerd.test.ts
```

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

The written-questions catalogue retains its last complete generation when a recheck stops early. To resume detail acquisition, run `python3 -B scripts/lib/wq_catalog.py --resume-partial-checkpoint`. The operator checks the new bilingual listings against the saved checkpoint, records which successful details it reused, and fetches the rest. The answer archive, local D1 publication and authenticated lookup still have to pass in the weekly step.

After verifying written-question originals, the weekly operator checks whether the archive volume supports transparent macOS compression. On a supported volume it compacts checksum-named HTML under the archive writer lock. Every replacement must return the original bytes at the same path and occupy fewer disk blocks. The run reports the allocation saved. Other volumes keep their ordinary files. To inspect a small batch on a supported host, run `python3 -B scripts/compact-written-question-objects.py --limit 12`. The subsequent D1 transaction checks the source digest and table contents, retains identical search-index entries, and verifies authenticated lookup.

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
