import { z } from 'zod';
import { isByokProvider, PROVIDERS, supportsByokModel, type ByokProvider } from '../byok';
import { detectLanguage } from '../language';
import { CHAT_LIMITS, parseChatRequest } from '../routes/chat';
import releaseCases from './data/v1-chat-claim-cases.json';

const MAX_CASES = 200;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_ANSWER_CHARS = 256 * 1024;
const MAX_SEGMENTS = 256;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const language = z.enum(['en', 'fr']);
const outcome = z.enum(['answer', 'refusal']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const target = z.object({
  candidate: z.string().regex(/^[a-f0-9]{40}$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  provider: z.custom<ByokProvider>((value) => typeof value === 'string' && isByokProvider(value)),
  model: z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
}).strict().refine(({ provider, model }) => supportsByokModel(provider, model));
const sourceUrl = z.string().max(2_048).url().regex(/^https?:\/\/[^\s]+$/);
const evidence = z.object({
  sourceUrl,
  excerpt: z.string().min(1).max(8_192).refine((value) => value.trim().length > 0),
}).strict();
const segmentText = z.string().min(1).max(MAX_ANSWER_CHARS);
const segment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('non-factual'), text: segmentText }).strict(),
  z.object({
    kind: z.literal('fact'),
    text: segmentText,
    verdict: z.enum(['supported', 'unsupported', 'partial', 'uncertain']),
    evidence: z.array(evidence).max(16),
  }).strict(),
]);

const plan = z.object({
  target,
  reviewerId: id,
  cases: z.array(z.object({ id, language, outcome, requestSha256: digest }).strict()).min(1).max(MAX_CASES),
}).strict();
const caseCatalog = z.array(z.object({
  id,
  language,
  outcome,
  prompt: z.string().trim().min(1).max(CHAT_LIMITS.topicChars),
  reviewFocus: z.string().trim().min(1),
  sources: z.array(sourceUrl).min(1).optional(),
}).strict()).min(4).max(MAX_CASES);
const capturedCase = z.object({
  id,
  language,
  requestBody: z.string().min(1).max(MAX_REQUEST_BYTES),
  answer: z.string().min(1).max(MAX_ANSWER_CHARS).refine((value) => value.trim().length > 0),
  retrieved: z.array(z.object({ sourceUrl, text: z.string().min(1).max(2 * 1024 * 1024) }).strict()).max(100),
}).strict();
const capture = z.object({
  target,
  recorderId: id,
  cases: z.array(capturedCase).max(MAX_CASES),
}).strict();
const review = z.object({
  target,
  reviewerId: id,
  cases: z.array(z.object({
    id,
    language,
    outcome,
    answerSha256: digest,
    captureSha256: digest,
    // The reviewer attests that each factual claim has its own reviewed segment.
    coverageAttested: z.literal(true),
    segments: z.array(segment).min(1).max(MAX_SEGMENTS),
  }).strict()).max(MAX_CASES),
}).strict();

// The runtime parser discards unknown fields. Release captures refuse extra
// fields such as credential headers represented as JSON.
const chatBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()),
  topic: z.string().optional(),
  jurisdiction: z.string().optional(),
  riding: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
}).strict();

type RecordKind = 'plan' | 'capture' | 'review';
type IssueCode = 'invalid-input' | 'target-mismatch' | 'reviewer-not-independent' | 'reviewer-mismatch' | 'missing-language-outcome'
  | 'duplicate-case' | 'unexpected-case' | 'missing-case' | 'wrong-language' | 'wrong-outcome'
  | 'invalid-request-body' | 'request-hash-mismatch' | 'request-target-mismatch'
  | 'answer-hash-mismatch' | 'capture-hash-mismatch' | 'incomplete-answer-coverage' | 'missing-factual-claims' | 'refusal-contains-claims'
  | 'unsupported-claim' | 'missing-claim-evidence' | 'uncaptured-evidence';

interface EvidenceIssue {
  code: IssueCode;
  input?: RecordKind;
  caseId?: string;
  segment?: number;
  language?: z.infer<typeof language>;
  outcome?: z.infer<typeof outcome>;
}

