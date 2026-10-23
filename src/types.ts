export interface Env {
  /** Legacy KV binding retained only for export and rollback. */
  API_KEYS?: KVNamespace;
  /** Preserve this namespace and customer:<workspace id> counter identity. */
  API_KEY_USAGE?: DurableObjectNamespace;
  FREE_MONTHLY_ALLOWANCE?: string;
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
  /** d1(default), verify, prefer-r2 or r2. Enable only after parity checks. */
  CORPUS_TEXT_MODE?: string;
  /** Response cache for corpus queries. */
  CIVIC_CACHE?: KVNamespace;
  /**
   * The key for the inference gateway that serves Jev.
   *
   * Without it the search uses the cosine order and the floor, and the product
   * behaves as it did before. See `src/jev.ts`.
   */
  JEV_KEY?: string;
  /** Corridators for ingest jobs. */
  INGEST_QUEUE?: Queue;
  /** Stripe secret for Billing Meter events. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe Billing Meter event name. */
  STRIPE_METER_EVENT_NAME?: string;
  /** The similarity index over the corpus. */
  VECTORIZE?: VectorizeBinding;
  /** Workers AI, for embedding a question in the corpus's own vector space. */
  AI?: AiBinding;
  /** The encoder service: EmbeddingGemma 2, served from the artefact. */
  ENCODER_URL?: string;
  /**
   * The encoder, called directly.
   *
   * A service binding rather than an address: a Worker cannot fetch a
   * `workers.dev` address on this account, and the encoder is the product's own
   * plumbing rather than something a customer calls.
   */
  ENCODER_SERVICE?: { fetch(request: Request): Promise<Response> };
  /** The shared secret the encoder checks. */
  ENCODER_TOKEN?: string;
}

/**
 * The slice of a Vectorize binding the product uses.
 *
 * The index holds no text — only vectors and metadata — so the row, its text
 * and its licence policy still live in the database and the licence gate
 * still applies to everything the product returns.
 */
export interface VectorizeBinding {
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: string | string[]; filter?: Record<string, string> },
  ): Promise<{
    matches: { id: string; score: number; metadata?: Record<string, string | number> }[];
  }>;
}

/** The slice of the Workers AI binding the product uses. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<Response>;
}
