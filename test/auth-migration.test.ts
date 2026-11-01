import { describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '@chester-hill-solutions/auth';
import { authenticateRequest } from '../src/access';
import { authMigrationSql, prepareAuthMigration } from '../src/auth-migration';
import { testD1 } from './helpers/d1';

const secret = 'sk_legacy_existing_customer_key';
const backup = {
  customers: [{ id: 'cust_existing', plan: 'metered', fuseLimit: 1200, fuseSoftWarn: true,
    stripeCustomerId: 'cus_stripe', label: "A customer's workspace" }],
  keys: [{ id: 'sk_display', kind: 'server', customerId: 'cust_existing', secretHash: hashOpaqueToken(secret) },
    { id: 'pk_public', kind: 'browser', customerId: 'cust_existing' }],
};

describe('legacy identity migration', () => {
  it('preserves an existing raw secret, billing plan and counter identity without raw-key recovery', async () => {
    const fixture = testD1();
    try {
      const sql = authMigrationSql(backup);
      expect(sql).not.toContain(secret);
      fixture.sqlite.exec(sql);
      fixture.sqlite.exec(sql);
      const identity = await authenticateRequest({ CIVIC_DB: fixture.db }, new Request('https://example.test', {
        headers: { Authorization: `Bearer ${secret}` },
      }));
      expect(identity.actor.keyId).toBe('sk_display');
      expect(identity.customer).toEqual({ id: 'cust_existing', plan: 'metered', fuseLimit: 1200,
        fuseSoftWarn: true, stripeCustomerId: 'cus_stripe' });
      expect(prepareAuthMigration(backup).summary).toMatchObject({ customers: 1, serverKeys: 1, skippedBrowserKeys: 1 });
    } finally { fixture.close(); }
  });
  it('does not reactivate a revoked key when a stale export runs again', async () => {
    const fixture = testD1();
    try {
      fixture.sqlite.exec(authMigrationSql(backup));
      fixture.sqlite.exec("UPDATE workspace_api_key SET status='revoked'");
      fixture.sqlite.exec(authMigrationSql(backup));
      await expect(authenticateRequest({ CIVIC_DB: fixture.db }, new Request('https://example.test', {
        headers: { Authorization: `Bearer ${secret}` },
      }))).rejects.toMatchObject({ code: 'KEY_INVALID' });
    } finally { fixture.close(); }
  });
  it('refuses incomplete or colliding input before it produces statements', () => {
    expect(() => prepareAuthMigration({ ...backup, customers: [] })).toThrow('has no customer');
    expect(() => prepareAuthMigration({ ...backup, keys: [backup.keys[0], backup.keys[0]] })).toThrow('Duplicate server key');
    expect(() => prepareAuthMigration({ ...backup, keys: [{ ...backup.keys[0], secretHash: 'invalid' }] })).toThrow();
  });
  it('refuses a hash already attached to a different workspace without changing its identity', () => {
    const fixture = testD1();
    try {
      fixture.sqlite.exec(authMigrationSql(backup));
      const conflicting = { customers: [{ ...backup.customers[0], id: 'different_customer' }],
        keys: [{ ...backup.keys[0], customerId: 'different_customer' }] };
      expect(() => fixture.sqlite.exec(authMigrationSql(conflicting))).toThrow();
      expect(fixture.sqlite.prepare('SELECT workspace_id FROM workspace_api_key').get()?.workspace_id).toBe('cust_existing');
    } finally { fixture.close(); }
  });
});
