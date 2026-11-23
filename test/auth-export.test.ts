import { describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '@chester-hill-solutions/auth';
import { collectLegacyAuth } from '../src/auth-export';
import { authMigrationSql, prepareAuthMigration } from '../src/auth-migration';
import { authenticateRequest } from '../src/access';
import { testD1 } from './helpers/d1';

const rawKey = 'sk_valid_legacy_hash_only';
const hash = hashOpaqueToken(rawKey);
const key = { id: 'sk_old', customerId: 'kept_customer', kind: 'server', secretHash: hash };
function reader(entries: Record<string, Record<string, unknown>>) {
  return { async list(prefix: string) { return Object.keys(entries).filter((name) => name.startsWith(prefix)); },
    async get(name: string) { if (!entries[name]) throw new Error('missing'); return entries[name]; } };
}
const customer = { id: 'kept_customer', plan: 'free', fuseLimit: 1000 };
describe('complete legacy authorization export', () => {
  it('preserves an active authoritative key even when its display write failed', async () => {
    const data = await collectLegacyAuth(reader({ 'customer:kept_customer': customer, [`keyhash:${hash}`]: key }));
    expect(prepareAuthMigration(data).summary.serverKeys).toBe(1);
    const fixture = testD1();
    try {
      fixture.sqlite.exec(authMigrationSql(data));
      expect((await authenticateRequest({ CIVIC_DB: fixture.db }, new Request('https://example.test', {
        headers: { Authorization: `Bearer ${rawKey}` },
      }))).customer.id).toBe('kept_customer');
    } finally { fixture.close(); }
  });
  it('preserves either revocation flag and refuses inconsistent or display-only server identities', async () => {
    const data = await collectLegacyAuth(reader({ 'customer:kept_customer': customer,
      [`keyhash:${hash}`]: key, 'key:sk_old': { ...key, disabled: true } }));
    expect(prepareAuthMigration(data).summary.revokedKeys).toBe(1);
    await expect(collectLegacyAuth(reader({ 'key:sk_old': key }))).rejects.toThrow('no authoritative hash');
    await expect(collectLegacyAuth(reader({ [`keyhash:${hash}`]: key,
      'key:sk_old': { ...key, customerId: 'different' } }))).rejects.toThrow('identities disagree');
  });
});
