#!/usr/bin/env bun
/** Bounded closed-loop HTTP measurement against an explicitly running deployment. */
import { latencySummary } from '../src/eval/v1';
import { balancedSchedule, collectObservations, corpusFreshness, requestRetrieval } from '../src/eval/v1-target';
import { inputDataset, namedArgs, positiveInteger, readDiscovery, selection, targetInputs, writeReport } from '../src/eval/v1-cli';
import { servingObservationSummary, validateServingProvenance } from '../src/eval/v1-observed';

const args = namedArgs(process.argv.slice(2), ['--target', '--provenance', '--route', '--dataset', '--split', '--limit', '--timeout-ms', '--output', '--requests', '--warmup', '--concurrency']);
const { dataset, datasetSha256 } = inputDataset(args.get('--dataset'));
const { target, provenance } = targetInputs(args);
const selected = selection(dataset, provenance.corpusRevision, args.get('--split'));
const count = positiveInteger(args.get('--requests'), 30, '--requests', 1000);
const warmup = Number(args.get('--warmup') ?? '3');
if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 100) throw new Error('--warmup must be an integer between 0 and 100');
const levels = (args.get('--concurrency') ?? '1,4').split(',').map((value) => positiveInteger(value, 1, '--concurrency', 16));
if (new Set(levels).size !== levels.length) throw new Error('Concurrency levels must be unique');
const discovery = await readDiscovery(target.baseUrl);
if (discovery.encoder && typeof discovery.encoder === 'object' && 'model' in discovery.encoder && discovery.encoder.model !== provenance.encoderModel) throw new Error('Published encoder model differs from operator provenance');
const startedAt = new Date();
const runs = [];
const schedule = balancedSchedule(selected.eligible, count);
for (const concurrency of levels) {
  const warmups = await collectObservations(Array.from({ length: warmup }, (_, at) => selected.eligible[at % selected.eligible.length]!), concurrency, (question) => requestRetrieval(target, question));
  warmups.observations = validateServingProvenance(warmups.observations, provenance);
  const measured = await collectObservations(schedule.map((question, at) => ({ ...question, id: `${question.id}#${at}` })), concurrency, (question) => requestRetrieval(target, question));
  measured.observations = validateServingProvenance(measured.observations, provenance);
  const succeeded = measured.observations.filter((observation) => observation.outcome === 'ok');
  runs.push({
    concurrency, warmupRequests: warmup, warmupFailures: warmups.observations.filter((o) => o.outcome !== 'ok').length,
    warmupObservations: warmups.observations,
    measuredRequests: count, completedRequests: succeeded.length,
    errorResponses: measured.observations.filter((o) => o.outcome === 'http-error').length,
    transportErrors: measured.observations.filter((o) => o.outcome === 'transport-error').length,
    invalidResponses: measured.observations.filter((o) => o.outcome === 'invalid-response').length,
    upstreamErrorResponses: measured.observations.filter((o) => [502, 503, 504].includes(o.status ?? 0)).length,
    wallMs: measured.elapsedMs,
    attemptedRequestsPerSecond: measured.attemptedRequestsPerSecond,
    completedRequestsPerSecond: succeeded.length / (measured.elapsedMs / 1000),
    latencyAllAttempts: latencySummary(measured.observations.map((o) => o.elapsedMs)),
    latencyCompleted: latencySummary(succeeded.map((o) => o.elapsedMs)),
    observations: measured.observations,
    servingObservations: servingObservationSummary(measured.observations),
  });
}
const endedAt = new Date();
const report = {
  kind: 'closed-loop-serving-http-benchmark', startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
  target: { origin: target.baseUrl, route: target.route, limit: target.limit }, provenance,
  provenanceTrust: 'serving response backend/corpus/parser/model/policy must match operator provenance; other state remains operator supplied', discovery,
  dataset: { version: dataset.version, sha256: datasetSha256, eligibleQuestions: selected.eligible.length, excluded: selected.excluded },
  loadModel: 'bounded closed-loop; no claim about open-loop capacity, saturation, CPU, or maximum sustainable throughput',
  requestMix: { rule: 'round robin across answerable/unanswerable and English/French; repeats within each bucket', answerable: schedule.filter((q) => q.answerable).length, unanswerable: schedule.filter((q) => !q.answerable).length, en: schedule.filter((q) => q.language === 'en').length, fr: schedule.filter((q) => q.language === 'fr').length },
  cacheState: 'uncontrolled, warmed by explicit warmup calls; repeats can use cache; no cold-cache or uncached-provider performance claim',
  providerFailureTelemetry: 'Serving metadata identifies per-provider errors and fallbacks when present; HTTP upstream errors and missing metadata are counted separately',
  corpusFreshness: corpusFreshness(provenance, endedAt),
  billableRequestsAttempted: levels.length * (warmup + count), runs,
};
const output = args.get('--output') ?? 'dist/evaluation/v1-benchmark.json';
writeReport(output, report);
console.log(JSON.stringify({ output, target: report.target, runs: runs.map(({ observations: _, ...run }) => run) }, null, 2));
if (runs.some((run) => run.completedRequests !== run.measuredRequests || run.warmupFailures)) process.exitCode = 1;
