# Bounded staging recovery candidate

Status: the user approved this exact bounded recovery on 2026-10-23 at
13:53 UTC. The isolated recovery entry is deployed as
`573be17a-e46c-4431-a97b-a24a5c2c8b60`; its verified one-time grant preserves
all 1,112 spent attempts and permits 640 more document attempts across at most
20 encoder calls. The first recovery attempt paused after six calls at 13:57 UTC:
1,304 cumulative document attempts are spent, 448 document slots and 14 calls
remain. The original object is suspended at revision 3, quiescent, with no alarm.
Its persisted failure is classified unknown. No contingency resume has occurred.
See the [attempt receipt](evidence/2026-10-22/stage-recovery-approved-attempt-1.json).
Completion and the new reported progress are not yet independently verified.
The original 1,112-document staging reconciliation failed its bound. Its result
and [stop evidence](evidence/2026-10-22/stage-pipeline-budget-stop.json) remain part
of release acceptance. A recovered result must retain that history.

## Observed starting state

At 2026-10-23 12:52 UTC, the original stage coordinator was suspended at revision
1, quiescent, with no alarm and pending recovery. Its budget is still cap 1,112,
submitted 1,112, remaining zero. The current failure classification is budget
exhaustion; it does not reconstruct earlier overwritten errors.

The exact stage identities are:

| Resource | Identity |
| --- | --- |
| Account | `ad5ec479b9a421faa2ed06c3d1c2b23a` |
| Pipeline Worker | `civicsignal-v1-stage-pipeline-20261022` |
| Coordinator namespace | `751026e8a12f46dc87f829d44cef4221` |
| Coordinator object | `5f57efc844823b53825d844574680ed1be6d0c372a32db23482639a321ca9504` |
| D1 | `e0fa8e43-82f9-4864-b237-6e82d77a860c` |
| R2 | `civicsignal-v1-stage-corpus-20261022` |
| Vectorize | `civicsignal-v1-stage-statutes-20261022` |
| Encoder | `civicsignal-v1-stage-encoder-20261022`, maximum one instance |

The source remains commit `0507465393c224c0491fc8c17c88340217acc656`, date
`2026-10-15`, parser `statutes-v2`, index digest
`b9b9ad97092ae2c5b4a35580f0cafe73`. Independent paused reads checked all 1,112
expected changed fingerprints: 600 match the target and 512 remain. The ordered
remaining-ID SHA-256 is
`a7fd7991e5cbdbfe40ecec3ca0c0391d0a294060218788d80cc0a42f1589a5fa`.
All 277,857 corpus rows have matching text references, retained D1 text is empty,
there are 600 completed mutation identities, no pending outbox and no published
new run. A fresh execution preflight must confirm these facts again.

## Proposed additional allowance

Preserve the original budget key, coordinator object and all 1,112 spent attempts.
One exact atomic replacement would record the reviewed authorization and increase
the cumulative document-attempt ceiling to **1,752**, adding **640** slots.
There is no reset, refund, fresh coordinator or allowance replenishment.

The extension also reserves at most **20 additional encoder HTTP attempts**, with
at most **32 documents per attempt**. The 512 unfinished changes need 16 full
successful batches; at most 128 document slots and four full-batch call slots
remain for reviewed retry/uncertainty. Partial batches and uncertain reservation
acknowledgements consume their slots too. Either exhausted ceiling stops work.

Snapshot ingestion now commits each successful provider batch before requesting
the next. The recovery entry must pause admission on failure before arranging
any retry. It must not spend contingency automatically. A later operator resume
requires review of the failure and the current revision; every attempt remains
inside both cumulative ceilings. A storage outage can make the pause uncertain;
the durable budget remains a separate bound. An accepted model request cannot be
cancelled or refunded.

The compiled authorization is limited to this exact source/object transition.
Normal production budget behavior continues to refuse cap changes. The extension
must start with the original paused revision and no alarm. Reconstructed objects
must recognize the same receipt and counters without granting again. A compatible
stop build must accept an already recorded extension while refusing to create one.

