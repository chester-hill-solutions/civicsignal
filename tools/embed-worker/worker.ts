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
const MAX_BATCH = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
};
