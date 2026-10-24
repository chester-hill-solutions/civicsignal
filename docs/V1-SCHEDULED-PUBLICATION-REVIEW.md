# Scheduled first-publication qualification review

Status: preparation only, 2026-10-24. Scheduled discovery and first publication
remain open. This review authorizes no deployment, event, source request, storage
copy or allowance extension. Preserve the existing manual Workflow and backup.

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

## Smallest next qualification

Extend the existing snapshot path with a stage-only qualification mode that uses
both a fresh physical R2 namespace and a distinct deterministic Workflow instance
ID. Keep the genuine source commit/date and `statutes-v2` parser identity. Reuse
the same source checks, parser, builder, manifest-last publication and verifier.
No fake source revision or parser label may manufacture a missing publication.

Before a hosted proposal is executable:

1. Review namespace isolation for every bucket operation used by the builder,
   including staging, list/cursor behavior, publication, readback and cleanup.
   Verify that no operation can read, overwrite or delete the canonical backup.
2. Bind the qualified instance ID, output namespace, genuine revision and exact
   event tuple together. A duplicate event must select the same instance and
   must not restart a failed or uncertain source attempt automatically.
3. Add bounded diagnostics before controller-tuple rejection. Record only a
   fixed marker and safe controller/configuration facts; invalid events must
   still fail before source work. Preserve uncertainty when receipt persistence
   fails; a log line alone is not successful publication evidence.
4. Enumerate and enforce source attempts across scheduled discovery, Workflow
   source checks, archive acquisition, retries and restarts. The current
   Workflow retry configuration does not justify a hard three-request source
   ceiling. Review a durable attempt cap or an explicitly bounded retry design
   before presenting any numerical allowance for approval.
5. Prove local behavior for absent publication, an existing qualified manifest,
   canonical/qualified coexistence, concurrent duplicates, lost acknowledgements,
   source failure, publication-last integrity and cleanup isolation. Exercise the
   actual scheduled entry point in the native Workers runtime.
6. Freeze the reviewed bundle/config and owned operator. Specify a future UTC
   event with sufficient confirmed propagation time, credential validity through
   cleanup, independent cleanup guards, finite observation windows and a finite
   complete request/storage budget. A missed admission window means no arming.

Successful hosted evidence must connect the admitted scheduled event to the
distinct instance, show no qualified manifest before the event, and show that
instance creating and publishing its complete snapshot. Verify every qualified
artifact against the pinned reference: the existing complete reference has
240 artifacts totaling **390,423,509 bytes**, plus verification of all 277,857
rows. Count additional qualification diagnostics separately. A health fetch,
manual API creation, an existing-publication no-op or absent metrics cannot close
this gate. Reconcile the canonical backup unchanged and the calendar empty.

This proposal remains local work to implement and review. Another hosted event
requires its own concrete approval; the original serving ledger and embedding
coordinator are unrelated and must not be reset or spent for this qualification.
