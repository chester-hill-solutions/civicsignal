/**
 * The corpus store, on D1 and Vectorize.
 *
 * The pipeline writes through the `CorpusStore` interface, and there are now
 * two implementations of it: this one, and the Postgres one the Railway plane
 * runs. The pipeline's cycle does not know which it is talking to — that is the
 * whole point of the seam — so the same reconciliation, the same fingerprint
 * and the same change feed work on either.
 *
 * ## The one thing this plane cannot do
 *
 * **A row and its vector are written in two calls, and there is no
 * transaction across them.** On the Postgres plane they are one statement in
 * one transaction, so a vector cannot point at a provision the store does not
 * have. Here they can: the D1 write lands and the Vectorize write fails, and
 * the index names a provision the corpus does not hold.
 *
 * That is not a new risk — it is the risk the product ran on for a month, and
 * it cost a morning to find, because the index was recreated once and took
 * 62,245 rows with it and **nothing said so**. The mitigation is the repair
 * script, which asks the index what it holds rather than trusting a
 * checkpoint, and it is run after every ingest.
 *
 * So the order matters here: **the row is written first, then the vector.** A
 * row without a vector is invisible to the index and harmless; a vector
 * without a row is a broken answer the product will happily give.
 */
/**
 * `search_text` is **gone from this table**, and its absence is deliberate.
 *
 * It was 250.9 MB of folded text on a 232.5 MB corpus — a second copy of
 * everything the product serves — plus an index on it, and it existed for one
 * query: the lexical `LIKE ?` path. That path ran only when the vector arm
 * returned nothing, which a vector search cannot do, and measured it rescued
 * one of the fourteen questions the vector arm misses at rank 5 — on the
 * concept half of the eval set, where the vector arm is the only arm that
 * works, it rescued none. The refusal it was standing in for is a floor on the
 * score now (`VECTOR_FLOOR`), which is a thing the product can actually say.
 */
import type { ChangeFeedEntry, CorpusStore, PipelineRow, RemovedRow, UpsertRow } from '../ingest/pipeline';
import type { PipelineRun, PipelineState, FingerprintEntry } from '../ingest/reconcile';

/**
 * The store.
 *
 * The rows live in D1 and the vectors in Vectorize, and the two are addressed
 * by the same id — the provision's id, which is the LIMS id and is unique
 * across the corpus and stable across re-consolidation.
 */
export class D1CorpusStore implements CorpusStore {
  constructor(
    private readonly db: D1Database,
    private readonly vector: Vectorize,
    /** The corpus this store holds. */
    private readonly corpusId = 'statutes-canada',
  ) {}

  /**
   * The fingerprints currently held, keyed by row id.
   *
   * Paged, because D1 has a row limit per query and the corpus has a quarter
   * of a million rows. The whole map is held at once — it is the corpus's
   * identity, and a reconciliation is the one thing that needs all of it.
   */
  async fingerprints(): Promise<Map<string, string>> {
    const fingerprints = new Map<string, string>();
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const result = await this.db
        .prepare(
          `SELECT id, text_hash FROM statute_sections
            WHERE corpus_id = ? AND text_hash IS NOT NULL
            ORDER BY id
            LIMIT ? OFFSET ?`,
        )
        .bind(this.corpusId, pageSize, offset)
        .all<{ id: string; text_hash: string }>();
      const rows = result.results ?? [];
      for (const row of rows) fingerprints.set(row.id, row.text_hash);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
    return fingerprints;
  }

  /**
   * Write a row and its vector.
   *
   * The row first, and the vector second, for the reason in the file's header:
   * a row without a vector is invisible, and a vector without a row is a
   * broken answer.
   *
   * The rows go out as **one batch**, and that is not a tidiness question. The
   * D1 binding's `batch` is a single request that runs its statements in one
   * transaction, so the rows land together — and the write costs one
   * subrequest rather than one per row. A Worker has a ceiling of a thousand
   * subrequests, and a corpus that changed more rows than that would die
   * halfway through, having written some of them.
   */
  async upsert(rows: UpsertRow[]): Promise<void> {
    if (rows.length === 0) return;

    const statements = rows.map((row) =>
      this.db
        .prepare(
          `INSERT INTO statute_sections (
             id, corpus_id, act, citation, section, schedule, part, status, heading,
             text, source_url, jurisdiction, in_force, language, topics,
             text_hash, last_changed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             act = excluded.act,
             citation = excluded.citation,
             section = excluded.section,
             schedule = excluded.schedule,
             part = excluded.part,
             status = excluded.status,
             heading = excluded.heading,
             text = excluded.text,
             source_url = excluded.source_url,
             in_force = excluded.in_force,
             language = excluded.language,
             topics = excluded.topics,
             text_hash = excluded.text_hash,
             last_changed = excluded.last_changed`,
        )
        .bind(
          row.row.id,
          row.row.corpusId,
          row.row.instrument,
          row.row.citation,
          row.row.section,
          row.row.schedule,
          row.row.part,
          row.row.status,
          row.row.heading,
          row.row.text,
          row.row.source_url,
          'CA',
          row.row.in_force,
          row.row.language,
          null,
          row.hash,
          row.row.lastChanged,
        ),
    );
    await this.db.batch(statements);

    const vectors = rows
      .filter((row) => row.embedding !== null)
      .map((row) => ({
        id: row.row.id,
        values: row.embedding as number[],
        namespace: 'statutes',
        metadata: { language: row.row.language, jurisdiction: 'CA' },
      }));
    if (vectors.length > 0) {
      await this.vector.upsert(vectors);
    }
  }

