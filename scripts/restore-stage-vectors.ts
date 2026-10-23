#!/usr/bin/env bun
/** Local validation by default; --apply only restores a separately approved stage index. */
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { token } from './lib/cloudflare-auth';
import { applyStageVectorPlan, assertStageVectorTarget, prepareStageVectorPlan, StageVectorApi, type StageVectorTarget } from './lib/stage-vector-restore';

const values = new Map<string, string>();
let apply = false;
const args = process.argv.slice(2);
for (let at = 0; at < args.length; at++) {
  const flag = args[at]!;
  if (flag === '--apply') { if (apply) throw new Error('Repeated --apply.'); apply = true; continue; }
  if (!['--dir', '--revision', '--receipt', '--receipt-sha256', '--account', '--index', '--metric', '--journal', '--max-batches'].includes(flag) || values.has(flag) || !args[at + 1] || args[at + 1]!.startsWith('--')) throw new Error('Unknown, repeated or incomplete stage restore argument.');
  values.set(flag, args[++at]!);
}
const required = (name: string) => { const value = values.get(name); if (!value) throw new Error(`${name} is required; no production defaults exist.`); return value; };
const metric = required('--metric');
if (metric !== 'cosine' && metric !== 'euclidean' && metric !== 'dot-product') throw new Error('Invalid explicit Vectorize metric.');
const target: StageVectorTarget = { account: required('--account'), index: required('--index'), metric };
assertStageVectorTarget(target);
const plan = await prepareStageVectorPlan({ directory: resolve(required('--dir')), revision: required('--revision'),
  receipt: resolve(required('--receipt')), receiptSha256: required('--receipt-sha256'), progress: message => console.log(message) });
if (!apply) {
  console.log(JSON.stringify({ mode: 'local-validation', source: plan.source, target, receiptSha256: plan.receiptSha256,
    storeSha256: plan.storeSha256, writes: false, networkRequests: 0, documentEmbeddings: 0 }, null, 2));
} else {
  const journal = resolve(required('--journal'));
  await mkdir(dirname(journal), { recursive: true });
  const lock = await open(`${journal}.lock`, 'wx', 0o600);
  try {
    const result = await applyStageVectorPlan(plan, new StageVectorApi(target, () => process.env.CLOUDFLARE_API_TOKEN ?? token()), {
      journal, maxBatches: Number(values.get('--max-batches') ?? 100), progress: message => console.log(message),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await lock.close(); await unlink(`${journal}.lock`); }
}
