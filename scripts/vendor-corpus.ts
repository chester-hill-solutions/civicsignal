/**
 * Re-vendor the corpus package from the house monorepo.
 *
 * CivicSignal depends on `@chester-hill-solutions/corpus` as a **vendored copy**
 * rather than a workspace link, because the package is published to GitHub
 * Packages and CivicSignal has to build and ship without the monorepo beside
 * it. The vendored `dist` is committed, so a clean checkout builds and runs.
 *
 * The cost of that choice is that the copy drifts. The source changes, the
 * vendored `dist` does not, and the type error that says so is in *this*
 * repository, about a package whose source is in another one — which is a
 * confusing way to find out that you need to run this script.
 *
 * So: one script, run from the root, which builds the source and copies what
 * is needed. It copies the built `dist` and merges the manifest, so the
 * vendored package keeps its identity — its description, licence and
 * repository — while taking its shape — its exports, scripts and entry points
 * — from the source.
 *
 *     bun scripts/vendor-corpus.ts
 *
 * The source is found relative to this repository by default, so nothing here
 * is tied to one machine's directory layout.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Where the house monorepo lives.
 *
 * Relative to this repository, so it works for anyone who has both side by
 * side, and overridable for anyone who does not.
 */
const SOURCE = resolve(
  ROOT,
  process.env.CHS_REPO ?? '../chs-corpus',
  'packages/corpus',
);

/** Where the vendored copy lives. */
const VENDOR = join(ROOT, 'vendor', '@chester-hill-solutions', 'corpus');

function fail(message: string): never {
  console.error(`vendor-corpus: ${message}`);
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  fail(
    `the corpus package is not at ${SOURCE}.\n` +
      `  Set CHS_REPO to the house monorepo, or put it beside this repository.`,
  );
}

if (!existsSync(join(SOURCE, 'package.json'))) {
  fail(`${SOURCE} has no package.json — that is not the corpus package.`);
}

/* ── build the source ─────────────────────────────────────────────────────── */

console.log(`vendor-corpus: building ${SOURCE}`);
const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: SOURCE, stdout: 'inherit', stderr: 'inherit' });
if (build.exitCode !== 0) {
  fail('the source build failed — nothing was copied.');
}

const sourceDist = join(SOURCE, 'dist');
if (!existsSync(sourceDist)) {
  fail(`the source build produced no dist/ at ${sourceDist}`);
}

/* ── copy the build ───────────────────────────────────────────────────────── */

// The dist is replaced rather than merged. A merge leaves the previous build's
// files behind, and a file that used to exist and no longer does is exactly
// the kind of thing that makes a vendored copy behave differently from its
// source.
console.log(`vendor-corpus: copying dist into ${VENDOR}`);
rmSync(join(VENDOR, 'dist'), { recursive: true, force: true });
cpSync(sourceDist, join(VENDOR, 'dist'), { recursive: true });

/* ── merge the manifest ───────────────────────────────────────────────────── */

const source = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8'));
const vendored = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'));

/**
 * The shape comes from the source; the identity stays.
 *
 * The description, licence and repository say which project this is and who
 * publishes it, and they are the vendored copy's own business. Everything that
 * describes how the package is *built and imported* belongs to the source.
 */
const merged = {
  name: source.name,
  version: source.version,
  description: vendored.description ?? source.description,
  type: source.type,
  license: vendored.license ?? source.license,
  repository: vendored.repository ?? source.repository,
  publishConfig: source.publishConfig ?? vendored.publishConfig,
  files: source.files ?? vendored.files,
  main: source.main ?? vendored.main,
  types: source.types ?? vendored.types,
  exports: source.exports ?? vendored.exports,
  scripts: source.scripts ?? vendored.scripts,
  dependencies: source.dependencies,
  devDependencies: source.devDependencies,
};

// `undefined` is not JSON. Drop the keys the source does not have, rather than
// writing them as null and letting a reader wonder what null means here.
for (const key of Object.keys(merged)) {
  if (merged[key] === undefined) delete merged[key];
}

writeFileSync(join(VENDOR, 'package.json'), JSON.stringify(merged, null, 2) + '\n');
console.log(`vendor-corpus: wrote ${join(VENDOR, 'package.json')}`);

/* ── say what changed ─────────────────────────────────────────────────────── */

const version = source.version;
console.log(`vendor-corpus: done — ${source.name}@${version}`);
