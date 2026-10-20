#!/usr/bin/env bun
/**
 * Validate the Railway infrastructure as code, locally.
 *
 * `railway config plan` is the real check, but it needs a linked project and a
 * working Railway. This evaluates the authoring file and checks the graph, so a
 * broken reference is caught in a second rather than in a deploy.
 *
 * The check that earns its keep is the last one: **a service declared with a
 * Dockerfile path that does not exist.** An apply that created a service which
 * could not build would break the environment it was supposed to describe, and
 * the failure would surface as a failed deploy rather than as a mistake in the
 * file.
 *
 *   bun scripts/check-railway-iac.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRailwayContext } from 'railway/iac';

const ROOT = new URL('..', import.meta.url).pathname;
const failures: string[] = [];

const program = (await import(join(ROOT, '.railway/railway.ts'))).default as (
  ctx: unknown,
) => { name?: string; resources?: Record<string, unknown>[] };

// The program is a `RailwayProgram`: it takes the context the CLI passes and
// returns a project definition.
const ctx = createRailwayContext({ command: 'plan', projectName: 'civicsignal' });
const project = program(ctx);

if (!project || typeof project !== 'object' || !Array.isArray(project.resources)) {
  console.error('railway-iac: the authoring file did not return a project');
  process.exit(1);
}

// ── the resources ────────────────────────────────────────────────────────────

const addresses = new Set<string>();
for (const resource of project.resources) {
  const address = String(resource['address'] ?? '');
  if (!address) {
    failures.push('a resource has no address');
    continue;
  }
  if (addresses.has(address)) failures.push(`duplicate resource address: ${address}`);
  addresses.add(address);
}

// ── the references ───────────────────────────────────────────────────────────

/** Every output a resource declares, so a reference can be checked against it. */
const outputs = new Map<string, Set<string>>();
for (const resource of project.resources) {
  const address = String(resource['address'] ?? '');
  const declared = new Set<string>();
  const output = resource['output'];
  if (typeof output === 'string') declared.add(output);
  // A managed database publishes the standard variables as well.
  if (resource['type'] === 'database') {
    for (const name of ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
      declared.add(name);
    }
  }
  // A service publishes Railway's own variables.
  if (resource['type'] === 'service') {
    for (const name of ['RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_PRIVATE_DOMAIN', 'PORT']) {
      declared.add(name);
    }
  }
  outputs.set(address, declared);
}

for (const resource of project.resources) {
  const owner = String(resource['address'] ?? '');
  const variables = (resource['variables'] ?? {}) as Record<string, { type?: string; resource?: string; output?: string }>;
  for (const [name, value] of Object.entries(variables)) {
    if (value?.type !== 'reference') continue;
    const target = String(value.resource ?? '');
    if (!addresses.has(target)) {
      failures.push(`${owner} references ${target}, which is not declared`);
      continue;
    }
    const available = outputs.get(target);
    if (available && value.output && !available.has(value.output)) {
      failures.push(
        `${owner} references ${target}.${value.output}, which that resource does not publish ` +
          `(it publishes: ${[...(available ?? [])].join(', ')})`,
      );
    }
  }
}

// ── the builds ───────────────────────────────────────────────────────────────

for (const resource of project.resources) {
  if (resource['type'] !== 'service') continue;
  const name = String(resource['name'] ?? resource['address']);
  const source = resource['source'] as { repo?: string; rootDirectory?: string } | undefined;
  const build = resource['build'] as { builder?: string; dockerfilePath?: string } | undefined;

  if (!source?.repo) {
    failures.push(`the service "${name}" has no source repository`);
  } else if (!source.repo.endsWith('/civicsignal')) {
    failures.push(`the service "${name}" builds from ${source.repo}, not from this repository`);
  }

  if (build?.builder !== 'DOCKERFILE') continue;
  if (!build.dockerfilePath) {
    failures.push(`the service "${name}" builds a Dockerfile but does not say which one`);
    continue;
  }
  const path = join(ROOT, source?.rootDirectory ?? '', build.dockerfilePath);
  if (!existsSync(path)) {
    failures.push(
      `the service "${name}" builds ${source?.rootDirectory}/${build.dockerfilePath}, which does not exist`,
    );
  }
}

// ── the result ───────────────────────────────────────────────────────────────

if (failures.length) {
  console.error('railway-iac: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const services = project.resources.filter((r) => r['type'] === 'service').length;
const databases = project.resources.filter((r) => r['type'] === 'database').length;
console.log('railway-iac: ok');
console.log(`  project ${project.name}: ${services} service(s), ${databases} database(s)`);
for (const resource of project.resources) {
  if (resource['type'] === 'service') console.log(`    service  ${resource['name']}`);
  if (resource['type'] === 'database') console.log(`    database ${resource['name']}`);
}
