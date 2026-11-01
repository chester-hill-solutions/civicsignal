# Scheduled first-publication qualification review

The [master plan](PLAN.md#mp-02-qualify-scheduled-first-publication) owns scope and work order.
This review records qualification constraints and local evidence.

Status: local implementation and full local checks pass, 2026-10-24. Hosted
scheduled discovery and first publication remain open. This review authorizes no
deployment, event, source request, storage copy or allowance extension. Preserve
the existing manual Workflow and backup.

## What the retained event establishes

The singleton `40 1 24 10 *` schedule was confirmed at
`2026-10-24T01:05:21.558Z`, **34m38.442s** before the 01:40 event. Both cleanup
guards independently removed it and checked an empty calendar after 01:45. The
[retained observation](evidence/2026-10-23/staging-cron-0140-root-observation.json)
records the identities, exact request scope and final state.

Cloudflare documents Cron propagation as taking up to 15 minutes. The confirmed
lead exceeded that allowance; short setup time is not supported as the cause.
The allowance is a documented propagation period, not proof that this event
executed. See the [primary Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

The final read at 01:45:34 queried scheduled metrics only through 01:45 and found
no rows. The entered/completed/failed objects were absent; the historical health
control was present. These observations cannot distinguish no invocation,
preclaim rejection, receipt-write failure, later invocation or delayed metrics.
No platform cause or actual source-call count was established.

## Why replaying the current probe cannot close the gate

In [staging-probe-receipts.ts](../services/snapshot/staging-probe-receipts.ts),
`runStagingProbe` validates the controller cron/time tuple before any marker or
receipt. A rejected tuple can therefore leave no event observation. Its durable
conditional entry claim correctly prevents an uncertain or duplicate invocation
from repeating the source attempt; retain that property.

In [staging-probe.ts](../services/snapshot/staging-probe.ts), the delegate calls
`runSnapshotScheduled` with `requirePublished:true`. The shared
[scheduled implementation](../services/snapshot/worker.ts) returns immediately
for an existing manifest and refuses a missing manifest in that probe mode.
Even a completed probe would prove existing-publication discovery only.

The canonical Workflow ID and canonical manifest already belong to the successful
API-created run. Changing only an output prefix could still reuse that completed
instance. Deleting the known-good manifest would destroy evidence without solving
the instance-identity collision.

## Implemented local qualification

The stage-only [qualification entry](../services/snapshot/qualification-worker.ts)
uses both a fresh physical R2 namespace and a distinct deterministic Workflow
instance ID. Its identity binds the genuine source commit/date, `statutes-v2`
parser, exact controller tuple and a fixed **15-minute source-start window**.
That window is our chosen spend-admission cap, not a Cloudflare delivery promise.
Source claims and actual sends refuse early/late admission; an archive that has
already started may finish within its separate 60-minute stream bound.

The [scoped bucket](../services/snapshot/qualification-store.ts) prefixes all
builder operations, binds opaque list cursors to their exact prefix and permits
deletion only within qualified staging objects. The
[shared Workflow](../services/snapshot/snapshot-workflow.ts) keeps one parser,
builder, manifest-last publication and cleanup path for canonical and qualified
runs. Neither the source revision nor parser label is fabricated.

There are exactly three durable source phases: discovery, authoritative commit
check and archive. Each conditional claim needs an acknowledged object and exact
readback before its sole transport call. Failure or lost acknowledgement spends
the claim; duplicate events and Workflow restarts cannot refund it. Qualification
source-step retries are disabled. Canonical retries remain unchanged. Invalid
controller tuples have fixed bounded diagnostic slots before rejection; arbitrary
tuples cannot choose new object names or spend a source attempt.

Local tests also reproduced a canonical publication defect: a valid gzip ending
inside the second tar entry could publish a partial one-row manifest. The new
[shared archive adapter](../services/snapshot/archive-source.ts) checks framing,
checksums, numeric-field termination, entry sizes and complete gzip/tar drain
before the staging step returns a publishable plan. It retains the existing tar
content reader and XML parser. It bounds compressed/expanded bytes at 1/2 GiB,
ordinary entries at 16 MiB, long names at 4 KiB and the stream at 60 minutes.
Its deadline checks also run after claims and at send/read/completion boundaries,
so a starved timer alone cannot admit late work.

The native canonical regression exhausts all four archive attempts and reaches
`errored` without a manifest. Its negative control bypasses only framing and
reproduces the partial publication. The native qualification fixture executes
the real scheduled entry and Workflow, preserves canonical objects, verifies
both fixture rows and retains the three-attempt ceiling after a real restart.
It uses a tiny synthetic bilingual archive, not the complete corpus.

The [root validation](evidence/2026-10-24/snapshot-acquisition-local-root-validation.json)
passes **1,689 tests in 97 files**, 23 Python cases, four compiler projects and
five Worker dry builds. All 448 source inputs were unchanged across those checks.
Focused snapshot checks (overlapping the full suite) pass 100 pure/regression
and 16 native cases; an independent reviewer passed 64 focused cases. Original
serving usage remains 159/160. No new hosted operation occurred.

## Before a hosted proposal is executable

The [offline preparation CLI](../scripts/prepare-snapshot-qualification.ts) now binds source pins, rebuilt bundle bytes, empty-cron configuration, reference evidence, and named budgets.
Its [48-case validation](evidence/2026-10-31/snapshot-proposal-local-validation-v2.json) covers drift, undercounts, output reuse, and failed persistence.
Exact reference copies reside in tracked evidence so clean checkouts can reproduce these checks.
The CLI emits only an unapproved proposal, bundle, and empty-cron config.
It selects no credentials and makes no network request.
Declared allowances remain distinct from runtime enforcement; `executionReady` stays false.
The checker requires at least 33,810 known custom-metadata key/value bytes for the 483 payload objects.
This floor differs from the 18,711 local sidecar bytes and does not measure provider overhead.
The owned execution operator and the dependencies below remain open.

Safe source diagnostics now pass 119 pure checks and 11 native checks on October 31.
Discovery receipts and archive Workflow errors retain typed codes, actual observed HTTP status, and safe quota facts.
They exclude raw bodies and exception text.
See the [local receipt](evidence/2026-10-31/snapshot-diagnostics-local-validation.json).
These changes apply to future failures. No source request ran or historical receipt changed.

The [reference accounting](evidence/2026-10-31/snapshot-reference-accounting.json) separates 486 local archive files from 243 logical intermediate R2 objects.
The 243 local metadata sidecars represent custom metadata; they are not separate R2 objects.
A successful single pass uses 986 logical R2 calls, including one staging cleanup pass.
This baseline excludes retries, duplicate invocations, failure branches, management, guards, artifact verification, and accounting overhead.
It supplies no approved ceiling or capacity claim.

1. Preserve the qualified diagnostics and their regression checks in the frozen source.
2. Freeze the reviewed bundle/config and owned operator, using the same isolated
   resource identities and no automatic schedule. Verify that the selected
   namespace and instance do not exist, and reconcile the canonical backup.
3. Enumerate a complete finite operator, R2, storage and verification budget.
   The runtime's three-source-attempt cap does not supply these other budgets.
   Current-source admission uses the budgeted discovery request; an additional
   prearm source probe is not included in that three-request allowance.
4. Select one future UTC event with sufficient confirmed propagation time,
   credential validity through cleanup, independent cleanup guards and finite
   observation windows. A missed admission window means no arming. Obtain the
   separate concrete approval before deployment/arming or source work.

Successful hosted evidence must connect the admitted scheduled event to the
distinct instance, show no qualified manifest before the event, and show that
instance creating and publishing its complete snapshot. Verify every qualified
artifact against the pinned reference: the existing complete reference has
240 artifacts totaling **390,423,509 bytes**, plus verification of all 277,857
rows. Count additional qualification diagnostics separately. A health fetch,
manual API creation, an existing-publication no-op or absent metrics cannot close
this gate. Reconcile the canonical backup unchanged and the calendar empty.

The local implementation does not close this hosted gate or establish a new
full-corpus 128-MiB measurement. Another hosted event requires its own concrete
approval; the original serving ledger and embedding coordinator must not be reset
or spent for this qualification.
