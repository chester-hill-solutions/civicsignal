import { afterEach, describe, expect, it } from 'vitest';
import { buildBrief } from '../src/routes/brief';
import { ALL_CORPUSES, CORPUSES, loadCorpusAvailability, UnsupportedCoverageError } from '../src/corpora/registry';
import { buildCapabilities, capabilitiesResponse, llmsTxt } from '../src/routes/capabilities';
import { sqliteCorpus } from './helpers/sqlite-corpus';
import type { CorpusContext } from '../src/corpora/types';
import type { Env } from '../src/types';

const open: ReturnType<typeof sqliteCorpus>[] = [];
afterEach(() => { for (const fixture of open.splice(0)) fixture.close(); });

function fixture(populated = true) {
  const fixture = sqliteCorpus();
  open.push(fixture);
  if (populated) fixture.sqlite.prepare(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at) VALUES ('statutes-canada', 'revision-1', '2026-10-20', '2026-10-20', 2, '2026-10-22T00:00:00Z')`).run();
  const ctx: CorpusContext = { db: fixture.db, fetch, now: () => new Date('2026-10-22'), vector: { async query() { return []; } }, embedQuery: async () => [0.1] };
  return { ...fixture, ctx };
}

describe('truthful v1 coverage', () => {
  it('retains future adapters but enables only the implemented federal ingestion', () => {
    expect(CORPUSES.map((corpus) => corpus.id)).toEqual(['statutes-canada']);
    expect(ALL_CORPUSES.map((corpus) => corpus.id)).toEqual(expect.arrayContaining(['hansard-federal', 'news-canada', 'gdelt', 'bills-canada']));
  });

  it('distinguishes a queried empty corpus from missing ingestion and requested exclusions', async () => {
    const { ctx } = fixture();
    const brief = await buildBrief({ topic: 'housing', exclude: ['bills'] }, ctx);
    expect(brief.coverage.find((entry) => entry.corpusId === 'statutes-canada')).toMatchObject({ status: 'no-results', count: 0 });
    expect(brief.coverage.find((entry) => entry.corpusId === 'news-canada')).toMatchObject({ status: 'unavailable', count: 0 });
    expect(brief.coverage.find((entry) => entry.corpusId === 'bills-canada')).toMatchObject({ status: 'excluded', count: 0 });
    expect(brief.spread.note).toContain('unavailable in v1');
    expect(brief.sentiment.note).toContain('unavailable in v1');
  });

  it('marks an unpublished or disconnected corpus unavailable, rather than no-results', async () => {
    const { ctx } = fixture(false);
    const unpublished = await buildBrief({ topic: 'housing' }, ctx);
    expect(unpublished.coverage.find((entry) => entry.corpusId === 'statutes-canada')?.status).toBe('unavailable');
    expect((await loadCorpusAvailability({ fetch, now: () => new Date() }))['statutes-canada']).toMatchObject({ available: false });
    ctx.db = { prepare() { throw new Error('offline'); } };
    expect((await loadCorpusAvailability(ctx))['statutes-canada'].reason).toContain('could not be read');
  });

  it('resolves the requested official language once, including repealed provisions, without an embedder', async () => {
    const { ctx, sqlite, statements } = fixture();
    const insert = sqlite.prepare(`INSERT INTO statute_sections
      (id, corpus_id, act, section, text, source_url, jurisdiction, in_force, search_text, citation, language, status)
      VALUES (?, 'statutes-canada', 'Competition Act', '36', ?, 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html', 'CA', ?, '', 'C-34', ?, ?)`);
    insert.run('en', 'English text.', 1, 'en', 'in-force');
    insert.run('fr', 'Texte français abrogé.', 0, 'fr', 'repealed');
    delete ctx.embedQuery;
    delete ctx.vector;
    const brief = await buildBrief({ topic: 'Competition Act s.36', language: 'fr', citation: { act: 'Competition Act', section: '36' } }, ctx);
    expect(brief.citation).toMatchObject({ resolved: true, status: 'repealed', item: { id: 'fr', language: 'fr' } });
    expect(brief.legislation.map((item) => item.id)).toEqual(['fr']);
    expect(brief.coverage.find((entry) => entry.corpusId === 'statutes-canada')?.status).toBe('supported');
    expect(statements.filter((sql) => sql.includes('FROM statute_sections'))).toHaveLength(1);
  });

  it.each([
    { jurisdiction: 'ON' }, { riding: '35047' }, { scope: { type: 'riding' as const, code: '35047' } },
    { scope: { type: 'municipality' as const, name: 'Ottawa' } }, { scope: { type: 'region' as const, name: 'GTA' } },
    { since: '2026-01-01' },
  ])('rejects an unsupported filter before reading or billing retrieval: %j', async (request) => {
    const { ctx, statements } = fixture();
    await expect(buildBrief({ topic: 'housing', ...request }, ctx)).rejects.toBeInstanceOf(UnsupportedCoverageError);
    expect(statements).toHaveLength(0);
  });
});

describe('machine-readable discovery', () => {
  it('advertises only verified populated coverage and usable v1 tools', async () => {
    const { ctx } = fixture();
    const env = { CIVIC_DB: ctx.db, VECTORIZE: {}, ENCODER_SERVICE: {}, ENCODER_TOKEN: 'configured' } as Env;
    const capabilities = buildCapabilities(env, 'https://api.example', await loadCorpusAvailability(ctx));
    expect(capabilities.coverage.map((entry) => entry.corpusId)).toEqual(['statutes-canada']);
    expect(capabilities.coverage[0]).toMatchObject({ rowCount: 2, revision: 'revision-1', lastRunAt: '2026-10-22T00:00:00Z' });
    expect(capabilities.unavailableCoverage.map((entry) => entry.corpusId)).toEqual(expect.arrayContaining(['statutes-ontario', 'news-canada', 'hansard-federal', 'bills-canada']));
    expect(capabilities.mcp.tools.map((tool) => tool.name).sort()).toEqual(['brief_topic', 'cite_provision', 'statute_changes', 'statute_lookup']);
    expect(capabilities.endpoints.map((endpoint) => endpoint.path)).not.toContain('/api/news');
    expect(capabilities.auth.oauth).toContain('not exposed');
    expect(capabilities.auth.browserKeys).toContain('not accepted');
    expect(capabilities.scopes[0]?.values).toEqual(['topic', 'jurisdiction:CA']);
  });

  it('does not advertise ready corpora or retrieval tools when only bindings exist', async () => {
    const { ctx } = fixture(false);
    const capabilities = buildCapabilities({ CIVIC_DB: ctx.db } as Env, 'https://api.example', await loadCorpusAvailability(ctx));
    expect(capabilities.coverage).toEqual([]);
    expect(capabilities.endpoints).toEqual([]);
    expect(capabilities.mcp.tools).toEqual([]);
    const response = await capabilitiesResponse({} as Env, 'https://api.example', 'request-1');
    expect((await response.json() as { coverage: unknown[] }).coverage).toEqual([]);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('does not publish nonexistent documentation, OAuth or unsupported endpoints in llms.txt', () => {
    const content = llmsTxt({} as Env, 'https://api.example');
    expect(content).not.toContain('/api/news');
    expect(content).not.toContain('/auth.md');
    expect(content).not.toContain('/docs');
    expect(content).toContain('unavailable in v1');
    expect(content).toContain('live capabilities');
  });
});
