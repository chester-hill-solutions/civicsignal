import { describe, expect, it } from 'vitest';
import { D1CorpusStore } from '../src/corpora/d1-store';
import type { PipelineRow, UpsertRow } from '../src/ingest/pipeline';

/**
 * The D1 store's statements.
 *
 * The store is the pipeline's way of writing to Cloudflare, and the expensive
 * mistake is a **silent** one: a column that does not exist is an error the
 * pipeline logs and moves past, and a provision that is never written is a
 * provision the product cannot cite.
 *
 * So these tests are about the *statements*, not about the data: that the
 * insert names the columns the schema has, that the bind order matches the
 * placeholders, and that the vectors are written after the rows rather than
 * with them — because a row without a vector is invisible, and a vector
 * without a row is a broken answer.
 */

/** A D1 binding that records what it was asked to do. */
function recordingD1() {
  const statements: { sql: string; binds: unknown[] }[] = [];
  /** The batches the store asked for, and how many statements each held. */
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      const record = { sql, binds: [] as unknown[] };
      statements.push(record);
      return {
        bind(...values: unknown[]) {
          record.binds = values;
          return this;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async first<T>() {
          return null as T | null;
        },
      };
    },
    async batch(prepared: { run(): Promise<unknown> }[]) {
      batches.push(prepared.length);
      for (const statement of prepared) await statement.run();
      return [];
    },
  };
  return { db: db as unknown as D1Database, statements, batches };
}

/** A Vectorize binding that records what it was asked to do. */
function recordingVectorize() {
  const upserts: { ids: string[]; namespace: string | undefined }[] = [];
  const deletes: string[][] = [];
  const vector = {
    async upsert(vectors: { id: string; namespace?: string }[]) {
      upserts.push({ ids: vectors.map((v) => v.id), namespace: vectors[0]?.namespace });
      return { mutationId: '1' };
    },
    async deleteByIds(ids: string[]) {
      deletes.push(ids);
      return { mutationId: '1' };
    },
  };
  return { vector: vector as unknown as Vectorize, upserts, deletes };
}

function row(id: string, overrides: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id,
    corpusId: 'statutes-canada',
    instrument: 'Canada Labour Code',
    citation: 'L.C. 1992, c. 22',
    section: '210',
    status: 'in-force',
    schedule: null,
    part: null,
    heading: 'Notice of termination',
    text: 'An employer shall give an employee written notice of termination.',
    source_url: 'https://laws-lois.justice.gc.ca/eng/acts/L-2.2/section-210.html',
    in_force: 1,
    language: 'en',
    embedText: '',
    lastChanged: '2026-10-15',
    ...overrides,
  };
}

function upsert(row: PipelineRow, embedding: number[] | null = null): UpsertRow {
  return { row, hash: 'hash-1', embedding };
}

describe('the D1 corpus store', () => {
  it('names the columns the schema has, and binds them in order', async () => {
    const { db, statements } = recordingD1();
    const { vector } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.upsert([upsert(row('a-1'))]);

    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO statute_sections"))!;
    expect(insert.sql).toContain('INSERT INTO statute_sections');
    // The columns the migration creates. A name that is not there is an error
    // the pipeline logs and moves past, and the provision is simply never
    // written.
    for (const column of [
      'id',
      'corpus_id',
      'act',
      'citation',
      'section',
      'schedule',
      'part',
      'status',
      'heading',
      'text',
      'source_url',
      'jurisdiction',
      'in_force',
      'language',
      'topics',
      'text_hash',
      'last_changed',
    ]) {
      expect(insert.sql).toContain(column);
    }
    // **And `search_text` is in the insert, empty, for one reason.**
    //
    // It is `NOT NULL` with no default on the live table, and the migration
    // that drops it needs a table rewrite D1 answers `out of memory:
    // SQLITE_NOMEM` to. So the column stays — required, and read by nobody —
    // and an insert that omitted it would fail the whole batch and take the
    // cycle with it. That is not hypothetical: it was the state of this code
    // for one commit, and it would have fired on the next corpus revision.
    expect(insert.sql).toContain('search_text');
    expect(insert.binds[15]).toBe('');
    // It is **not** in the update, so an existing value is left alone rather
    // than rewritten with a value nothing reads.
    expect(insert.sql.split('ON CONFLICT')[1]).not.toContain('search_text');
    // One placeholder per column, and one bind per placeholder.
    const placeholders = (insert.sql.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(18);
    expect(insert.binds.length).toBe(18);
    expect(insert.binds[0]).toBe('a-1');
    expect(insert.binds[13]).toBe('en');
  });

  it('writes the row before the vector', async () => {
    const { db, statements } = recordingD1();
    const { vector, upserts } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.upsert([upsert(row('a-1'), [0.1, 0.2])]);

    // The row's statement was prepared first, and the vector was written after
    // it — a row without a vector is invisible, and a vector without a row is
    // a broken answer.
    expect(statements.filter((statement) => statement.sql.includes("INSERT INTO statute_sections")).length).toBe(1);
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.ids).toEqual(['a-1']);
    expect(upserts[0]!.namespace).toBe('statutes');
  });

  it('does not write a vector for a row that has none', async () => {
    const { db } = recordingD1();
    const { vector, upserts } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.upsert([upsert(row('a-1'), null)]);

    expect(upserts.length).toBe(0);
  });

  /**
   * The rows go out as one batch.
   *
   * A Worker has a ceiling of a thousand subrequests, and each statement sent
   * on its own is one of them — so a corpus that changed more rows than that
   * would die halfway through, having written some of them and not the rest.
   */
  it('writes the rows in one batch, not one request per row', async () => {
    const { db, batches } = recordingD1();
    const { vector } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.upsert([upsert(row('a-1')), upsert(row('a-2')), upsert(row('a-3'))]);

    expect(batches).toEqual([3]);
  });

  it('removes the row and the vector together', async () => {
    const { db, statements } = recordingD1();
    const { vector, deletes } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.remove(['a-1']);

    expect(deletes).toEqual([['a-1']]);
    expect(statements.some((s) => s.sql.includes('DELETE FROM statute_sections'))).toBe(true);
  });

  it('records the revision it is at', async () => {
    const { db, statements } = recordingD1();
    const { vector } = recordingVectorize();
    const store = new D1CorpusStore(db, vector);

    await store.setState({
      corpusId: 'statutes-canada',
      commit: 'abc123',
      commitDate: '2026-10-15',
      asOf: '2026-10-15',
      rowCount: 277857,
      lastRunAt: '2026-10-21T00:00:00Z',
    });

    expect(statements[0]!.sql).toContain('INSERT INTO corpus_state');
    expect(statements[0]!.binds[1]).toBe('abc123');
  });
});
