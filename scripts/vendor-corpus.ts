/** Refresh committed CHS runtimes from an explicitly pinned, clean source checkout.
 * CHS_REPO=/path/to/chester-hill-solutions CHS_SOURCE_REF=<commit> bun scripts/vendor-corpus.ts corpus api-billing
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.env.CHS_REPO && resolve(process.env.CHS_REPO);
const pin = process.env.CHS_SOURCE_REF;
if (!source || !pin || !/^[0-9a-f]{40}$/.test(pin)) throw new Error('Set CHS_REPO and CHS_SOURCE_REF to the exact reviewed 40-character commit.');
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', source!, ...args], { stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Cannot inspect the CHS source checkout');
  return result.stdout.toString().trim();
}
if (git('rev-parse', 'HEAD') !== pin || git('status', '--porcelain', '--untracked-files=normal')) throw new Error('CHS source must be clean and checked out at CHS_SOURCE_REF.');
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['corpus', 'api-billing'];
if (new Set(names).size !== names.length || names.some(name => !['corpus', 'api-billing'].includes(name))) throw new Error('Supported packages: corpus api-billing');
const receiptPath = join(root, 'vendor/chs-provenance.json');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const staging = mkdtempSync(join(tmpdir(), 'civicsignal-vendor-'));
function hashes(directory: string, prefix = ''): { path: string; sha256: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${path}`);
    return entry.isDirectory() ? hashes(join(directory, entry.name), path) : [{ path, sha256: createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex') }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
try {
  const updates = names.map(name => {
    const packageSource = join(source, 'packages', name);
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: packageSource, stdout: 'inherit', stderr: 'inherit' });
    if (build.exitCode !== 0) throw new Error(`Build failed: ${name}`);
    const manifest = JSON.parse(readFileSync(join(packageSource, 'package.json'), 'utf8'));
    if (manifest.name !== `@chester-hill-solutions/${name}`) throw new Error('Unexpected package identity');
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (Object.values(manifest[group] ?? {}).some(value => typeof value !== 'string' || /^(workspace:|file:|link:)/.test(value))) throw new Error('Internal dependencies require release staging before vendoring');
    }
    const target = join(staging, name);
    for (const file of [...(manifest.files ?? ['dist']), 'README.md', 'LICENSE']) {
      if (file.includes('..') || file.startsWith('/')) throw new Error('Unsafe package file path');
      if (existsSync(join(packageSource, file))) cpSync(join(packageSource, file), join(target, file), { recursive: true });
    }
    delete manifest.scripts;
    delete manifest.devDependencies;
    manifest.gitHead = pin;
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { package: manifest.name, version: manifest.version, sourceCommit: pin, sourcePath: `packages/${name}`, files: hashes(target), target };
  });
  // Validate all builds before replacing any committed runtime.
  for (const { target, ...entry } of updates) {
    const destination = join(root, 'vendor', entry.package);
    rmSync(destination, { recursive: true, force: true });
    cpSync(target, destination, { recursive: true });
    receipt.packages = receipt.packages.filter((old: { package: string }) => old.package !== entry.package);
    receipt.packages.push(entry);
  }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
} finally { rmSync(staging, { recursive: true, force: true }); }
console.log('CHS runtimes refreshed. Run bun install --force, then bun run validate.');
