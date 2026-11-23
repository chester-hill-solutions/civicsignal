import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { createApiKey, revokeApiKey } from '@chester-hill-solutions/auth-d1';
import { workspaces } from '@chester-hill-solutions/auth-d1/schema';
import { authenticateRequest, RETRIEVE_CAPABILITY, workspaceBilling } from '../src/access';
import { InMemoryUsageLedger } from '@chester-hill-solutions/api-billing';
import { runBillableRetrieval } from '../src/metering';
import { testD1 } from './helpers/d1';

const closing: (() => void)[] = [];
afterEach(() => { for (const close of closing.splice(0)) close(); });

async function account(capabilities = [RETRIEVE_CAPABILITY]) {
  const fixture = testD1();
  closing.push(fixture.close);
  const db = drizzle(fixture.db);
  await db.insert(workspaces).values({ id: 'existing_customer_17' });
  await db.insert(workspaceBilling).values({ workspaceId: 'existing_customer_17', plan: 'free',
    fuseLimit: 2, fuseSoftWarn: false, enabled: true });
  const key = await createApiKey(db, { workspaceId: 'existing_customer_17', name: 'Test',
    capabilities, keyPrefix: 'sk_live' });
  const env = { CIVIC_DB: fixture.db };
  const request = () => new Request('https://example.test/api/statutes', {
    headers: { Authorization: `Bearer ${key.rawKey}` },
  });
  return { ...fixture, db, env, key, request };
}

describe('CHS identity integration', () => {
  it('resolves a shared key and keeps the existing customer counter identity', async () => {
    const fixture = await account();
    const identity = await authenticateRequest(fixture.env, fixture.request());
    expect(identity.actor.workspaceId).toBe('existing_customer_17');
    expect(identity.customer.id).toBe('existing_customer_17');
    expect(identity.customer.fuseLimit).toBe(2);
    expect(identity.actor.capabilities.has(RETRIEVE_CAPABILITY)).toBe(true);
  });
  it('requires credentials and capabilities and honors revocation', async () => {
    const fixture = await account([]);
    await expect(authenticateRequest(fixture.env, new Request('https://example.test')))
      .rejects.toMatchObject({ status: 401, code: 'KEY_REQUIRED' });
    await expect(authenticateRequest(fixture.env, fixture.request()))
      .rejects.toMatchObject({ status: 403, code: 'CAPABILITY_REQUIRED' });
    await revokeApiKey(fixture.db, fixture.key.apiKey.id, 'existing_customer_17');
    await expect(authenticateRequest(fixture.env, fixture.request()))
      .rejects.toMatchObject({ status: 401, code: 'KEY_INVALID' });
  });
  it('meters only completed work and blocks an exhausted fuse before work', async () => {
    const fixture = await account();
    const identity = await authenticateRequest(fixture.env, fixture.request());
    const ledger = new InMemoryUsageLedger();
    let calls = 0;
    await expect(runBillableRetrieval(fixture.env, identity, async () => {
      throw new Error('Upstream failed');
    }, { ledger })).rejects.toThrow('Upstream failed');
    expect((await ledger.peekMonthly(identity.customer.id, 2)).count).toBe(0);
    const work = async () => { calls++; return 'retrieved'; };
    expect(await runBillableRetrieval(fixture.env, identity, work, { ledger })).toBe('retrieved');
    expect(await runBillableRetrieval(fixture.env, identity, work, { ledger })).toBe('retrieved');
    await expect(runBillableRetrieval(fixture.env, identity, work, { ledger }))
      .rejects.toMatchObject({ outcome: { status: 429 } });
    expect(calls).toBe(2);
    expect((await ledger.peekMonthly(identity.customer.id, 2)).count).toBe(2);
  });
});
