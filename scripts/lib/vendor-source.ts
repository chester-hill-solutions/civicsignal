import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface PinnedChsSource {
  revision: string;
  sourceTree?: string;
  baseRevision?: string;
  sourcePatch?: { path: string; sha256: string };
}

const commit = (value: string, name: string): string => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`${name} must be a full pinned Git SHA.`);
  return value;
};
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, encoding: 'utf8', stdio: 'pipe',
}).trim();

/** Materialize only pinned Git objects; never check out or patch the source worktree. */
export function preparePinnedChsSource(root: string, sourceRepo: string, checkout: string, pin: PinnedChsSource): Required<Pick<PinnedChsSource, 'revision' | 'sourceTree'>> & PinnedChsSource {
  const revision = commit(pin.revision, 'CHS revision');
  if (pin.baseRevision !== undefined) commit(pin.baseRevision, 'CHS base revision');
  if (pin.sourceTree !== undefined) commit(pin.sourceTree, 'CHS source tree');
  let patch: string | undefined;
  if (pin.sourcePatch) {
    patch = resolve(root, pin.sourcePatch.path);
    const path = relative(resolve(root), patch);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || !/^[a-f0-9]{64}$/.test(pin.sourcePatch.sha256)) {
      throw new Error('Invalid CHS source patch path or fingerprint.');
    }
    const fingerprint = createHash('sha256').update(readFileSync(patch)).digest('hex');
    if (fingerprint !== pin.sourcePatch.sha256) throw new Error('The CHS source patch differs from its recorded fingerprint.');
    const header = readFileSync(patch, 'utf8').split('\n', 1)[0];
    if (!header?.startsWith(`From ${revision} `)) throw new Error('The CHS source patch names a different source revision.');
  }
  const source = resolve(sourceRepo);
  const hasRevision = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: source, stdio: 'pipe' }).status === 0;
  if (!hasRevision && (!patch || !pin.baseRevision || !pin.sourceTree)) {
    throw new Error('The pinned CHS revision is absent. A baseRevision, sourceTree and hash-verified sourcePatch are required.');
  }
  const availableRevision = hasRevision ? revision : pin.baseRevision!;
  git(source, ['cat-file', '-e', `${availableRevision}^{commit}`]);
  const expectedTree = hasRevision ? git(source, ['rev-parse', `${revision}^{tree}`]) : pin.sourceTree!;
  if (pin.sourceTree && pin.sourceTree !== expectedTree) throw new Error('The CHS source tree differs from its pinned revision.');
  if (existsSync(checkout)) throw new Error('The isolated CHS checkout must be a new directory.');
  mkdirSync(checkout, { recursive: true });
  git(checkout, ['init', '--quiet']);
  // Local, shallow fetch copies Git objects and preserves gitlinks/file modes.
  // It does not run hooks or mutate the original repository's refs or files.
  git(checkout, ['fetch', '--quiet', '--no-tags', '--depth=1', source, availableRevision]);
  git(checkout, ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (!hasRevision) {
    git(checkout, ['apply', '--check', '--index', patch!]);
    git(checkout, ['apply', '--index', patch!]);
  }
  const actualTree = git(checkout, ['write-tree']);
  if (actualTree !== expectedTree) throw new Error('The reconstructed CHS source tree differs from the pinned tree.');
  return { revision, sourceTree: expectedTree,
    ...(pin.baseRevision === undefined ? {} : { baseRevision: pin.baseRevision }),
    ...(pin.sourcePatch === undefined ? {} : { sourcePatch: { ...pin.sourcePatch } }),
  };
}

export const CHS_VENDOR_PACKAGES = ['app-origin', 'auth', 'auth-d1', 'api-billing', 'corpus'] as const;

/** Preserve published metadata while resolving the same five local workspaces. */
export function vendorPackageMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const metadata = structuredClone(input);
  delete metadata['scripts'];
  delete metadata['devDependencies'];
  for (const group of ['dependencies', 'optionalDependencies']) {
    const dependencies = metadata[group];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error(`Invalid package ${group}.`);
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        const sibling = dependency.replace('@chester-hill-solutions/', '');
        if (!CHS_VENDOR_PACKAGES.some((name) => name === sibling)) throw new Error(`Unvendored workspace dependency ${dependency}`);
        Reflect.set(dependencies, dependency, 'workspace:*');
      }
    }
  }
  return metadata;
}
