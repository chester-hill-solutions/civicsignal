import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, type ByokProvider } from '../src/byok';
import { prepareChatClaimPreregistration, verifyChatClaimEvidence } from '../src/eval/chat-claim-evidence';

const sourceUrl = 'https://example.invalid/test-act/1';
const enExcerpt = 'The test provision states rule A.';
const frExcerpt = 'La disposition de test énonce la règle A.';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function captureDigest(
  entry: { id: string; language: string; requestBody: string; answer: string; retrieved: { sourceUrl: string; text: string }[] },
  target: { candidate: string; revision: string; provider: string; model: string },
) {
  return digest(JSON.stringify([
    [target.candidate, target.revision, target.provider, target.model],
    entry.id, entry.language, entry.requestBody, entry.answer, entry.retrieved.map((source) => [source.sourceUrl, source.text]),
  ]));
}
type Fact = {
  kind: 'fact';
  text: string;
  verdict: 'supported' | 'unsupported' | 'partial' | 'uncertain';
  evidence: { sourceUrl: string; excerpt: string }[];
};
type Segment = Fact | { kind: 'non-factual'; text: string };

function fixture(provider: ByokProvider = 'opencode-zen') {
  const identity = { candidate: 'a'.repeat(40), revision: 'b'.repeat(40), provider, model: PROVIDERS[provider].defaultModel };
  const cases = [
    { id: 'answer-en', language: 'en', outcome: 'answer', answer: 'Rule A applies. [Source](' + sourceUrl + ')', excerpt: enExcerpt, claim: 'Rule A applies.' },
    { id: 'answer-fr', language: 'fr', outcome: 'answer', answer: 'La règle A s’applique. [Source](' + sourceUrl + ')', excerpt: frExcerpt, claim: 'La règle A s’applique.' },
    { id: 'refusal-en', language: 'en', outcome: 'refusal', answer: 'There is not enough evidence to answer.' },
    { id: 'refusal-fr', language: 'fr', outcome: 'refusal', answer: 'Les sources sont insuffisantes pour répondre.' },
  ];
  const capture = { target: { ...identity }, recorderId: 'operator', cases: cases.map(({ id, language, answer, excerpt }) => ({
    id, language, answer, requestBody: JSON.stringify({ messages: [{ role: 'user', content: 'Case ' + id }] }),
    retrieved: excerpt ? [{ sourceUrl, text: excerpt }] : [],
  })) };
  const plan = { target: { ...identity }, reviewerId: 'reviewer', cases: cases.map(({ id, language, outcome }, index) => ({
    id, language, outcome, requestSha256: digest(capture.cases[index]!.requestBody),
  })) };
  const review = { target: { ...identity }, reviewerId: 'reviewer', cases: cases.map(({ id, language, outcome, answer, excerpt, claim }, index) => {
    const segments: Segment[] = claim && excerpt
      ? [{ kind: 'fact', text: claim, verdict: 'supported', evidence: [{ sourceUrl, excerpt }] },
        { kind: 'non-factual', text: answer.slice(claim.length) }]
      : [{ kind: 'non-factual', text: answer }];
    return { id, language, outcome, answerSha256: digest(answer), captureSha256: captureDigest(capture.cases[index]!, capture.target),
      coverageAttested: true, segments };
  }) };
  return { plan, capture, review, check: () => verifyChatClaimEvidence(plan, capture, review) };
}

