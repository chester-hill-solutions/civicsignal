/**
 * The encoder client.
 *
 * The product embeds with EmbeddingGemma 2, served from the artefact itself:
 *
 *   litert-community/embeddinggemma-2-text-270m-litert-lm
 *     └── embeddinggemma-2-text-270m.litertlm   157.0 MB, Apache 2.0
 *
 * The service behind `ENCODER_URL` runs that exact file through `litert-lm serve`,
 * which speaks the OpenAI embeddings API. So this client is an OpenAI-shaped
 * request, and the reason it is written against the corpus's *own* encoder rather
 * than a hosted one is narrow and important:
 *
 * **The client and the server must be in the same vector space.** A browser that
 * embeds with the LiteRT bundle and a server that embeds with fp32 PyTorch
 * weights produce vectors that differ by quantisation drift, and drift flips
 * near-ties — which is exactly the case where a citation either resolves or does
 * not. Embedding the corpus with the file that ships to clients makes the two
 * identical by construction rather than approximately.
 *
 * The encoder contract — model, task prefixes, dimension, artefact digest — is
 * published at `/.well-known/civicsignal.json` so a caller embedding locally
 * knows what it has to match.
 */

/** The published encoder contract. A client that embeds locally must match it. */
export interface EncoderContract {
  /** The model identifier the service serves. */
  model: string;
  /** The Hugging Face repository the artefact comes from. */
  artefact: string;
  /** The file name, which is the artefact. */
  file: string;
  /** Immutable publisher revision and SHA-256, checked by the image build. */
  revision: string;
  sha256: string;
  bytes: number;
  /** The dimension of the vectors. */
  dimensions: number;
  /**
   * The task instruction prefixes the model was trained with.
   *
   * They are not bare prefixes — they are structured templates, and the document
   * one has two fields. EmbeddingGemma 2's model card gives, for web and document
   * search:
   *
   *   query     `task: search result | query: {query}`
   *   document  `title: {title} | text: {content}`
   *
   * Mixing them costs accuracy, and omitting them still works but reduces
   * precision. The hosted EmbeddingGemma on Workers AI accepts no prefix
   * parameter at all, which is one of the reasons it is not used here.
   */
  queryTemplate: string;
  documentTemplate: string;
  /** The dimensions Matryoshka training allows the vector to be truncated to. */
  matryoshkaDimensions: number[];
  /** Whether the vectors are L2-normalised. They are. */
  normalised: true;
}

export const ENCODER_CONTRACT: EncoderContract = {
  model: 'embeddinggemma-2-270m',
  artefact: 'litert-community/embeddinggemma-2-text-270m-litert-lm',
  file: 'embeddinggemma-2-text-270m.litertlm',
  revision: '9be6e8b90982095dc05c2bd162e4b954ee4dbac7',
  sha256: '2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb',
  bytes: 164626432,
  dimensions: 768,
  queryTemplate: 'task: search result | query: {query}',
  documentTemplate: 'title: {title} | text: {content}',
  matryoshkaDimensions: [128, 256, 512, 768],
  normalised: true,
};

/**
 * The text to embed a query as.
 *
 * EmbeddingGemma 2 was trained with these instructions and they are not optional
 * decoration: embedding a query with the document instruction, or with neither,
 * measurably degrades the ranking.
 */
export function queryText(query: string): string {
  return ENCODER_CONTRACT.queryTemplate.replace('{query}', query);
}

/**
 * The text to embed a provision as.
 *
 * `title` is the provision's marginal note — "Employee entitled to leave" — and
 * `content` is the provision itself. The model card's document instruction has
 * two fields, and a provision has exactly two: a heading and a body.
 *
 * The instrument's name goes in the title too, because the title is what
 * disambiguates. Two provisions called "Application" from two different Acts are
 * not the same provision, and a retrieval that cannot tell them apart will
 * return one when the caller asked for the other.
 */
export function documentText(input: { title: string; content: string }): string {
  return ENCODER_CONTRACT.documentTemplate
    .replace('{title}', input.title)
    .replace('{content}', input.content);
}

export interface EmbedRequest {
  /** The encoder service's base URL. */
  endpoint: string;
  /** The inputs, already prefixed. */
  inputs: string[];
  /** The model to use. */
  model?: string;
  /** An optional bearer token, if the service is behind one. */
  token?: string;
  /** How long to wait. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Embed a batch of inputs.
 *
 * The service returns L2-normalised vectors in the order the inputs were given;
 * a vector that came back with the wrong length is an error rather than a
 * silently truncated result, because a truncated vector matches a different
 * provision and looks like a confident wrong answer.
 */
export async function embed(request: EmbedRequest): Promise<number[][]> {
  if (request.inputs.length === 0) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${request.endpoint.replace(/\/$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
      },
      body: JSON.stringify({
        model: request.model ?? ENCODER_CONTRACT.model,
        input: request.inputs,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`the encoder returned ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { index: number; embedding: number[] }[];
    };
    const data = body.data ?? [];
    if (data.length !== request.inputs.length) {
      throw new Error(`the encoder returned ${data.length} vectors for ${request.inputs.length} inputs`);
    }
    // The service returns them in order, but it is cheap to be certain, and a
    // mis-ordered batch is a silent correctness bug.
    const ordered = [...data].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if (item.embedding.length !== ENCODER_CONTRACT.dimensions) {
        throw new Error(
          `the encoder returned ${item.embedding.length} dimensions, not ${ENCODER_CONTRACT.dimensions}`,
        );
      }
    }
    return ordered.map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Embed one query, with the query instruction.
 */
export async function embedQuery(
  endpoint: string,
  text: string,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<number[]> {
  const [vector] = await embed({
    endpoint,
    inputs: [queryText(text)],
    ...options,
  });
  return vector!;
}
