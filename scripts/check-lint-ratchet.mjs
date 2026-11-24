import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policy } from '../house-rules/index.mjs';

const base = process.env.RATCHET_BASE_SHA;
const baselinePath = '.ratchet-strap.json';
const args = ['node_modules/@chester-hill-solutions/ratchet-strap/dist/cli.js', 'check', '--exec-eslint'];
let temporary;

try {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (baseline.mode !== 'identities' ||
    JSON.stringify(Object.keys(baseline.identities).sort()) !== JSON.stringify(Object.keys(policy.rules).sort())) {
    throw new Error('The Ratchet Strap baseline must track every configured rule in identity mode.');
  }
  if (base && !/^0{40}$/u.test(base)) {
    if (!/^[a-f0-9]{40}$/u.test(base)) throw new Error('RATCHET_BASE_SHA must be a Git commit SHA.');
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`]);
    const existing = execFileSync('git', ['ls-tree', '--name-only', base, '--', baselinePath], { encoding: 'utf8' });
    if (existing.trim() === baselinePath) {
      temporary = mkdtempSync(join(tmpdir(), 'civicsignal-ratchet-'));
      const predecessor = join(temporary, 'baseline.json');
      writeFileSync(predecessor, execFileSync('git', ['show', `${base}:${baselinePath}`]));
      args.push('--previous-baseline', predecessor);
    }
  }

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const report = JSON.parse(result.stdout);
    console.log(`Ratchet Strap verified ${Object.keys(report.counts).length} rules across ${report.files} files.`);
  } else if (result.status === 1) {
    const { diagnostics, ...summary } = JSON.parse(result.stdout);
    console.error(JSON.stringify(summary, null, 2));
  } else {
    process.stderr.write(result.stdout ?? 'Ratchet Strap did not finish.\n');
  }
  process.exitCode = result.status ?? 2;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
