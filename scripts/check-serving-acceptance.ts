#!/usr/bin/env bun
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { checkServingAcceptance } from '../src/eval/serving-acceptance';
import { inputDataset, namedArgs, positiveInteger } from '../src/eval/v1-cli';
import { targetProvenanceSchema } from '../src/eval/v1-target';

function evidenceFile(path: string | undefined) {
  if (!path) throw new Error('Missing evidence path');
  const file = statSync(path);
  if (!file.isFile() || file.size > 16 * 1024 * 1024) throw new Error('Invalid evidence file');
  return path;
}

function readEvidence(path: string | undefined): unknown {
  return JSON.parse(readFileSync(evidenceFile(path), 'utf8')) as unknown;
}

function localAncestorTime(repository: string, ancestor: string, head: string) {
  // Missing objects in a partial clone must fail instead of fetching.
  const options: ExecFileSyncOptionsWithStringEncoding = {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 8192,
  };
  const git = (args: string[]) => execFileSync('git', ['--no-replace-objects', '-C', repository, ...args], options);
  try {
    git(['merge-base', '--is-ancestor', ancestor, head]);
    const seconds = git(['show', '-s', '--format=%ct', ancestor]).trim();
    if (/^\d+$/.test(seconds)) return Number(seconds) * 1000;
  } catch {
    return undefined;
  }
}

try {
  const args = namedArgs(process.argv.slice(2), ['--dataset', '--provenance', '--origin', '--limit', '--benchmark-split',
    '--calibration', '--holdout', '--benchmark', '--approved-ancestor', '--source-repo']);
  const origin = args.get('--origin');
  const url = new URL(origin ?? '');
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid origin');
  const benchmarkSplit = args.get('--benchmark-split');
  if (benchmarkSplit !== 'all' && benchmarkSplit !== 'holdout' && benchmarkSplit !== 'calibration') throw new Error('Invalid benchmark split');
  const sourceRepo = args.get('--source-repo');
  const approvedAncestor = args.get('--approved-ancestor');
  if ((approvedAncestor && !/^[a-f0-9]{40}$/.test(approvedAncestor)) || Boolean(sourceRepo) !== Boolean(approvedAncestor)) {
    throw new Error('Supply the exact ancestor pin and local source repository together');
  }
  const dataset = inputDataset(evidenceFile(args.get('--dataset')));
  const provenance = targetProvenanceSchema.parse(readEvidence(args.get('--provenance')));
  const result = checkServingAcceptance({
    ...dataset,
    provenance,
    origin,
    limit: positiveInteger(args.get('--limit'), 10, '--limit', 100),
    benchmarkSplit,
    approvedAncestor,
    ancestorCommitTime: sourceRepo ? (ancestor, head) => localAncestorTime(sourceRepo, ancestor, head) : undefined,
    calibration: readEvidence(args.get('--calibration')),
    holdout: readEvidence(args.get('--holdout')),
    benchmark: readEvidence(args.get('--benchmark')),
  });
  console.log(JSON.stringify({ ...result, deployment: provenance.deployment, corpusRevision: provenance.corpusRevision,
    upstreamRevision: provenance.upstream.revision, datasetSha256: dataset.datasetSha256 }));
  if (!result.ready) process.exitCode = 1;
} catch {
  console.error('Supply readable --dataset, --provenance, --calibration, --holdout, and --benchmark JSON files with the reviewed --origin and --benchmark-split.');
  process.exitCode = 1;
}
