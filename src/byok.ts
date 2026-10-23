import type { CorpusItem } from "@chester-hill-solutions/corpus";

/**
 * BYOK chat: retrieval, then the caller's own model.
 *
 * Two properties this module exists to guarantee.
 *
 * **The caller pays for generation, and the key never lands here.** The key arrives
 * in a header on one request, goes to the provider, and is not logged, not persisted,
 * not recorded in the usage ledger, and never included in an error. The product's
 * marginal cost is retrieval, which is already a rounding error, so the business is
 * an index business rather than a token business.
 *
 * **The licence gate runs before the prompt is built, not after the model answers.**
 * A cite-only corpus reaches the model as the excerpt the gate already permitted —
 * never the full text — and the instructions tell the model to quote it rather than
 * transform it. A summary of Crown-copyright debate is a derivative of it, and this
 * is the difference between a chat surface and a licence incident.
 */

export type ByokProvider = "anthropic" | "openai" | "google" | "opencode-zen";

export interface ProviderSpec {
  label: string;
  /** Default model when the caller does not name one. */
  defaultModel: string;
  endpoint(model: string): string;
  headers(apiKey: string): Record<string, string>;
  body(input: { system: string; messages: { role: string; content: string }[]; model: string; maxTokens: number }): unknown;
  parse(body: unknown): string;
}

export const OPENCODE_ZEN_MODEL = "claude-haiku-4-5";
export const OPENCODE_ZEN_LIMITS = { timeoutMs: 30_000, responseBytes: 256 * 1024 } as const;
const OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/inference/anthropic/v1/messages";

const anthropicBody: ProviderSpec["body"] = ({ system, messages, model, maxTokens }) => ({
  model,
  max_tokens: maxTokens,
  system,
  messages: messages.map((m) => ({ role: m.role, content: m.content })),
});
const anthropicText: ProviderSpec["parse"] = (body) => {
  const content = (body as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n")
    .trim();
};

export const PROVIDERS: Record<ByokProvider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic",
    defaultModel: "claude-sonnet-4-5",
    endpoint: () => "https://api.anthropic.com/v1/messages",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
    body: anthropicBody,
    parse: anthropicText,
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    endpoint: () => "https://api.openai.com/v1/chat/completions",
    headers: (apiKey) => ({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    }),
    body: ({ system, messages, model, maxTokens }) => ({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
    }),
    parse: (body) => {
      const choices = (body as { choices?: { message?: { content?: string } }[] })?.choices ?? [];
      return (choices[0]?.message?.content ?? "").trim();
    },
  },
  google: {
    label: "Google",
    defaultModel: "gemini-2.5-flash",
    endpoint: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: (apiKey) => ({ "content-type": "application/json", "x-goog-api-key": apiKey }),
    body: ({ system, messages, maxTokens }) => ({
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: maxTokens },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    }),
    parse: (body) => {
      const candidates = (body as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];
      return parts
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    },
  },
  "opencode-zen": {
    label: "OpenCode Zen",
    defaultModel: OPENCODE_ZEN_MODEL,
    endpoint: () => OPENCODE_ZEN_ENDPOINT,
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" }),
    body: anthropicBody,
    parse: anthropicText,
  },
};

export function isByokProvider(value: string): value is ByokProvider {
  return Object.hasOwn(PROVIDERS, value);
}

/** The initial Zen adapter supports one reviewed Messages-family model. */
export function supportsByokModel(provider: ByokProvider, model?: string): boolean {
  return provider !== "opencode-zen" || !model?.trim() || model.trim() === OPENCODE_ZEN_MODEL;
}

