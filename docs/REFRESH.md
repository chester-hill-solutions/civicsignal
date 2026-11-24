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

Each step writes its own receipt under `dist/refresh/receipts/`. The run report lands at `dist/refresh/<timestamp>.json` and `dist/refresh/latest.json`:

```json
{
  "startedAt": "2026-11-25T11:15:00.000Z",
  "ok": true,
  "durationMs": 168000,
  "steps": [
    { "name": "consultations", "ok": true, "durationMs": 5100,
      "summary": { "counts": { "added": 0, "removed": 0, "unchanged": 5208 } } },
    { "name": "committee-calls", "ok": true, "durationMs": 31000,
      "summary": { "calls": 30, "added": 0, "changed": 0, "dropped": 0, "pending": 2, "conflicts": 0 } },
    { "name": "funding", "ok": true, "durationMs": 152000,
      "summary": { "sources": [{ "source": "esdc", "events": { "changed": 0 } }] } }
  ]
}
```

A quiet day shows zero additions, removals and changes in each summary. A step that reports changes you did not expect is the signal to open its receipt and the collection's contract before trusting the serving data.

A lock file (`dist/refresh/lock.json`) stops two runs overlapping. A lock whose process is gone, or that is more than two hours old, is replaced.

## Scheduling on macOS

```sh
scripts/schedule/install-daily.sh     # launchd agent, daily at 06:15 local
scripts/schedule/uninstall-daily.sh   # remove it; local data stays
launchctl kickstart -k gui/$(id -u)/com.civicsignal.refresh-daily   # run now
```

The agent runs `bun scripts/refresh-daily.ts` with the repository as its working directory and appends to `~/Library/Logs/civicsignal-refresh.log`. It is a per-user agent: it runs when you are logged in, and it does not run missed schedules after a shutdown. Check `launchctl print gui/$(id -u)/com.civicsignal.refresh-daily` when a run does not appear.

On Linux, use the same command from cron:

```
15 6 * * * cd /path/to/civicsignal && /path/to/bun run refresh:daily >> "$HOME/.local/state/civicsignal-refresh.log" 2>&1
```

## What stays off the daily job

| Collection | Cadence | Why |
| --- | --- | --- |
| GEDS directory | Weekly, or change-triggered | The export's `Last-Modified` was 2026-10-25 when imported on November 24; a full import takes ~7 minutes and the snapshot is ~1.1 GB |
| Full committee corpus (catalogue, download, expand, corpus) | Weekly | Walks thousands of originals; the calls intake already refreshes the time-sensitive surface |
| Parliamentary catalogues, Journals, written questions | Weekly operator run | Follow the routine checks in [the plan](PLAN.md#routine-current-session-refresh) |

Use the daily report as the reliable signal for the three fast collections, and run the weekly sets by hand until their publication intervals are measured the same way.

## Failure handling

- A failed step keeps the previous serving data; every intake publishes transactionally and refuses an older observation.
- Re-run the same command after fixing the cause. Identical input adds no records and no change events.
- A publisher defect that the intake cannot resolve is reported, not hidden: committee calls expose `pendingChange` and `contentConflict`, and consultations expose `stale` and `removed` counts.
- Keep the receipts. They are the dated evidence that a quiet day was quiet, rather than a failed fetch.
