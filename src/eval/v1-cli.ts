import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import bundled from './data/v1-questions.json';
import { eligibleQuestions, validateV1Dataset } from './v1';
import { targetProvenanceSchema, type HttpTarget } from './v1-target';

/** Strict named arguments prevent a mistyped local flag from becoming a live run. */
export function namedArgs(argv: string[], allowed: string[]) {
  const args = new Map<string, string>();
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at]!;
    if (!allowed.includes(name) || args.has(name)) throw new Error(`Unknown or repeated option: ${name}`);
    const value = argv[++at];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    args.set(name, value);
  }
  return args;
}
export function positiveInteger(value: string | undefined, fallback: number, name: string, maximum = 10000) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return parsed;
}
export function writeReport(path: string, report: unknown) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
}
export function inputDataset(path?: string) {
  const source: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : bundled;
  const dataset = validateV1Dataset(source);
  return { dataset, datasetSha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex') };
}
export function targetInputs(args: Map<string, string>) {
  const baseUrl = args.get('--target');
  const path = args.get('--provenance');
  if (!baseUrl || !path) throw new Error('--target and --provenance are required for network measurements');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Target must be a plain HTTP(S) origin without credentials, path, query or fragment');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && url.protocol !== 'https:') throw new Error('Remote targets require HTTPS');
  const provenance = targetProvenanceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (provenance.environment === 'local-fixture' && !local) throw new Error('Fixture evidence must point to a loopback target');
  const route = args.get('--route') ?? (provenance.backend === 'postgres' ? '/api/brief' : '/api/statutes');
  if (route !== '/api/statutes' && route !== '/api/brief') throw new Error('Route must be /api/statutes or /api/brief');
  const key = process.env.CIVICSIGNAL_KEY;
  if (!key && provenance.environment !== 'local-fixture') throw new Error('Set CIVICSIGNAL_KEY for an authenticated deployed target');
  const target: HttpTarget = { baseUrl: url.origin, route, key, timeoutMs: positiveInteger(args.get('--timeout-ms'), 60000, '--timeout-ms', 120000), limit: positiveInteger(args.get('--limit'), 10, '--limit', 100) };
  return { target, provenance, local };
}
export function selection(dataset: ReturnType<typeof inputDataset>['dataset'], revision: string, value?: string) {
  const split = value ?? 'all';
  if (split !== 'all' && split !== 'calibration' && split !== 'holdout') throw new Error('--split must be all, calibration or holdout');
  const selected = eligibleQuestions(dataset, revision, split);
  if (!selected.eligible.some((q) => q.answerable) || !selected.eligible.some((q) => !q.answerable)) throw new Error('Eligible selection must contain both answerability classes; re-verify labels if the target revision changed');
  return selected;
}
export async function readDiscovery(origin: string) {
  try {
    const response = await fetch(new URL('/.well-known/civicsignal.json', origin), { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) return { status: response.status, encoder: null };
    const body: unknown = await response.json();
    const encoder = body && typeof body === 'object' && 'encoder' in body ? body.encoder : null;
    return { status: response.status, encoder };
  } catch (error) { return { status: null, encoder: null, failure: error instanceof Error ? error.name : 'UNKNOWN' }; }
}
