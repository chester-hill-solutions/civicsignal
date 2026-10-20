#!/usr/bin/env node
/**
 * Billing invariants.
 *
 * The rule this product cannot get wrong: a billable unit is recorded only after a
 * successful retrieval, never on an error, and never more than once per request.
 * The failure mode is invisible at runtime — a route that bills before it knows
 * whether it succeeded quietly overcharges.
 *
 * These checks read the source rather than instrumenting it, so they have to find
 * the *order* rather than the presence of a call. The first version of this file
 * compared two string offsets in the whole file, which stopped establishing the
 * invariant the moment a second route was added: it looked at the first billing
 * call and the first query call, wherever they happened to be, and reported on
 * those. A check that reports success without establishing anything is worse than
 * no check, so this version works per handler.
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

// 1. Every API route must go through the spine's billable recorder, and every one
//    must authenticate a server key.
const indexSrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
if (!indexSrc.includes('recordSuccessfulBillable')) {
  failures.push('src/index.ts never records a billable unit');
}
if (!indexSrc.includes('authorizeServerKey')) {
  failures.push('src/index.ts never authenticates a server key');
}

// 2. Within every handler that bills, the retrieval must happen before the billing.
//    Work is done by one of: the query runner, the chat runner, the vector index, or
//    the brief builder. A handler that bills without any of them is billing for
//    nothing.
const WORK_CALLS = [
  'await runQuery(',
  'await runChat(',
  'await index.query(',
  'await buildBrief(',
];
const BILL_CALL = 'await recordSuccessfulBillable(';

/** Split a source file into `async function name(...) { … }` bodies. */
function handlerBodies(text) {
  const bodies = [];
  const re = /async function (\w+)\s*\([^)]*\)\s*(?::[^{]*)?\{/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    bodies.push({ name: match[1], body: text.slice(start, i) });
  }
  return bodies;
}

for (const { path, text } of sources) {
  for (const handler of handlerBodies(text)) {
    const billIdx = handler.body.indexOf(BILL_CALL);
    if (billIdx === -1) continue;

    const workIdx = WORK_CALLS.map((c) => handler.body.indexOf(c))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0];

    if (workIdx === undefined) {
      failures.push(`${path}: ${handler.name} bills without doing any work`);
    } else if (workIdx > billIdx) {
      failures.push(`${path}: ${handler.name} records the billable unit before the work`);
    }
  }
}

// 3. A route must not bill twice.
for (const { path, text } of sources) {
  for (const handler of handlerBodies(text)) {
    const count = handler.body.split(BILL_CALL).length - 1;
    if (count > 1) {
      failures.push(`${path}: ${handler.name} records ${count} billable units`);
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
  'billing-invariants: ok (bill-after-work, single-record, work-before-bill per handler, free-allowance default, corpus regimes declared, price consistent)',
);
