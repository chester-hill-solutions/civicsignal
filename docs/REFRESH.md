# Intake refresh

Use the Cloudflare sections to operate private staging from any authorized host. The local commands reproduce reference runs during migration. The [master plan](PLAN.md#pipeline-verification-priorities) tracks each source through its hosted calendar test and cutover. D-08 governs hosted publication and cadence per corpus.

## Cloudflare consultations staging

The [staging Worker configuration](../services/consultations/wrangler.jsonc) identifies the private Worker and its dedicated D1, R2 and Workflow bindings. The combined daily coordinator starts the Workflow instance `consultations-<scheduledTime>`, where the suffix is the Unix time in milliseconds. Operators can inspect that instance in Cloudflare Workflows from any authorized host. A completed instance returns the revision, row count and R2 receipt key. Inspect the failed step and its error for an incomplete instance.

The [Workflow](../services/consultations/worker.ts) archives the public CSV and dictionary by SHA-256 before publication. A retry of the publication step reads those checkpointed objects. The D1 transaction publishes record changes and their history together. A private service binding then uses the same lookup function as the product API to verify a source row's English and French titles. Its dated receipt in `consultations/runs/` identifies the original bytes, catalogue revision, D1 publication rows read and written, and the verified record. Request these objects through authenticated Cloudflare access. Customer workspace authorization and billing belong to the product API.

For an operator-triggered staging check, select the project account in `cf` and run the command below. It creates one manual instance with the current time. For calendar evidence, correlate the combined coordinator occurrence with this child instance and its R2 receipt.

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

The combined daily coordinator starts the [private NSERC Workflow](../services/funding/wrangler.jsonc) with instance ID `nserc-<scheduledTime>` in Unix milliseconds. Its [private Python collector](../services/funding/collector/wrangler.jsonc) runs the same bilingual CCI catalogue parser as the local operator and preserves the official HTML pages and the dated inventory in the dedicated funding R2 bucket. Cloudflare performs the publisher fetches and all storage operations.

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

The combined daily coordinator starts the [ESDC Workflow](../services/funding/esdc/wrangler.jsonc), which uses a [private collector](../services/funding/esdc-collector/wrangler.jsonc). The two Workers share the funding D1 and R2 resources with NSERC. The Workflow accepts only ESDC inventory, writes ESDC catalogue rows, and verifies an English and a French edition through the private lookup service.

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

The combined daily coordinator starts the private House Workflow for session 45-1. It captures the two official participation indexes, their linked study pages and eight Senate coverage probes. The Workflow retains each original and its request timestamp in R2. The publication transaction applies the dated call and study-link changes to the sealed committee database. The last full corpus cutoff still identifies the base corpus. The authenticated product check confirms the served English and French calls, linked studies and related counts. [Workflow configuration](../services/house/wrangler.jsonc) · [Collector configuration](../services/house-collector/wrangler.jsonc)

Each occurrence uses an instance ID of the form `house-calls-<scheduledTime>`, with the UTC event timestamp in Unix milliseconds. To inspect an occurrence and read its completion receipt, select the staging account and use its instance ID.

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
cf workflows instances get "$house_instance" --workflow-name civicsignal-stage-house --simple true
cf r2 objects get "committee/house-calls/runs/$house_instance.json" --bucket-name civicsignal-stage-funding
```

If House acquisition is interrupted after retaining pages, restart the same incomplete instance to reuse verified originals and request timestamps. For a confirmed publisher 403, read the refusal under `committee/house-calls/failures/<instanceId>.json` and the combined report. Use the dated receipt when investigating a completed occurrence. A new calendar occurrence makes fresh publisher requests. The Cloudflare Workflow status names the failed step. The completion receipt records the R2 inventory digest, committed call counts, both language checks, and product usage. If a Senate probe is unreadable, its checkpoint records that outcome. A missing House page fails acquisition.

For the latest completed D1 observation, compare all hosted call rows with a replay through the local intake operator using the hosted originals and the prepublication snapshot. The command writes its replay database to a temporary directory.

```sh
python3 -B scripts/verify-house-staging.py "$house_instance"
```

## Combined Cloudflare daily refresh

The private combined Workflow starts consultations, NSERC, ESDC and House calls daily at **15:15 UTC** (10:15 Toronto standard time or 11:15 during daylight time). The coordinator owns the staging calendar. Each child keeps its own dated acquisition and publication receipt. When the children finish, the combined Workflow checks the authenticated API and writes a single immutable report. [Coordinator configuration](../services/daily/wrangler.jsonc)

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
cf workflows instances list --workflow-name civicsignal-stage-daily --per-page 10
cf workflows instances get "$daily_instance" --workflow-name civicsignal-stage-daily --simple true
cf r2 objects get "daily/runs/$daily_instance.json" --bucket-name civicsignal-stage-funding
```

Use the report's `status` as the outcome. A complete run refreshed and verified all four sources. A degraded run records a failed or timed-out intake alongside the successful intake and serving checks. A failed report indicates a verification error or an unproven House fallback. Cloudflare shows the coordinator as complete once it has retained any of these reports.

For a House 403, the source outcome includes the exact publisher URL, status and immutable failure receipt. The coordinator compares D1 fingerprints of the House call rows, links, publication head and cutoff before and after the failure. It also checks the prior completion receipt in R2. When those match, it verifies the English and French product responses against that saved House observation. The report marks this verification `last-good` and retains the current successful receipts for consultations and both funding catalogues.

Use an operator-triggered occurrence only when the calendar and other manual occurrences are idle. Its child IDs use the same timestamp as the coordinator, so the report identifies the exact attempts.

```sh
daily_ms=$(node -p 'Date.now()')
cf workflows instances create civicsignal-stage-daily \
  --body "$(jq -cn --arg id "daily-refresh-$daily_ms" --argjson ms "$daily_ms" '{instance_id:$id,params:{scheduledTime:$ms}}')"
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

## Daily Mac fallback

The installed 06:15 Toronto LaunchAgent runs House committee calls. The combined Cloudflare calendar owns scheduled consultations, NSERC and ESDC funding. Both funding publications passed native authenticated bilingual readback. The weekly notices workflow consumes the hosted consultations catalogue. [Funding cutover evidence](evidence/2026-11-26/funding-mac-cutover.json) · [Consultation notices cutover](evidence/2026-11-26/consultation-notices-cloudflare.json)

| Collection | Command | Measured (2026-11-24) |
| --- | --- | --- |
| House committee calls | `bun run refresh:committee-calls` | ~30 s, 30 study pages + 8 Senate pages |

After an interrupted local ESDC capture, run `python3 -B scripts/funding-esdc.py --output data/corpus/funding/esdc.json --resume` before the next regular capture. This resumes that observation, verifies archived pages, and reuses confirmed missing detail pages. A fresh invocation begins a new observation and checks the publisher again. The full-size recovery test withheld one page, then recovered it while preserving the 196 editions and 56 reported gaps. [Checkpoint evidence](evidence/2026-11-25/esdc-checkpoint.json)

To verify the ESDC publisher separately, run the following against a completed inventory. It publishes into isolated local D1, repeats the observation with a later timestamp, and compares every row in the four serving tables with the SQLite reference. [Recorded ESDC result](evidence/2026-11-25/esdc-d1-local.json)

```sh
CIVICSIGNAL_WORKERD_TESTS=1 \
CIVICSIGNAL_ESDC_FUNDING_REFERENCE=data/corpus/funding/esdc.json \
bun run test test/funding-acquired-publish-workerd.test.ts
```

For local diagnostics, `bun run refresh:daily` runs consultations, House calls and both funding catalogues in sequence. Each step writes its own outcome. A step failure allows the remaining steps to continue and sets a nonzero process exit status.

```sh
bun run refresh:daily
bun run refresh:daily --only consultations --report dist/refresh/one.json
```

Every invocation writes a dated report in `dist/refresh/`. The installed schedule and manual selective retries update `latest-partial.json`. Use `latest-full.json` for the most recent attempt covering all three intakes and `latest-successful-full.json` for the last successful full run. The existing `latest.json` follows the latest invocation of either scope. For older reports, check the step names and whether serving verification was recorded.

The daily runner checks manually selected consultations and funding against their local catalogue databases. It publishes House calls into the dedicated committee D1 database and checks the served editions against the intake. After all selected steps pass, it records their authenticated Worker checks in `workerVerification` before writing the report. The installed schedule runs one check and a full manual run uses four. Use the dated report to look up an edition in the same database served by the Worker.

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

## Cloudflare weekly federal discovery staging

The private federal discovery Workflow reads the checked-in register, archives its exact bytes, and acquires the registered government catalogue endpoints. It fetches each distinct publisher URL once per observation and retains every series membership. This is the discovery stage for datasets and catalogue indexes. The report and original objects live in the private weekly R2 bucket. [Registered sources](evidence/2026-11-23/federal-public-service-sources.csv) · [Workflow configuration](../services/federal-register/wrangler.jsonc)

Cloudflare runs the Workflow every Saturday at 14:00 UTC, which is 09:00 Toronto in standard time and 10:00 in daylight time. The November 26 qualification used a temporary Thursday trigger. The Saturday cutover changed the calendar and verified the active deployment and bindings. [Native qualification and calendar readback](evidence/2026-11-26/federal-discovery-cloudflare.json)

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
cf workflows instances list --workflow-name civicsignal-stage-federal-register --per-page 10
cf r2 objects get weekly/federal-discovery/latest-complete.json --bucket-name civicsignal-stage-weekly
federal_instance=$(cf r2 objects get weekly/federal-discovery/latest-attempt.json --bucket-name civicsignal-stage-weekly | jq -er '.instanceId')
python3 -B scripts/verify-federal-register-staging.py "$federal_instance"
```

The verifier reads back every archive and request checkpoint and compares the inventory with the pre-port parser. Pass `--compare-baseline` with the latest complete local receipt and its matching download cache to identify publisher bytes and normalized endpoint inventories that changed since the Mac observation.

Each occurrence creates an immutable report at `weekly/federal-discovery/runs/federal-discovery-<scheduledTime>.json`. A partial report identifies the failed endpoints through its inventory and advances only the latest attempt. Consumers use the latest complete report and its verified inventory for downstream discovery. A retry of an interrupted observation reuses verified request checkpoints. A new occurrence fetches the publisher again.

The local federal bulk, publications, guidance and report-directory steps still read their local discovery database or archive. Keep the local weekly operator active while moving those consumers to the hosted register.

### Official institution titles

The same weekly Workflow imports the bilingual titles from the verified catalogue entry for that occurrence. It selects the single official CSV, verifies the ordered fields and records, and retains the exact CSV and parsed records by SHA-256 in private R2. The titles receipt pins the discovery receipt and packet hashes. An issue with an unrelated catalogue can leave the register partial while the verified titles entry supplies the import. An unavailable titles catalogue records a skipped import, and a refused or invalid CSV records a failed import. Both outcomes advance the titles attempt pointer and preserve the last complete set.

```sh
titles_instance=$(cf r2 objects get weekly/official-titles/latest-attempt.json --bucket-name civicsignal-stage-weekly | jq -er '.instanceId')
cf r2 objects get weekly/official-titles/latest-complete.json --bucket-name civicsignal-stage-weekly
python3 -B scripts/verify-official-titles-staging.py "$titles_instance"
```

The verifier rereads the archived catalogue and CSV, runs the pre-port bulk validator, and compares every field and row. The institution coverage report follows `weekly/official-titles/latest-complete.json` to the immutable receipt and replays its archived CSV and ordered records. The Cloudflare Workflow reads the private bucket through its R2 binding. The local fallback uses `cf`. Both record the receipt hash alongside the source citation. The Mac weekly schedule no longer downloads the titles CSV from the publisher. [Coverage cutover](evidence/2026-11-26/coverage-titles-cutover.json)

The November 26 native qualification completed all seven steps on their first attempt. It verified the original checksum and every field and row against the local reference. Cloudflare confirmed the standing Saturday calendar after the temporary Thursday trigger was removed. [Titles qualification](evidence/2026-11-26/official-titles-cloudflare.json)

### GC Service Inventory

The weekly Workflow selects the Service Inventory CSVs from the same occurrence’s verified catalogue entry. It acquires each file as a separate Workflow step, validates its published fields and records, and retains the original in private R2. The successful resource checkpoint pins the occurrence, resource URL, SHA-256, size, headers and record count. A retry verifies and reuses that checkpoint. Each new occurrence fetches the source again. The collector bounds each resource to 24 MiB and 60 seconds of publisher access.

```sh
service_instance=$(cf r2 objects get weekly/service-inventory/latest-attempt.json --bucket-name civicsignal-stage-weekly | jq -er '.instanceId')
cf r2 objects get weekly/service-inventory/latest-complete.json --bucket-name civicsignal-stage-weekly
python3 -B scripts/verify-service-inventory-staging.py "$service_instance"
```

The latest complete pointer advances after every selected CSV passes. A failed resource or unavailable catalogue appears in the latest attempt and preserves the last complete set. Follow the dated receipt’s resource references for the original CSVs. The independent verifier rehashes and replays each original against its occurrence checkpoint and the pre-port importer.

The native November 26 qualification published all four CSVs with 27,495 rows in 40.8 seconds. Independent readback replayed every archived CSV and verified the dated discovery receipt, per-resource checkpoints and both pointers. The operating schedule remains Saturday at 14:00 UTC. [Service Inventory qualification](evidence/2026-11-26/service-inventory-cloudflare.json)

The institution coverage report reads the latest complete Service Inventory receipt and verifies every resource checkpoint, archive hash, header and row count before publishing the report. Its source entries retain the hosted receipt and checkpoint hashes. The Cloudflare Workflow uses its R2 binding and the local fallback uses `cf`. The Mac weekly runner no longer fetches Service Inventory CSVs from the publisher. [Coverage cutover](evidence/2026-11-26/coverage-service-cutover.json)

### Institution coverage report

The private coverage Workflow pins the latest complete titles, Service Inventory and federal discovery receipts. It reads grouped consultation publishers from staging D1, which the combined daily Cloudflare refresh populates. The Linux container restores the input workspace from digest-verified R2 objects. It uses the hosted federal register for access-request and grant CSVs, the bibliography exports, and Treasury Board and IRCC index pages. The existing source operators acquire the remaining inputs from official publishers and the existing report script verifies and attributes them. Cloudflare operators retrieve the report through private R2 and inspect its run through Workflows. [Workflow configuration](../services/institution-coverage/wrangler.jsonc)

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
workflow=civicsignal-stage-institution-coverage
bucket=civicsignal-stage-weekly
cf workflows instances list --workflow-name "$workflow" --per-page 10
pointer=$(cf r2 objects get weekly/institution-coverage/latest-attempt.json --bucket-name "$bucket")
instance=$(printf '%s' "$pointer" | jq -er '.instanceId')
cf workflows instances get "$instance" --workflow-name "$workflow"
receipt_key=$(printf '%s' "$pointer" | jq -er '.receiptKey')
cf r2 objects get "$receipt_key" --bucket-name "$bucket" > coverage-receipt.json
jq '{status, inputFreshness, attempts: [.attempts[] | {source, ok, exitCodes, elapsedSeconds}]}' coverage-receipt.json
report_key=$(jq -er '.report.key' coverage-receipt.json)
cf r2 objects get "$report_key" --bucket-name "$bucket" > coverage.json
printf '%s  coverage.json\n' "$(jq -er '.report.sha256' coverage-receipt.json)" | shasum -a 256 -c -
```

Use `latest-complete.json` in the same prefix to select the last fully successful report. It first appears after a complete refresh. Each published refresh records the exit codes and duration for each source, identifies which upstream collections are current, and points to its report, consultation owner projection and workspace. A degraded refresh advances the attempt and workspace pointers and preserves the last complete report pointer. The complete pointer requires the current titles, Service Inventory and discovery occurrence, a same-day consultation publication, and successful source checks. A replay writes a dated receipt without advancing the fresh pointers. For an occurrence that stops before publication, read the error from its Workflow instance.

For the initial archive, `python3 -B scripts/bootstrap-institution-coverage.py` verifies and uploads a stable workspace to private R2 and writes the manifest reference to stdout. Only the initial occurrence needs the bootstrap reference at `weekly/institution-coverage/bootstrap.json`. Later runs use the workspace manifest from their predecessor. The pinned PDF extractor replays each policy PDF against its checked archive. Cloudflare's x86 extractor can wrap paragraphs differently, so the hosted replay verifies the exact words, order and citation on each page. On November 26 the Cloudflare replay matched the independent reference byte for byte across all 33 source groups. [Replay evidence](evidence/2026-11-26/institution-coverage-cloudflare.json)

The standing staging schedule is Saturday at 16:00 UTC, two hours after the federal register and 45 minutes after the combined daily refresh starts. The first occurrence on this schedule is due November 28. The initial November 26 native occurrences published verified reports across 33 source groups and 18 series. A subsequent November 26 occurrence in Toronto restored the R2 workspace and repeated the source acquisitions. Its receipt is `degraded` and lists the source gaps and the prior UTC day's register and consultation inputs. [Initial native runs](evidence/2026-11-26/institution-coverage-cloudflare.json) · [Follow-up and source cutovers](evidence/2026-11-26/coverage-source-cutover.json)

To rerun the authenticated ECCC and GEDS checks inside Cloudflare, set `state` to the `.state` object from the dated refresh receipt you want to verify. The Workflow restores that exact archive and saves the check counts in `servingReplay` on its dated receipt.

```sh
state=$(jq -ce '.state' coverage-receipt.json)
scheduled_time=$(node -p 'Date.now()')
instance="institution-coverage-$scheduled_time"
body=$(jq -cn --arg id "$instance" --argjson time "$scheduled_time" --argjson state "$state" \
  '{instance_id:$id, params:{scheduledTime:$time, mode:"replay", state:$state, checkServing:true}}')
cf workflows instances create "$workflow" --body "$body"
cf workflows instances get "$instance" --workflow-name "$workflow"
```

Use `retrySource: "federal-regulatory-plans"` with the same pinned replay request to reacquire and replay the regulatory plans from the archived issuer pages. The dated replay receipt records the single producer attempt and its separate workspace and report. The scheduled attempt and workspace pointers stay on their existing occurrence.

Departmental PDF attribution records the current acquisition status. For a current citation with a temporary fetch failure, the report can retain a previously verified edition after checking its archived PDF and extracted text against their recorded hashes. The report identifies the retained generations in `retainedEvidence`. A current removal, a changed citation or a newer unverified assessment closes that historical match. A replay of the second staging workspace recovered all 51 editions affected by the fetch timeouts. [Replay evidence](evidence/2026-11-26/institution-coverage-cloudflare.json)

The Mac weekly runner no longer schedules the coverage report. For a manual diagnostic from an acquired local workspace, run `python3 -B scripts/federal-institution-coverage.py --include-acquisitions --output dist/refresh-weekly/federal-institutions.json` from the repository root.

## Cloudflare Hansard refresh

The private Hansard Worker starts one Workflow instance per chamber from its Monday 14:00 UTC trigger. The instance ID uses the chamber and the scheduled UTC minute in Unix milliseconds. Both instances derive the last completed Toronto week from that minute. The session is pinned to 45-1. [Worker configuration](../services/hansard/wrangler.jsonc)

Each instance restores its own checksum-verified SQLite store and source archive from R2. It fetches the completed week from the official House XML or Senate HTML source, replays both editions, and reconciles the full session against the publisher calendar. The container verifies archived citations through the authenticated Worker routes against the restored SQLite store. It also checks bilingual search, exact lookup, and change-feed pagination. Each chamber keeps its own last complete publication when a run degrades.

The archive is private staging. The customer API configuration and corpus source-use decisions are tracked in [D-08](PLAN.md#decisions-still-required).

The November 26 native qualification started both workflows at 19:04 Toronto time. It fetched 10 House and six Senate editions for November 16–22, reconciled all 546 registered language editions through the cutoff, and preserved both change feeds. An independent restore checked each published R2 chunk, both SQLite databases and both receipt heads. The Mac weekly agent stayed idle during the native run. Its two Hansard steps were then retired. Local acquisition and replay commands remain available for diagnostics. [Qualification evidence](evidence/2026-11-26/hansard-cloudflare.json)

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
workflow=civicsignal-stage-hansard
bucket=civicsignal-stage-weekly
cf workflows instances list --workflow-name "$workflow" --per-page 10
chamber=house  # or senate
prefix=weekly/hansard/$chamber
pointer=$(cf r2 objects get "$prefix/latest-attempt.json" --bucket-name "$bucket")
jq '{status, instanceId, scheduledTime}' <<< "$pointer"
cf workflows instances get "$(jq -er '.instanceId' <<< "$pointer")" --workflow-name "$workflow"
cf r2 objects get "$(jq -er '.receiptKey' <<< "$pointer")" --bucket-name "$bucket" > hansard-receipt.json
jq '{status, reason, report, state}' hansard-receipt.json
```

Read `latest-complete.json` for the last verified chamber snapshot. A degraded receipt gives the failure and pinned prior state. A complete receipt points to the new workspace manifest and verification report by SHA-256. For a suspected publisher refusal, inspect the dated receipt before retrying. For initial seeding, `python3 -B scripts/bootstrap-hansard.py house` and its Senate equivalent upload immutable archive objects and return the manifest references. The first run reads those references from the chamber's `bootstrap.json`. Routine runs restore their predecessor's workspace.

## Cloudflare Canada Gazette refresh

The private staging Worker runs every Saturday at 15:00 UTC. It derives the Toronto cutoff from the scheduled event and restores the last verified SQLite store and publisher archive from R2. The Workflow runs the current issue refresh and annual reconciliation serially against the same store. [Worker configuration](../services/gazette/wrangler.jsonc)

The current refresh verifies the four latest regular Part I and II language editions. The annual phase reads the four publisher listings, replays archived editions against the store, and captures missing regular issues and separately numbered extras. The authenticated checks verify current searches and citations, annual regular edition lookups, and extra edition search and lookup. A failed phase records its result in the dated report and preserves the last complete publication. The archive and verification are private staging, with customer API publication tracked under [D-08](PLAN.md#decisions-still-required).

The November 26 native qualification verified all four current editions, all 70 regular issues and all nine separately numbered extras. The independent R2 restore verified the publisher objects, SQLite integrity and unchanged change-feed positions. Both Mac Gazette steps were retired afterward. The first standing Saturday occurrence is November 28. [Qualification evidence](evidence/2026-11-26/gazette-cloudflare.json)

```sh
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a
bucket=civicsignal-stage-weekly
cf workflows instances list --workflow-name civicsignal-stage-gazette --per-page 10
pointer=$(cf r2 objects get weekly/gazette/latest-attempt.json --bucket-name "$bucket")
cf r2 objects get "$(jq -er '.receiptKey' <<< "$pointer")" --bucket-name "$bucket" > gazette-receipt.json
cf r2 objects get "$(jq -er '.report.key' gazette-receipt.json)" --bucket-name "$bucket" > gazette-report.json
printf '%s  gazette-report.json\n' "$(jq -er '.report.sha256' gazette-receipt.json)" | shasum -a 256 -c -
jq '{cutoff, current, annual}' gazette-report.json
```

Use `weekly/gazette/latest-complete.json` to select the last verified publication. For initial seeding, `python3 -B scripts/bootstrap-gazette.py` uploads the checked SQLite archive and returns the manifest reference for `weekly/gazette/bootstrap.json`. Later occurrences restore the last complete snapshot.

## Additional private weekly Cloudflare refreshes

These Workflows use the private `civicsignal-stage-weekly` bucket. Each occurrence pins its input workspace, verifies the acquired publication, and records an immutable receipt. Future runs restore the last complete verified state. A degraded attempt records the failure or publisher gaps and keeps the prior publication available.

| Job | Saturday UTC | Publication verification |
| --- | --- | --- |
| `statutes-export` | 12:00 | Clones the official Justice Canada laws repository into the Container and verifies the bilingual SQL, JSONL and title exports, revision and file hashes. This replaces the local export contract independently of the reviewed MP-02 snapshot promotion. |
| `parliament` | 13:00 | Refreshes 45-1 bills, recorded votes, Journals and roll calls. Verifies seven bilingual SQLite inventories, the cited originals, and two authenticated Worker cases. |
| `consultation-notices` | 17:00 | Pins the hosted consultations D1 revision and immutable R2 receipt. Verifies the published CSV, dictionary, notices and bilingual citations. It publishes only when no previously verified open edition loses coverage and every publisher failure matches the prior verified archive. The report retains those gaps and marks publisher coverage degraded. A new failure or exhausted archive budget preserves the previous verified publication and retains the candidate in the dated report. |
| `written-questions` | 17:00 | Checks both official 45-1 question listings and answer objects, materializes the isolated SQLite publication, and verifies authenticated lookup against the acquired observation. |

For first installation, run `python3 -B scripts/bootstrap-<job>.py` to upload the verified baseline and retain the returned manifest reference. Set that reference as `weekly/<job>/bootstrap.json` in the staging bucket and read it back before the first occurrence. Each worker has its own `services/<job>/wrangler.jsonc` with a private deployment and standing cron.

Check the Workflow status and read the dated `weekly/<job>/runs/<instance>.json` receipt from R2. Its report and manifest references give the exact size and SHA-256 for independent readback. Use `weekly/<job>/latest-complete.json` for the most recent verified publication and `weekly/<job>/latest-attempt.json` for the latest retained attempt.

The November 26 Parliament qualification completed in 4 minutes 27 seconds. Independent readback verified 13 R2 chunks, all 1,081 cited originals, and the seven bilingual SQLite inventories. Both authenticated Worker cases passed. The standing Cloudflare Saturday schedule now owns Parliament and the Mac weekly step has retired. [Qualification evidence](evidence/2026-11-26/parliament-cloudflare.json)

The November 26 statutes export qualification checked the current Justice Canada head, cloned it, and rebuilt all six files in 2 minutes 48 seconds. The file hashes matched the verified prior generation. Independent readback checked all 10 R2 chunks and all six file hashes. The Mac's `statutes-local` step has retired. [Qualification evidence](evidence/2026-11-26/statutes-export-cloudflare.json)

The November 26 consultation notices qualification published 144 current language editions, including 98 with verified original notices. All nine acquisition failures matched known publisher gaps and the prior verified open editions remained available. The authenticated Worker check and independent R2 restore passed. The Mac's daily consultations and weekly notices steps have retired. [Qualification evidence](evidence/2026-11-26/consultation-notices-cloudflare.json)

The November 26 written-questions qualification completed in 24 minutes 37 seconds. Cloudflare rechecked all 3,476 listed editions and verified 16,109 referenced originals. The four existing coverage gaps remained visible. The authenticated Worker case passed. An independent R2 restore verified the serving database, migrations and matching source digest before the Mac weekly step retired. [Qualification evidence](evidence/2026-11-26/written-questions-cloudflare.json)

## Offline committee replay on Cloudflare

The private `civicsignal-stage-committee-replay` Workflow rebuilds the 45-1 SQLite preview from the pinned originals in R2. Run `python3 -B scripts/bootstrap-committee-replay.py` once to upload the sealed catalogue, original objects and acquisition database. Install the returned reference at `weekly/committee-replay/bootstrap.json`. The preview build replays the original publication dates, preserves the retained source archive, and verifies the resulting authenticated API routes before archiving the separate serving manifest.

Start the replay with `wrangler workflows trigger civicsignal-stage-committee-replay '{"scheduledTime":<epoch-ms>}' --id committee-replay-<epoch-ms> --config services/committee-replay/wrangler.jsonc`, substituting one new millisecond timestamp in both places. Read the dated R2 occurrence receipt and its report. The report's `servingState` pins the separate verified preview archive. The standing full committee schedule will need fresh official House and Senate inputs and a shadow D1 generation that also verifies the newer daily House calls overlay.

For a preview at the same verified weekly cutoff, the existing `materialize-committee-corpus.py --calls-only` operator reapplies the retained daily overlay and preserves its original observation timestamps. The replay verified all 30 editions, 60 links, and 40 publisher originals. Applying it twice produced zero additional writes. A different weekly cutoff requires validation of the carried-forward bilingual study links and a separate receipt linking the original daily observation to the new D1 generation. [Overlay replay evidence](evidence/2026-11-26/committee-offline-replay.json)

The private shadow operator verifies the same publisher receipt and requires the target preview to have a later weekly cutoff. It checks both language editions of every retained committee and study, then writes a separate SQLite output. The recorded test used the real earlier receipt and a controlled later cutoff. It preserved the original daily observation and restored all 60 links. [Shadow replay evidence](evidence/2026-11-26/committee-offline-replay.json)

```sh
python3 -B services/committee-replay/run.py carry-forward \
  --retained "$FROZEN_ACQUISITION" --receipt "$RETAINED_RECEIPT" \
  --originals "$ORIGINALS_ROOT" --base "$LATER_SHADOW_PREVIEW" --output "$NEW_SHADOW_SQLITE"
```

## Weekly local refresh

The weekly per-user LaunchAgent runs on Saturdays at 09:00 local time. The daily agent continues to run at 06:15. Both acquire the same kernel lock while publishing committees. A conflicting weekly or daily committee step exits with an error and can be retried independently. The other collections continue.

Cloudflare’s Saturday coverage Workflow owns ATI summaries, grant awards, briefing notes, CanadaBuys procurement, and the algorithmic assessment and briefing-package catalogues. The operators remain available for manual archive diagnostics. Both native workflows passed the five acquisitions. Independent R2 readback verified all 36 cited publisher originals. [Weekly cutover evidence](evidence/2026-11-26/weekly-federal-mac-cutover.json)

The hosted register and coverage Workflow also own federal catalogue discovery, government bibliography and checklist publication, Treasury Board and IRCC guidance, dated policy editions, and departmental HTML. The reported publisher gaps are still visible in the archived receipts. The Mac retains its report directories and issuer pages for its remaining edition and regulatory plan checks. [Federal parity and cutover evidence](evidence/2026-11-26/weekly-federal-parity-cutover.json)

GEDS, ECCC and departmental PDF acquisition now run only in the hosted coverage Workflow. Independent R2 readback verified both catalogues and the PDF workflow's 116 publisher originals, 116 extraction files and 32 archive notices. The PDF acquisition reported 105 verified and 12 review citations, matching the Mac. The scheduled run passed the GEDS lookup. The hosted replay of the exact scheduled archive passed both ECCC checks after the coverage test was corrected to follow the API cursor. [Source cutover evidence](evidence/2026-11-26/coverage-source-cutover.json)

```sh
python3 -B scripts/schedule/weekly.py install
python3 -B scripts/refresh-weekly.py --help
python3 -B scripts/refresh-weekly.py --status
python3 -B scripts/refresh-weekly.py --only committees
python3 -B scripts/schedule/weekly.py remove
```

Installation registers the job. It runs while the user is logged in. Removal unloads it and retains its databases and dated receipts. The installed command is `python3 -B scripts/refresh-weekly.py`. Read the dated report under `dist/refresh-weekly/` to see the command, exit status, disk headroom and serving checks for each source. A failed or skipped source makes the full run fail. A partial archive can still have successful verification of its available contents. The per-source command results retain both outcomes. `latest-full.json` records the last full attempt and `latest-successful-full.json` records the last complete success. A selective retry updates `latest-partial.json`. For an interrupted committee catalogue, `python3 -B scripts/refresh-weekly.py --only committees --resume-committee-catalogue` continues its saved acquisition and then runs the remaining publication and Worker checks. Scheduled runs begin a fresh catalogue.

| Collection | What the weekly operator does |
| --- | --- |
| Departmental report directories and editions | Refreshes the federal plans and results directories, Treasury Board’s plan cycles, and both editions of the government-wide list of institutional regulatory pages. The separate `departmental-report-editions` step archives issuer landing pages, records year-labelled plan and result links, and tracks discovery links from regulators. Its current report retains the last verified content and the latest attempt for each issuer. |
| Institutional regulatory plans | Follows forward-plan links from the government-wide directory to issuer pages, verifies the target, and records the original, named initiatives and stated plan cycles. |
| Committee corpus | Refreshes Senate meeting notices before extracting their publication links. The downloader checks the digest and timestamp of each parsed notice and fetches the other linked originals. The operator then builds the corpus, verifies its archived files, publishes to local D1, and tests bilingual retrieval. |

For a manual written-questions diagnostic, `python3 -B scripts/lib/wq_catalog.py --resume-partial-checkpoint` resumes a saved acquisition. The operator checks the new bilingual listings against the checkpoint, records which successful details it reused, and fetches the rest. Verify the answer archive and authenticated lookup after rebuilding the isolated preview.

The manual written-questions compactor checks whether the archive volume supports transparent macOS compression. On a supported volume it compacts checksum-named HTML under the archive writer lock. Every replacement must return the original bytes at the same path and occupy fewer disk blocks. To inspect a small batch on a supported host, run `python3 -B scripts/compact-written-question-objects.py --limit 12`.

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