function indexCases<T extends { id: string }>(cases: T[], input: RecordKind, issues: EvidenceIssue[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const entry of cases) {
    if (byId.has(entry.id)) issues.push({ code: 'duplicate-case', input, caseId: entry.id });
    byId.set(entry.id, entry);
  }
  return byId;
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Prepare a fixed suite for one provider/model without making a serving request. */
export async function prepareChatClaimPreregistration(identity: unknown, reviewer: unknown) {
  const servingTarget = target.parse(identity);
  const reviewerId = id.parse(reviewer);
  const cases = caseCatalog.parse(releaseCases);
  const issues: EvidenceIssue[] = [];
  indexCases(cases, 'plan', issues);
  checkCaseCoverage(cases, issues);
  if (issues.length > 0 || cases.some((entry) => detectLanguage(entry.prompt) !== entry.language)) {
    throw new Error('Invalid bilingual chat case catalog');
  }
  const requests = cases.map(({ prompt, ...entry }) => {
    const body = parseChatRequest({
      messages: [{ role: 'user', content: prompt }],
      provider: servingTarget.provider,
      model: servingTarget.model,
      maxTokens: 256,
    });
    return { ...entry, requestBody: JSON.stringify(body) };
  });
  const planned = await Promise.all(requests.map(async ({ id, language, outcome, requestBody }) => ({
    id, language, outcome, requestSha256: await sha256(requestBody),
  })));
  return {
    plan: plan.parse({ target: servingTarget, reviewerId, cases: planned }),
    requests,
  };
}

function checkCaseCoverage(cases: readonly { language: z.infer<typeof language>; outcome: z.infer<typeof outcome> }[], issues: EvidenceIssue[]) {
  const coverage = new Set(cases.map((entry) => `${entry.language}:${entry.outcome}`));
  for (const locale of language.options) {
    for (const expectedOutcome of outcome.options) {
      if (!coverage.has(`${locale}:${expectedOutcome}`)) {
        issues.push({ code: 'missing-language-outcome', input: 'plan', language: locale, outcome: expectedOutcome });
      }
    }
  }
}

/** Bind the exact request, answer and retrieved text to the serving target. */
export function hashChatClaimCapture(entry: z.infer<typeof capturedCase>, source: z.infer<typeof target>): Promise<string> {
  return sha256(JSON.stringify([
    [source.candidate, source.revision, source.provider, source.model],
    entry.id, entry.language, entry.requestBody, entry.answer, entry.retrieved.map((source) => [source.sourceUrl, source.text]),
  ]));
}

function validateCapturedRequest(body: string, expected: z.infer<typeof target>): IssueCode | undefined {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > MAX_REQUEST_BYTES || new TextDecoder().decode(bytes) !== body) return 'invalid-request-body';
  try {
    const request = parseChatRequest(chatBody.parse(JSON.parse(body)));
    const model = request.model ?? PROVIDERS[expected.provider].defaultModel;
    if ((request.provider && request.provider !== expected.provider) ||
      model !== expected.model) return 'request-target-mismatch';
  } catch {
    return 'invalid-request-body';
  }
}

/**
 * Check release evidence from a preregistered plan, an immutable capture,
 * and a separate human review. Evidence identity and coverage are mechanical
 * checks. Claim identification and factual support are the reviewer's judgment.
 */
