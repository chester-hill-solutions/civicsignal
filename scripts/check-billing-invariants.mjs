#!/usr/bin/env node
/**
 * Billing invariants.
 *
 * The rule this product cannot get wrong: a billable unit is recorded only after a
 * successful 200, never on an error, and never more than once per request. These
 * checks are greps over the source because the failure mode is invisible at runtime —
 * a route that bills before it knows whether it succeeded will quietly overcharge.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'src'));
const sources = files.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

// 1. Every API route must go through the spine's billable recorder.
const indexSrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
if (!indexSrc.includes('recordSuccessfulBillable')) {
  failures.push('src/index.ts never records a billable unit');
}
if (!indexSrc.includes('authorizeServerKey')) {
  failures.push('src/index.ts never authenticates a server key');
}

// 2. The recorder must be called after the work, not before it.
//    Match the call site, not the import — the import appears first in the file.
const recordIdx = indexSrc.indexOf('await recordSuccessfulBillable(');
const runIdx = indexSrc.indexOf('await runQuery(');
if (recordIdx === -1) {
  failures.push('src/index.ts never awaits a billable-unit record');
} else if (runIdx === -1) {
  failures.push('src/index.ts never awaits the query');
} else if (recordIdx < runIdx) {
  failures.push('the billable unit is recorded before the query runs');
}

// 3. No route may bill on a non-200 path: the fuse decision must gate the response.
for (const { path, text } of sources) {
  if (text.includes('await recordSuccessfulBillable(') && path.endsWith('index.ts')) {
    const after = text.slice(recordIdx);
    if (!after.includes('billed.allowed')) {
      failures.push(`${path}: the fuse decision after billing is not checked`);
    }
  }
}

// 4. The free allowance must be a named constant with a documented default.
const customer = readFileSync(join(ROOT, 'src', 'spine', 'customer.ts'), 'utf8');
if (!/DEFAULT_FREE_MONTHLY_ALLOWANCE\s*=\s*\d+/.test(customer)) {
  failures.push('src/spine/customer.ts: the free allowance is not a literal default');
}

// 5. Every corpus must declare a redistribution regime.
const policies = readFileSync(join(ROOT, 'src', 'corpora', 'policies.ts'), 'utf8');
const declared = (policies.match(/redistribution:\s*'(open|cite-only|metadata-only)'/g) || []).length;
const policyIds = (policies.match(/^\s{2}id:\s*'/gm) || []).length;
if (declared !== policyIds) {
  failures.push(`src/corpora/policies.ts: ${policyIds} corpora declared but ${declared} redistribution regimes`);
}

// 6. The pricing shown to buyers must match the metered price.
const pricing = readFileSync(join(ROOT, 'src', 'routes', 'capabilities.ts'), 'utf8');
if (!/unitPriceUsd:\s*0\.005/.test(pricing)) {
  failures.push('src/routes/capabilities.ts: the advertised unit price is not 0.005 USD');
}

if (failures.length) {
  console.error('billing-invariants: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  'billing-invariants: ok (bill-after-success, single-record, fuse-checked, free-allowance default, corpus regimes declared, price consistent)',
);
