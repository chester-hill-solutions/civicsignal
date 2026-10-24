#!/usr/bin/env node
/**
 * Static billing architecture checks. These establish dependency boundaries,
 * not runtime billing order or call counts. The endpoint and access tests verify
 * successful-call billing, errors, quota enforcement, and MCP bookkeeping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];
const modules = new Map();

function load(path) {
  if (modules.has(path)) return modules.get(path);
  if (!existsSync(path)) {
    failures.push(`missing module: ${relative(ROOT, path)}`);
    return null;
  }
  const text = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  for (const statement of ast.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  const module = { text, imports };
  modules.set(path, module);
  return module;
}

// Trace the production Worker, including MCP. An old implementation may remain
// as a migration reference, but it must not become reachable from an entrypoint.
const reachable = new Set();
function visit(path) {
  if (reachable.has(path)) return;
  reachable.add(path);
  const module = load(path);
  if (!module) return;
  for (const dependency of module.imports) {
    if (!dependency.startsWith('.')) continue;
    const base = resolve(dirname(path), dependency);
    const target = [base, `${base}.ts`, join(base, 'index.ts')].find(existsSync);
    if (!target) {
      failures.push(`${relative(ROOT, path)}: unresolved local import ${dependency}`);
    } else visit(target);
  }
}
visit(join(ROOT, 'src/index.ts'));

for (const legacy of ['src/spine/api-keys.ts', 'src/spine/billing.ts', 'src/spine/quota.ts']) {
  if (reachable.has(join(ROOT, legacy))) failures.push(`Worker reaches legacy implementation ${legacy}`);
}

for (const [file, packages] of [
  ['src/access.ts', ['@chester-hill-solutions/auth', '@chester-hill-solutions/auth-d1']],
  ['src/metering.ts', ['@chester-hill-solutions/api-billing']],
]) {
  const path = join(ROOT, file);
  const module = load(path);
  if (!reachable.has(path)) failures.push(`${file} is not reachable from the production Worker`);
  for (const dependency of packages) {
    if (!module?.imports.some((value) => value === dependency || value.startsWith(`${dependency}/`))) {
      failures.push(`${file} must use ${dependency}`);
    }
  }
}

const policies = load(join(ROOT, 'src/corpora/policies.ts'));
const declared = (policies?.text.match(/redistribution:\s*'(open|cite-only|metadata-only)'/g) ?? []).length;
const policyIds = (policies?.text.match(/^\s{2}id:\s*'/gm) ?? []).length;
if (declared !== policyIds || policyIds === 0) {
  failures.push(`corpus policies declare ${policyIds} corpora and ${declared} redistribution regimes`);
}

// v1 has no confirmed public paid price. Discovery must not promise a stale
// historical estimate; the configured workspace plan remains authoritative.
const pricing = load(join(ROOT, 'src/routes/capabilities.ts'));
if (!/unitPriceUsd:\s*null/.test(pricing?.text ?? '')) {
  failures.push('v1 must leave the unconfigured public paid price null');
}

if (failures.length) {
  console.error('billing-invariants: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('billing-invariants: ok (CHS auth/metering dependencies, no reachable legacy implementations, honest v1 price contract, corpus redistribution declarations)');
