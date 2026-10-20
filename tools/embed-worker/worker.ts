/**
 * A local embedding endpoint.
 *
 * `wrangler dev` proxies the Workers AI binding using the operator's Cloudflare
 * session, so this is a way to run embeddings without a separate API token. It exists
 * for the corpus embedding job and the retrieval evaluation, not for production.
 *
 * POST /embed  { "texts": string[], "model"?: string }  ->  { "vectors": number[][] }
 */
export interface Env {
  AI: { run: (model: string, input: unknown) => Promise<unknown> };
}

const DEFAULT_MODEL = '@cf/baai/bge-m3';
const RERANKER = '@cf/baai/bge-reranker-base';
const MAX_BATCH = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/rerank') {
      return this.rerank(request, env);
    }
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const body = (await request.json()) as { texts?: string[]; model?: string };
    const texts = Array.isArray(body.texts) ? body.texts : [];
    if (texts.length === 0) return new Response('no texts', { status: 400 });
    if (texts.length > MAX_BATCH) return new Response(`max ${MAX_BATCH}`, { status: 413 });

    const model = body.model ?? DEFAULT_MODEL;
    const result = (await env.AI.run(model, { text: texts, pooling: 'cls' })) as {
      data?: number[][];
    };
    return Response.json({ vectors: result.data ?? [] });
  },

  /**
   * Rerank candidates against a query.
   *
   * A cross-encoder over the keyword arm's top candidates is usually a larger
   * recall-to-precision gain than adding semantic recall at all, and it is the
   * cheaper experiment: no corpus embedding, no vector index, one request per
   * question. The evaluation compares it head to head with the vector arm.
   */
  async rerank(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const body = (await request.json()) as {
      query?: string;
      contexts?: ({ text: string } | string)[];
      documents?: ({ text: string } | string)[];
    };
    const query = typeof body.query === 'string' ? body.query : '';
    // Accept either shape and normalise to plain strings; the model wants
    // contexts as objects, and the caller's index into the array has to survive.
    const raw = Array.isArray(body.contexts) ? body.contexts : Array.isArray(body.documents) ? body.documents : [];
    const documents = raw.map((entry) =>
      typeof entry === 'string' ? entry : String(entry?.text ?? ''),
    );
    if (!query || documents.length === 0) {
      return new Response('query and documents are required', { status: 400 });
    }
    // The reranker takes contexts as objects, and returns the index of each context
    // in the array it was given, so the order of the request is the order of the
    // response.
    const result = (await env.AI.run(RERANKER, {
      query,
      contexts: documents.map((text) => ({ text })),
    })) as {
      response?: { id: number; score: number }[];
    };
    const results = (result.response ?? [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((r) => ({ index: r.id, score: r.score }));
    return Response.json({ results });
  },
};
