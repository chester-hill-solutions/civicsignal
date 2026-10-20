/**
 * The minimal environment surface the commercial spine depends on.
 *
 * Extracted from `riding-and-address/src/types.ts`, narrowed to the bindings the
 * key, customer, usage and billing modules actually read. When the spine becomes
 * `@chester-hill-solutions/api-billing`, this file is replaced by the package's own
 * types and the product Env extends it.
 */
export interface Env {
  /** API keys + customer projection. When unbound, Customer key checks are skipped. */
  API_KEYS?: KVNamespace;
  /** Per-key daily + per-Customer monthly counters. */
  API_KEY_USAGE?: DurableObjectNamespace;
  /** Free-tier monthly billable units (default 1000). */
  FREE_MONTHLY_ALLOWANCE?: string;
  /** Stripe secret for Billing Meter events (optional until paid checkout). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_METER_EVENT_NAME?: string;
  /** Shared secret guarding administrative routes. */
  BASIC_AUTH?: string;
}