describe('chat claim preregistration', () => {
  it('emits exact reproducible request bytes and binds them, the candidate and the reviewer', async () => {
    const { target } = fixture().plan;
    const packet = await prepareChatClaimPreregistration(target, 'independent-reviewer');
    expect(packet).toEqual(await prepareChatClaimPreregistration(target, 'independent-reviewer'));
    expect(packet.plan.target).toEqual(target);
    expect(packet.plan.reviewerId).toBe('independent-reviewer');
    expect(new Set(packet.requests.map(({ language, outcome }) => `${language}:${outcome}`))).toEqual(
      new Set(['en:answer', 'fr:answer', 'en:refusal', 'fr:refusal']),
    );
    expect(packet.plan.cases).toEqual(packet.requests.map(({ id, language, outcome, requestBody }) => ({
      id, language, outcome, requestSha256: digest(requestBody),
    })));
    for (const request of packet.requests) {
      const body = JSON.parse(request.requestBody);
      expect(Object.keys(body)).toEqual(['messages', 'provider', 'model', 'maxTokens']);
      expect(body).toMatchObject({ messages: [{ role: 'user', content: expect.any(String) }],
        provider: target.provider, model: target.model, maxTokens: 256 });
      expect(body.messages).toHaveLength(1);
    }
  });

  it('requires an exact target, allowed model and named reviewer', async () => {
    const { target } = fixture().plan;
    await expect(prepareChatClaimPreregistration({ ...target, revision: 'main' }, 'reviewer')).rejects.toThrow();
    await expect(prepareChatClaimPreregistration({ ...target, model: 'different-model' }, 'reviewer')).rejects.toThrow();
    await expect(prepareChatClaimPreregistration(target, undefined)).rejects.toThrow();
  });
});

