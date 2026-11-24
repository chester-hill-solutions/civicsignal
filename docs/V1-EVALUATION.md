# CivicSignal v1 retrieval evaluation

The runner measures the HTTP retrieval path that a caller uses. It does not replace the serving adapter with an evaluation search. Isolated staging measurements are recorded below; no production measurement is claimed. A green unit test is not a deployment benchmark.

## Hosted staging observations — 2026-10-24 UTC

The reconciled, strict-R2 staging API version `02dd9821-6bac-481d-89a4-5dfdf977bc6e`
served source `0507465393c224c0491fc8c17c88340217acc656`, parser `statutes-v2`,
with `embeddinggemma-2-270m`, JEV reranking and the unchanged
`vectorize:federal-authority-v3-observed` policy. The original durable relay
retains its 160-request cumulative limit. Latency includes the local relay and
durable reservation overhead. The original vector index was preserved; legacy
embedding model provenance remains unattested even though its complete backup
and metadata are verified.

| Measurement | Calibration | Holdout |
| --- | ---: | ---: |
| Valid responses / planned | 20/20 | 63/64 |
| Answerable Hit@1 | 11/12 | 35/48 |
| Answerable Hit@5 and Hit@10 | 11/12 | 40/48 |
| Mean reciprocal rank | 0.9167 | 0.7681 |
| False refusals / completed answerable | 0/12 | 3/48 |
| Accepted answerable without gold | 1 | 5 |
| False accepts / completed unsupported | 0/8 | 1/15 |
| English Hit@5 | 6/6 | 21/24 |
| French Hit@5 | 5/6 | 19/24 |
| Both languages Hit@5 | 5/6 pairs | 18/24 pairs |
| Completed client latency p50 / p95 | 2.155 / 3.041 s | 2.502 / 3.385 s |

Calibration retained all 20 fresh computed score observations, with no provider
errors. Its threshold sweep is an unapplied candidate, not validation of the
reranker authority decision. The serving floor remains 0.62. Holdout used the
fixed policy and reported no cache hits. Its one error was an encoder-related
HTTP 502 on `unsupported-quebec-civil-code-en`; that case does not enter the
false-accept denominator. The false accept asked for the current federal wage
amount on an administrative webpage and received statute results. The eight
missed positive labels include three refusals and five wrong-result responses;
the French set is weaker. Provider-level latency and cause of the encoder
failure have not been established by these observations.

An offline check also found a finite, nonzero stored vector for the single
calibration miss, `E-2.01-24-fr` (norm 0.99999982). A zero placeholder does not
explain that miss. The completed run did not retain its query vector or raw
100-candidate set, so candidate omission and reranking remain unresolved. No
serving or model request was made for this check. See the
[vector observation](evidence/2026-10-23/calibration-miss-offline-vector-observation.json).

The held-out process exited unsuccessfully. These results expose retrieval and
scope limitations and do not close release acceptance. Subsequent tuning must
retain this result as history and use new held-out questions for independent
validation. No retry or threshold change occurred. A first calibration invocation
was blocked locally by the network sandbox before any relay reservation; its
20 local transport errors and failed receipt are preserved separately. The
explicit corrected invocation used the same dataset, policy and original ledger.

Local reports: `dist/evaluation/v1-stage-20261022-network-recovery-calibration.json`
and `dist/evaluation/v1-stage-20261022-network-recovery-holdout.json`.

The 44-call benchmark completed its planned attempts at 00:43:45 UTC and exited
unsuccessfully. Its mix is ten answerable, ten unsupported, ten English and ten
French queries per measured batch, plus two warm-ups per concurrency level.

| Concurrency | Measured valid | Warm-up failures | Cache hits / measured | Completed p50 / p95 | Valid requests/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 19/20 | 1/2 | 11/20 | 2.121 / 4.602 s | 0.456 |
| 4 | 20/20 | 1/2 | 20/20 | 0.440 / 1.924 s | 3.882 |

The serial error is a row-hydration 502 on `A-1-6-en#4`. Warm-up response
observations were discarded by this runner version; their failure counts alone
cannot identify a provider or cause. The two levels have different cache
populations. Their throughput ratio is not an isolated concurrency improvement,
maximum sustainable load, uncached inference performance or production capacity.
The raw report is `dist/evaluation/v1-stage-20261022-network-recovery-benchmark.json`.

The original approved Zen chat request, capped at 128 output tokens, reached the
relay at reservation 153 and failed acceptance. Its terminal receipt retained no
safe HTTP status, correlation or failed predicate, so it cannot establish whether
the provider failed or the response/citation contract was unmet. That attempt and
the earlier clean **153/160** relay shutdown remain unchanged in the
[original serving receipt](evidence/2026-10-23/staging-retrieval-generation-root-validation.json).

The user then approved one additional diagnostic request under the same 128-token
cap. Reservation **154** returned staging **HTTP 502 / `UPSTREAM_UNAVAILABLE`** at
01:18:55 UTC, correlation `req_mvlpnc3f3csiit1oeq`. Its fixed HTTP-status predicate
failed; no retry ran. This is more specific evidence of a staging API failure,
but it does not identify the failed retrieval/provider stage, establish a Zen
call, or verify the generation key or an answer/citation contract. The diagnostic
retains safe status, correlation and error-code metadata, with no raw body, answer
or key-derived hash. See the
[diagnostic successor receipt](evidence/2026-10-23/opencode-zen-diagnostic-v2-root-observation.json).

