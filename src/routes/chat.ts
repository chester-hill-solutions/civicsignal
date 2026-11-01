import {
  buildContextBlock,
  chatByok,
  isByokProvider,
  supportsByokModel,
  OPENCODE_ZEN_MODEL,
  PROVIDERS,
  type ByokProvider,
  type CitedItem,
} from '../byok';
import { type BriefRequest, type BriefResponse } from './brief';
import { ENCODER_CONTRACT } from '../encoder';
import { loadActTitles } from '../corpora/act-titles';
import { parseCitation } from '@chester-hill-solutions/corpus';
import { errorResponse, RequestInputError } from '../http';
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

export const CHAT_LIMITS = {
  messages: 32,
  messageChars: 8_000,
  totalChars: 32_000,
  topicChars: 4_000,
  maxTokens: 4_096,
} as const;

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ChatInputError('The JSON body must be an object.');
  }
  return body as Record<string, unknown>;
}

function optionalText(record: Record<string, unknown>, name: string, maxChars: number): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxChars) {
    throw new ChatInputError(`${name} must be a non-empty string of at most ${maxChars} characters.`);
  }
  return value.trim();
}

function optionalInteger(record: Record<string, unknown>, name: string, maximum: number): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ChatInputError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

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
  const record = objectBody(body);
  if (!Array.isArray(record['messages']) || record['messages'].length < 1 || record['messages'].length > CHAT_LIMITS.messages) {
    throw new ChatInputError(`messages must contain between 1 and ${CHAT_LIMITS.messages} messages.`);
  }
  let totalChars = 0;
  const messages = record['messages'].map((message: unknown) => {
    const item = objectBody(message);
    if (item['role'] !== 'user' && item['role'] !== 'assistant') {
      throw new ChatInputError('Each message role must be user or assistant.');
    }
    const content = item['content'];
    if (typeof content !== 'string' || !content.trim() || content.length > CHAT_LIMITS.messageChars) {
      throw new ChatInputError(`Each message must contain between 1 and ${CHAT_LIMITS.messageChars} characters.`);
    }
    totalChars += content.length;
    return { role: item['role'], content };
  });
  if (totalChars > CHAT_LIMITS.totalChars) {
    throw new ChatInputError(`The conversation must not exceed ${CHAT_LIMITS.totalChars} characters.`);
  }
  if (messages.at(-1)?.role !== 'user') {
    throw new ChatInputError('The last message must be from the user.');
  }
  const provider = optionalText(record, 'provider', 32);
  if (provider && !isByokProvider(provider)) {
    throw new ChatInputError('Supported providers: anthropic, openai, google, opencode-zen.');
  }
  const model = optionalText(record, 'model', 200);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) {
    throw new ChatInputError('model must be a provider model identifier.');
  }
  return {
    messages,
    topic: optionalText(record, 'topic', CHAT_LIMITS.topicChars),
    jurisdiction: optionalText(record, 'jurisdiction', 128),
    riding: optionalText(record, 'riding', 128),
    provider,
    model,
    maxTokens: optionalInteger(record, 'maxTokens', CHAT_LIMITS.maxTokens),
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

/** Check link destinations only. This does not check whether the text supports a claim. */
export function validateAnswerCitationLinks(answer: string, citationUrls: readonly string[]): void {
  const invalid = () => { throw new Error('Invalid generation response.'); };
  const urls = new Set(citationUrls.filter((url) => {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        !parsed.username && !parsed.password && !/[\s\\<>\x00-\x1f\x7f]/u.test(url);
    } catch { return false; }
  }));
  let links = 0;
  const destination = (value: string) => {
    // Compare the original spelling. URL parsing must not normalize any destination.
    if (!/^https?:\/\//i.test(value) || /[\s\\<>()[\]"'`]/u.test(value) || /[\x00-\x1f\x7f]/u.test(value) || /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i.test(value) || !urls.has(value)) invalid();
    links++;
  };
  // Reference definitions can sit inside list or quote containers.
  // Each line prefix permits only horizontal whitespace and container marks.
  if (/^[ \t>+*().\d-]*\[[^\]\r\n]+\]:/m.test(answer)) invalid();
  for (let at = 0; at < answer.length;) {
    const char = answer[at]!;
    if (char === '`') {
      const end = answer.indexOf('`', at + 1);
      if (end <= at + 1 || answer[end + 1] === '`' || /[\r\n]/u.test(answer.slice(at + 1, end))) invalid();
      // Code text supplies no link destination, even when it spells a URL.
      at = end + 1;
      continue;
    }
    if (char === '\\') {
      if (answer[at + 1] === '[' || answer[at + 1] === ']' ||
        /^<?https?:\/\//i.test(answer.slice(at + 1, at + 10))) invalid();
      // Ordinary escaped notation needs no search for a closing bracket.
      at += 2;
      continue;
    }
    if (char === '[') {
      const end = answer.indexOf(']', at + 1);
      if (end < 0) invalid();
      const label = answer.slice(at + 1, end);
      if (/[\[\\\r\n<>`]|https?:\/\//iu.test(label) || /:\S/u.test(label)) invalid();
      let following = end + 1;
      while (following < answer.length && /\s/u.test(answer[following]!)) following++;
      if (answer[following] === '[') invalid();
      if (answer[end + 1] === '(') {
        if (answer[at - 1] === '!') invalid();
        const close = answer.indexOf(')', end + 2);
        if (close < 0) invalid();
        destination(answer.slice(end + 2, close));
        at = close + 1;
        continue;
      }
      // A plain bracket, such as section [1], supplies no destination.
      // Consume its complete span, so each long scan advances or refuses.
      at = end + 1;
      continue;
    }
    if (char === ']' && (answer[at + 1] === '(' || answer[at + 1] === '[')) invalid();
    if (char === '<') {
      const end = answer.indexOf('>', at + 1);
      if (end < 0) invalid();
      destination(answer.slice(at + 1, end));
      at = end + 1;
      continue;
    }
    if (/[a-z]/i.test(char)) {
      let end = at + 1;
      while (end < answer.length && /[a-z\d+.-]/i.test(answer[end]!)) end++;
      const scheme = answer.slice(at, end);
      if (answer[end] === ':' && (answer.slice(end + 1, end + 3) === '//' || /^(?:mailto|javascript|data)$/i.test(scheme) && /\S/u.test(answer[end + 1] ?? ''))) {
        if (!/^https?$/i.test(scheme) || /[\p{L}\p{N}\p{M}+._/-]$/u.test(answer.slice(Math.max(0, at - 2), at))) invalid();
        const rest = answer.slice(at);
        const boundary = rest.search(/[\s<>()[\]\\"'`]/u);
        const length = boundary < 0 ? rest.length : boundary;
        if (rest[length] === '(') invalid();
        let value = rest.slice(0, length);
        // One sentence mark can follow an already exact retrieved URL.
        if (!urls.has(value) && /[.,;!]$/u.test(value) && urls.has(value.slice(0, -1))) value = value.slice(0, -1);
        destination(value);
        at += length;
        continue;
      }
      at = end;
      continue;
    }
    at++;
  }
  if (links === 0) invalid();
}

export interface ChatResult {
  answer: string;
  provider: ByokProvider;
  model: string;
  cited: CitedItem[];
  scope: BriefRequest['scope'];
  /** The selected model was not used when retrieval returned no material. */
  generation?: { status: 'skipped'; reason: 'no-retrieved-material' };
}

export interface ChatDeps {
  env: Env;
  /** Retrieves the material supplied to generation. */
  retrieve: (request: BriefRequest) => Promise<BriefResponse>;
  /** The caller's provider key. Never stored, never logged. */
  byokKey: string;
  byokProvider: string;
}

/**
 * Retrieve material, then use the caller's model when material exists.
 *
 * Generation uses the key for at most one upstream call.
 */
export async function runChat(deps: ChatDeps, request: ChatRequest): Promise<ChatResult> {
  request = parseChatRequest(request);
  if (!isByokProvider(deps.byokProvider)) {
    throw new ChatInputError(
      'Supported providers: anthropic, openai, google, opencode-zen.',
    );
  }
  if (request.provider && request.provider !== deps.byokProvider) {
    throw new ChatInputError('The provider in the body must match the BYOK provider header.');
  }
  if (!supportsByokModel(deps.byokProvider, request.model)) {
    throw new ChatInputError('OpenCode Zen supports only ' + OPENCODE_ZEN_MODEL + '.');
  }
  if (!deps.byokKey.trim() || deps.byokKey.length > 4096) {
    throw new ChatInputError('A generation key is required. Send it in the ' + BYOK_KEY_HEADER + ' header.');
  }
  const topic = request.topic ?? request.messages.at(-1)!.content;
  if (topic.length > CHAT_LIMITS.topicChars) {
    throw new ChatInputError(`The retrieval question must not exceed ${CHAT_LIMITS.topicChars} characters. Supply a shorter topic.`);
  }
  const brief = await deps.retrieve({
    topic,
    jurisdiction: request.jurisdiction,
    riding: request.riding,
  } as BriefRequest);

  const cited = citedItemsFromBrief(brief);
  if (cited.length === 0) {
    return {
      answer: 'The retrieved material does not contain an answer to this question.',
      provider: deps.byokProvider,
      model: request.model?.trim() || PROVIDERS[deps.byokProvider].defaultModel,
      cited,
      scope: brief.scope,
      generation: { status: 'skipped', reason: 'no-retrieved-material' },
    };
  }
  const result = await chatByok({
    provider: deps.byokProvider,
    apiKey: deps.byokKey,
    model: request.model,
    system: buildSystemPrompt(cited),
    messages: request.messages,
    maxTokens: request.maxTokens,
    validateAnswer: (answer) => validateAnswerCitationLinks(answer, cited.map((item) => item.citationUrl)),
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
export class ChatInputError extends RequestInputError {
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
  const record = objectBody(body);
  const vector = record['vector'];
  if (!Array.isArray(vector) || vector.length !== ENCODER_CONTRACT.dimensions) {
    throw new ChatInputError(`vector must contain exactly ${ENCODER_CONTRACT.dimensions} numbers from the published encoder.`);
  }
  if (!vector.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
    throw new ChatInputError('Every vector coordinate must be a finite number.');
  }
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new ChatInputError('vector must have a finite non-zero magnitude.');
  }
  const corpus = optionalText(record, 'corpus', 64);
  if (corpus && corpus !== 'statutes-canada') {
    throw new ChatInputError('Vector matching supports only statutes-canada.');
  }
  return {
    vector,
    corpus,
    topK: optionalInteger(record, 'topK', 50),
  };
}

export function chatErrorResponse(
  err: unknown,
  env: Env,
  origin: string | null,
  correlationId: string,
): Response {
  if (err instanceof RequestInputError) {
    return errorResponse('INVALID_ARGUMENT', err.message, env, origin, correlationId, err.status);
  }
  return errorResponse('CHAT_FAILED', 'The generation call failed.', env, origin, correlationId, 502);
}

export { buildContextBlock, chatByok, isByokProvider, PROVIDERS };
export type { ByokProvider, CitedItem };
export { loadActTitles, parseCitation };
