# Staging source access recovery

The one-shot anonymous observation on 2026-10-23 at 19:16 UTC returned HTTP 403
with GitHub primary quota limit 60, used 60 and remaining 0. The reported reset
is 19:36:41 UTC. This establishes current exhaustion, not the cause of the earlier
saved HTTP 403 or who consumed the quota. Waiting for reset cannot reserve quota.
See the [observation](evidence/2026-10-22/stage-source-head-quota-exhausted.json).

The selected remedy is a dedicated, expiring read-only GitHub credential for the
public `justicecanada/laws-lois-xml` source, supplied through a private local file
path explicitly approved for the isolated staging pipeline. Do not reuse a
personal CLI token or connector credential. Never put the value in arguments,
source, configs, receipts or logs. Existing Worker code already accepts the
`GITHUB_TOKEN` secret for source checks. Credential availability remains pending.

Prepare and independently review the complete operator chain before using the
credential or changing the deployed binding:

1. Preserve the consumed anonymous probe, original failed verification, all
   started markers, old manifests, allowance grant and spent usage.
2. Verify the current stop-only version, original namespace/object, exact stage
   bindings, empty calendar and paused 1,304-attempt/six-call/revision-3 state.
3. Add only the approved `GITHUB_TOKEN` staging secret. Account for any version
   or deployment change caused by the secret operation and verify live bindings.
4. Use a separately named immutable authenticated one-shot probe. Claim and sync
   its attempt before one fixed metadata request with a 15-second total deadline,
   1 MiB body limit, no redirect and no retry. Return only status, the checked
   commit/date and allowlisted numeric quota fields. No token or raw body returns.
5. Admit continuation only on a fresh successful source pin and usable quota
   with at least 16 requests remaining. Finishing 320 rows requires 10 successful
   encoder submissions and 11 source checks; all 14 remaining encoder-call slots
   plus the diagnostic need at most 16 source requests. Headroom is not reserved.
6. Rebind the reviewed continuation and independent completion/backup proofs to
   the actual new candidate/version and exact secret-name inventory. Resume once
   only after fresh live checks. A failure pauses and requires another review.

Keep source commit `0507465393c224c0491fc8c17c88340217acc656`, date `2026-10-15`,
parser `statutes-v2` and index digest `b9b9ad97092ae2c5b4a35580f0cafe73` fixed.
The same original coordinator retains cap 1,752, submitted 1,304 and six of 20
extension calls spent. No reset, refund, allowance increase or new coordinator
is part of this remedy. The 160 serving-attempt and one-encoder limits remain.

The current stop-only deployment remains active until the reviewed replacement.
No production, Railway, resource deletion or production credential change is
included. This document is preparation, not evidence of authenticated access,
successful ingestion or a completed release.
