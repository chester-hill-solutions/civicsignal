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

The original ledger now retains **154/160** reservations, six unspent, with its
original prefix and no reset. The restarted diagnostic relay's owned process
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
This source remains undeployed. The original serving ledger stays at **154/160**;
no generation or retrieval call was added. The previous holdout and benchmark
failures remain open. New hosted acceptance must name the actual deployed source
and cache contract; it cannot reinterpret the earlier measurements as a pass.

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
- Dataset SHA-256: `5947e2417cebd4883df368a4aeca1dccdb79bd0329056155d7420016431f8cf9`.
- Verification artifact generated locally: `dist/evaluation/v1-labels.json`.

The negative set expressly asks for a different authority or source: provincial/municipal/foreign rules, court reasons, weather, statistics, current administrative amounts, and monetary-policy announcements. These are scope labels, not verified statements about those external sources. Federal minimum wage questions distinguish the current amount on a government webpage from the statutory rule. The Ontario HST-rate pair stays **unverified**: a rate may be stated in federal legislation, so its absence must not be assumed.

The Canada Health Act source produced a preamble row with section label `8` as well as the real section. Gold uses the actual headed provision identifier, never the preamble row. Existence of an Act/section pair alone is insufficient label verification.

`src/eval/questions.ts` remains the legacy development set for reproducing historical runs. Its historical negatives and thresholds are not release holdout evidence. In particular, the 0.62 Vectorize floor recorded in the handoff was tuned on prior probes. This dataset does not independently validate it until the held-out run is complete.

## Reproduce label verification

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

## Verification status and remaining prerequisites

The focused suite has **47 passing tests** for partitioning/provenance exclusions, denominator math, language pairing, threshold separation, percentile math, actual loopback HTTP requests, bounded concurrency, malformed/error responses, credential-safe redirects, freshness calculations, adapter observations, cache provenance/bypass, successful provider fallbacks, source/parser separation, and strict collection of all 20 calibration cases. Source verification passed as recorded above. An additional 20-request loopback integration passes through the actual portability HTTP handler, shared Postgres retrieval adapter, language filter, observation collector, and CHS in-memory usage ledger: all 20 calibration observations qualify, eight refused scores remain visible, and usage is exactly 20. Its embeddings and scores are deterministic fixtures. These tests establish the measurement contract only; their scores and timing are not CivicSignal retrieval-quality or production-performance results. They require local socket permission in restricted environments.

Before release, retain the following evidence:

1. An authoritative served corpus/index revision and encoder/reranker/deployment snapshot for Cloudflare. Record a fresh upstream head at measurement time.
2. A budgeted credentialed serving-path run on the 64 held-out cases, with failures investigated and bilingual results reviewed. No such new live run has been performed here.
3. Execute and retain the 20-case fresh serving calibration per backend and language. The collection path is implemented and tested; no new calibrated threshold is established without a real run.
4. A bounded live HTTP benchmark with its request budget and cache state stated. No production latency or throughput number is established by the tests.
5. Verify the new provider/fallback observations on the deployed candidate with correlated request evidence. Local instrumentation tests do not prove a live gateway failure or deployed configuration. Per-provider latency remains outside the current observation.
6. Postgres held-out/performance evidence if Postgres is advertised as a production-equivalent backend. Its portability implementation must not inherit a Vectorize threshold without measurement.
7. A new non-empty revision published by the automated pipeline, with observed ingestion/freshness lag. A metadata timestamp alone does not prove this end-to-end update path.