## Review and execution sequence

1. Freeze the compiled authorization, source/config/bundle hashes and local proof.
   Run the complete release gate and independent review. Prepare the compatible
   stop build and finite observation controls before requesting approval.
2. Obtain explicit user approval for the additional 640 document slots, 20 encoder
   calls and their staging storage/compute usage. Existing 160 serving-request
   and one-encoder limits stay in force; 14 serving requests are already reserved.
3. Re-read the exact stage account, active version, bindings, original namespace,
   suspended object, source tuple and remaining diff. Stop on drift or a nonempty
   pending outbox. Keep all calendars off.
4. Deploy only the reviewed isolated recovery entry. Its first initialization can
   record the extension even when reached by a control GET; this mutation must
   happen only after approval. Verify the exact embedded receipt, cap 1,752,
   submitted 1,112, zero new reserved calls and unchanged paused state/D1 data.
5. Resume the current suspended revision through the existing authenticated
   control route. Observe the pending continuation with finite deadlines. On
   failure, preserve state and review before any contingency resume. On identity
   drift, unknown failure, exhausted bound or uncertain stop, halt.
6. Completion requires actual v2 publication/run, all 1,112 expected changed
   identities, no pending outbox, complete row/text/fingerprint checks and final
   cumulative counters. Suspend/drain again before final vector backup and
   visibility checks. Preserve the original failed test and measured recovery.

This proposal does not authorize production changes, Railway changes, deletion,
another full snapshot build, a serving-request increase or generation-provider
usage. Scheduled Snapshot discovery, post-reconciliation protocol/quota checks,
held-out quality/performance, positive BYOK generation and production cutover
remain separate release gates.

## Prepared implementation and proof

The fixed authorization core SHA-256 is
`26b6b13a511ac3f55e07bffc08686f8997addc88425838564bbf789d256e5b13`.
The optional recovery entry is `services/pipeline/staging-recovery.ts`; normal
configs do not select it. The budget grants only on the exact original exhausted
record and admission revision. Its one-key receipt couples cumulative documents
and call reservations. A verify-only successor can pause an existing grant and
cannot initialize one. Recovery reconstruction conservatively suspends open
pending work before external events, including after a failed pause write.

The focused gate passes 181 checks in ten files, including 33 new unit tests and
eight real local workerd cases. The complete local gate passes 944 tests across
79 files, four compiler projects, runtime probes, invariants and five builds.
See the [complete gate receipt](evidence/2026-10-22/recovery-candidate-local-validation.json).
The positive workerd fixture supplies the fixed policy identity because its local
namespace differs; the actual entry separately refuses the wrong local object.
These local proofs do not attest a hosted grant or successful recovery.
The [candidate receipt](evidence/2026-10-22/stage-recovery-extension-candidate.json)
pins the recovery/stop bundles and the frozen operator manifest. The subsequent
approved execution must retain that candidate and the original failed result.
The [independent review](evidence/2026-10-22/stage-recovery-extension-independent-review.json)
matches the frozen runtime and operator hashes and reports no remaining actionable
findings. It records the fixed failure/reconstruction, deployment-guard and final
completion issues with their proof limits.

The prepared operator packet refuses deployment or resume without a matching
trusted approval receipt, frozen artifact hashes and fresh original-state proof.
Its finite monitor resumes once, reads mutation uncertainty from the same object,
pauses after completion/failure/deadline, and never resumes contingency itself.
It permits at most 88 control operations, with a 20-minute observation deadline
plus finite stop/drain checks. Every request has a 15-second deadline and bounded
body. If stop remains uncertain, use the compatible reviewed verify-only stop
build. Preserve all started markers and receipts.

A final successful run may report only its remaining changes. Failed earlier
cycles did not publish run summaries. Acceptance therefore checks the complete
1,112 feed and completed mutation identities against the frozen target, rather
than requiring successful run counters to reconstruct those failed prefixes.
