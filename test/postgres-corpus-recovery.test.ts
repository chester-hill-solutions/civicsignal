import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import postgres from 'postgres';
import { PostgresCorpusStore } from '../services/corpus-db/store';
import type { CorpusBatch } from '../src/ingest/pipeline';
import { fingerprint } from '../src/ingest/reconcile';
import { row } from './helpers/corpus-store';

async function harness() {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec('CREATE EXTENSION vector');
  for (const name of ['0001_corpus.sql', '0002_topics.sql', '0003_corpus_mutations.sql', '0004_corpus_parser.sql']) {
    await pg.exec(readFileSync(new URL(`../services/corpus-db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  let fail: RegExp | null = null;
  // postgres.js produces parameterized SQL; execute exactly those statements
  // and values in embedded PostgreSQL, with real BEGIN/ROLLBACK semantics.
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
    if (fail?.test(query)) throw new Error('injected database failure');
    return (await pg.query(query, values)).rows;
  };
  const client = Object.assign(tagged, {
    async begin<T>(work: (tx: typeof tagged) => Promise<T>) {
      await pg.exec('BEGIN');
      try { const value = await work(tagged); await pg.exec('COMMIT'); return value; }
      catch (error) { await pg.exec('ROLLBACK'); throw error; }
    },
    async end() { await pg.close(); },
  }) as unknown as ReturnType<typeof postgres>;
  return { pg, store: new PostgresCorpusStore('', { client }), fail: (pattern: RegExp | null) => { fail = pattern; } };
}
function batch(): CorpusBatch {
  const value = row('acts-en-100');
  return { corpusId: value.corpusId, revision: 'new', occurredAt: '2026-10-22',
    upserts: [{ row: value, hash: fingerprint(value), embedding: Array(768).fill(0.1) }], removedIds: [],
    changes: [{ corpusId: value.corpusId, change: 'added', rowId: value.id, instrument: value.instrument,
      citation: value.citation, section: value.section, heading: value.heading, status: value.status,
      summary: value.heading, sourceUrl: value.source_url, occurredAt: '2026-10-22' }] };
}

describe('PostgreSQL corpus transactions', () => {
  it('rolls back rows, vector and mutation identity on feed failure, then commits one event on retry', async () => {
    const h = await harness();
    try {
      h.fail(/INSERT INTO corpus_changes/);
      await expect(h.store.applyBatch(batch())).rejects.toThrow('injected database failure');
      expect((await h.pg.query('SELECT * FROM statute_provisions')).rows).toHaveLength(0);
      expect((await h.pg.query('SELECT * FROM corpus_mutations')).rows).toHaveLength(0);
      h.fail(null);
      await h.store.applyBatch(batch());
      await h.store.applyBatch(batch());
      expect((await h.pg.query('SELECT * FROM statute_provisions WHERE embedding IS NOT NULL')).rows).toHaveLength(1);
      expect((await h.pg.query('SELECT * FROM corpus_changes')).rows).toHaveLength(1);
      expect((await h.pg.query('SELECT * FROM corpus_mutations')).rows).toHaveLength(1);
      const remove = { ...batch(), upserts: [], changes: [], removedIds: ['acts-en-100'] };
      await h.store.applyBatch(remove);
      await h.store.applyBatch(remove);
      expect((await h.pg.query('SELECT * FROM statute_provisions')).rows).toHaveLength(0);
      expect((await h.pg.query("SELECT source_url FROM corpus_changes WHERE change = 'removed'")).rows).toEqual([{ source_url: row('acts-en-100').source_url }]);
    } finally { await h.store.close(); }
  }, 30_000);

  it('commits state and run log together and preserves the corpus row count on retried publication', async () => {
    const h = await harness();
    try {
      await h.store.applyBatch(batch());
      const run = { corpusId: 'statutes-canada', commit: 'new', commitDate: '2026-10-22', ranAt: '2026-10-22T00:00:00Z',
        counts: { added: 1, changed: 0, removed: 0, unchanged: 0 }, embedded: 1, durationMs: 10, ok: true };
      const state = { corpusId: run.corpusId, commit: run.commit, commitDate: run.commitDate, asOf: run.commitDate,
        rowCount: 1, lastRunAt: run.ranAt };
      h.fail(/INSERT INTO corpus_state/);
      await expect(h.store.finishRun(run, state)).rejects.toThrow('injected database failure');
      expect((await h.pg.query('SELECT * FROM corpus_runs')).rows).toHaveLength(0);
      h.fail(null);
      await h.store.finishRun(run, state);
      expect((await h.pg.query('SELECT added, changed, removed FROM corpus_runs')).rows).toEqual([{ added: 1, changed: 0, removed: 0 }]);
      expect((await h.pg.query('SELECT row_count, indexed_count FROM corpus_state')).rows).toEqual([{ row_count: 1, indexed_count: 1 }]);
    } finally { await h.store.close(); }
  }, 30_000);
});
