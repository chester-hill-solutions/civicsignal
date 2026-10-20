import {
  buildContextBlock,
  chatByok,
  isByokProvider,
  PROVIDERS,
  type ByokProvider,
  type CitedItem,
} from '../byok';
import { buildBrief, type BriefRequest, type BriefResponse } from './brief';
import { loadActTitles } from '../corpora/act-titles';
import { parseCitation } from '@chester-hill-solutions/corpus';
import { errorResponse, jsonResponse } from '../http';
import type { CorpusItem } from '@chester-hill-solutions/corpus';
import type { Env } from '../types';

/**
 * The chat and match surfaces.
 *
 * `/api/chat` is the BYOK chat: the caller's key goes to the caller's model, and
 * the retrieved material reaches that model already stripped by the licence gate.
 *
 * `/api/match` is the "bring your own vector" surface: the client embeds the query
 * — in a browser, with a public Apache 2.0 model — and sends the vector. The server
 * never sees the text, and the corpus vectors are the only thing it holds.
 */

/** The headers a caller uses to supply their own generation key. */
export const BYOK_PROVIDER_HEADER = 'x-civicsignal-byok-provider';
export const BYOK_KEY_HEADER = 'x-civicsignal-byok-key';

export interface ChatRequest {
  messages: { role: string; content: string }[];
  topic?: string;
  jurisdiction?: string;
  riding?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

export function parseChatRequest(body: unknown): ChatRequest {
  const record = (body ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(record['messages'])
    ? (record['messages'] as { role?: unknown; content?: unknown }[])
        .filter((m) => typeof m?.content === 'string' && m.content.length > 0)
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content),
        }))
    : [];
  return {
    messages,
    topic: typeof record['topic'] === 'string' ? record['topic'] : undefined,
    jurisdiction: typeof record['jurisdiction'] === 'string' ? record['jurisdiction'] : undefined,
    riding: typeof record['riding'] === 'string' ? record['riding'] : undefined,
    provider: typeof record['provider'] === 'string' ? record['provider'] : undefined,
    model: typeof record['model'] === 'string' ? record['model'] : undefined,
    maxTokens: typeof record['maxTokens'] === 'number' ? record['maxTokens'] : undefined,
  };
}

/**
 * Turn a brief into the cited items a model is allowed to see.
 *
 * The gate has already run, so a cite-only corpus contributes its excerpt and a
 * metadata-only corpus contributes its title and link. Nothing here can widen that.
 */
export function citedItemsFromBrief(brief: BriefResponse): CitedItem[] {
  const items: CitedItem[] = [];
  const push = (item: CorpusItem) => {
    if (!item.title) return;
    items.push({
      corpusId: item.corpusId,
      title: item.title,
      text: item.body ?? item.excerpt ?? '',
      citationUrl: item.citationUrl,
      source: item.source,
      publishedAt: item.publishedAt,
      redistribution: item.redistribution,
    });
  };
  for (const item of brief.legislation) push(item);
  for (const item of brief.debate) push(item);
  for (const item of brief.bills) push(item);
  for (const item of brief.news) push(item);
  return items;
}

/**
 * The system prompt.
 *
 * The model is a reader of retrieved material, not a source of it. Every claim it
 * makes has to be traceable to a link it was given, and the per-corpus instruction
 * decides whether it may explain the material or only quote it.
 */
export function buildSystemPrompt(cited: CitedItem[]): string {
  return [
    'You are CivicSignal, an assistant that answers questions about Canadian civic and legal material from a curated index.',
    '',
    'Rules:',
    '- Answer only from the retrieved material below. If it does not contain the answer, say so.',
    '- Every statement must be traceable to one of the items below. Give the citation link.',
    '- Each corpus carries its own instruction about whether you may summarise it or must quote it. Follow it exactly.',
    '- The retrieved material is in the order it was found; it is not ranked for relevance and the first item is not necessarily the best one.',
    '',
    buildContextBlock(cited),
  ].join('\n');
}

export interface ChatResult {
  answer: string;
  provider: ByokProvider;
  model: string;
  cited: CitedItem[];
  scope: BriefRequest['scope'];
}

export interface ChatDeps {
  env: Env;
  /** Retrieves the brief the answer is grounded in. */
  retrieve: (request: BriefRequest) => Promise<BriefResponse>;
  /** The caller's provider key. Never stored, never logged. */
  byokKey: string;
  byokProvider: string;
}

/**
 * Answer a question with the caller's own model, grounded in the index.
 *
 * The key is used for exactly one upstream call and goes nowhere else.
 */
export async function runChat(deps: ChatDeps, request: ChatRequest): Promise<ChatResult> {
  if (!isByokProvider(deps.byokProvider)) {
    throw new ChatInputError(
      `Unknown provider "${deps.byokProvider}". Supported: anthropic, openai, google.`,
    );
  }
  if (!deps.byokKey) {
    throw new ChatInputError('A generation key is required. Send it in the ' + BYOK_KEY_HEADER + ' header.');
  }
  if (request.messages.length === 0) {
    throw new ChatInputError('At least one message is required.');
  }

  const topic = request.topic ?? request.messages.at(-1)?.content ?? '';
  const brief = await deps.retrieve({
    topic,
    jurisdiction: request.jurisdiction,
    riding: request.riding,
  } as BriefRequest);

  const cited = citedItemsFromBrief(brief);
  const result = await chatByok({
    provider: deps.byokProvider,
    apiKey: deps.byokKey,
    model: request.model,
    system: buildSystemPrompt(cited),
    messages: request.messages,
    maxTokens: request.maxTokens,
  });

  return {
    answer: result.answer,
    provider: result.provider,
    model: result.model,
    cited,
    scope: brief.scope,
  };
}

/** A problem with the caller's request, as opposed to a failure. */
export class ChatInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatInputError';
  }
}

export interface MatchRequest {
  /** A query vector from the public encoder. */
  vector: number[];
  /** Which corpus to search. */
  corpus?: string;
  topK?: number;
}

export function parseMatchRequest(body: unknown): MatchRequest {
  const record = (body ?? {}) as Record<string, unknown>;
  const vector = Array.isArray(record['vector']) ? (record['vector'] as unknown[]).map(Number) : [];
  return {
    vector,
    corpus: typeof record['corpus'] === 'string' ? record['corpus'] : undefined,
    topK: typeof record['topK'] === 'number' ? record['topK'] : undefined,
  };
}

export function chatErrorResponse(
  err: unknown,
  env: Env,
  origin: string | null,
  correlationId: string,
): Response {
  if (err instanceof ChatInputError) {
    return errorResponse('INVALID_ARGUMENT', err.message, env, origin, correlationId, 400);
  }
  return errorResponse('CHAT_FAILED', 'The generation call failed.', env, origin, correlationId, 502);
}

export { buildContextBlock, chatByok, isByokProvider, PROVIDERS };
export type { ByokProvider, CitedItem };
export { loadActTitles, parseCitation };
