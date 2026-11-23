# Shared staging serving-request budget

The local relay enforces one cumulative allowance for the reviewed staging API origin. It performs no request on startup. Its only
upstream is the explicit HTTPS
`civicsignal-v1-stage-api-*.<account>.workers.dev` origin returned by the approved
stage deployment. There is no default target, production target, cross-origin
forwarding, redirect following, budget-reset flag or automatic stale-lock repair.

## November D-01 run packet

This packet is prepared for review. D‑01 needs **131 fresh relay attempts**, including up to 128 billable retrievals. Approve the exact staging origin, candidate, date window, and ledger before running it. The [historical ledger](V1-ZEN-RECHECK.md) retains its original **159/160** reservations and final single slot.

| Phase | Retrieval attempts | Discovery attempts | Cumulative ledger offset |
| --- | ---: | ---: | ---: |
| Calibration, with the fresh-evaluation header | 20 | 1 | 21 |
| Independent bilingual holdout | 64 | 1 | 86 |
| Benchmark at concurrency 1 and 4, with two warm-ups and 20 measured requests each | 44 | 1 | 131 |

Pin the exact qualified source and API Worker version to a fresh read of the active deployment, staging bindings, encoder model and image, and retrieval policy. Confirm migration 0009, settled D1 publication state, R2 provision text, and Vectorize visibility for the same served revision. Verify the staging key can cover up to 128 retrieval units. The November labels pin `855cdfc65207a6906c414e09a77d7f93267c5356` and parser `statutes-v2`. Capture the authoritative upstream observation before the run and use one provenance file for all three phases. A different served revision needs matching verified labels. An ancestor of the observed head needs separate approval and the D‑01 ancestry and age checks. [Dataset proof](V1-EVALUATION.md#november-revision)

The serving owner uses one fresh ledger for this scope after approval, one run per phase, and an approved finite window. Check the ledger offset, discovery response, and settled process state at each boundary. Confirm calibration readiness and freeze the policy before the independent holdout. A calibration-driven policy change requires a newly qualified candidate and reviewed packet before the holdout. Retain failed attempts and reports. A failed phase stops the run, and follow-up attempts require their own scope.

HTTP and MCP smoke checks have their own request scope. D‑02 needs up to eight staging POSTs and eight BYOK calls per qualified provider/model, with 256 requested output tokens per case. The positive Zen smoke needs a separately reviewed one-request successor capped at 128 output tokens. Its historical request packet binds the earlier API version and ledger. Preserve that packet and prove the identity of the successor before asking for a fresh budget. [Chat and Zen procedures](V1-EVALUATION.md#d-02-bilingual-chat-claim-review) · [Historical Zen packet](V1-ZEN-RECHECK.md)

## Start and use the relay

After approval, set `STAGE_API_ORIGIN` and `D01_LEDGER` to the actual reviewed origin and new ledger path. The ledger's parent directory must already exist.

```sh
bun scripts/staging-request-proxy.ts --target "$STAGE_API_ORIGIN" --ledger "$D01_LEDGER" --limit 131 --port 8788 --timeout-ms 60000
```

It binds only `127.0.0.1`. `--port 0` selects an available local port and prints
the actual loopback origin. Startup reports the actual upstream origin, limit,
reserved count and remaining count without credentials. Preserve that output
beside the evaluation evidence. A second process using this ledger is refused.
Use the printed loopback origin for every subsequent call, including all MCP
initialization, notifications and discovery requests. Do not follow links by
calling the deployment origin directly; that bypasses the enforced allowance.

The existing eval/bench target validator permits a loopback target while keeping
real deployment provenance `environment:"staging"`, `backend:"vectorize"` and the
actual deployed revision/parser/model/policy. The provenance `evidence.note` must explicitly name the actual stage origin,
this relay/ledger and the added local fsync/forwarding measurement overhead.
Use the operator's normal `CIVICSIGNAL_KEY` environment variable; do not put it
in a command or ledger.
For the fixed port above, set `STAGE_PROVENANCE` to the reviewed provenance file and `D01_REPORT_DIR` to a new reports directory. Use the verified November dataset and the declared `all` benchmark split. Run each command as its own phase after checking the prior result and ledger offset.

```sh
dataset=src/eval/data/v1-november-questions.json
relay_origin=http://127.0.0.1:8788
bun scripts/eval-v1.ts --target "$relay_origin" --provenance "$STAGE_PROVENANCE" --dataset "$dataset" --route /api/statutes --limit 10 --split calibration --calibrate-observed true --concurrency 1 --timeout-ms 65000 --output "$D01_REPORT_DIR/eval-calibration.json"
bun scripts/eval-v1.ts --target "$relay_origin" --provenance "$STAGE_PROVENANCE" --dataset "$dataset" --route /api/statutes --limit 10 --split holdout --concurrency 1 --timeout-ms 65000 --output "$D01_REPORT_DIR/eval-holdout.json"
bun scripts/bench-v1.ts --target "$relay_origin" --provenance "$STAGE_PROVENANCE" --dataset "$dataset" --route /api/statutes --limit 10 --split all --requests 20 --warmup 2 --concurrency 1,4 --timeout-ms 65000 --output "$D01_REPORT_DIR/benchmark.json"
```

Supply these reports, exact provenance, relay origin, and benchmark split to the [offline checker](V1-EVALUATION.md#d-01-serving-decision). It requires a successful discovery response with the reviewed encoder model and dimensions in each phase. The relay limits aggregate attempts even if the schedule is
larger or a runner restarts. It returns HTTP 429 after the allowance is spent;
those locally rejected requests do not reach the stage API. All upstream HTTP
attempts count, including transport failures, HTTP errors, timeouts, aborted
calls and MCP notifications that consume no product usage units. No reservation
is refunded. Local validation failures such as an oversized body are not
forwarded and do not consume the upstream allowance.

## Evidence and measurement scope

The ledger's first line contains only format, actual target origin and approved
limit. Subsequent lines contain only `seq`, `method`, `pathname` and ISO `time`.
They never contain query strings, request/response bodies, Authorization/BYOK
headers or API keys. The relay forwards those headers/body/query to the selected
stage origin without printing them. Keep API keys out of URL path segments.
Bodies are bounded to 128 KiB before reservation/forwarding. Redirects fail;
the deadline and caller-abort signal remain active through streaming MCP bodies.

Each attempt is appended and fsynced **before** its upstream send. The exclusive
process lock is held for the relay's lifetime. The ledger is bound to one exact
target and limit and persists across clean restarts. Header changes, missing or
extra fields, duplicate/gapped sequence numbers, over-limit records, a partial
trailing line, oversized/nonregular files and stale locks cause refusal. A
failed/uncertain reservation confirmation disables forwarding in that process;
a complete reservation found after restart is conservatively retained even if
no HTTP request can be proven to have left the relay.

Report these measurements as **real staging serving-path measurements through a
local request-budget relay**. Their end-to-end latency includes local request
body reading, native filesystem fsync and relay overhead; they are not direct
Worker-only latency or local-fixture retrieval results. Each response adds
`x-civicsignal-staging-target` and
`x-civicsignal-staging-proxy-prepare-ms` (also `Server-Timing:
staging_proxy_prepare`). Preparation time measures work before the upstream
send, including body reading and durable reservation; it does not isolate all
relay/response-network overhead. Keep the ledger and relay startup output with
the reports so their loopback `target.origin` can be traced to the actual stage
origin. Do not subtract the header value and claim an independently measured
origin latency.

## Stop, inspect and restart

Ctrl-C/SIGTERM stops the listener and removes its process lock while preserving
all reservations. Inspect the file without binding a port or making a request:

```sh
bun scripts/staging-request-proxy.ts --target "$STAGE_API_ORIGIN" --ledger "$D01_LEDGER" --limit 131 --inspect
```

Restart with the exact same target, limit and ledger path; no credits reset.
After an abrupt crash, the `.lock` is intentionally retained. Verify its owning
PID/process and listener have stopped, validate the existing ledger with
`--inspect`, and only then remove that exact stale `.lock` before restarting.
Do not remove a live process's lock. If integrity inspection fails, stop for
operator review: do not truncate, repair, delete or substitute a fresh ledger,
or increase its limit to continue the approved run. Preserve inconsistent
artifacts for diagnosis and reconcile attempted requests before any new budget
is approved.
