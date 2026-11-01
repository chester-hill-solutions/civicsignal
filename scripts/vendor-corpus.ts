#!/usr/bin/env bun
/** Rebuild pinned CHS packages in an isolated checkout; preserve source worktrees. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CHS_VENDOR_PACKAGES, preparePinnedChsSource, vendorPackageMetadata, type PinnedChsSource } from './lib/vendor-source';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--verify-source')) throw new Error('Usage: bun scripts/vendor-corpus.ts [--verify-source]');
const verifySourceOnly = args[0] === '--verify-source';
const root = resolve(import.meta.dir, '..');
const packages = CHS_VENDOR_PACKAGES;
const source = process.env.CHS_REPO;
if (!source) throw new Error('Set CHS_REPO to a local CHS repository. This command builds an isolated pinned checkout.');
const previous = JSON.parse(readFileSync(join(root, 'vendor/chs-manifest.json'), 'utf8'));
const revision = process.env.CHS_REVISION ?? previous.revision;
const temporary = mkdtempSync(join(tmpdir(), 'civicsignal-chs-build-'));
const checkout = join(temporary, 'source');
try {
  const pin: PinnedChsSource = revision === previous.revision
    ? { revision, sourceTree: previous.sourceTree, baseRevision: previous.baseRevision, sourcePatch: previous.sourcePatch }
    : { revision };
  const provenance = preparePinnedChsSource(root, source, checkout, pin);
  if (verifySourceOnly) {
    console.log(JSON.stringify({ verified: true, ...provenance, vendorChanged: false }));
  } else {
    execFileSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts',
      ...packages.flatMap((name) => ['--filter', `@chester-hill-solutions/${name}`])], { cwd: checkout, stdio: 'inherit' });
    const staged = join(temporary, 'vendor');
    mkdirSync(staged);
    const manifest: { source: string; packages: Record<string, { version: string; files: Record<string, string> }> } & PinnedChsSource = {
      source: previous.source, ...provenance, packages: {},
    };
    const files = (dir: string, prefix = ''): string[] => readdirSync(join(dir, prefix), { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? files(dir, join(prefix, entry.name)) : [join(prefix, entry.name)]).sort();
    for (const name of packages) {
      const pkg = join(checkout, 'packages', name);
      execFileSync('bun', ['run', 'build'], { cwd: pkg, stdio: 'inherit' });
      if (!existsSync(join(pkg, 'dist'))) throw new Error(`${name} did not build dist`);
      const target = join(staged, name);
      mkdirSync(target);
      cpSync(join(pkg, 'dist'), join(target, 'dist'), { recursive: true });
      const metadata = vendorPackageMetadata(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')));
      if (typeof metadata['version'] !== 'string') throw new Error(`${name} has no package version.`);
      writeFileSync(join(target, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
      manifest.packages[name] = { version: metadata['version'], files: Object.fromEntries(files(target).map((file) => [
        file, createHash('sha256').update(readFileSync(join(target, file))).digest('hex'),
      ])) };
    }
    // No vendored file changes until every build and manifest is complete.
    for (const name of packages) {
      const destination = join(root, 'vendor/@chester-hill-solutions', name);
      rmSync(destination, { recursive: true, force: true });
      cpSync(join(staged, name), destination, { recursive: true });
    }
    writeFileSync(join(root, 'vendor/chs-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Vendored ${packages.length} packages at ${revision}. Run bun install and bun run validate.`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
