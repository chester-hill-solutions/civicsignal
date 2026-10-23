import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CorpusStore } from '../src/corpora/d1-store';
import { runPipeline, type CorpusBatch, type UpsertRow } from '../src/ingest/pipeline';
import { fingerprint } from '../src/ingest/reconcile';
import type { TextObjectBucket } from '../src/corpora/text-store';
import { row } from './helpers/corpus-store';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** Execute the actual production statements and D1 batch transaction semantics. */
function harness(dropSearchText = false, textOptions: { textBucket?: TextObjectBucket; retainD1Text?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_statute_citation_columns.sql', '0003_pipeline.sql', '0006_corpus_mutations.sql', '0007_provision_text_refs.sql', '0008_corpus_parser.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  if (dropSearchText) sqlite.exec(readFileSync(new URL('../migrations/0004_drop_search_text.sql', import.meta.url), 'utf8'));
  let failSql: RegExp | null = null;
  let failVector = false;
  let embedCalls = 0;
  const values = new Map<string, number[]>();
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const check = () => { if (failSql?.test(sql)) throw new Error('injected database failure'); };
    return {
      bind(...args: unknown[]) { binds = args; return this; },
      async run() { check(); return sqlite.prepare(sql).run(...binds); },
      async first() { check(); return sqlite.prepare(sql).get(...binds) ?? null; },
      async all() { check(); return { results: sqlite.prepare(sql).all(...binds) }; },
    };
  };
  const db = {
    prepare,
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const vector = {
    async upsert(vectors: { id: string; values: number[] }[]) {
      if (failVector) throw new Error('injected vector failure');
      for (const vector of vectors) values.set(vector.id, vector.values);
    },
    async deleteByIds(ids: string[]) {
      if (failVector) throw new Error('injected vector failure');
      for (const id of ids) values.delete(id);
    },
  } as unknown as Vectorize;
  const store = new D1CorpusStore(db, vector, 'statutes-canada', textOptions);
  const encoder = { async embed(documents: unknown[]) { embedCalls++; return documents.map(() => [0.1, 0.2]); } };
  return { store, sqlite, values, encoder,
    sqlFailure: (pattern: RegExp | null) => { failSql = pattern; },
    vectorFailure: (value: boolean) => { failVector = value; },
    embedCalls: () => embedCalls,
  };
}

const next = { commit: 'revision-2', date: '2026-10-22' };
function batch(upserts: UpsertRow[], removedIds: string[] = []): CorpusBatch {
  return { corpusId: 'statutes-canada', revision: next.commit, occurredAt: next.date, upserts, removedIds,
    changes: upserts.map(({ row }) => ({ corpusId: row.corpusId, change: 'added', rowId: row.id,
      instrument: row.instrument, citation: row.citation, section: row.section, heading: row.heading,
      status: row.status, summary: row.heading, sourceUrl: row.source_url, occurredAt: next.date })) };
}
function upsert(id: string): UpsertRow {
  const value = row(id);
  return { row: value, hash: fingerprint(value), embedding: [0.1, 0.2] };
}
const count = (h: ReturnType<typeof harness>, table: string) => h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

function textBucket() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  let fail = false;
  const bucket: TextObjectBucket = {
    async put(key, bytes) { if (fail) throw new Error('injected R2 failure'); if (objects.has(key)) return null; objects.set(key, bytes); return {}; },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
    },
  };
  return { bucket, objects, fail: (value: boolean) => { fail = value; } };
}

