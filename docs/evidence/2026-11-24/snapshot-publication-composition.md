# November 24 staged statutes publication readiness

Aboiteau Work reviewed the acceptance criteria in turn `turn_8395bdcc-62c7-44f1-aa69-8d3076db7569`. Its retained reply called for the pre-event namespace and instance checks, event-bound publication evidence, and independent cleanup. The live provider observations below came from the operator.

The local operator composition passed its focused checks at checkout base
`a353f344214dbb9ceed6802726d44226ad76d2b1` with the working-tree patch. The check
used Bun 1.3.5 and Node 24.22.3 on macOS arm64. Nine Vitest files passed 231
checks with fixture calendars, credentials, provider evidence, and artifact
inputs. The composition success fixture supplies the artifact verifier result.
Separate tests exercise the real streaming verifier and its November staging
object routing. [Composition checks](../../../test/snapshot-publication-window.test.ts) · [Calendar checks](../../../test/snapshot-calendar-window.test.ts) · [Artifact checks](../../../test/verify-snapshot-artifacts.test.ts)

| Phase | Local check |
| --- | --- |
| Before arming | Load the pinned November packet and recompute its qualification identity. Match the prepared config hash and reviewed Worker deployment, version and Workflow ID. Require current source, an empty namespace, absent candidate manifest and instance, and matching canonical backup bytes and digest. |
| Scheduled calendar | Call the existing isolated Worker calendar runner with the exact packet window. Both independent cleanup writes require an acknowledgement and empty readback. The independent final read also requires an empty calendar. One lost cleanup acknowledgement fails qualification and retains the readback. |
| First publication | Match the completed Workflow output to the instance, namespace, revision and row count. Check scheduled admission, discovery, delegation, first-publication outcome and all three source reservation receipts. Fail on evidence of reuse, failure or uncertain work. |
| Artifact verification | Run the existing bounded streaming verifier only after the calendar and first-publication evidence pass. Its November pins require 238 artifacts, 389,760,843 bytes and 277,666 rows. It also hashes the canonical October manifest before and after the scan. |

The operator entry takes explicit preflight, deployment, Workflow outcome and
artifact adapters. Its admission and observation deadlines send an abort signal
to the active adapter and stop the local run. The hosted operator must connect
that signal to the provider request or `cf` process and enforce the approved
logical operation and byte budgets. The local composition used fixtures and
performed no provider operations. [Operator entry](../../../scripts/lib/snapshot-publication-window.ts) · [Pinned verifier](../../../scripts/verify-staged-snapshot.ts)

The read-only `cf` outcome adapter supplies the exact instance and seven R2
receipt reads to the same operator entry. It accepts the Workflow binding
trigger, checks the exact instance parameters, bounds Workflow polls to the
reviewed count, and forwards cancellation to each subprocess. The parser
accepts at most 2 KiB per receipt and the subprocess caps captured stdout at
64 KiB. The hosted budget still accounts for provider-side transfer.
Two additional exact-key GETs must return Cloudflare code `10007` and HTTP 404 for the requested staging account, bucket, and diagnostic key. A live check on the expired staging namespace verified that `cf` and the reader recognize that response. A permissions error, a missing bucket, and a different object's 404 leave the outcome unverified. [Outcome reader](../../../scripts/lib/snapshot-publication-cf.ts) · [Controlled response tests](../../../test/snapshot-publication-window.test.ts) · [Workflow instance response](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/) · [R2 list pagination](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)

The separate read-only `cf` baseline records the retained isolated deployment,
Workflow creation evidence, instance-list observation and exact canonical
staging object. The anonymous public source observation on November 24 returned
`855cdfc65207a6906c414e09a77d7f93267c5356`, committed November 16 at
15:21:51 UTC. It matched the pinned reference at that observation. Recheck the
source, selected instance and namespace during admission of the fresh packet.
[Cloudflare baseline](staging-publication-cf-baseline.json)

The prior November 23 publication event expired unarmed. A new run needs a
reviewed future UTC event, its prepared configuration and deployment pins, an
approved finite staging budget, and authority for the isolated schedules
operator and both independent cleanup guards through final observation.
The historical `9109` failures and automatic approval refusal for broader
OAuth remain the account-authority evidence for that attempt. The new baseline
establishes scoped read access. MP-02 remains open until the hosted event and
complete publication qualify. [Prior attempt](../../V1-RELEASE.md#november-22-staging-publication-version) · [Qualification procedure](../../V1-SCHEDULED-PUBLICATION-REVIEW.md#before-a-hosted-proposal-is-executable)