/** One finite Zen POST. No redirects, retry, fallback or provider-body errors. */
async function opencodeZenAnswer(apiKey: string, body: unknown, parse: ProviderSpec["parse"], signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const deadline = performance.now() + OPENCODE_ZEN_LIMITS.timeoutMs;
  const failure = () => new Error("The OpenCode Zen request did not complete within its bounds.");
  let rejectDeadline!: (reason: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  void expired.catch(() => {});
  const abort = () => { controller.abort(); rejectDeadline(failure()); };
  const timer = setTimeout(abort, OPENCODE_ZEN_LIMITS.timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  const check = () => { if (controller.signal.aborted || signal?.aborted || performance.now() >= deadline) throw failure(); };
  const within = async <T>(pending: Promise<T>): Promise<T> => {
    void pending.catch(() => {});
    check();
    const result = await Promise.race([pending, expired]);
    check();
    return result;
  };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let finished = false;
  let failedStatus: number | undefined;
  try {
    check();
    const requestBody = JSON.stringify(body);
    check();
    const pending = fetch(OPENCODE_ZEN_ENDPOINT, {
      method: "POST", headers: PROVIDERS["opencode-zen"].headers(apiKey), body: requestBody,
      redirect: "error", signal: controller.signal,
    }).then((value) => {
      if (finished) {
        // A transport ignoring abort may settle late. Dispose its body; never send again.
        void value.body?.cancel().catch(() => {});
        throw failure();
      }
      response = value;
      check();
      return value;
    });
    response = await within(pending);
    if (!response.ok) { failedStatus = response.status; throw failure(); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > OPENCODE_ZEN_LIMITS.responseBytes)) throw failure();
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const next = await within(reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > OPENCODE_ZEN_LIMITS.responseBytes) throw failure();
      if (next.value.byteLength) chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    check();
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    check();
    const answer = parse(value);
    check();
    if (apiKey && answer.includes(apiKey)) throw failure();
    check();
    complete = true;
    return answer;
  } catch {
    throw failedStatus === undefined ? failure() : new Error(`The OpenCode Zen endpoint returned ${failedStatus}.`);
  } finally {
    finished = true;
    if (!complete) {
      controller.abort();
      const cancel = reader ? reader.cancel() : response?.body?.cancel();
      if (cancel) {
        // Cleanup shares the original deadline. An uncertain call is terminal.
        const settled = cancel.catch(() => {});
        try { if (performance.now() < deadline) await Promise.race([settled, expired]); } catch { /* Preserve the original safe failure. */ }
      }
    }
    reader?.releaseLock();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** One retrieved item, ready to be put in front of a model. */
export interface CitedItem {
  corpusId: string;
  title: string;
  /** The text as the licence gate permitted it. */
  text: string;
  citationUrl: string;
  source: string;
  publishedAt?: string;
  redistribution: CorpusItem["redistribution"];
}

/**
 * The instruction for a corpus, derived from its regime.
 *
 * This is the whole point of the design. An open corpus can be summarised and
 * explained. A cite-only corpus can only be quoted, because a paraphrase of Crown
 * copyright is a derivative of it. A metadata-only corpus contributes no text at all,
 * so the model may only refer to it by title and link.
 */
export function corpusInstruction(redistribution: CorpusItem["redistribution"]): string {
  switch (redistribution) {
    case "open":
      return "This material is openly licensed. You may summarise, explain and analyse it. Cite the provision.";
    case "cite-only":
      return (
        "This material is Crown copyright and may only be quoted, not reproduced. " +
        "Quote it verbatim in quotation marks. Do not paraphrase, summarise, translate or otherwise transform it, " +
        "and do not combine separate passages into a paraphrase. " +
        "Attribute every quotation to its speaker and date, and give the citation link."
      );
    case "metadata-only":
      return (
        "Only the headline and the link for this item are available; its text may not be reproduced. " +
        "Refer to it by title and link. Do not infer or reconstruct its content."
      );
  }
}

/**
 * Build the context block: the retrieved material, grouped by corpus, each group
 * under its own instruction.
 */
export function buildContextBlock(items: CitedItem[]): string {
  if (items.length === 0) {
    return "No material was retrieved for this question. Say so, and suggest what would make it answerable.";
  }

  const byCorpus = new Map<string, CitedItem[]>();
  for (const item of items) {
    const list = byCorpus.get(item.corpusId);
    if (list) list.push(item);
    else byCorpus.set(item.corpusId, [item]);
  }

  const blocks: string[] = [];
  for (const [corpusId, corpusItems] of byCorpus) {
    const regime = corpusItems[0]!.redistribution;
    blocks.push(`## ${corpusId}\n${corpusInstruction(regime)}`);
    for (const item of corpusItems) {
      const when = item.publishedAt ? ` (${item.publishedAt.slice(0, 10)})` : "";
      blocks.push(
        [
          `### ${item.title}${when}`,
          `Source: ${item.source}`,
          `Link: ${item.citationUrl}`,
          regime === "metadata-only" ? "(title and link only)" : item.text,
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }
  }
  return blocks.join("\n\n");
}

export interface ByokChatResult {
  answer: string;
  provider: ByokProvider;
  model: string;
  cited: number;
}

/**
 * Call the caller's provider.
 *
 * The key is used here and nowhere else: it goes into the request headers and is
 * not returned, logged, or stored.
 */
export async function chatByok(options: {
  provider: ByokProvider;
  apiKey: string;
  model?: string;
  system: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ByokChatResult> {
  const spec = PROVIDERS[options.provider];
  const model = options.model?.trim() || spec.defaultModel;

  if (!supportsByokModel(options.provider, model)) throw new Error("OpenCode Zen supports only " + OPENCODE_ZEN_MODEL + ".");
  const requestBody = spec.body({ system: options.system, messages: options.messages, model, maxTokens: options.maxTokens ?? 1200 });
  if (options.provider === "opencode-zen") {
    const answer = await opencodeZenAnswer(options.apiKey, requestBody, spec.parse, options.signal);
    return { answer, provider: options.provider, model, cited: 0 };
  }

  const response = await fetch(spec.endpoint(model), {
    method: "POST",
    headers: spec.headers(options.apiKey),
    body: JSON.stringify(requestBody),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    // The provider's body may echo the key, so it is not passed through.
    throw new Error(`The ${spec.label} endpoint returned ${response.status}.`);
  }

  const body = (await response.json()) as unknown;
  const answer = spec.parse(body);
  return { answer, provider: options.provider, model, cited: 0 };
}
