#!/usr/bin/env bun
/** Actual serving-path evaluation. No direct vector/database bypass and no automatic threshold changes. */
import { scoreV1 } from '../src/eval/v1';
import { corpusFreshness, collectObservations, requestRetrieval } from '../src/eval/v1-target';
import { inputDataset, namedArgs, positiveInteger, readDiscovery, selection, targetInputs, writeReport } from '../src/eval/v1-cli';
import { verifyLabelSources } from '../src/eval/v1-source';
import { observedCalibration, servingObservationSummary, validateServingProvenance } from '../src/eval/v1-observed';

const args = namedArgs(process.argv.slice(2), ['--target', '--provenance', '--route', '--dataset', '--split', '--concurrency', '--limit', '--timeout-ms', '--output', '--verify-sources', '--verify-only', '--calibrate-observed']);
const { dataset, datasetSha256 } = inputDataset(args.get('--dataset'));
const sourceVerification = args.has('--verify-sources') ? verifyLabelSources(dataset, args.get('--verify-sources')!) : null;
if (sourceVerification?.rejected.length) throw new Error(`Source verification rejected ${sourceVerification.rejected.length} labels: ${JSON.stringify(sourceVerification.rejected)}`);
if (args.get('--verify-only') === 'true') {
  if (!sourceVerification) throw new Error('--verify-only true requires --verify-sources <corpus clone>');
  const result = { datasetVersion: dataset.version, datasetSha256, sourceVerification,
    sourceVerifiedQuestions: dataset.questions.filter((q) => q.status === 'verified-source').length,
    scopeVerifiedQuestions: dataset.questions.filter((q) => q.status === 'verified-scope').length,
    unverifiedExcluded: dataset.questions.filter((q) => q.status === 'unverified').map((q) => q.id) };
  writeReport(args.get('--output') ?? 'dist/evaluation/v1-labels.json', result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (args.has('--verify-only')) throw new Error('--verify-only accepts only true');
const { target, provenance } = targetInputs(args);
if (args.has('--calibrate-observed') && args.get('--calibrate-observed') !== 'true') throw new Error('--calibrate-observed accepts only true');
const calibrateObserved = args.get('--calibrate-observed') === 'true';
if (calibrateObserved && args.get('--split') !== 'calibration') throw new Error('--calibrate-observed requires --split calibration; holdout cannot select a threshold');
target.fresh = calibrateObserved;
const selected = selection(dataset, provenance.corpusRevision, args.get('--split'));
const concurrency = positiveInteger(args.get('--concurrency'), 1, '--concurrency', 32);
const discovery = await readDiscovery(target.baseUrl);
if (discovery.encoder && typeof discovery.encoder === 'object' && 'model' in discovery.encoder && discovery.encoder.model !== provenance.encoderModel) throw new Error('Published encoder model differs from operator provenance');
const startedAt = new Date();
const measured = await collectObservations(selected.eligible, concurrency, (question) => requestRetrieval(target, question));
measured.observations = validateServingProvenance(measured.observations, provenance);
const endedAt = new Date();
const calibration = calibrateObserved ? observedCalibration(dataset.questions, measured.observations, provenance) : null;
const report = {
  kind: 'serving-path-retrieval-evaluation', startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
  target: { origin: target.baseUrl, route: target.route, concurrency, limit: target.limit },
  provenance, provenanceTrust: 'serving response backend/corpus/parser/model/policy must match operator provenance; other state remains operator supplied', discovery,
  dataset: { version: dataset.version, sha256: datasetSha256, excluded: selected.excluded }, sourceVerification,
  cacheState: calibrateObserved ? 'fresh execution requested through authenticated evaluation header; only computed serving scores qualify' : 'per-response metadata identifies hits, misses and originating cached scores',
  providerFailureTelemetry: 'per-response serving observations identify provider errors and successful fallbacks; requests without observations remain unknown',
  servingObservations: servingObservationSummary(measured.observations),
  freshness: corpusFreshness(provenance, endedAt), calibration,
  metrics: scoreV1(selected.eligible, measured.observations),
  timing: { wallMs: measured.elapsedMs, attemptedRequestsPerSecond: measured.attemptedRequestsPerSecond, completedRequestsPerSecond: measured.observations.filter((o) => o.outcome === 'ok').length / (measured.elapsedMs / 1000) },
  observations: measured.observations,
};
const output = args.get('--output') ?? 'dist/evaluation/v1-serving.json';
writeReport(output, report);
console.log(JSON.stringify({ output, metrics: report.metrics, freshness: report.freshness }, null, 2));
if (report.metrics.overall.requestErrors || report.metrics.overall.missing) process.exitCode = 1;
if (calibration && !calibration.ready) process.exitCode = 1;
