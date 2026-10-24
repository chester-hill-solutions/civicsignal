/**
 * The Jev client, and the decision that this product makes with it.
 *
 * The product used one cosine score and one threshold. That does not work. The
 * measurement is in `docs/` and in the messages that led here, but the short
 * form is this: a relevance score answers "does the corpus have a provision
 * about this". The product must answer "does the corpus have the provision that
 * answers this". For a question about Quebec tenancy the first answer is yes,
 * because a federal tenancy regulation exists, and the second answer is no.
 *
 * So the decision comes from six separate questions, and from the rule in
 * `decide`. Each question is narrow. Each question is a Noul, which returns a
 * number from 0 to 1. The code combines the numbers, so the rule is readable
 * and changeable.
 *
 * The candidate ranking uses one Noul for each candidate, in the same call.
 * The candidate and authority questions share one request and the same state.
 */
import { ENCODER_CONTRACT } from './encoder';
import { ProviderJsonError, providerJsonOnce, type ProviderJsonPhase } from './provider-json';

/** The endpoint of the inference gateway. */
export const JEV_ENDPOINT = 'https://opencode.ai/inference/systemone/v1/systemone';

/** The model. */
export const JEV_MODEL = 'jev-1.13';

/** Responses cached under an older transport/schema contract must be re-evaluated. */
export const JEV_CONTRACT_VERSION = 'jev-noul-complete-15s-v1';

/** How many characters of a provision Jev reads. */
export const EXCERPT_CHARS = 250;

/** The candidate budget used by this product's retrieval policy. */
export const CANDIDATE_COUNT = 250;

/** Saturated diagnostic counts, never provider answer names or values. */
export const MAX_JEV_FAILURE_COUNT = CANDIDATE_COUNT + 7;
export interface JevFailure {
  phase: ProviderJsonPhase;
  upstreamStatus?: number;
  schemaReason?: 'response-shape' | 'answers-shape' | 'requested-answers';
  rejectedCount?: number;
  missingCount?: number;
}

/** The limit on the relevance, inside a question that passed the authority test. */
export const RELEVANCE_FLOOR = 0.5;

/** One provision, as Jev reads it. */
export interface Candidate {
  id: string;
  /** The words that identify the provision, for example "Canada Labour Code, section 210". */
  title: string;
  /** The body of the provision. The client cuts it to `EXCERPT_CHARS`. */
  text: string;
}

/**
 * The six atomic questions about the authority that the question needs.
 *
 * The names are the keys in the request and in the answer. The text is the
 * question.
 */
export const ATOMIC_QUESTIONS = {
  needs_federal_statute:
    'The rule this question asks about is stated in a Canadian federal statute or regulation.',
  needs_provincial:
    'The rule this question asks about is stated in provincial or territorial law rather than federal law.',
  needs_court_decision:
    'The answer to this question is a decision of a court rather than the text of a statute.',
  needs_foreign_law:
    'The rule this question asks about comes from a jurisdiction outside Canada.',
  is_not_law: 'This question is not about law at all.',
  asks_published_figure:
    'This question asks for an amount or a rate, of the kind published as a policy figure, that the text of a statute does not state.',
} as const;

export type AtomicQuestion = keyof typeof ATOMIC_QUESTIONS;

export type AuthorityFlags = Record<AtomicQuestion, number>;

/** What Jev gives back. */
export interface JevResult {
  /** The relevance of each candidate, in the order given. */
  relevance: number[];
  /** The six values. */
  flags: AuthorityFlags;
  /** The value of "at least one provision states the rule". */
  anyRelevant: number;
}

/** What the product does with the answer. */
export type Decision = 'answer' | 'web' | 'refuse';

/**
 * The rule, in code.
 *
 * The order of the tests matters. A question about a court decision is not a
 * question about a statute, so it goes to the web arm and not to the corpus.
 * A question that is not about law goes nowhere. Only a question that needs a
 * federal statute, and has a provision above the floor, comes from the corpus.
 */
export function decide(
  flags: AuthorityFlags,
  anyRelevant: number,
  floor = RELEVANCE_FLOOR,
): Decision {
  if (flags.needs_foreign_law >= 0.5) return 'refuse';
  if (flags.is_not_law >= 0.5) return 'refuse';
  if (flags.needs_provincial >= 0.5) return 'web';
  if (flags.needs_court_decision >= 0.5) return 'web';
  if (flags.asks_published_figure >= 0.5) return 'refuse';
  if (flags.needs_federal_statute < 0.5) return 'refuse';
  return anyRelevant >= floor ? 'answer' : 'refuse';
}

