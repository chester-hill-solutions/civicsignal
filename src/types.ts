import type { Env as SpineEnv } from './spine/env';

export interface Env extends SpineEnv {
  /** Public origin used in discovery documents and MCP instructions. */
  PUBLIC_API_BASE_URL?: string;
  /** Comma-separated public hostnames allowed to serve discovery routes. */
  PUBLIC_API_HOSTS?: string;
  /** Product display name. */
  PRODUCT_NAME?: string;
  /** Comma-separated origins allowed for credentialed CORS. */
  ALLOWED_ORIGINS?: string;
  /** Per-IP rate limit for the unbilled demo tier (default 30/min). */
  DEMO_RATE_LIMIT?: string;
  /** Published pk_* key shared by every visitor of the public demo surface. */
  DEMO_BROWSER_API_KEY?: string;
  /** Corpus store. */
  CIVIC_DB?: D1Database;
  /** Static corpus snapshots and rendered briefs. */
  CORPORA?: R2Bucket;
  /** Response cache for corpus queries. */
  CIVIC_CACHE?: KVNamespace;
  /** Corridators for ingest jobs. */
  INGEST_QUEUE?: Queue;
  /** Stripe secret for Billing Meter events. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe Billing Meter event name. */
  STRIPE_METER_EVENT_NAME?: string;
}
