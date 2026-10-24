import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapStagingConfig, prepareStagingConfigs, STAGING_ACCOUNT } from '../scripts/lib/staging-config';

const suffix = '20261022';
const inventory = { format: 1, accountId: STAGING_ACCOUNT, suffix, observedAt: '2026-10-23T01:00:00Z',
  d1: { name: `civicsignal-v1-stage-d1-${suffix}`, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  r2: { name: `civicsignal-v1-stage-corpus-${suffix}` }, cache: { title: `civicsignal-v1-stage-cache-${suffix}`, id: 'a'.repeat(32) },
  vectorize: { name: `civicsignal-v1-stage-statutes-${suffix}`, dimensions: 768, metric: 'cosine' } };
describe('standalone staging configuration', () => {
  it('prepares a resource bootstrap without any production bindings or guessed IDs', () => {
    const value = bootstrapStagingConfig(resolve('.'), suffix);
    expect(value.account_id).toBe(STAGING_ACCOUNT);
    expect(value).not.toHaveProperty('d1_databases'); expect(value).not.toHaveProperty('services');
  });
  it('isolates every binding, disables crons and pins bounded stage work', () => {
    const configs = prepareStagingConfigs(resolve('.'), inventory);
    expect(configs.pipeline?.vars).toMatchObject({ PIPELINE_EMBEDDING_ATTEMPT_CAP: '1112', CORPUS_RETAIN_D1_TEXT: 'false' });
    expect(configs.snapshot?.vars).toHaveProperty('SNAPSHOT_PINNED_COMMIT');
    expect(configs.pipeline?.triggers).toEqual({ crons: [] }); expect(configs.snapshot?.triggers).toEqual({ crons: [] });
    expect(configs.api?.vars).not.toHaveProperty('PUBLIC_API_BASE_URL');
    expect(JSON.stringify(configs)).not.toContain('8056b1a0-f858-4f89-a332-91f7f350eb7b');
    expect(JSON.stringify(configs)).not.toContain('civicsignal-statutes-gemma');
    expect(configs.restore?.vars).toMatchObject({ RESTORE_D1_ID: inventory.d1.id, RESTORE_ENABLED: 'staging-only' });
    for (const value of Object.values(configs)) expect(value.routes ?? []).toEqual([]);
  });
  it.each([
    { ...inventory, d1: { ...inventory.d1, id: '8056b1a0-f858-4f89-a332-91f7f350eb7b' } },
    { ...inventory, r2: { name: 'civicsignal-corpus' } },
    { ...inventory, vectorize: { ...inventory.vectorize, name: 'civicsignal-statutes-gemma' } },
    { ...inventory, cache: { ...inventory.cache, id: '45d4754592494e87aa7e2a62e42abbaa' } },
  ])('refuses a production or mismatched resource before configuration output', (value) => {
    expect(() => prepareStagingConfigs(resolve('.'), value)).toThrow(/production|isolated/);
  });
});
