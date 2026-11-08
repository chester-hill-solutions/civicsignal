import { describe, expect, it, vi } from 'vitest';
import { recordSuccessfulBillable, reportStripeMeter, type BillableAuthContext } from '../src/spine/billing';
import { InMemoryUsageLedger } from '../src/spine/usage-ledger';
import type { Env } from '../src/spine/env';

const context = {
  customer: { id: 'customer-a', plan: 'metered', fuseLimit: 0, stripeCustomerId: 'cus_fixture' },
} as BillableAuthContext;

describe('best-effort billing report host policy', () => {
  it('skips unconfigured Stripe before validating its event configuration', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture must not call a provider'));
    try {
      await expect(reportStripeMeter({ STRIPE_METER_EVENT_NAME: '   ' } as Env, context, 1)).resolves.toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it('does not fail successful product work after counting when meter configuration is invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture must not call a provider'));
    try {
      const ledger = new InMemoryUsageLedger();
      const nowMs = Date.UTC(2026, 10, 8);
      const env = { STRIPE_SECRET_KEY: 'fixture-only', STRIPE_METER_EVENT_NAME: '   ' } as Env;
      await expect(recordSuccessfulBillable(env, context, { ledger, nowMs })).resolves.toEqual({ allowed: true, status: 200 });
      expect((await ledger.peekMonthly('customer-a', 0, nowMs)).count).toBe(1);
      expect(warn).toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); fetcher.mockRestore(); }
  });
});
