import { afterEach, describe, expect, it } from 'vitest';
import { parseChangesQuery, readStatuteChanges, validateChangesRequest } from '../src/routes/changes';
import { RequestInputError } from '../src/http';
import { UnsupportedCoverageError } from '../src/corpora/registry';
import { sqliteCorpus } from './helpers/sqlite-corpus';
import type { CorpusContext } from '../src/corpora/types';

const open: ReturnType<typeof sqliteCorpus>[] = [];
afterEach(() => { for (const fixture of open.splice(0)) fixture.close(); });

function fixture() {
  const fixture = sqliteCorpus();
  open.push(fixture);
  const insert = fixture.sqlite.prepare(`INSERT INTO corpus_changes (id, corpus_id, change, row_id,
    instrument, citation, section, heading, status, summary, source_url, occurred_at, recorded_at)
    VALUES (?, 'statutes-canada', ?, ?, 'Competition Act', 'C-34', '36', 'Recovery of damages',
    'in-force', 'SECRET FULL TEXT MUST NOT BE EMITTED', ?, ?, '2026-03-03T00:00:00Z')`);
  insert.run(7, 'removed', 'gone', 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html', '2026-03-02');
  insert.run(2, 'added', 'new', 'javascript:alert(1)', '2026-02-28');
  insert.run(5, 'changed', 'updated', 'https://laws-lois.justice.gc.ca/en/acts/C-34/section-36.html', '2026-03-01T14:30:00Z');
  const ctx: CorpusContext = { db: fixture.db, fetch, now: () => new Date('2026-03-03') };
  return { ...fixture, ctx };
}

describe('statute change feed', () => {
  it('paginates actual SQLite rows in stable ingestion-event order without leaking text', async () => {
    const { ctx, statements } = fixture();
    const first = await readStatuteChanges({ limit: 2 }, ctx);
    expect(first.items.map((item) => item.id)).toEqual([2, 5]);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfter).toBe(5);
    expect(first.items[0]?.sourceUrl).toBeNull();
    expect(first.items[1]?.sourceUrl).toContain('laws-lois.justice.gc.ca');
    expect(first.provenance.attribution).toContain('Government of Canada');
    expect(first.provenance.note).toContain('do not establish');
    expect(JSON.stringify(first)).not.toContain('SECRET FULL TEXT');
    expect(statements[0]).not.toMatch(/summary|SELECT \*/i);
    const next = await readStatuteChanges({ after: first.nextAfter, limit: 2 }, ctx);
    expect(next.items.map((item) => item.id)).toEqual([7]);
    expect(next.hasMore).toBe(false);
    expect(next.nextAfter).toBe(7);
  });

  it('includes the full calendar day and respects exact UTC timestamps and change kind', async () => {
    const { ctx } = fixture();
    expect((await readStatuteChanges({ since: '2026-03-01', until: '2026-03-01' }, ctx)).items.map((item) => item.id)).toEqual([5]);
    expect((await readStatuteChanges({ until: '2026-03-01T14:30:00Z', change: 'changed' }, ctx)).items.map((item) => item.id)).toEqual([5]);
    expect((await readStatuteChanges({ until: '2026-03-01T14:29:59Z' }, ctx)).items.map((item) => item.id)).toEqual([2]);
  });

  it('makes an exhausted feed explicit without resetting the cursor', async () => {
    const { ctx } = fixture();
    expect(await readStatuteChanges({ after: 7 }, ctx)).toMatchObject({ items: [], count: 0, after: 7, nextAfter: 7, hasMore: false });
  });

  it('distinguishes an absent store from a valid empty feed', async () => {
    await expect(readStatuteChanges({}, { fetch, now: () => new Date() })).rejects.toBeInstanceOf(UnsupportedCoverageError);
    const { ctx } = fixture();
    ctx.db = { prepare() { throw new Error('database offline'); } };
    await expect(readStatuteChanges({}, ctx)).rejects.toThrow('database offline');
  });

  it.each([
    { after: -1 }, { after: 1.5 }, { after: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: Infinity }, { limit: 1.5 },
    { since: '2026-02-30' }, { until: '2026-13-01' }, { since: '2026-03-01T99:00:00Z' },
    { since: '2026-03-02', until: '2026-03-01' },
  ])('rejects invalid bounds before touching the database: %j', async (request) => {
    const { ctx, statements } = fixture();
    await expect(readStatuteChanges(request, ctx)).rejects.toBeInstanceOf(RequestInputError);
    expect(statements).toHaveLength(0);
  });

  it('validates URL input without coercing blanks, fractions, duplicates or unknown filters', () => {
    expect(parseChangesQuery(new URL('https://api.example/api/changes?after=5&limit=10&since=2026-03-01&change=removed'))).toMatchObject({ after: 5, limit: 10, change: 'removed' });
    for (const query of ['limit=', 'limit=1.5', 'limit=2&limit=3', 'after=-1', 'since=yesterday', 'change=deleted', 'topic=housing']) {
      expect(() => parseChangesQuery(new URL(`https://api.example/api/changes?${query}`))).toThrow(RequestInputError);
    }
    expect(() => parseChangesQuery(new URL('https://api.example/api/changes?corpus=news-canada'))).toThrow(UnsupportedCoverageError);
    expect(validateChangesRequest({})).toMatchObject({ after: 0, limit: 50 });
  });
});
