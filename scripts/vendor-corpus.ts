/**
 * Re-vendor a house package from the monorepo.
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
 *     bun scripts/vendor-corpus.ts                    # the corpus
 *     bun scripts/vendor-corpus.ts corpus api-billing  # both
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
const MONOREPO = resolve(ROOT, process.env.CHS_REPO ?? '../chs-corpus');

/** The packages to vendor. */
const PACKAGES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['corpus'];

function fail(message: string): never {
  console.error(`vendor-corpus: ${message}`);
  process.exit(1);
}

for (const name of PACKAGES) {
  await vendor(name);
}

async function vendor(name: string): Promise<void> {
  const source = join(MONOREPO, 'packages', name);
  const vendorDir = join(ROOT, 'vendor', '@chester-hill-solutions', name);

  if (!existsSync(source)) {
    fail(
      `the ${name} package is not at ${source}.\n` +
        `  Set CHS_REPO to the house monorepo, or put it beside this repository.`,
    );
  }
  if (!existsSync(join(source, 'package.json'))) {
    fail(`${source} has no package.json — that is not the ${name} package.`);
  }

  /* ── build the source ───────────────────────────────────────────────────── */

  console.log(`vendor-corpus: building ${name}`);
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: source, stdout: 'inherit', stderr: 'inherit' });
  if (build.exitCode !== 0) {
    fail(`the ${name} build failed — nothing was copied.`);
  }

  const sourceDist = join(source, 'dist');
  if (!existsSync(sourceDist)) {
    fail(`the ${name} build produced no dist/ at ${sourceDist}`);
  }

/* ── copy the build ───────────────────────────────────────────────────────── */

  // The dist is replaced rather than merged. A merge leaves the previous
  // build's files behind, and a file that used to exist and no longer does is
  // exactly the kind of thing that makes a vendored copy behave differently
  // from its source.
  console.log(`vendor-corpus: copying dist into ${vendorDir}`);
  rmSync(join(vendorDir, 'dist'), { recursive: true, force: true });
  cpSync(sourceDist, join(vendorDir, 'dist'), { recursive: true });

/* ── merge the manifest ───────────────────────────────────────────────────── */

  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const vendored = JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8'));

/**
 * The shape comes from the source; the identity stays.
 *
 * The description, licence and repository say which project this is and who
 * publishes it, and they are the vendored copy's own business. Everything that
 * describes how the package is *built and imported* belongs to the source.
 */
  const merged = {
    name: manifest.name,
    version: manifest.version,
    description: vendored.description ?? manifest.description,
    type: manifest.type,
    license: vendored.license ?? manifest.license,
    repository: vendored.repository ?? manifest.repository,
    publishConfig: manifest.publishConfig ?? vendored.publishConfig,
    files: manifest.files ?? vendored.files,
    main: manifest.main ?? vendored.main,
    types: manifest.types ?? vendored.types,
    exports: manifest.exports ?? vendored.exports,
    scripts: manifest.scripts ?? vendored.scripts,
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
  };

// `undefined` is not JSON. Drop the keys the source does not have, rather than
// writing them as null and letting a reader wonder what null means here.
for (const key of Object.keys(merged)) {
  if (merged[key] === undefined) delete merged[key];
}

  writeFileSync(join(vendorDir, 'package.json'), JSON.stringify(merged, null, 2) + '\n');
  console.log(`vendor-corpus: wrote ${join(vendorDir, 'package.json')}`);
  console.log(`vendor-corpus: done — ${manifest.name}@${manifest.version}`);
}