describe('corpus transaction and outbox recovery', () => {
  it('does not commit rows, feed or references when an R2 upload fails', async () => {
    const r2 = textBucket();
    const h = harness(false, { textBucket: r2.bucket });
    r2.fail(true);
    await expect(h.store.applyBatch(batch([upsert('a-1')]))).rejects.toThrow('injected R2 failure');
    for (const table of ['statute_sections', 'statute_text_refs', 'corpus_changes', 'corpus_mutations']) expect(count(h, table)).toBe(0);
  });

  it('commits row and R2 reference atomically; a failed SQL transaction leaves the old row/reference intact', async () => {
    const r2 = textBucket();
    const h = harness(false, { textBucket: r2.bucket });
    await h.store.applyBatch(batch([upsert('a-1')]));
    const old = h.sqlite.prepare('SELECT row_fingerprint FROM statute_text_refs').get().row_fingerprint;
    const changed = row('a-1', { text: 'A changed provision.' });
    h.sqlFailure(/INSERT INTO corpus_changes/);
    await expect(h.store.applyBatch(batch([{ row: changed, hash: fingerprint(changed), embedding: [0.1] }]))).rejects.toThrow();
    expect(h.sqlite.prepare('SELECT row_fingerprint FROM statute_text_refs').get().row_fingerprint).toBe(old);
    expect(h.sqlite.prepare('SELECT text_hash FROM statute_sections').get().text_hash).toBe(old);
    expect(r2.objects.size).toBe(2); // the unreferenced immutable object is safe
  });

  it('can omit D1 text only after the immutable object and matching reference verify', async () => {
    const r2 = textBucket();
    const h = harness(true, { textBucket: r2.bucket, retainD1Text: false });
    await h.store.applyBatch(batch([upsert('a-1')]));
    const value = h.sqlite.prepare('SELECT text, text_hash FROM statute_sections').get();
    expect(value.text).toBe('');
    expect(h.sqlite.prepare('SELECT row_fingerprint FROM statute_text_refs').get().row_fingerprint).toBe(value.text_hash);
    expect(r2.objects.size).toBe(1);
    await h.store.applyBatch(batch([], ['a-1']));
    expect(count(h, 'statute_text_refs')).toBe(0);
  });

  it.each([false, true])('writes against the live and clean-migration schema (search_text dropped: %s)', async (dropped) => {
    const h = harness(dropped);
    await h.store.applyBatch(batch([upsert('a-1')]));
    expect(count(h, 'statute_sections')).toBe(1);
    expect(h.values.has('a-1')).toBe(true);
  });
  it('rolls back rows and fingerprints when the feed insert fails, then retries the complete change', async () => {
    const h = harness();
    h.sqlFailure(/INSERT INTO corpus_changes/);
    const run = () => runPipeline({ corpusId: 'statutes-canada', previous: { commit: 'old', date: '2026-10-01' },
      next, rows: [row('a-1')], store: h.store, encoder: h.encoder, now: new Date('2026-10-22T00:00:00Z') });
    await expect(run()).rejects.toThrow('injected database failure');
    expect(count(h, 'statute_sections')).toBe(0);
    expect(count(h, 'corpus_mutations')).toBe(0);
    h.sqlFailure(null);
    expect((await run()).counts.added).toBe(1);
    expect(count(h, 'corpus_changes')).toBe(1);
    expect(count(h, 'corpus_runs')).toBe(1);
    expect((await h.store.currentCommit())?.rowCount).toBe(1);
  });

  it('recovers a crash after row/feed commit before vector write without re-embedding or losing the event', async () => {
    const h = harness();
    h.vectorFailure(true);
    const run = () => runPipeline({ corpusId: 'statutes-canada', previous: { commit: 'old', date: '2026-10-01' },
      next, rows: [row('a-1')], store: h.store, encoder: h.encoder, now: new Date('2026-10-22T00:00:00Z') });
    await expect(run()).rejects.toThrow('injected vector failure');
    expect(count(h, 'statute_sections')).toBe(1);
    expect(count(h, 'corpus_changes')).toBe(1);
    expect(h.values.size).toBe(0);
    expect(await h.store.currentCommit()).toBeNull();
    h.vectorFailure(false);
    await run();
    expect(h.embedCalls()).toBe(1);
    expect(h.values.get('a-1')).toEqual([0.1, 0.2]);
    expect(count(h, 'corpus_changes')).toBe(1);
    expect((await h.store.currentCommit())?.commit).toBe(next.commit);
    expect(h.sqlite.prepare('SELECT payload FROM corpus_mutations').get().payload).toBeNull();
  });

  it('does not duplicate events when a revision is replayed with different batch boundaries', async () => {
    const h = harness();
    const rows = [upsert('a-1'), upsert('a-2')];
    await h.store.applyBatch(batch(rows));
    await h.store.applyBatch(batch([rows[0]!]));
    await h.store.applyBatch(batch([rows[1]!]));
    expect(count(h, 'corpus_changes')).toBe(2);
    expect(count(h, 'corpus_mutations')).toBe(2);
  });

  it('retains removal metadata and retries failed vector deletion after the row is gone', async () => {
    const h = harness();
    await h.store.applyBatch(batch([upsert('a-1')]));
    h.vectorFailure(true);
    await expect(h.store.applyBatch(batch([], ['a-1']))).rejects.toThrow('injected vector failure');
    expect(count(h, 'statute_sections')).toBe(0);
    expect(h.values.has('a-1')).toBe(true);
    h.vectorFailure(false);
    await h.store.recoverPendingWrites();
    await h.store.applyBatch(batch([], ['a-1']));
    expect(h.values.has('a-1')).toBe(false);
    const event = h.sqlite.prepare("SELECT * FROM corpus_changes WHERE change = 'removed'").get();
    expect(event.instrument).toBe('Access to Information Act');
    expect(count(h, 'corpus_changes')).toBe(2);
  });

  it('never publishes a revision when its run log cannot be written', async () => {
    const h = harness();
    h.sqlFailure(/INSERT INTO corpus_runs/);
    await expect(runPipeline({ corpusId: 'statutes-canada', previous: { commit: 'old', date: '2026-10-01' },
      next, rows: [row('a-1')], store: h.store, encoder: h.encoder, now: new Date('2026-10-22T00:00:00Z') })).rejects.toThrow();
    expect(count(h, 'corpus_runs')).toBe(0);
    expect(await h.store.currentCommit()).toBeNull();
  });
});
