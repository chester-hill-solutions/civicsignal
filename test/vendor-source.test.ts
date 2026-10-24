import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHS_VENDOR_PACKAGES, preparePinnedChsSource, vendorPackageMetadata } from '../scripts/lib/vendor-source';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (cwd: string, message: string) => git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', message]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'civicsignal-vendor-source-'));
  temporary.push(root);
  const origin = join(root, 'origin');
  const source = join(root, 'base-only');
  mkdirSync(origin);
  git(origin, ['init', '--quiet']);
  writeFileSync(join(origin, 'README.md'), 'Base package source.\n');
  git(origin, ['add', '.']); commit(origin, 'Initial source');
  const initial = git(origin, ['rev-parse', 'HEAD']);
  // A real gitlink must survive reconstruction even though tar archives omit it.
  git(origin, ['update-index', '--add', '--cacheinfo', `160000,${initial},vendor/nested`]);
  commit(origin, 'Base source with gitlink');
  const baseRevision = git(origin, ['rev-parse', 'HEAD']);
  git(origin, ['branch', 'pinned-base']);
  writeFileSync(join(origin, 'README.md'), 'Patched package source.\n');
  writeFileSync(join(origin, 'operation.ts'), 'export const operation = 1;\n');
  git(origin, ['add', 'README.md', 'operation.ts']); commit(origin, 'Idempotent operation patch');
  const revision = git(origin, ['rev-parse', 'HEAD']);
  const sourceTree = git(origin, ['rev-parse', 'HEAD^{tree}']);
  mkdirSync(join(root, 'patches'));
  const patch = execFileSync('git', ['format-patch', '--stdout', `${baseRevision}..${revision}`], { cwd: origin });
  writeFileSync(join(root, 'patches/source.patch'), patch);
  git(root, ['clone', '--quiet', '--no-local', '--depth=1', '--branch', 'pinned-base', origin, source]);
  const sourcePatch = { path: 'patches/source.patch', sha256: createHash('sha256').update(patch).digest('hex') };
  return { root, origin, source, pin: { revision, baseRevision, sourceTree, sourcePatch } };
}

describe('pinned CHS refresh source', () => {
  it('reconstructs the exact patched tree from base-only objects and preserves the source worktree', () => {
    const test = fixture();
    expect(spawnSync('git', ['cat-file', '-e', `${test.pin.revision}^{commit}`], { cwd: test.source }).status).not.toBe(0);
    writeFileSync(join(test.source, 'README.md'), 'Uncommitted operator work.\n');
    const status = git(test.source, ['status', '--porcelain']);
    const checkout = join(test.root, 'checkout');
    const provenance = preparePinnedChsSource(test.root, test.source, checkout, test.pin);
    expect(provenance).toEqual(test.pin);
    expect(git(checkout, ['write-tree'])).toBe(test.pin.sourceTree);
    expect(git(checkout, ['ls-files', '--stage', 'vendor/nested'])).toContain('160000');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('Patched package source.\n');
    expect(readFileSync(join(checkout, 'operation.ts'), 'utf8')).toContain('operation = 1');
    expect(git(test.source, ['rev-parse', 'HEAD'])).toBe(test.pin.baseRevision);
    expect(git(test.source, ['status', '--porcelain'])).toBe(status);
    expect(readFileSync(join(test.source, 'README.md'), 'utf8')).toBe('Uncommitted operator work.\n');
    expect(spawnSync('git', ['cat-file', '-e', `${test.pin.revision}^{commit}`], { cwd: test.source }).status).not.toBe(0);
  });

  it('uses the available target commit directly and retains all provenance fields', () => {
    const test = fixture();
    const checkout = join(test.root, 'direct');
    expect(preparePinnedChsSource(test.root, test.origin, checkout, test.pin)).toEqual(test.pin);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(test.pin.revision);
  });

  it('produces identical trees on repeated base-only refreshes', () => {
    const test = fixture();
    for (const name of ['first', 'second']) {
      const checkout = join(test.root, name);
      expect(preparePinnedChsSource(test.root, test.source, checkout, test.pin).sourceTree).toBe(test.pin.sourceTree);
    }
  });

  it('rejects a changed patch before materializing source or running a build', () => {
    const test = fixture();
    writeFileSync(join(test.root, test.pin.sourcePatch.path), 'Tampered patch.\n');
    const checkout = join(test.root, 'rejected');
    expect(() => preparePinnedChsSource(test.root, test.source, checkout, test.pin)).toThrow('fingerprint');
    expect(existsSync(checkout)).toBe(false);
  });

  it('rejects an applied patch whose tree is not the pinned tree', () => {
    const test = fixture();
    expect(() => preparePinnedChsSource(test.root, test.source, join(test.root, 'rejected'), {
      ...test.pin, sourceTree: '0'.repeat(40),
    })).toThrow('reconstructed CHS source tree');
  });

  it('requires complete fallback provenance and confines the patch path', () => {
    const test = fixture();
    expect(() => preparePinnedChsSource(test.root, test.source, join(test.root, 'missing'), { revision: test.pin.revision })).toThrow('baseRevision, sourceTree');
    expect(() => preparePinnedChsSource(test.root, test.source, join(test.root, 'outside'), {
      ...test.pin, sourcePatch: { ...test.pin.sourcePatch, path: '../source.patch' },
    })).toThrow('patch path');
  });
});

describe('five-package vendored metadata', () => {
  it('preserves published fields and external ranges while resolving only the five selected workspaces', () => {
    expect(CHS_VENDOR_PACKAGES).toEqual(['app-origin', 'auth', 'auth-d1', 'api-billing', 'corpus']);
    const input = { name: '@chester-hill-solutions/api-billing', version: '0.1.1', type: 'module',
      exports: { '.': { import: './dist/index.js' } }, files: ['dist'], publishConfig: { registry: 'https://npm.pkg.github.com' },
      scripts: { build: 'tsc' }, devDependencies: { typescript: '^5.9.2' },
      dependencies: { '@chester-hill-solutions/auth': 'workspace:^', postgres: '^3.4.7' },
      optionalDependencies: { '@chester-hill-solutions/app-origin': 'workspace:*' },
      peerDependencies: { 'better-auth': '1.7.10' },
    };
    const metadata = vendorPackageMetadata(input);
    expect(metadata).toEqual({ ...input, scripts: undefined, devDependencies: undefined,
      dependencies: { '@chester-hill-solutions/auth': 'workspace:*', postgres: '^3.4.7' } });
    expect(Object.hasOwn(metadata, 'scripts')).toBe(false);
    expect(Object.hasOwn(metadata, 'devDependencies')).toBe(false);
    expect(input.dependencies['@chester-hill-solutions/auth']).toBe('workspace:^');
  });

  it('rejects workspace dependencies outside the selected five packages', () => {
    expect(() => vendorPackageMetadata({ dependencies: { '@chester-hill-solutions/other': 'workspace:*' } })).toThrow('Unvendored workspace dependency');
  });
});
