import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

export const STAGING_ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a';
export const STAGING_SOURCE = { commit: '0507465393c224c0491fc8c17c88340217acc656', date: '2026-10-15' };
const schema = z.object({
  format: z.literal(1), accountId: z.literal(STAGING_ACCOUNT), suffix: z.string().regex(/^\d{8}$/),
  observedAt: z.string().datetime(),
  d1: z.object({ name: z.string(), id: z.string().uuid() }).strict(),
  r2: z.object({ name: z.string() }).strict(),
  cache: z.object({ title: z.string(), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  vectorize: z.object({ name: z.string(), dimensions: z.literal(768), metric: z.enum(['cosine', 'euclidean', 'dot-product']) }).strict(),
}).strict();

export function stagingNames(suffix: string) {
  if (!/^\d{8}$/.test(suffix)) throw new Error('Use an explicit eight-digit staging suffix.');
  const prefix = 'civicsignal-v1-stage-';
  return { bootstrap: `${prefix}bootstrap-${suffix}`, corpus: `${prefix}corpus-${suffix}`,
    d1: `${prefix}d1-${suffix}`, cache: `${prefix}cache-${suffix}`, vectorize: `${prefix}statutes-${suffix}`,
    api: `${prefix}api-${suffix}`, pipeline: `${prefix}pipeline-${suffix}`, encoder: `${prefix}encoder-${suffix}`,
    snapshot: `${prefix}snapshot-${suffix}`, restore: `${prefix}restore-${suffix}` };
}

function readConfig(root: string, path: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(resolve(root, path), 'utf8'));
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object') throw new Error('Cannot parse the source Worker config.');
  return parsed.config as Record<string, unknown>;
}

export function bootstrapStagingConfig(root: string, suffix: string): Record<string, unknown> {
  return { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: stagingNames(suffix).bootstrap,
    account_id: STAGING_ACCOUNT, compatibility_date: '2026-10-22' };
}

/** Offline preparation only. Read back every returned resource descriptor before deployment. */
export function prepareStagingConfigs(root: string, input: unknown): Record<string, Record<string, unknown>> {
  const inventory = schema.parse(input);
  const names = stagingNames(inventory.suffix);
  if (inventory.d1.name !== names.d1 || inventory.r2.name !== names.corpus || inventory.cache.title !== names.cache || inventory.vectorize.name !== names.vectorize ||
      inventory.d1.id === '8056b1a0-f858-4f89-a332-91f7f350eb7b' ||
      ['45d4754592494e87aa7e2a62e42abbaa', '2d0152b0958c48fab4a98b3046e0c08e'].includes(inventory.cache.id)) {
    throw new Error('Staging inventory names/IDs must match isolated resources; production bindings are forbidden.');
  }
  const common = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'),
    account_id: inventory.accountId, compatibility_date: '2026-10-22', compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true }, workers_dev: true };
  const d1 = { binding: 'CIVIC_DB', database_name: names.d1, database_id: inventory.d1.id,
    migrations_dir: resolve(root, 'migrations') };
  const api = { ...readConfig(root, 'wrangler.jsonc'), ...common, name: names.api, main: resolve(root, 'src/index.ts'),
    vars: { PRODUCT_NAME: 'CivicSignal v1 staging', FREE_MONTHLY_ALLOWANCE: '1000', CORPUS_TEXT_MODE: 'r2' },
    routes: [], kv_namespaces: [{ binding: 'CIVIC_CACHE', id: inventory.cache.id }],
    d1_databases: [d1], r2_buckets: [{ binding: 'CORPORA', bucket_name: names.corpus }],
    vectorize: [{ binding: 'VECTORIZE', index_name: names.vectorize }], services: [{ binding: 'ENCODER_SERVICE', service: names.encoder }] };
  delete (api as Record<string, unknown>)['ai'];
  const pipeline = { ...readConfig(root, 'services/pipeline/wrangler.jsonc'), ...common,
    name: names.pipeline, main: resolve(root, 'services/pipeline/worker.ts'), routes: [], triggers: { crons: [] },
    vars: { CORPUS_RETAIN_D1_TEXT: 'false', PIPELINE_PINNED_COMMIT: STAGING_SOURCE.commit,
      PIPELINE_PINNED_DATE: STAGING_SOURCE.date, PIPELINE_EMBEDDING_ATTEMPT_CAP: '1112' },
    d1_databases: [d1], r2_buckets: [{ binding: 'CORPUS', bucket_name: names.corpus }],
    vectorize: [{ binding: 'VECTORIZE', index_name: names.vectorize }], services: [{ binding: 'ENCODER_SERVICE', service: names.encoder }] };
  const snapshot = { ...readConfig(root, 'services/snapshot/wrangler.jsonc'), ...common,
    name: names.snapshot, main: resolve(root, 'services/snapshot/worker.ts'), routes: [], triggers: { crons: [] },
    vars: { SNAPSHOT_PINNED_COMMIT: STAGING_SOURCE.commit, SNAPSHOT_PINNED_DATE: STAGING_SOURCE.date },
    r2_buckets: [{ binding: 'CORPUS', bucket_name: names.corpus }],
    workflows: [{ binding: 'SNAPSHOT', name: names.snapshot, class_name: 'CorpusSnapshot' }] };
  const sourceEncoder = readConfig(root, 'services/encoder/wrangler.jsonc');
  const containers = sourceEncoder['containers'];
  if (!Array.isArray(containers) || containers.length !== 1 || typeof containers[0] !== 'object') throw new Error('Expected one pinned encoder container.');
  const encoder = { ...sourceEncoder, ...common, name: names.encoder, main: resolve(root, 'services/encoder/worker.ts'), routes: [],
    containers: [{ ...containers[0], name: names.encoder, image: resolve(root, 'services/encoder/Dockerfile'), image_build_context: resolve(root), max_instances: 1 }],
    exports: { Encoder: { type: 'durable-object', storage: 'sqlite', container: names.encoder } } };
  const restore = { ...common, name: names.restore, main: resolve(root, 'services/restore/worker.ts'), routes: [],
    vars: { RESTORE_ENABLED: 'staging-only', RESTORE_STAGE_ID: `stage-${inventory.suffix}`, RESTORE_ACCOUNT_ID: inventory.accountId,
      RESTORE_D1_ID: inventory.d1.id, RESTORE_R2_NAME: names.corpus },
    d1_databases: [{ ...d1, binding: 'RESTORE_DB' }], r2_buckets: [{ binding: 'RESTORE_TEXTS', bucket_name: names.corpus }] };
  return { resources: bootstrapStagingConfig(root, inventory.suffix), api, pipeline, snapshot, encoder, restore };
}
