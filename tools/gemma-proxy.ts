/**
 * A local EmbeddingGemma 2 endpoint, in the shape the embed scripts expect.
 *
 * The scripts post `{texts, model}` and read `{vectors}`. This answers that shape
 * from `litert-lm serve`, and it is where the task instructions live — because
 * they are the difference between using the model as it was trained and using it
 * approximately.
 *
 * EmbeddingGemma 2's instructions are structured templates, not bare prefixes:
 *
 *   query     `task: search result | query: {query}`
 *   document  `title: {title} | text: {content}`
 *
 * A provision has exactly the two fields the document instruction wants: a heading
 * and a body. The title carries the instrument and the section as well as the
 * heading, because that is what disambiguates two provisions that share a name.
 *
 * The corpus is embedded with the document instruction and the questions with the
 * query one. Mixing them costs accuracy, and Workers AI's `embeddinggemma-300m`
 * accepts no instruction at all, which is one of the reasons it is not the model
 * this product uses.
 *
 *   bun tools/gemma-proxy.ts --port 8800
 */
import { documentText, queryText } from '../src/encoder';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg === -1 ? 8800 : Number(args[portArg + 1]) ?? 8800;
const UPSTREAM = process.env.LITERT_URL ?? 'http://127.0.0.1:9379';

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.pathname === '/embed-query' ? 'query' : 'document';

    const body = (await request.json()) as { texts?: string[]; titles?: string[] };
    const texts = body.texts ?? [];
    if (texts.length === 0) return Response.json({ vectors: [] });

    const inputs = texts.map((text, index) =>
      mode === 'query'
        ? queryText(text)
        : documentText({ title: body.titles?.[index] ?? '', content: text }),
    );

    const response = await fetch(`${UPSTREAM.replace(/\/$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embeddinggemma-2-270m', input: inputs }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return Response.json({ error: `the encoder returned ${response.status}: ${detail}` }, { status: 502 });
    }

    const payload = (await response.json()) as {
      data?: { index: number; embedding: number[] }[];
    };
    const ordered = [...(payload.data ?? [])].sort((a, b) => a.index - b.index);
    if (ordered.length !== texts.length) {
      return Response.json(
        { error: `the encoder returned ${ordered.length} vectors for ${texts.length} inputs` },
        { status: 502 },
      );
    }
    return Response.json({ vectors: ordered.map((item) => item.embedding) });
  },
});

console.log(`the EmbeddingGemma 2 proxy is listening on ${server.port}`);