  /** Remove rows that are no longer in the corpus, and return what they were. */
  async remove(ids: string[]): Promise<RemovedRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT id, act, citation, section, heading, status, source_url, language
           FROM statute_sections
          WHERE id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<{
        id: string;
        act: string;
        citation: string | null;
        section: string;
        heading: string | null;
        status: string | null;
        source_url: string;
        language: string | null;
      }>();
    const rows = result.results ?? [];

    await this.db
      .prepare(`DELETE FROM statute_sections WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    await this.vector.deleteByIds(ids);

    return rows.map((row) => ({
      id: row.id,
      instrument: row.act,
      citation: row.citation ?? '',
      section: row.section,
      heading: row.heading,
      status: row.status,
      sourceUrl: row.source_url,
      language: row.language ?? 'en',
    }));
  }

  /** Record the run in the run log. */
  async recordRun(run: PipelineRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO corpus_runs (
           corpus_id, commit_sha, commit_date, ran_at, added, changed, removed,
           unchanged, embedded, duration_ms, ok, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.corpusId,
        run.commit,
        run.commitDate,
        run.ranAt,
        run.counts.added,
        run.counts.changed,
        run.counts.removed,
        run.counts.unchanged,
        run.embedded,
        run.durationMs,
        run.ok ? 1 : 0,
        run.error ?? null,
      )
      .run();
  }

  /** Record the changes in the change feed. */
  async recordChanges(changes: ChangeFeedEntry[]): Promise<void> {
    if (changes.length === 0) return;
    for (const change of changes) {
      await this.db
        .prepare(
          `INSERT INTO corpus_changes (
             corpus_id, change, row_id, instrument, citation, section, heading,
             status, summary, source_url, occurred_at, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          change.corpusId,
          change.change,
          change.rowId,
          change.instrument,
          change.citation,
          change.section,
          change.heading,
          change.status,
          change.summary,
          change.sourceUrl,
          change.occurredAt,
          new Date().toISOString(),
        )
        .run();
    }
  }

  /**
   * The fingerprints, in id order, a page at a time.
   *
   * Keyset pagination (`WHERE id > ? ORDER BY id`), not `OFFSET`: the offset
   * form makes D1 walk every row before the offset on every page, and this
   * walks the primary key once. It is the same query the diff is a merge
   * against, and it is the difference between thirty megabytes in memory and
   * a thousand entries.
   *
   * The order is the store's own — `ORDER BY id` on a `TEXT` column is
   * bytewise, and every provision id is ASCII, so it is the same order the
   * snapshot's index is written in and the same order JavaScript's `<` gives.
   */
  async *fingerprintEntries(pageSize = 1000): AsyncGenerator<FingerprintEntry> {
    let after = '';
    for (;;) {
      const result = await this.db
        .prepare(
          `SELECT id, text_hash FROM statute_sections
            WHERE corpus_id = ? AND text_hash IS NOT NULL AND id > ?
            ORDER BY id
            LIMIT ?`,
        )
        .bind(this.corpusId, after, pageSize)
        .all<{ id: string; text_hash: string }>();
      const rows = result.results ?? [];
      if (rows.length === 0) return;
      for (const row of rows) yield { id: row.id, fp: row.text_hash };
      after = rows[rows.length - 1]!.id;
    }
  }

  /** Record the corpus revision the store is now at. */
  async setState(state: PipelineState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO corpus_state (corpus_id, commit_sha, commit_date, as_of, row_count, last_run_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (corpus_id) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           commit_date = excluded.commit_date,
           as_of = excluded.as_of,
           row_count = excluded.row_count,
           last_run_at = excluded.last_run_at`,
      )
      .bind(
        state.corpusId,
        state.commit,
        state.commitDate,
        state.asOf,
        state.rowCount,
        state.lastRunAt,
      )
      .run();
  }

  /** The revision the store is at, if it is at one. */
  async currentCommit(corpusId = this.corpusId): Promise<PipelineState | null> {
    const result = await this.db
      .prepare(
        'SELECT corpus_id, commit_sha, commit_date, as_of, row_count, last_run_at FROM corpus_state WHERE corpus_id = ?',
      )
      .bind(corpusId)
      .first<{
        corpus_id: string;
        commit_sha: string;
        commit_date: string;
        as_of: string;
        row_count: number;
        last_run_at: string;
      }>();
    if (!result) return null;
    return {
      corpusId: result.corpus_id,
      commit: result.commit_sha,
      commitDate: result.commit_date,
      asOf: result.as_of,
      rowCount: result.row_count,
      lastRunAt: result.last_run_at,
    };
  }
}