/** The question for one candidate. */
function candidateQuestion(at: number): string {
  return `Provision c${at} states the rule the question asks about.`;
}

/**
 * Rank candidates with Jev, and get the authority answers.
 *
 * The function returns `null` when the call fails. The caller then uses the
 * cosine order and the floor, so a failure of the gateway does not stop the
 * search.
 */
export async function rankWithJev(
  query: string,
  candidates: Candidate[],
  options: { key: string; endpoint?: string; model?: string; send?: typeof fetch; onFailure?: (failure: JevFailure) => void | PromiseLike<void> },
): Promise<JevResult | null> {
  if (candidates.length === 0) return null;
  const candidateCount = candidates.length;
  let onFailure: typeof options.onFailure;
  try { onFailure = options.onFailure; } catch { /* Optional observer access is isolated too. */ }
  let schemaFailure: Pick<JevFailure, 'schemaReason' | 'rejectedCount' | 'missingCount'> | undefined;

  const questions: Record<string, { type: string; instructions: string }> = {};
  candidates.forEach((_, at) => {
    questions[`c${at}`] = { type: 'noul', instructions: candidateQuestion(at) };
  });
  for (const [name, instructions] of Object.entries(ATOMIC_QUESTIONS)) {
    questions[name] = { type: 'noul', instructions };
  }
  questions['any_relevant'] = {
    type: 'noul',
    instructions: 'At least one provision below states the rule the question asks about.',
  };

  const state = [
    ...candidates.map(
      (candidate, at) =>
        `c${at}: ${candidate.title}\n${candidate.text.slice(0, EXCERPT_CHARS)}`,
    ),
    `question: ${query}`,
  ].join('\n\n');

  try {
    return await providerJsonOnce({
      url: options.endpoint ?? JEV_ENDPOINT,
      headers: {
        authorization: `Bearer ${options.key}`,
        'content-type': 'application/json',
      },
      body: { model: options.model ?? JEV_MODEL, state, questions },
      timeoutMs: 15_000,
      responseBytes: 256 * 1024,
      requestBytes: 1024 * 1024,
      send: options.send,
      parse: (value) => {
        if (!record(value)) {
          schemaFailure = { schemaReason: 'response-shape' };
          throw new Error('Invalid Jev response.');
        }
        if (!record(value.answers)) {
          schemaFailure = { schemaReason: 'answers-shape' };
          throw new Error('Invalid Jev response.');
        }
        const answers = value.answers;
        const scores: Record<string, number> = {};
        let rejected = 0, missing = 0;
        for (const name of Object.keys(questions)) {
          if (!Object.hasOwn(answers, name)) { missing++; continue; }
          const answer = answers[name];
          if (!record(answer) || answer.type !== 'noul' ||
            typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) ||
            answer.noul < 0 || answer.noul > 1) { rejected++; continue; }
          scores[name] = answer.noul;
        }
        if (rejected || missing) {
          schemaFailure = { schemaReason: 'requested-answers',
            rejectedCount: Math.min(rejected, MAX_JEV_FAILURE_COUNT), missingCount: Math.min(missing, MAX_JEV_FAILURE_COUNT) };
          throw new Error('Invalid Jev response.');
        }
        const flags = {} as AuthorityFlags;
        for (const name of Object.keys(ATOMIC_QUESTIONS) as AtomicQuestion[]) flags[name] = scores[name]!;
        return {
          relevance: Array.from({ length: candidateCount }, (_, at) => scores[`c${at}`]!),
          flags,
          anyRelevant: scores.any_relevant!,
        };
      },
    });
  } catch (error) {
    const phase = error instanceof ProviderJsonError ? error.phase : 'transport';
    const failure: JevFailure = { phase };
    if (error instanceof ProviderJsonError && error.httpStatus !== undefined) failure.upstreamStatus = error.httpStatus;
    if (phase === 'response-validation' && schemaFailure) Object.assign(failure, schemaFailure);
    // Diagnostics cannot change the existing null/fallback contract.
    try { void Promise.resolve(onFailure?.(failure)).catch(() => {}); }
    catch { /* No raw observer exception or awaited diagnostics work. */ }
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The candidates in the order that Jev puts them.
 *
 * A tie keeps the order of the cosine, which is the better order of the two for
 * an equal score.
 */
export function reorder<T>(candidates: T[], relevance: number[]): T[] {
  return candidates
    .map((candidate, at) => ({ candidate, at }))
    .sort((left, right) => relevance[right.at]! - relevance[left.at]! || left.at - right.at)
    .map((entry) => entry.candidate);
}

/** The encoder contract, re-exported so a caller can check the dimensions. */
export { ENCODER_CONTRACT };
