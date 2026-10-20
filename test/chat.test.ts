import { describe, expect, it } from 'vitest';
import {
  buildContextBlock,
  buildSystemPrompt,
  citedItemsFromBrief,
  parseChatRequest,
  parseMatchRequest,
  PROVIDERS,
  type CitedItem,
} from '../src/routes/chat';
import type { BriefResponse } from '../src/routes/brief';

/**
 * The chat surface's licence discipline.
 *
 * The rule under test: what a model is allowed to see is decided by the licence
 * gate *before* the prompt is built, and the instruction the model gets about each
 * corpus follows from that regime. A summary of Crown-copyright debate is a
 * derivative of it, so a cite-only corpus must be quotable and nothing more.
 */

function brief(): BriefResponse {
  return {
    topic: 'housing',
    generatedAt: '2026-10-20T00:00:00Z',
    scope: { type: 'topic' },
    jurisdiction: null,
    riding: null,
    window: { since: null, until: null },
    legislation: [
      {
        corpusId: 'statutes-canada',
        kind: 'statute',
        id: 's1',
        title: 'Canada Labour Code s.210',
        body: 'The full text of an openly-licensed provision.',
        citationUrl: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
        source: 'Government of Canada',
        redistribution: 'open',
        attribution: 'Source: Justice Laws Website.',
      },
    ],
    debate: [
      {
        corpusId: 'hansard-federal',
        kind: 'debate',
        id: 'h1',
        title: 'Debate on housing',
        excerpt: 'We must build more homes.',
        citationUrl: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-1/hansard',
        source: 'House of Commons of Canada',
        publishedAt: '2026-05-04T00:00:00Z',
        redistribution: 'cite-only',
        attribution: 'Source: Debates (Hansard).',
      },
    ],
    bills: [],
    news: [
      {
        corpusId: 'news-canada',
        kind: 'news',
        id: 'n1',
        title: 'City announces housing plan',
        citationUrl: 'https://example.invalid/n1',
        source: 'Some Outlet',
        publishedAt: '2026-05-05T00:00:00Z',
        redistribution: 'metadata-only',
        attribution: 'Source: the originating publisher.',
      },
    ],
    sentiment: { series: [], mean: null, volume: 0, note: '' },
    citation: null,
    spread: { byJurisdiction: [], byRiding: [], coverage: { attributed: 0, total: 0 }, note: '' },
    coverage: [],
    attribution: [],
  };
}

describe('cited items', () => {
  it('takes the body for an open corpus and the excerpt for a cite-only one', () => {
    const cited = citedItemsFromBrief(brief());
    const statute = cited.find((c) => c.corpusId === 'statutes-canada')!;
    const debate = cited.find((c) => c.corpusId === 'hansard-federal')!;
    const news = cited.find((c) => c.corpusId === 'news-canada')!;
    expect(statute.text).toContain('full text');
    expect(debate.text).toBe('We must build more homes.');
    expect(news.text).toBe('');
  });
});

describe('the context block', () => {
  it('tells the model to summarise an open corpus and to quote a cite-only one', () => {
    const block = buildContextBlock(citedItemsFromBrief(brief()));
    expect(block).toContain('You may summarise, explain and analyse it');
    expect(block).toContain('may only be quoted, not reproduced');
    expect(block).toContain('Do not paraphrase');
  });

  it('gives a metadata-only corpus no text at all, even if some slipped through', () => {
    // Defence in depth: the gate should have stripped the body already, and the
    // context builder refuses to include one either way.
    const leaky: CitedItem = {
      corpusId: 'news-canada',
      title: 'City announces housing plan',
      text: 'THE ARTICLE TEXT, WHICH MUST NOT APPEAR',
      citationUrl: 'https://example.invalid/n1',
      source: 'Some Outlet',
      redistribution: 'metadata-only',
    };
    const block = buildContextBlock([leaky]);
    expect(block).toContain('title and link only');
    expect(block).not.toContain('THE ARTICLE TEXT');
  });

  it('includes a citation link for every item', () => {
    const block = buildContextBlock(citedItemsFromBrief(brief()));
    expect(block).toContain('https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html');
    expect(block).toContain('https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-1/hansard');
    expect(block).toContain('https://example.invalid/n1');
  });

  it('says so when nothing was retrieved', () => {
    expect(buildContextBlock([])).toContain('No material was retrieved');
  });
});

describe('the system prompt', () => {
  it('tells the model it is a reader of retrieved material, not a source of it', () => {
    const prompt = buildSystemPrompt(citedItemsFromBrief(brief()));
    expect(prompt).toContain('Answer only from the retrieved material');
    expect(prompt).toContain('Every statement must be traceable');
    expect(prompt).toContain('not ranked for relevance');
  });
});

describe('request parsing', () => {
  it('reads the messages, the topic and the provider', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'user', content: 'What does section 210 say?' },
        { role: 'assistant', content: 'It says…' },
        { role: 'user', content: 'More?' },
      ],
      topic: 'housing',
      provider: 'openai',
      model: 'gpt-4.1',
    });
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1]?.role).toBe('assistant');
    expect(parsed.topic).toBe('housing');
    expect(parsed.provider).toBe('openai');
  });

  it('ignores a malformed message rather than passing it to a model', () => {
    const parsed = parseChatRequest({ messages: [{ role: 'user' }, 'nope', { content: 'ok' }] });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe('user');
  });

  it('reads a match request', () => {
    const parsed = parseMatchRequest({ vector: [0.1, 0.2], corpus: 'statutes-canada', topK: 5 });
    expect(parsed.vector).toEqual([0.1, 0.2]);
    expect(parsed.corpus).toBe('statutes-canada');
    expect(parsed.topK).toBe(5);
  });

  it('reads an empty match request as no vector', () => {
    expect(parseMatchRequest({}).vector).toEqual([]);
  });
});

describe('the providers', () => {
  it('each carry a default model, an endpoint and a parser', () => {
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      expect(spec.defaultModel.length).toBeGreaterThan(0);
      expect(spec.endpoint(spec.defaultModel)).toMatch(/^https:\/\//);
      expect(spec.parse({})).toBe('');
      expect(spec.headers('secret-key')).toBeTruthy();
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('parses an Anthropic response', () => {
    const answer = PROVIDERS.anthropic.parse({
      content: [
        { type: 'text', text: 'First.' },
        { type: 'tool_use' },
        { type: 'text', text: 'Second.' },
      ],
    });
    expect(answer).toBe('First.\nSecond.');
  });

  it('parses an OpenAI response', () => {
    expect(PROVIDERS.openai.parse({ choices: [{ message: { content: 'Hello.' } }] })).toBe('Hello.');
  });

  it('parses a Google response', () => {
    const answer = PROVIDERS.google.parse({
      candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world.' }] } }],
    });
    expect(answer).toBe('Hello world.');
  });
});
