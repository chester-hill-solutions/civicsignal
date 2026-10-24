import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'vendor/chs-manifest.json'), 'utf8')) as {
  source: string; revision: string;
  packages: Record<string, { version: string; files: Record<string, string> }>;
  sourcePatch?: { path: string; sha256: string };
};
if (!/^[a-f0-9]{40}$/.test(manifest.revision)) throw new Error('The CHS source revision is missing.');
if (manifest.sourcePatch) {
  const patch = resolve(root, manifest.sourcePatch.path);
  if (relative(root, patch).startsWith('..') || createHash('sha256').update(readFileSync(patch)).digest('hex') !== manifest.sourcePatch.sha256) {
    throw new Error('The upstream source patch differs from its recorded fingerprint.');
  }
}
let checked = 0;
for (const [name, entry] of Object.entries(manifest.packages)) {
  const dir = resolve(root, 'vendor/@chester-hill-solutions', name);
  for (const [file, expected] of Object.entries(entry.files)) {
    const target = resolve(dir, file);
    if (relative(dir, target).startsWith('..')) throw new Error('Invalid vendor path.');
    if (!existsSync(target)) throw new Error(`Missing vendored file: ${name}/${file}`);
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== expected) throw new Error(`Vendored file differs from the CHS manifest: ${name}/${file}`);
    checked++;
  }
  const packageJson = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
    version: string; exports: Record<string, { types?: string; import?: string; default?: string }>;
    dependencies?: Record<string, string>;
  };
  if (packageJson.version !== entry.version) throw new Error(`Vendor version differs: ${name}`);
  for (const value of Object.values(packageJson.exports)) {
    for (const path of Object.values(value)) {
      if (path && !existsSync(resolve(dir, path))) throw new Error(`Missing package export: ${name}/${path}`);
    }
  }
  for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
    if (version.startsWith('workspace:') && !manifest.packages[dependency.replace('@chester-hill-solutions/', '')]) {
      throw new Error(`Unresolved workspace dependency: ${dependency}`);
    }
  }
  for (const file of readdirSync(dir)) {
    if (file === 'src') throw new Error('Vendored runtime must use the pinned build output.');
  }
}
console.log(`chs-vendor: ${checked} files verified at ${manifest.revision}`);
