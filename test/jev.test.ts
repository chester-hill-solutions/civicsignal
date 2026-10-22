import { describe, expect, it } from 'vitest';
import {
  ATOMIC_QUESTIONS,
  CANDIDATE_COUNT,
  decide,
  reorder,
  rankWithJev,
  type AuthorityFlags,
  type Candidate,
} from '../src/jev';

/**
 * The decision, and the client.
 *
 * The rule is what replaces a single threshold on a cosine score, so the tests
 * are the routing table that the measurement produced. Each case is a question
 * from the label set, with the values that Jev gave for it.
 */
function flags(overrides: Partial<AuthorityFlags> = {}): AuthorityFlags {
  return {
    needs_federal_statute: 0,
    needs_provincial: 0,
    needs_court_decision: 0,
    needs_foreign_law: 0,
    is_not_law: 0,
    asks_published_figure: 0,
    ...overrides,
  };
}

describe('the decision', () => {
  it('answers from the corpus when the question needs a federal statute', () => {
    expect(decide(flags({ needs_federal_statute: 0.94 }), 0.97)).toBe('answer');
  });

  it('routes a provincial question to the web arm', () => {
    // "What is the fine for speeding in Ontario?" Measured: provincial 0.83.
    expect(decide(flags({ needs_provincial: 0.83, needs_federal_statute: 0.15 }), 0.21)).toBe('web');
  });

  it('routes a question about a court decision to the web arm', () => {
    // "What did the Supreme Court hold in R v Gladue?" Measured: court 0.82.
    expect(decide(flags({ needs_court_decision: 0.82, needs_federal_statute: 0.38 }), 0.43)).toBe('web');
  });

  it('refuses a question about a published figure, even though the law is federal', () => {
    // "How much is the Canada Child Benefit?" Measured: federal 0.67, figure 0.86.
    expect(
      decide(flags({ needs_federal_statute: 0.67, asks_published_figure: 0.86 }), 0.38),
    ).toBe('refuse');
  });

  it('refuses a question about foreign law', () => {
    expect(decide(flags({ needs_foreign_law: 0.71 }), 0.04)).toBe('refuse');
  });

  it('refuses a question that is not about law', () => {
    // "What is the weather in Ottawa tomorrow?" Measured: not law 0.88.
    expect(decide(flags({ is_not_law: 0.88 }), 0.09)).toBe('refuse');
  });

  /**
   * The case that the single score could not decide.
   *
   * For Quebec tenancy the corpus does hold a federal tenancy regulation, so
   * "at least one provision states the rule" is high and correct. The authority
   * answer is what separates it: the rule is provincial.
   */
  it('refuses a question whose relevance is high but whose authority is wrong', () => {
    expect(decide(flags({ needs_provincial: 0.70, needs_federal_statute: 0.33 }), 0.66)).toBe('web');
  });

  it('refuses when the authority is right and the relevance is low', () => {
    expect(decide(flags({ needs_federal_statute: 0.90 }), 0.2)).toBe('refuse');
  });

  it('refuses when no authority question is confident', () => {
    expect(decide(flags(), 0.99)).toBe('refuse');
  });
});

describe('the client', () => {
  const candidates: Candidate[] = [
    { id: 'a-1', title: 'Access to Information Act, section 1', text: 'one' },
    { id: 'a-2', title: 'Access to Information Act, section 2', text: 'two' },
  ];

  function answer(answers: Record<string, { noul: number }>): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ model: 'jev-1.13', answers }), { status: 200 })) as typeof fetch;
  }

  it('asks one question for each candidate, and the six, and any_relevant', async () => {
    let sent: { state: string; questions: Record<string, unknown> } | undefined;
    const send = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as typeof sent;
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    await rankWithJev('a question', candidates, { key: 'k', send });

    const names = Object.keys(sent!.questions!);
    expect(names).toHaveLength(candidates.length + Object.keys(ATOMIC_QUESTIONS).length + 1);
    expect(names).toContain('c0');
    expect(names).toContain('c1');
    expect(names).toContain('any_relevant');
    expect(names).toContain('needs_federal_statute');
    expect(sent!.state).toContain('question: a question');
    // One state, one call: the whole decision is a single request.
    expect(sent!.state).toContain('c0:');
  });

  it('returns null when the gateway refuses, so the caller can fall back', async () => {
    const send = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    expect(await rankWithJev('a question', candidates, { key: 'k', send })).toBeNull();
  });

  it('returns null when the call throws', async () => {
    const send = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await rankWithJev('a question', candidates, { key: 'k', send })).toBeNull();
  });

  it('reads the relevance and the flags', async () => {
    const send = answer({
      c0: { noul: 0.9 },
      c1: { noul: 0.1 },
      any_relevant: { noul: 0.95 },
      needs_federal_statute: { noul: 0.93 },
    });
    const result = await rankWithJev('a question', candidates, { key: 'k', send });

    expect(result?.relevance).toEqual([0.9, 0.1]);
    expect(result?.anyRelevant).toBe(0.95);
    expect(result?.flags.needs_federal_statute).toBe(0.93);
    // A question the gateway did not answer is zero, which is the safe value.
    expect(result?.flags.needs_provincial).toBe(0);
  });

  it('does not call the gateway with no candidates', async () => {
    let called = false;
    const send = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await rankWithJev('a question', [], { key: 'k', send })).toBeNull();
    expect(called).toBe(false);
  });
});

describe('the order that Jev puts the candidates in', () => {
  it('sorts by the relevance', () => {
    expect(reorder(['a', 'b', 'c'], [0.1, 0.9, 0.5])).toEqual(['b', 'c', 'a']);
  });

  it('keeps the cosine order for an equal score', () => {
    expect(reorder(['a', 'b', 'c'], [0.5, 0.5, 0.5])).toEqual(['a', 'b', 'c']);
  });
});

describe('the constants', () => {
  it('uses the candidate count that the measurement used', () => {
    expect(CANDIDATE_COUNT).toBe(250);
  });
});