describe('chat claim release evidence', () => {
  it('binds separate English and French answer and refusal cases to the graded capture', async () => {
    expect(await fixture().check()).toEqual({ ready: true, reviewedCases: 4, supportedClaims: 2, issues: [] });
  });

  it.each(['plan', 'capture', 'review'] as const)('rejects duplicate %s cases', async input => {
    const f = fixture();
    const entries: { id: string }[] = f[input].cases;
    entries.push(entries[0]!);
    expect((await f.check()).issues).toContainEqual({ code: 'duplicate-case', input, caseId: 'answer-en' });
  });

  it('rejects missing and unexpected IDs without replacing the preregistered coverage', async () => {
    const f = fixture();
    f.capture.cases[0]!.id = 'unregistered';
    f.review.cases.pop();
    expect((await f.check()).issues).toEqual(expect.arrayContaining([
      { code: 'unexpected-case', input: 'capture', caseId: 'unregistered' },
      { code: 'missing-case', input: 'capture', caseId: 'answer-en' },
      { code: 'missing-case', input: 'review', caseId: 'refusal-fr' },
    ]));
  });

  it('requires separate answer and refusal cases for both official languages', async () => {
    const f = fixture();
    f.plan.cases.pop();
    f.capture.cases.pop();
    f.review.cases.pop();
    expect((await f.check()).issues).toEqual([
      { code: 'missing-language-outcome', input: 'plan', language: 'fr', outcome: 'refusal' },
    ]);
  });

  it('rejects a different candidate, revision or self-review', async () => {
    const f = fixture();
    f.capture.target.candidate = 'c'.repeat(40);
    f.review.target.revision = 'd'.repeat(40);
    f.review.reviewerId = f.capture.recorderId;
    f.plan.reviewerId = f.capture.recorderId;
    expect((await f.check()).issues).toEqual([
      { code: 'target-mismatch', input: 'capture' },
      { code: 'target-mismatch', input: 'review' },
      { code: 'reviewer-not-independent', input: 'review' },
    ]);
  });

  it('rejects an independent reviewer substituted after preregistration', async () => {
    const f = fixture();
    f.review.reviewerId = 'different-reviewer';
    expect((await f.check()).issues).toEqual([{ code: 'reviewer-mismatch', input: 'review' }]);
  });

  it('binds verdicts to the preregistered provider and model', async () => {
    const f = fixture('openai');
    f.capture.target.provider = 'anthropic';
    f.review.target.model = 'different-model';
    expect((await f.check()).issues).toEqual([
      { code: 'target-mismatch', input: 'capture' },
      { code: 'target-mismatch', input: 'review' },
    ]);
  });

  it('rejects an unsupported explicit model for the OpenCode Zen target', async () => {
    const f = fixture();
    for (const data of [f.plan, f.capture, f.review]) data.target.model = 'different-model';
    expect((await f.check()).issues).toEqual([
      { code: 'invalid-input', input: 'plan' },
      { code: 'invalid-input', input: 'capture' },
      { code: 'invalid-input', input: 'review' },
    ]);
  });

  it('requires the actual default model when the request omits its model', async () => {
    const f = fixture('openai');
    for (const data of [f.plan, f.capture, f.review]) data.target.model = 'admissible-nondefault-model';
    for (const [index, entry] of f.capture.cases.entries()) f.review.cases[index]!.captureSha256 = captureDigest(entry, f.capture.target);
    expect((await f.check()).issues).toEqual(f.plan.cases.map(({ id }) => ({
      code: 'request-target-mismatch', input: 'capture', caseId: id,
    })));
  });

  it('requires fresh review when all three artifacts relabel the same captured cases', async () => {
    const f = fixture();
    for (const data of [f.plan, f.capture, f.review]) data.target.revision = 'd'.repeat(40);
    expect((await f.check()).issues).toEqual(f.plan.cases.map(({ id }) => ({
      code: 'capture-hash-mismatch', caseId: id,
    })));
  });

  it('rejects a different prompt under the same case ID even when the capture digest matches', async () => {
    const f = fixture();
    const entry = f.capture.cases[0]!;
    entry.requestBody = JSON.stringify({ messages: [{ role: 'user', content: 'A substituted question' }] });
    f.review.cases[0]!.captureSha256 = captureDigest(entry, f.capture.target);
    expect((await f.check()).issues).toEqual([{ code: 'request-hash-mismatch', caseId: 'answer-en' }]);
  });

  it('binds the review to the exact captured request bytes as well as the preregistered hash', async () => {
    const f = fixture();
    const entry = f.capture.cases[0]!;
    entry.requestBody += ' ';
    f.plan.cases[0]!.requestSha256 = digest(entry.requestBody);
    expect((await f.check()).issues).toEqual([{ code: 'capture-hash-mismatch', caseId: 'answer-en' }]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an unsupported body field', JSON.stringify({ messages: [{ role: 'user', content: 'test' }], apiKey: 'synthetic-secret' })],
    ['an extra field in a message', JSON.stringify({ messages: [{ role: 'user', content: 'test', apiKey: 'synthetic-secret' }] })],
    ['an invalid runtime request', JSON.stringify({ messages: [{ role: 'assistant', content: 'test' }] })],
  ])('rejects %s in the captured request without exposing request values', async (_, requestBody) => {
    const f = fixture();
    const entry = f.capture.cases[0]!;
    entry.requestBody = requestBody;
    f.plan.cases[0]!.requestSha256 = digest(requestBody);
    f.review.cases[0]!.captureSha256 = captureDigest(entry, f.capture.target);
    const result = await f.check();
    expect(result.issues).toEqual([{ code: 'invalid-request-body', input: 'capture', caseId: 'answer-en' }]);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('rejects request body settings that disagree with the registered provider or model', async () => {
    const f = fixture();
    const entry = f.capture.cases[0]!;
    entry.requestBody = JSON.stringify({ messages: [{ role: 'user', content: 'test' }], provider: 'openai' });
    f.plan.cases[0]!.requestSha256 = digest(entry.requestBody);
    f.review.cases[0]!.captureSha256 = captureDigest(entry, f.capture.target);
    expect((await f.check()).issues).toEqual([{ code: 'request-target-mismatch', input: 'capture', caseId: 'answer-en' }]);
  });

  it('checks capture language, reviewed language and reviewed disposition', async () => {
    const f = fixture();
    f.capture.cases[0]!.language = 'fr';
    f.review.cases[0]!.captureSha256 = captureDigest(f.capture.cases[0]!, f.capture.target);
    f.review.cases[1]!.language = 'en';
    f.review.cases[3]!.outcome = 'answer';
    expect((await f.check()).issues).toEqual([
      { code: 'wrong-language', input: 'capture', caseId: 'answer-en' },
      { code: 'wrong-language', input: 'review', caseId: 'answer-fr' },
      { code: 'wrong-outcome', input: 'review', caseId: 'refusal-fr' },
    ]);
  });

  it('fails if the reviewed answer bytes differ or the reviewed spans omit text', async () => {
    const f = fixture();
    f.capture.cases[0]!.answer = 'The original English answer changed.';
    f.review.cases[1]!.segments.pop();
    expect((await f.check()).issues).toEqual([
      { code: 'answer-hash-mismatch', caseId: 'answer-en' },
      { code: 'capture-hash-mismatch', caseId: 'answer-en' },
      { code: 'incomplete-answer-coverage', caseId: 'answer-en' },
      { code: 'incomplete-answer-coverage', caseId: 'answer-fr' },
    ]);
  });

  it('rejects a changed source context even if the reviewed excerpt still matches', async () => {
    const f = fixture();
    f.capture.cases[0]!.retrieved[0]!.text = enExcerpt + ' The exceptions changed.';
    expect((await f.check()).issues).toEqual([{ code: 'capture-hash-mismatch', caseId: 'answer-en' }]);
  });

  it('requires an explicit coverage attestation and a factual claim inventory', async () => {
    const absent = fixture();
    absent.review.cases[0]!.coverageAttested = false;
    expect((await absent.check()).issues).toEqual([{ code: 'invalid-input', input: 'review' }]);
    const empty = fixture();
    empty.review.cases[0]!.segments = [{ kind: 'non-factual', text: empty.capture.cases[0]!.answer }];
    expect((await empty.check()).issues).toEqual([{ code: 'missing-factual-claims', caseId: 'answer-en' }]);
  });

  it.each(['unsupported', 'partial', 'uncertain'] as const)('rejects a claim graded %s', async verdict => {
    const f = fixture();
    (f.review.cases[0]!.segments[0] as Fact).verdict = verdict;
    expect((await f.check()).issues).toEqual([{ code: 'unsupported-claim', caseId: 'answer-en', segment: 1 }]);
  });

  it('rejects a supported grade with no excerpt, an invented excerpt or an invented source', async () => {
    const f = fixture();
    (f.review.cases[0]!.segments[0] as Fact).evidence = [];
    (f.review.cases[1]!.segments[0] as Fact).evidence = [{ sourceUrl, excerpt: 'Texte inventé.' }];
    expect((await f.check()).issues).toEqual([
      { code: 'missing-claim-evidence', caseId: 'answer-en', segment: 1 },
      { code: 'uncaptured-evidence', caseId: 'answer-fr', segment: 1 },
    ]);
    (f.review.cases[0]!.segments[0] as Fact).evidence = [{ sourceUrl: 'https://example.invalid/invented-act', excerpt: enExcerpt }];
    expect((await f.check()).issues).toContainEqual({ code: 'uncaptured-evidence', caseId: 'answer-en', segment: 1 });
  });

  it('rejects a refusal with a substantive assertion even when its cited excerpt exists', async () => {
    const f = fixture();
    const entry = f.capture.cases[2]!;
    entry.retrieved = [{ sourceUrl, text: enExcerpt }];
    f.review.cases[2]!.captureSha256 = captureDigest(entry, f.capture.target);
    f.review.cases[2]!.segments = [{
      kind: 'fact', text: entry.answer, verdict: 'supported', evidence: [{ sourceUrl, excerpt: enExcerpt }],
    }];
    expect((await f.check()).issues).toEqual([{ code: 'refusal-contains-claims', caseId: 'refusal-en' }]);
  });
});