The October 24 documentation check confirms that the configured Zen endpoint,
Bearer authentication and `claude-haiku-4-5` model match OpenCode's current
[inference API](https://dev.opencode.ai/v2/docs/console/api/inference/) and
[model table](https://dev.opencode.ai/v2/docs/console/models). This does not
establish key/account eligibility or that the failed staging request reached
generation; it supplies no basis for changing the endpoint or retrying.

After the generation diagnostic, the ledger retained **154/160** reservations
with its original prefix and no reset. The restarted diagnostic relay's owned process
timed out with cleanup uncertainty. An independent observation at **01:24:41 UTC**
found its PID and listener absent; this is later point-in-time evidence and does
not turn the original timeout into a settled success. Neither hosted Zen attempt
passes acceptance. Production was not changed.

The earlier API diagnostics source at `520c102` passed clean Linux pull-request merge
candidate CI: **1,281 tests in 89 files**, 21 Python cases, four compiler projects,
117 vendor files, two runtime probes and five dry-run builds. GitHub's generated
merge candidate includes that exact head; it was not a detached standalone head
checkout. This source remains undeployed, so those diagnostics do not explain the
earlier hosted failures retrospectively. See the
[CI receipt](evidence/2026-10-23/release-linux-ci-520c102.json).

The separate **01:40 UTC** snapshot Cron experiment completed both independent
cleanup guards at T+5. Its final seven-request read passed at **01:45:38 UTC**:
zero scheduled metric rows, absent entered/completed/failed event objects, one
successful historical health control, an empty calendar and the unchanged
API-created Workflow/manifest. This leaves the Cron discovery/publication gate
open; absence does not establish non-dispatch or a platform cause. The reader
made no source, model or serving calls. The frozen runtime allowed at most one
source request for that event, but its actual execution is unattested. These
observations add no retrieval or generation measurements. See the
[Cron outcome and limits](evidence/2026-10-23/staging-cron-0140-root-observation.json).

The subsequent local investigation reproduced provider-boundary defects without
another hosted request. Jev HTTP 200 with JSON `null` threw outside its failure
handler; partial answers fabricated zero scores and malformed probabilities were
accepted. BYOK providers accepted empty answers and consumed usage, three allowed
synthetic key echoes, and malformed text/array shapes could become billable answers.
These reproductions do not establish the cause of either historical Zen failure
or any held-out miss.

The repaired local source uses one bounded JSON exchange per provider, validates
answers before billing and retains only safe generation failure phase/status
metadata. Jev requires every requested typed Noul probability, with a 15-second
deadline, 256 KiB response cap and 1 MiB request cap. Its existing failure fallback,
model, prompt, authority rule and thresholds remain unchanged. All four BYOK
providers use the 30-second / 256 KiB boundary. Jev-enabled cache keys include
`jev-noul-complete-15s-v1`; vector-only keys are unchanged. Existing cached decisions
contain no raw authority flags with which to validate the stricter contract, so
they cannot be reused as evidence for it. The documented probability shape was
checked against the primary [System One API](https://docs.typesafe.ai/api/system-one).

The [local validation receipt](evidence/2026-10-24/provider-boundary-root-validation.json)
records exact source pins, regressions, independent reviews and release checks.
That source was subsequently deployed as staging API version
`f512cf84-fbcc-4990-bad0-13cdc0678c71`. The deployment itself added no serving
request. At **03:44 UTC**, a separately owned retrieval probe used reservations
**155 and 156**, then stopped at its cold-reranking predicate. Both HTTP responses
were 200. The original Zen topic resolved exactly to Canada Health Act section 8
with the expected citation and no encoder or reranker call. This diagnoses the
already-used topic; it is neither fresh holdout validation nor proof of either
historical generation failure's cause.

The calibration question `P-21-4-en` returned ten results through the existing
vector-floor fallback: encoder, Vectorize and row hydration succeeded, but the
reranker reported an error. Its expected provision was sixth; the computed top
score was 0.6629009 and retrieval elapsed time was 2,138 ms. The response did not
identify the reranker failure phase or upstream status. The warm third request
and KV-settle wait did not run. The child and owner settled, the ledger closed,
and the failed qualification receipt remains preserved. No automatic retry ran.

After that probe the ledger was **156/160**, with four reservations unspent and its
154-request prefix unchanged. Zen key validity and positive chat acceptance
remain unverified. The previous holdout and benchmark failures remain open; this
two-request diagnosis does not replace them. See the
[retrieval probe receipt](evidence/2026-10-24/staging-api-v5-retrieval-root-observation.json).

Staging diagnostics version `e33f3256-b9be-43c9-a5e3-d7d0bc1451b9` then passed
binding/runtime/usage/calendar postverification at **04:05:43 UTC**. Its one fresh
calibration GET at reservation **157** returned HTTP 200 with the same vector
fallback and gold rank six. The added observation identifies `transport`, with
no observed upstream HTTP status. Retrieval elapsed time was 1,799 ms. The
diagnostic owner and child settled and the original ledger closed at **157/160**,
three unspent. No generation request or additional identity GET ran. See the
[fresh diagnosis](evidence/2026-10-24/staging-api-v6-reranker-diagnosis-root-observation.json).

A local workerd reproduction confirmed a compatibility defect in the shared
provider wrapper: Workers rejects `redirect: "error"` before outbound I/O. Detached
native fetch works; changing its receiver is unnecessary. Source `78e0c2f` uses
`manual` while retaining non-success/redirect refusal. Five native runtime cases
verify valid POST dispatch and same/cross-origin 302/307 refusal without a second
request or credential forwarding. The full local and Linux gates pass
**1,566 tests in 93 files**; Linux also passes **23 Python cases**. See the
[repair qualification](evidence/2026-10-24/provider-redirect-root-validation.json)
and [Linux CI](evidence/2026-10-24/provider-redirect-linux-ci.json).

The repaired staging API `3efd1935-39ea-41da-b19c-e8bbf495b50d` passed the same
binding/runtime/usage/calendar checks at **04:20:11 UTC**. Reservations **158/159**
then passed normal cold/warm characterization of the same calibration question.
Cold retrieval ran all providers successfully, used no fallback and placed the
gold **first**, improving on the fallback's sixth position. After the bounded
65-second wait, warm retrieval returned the same ordered IDs/citations, score
provenance and originating timestamp, with no encoder/vector/reranker call.
Worker retrieval elapsed times were **2,301 ms cold / 1,450 ms warm**; these are
not client benchmark or capacity estimates. Both owner and child settled and the
original ledger closed at **159/160**, leaving one reservation. See the
[cold/warm observation](evidence/2026-10-24/staging-api-v7-calibration-recheck-root-observation.json).

This closes the reproduced current provider-dispatch defect and this calibration
check. It does not establish the cause of the older Zen attempts, which predate
the wrapper deployment, or replace the failed holdout/benchmark results. Positive
Zen chat acceptance and key eligibility remain unverified. Another generation
call requires a new explicit approval even though one serving slot remains.

## Dataset and evidence

`src/eval/data/v1-questions.json` contains 86 questions. English and French versions form one pair and remain in the same split. Positive groups use the instrument identifier, so an Act cannot appear in both calibration and holdout.

| Split | Source-verified answerable | Scope-verified unanswerable | Unverified and excluded | Scored total |
| --- | ---: | ---: | ---: | ---: |
| Calibration | 12 | 8 | 0 | 20 |
| Holdout | 48 | 16 | 2 | 64 |
| Total | 60 | 24 | 2 | 84 |

The positive set names 30 provisions across 15 Acts. The 24 held-out provisions cover 12 Acts absent from the older six-Act set: access to information, health insurance, human rights, citizenship, copyright, divorce, employment insurance, food, official languages, trademarks, youth justice, and species at risk. The three calibration Acts were already used in development. Holdout means unused for model/prompt/threshold selection in this work; it does not mean the questions or legislation were absent from model training.

Each positive label records its exact parsed row identifier, language, Act, section, upstream commit, XML blob SHA-256, parsed-text SHA-256, evidence excerpt, and immutable upstream URL. The evidence was inspected in both languages and then checked against the canonical repository clone using the ingestion parser. The verifier reads immutable Git blobs, not working-tree files.

Verified on 2026-10-22:

- Corpus source commit: `0507465393c224c0491fc8c17c88340217acc656`.
- Parser contract: `statutes-v2`; source and parser revisions are recorded separately.
- Source blobs checked: **30**.
- Positive question labels checked: **60/60**; rejected: **0**.
- Dataset SHA-256 (the runner's parsed JSON serialization): `5947e2417cebd4883df368a4aeca1dccdb79bd0329056155d7420016431f8cf9`.
- Verification artifact generated locally: `dist/evaluation/v1-labels.json`.

The negative set expressly asks for a different authority or source: provincial/municipal/foreign rules, court reasons, weather, statistics, current administrative amounts, and monetary-policy announcements. These are scope labels, not verified statements about those external sources. Federal minimum wage questions distinguish the current amount on a government webpage from the statutory rule. The Ontario HST-rate pair stays **unverified**: a rate may be stated in federal legislation, so its absence must not be assumed.

The Canada Health Act source produced a preamble row with section label `8` as well as the real section. Gold uses the actual headed provision identifier, never the preamble row. Existence of an Act/section pair alone is insufficient label verification.

`src/eval/questions.ts` remains the legacy development set for reproducing historical runs. Its historical negatives and thresholds are not release holdout evidence. In particular, the 0.62 Vectorize floor recorded in the handoff was tuned on prior probes. This dataset does not independently validate it until the held-out run is complete.

## Reproduce label verification

### November revision

The [November dataset](../src/eval/data/v1-november-questions.json) combines the original calibration split of 20 cases and the independent successor holdout of 64 cases. The November source check verified all 60 positive labels across 30 immutable XML blobs. Four blobs changed since October, and all labelled provision digests, prompt text, gold rows, and scope labels were preserved. [Verification receipt](evidence/2026-11-22/november-serving-label-verification.json)

```sh
bun scripts/eval-v1.ts \
  --dataset src/eval/data/v1-november-questions.json \
  --verify-only true \
  --verify-sources /path/to/laws-lois-xml \
  --output dist/evaluation/v1-november-labels.json
```

Select this dataset explicitly for any serving measurement that uses the verified November corpus revision. Select the declared split separately for each measurement.

### Successor labels — 2026-10-31

The separate [successor dataset](../src/eval/data/v1-successor-questions.json) contains 64 holdout questions.
It has 48 positive questions for 24 provisions across 12 Acts, plus 16 excluded-source questions.
The positive Acts, gold identifiers, question identifiers, groups, and question text do not overlap the stored formal development and v1 sets.
The shared citation parser resolves no positive question as an exact-provision request.
Negative source categories overlap earlier controls; their requested sources and question text differ.

Full immutable-source checks pass all 48 positive labels against 24 XML blobs, with zero rejected labels.
The [source proof](evidence/2026-10-31/successor-label-source-verification.json) pins revision `0507465393c224c0491fc8c17c88340217acc656` and parser `statutes-v2`.
The [validation receipt](evidence/2026-10-31/successor-serving-label-local-validation.json) records 35 focused checks and the limits of this selection.
The parsed dataset digest is `d3f43f117da958f19c3cf1c43314dcd764be7065bc1a58bd7dc4b0857fb94631`.

```sh
bun scripts/eval-v1.ts \
  --dataset src/eval/data/v1-successor-questions.json \
  --verify-only true \
  --verify-sources /path/to/laws-lois-xml \
  --output dist/evaluation/v1-successor-labels.json
```

This command makes no network request. Use a new output path to preserve earlier proofs.
Clean-checkout tests check the parser seam with small wrappers around unchanged source Sections.
The separate full-blob proof checks every original XML source.

The default runner and historical questions stay unchanged; a future run must select this dataset explicitly.
No hosted request, threshold, prompt, provider, or policy changes through this work.
The labels describe a fixed historical source; they do not establish current deployment presence, population accuracy, or generated-answer support.
Acceptance criteria, fresh target provenance, and a separately bounded serving decision remain required.
Use for tuning invalidates holdout independence.

### Original label verification

```sh
bun scripts/eval-v1.ts \
  --verify-only true \
  --verify-sources /Users/ladmin/.cache/civicsignal/laws-lois-xml \
  --output dist/evaluation/v1-labels.json
```

Use another clone path on another machine. All referenced commits must be present locally. The command performs no remote retrieval, inference, deployment, or data write to that clone. A source digest, row identity, language, section, status, or evidence mismatch fails verification.

Positive labels are excluded when their source revision differs from the target revision. Re-verify and version the labels for a new revision. Do not silently score removed or changed provisions as retrieval misses, and do not change the corpus revision in a provenance file to bypass this check.

## Target provenance

A network run requires an explicit target origin and a JSON provenance file. The file must contain:

| Field | Required evidence |
| --- | --- |
| `backend` | `vectorize`, `postgres`, or `local-fixture` |
| `environment` | `production`, `staging`, or `local-fixture` |
| `deployment` | The deployed Worker/server version or source commit |
| `corpusRevision` | The served 40-character source commit from corpus state |
| `parserVersion` | The parser contract recorded in published corpus state, for example `statutes-v2` |
| `corpusAsOf` | The corpus date, as ISO date or timestamp |
| `corpusLastRunAt` | Timestamp of the published successful run |
| `upstream` | Object with observed `revision`, `committedAt`, and `observedAt` timestamps |
| `encoderModel`, `encoderArtifact`, `encoderDimensions` | The deployed encoder contract, not an unrelated local model |
| `retrievalPolicy`, `reranker` | Deployed policy/version, floor, and reranker mode; state `disabled` if appropriate |
| `evidence` | Object with `source`, `observedAt`, and `note` identifying the actual state reads |

The release candidate returns bounded `retrieval` observations on HTTP and MCP retrieval results, including refused results and failures. They state backend, source commit, parser version, policy, encoder model, language filter, execution mode, pre-refusal top score, score origin/time, cache state, fallback state, provider outcomes, candidate/result counts, and total retrieval duration. They contain no question, candidate text, credential, or provider exception. Cached scores are marked as originating from an earlier computation; they are not fresh measurements.

The scripts fetch `/.well-known/civicsignal.json` and compare its encoder model when exposed. Successful responses must also carry serving observations matching the supplied backend/source/parser/model/policy. Missing or conflicting observations are invalid measurement responses, not accepted evidence. The context may use a composite cache revision such as `<source commit>:statutes-v2`; the report compares the source commit and parser version separately. Deployment identity, upstream observations, publication timestamps, index/row parity, and freshness still need authoritative operator evidence. Retain those state reads with the report.

Supply the API key through the existing `CIVICSIGNAL_KEY` environment variable. The runner does not read credential files or print keys. It refuses credential-bearing URLs and remote plaintext HTTP, and does not follow redirects with the key.

## Measure the serving retrieval path

```sh
bun scripts/eval-v1.ts \
  --target https://api.civicsignal.chesterhillsolutions.ca \
  --provenance /path/to/verified-vectorize-state.json \
  --split holdout \
  --concurrency 1 \
  --output dist/evaluation/v1-vectorize-holdout.json
```

This example performs **64 normal, potentially billable retrieval calls** after excluding unverified labels. An `all` run performs 84. Use `/api/statutes` for the Worker; `--route /api/brief` reads its `legislation` array and also supports the Bun/Postgres service. Different backends and retrieval modes require separate reports and provenance files. There is no automatic deployed-target default.

The report includes each response outcome, item identifiers/languages, correlation identifier, request duration, source/model/deployment metadata, paired bilingual metrics, and exclusions. It contains no returned statute text or API key. It records the dataset digest and exact denominators.

- Hit@1/5/10 and MRR use **all selected answerable questions**, including errors and missing observations as misses. These are question hit rates, not document-level recall.
- False rejection counts successful answerable responses with no items. Its denominator is completed answerable requests. An accepted wrong result is reported separately.
- False acceptance counts successful unanswerable responses with any item. Its denominator is completed unanswerable requests.
- HTTP errors, transport errors, malformed response shapes, and missing observations are separate. They never count as honest refusals.
- A gold identifier in the wrong language, or without language metadata, is a miss.
- Paired results show both-language success and one-language-only success.
- Latency percentiles use nearest rank, with all-attempt and completed-request populations reported separately.

An empty denominator is `null`, not a zero-error rate. A zero false-accept count on a small negative set is not evidence of zero population risk. These are retrieval/scope labels; they do not grade generated legal answers or constitute a human legal review.

Serving observations identify encoder, vector, row hydration, and reranker outcomes. A failed reranker that produces a successful vector fallback is counted as a provider failure and a fallback execution, independently of HTTP success. HTTP 502/503/504 remain a separate upstream-response count. A failed request with no serving observation has unknown provider attribution. The report does not infer provider identity from status alone or expose raw error text. Total client/retrieval latency is measured; per-provider latency is not yet instrumented.

The `federal-authority-v4-eligible-floor` policy admits a vector fallback only when at least one returned provision meets the backend floor. The raw `preRefusalTopScore` can describe a candidate outside the result. The optional `cacheFailure` field records a read or write fault for the current request. Evaluation and benchmark summaries count those faults separately.

## Calibrate each backend separately

Never translate a cosine threshold into a Vectorize score by a fixed factor. Preserve the existing index. Acquire **raw pre-refusal**, language-filtered best scores for every calibration question using the deployed encoder and exact target backend/revision. Do not derive raw scores from responses that have already passed an acceptance floor.

Collect the 20 calibration cases from the normal serving route:

```sh
bun scripts/eval-v1.ts \
  --target https://api.civicsignal.chesterhillsolutions.ca \
  --provenance /path/to/verified-vectorize-state.json \
  --split calibration \
  --calibrate-observed true \
  --output dist/evaluation/v1-vectorize-calibration.json
```

This attempts **20 normal, potentially billable calls**. The authenticated `X-CivicSignal-Evaluation: fresh` header asks the server to bypass retrieval-cache reads and writes without changing the question, language filter, authority policy, quota, or successful-call billing. The runner accepts only computed scores from successful encoder/vector execution. It rejects cached origins, exact lookups, missing telemetry, wrong language filters, and mismatched backend/source/parser/model/policy. Scores below the deployed floor are retained on refused responses. All 20 cases must qualify before a threshold candidate is produced; otherwise the report records each rejected case and exits unsuccessfully. Holdout cannot be used with this option.

The candidate minimizes calibration false accepts, then false rejects, then the threshold. The full sweep is recorded and never applied automatically. Vectorize and Postgres reports remain independent; scores are not rescaled across backends. The release runner accepts no manually supplied raw-score file or `/api/match` substitution. The pure scoring helper remains available for unit tests and historical analysis, but release calibration must retain the serving observations. Reranker authority decisions need their own serving-path evaluation; a vector floor sweep cannot validate those decisions.

The normal `/api/statutes` path and the Postgres `/api/brief` path now expose the actual language-filtered, pre-refusal observation. The public raw `/api/match` route is intentionally not calibration evidence. Do not substitute its unfiltered top-1 scores or scores from a local cosine scan. Hold the selected backend policy fixed before running holdout; use new held-out questions after subsequent tuning. No new floor has been measured or applied by this implementation work.

## Measure HTTP latency and throughput

```sh
bun scripts/bench-v1.ts \
  --target https://api.civicsignal.chesterhillsolutions.ca \
  --provenance /path/to/verified-vectorize-state.json \
  --requests 20 \
  --warmup 2 \
  --concurrency 1,4 \
  --output dist/evaluation/v1-vectorize-benchmark.json
```

This example attempts **44 normal, potentially billable calls**. Measured requests use a declared round-robin mix of answerable/unanswerable and English/French cases, with repetitions within each bucket. This is a controlled mix, not an observed customer traffic distribution. Each concurrency level performs explicit warmup calls, then times the measured batch using a monotonic clock. Reports include attempted requests/second, completed requests/second, all/completed latency percentiles, and each error class. Successful empty refusals are valid completed retrieval responses. The load is bounded and closed loop; it does not establish maximum sustainable throughput, saturation, or open-loop capacity.

Exact query text is preserved. Repeated questions can hit the deployment cache. Cache state is reported as uncontrolled/warmed; these results cannot be described as uncached encoder/reranker latency. Fresh calibration uses the explicit cache-bypass header. A benchmark still needs a declared warm/cold policy and an explicitly coordinated deployment test; provider-stage latency requires additional stage timing. Fixture-origin reports are labelled `local-fixture` and cannot establish production performance.

Freshness reports distinguish corpus timestamp age, last successful run age, upstream observation age, and whether the observed upstream revision is served. If a newer upstream revision is pending, its age is a lower bound on unresolved lag. Historical metadata cannot establish current freshness.

## D-01 serving decision

The product owner approved the limits below with accuracy first, speed second, and freshness third. Pin the Worker version, route, corpus revision, parser, model, retrieval policy, and dataset hashes before the run.

| Measure | Required passing bar | Evidence to use |
| --- | --- | --- |
| Accuracy in each language | At least **22 of 24** answerable cases return the correct provision in the top five. Allow at most one false refusal and one nonempty response without the gold provision per language. | Use the holdout's `metrics.byLanguage`. Hit@5 includes every planned answerable case in its denominator. Read `falseRejection` and `acceptedWithoutGold` separately. Report top-one hits and paired bilingual results. |
| Unsupported queries and complete evidence | **Zero of eight** unsupported cases accepted in each language. All calibration, holdout, measured benchmark, and warm-up requests complete with valid evidence. | Read missing requests and HTTP, transport, and invalid-response errors separately. Report fresh Jev fallback rates by language over fresh Jev attempts, alongside cache hits and any missing telemetry. Successful fallback counts toward quality and latency under the same criteria. |
| Speed | Completed-client p95 at or below **8 seconds at each** benchmark concurrency level, 1 and 4. | Use the bounded benchmark with two warm-ups and 20 mixed measured requests per level. Include relay overhead and report observed cache usage, all-attempt latency, and completed throughput at each level. |
| Freshness | Observe the upstream head within **24 hours** of the end of measurement. The served revision may match that head or be an explicitly approved ancestor with a source commit timestamp within the preceding **seven days**. | Verify the served revision and ancestry against the upstream observation. Record the source commit time and last successful ingestion time separately. A quiet upstream can still match the served revision. |

The [offline acceptance checker](../scripts/check-serving-acceptance.ts) binds the calibration, holdout, and benchmark reports to the reviewed staging provenance, relay origin, result limit, and dataset. It requires a successful discovery response with the reviewed encoder model and dimensions in all three phases, checks the expected cases and warm-ups, and recomputes the pass criteria from the recorded observations. Use the benchmark split from the [reviewed request packet](STAGING-REQUEST-BUDGET.md#november-d-01-run-packet).

```sh
bun --no-env-file scripts/check-serving-acceptance.ts \
  --dataset src/eval/data/v1-november-questions.json \
  --provenance stage-provenance.json --origin "$SERVING_RELAY_ORIGIN" \
  --benchmark-split "$BENCHMARK_SPLIT" --limit 10 \
  --calibration eval-calibration.json --holdout eval-holdout.json \
  --benchmark benchmark.json
```

When the run serves an approved earlier revision, add `--approved-ancestor "$APPROVED_CORPUS_REVISION" --source-repo /path/to/laws-lois-xml`. Both commits and their connecting history must be present locally. The checker verifies ancestry and the actual Git commit timestamp. It emits a JSON result and exits unsuccessfully if a requirement fails.

Keep the checker result with the reviewed provenance, report files, and relay ledger. The operator still verifies the staging deployment and upstream observation and reviews the request budget. Replace the retained operator's unconditional age caps with the approved policy before freezing its executable packet. Scheduled publication retains its own gate.

Select the matching source labels before opening a serving budget. The November rebind qualifies labels for the exact corpus revision in its receipt. A different target revision needs its own source check. Keep calibration, the independent holdout, and the budgeted benchmark schedules explicit in their packets. [November revision proof](#november-revision)

## D-02 bilingual chat claim review

The [eight chat cases](../src/eval/data/v1-chat-claim-cases.json) exercise answerable and out-of-coverage questions in both languages. Keep them separate from retrieval acceptance and the single-request Zen smoke. The positive prompts reuse provisions from the original retrieval calibration, with no overlap with either holdout. Reference sources in the catalog guide the reviewer. Use the material returned by the same chat request to verify the captured answer.

The product owner will independently review the eight cases using reviewer ID `product-owner`. A separate operator captures the responses and provides the exact answer and its retrieved provisions for review. After selecting the hosted candidate, served corpus revision, provider, and model, prepare and retain a packet before collecting evidence. This command runs offline.

```sh
bun scripts/prepare-chat-claim-preregistration.ts \
  --candidate "$CANDIDATE_SHA" --revision "$CORPUS_REVISION" \
  --provider "$CHAT_PROVIDER" --model "$CHAT_MODEL" \
  --reviewer product-owner > chat-preregistration.json
jq '.plan' chat-preregistration.json > chat-plan.json
```

Retain the packet and plan digest in the reviewed execution record before any request. Send each `requests[].requestBody` verbatim as UTF-8. The per-case hash covers the string bytes, without a trailing newline. Supply authorization separately in headers. Each case sets a 256-output-token cap. Budget one staging attempt and up to one BYOK generation call per case, including refusal cases, with no automatic retries. Account for retrieval providers separately. The packet supplies case inputs for a separately reviewed budget.

Record each successful response privately with the corresponding request body and the retrieved `cited` entries' `citationUrl` and `text`, represented as `sourceUrl` and `text` in the capture. Confirm the response provider, model, and serving revision against the registered target and retain the correlated staging receipt. Record failures in the attempt ledger. A failed request leaves the required case incomplete.

The registered reviewer records the answer language, answer or refusal outcome, and a contiguous segmentation covering the exact answer. Each factual segment needs a supported verdict and an exact excerpt from the retrieved material. Refusals need to decline the question without factual assertions. Use `hashChatClaimCapture` to bind the captured request, answer, retrieved text, and target for review. Keep credentials out of the capture and review.

```sh
bun scripts/check-chat-claim-evidence.ts \
  --plan chat-plan.json --capture chat-capture.json --review chat-review.json
```

The checker verifies the evidence bindings, coverage and excerpts. Claim identification and factual support depend on the independent review. This is a release check on the preregistered cases.

The current eight-case packet is ready for review. The default capture order follows D-01 qualification. The product owner can explicitly approve earlier capture for staging evaluation under a separate request budget. Early chat evidence leaves the serving and production gates open. [Offline packet](V1-RELEASE.md#november-23-d-02-offline-packet)

## Verification status and remaining prerequisites

The v1 release checks run against the Cloudflare Worker and Vectorize. Postgres measurements apply to the alternative deployment.

Local regression checks pass for the [serving prerequisites](PLAN.md#local-serving-prerequisites) identified by the [November 22 probes](V1-RELEASE.md#november-22-local-code-assessment).
The [November 23 hosted run](V1-RELEASE.md#november-23-hosted-serving-and-chat-acceptance) bound D-01 and D-02 to candidate `44ce56f` and November corpus `855cdfc`. D-01 met latency, freshness, and unsupported-query requirements. Vector fallback missed the accuracy bar in both languages after Jev returned HTTP 402 on all calls. D-02 captured four expected refusals and one false refusal. Zen returned HTTP 402 on all three generation attempts, leaving claim verification open.

The first hybrid run stopped after 19 of 20 calibration searches completed. The repaired version completed calibration and found 20 of 24 English and 23 of 24 French provisions in the holdout. Three HTTP 502 responses stopped the run before benchmark. Both languages refused every unsupported holdout question. [Repaired hybrid D-01 result](V1-RELEASE.md#november-23-repaired-hybrid-d-01)

### November 23 calibration recall hillclimb

The paused staging pipeline briefly exposed a protected probe for 28 fixed prompts. It read the first 100 language-filtered candidates from the existing encoder and Vectorize index. The probe recorded the 20 calibration cases, two election chat development cases, and six new unsupported questions that explicitly name a federal Act. Cloudflare then restored the prior pipeline version with the same paused coordinator. The experiment used the November snapshot for statute text and titles.

| Calibration configuration | English top-five hits | French top-five hits | Unsupported calibration accepts |
| --- | ---: | ---: | ---: |
| Archived staging vector fallback | 3/6 | 5/6 | 0/8 |
| Local fallback promoting the uniquely named statute among the existing candidates | 4/6 | 5/6 | 0/8 |
| Offline FTS5 prototype, using the named statute's headings and first 320 characters after the vector gate accepts | 5/6 | 6/6 | 0/8 |

The raw vector pool contained 6/6 English and 5/6 French gold provisions. Replaying the existing fallback reproduced all 20 archived responses exactly. The local `federal-authority-v5-named-statute` change promoted the English Privacy Act collection provision from rank six to five in replay. It preserves the original refusal decision and requires a qualifying returned vector after reordering. The new six named-Act controls also stayed refused. The release holdout served no tuning role.

The FTS5 prototype brought the French election appointment provision from outside the raw top 100 to rank three. The English counterpart was raw rank seven and remained refused. Lowering the floor to `0.60` for explicitly named Acts would accept one of the new unsupported questions. Test the indexed prototype across more named and unnamed development prompts before choosing a serving policy. Raw candidates, local code replay, and FTS5 results are in `dist/evaluation/2026-11-23-recall-hillclimb/`.

### Plain-language query interpretation experiment

The [labour-board probe](V1-RELEASE.md#november-23-labour-board-query-probe) supplies two development cases. “labour board law” should prompt a question about the jurisdiction and what the user wants to know. The explicit federal question about the Board's powers should return Canada Labour Code section 16 in the top five. The retrieved statute supplies the section and citation. [Canada Labour Code, section 16](https://laws-lois.justice.gc.ca/eng/acts/L-2/section-16.html)

#### November 23 scoped full-text baseline

The local SQLite FTS5 prototype verified all 277,666 rows of corpus `855cdfc` and built 13 scoped indexes for the frozen questions. It resolves an explicit Act title in the query's language and ranks canonical, in-force numbered provisions using their headings and first 320 characters. Each search returns up to 20 candidates. The exact English labour-board question ranked section 16 fourth, compared with its absence from the top five in the earlier staging probe. The French counterpart ranked ninth. [English section 16](https://laws-lois.justice.gc.ca/en/acts/L-2/section-16.html) · [French section 16](https://laws-lois.justice.gc.ca/fr/lois/L-2/section-16.html)

| Fresh development result | English | French |
| --- | ---: | ---: |
| Correct provision in the top five, named Acts | 4/6 | 4/6 |
| Correct provision in the top five, all answerable | 4/8 | 4/8 |
| Answerable prompts without an Act title left unscoped | 2/2 | 2/2 |
| Ambiguous prompts flagged for scope | 2/2 | 2/2 |
| Unsupported prompts with a named Act that returned candidates | 4/4 | 4/4 |

The complaints deadline and survey confidentiality questions missed the top five in both languages. The prototype only returns candidates and scope observations, so the unsupported rows measure candidate leakage. A serving candidate still needs to decide whether the evidence supports an answer. Local warm scoped lookup p95 was 0.27 ms, excluding the index build and any hosted latency.

The seed pair and 28 fresh prompts were frozen before ranking ran. The fresh prompts had no exact normalized match in the November calibration or release holdout. The fixture, disposable script, and raw report are in `dist/evaluation/2026-11-23-scoped-fts/`. Run the prototype from the repository root with `python3 dist/evaluation/2026-11-23-scoped-fts/scoped_fts_prototype.py --snapshot /path/to/verified-snapshot`.

#### November 23 DeepSeek query interpretation replay

One direct OpenCode Zen `deepseek-v4.1-flash` call per prompt processed the 30 frozen cases and a separate “labour board law” smoke prompt. Zen received the question and language with a 256-output-token cap. The local scorer checked suggested Act titles against the pinned bilingual corpus, retained explicit scope, and merged the original query and up to two distinct rewrites by reciprocal rank fusion. It verified that the full-text fallback reproduced all 30 original results and complete candidate lists. [OpenCode model and endpoint](https://opencode.ai/docs/console/models/)

| Result | English | French |
| --- | ---: | ---: |
| Canada Labour Code section 16 rank | 4 → 2 | 9 → 9 |
| Fresh answerable cases in the top five | 4/8 → 6/8 | 4/8 → 6/8 |
| Fresh named-Act cases in the top five | 4/6 → 4/6 | 4/6 → 4/6 |
| Fresh unnamed-Act cases in the top five | 0/2 → 2/2 | 0/2 → 2/2 |
| Fresh ambiguous cases given a model clarification | 2/2 | 0/2 |
| Fresh unsupported cases that returned candidates | 4/4 → 0/4 | 4/4 → 0/4 |

The original wording alone found all four unnamed provisions in the top five once the model supplied the correct Act. French rewriting moved Statistics Act section 17 from rank seven to three and Lobbying Act section 5 from rank four to seven. The smoke prompt elicited a federal-versus-provincial question. Both French ambiguous prompts received HTTP 200 with unusable generation responses and fell back to `scope-needed`. Successful calls took 1.99 seconds at p50 and 3.625 seconds at p95. The eight unsupported cases were routed outside federal Acts. The experiment measured retrieval and routing and generated zero legal answers, so claim verification remains a separate acceptance check.

The prompt, disposable scripts, decision receipts, and report are in `dist/evaluation/2026-11-23-zen-rewrite/`. Reproduce scoring without new provider calls using `python3 dist/evaluation/2026-11-23-zen-rewrite/score.py --snapshot /path/to/verified-snapshot`.

#### November 23 Mistral Small query interpretation replay

The same 30 frozen questions and ambiguity smoke prompt ran through the supplied OpenCode custom provider with `mistralai/mistral-small-24b-instruct-2501`. The prompt, token cap, pinned corpus, and scoring policy matched the DeepSeek replay. Each prompt had one attempt. [OpenCode custom providers API](https://opencode.ai/docs/console/api/providers)

| Measure | DeepSeek | Mistral Small |
| --- | ---: | ---: |
| Canada Labour Code section 16 rank, English | 2 | 9 |
| Canada Labour Code section 16 rank, French | 9 | 12 |
| Fresh answerable cases in the top five, English / French | 6/8 / 6/8 | 6/8 / 6/8 |
| French named-Act cases in the top five | 4/6 | 5/6 |
| French unnamed-Act cases in the top five | 2/2 | 1/2 |
| Ambiguous cases sent to search | 0/4 | 4/4 |
| Unsupported cases that returned candidates | 0/8 | 1/8 |
| Successful provider calls, p50 / p95 | 1.990 s / 3.625 s | 0.801 s / 1.119 s |

Mistral ranked the French lobbying result first, moved the French federal records question to clarification, and assumed federal jurisdiction on four ambiguous labour questions. Its smoke clarification asked for a province or territory and omitted the federal option. One unsupported English request produced a malformed decision. The literal fallback returned five statute candidates for that request. The latency comparison measures the client-observed provider calls through the two OpenCode routes. The experiment returned candidates and routing decisions only.

The Mistral receipts and score report are in `dist/evaluation/2026-11-23-mistral-rewrite/`. Keep DeepSeek as the comparison baseline for the next retrieval experiment.

#### November 23 Cohere Command R query interpretation replay

`cohere/command-r-08-2024` ran through the same OpenCode custom connection as Mistral with the same 31 prompts, token cap, pinned corpus, and scoring policy. The English section 16 call timed out at 30 seconds and full-text fallback returned rank four. For the French query, Command R selected the right Act and repeated the original search terms. Section 16 stayed at rank nine. [Cohere Command R model documentation](https://docs.cohere.com/docs/command-r)

Command R found the right provision in the top five on 5/8 fresh English and 6/8 fresh French queries, compared with 6/8 in each language for DeepSeek. It assumed federal jurisdiction on both ambiguous reinstatement questions and on the “labour board law” smoke prompt. Its proposed Act titles for the other two ambiguous questions failed corpus validation and the fallback requested scope. The two unsupported municipal lobbying questions returned federal candidates. Successful provider calls took 3.829 seconds at p50 and 16.540 seconds at p95. This was a query interpretation test with the same local candidate ranking policy.

The Command R receipts and raw score report are in `dist/evaluation/2026-11-23-cohere-rewrite/`.

#### November 23 Claude Haiku 5.5 query interpretation replay

`anthropic/claude-haiku-5.5` ran through the same OpenCode custom connection, with the same prompt, token cap, pinned corpus, and scoring policy. Haiku returned the right provision in the top five for 5/8 fresh English queries and 6/8 fresh French queries, against DeepSeek's 6/8 in each language. It identified the correct Act on all four unnamed queries. Its rewrites pushed Canada Labour Code section 16 from literal rank four to eight in English and from nine to fifteen in French. DeepSeek placed it at two and nine, respectively.

Haiku routed all eight unsupported prompts outside federal Acts. It asked a focused question for one of the four ambiguous prompts, and the other three fell back to `scope-needed` after unusable replies. The smoke prompt asked about federal versus provincial jurisdiction and the issue. Four of the 31 calls returned unusable replies, including a separate named-Act query whose full-text fallback recovered rank one. Successful provider calls took 1.365 seconds at p50 and 1.790 seconds at p95. [OpenCode model catalog](https://opencode.ai/docs/console/models/)

The Haiku receipts and raw score report are in `dist/evaluation/2026-11-23-haiku-rewrite/`.

#### November 23 short heading phrase prototype

The prototype keeps the explicitly named Act, or checks an inferred title against the pinned corpus. It runs the original query and at most one distinct heading-style phrase, then merges the results. Two ranking comparisons promoted a unique exact heading match or increased the weight of all headings. A local English or French scope question handles unresolved model decisions when the original query has no scope.

DeepSeek processed 30 replay prompts, the labour-board smoke prompt, and 22 new questions. The new questions include seven answerable cases per language across four Acts, two jurisdiction controls, and two unsupported controls. Their questions and gold provisions were frozen and checked against the previous development and release sets before collection. All 14 positive labels matched canonical provisions in the pinned November snapshot. [Canada Labour Code section 22](https://laws-lois.justice.gc.ca/eng/acts/L-2/section-22.html) · [Access to Information Act section 25](https://laws-lois.justice.gc.ca/eng/acts/A-1/section-25.html) · [Privacy Act section 6](https://laws-lois.justice.gc.ca/eng/acts/P-21/section-6.html) · [Canada Health Act section 20](https://laws-lois.justice.gc.ca/eng/acts/C-6/section-20.html)

| Measure | Literal scoped FTS | Act identification only | One heading phrase | Phrase plus unique heading promotion |
| --- | ---: | ---: | ---: | ---: |
| Canada Labour Code section 16 rank, EN / FR | 4 / 9 | 4 / 9 | 2 / 4 | 2 / 1 |
| Original development top-five hits, EN / FR | 4/8 / 4/8 | 6/8 / 6/8 | 7/8 / 6/8 | 7/8 / 6/8 |
| New development top-five hits, EN / FR | 3/7 / 3/7 | 5/7 / 5/7 | 5/7 / 5/7 | 5/7 / 5/7 |
| New unsupported questions with candidates | 4/4 | 0/4 | 0/4 | 0/4 |
| Original unsupported questions with candidates | 8/8 | 2/8 | 2/8 | 2/8 |

DeepSeek generated “pouvoirs du Conseil” on the French anchor. Both unique heading promotion and the higher general heading weight moved it to first place, with no additional top-five hits on the new questions. Act identification supplied all four new top-five gains. The model asked for clarification on all four new ambiguous cases and over-clarified one answerable French prompt. It also routed both original municipal lobbying questions to federal results. Keep the scope and evidence decisions under evaluation. These are search candidates, with no legal answers generated.

The initial run produced usable decisions for 21/53 calls. The repeat requested `reasoning_effort: none` and JSON output with the same prompt and 256-token cap, yielding 52/53 usable decisions. The remaining malformed response used literal search and returned the right provision first. Successful calls in the repeat took 1.091 seconds at p50 and 1.866 seconds at p95. [DeepSeek completion options](https://api-docs.deepseek.com/api/create-chat-completion/)

The frozen inputs, both collections, and offline scores are in `dist/evaluation/2026-11-23-heading-rewrite/`. Reproduce scoring with `python3 dist/evaluation/2026-11-23-heading-rewrite/score_heading.py --snapshot /path/to/verified-snapshot`.

#### November 23 paired Vectorize and full-text comparison

All 53 prompts from the heading experiment used the locally verified CPU copy of the staging EmbeddingGemma artifact and LiteRT-LM version, then queried the actual staging Vectorize index through `cf`. The Vectorize watermark matched the verified November publication before and after the run. Four archived hosted controls reproduced the exact top-five order and shared 97 to 100 IDs in the top 100. Every returned ID belonged to the pinned snapshot and requested language. The scoped full-text arm replayed the same recorded DeepSeek decisions and exact-heading promotion. [Cloudflare query contract](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/query/)

Across the 30 answerable development prompts, the first 20 vectors contained the right provision for 28 cases, and the first 20 scoped full-text results contained it for 26. The union contained all 30. Vectorize uniquely supplied four provisions and full-text uniquely supplied two at that depth. With Act identification and the original wording alone, each arm supplied two unique provisions. At depth 100, Vectorize covered all 30 development positives but missed the separate French section 16 anchor. Scoped full-text put that anchor first.

| Ranked configuration | English top five | French top five | Unsupported with candidates | Ambiguous with candidates |
| --- | ---: | ---: | ---: | ---: |
| Raw vector order | 12/15 | 12/15 | 12/12 | 8/8 |
| Vector order with the 0.62 floor | 10/15 | 10/15 | 0/12 | 0/8 |
| Act identification and original wording | 11/15 | 11/15 | 2/12 | 0/8 |
| Scoped full-text with heading rewrite and promotion | 12/15 | 11/15 | 2/12 | 0/8 |
| Equal reciprocal-rank fusion of both top-20 pools | 13/15 | 14/15 | 12/12 | 8/8 |
| Fusion with the same scope decisions as full-text | 13/15 | 13/15 | 2/12 | 0/8 |

Vectorize ranked the correct English labour complaint deadline provision first, and the heading rewrite dropped it outside its top 20. Vectorize also ranked the French personal-information-bank provision first after the scope model asked for clarification. That case lost its result in the scope-gated hybrid. Conversely, equal fusion demoted French section 16 from first to seventh. A follow-up offline diagnostic kept unique verified headings at the top and restored that result to first without changing the development hit counts. Both scope-gated versions still produced federal candidates for the two unsupported municipal lobbying prompts. The comparison measured development candidate recall, ranking, and scope decisions. It made no hosted serving or chat acceptance measurement.

The vector capture, lexical lists, and offline score report are in `dist/evaluation/2026-11-23-vector-hybrid/`. Replay the comparison with `python3 dist/evaluation/2026-11-23-vector-hybrid/score_hybrid.py --snapshot /path/to/verified-snapshot`.

#### November 23 hybrid jurisdiction and evidence check

The prototype checks whose rule or process the user wants, then asks DeepSeek to select one of five retrieved federal passages and copy a continuous supporting quote. Code checks the candidate handle and exact text. The Canada Labour Code candidates include their Part labels from the verified English and French XML blobs at the pinned corpus revision. The prototype retains first-pass jurisdiction refusals and clarifications. It reopens a clarification only with explicit federal wording in the question, a vector result above the existing relevance floor, and a validated supporting excerpt. If a proposed Act yields insufficient evidence and the question supplies neither an Act title nor explicit federal scope, it asks a localized jurisdiction question. [Canada Labour Code Part III application](https://laws-lois.justice.gc.ca/eng/acts/L-2/section-167.html)

| Development measure | Before authority and evidence check | After the combined check |
| --- | ---: | ---: |
| Original answerable top-five hits, EN / FR | 13/15 / 13/15 | 13/15 / 14/15 |
| Original unsupported questions with candidates | 2/12 | 0/12 |
| New authority questions with the correct federal provision, EN / FR | 3/4 / 4/4 | 3/4 / 4/4 |
| New non-federal questions with candidates | 8/8 raw pooled | 0/8 |
| New ambiguous questions asked to clarify | 3/4 in first-pass model routing | 4/4 |

The English and French municipal lobbying regressions both routed outside federal coverage. The evidence check recovered the French personal-information-bank provision and retained the French section 16 heading at rank one. The new valid federal questions exercised municipal records, workplaces in a province, and provincial administration of federal health funding. The English federal lobbying case lacked the required provision in the candidate pool. The other seven new federal cases returned their labelled provision with an exact excerpt. [Lobbying Act section 7](https://laws-lois.justice.gc.ca/eng/acts/L-12.4/section-7.html) · [Access to Information Act section 13](https://laws-lois.justice.gc.ca/eng/acts/A-1/section-13.html) · [Canada Health Act section 13](https://laws-lois.justice.gc.ca/eng/acts/C-6/FullText.html)

The initial evidence review picked the wrong Part of the Canada Labour Code twice and produced two unusable decisions. The replay with Part labels and shorter excerpts returned 73 usable decisions. The final routing and clarification rules were selected after inspecting the development replies. Evidence review alone still tried to answer one ambiguous query. The combined scope decision retained its clarification. Provider p95 for the evidence call was 2.102 seconds, measured separately from query interpretation and retrieval.

The 20 new prompts, staged vector capture, frozen candidate packets, both evidence runs, and raw results are in `dist/evaluation/2026-11-23-hybrid-scope/`. Fresh cases used scoped full-text on literal Act names plus vectors. The later upstream scope replay changed the admission decision using those same candidate lists. Recompute the final report with `python3 dist/evaluation/2026-11-23-hybrid-scope/score.py --with-scope-routing`. This experiment checked passages and candidate routing. Independent chat claim verification remains open.

#### Next comparison

Use the combined prototype as the candidate for serving-path integration. Confirm the full retrieval and evidence path on a fresh named and unnamed calibration set before freezing the policy for D-01. D-02 requires independent review of every factual claim in the registered chat answers.

### Serving verification procedure

- Check that the served revision matches the corpus data during update and recovery. Qualify the exact source, parser, and policy before the run.
- Keep `preRefusalTopScore` as the raw language-filtered top score. If calibration uses the best eligible score, give it distinct telemetry and version its provenance.
- Run fresh Cloudflare calibration before the independent holdout. Report the eligibility rule and keep past hosted results with their original policy.
- Record cache failures separately from provider and text hydration failures. Compare cold and warm paths under a declared cache policy.

The checks below record the initial local qualification and its original prerequisites.
Use the dated hosted observations above and the [master plan](PLAN.md#mp-03-close-serving-acceptance) for current acceptance work.

The focused suite has **47 passing tests** for partitioning/provenance exclusions, denominator math, language pairing, threshold separation, percentile math, actual loopback HTTP requests, bounded concurrency, malformed/error responses, credential-safe redirects, freshness calculations, adapter observations, cache provenance/bypass, successful provider fallbacks, source/parser separation, and strict collection of all 20 calibration cases. Source verification passed as recorded above. An additional 20-request loopback integration passes through the actual portability HTTP handler, shared Postgres retrieval adapter, language filter, observation collector, and CHS in-memory usage ledger: all 20 calibration observations qualify, eight refused scores remain visible, and usage is exactly 20. Its embeddings and scores are deterministic fixtures. These tests establish the measurement contract only; their scores and timing are not CivicSignal retrieval-quality or production-performance results. They require local socket permission in restricted environments.

Before release, retain the following evidence:

1. An authoritative served corpus/index revision and encoder/reranker/deployment snapshot for Cloudflare. Record a fresh upstream head at measurement time.
2. A budgeted credentialed serving-path run on the 64 held-out cases, with failures investigated and bilingual results reviewed. No such new live run has been performed here.
3. Execute and retain the 20-case fresh Cloudflare serving calibration with results split by language. The collection path is implemented and tested; no new calibrated threshold is established without a real run.
4. A bounded live HTTP benchmark with its request budget and cache state stated. No production latency or throughput number is established by the tests.
5. Verify the new provider/fallback observations on the deployed candidate with correlated request evidence. Local instrumentation tests do not prove a live gateway failure or deployed configuration. Per-provider latency remains outside the current observation.
6. If a future release selects the Postgres stack, qualify its held-out quality, performance, and threshold independently.
7. A new non-empty revision published by the automated pipeline, with observed ingestion/freshness lag. A metadata timestamp alone does not prove this end-to-end update path.