export async function verifyChatClaimEvidence(expected: unknown, captured: unknown, reviewed: unknown): Promise<{
  ready: boolean;
  reviewedCases: number;
  supportedClaims: number;
  issues: EvidenceIssue[];
}> {
  const preregistered = plan.safeParse(expected);
  const observed = capture.safeParse(captured);
  const attested = review.safeParse(reviewed);
  const issues: EvidenceIssue[] = [];
  let reviewedCases = 0;
  let supportedClaims = 0;
  const result = () => ({ ready: issues.length === 0, reviewedCases, supportedClaims, issues });
  if (!preregistered.success) issues.push({ code: 'invalid-input', input: 'plan' });
  if (!observed.success) issues.push({ code: 'invalid-input', input: 'capture' });
  if (!attested.success) issues.push({ code: 'invalid-input', input: 'review' });
  if (!preregistered.success || !observed.success || !attested.success) return result();

  const source = preregistered.data.target;
  for (const [input, compared] of [['capture', observed.data.target], ['review', attested.data.target]] as const) {
    if (source.candidate !== compared.candidate || source.revision !== compared.revision ||
      source.provider !== compared.provider || source.model !== compared.model) issues.push({ code: 'target-mismatch', input });
  }
  if (observed.data.recorderId === attested.data.reviewerId) issues.push({ code: 'reviewer-not-independent', input: 'review' });
  if (preregistered.data.reviewerId !== attested.data.reviewerId) issues.push({ code: 'reviewer-mismatch', input: 'review' });
  const expectedCases = indexCases(preregistered.data.cases, 'plan', issues);
  const capturedCases = indexCases(observed.data.cases, 'capture', issues);
  const reviewedById = indexCases(attested.data.cases, 'review', issues);
  checkCaseCoverage(preregistered.data.cases, issues);
  for (const [input, actual] of [['capture', capturedCases], ['review', reviewedById]] as const) {
    for (const caseId of actual.keys()) if (!expectedCases.has(caseId)) issues.push({ code: 'unexpected-case', input, caseId });
    for (const caseId of expectedCases.keys()) if (!actual.has(caseId)) issues.push({ code: 'missing-case', input, caseId });
  }
  if (issues.length > 0) return result();

  for (const [caseId, registered] of expectedCases) {
    const actual = capturedCases.get(caseId)!;
    const grading = reviewedById.get(caseId)!;
    const caseStart = issues.length;
    if (actual.language !== registered.language) issues.push({ code: 'wrong-language', input: 'capture', caseId });
    if (grading.language !== registered.language) issues.push({ code: 'wrong-language', input: 'review', caseId });
    if (grading.outcome !== registered.outcome) issues.push({ code: 'wrong-outcome', input: 'review', caseId });
    const requestIssue = validateCapturedRequest(actual.requestBody, source);
    if (requestIssue) issues.push({ code: requestIssue, input: 'capture', caseId });
    if (await sha256(actual.requestBody) !== registered.requestSha256) issues.push({ code: 'request-hash-mismatch', caseId });
    if (await sha256(actual.answer) !== grading.answerSha256) issues.push({ code: 'answer-hash-mismatch', caseId });
    if (await hashChatClaimCapture(actual, observed.data.target) !== grading.captureSha256) issues.push({ code: 'capture-hash-mismatch', caseId });
    let offset = 0;
    for (const part of grading.segments) {
      if (!actual.answer.startsWith(part.text, offset)) {
        issues.push({ code: 'incomplete-answer-coverage', caseId });
        break;
      }
      offset += part.text.length;
    }
    if (issues.length === caseStart && offset !== actual.answer.length) issues.push({ code: 'incomplete-answer-coverage', caseId });
    if (issues.length !== caseStart) continue;

    const facts = grading.segments.filter((part) => part.kind === 'fact');
    if (registered.outcome === 'answer' && facts.length === 0) issues.push({ code: 'missing-factual-claims', caseId });
    if (registered.outcome === 'refusal' && facts.length > 0) issues.push({ code: 'refusal-contains-claims', caseId });
    for (const [index, part] of grading.segments.entries()) {
      if (part.kind !== 'fact') continue;
      if (part.verdict !== 'supported') issues.push({ code: 'unsupported-claim', caseId, segment: index + 1 });
      else if (part.evidence.length === 0) issues.push({ code: 'missing-claim-evidence', caseId, segment: index + 1 });
      else if (part.evidence.some((quote) => !actual.retrieved.some((source) =>
        source.sourceUrl === quote.sourceUrl && source.text.includes(quote.excerpt)))) {
        issues.push({ code: 'uncaptured-evidence', caseId, segment: index + 1 });
      }
    }
    if (caseStart === issues.length) {
      reviewedCases++;
      supportedClaims += facts.length;
    }
  }
  return result();
}
