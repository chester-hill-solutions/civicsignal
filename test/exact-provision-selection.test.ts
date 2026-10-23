import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { statutesCorpus } from '../src/corpora/adapters';
import { postgresStatutesCorpus } from '../src/corpora/postgres-adapters';
import { postgresCorpusDatabase } from '../src/corpora/postgres-driver';
import { COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS } from '../src/corpora/compact-restore';
import type { Corpus, CorpusContext } from '../src/corpora/types';
import { testD1 } from './helpers/d1';

type Row = Record<string, unknown>;
const source = JSON.parse(readFileSync(new URL('./fixtures/c6-exact-citation-legacy.json', import.meta.url), 'utf8')) as { rows: Row[] };
const englishPreamble = source.rows.find((row) => row['id'] === 'acts-en-151434')!;
const englishSection = source.rows.find((row) => row['id'] === 'acts-en-151510')!;
interface Harness { ctx: CorpusContext; corpus: Corpus; insert(rows: Row[]): Promise<void>; clear(): Promise<void>; close(): Promise<unknown> | void }

async function harness(backend: 'D1' | 'PostgreSQL'): Promise<Harness> {
  const common = { fetch, now: () => new Date('2026-10-23T00:00:00Z') };
  if (backend === 'D1') {
    const database = testD1({ schema: COMPACT_CORPUS_SCHEMA });
    return { ctx: { ...common, db: database.db }, corpus: statutesCorpus,
      async insert(rows) { for (const row of rows) database.sqlite.prepare(`INSERT INTO statute_sections(${COMPACT_STATUTE_COLUMNS.join(',')}) VALUES(${COMPACT_STATUTE_COLUMNS.map(() => '?').join(',')})`)
        .run(...COMPACT_STATUTE_COLUMNS.map((column) => row[column] ?? null) as (string | number | null)[]); },
      async clear() { database.sqlite.exec('DELETE FROM statute_sections'); }, close: database.close };
  }
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE statute_provisions(id TEXT PRIMARY KEY,corpus_id TEXT,instrument TEXT,citation TEXT,section TEXT,
    status TEXT,heading TEXT,text TEXT,source_url TEXT,jurisdiction TEXT,in_force BOOLEAN,topics TEXT,language TEXT)`);
  const columns = ['id', 'corpus_id', 'instrument', 'citation', 'section', 'status', 'heading', 'text', 'source_url', 'jurisdiction', 'in_force', 'topics', 'language'];
  const db = postgresCorpusDatabase({ async unsafe(query, values) { return (await pg.query(query, values)).rows; } });
  return { ctx: { ...common, db }, corpus: postgresStatutesCorpus,
    async insert(rows) { for (const row of rows) await pg.query(`INSERT INTO statute_provisions(${columns.join(',')}) VALUES(${columns.map((_column, at) => `$${at + 1}`).join(',')})`,
      columns.map((column) => column === 'instrument' ? row['act'] : column === 'in_force' ? Boolean(row[column]) : row[column] ?? null)); },
    async clear() { await pg.exec('DELETE FROM statute_provisions'); }, close: () => pg.close() };
}

describe.each(['D1', 'PostgreSQL'] as const)('exact source selection on %s', (backend) => {
  let h: Harness;
  beforeAll(async () => { h = await harness(backend); });
  beforeEach(async () => { await h.clear(); });
  afterAll(async () => { await h.close(); });

  it.each([
    { language: 'en', act: 'Canada Health Act', id: 'acts-en-151510', path: 'en/acts' },
    { language: 'fr', act: 'Loi canadienne sur la santé', id: 'acts-fr-147900', path: 'fr/lois' },
  ])('resolves real legacy C-6 section8 before LIMIT1 in $language', async ({ language, act, id, path }) => {
    await h.insert(source.rows);
    const table = backend === 'D1' ? 'statute_sections' : 'statute_provisions';
    const title = backend === 'D1' ? 'act' : 'instrument';
    const original = await h.ctx.db!.prepare(`SELECT id FROM ${table} WHERE ${title}=? AND section=? AND language=? ORDER BY in_force DESC,id LIMIT ?`)
      .bind(act, '8', language, 1).all<{ id: string }>();
    expect(original.results?.map((row) => row.id)).toEqual([language === 'en' ? 'acts-en-151434' : 'acts-fr-147824']);
    const result = await h.corpus.retrieve({ act, section: '8', language, limit: 1 }, h.ctx);
    expect(result.map((item) => item.id)).toEqual([id]);
    expect(result[0]?.citationUrl).toBe(`https://laws-lois.justice.gc.ca/${path}/C-6/section-8.html`);
    expect(result[0]?.body).toBe(source.rows.find((row) => row['id'] === id)!['text']);
    expect((await h.corpus.retrieve({ act, section: '8', language, limit: 10 }, h.ctx)).map((item) => item.id)).toEqual([id]);
  });

  it('prefers a canonical section without a heading even when it is repealed and its namesake is in force', async () => {
    await h.insert([{ ...englishPreamble, heading: 'A misleading preamble heading' }, { ...englishSection, heading: null, in_force: 0, status: 'repealed' }]);
    const result = await h.corpus.retrieve({ act: 'Canada Health Act', section: '8', language: 'en', limit: 1 }, h.ctx);
    expect(result.map((item) => item.id)).toEqual(['acts-en-151510']);
    expect(result[0]?.extra).toMatchObject({ inForce: false, status: 'repealed' });
  });

  it('retains multiple canonical section versions within the requested limit', async () => {
    await h.insert([englishPreamble, englishSection, { ...englishSection, id: 'acts-en-151511', status: 'repealed', in_force: 0 }]);
    expect((await h.corpus.retrieve({ act: 'Canada Health Act', section: '8', limit: 10 }, h.ctx)).map((item) => item.id))
      .toEqual(['acts-en-151510', 'acts-en-151511']);
  });

  it('preserves every full-text/amending match when no canonical section exists', async () => {
    const amended = { ...englishSection, source_url: 'https://laws-lois.justice.gc.ca/en/acts/C-6/FullText.html#h-151510' };
    await h.insert([englishPreamble, amended]);
    const query = { act: 'Canada Health Act', section: '8', language: 'en' };
    expect((await h.corpus.retrieve({ ...query, limit: 10 }, h.ctx)).map((item) => item.id)).toEqual(['acts-en-151434', 'acts-en-151510']);
    expect((await h.corpus.retrieve({ ...query, limit: 1 }, h.ctx)).map((item) => item.id)).toEqual(['acts-en-151434']);
  });

  it.each(['A', 'Schedule 1'])('preserves nonnumeric %s fallback rows', async (section) => {
    await h.insert([{ ...englishPreamble, section }, { ...englishSection, section,
      source_url: 'https://laws-lois.justice.gc.ca/en/acts/C-6/FullText.html#h-151510' }]);
    expect((await h.corpus.retrieve({ act: 'Canada Health Act', section, limit: 10 }, h.ctx)).map((item) => item.id))
      .toEqual(['acts-en-151434', 'acts-en-151510']);
  });

  it.each([
    { language: 'en', citation: 'SOR-96-313', path: 'en/regulations/SOR-96-313' },
    { language: 'fr', citation: 'C.R.C.,_ch._870', path: 'fr/reglements/C.R.C.%2C_ch._870' },
  ])('recognizes a decimal regulation section URL in $language', async ({ language, citation, path }) => {
    const common = { act: 'Regulation fixture', section: '15.1', citation, language };
    await h.insert([{ ...englishPreamble, ...common, source_url: `https://laws-lois.justice.gc.ca/${path}/FullText.html#h-151434` },
      { ...englishSection, ...common, heading: null, source_url: `https://laws-lois.justice.gc.ca/${path}/section-15.1.html` }]);
    expect((await h.corpus.retrieve({ act: common.act, section: common.section, language, limit: 1 }, h.ctx)).map((item) => item.id)).toEqual(['acts-en-151510']);
  });

  it('keeps the language filter when two official versions share an instrument title', async () => {
    await h.insert(source.rows.map((row) => ({ ...row, act: 'Shared title' })));
    for (const [language, id] of [['en', 'acts-en-151510'], ['fr', 'acts-fr-147900']]) {
      expect((await h.corpus.retrieve({ act: 'Shared title', section: '8', language, limit: 1 }, h.ctx)).map((item) => item.id)).toEqual([id]);
    }
  });
});

it('hydrates only the selected actual section on the D1 exact path', async () => {
  const h = await harness('D1');
  try {
    await h.insert(source.rows.map((row) => ({ ...row, text: '' })));
    const hydrated: string[][] = [];
    h.ctx.provisionTexts = { async hydrate(rows) {
      hydrated.push(rows.map((row) => String(row['id'])));
      return rows.map((row) => ({ ...row, text: source.rows.find((original) => original['id'] === row['id'])!['text'] }));
    } };
    const result = await h.corpus.retrieve({ act: 'Canada Health Act', section: '8', language: 'en', limit: 1 }, h.ctx);
    expect(hydrated).toEqual([['acts-en-151510']]);
    expect(result[0]?.body).toBe(englishSection['text']);
  } finally { await h.close(); }
});
