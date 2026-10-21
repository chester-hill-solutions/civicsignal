import type { Encoder } from './pipeline';

/**
 * The encoder, over HTTP.
 *
 * The encoder's contract is `/embed`, with the **texts and the titles
 * separately** — it is not the OpenAI-compatible `/v1/embeddings`, which was
 * the old encoder: the one that ran `litert-lm serve` and could not chunk a
 * long provision, and which the pipeline was still speaking to, so every cycle
 * failed with a 404 that read like a missing model.
 *
 * The client lives here rather than in a caller because there are two callers
 * now — the Railway runner and the Worker — and the encoder's contract is not
 * something either of them should be able to get subtly wrong on its own.
 */
export function httpEncoder(options: {
  /** Where the encoder is. */
  url: string;
  /** The shared secret the encoder checks. */
  token?: string;
  /**
   * How the request is sent.
   *
   * A Worker calls the encoder through a **service binding** rather than by
   * its address: a Worker cannot fetch a `workers.dev` address on this account
   * — it answers `1042` — and the encoder is the product's own plumbing rather
   * than something a customer calls. A process just uses `fetch`.
   */
  send?: (request: Request) => Promise<Response>;
}): Encoder {
  return {
    async embed(documents) {
      const url = `${options.url.replace(/\/$/, '')}/embed`;
      const request = new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({
          texts: documents.map((document) => document.text),
          titles: documents.map((document) => document.title),
        }),
      });
      const response = options.send ? await options.send(request) : await fetch(request);
      if (!response.ok) {
        // The status and the address, because "the encoder refused: 404" is not
        // a diagnosis — a 404 from the wrong path and a 404 from the wrong
        // address look identical until the address is in the message.
        throw new Error(
          `the encoder returned ${response.status} at ${url}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      const body = (await response.json()) as { vectors?: number[][] };
      const vectors = body.vectors ?? [];
      if (vectors.length !== documents.length) {
        throw new Error(
          `the encoder returned ${vectors.length} vector(s) for ${documents.length} document(s)`,
        );
      }
      return vectors;
    },
  };
}
