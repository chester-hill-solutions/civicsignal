# Shared staging serving-request budget

The local relay enforces one cumulative allowance of **160 HTTP/MCP attempts**
for the approved staging API origin. It performs no request on startup. Its only
upstream is the explicit HTTPS
`civicsignal-v1-stage-api-*.<account>.workers.dev` origin returned by the approved
stage deployment. There is no default target, production target, cross-origin
forwarding, redirect following, budget-reset flag or automatic stale-lock repair.
No hosted request or hosted metric is established by the local relay tests.

All manual smokes, MCP messages/notifications, eval discovery, warmups, measured
calls and retries must use this same loopback relay and ledger. A separate direct
encoder-origin HTTP smoke is omitted. Use one proxied stage API semantic smoke
and its successful serving encoder observation to verify hosted query inference
with the configured stage encoder service/secret and pinned model. Deployment
image/pin verification is a separate read-only metadata check. The proposed
allocation remains 20 calibration + 64 holdout + 44 benchmark retrievals, their
three discovery calls, and 21 manual smoke/protocol calls: 152 planned attempts,
with eight shared diagnostic/retry attempts. Failed attempts consume allowance.

## Start and use the relay

Set `STAGE_API_ORIGIN` to the actual reviewed stage API origin. Create the local
parent directory, then start one relay process in a dedicated terminal:

```sh
mkdir -p dist/release/staging
bun scripts/staging-request-proxy.ts --target "$STAGE_API_ORIGIN" --ledger dist/release/staging/serving-requests.jsonl --limit 160 --port 8788 --timeout-ms 60000
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
For the fixed port above, example commands are:

```sh
bun scripts/eval-v1.ts --target http://127.0.0.1:8788 --provenance dist/release/staging/provenance.json --route /api/statutes --split calibration --calibrate-observed true --concurrency 1 --timeout-ms 65000 --output dist/release/staging/eval-calibration.json
bun scripts/eval-v1.ts --target http://127.0.0.1:8788 --provenance dist/release/staging/provenance.json --route /api/statutes --split holdout --concurrency 1 --timeout-ms 65000 --output dist/release/staging/eval-holdout.json
bun scripts/bench-v1.ts --target http://127.0.0.1:8788 --provenance dist/release/staging/provenance.json --route /api/statutes --requests 20 --warmup 2 --concurrency 1,4 --timeout-ms 65000 --output dist/release/staging/benchmark.json
```

Verify the selected dataset contains the approved 20/64 split before sending
these commands. The relay limits aggregate attempts even if the schedule is
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
bun scripts/staging-request-proxy.ts --target "$STAGE_API_ORIGIN" --ledger dist/release/staging/serving-requests.jsonl --limit 160 --inspect
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
