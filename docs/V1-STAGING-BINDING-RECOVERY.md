# Resolve the uncertain staging source binding

The dedicated public-read-only GitHub token was created through the browser after
explicit user confirmation. Its issuer expiry date is October 24, 2026. The token
is stored privately and is approved only for the isolated staging pipeline's
`GITHUB_TOKEN` binding. No token value belongs in this report or its evidence.

The pre-binding read passed. One secret PUT began at 21:12:59 UTC on October 23.
The operator returned `binding-uncertain-no-retry` at 21:13:01 UTC. It retained the
intent, failed receipt and journal, but not the HTTP status or response body.
This establishes an attempted write; it establishes neither refusal nor a received
successful acknowledgement. No second PUT followed it. The independently
reconciled authenticated probe and single recovery continuation are recorded below.

The current Cloudflare API schema permits a `text` field in a successful secret
update response. The prepared binding validator rejects that field. This is a
possible explanation for the command failure, not evidence of the actual response.
See the [Cloudflare secret-update schema](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/).

## First observation

Use a separate, reviewed read-only operator. Preserve the original failed binding
receipt and every consumed marker. Do not repeat the write to learn its outcome.

The observation permits exactly four management GETs: deployments, the discovered
sole active version, settings and schedules. One authenticated GET reads the
original staging coordinator's control state. Each request has a 15-second total
deadline; management/control bodies are capped at 256 KiB/16 KiB. Requests are
serialized with at least 334 ms between starts. The owned process has an 80-second
deadline and at most 10 seconds of cleanup. There are no retries, redirects,
credential refreshes, source requests, serving requests or model calls.

Require the original resource identities, exact runtime and binding inventories,
empty schedules, and the original suspended/drained revision-3 checkpoint at
1,304 submissions and six extension calls. Determine whether the only binding
addition is the name/type `GITHUB_TOKEN`/`secret_text`. Never request a secret value.
Link the observation to the original preflight, failed PUT receipt/journal,
private credential approval and independent root review by digest.

A matching name-only readback can establish binding presence and current version
identity. It cannot establish that a successful PUT acknowledgement was received
or independently prove the secret's value. Record this distinction. Unexpected
bindings, runtime, version activity, schedules or coordinator state stop the plan.

## Observed outcome

The reviewed v2 reader completed at **21:41:51 UTC on October 23**. All five GETs
settled successfully. The sole active version was
`f42a444b-1ff7-42bb-9ccb-bb46d6e1a743`. Its version/settings inventories contained
the exact expected 12 bindings, including `GITHUB_TOKEN` as `secret_text`, and
matched the expected runtime. Schedules were empty. The original coordinator
remained suspended and drained at revision 3, with **1,304 submissions, six
extension encoder calls and 448 document attempts remaining**.

The observation digest is
`15d765360572a9ba9b193ed11c2dd2d8775d9291ea3c1018aa21a39291578994`;
the reader candidate digest is
`9ae49849bb8550871f6ff06c41b90861c0ddc6d343ef9a2057eebbe0d20bb277`.
The [root validation](evidence/2026-10-23/staging-binding-readback-root-validation.json)
checks the owned result, chronology, exact five-request journal and receipt digests.
The owned child exited 0 and settled before the result was recorded. No source,
model, serving or mutation request occurred. The original write remains
unacknowledged, and this diagnostic does not authorize continuation by itself.

The first reader's local launch failure is preserved separately. Its Node guard
rejected a numeric macOS-injected encoding variable before selecting credentials
or making any cloud request. The v2 guard validates that variable's bounded
numeric format and current UID; its real owned launch check passed before the
five-GET observation.

## Continue with an honest evidence chain

If readback matches, prepare sibling source and continuation operators. They must
admit an explicitly reconciled binding observation and preserve the original
uncertain write. Never overwrite `binding.json`, change its failure into success,
or claim that a new operator executed the old operator manifest.

The old source operators, continuation and deployment envelope require the old
binding acknowledgement and cannot be used across this gate. New operators need
their own manifests, receipt paths, private root reviews and durable intents.
They can reference the unchanged authenticated-stop, recovery and stop runtime
bundles/configurations. Keep the original coordinator, grant, claim history,
encoder and resource identities.

Before the authenticated-stop deployment, perform a fresh bounded readback.
Verify the deployed version independently. Then make the one previously planned
durable authenticated source-head probe. Require HTTP 200, the exact approved
commit/date and at least 16 requests of reported source headroom before the one
explicit recovery resume. A working source probe establishes operational access;
attribution to the dedicated token also relies on no independent binding writer.
Do not create another probe claim to bypass a failed or uncertain probe.

Use a new no-refresh deployment envelope with the same owned CLI limits and exact
runtime/configuration pins. Freeze the actual new continuation manifest before
preparing downstream metadata, text, vector and fresh-completion qualifiers.
A small upstream chain-reference capsule may avoid duplicating validators. It
must not contain future descendant hashes that create a dependency cycle. Retain
the large expected-row ledger and baseline artifacts by reference.

The prior frozen packets remain historical evidence. New qualifying receipts must
name the code and lineage that actually ran. Stop after uncertainty; no automatic
contingency resume or mutation retry is introduced.

## Limits and acceptance

This repair adds no secret PUT and no usage allowance. Existing ceilings remain
1,752 cumulative document attempts, 20 extension encoder calls, one encoder and
160 cumulative serving attempts. The completed recovery monitor reports 1,624
submissions and 16 extension calls, with 128 document slots and four calls left.
The last independent metadata read verified 792/1,112 changes; a final full
metadata scan remains pending. Production and Railway remain
outside this staging approval.

Acceptance requires actual readback, an independently verified deployment and
source observation, one bounded continuation, then independent completed metadata,
text and vector proofs. Prepared operators and local fixtures do not satisfy
those hosted gates. Root must review each new frozen artifact before execution.

## Authenticated recovery outcome

The new authenticated-stop deployment and independent post-verification passed.
The one durable authenticated source claim completed at **22:28:24 UTC** with
HTTP 200, source commit `0507465393c224c0491fc8c17c88340217acc656`,
date `2026-10-15`, and reported quota **4,999/5,000**. Its receipt digest is
`559bbf718e7bfca6ba9d744cfbb8c702ef1f05c542fc52959b42322b2e2b1955`.
This proves working authenticated source access. The original secret-write
acknowledgement remains false; no token value was returned by the readback.

The recovery deployment `e38e0ca3-b874-4e8b-8440-f86970e161b4` was acknowledged
and independently verified before the single explicit resume. The monitor
completed at **22:34:18 UTC**. It then suspended the original coordinator at
revision 5: no pending work, failures, active run, queued run, handler or alarm.
Counters are **1,624 submissions and 16 extension calls**. The owned monitor
settled with exit 0; its result digest is
`46d39477cfe6b0eba186542b7afdc1c4af1af888f321b56c68340a5d10084c0b`.
The [root validation](evidence/2026-10-23/staging-source-recovery-root-validation.json)
records these actual receipts and the unchanged limits.

Independent final metadata, text and vector checks remain required. The prepared
metadata verifier's five-minute admission window elapsed during handover before
its first attempt. Preserve that packet. A new packet must admit the original
monitor historically and check the current deployment, bindings, schedules and
exact paused coordinator before any D1 query. It must retain the original
timestamps, claims, revision and usage; no new ingestion resume is needed.
