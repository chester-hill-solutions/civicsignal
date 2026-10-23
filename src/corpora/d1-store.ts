/** D1 atomically stores each row, its change event and a Vectorize outbox.
 * Vectorize has no shared transaction with D1. Pending vector operations are
 * replayed before reconciliation reads fingerprints; upsert/delete replay is
 * idempotent. Completed mutation identities prevent duplicate change events
 * when the same revision is retried with different batch boundaries. */
import type { ChangeFeedEntry, CorpusBatch, CorpusStore, PipelineRow, RemovedRow, UpsertRow } from '../ingest/pipeline';
import { prepareProvisionText, writeImmutableProvisionText, UPSERT_TEXT_REFERENCE_SQL, textReferenceBindings, type TextObjectBucket } from './text-store';
import { SNAPSHOT_PARSER_VERSION } from '../ingest/snapshot-format';
import { mutationId, removalFeedEntry } from '../ingest/mutations';
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
    private readonly options: { textBucket?: TextObjectBucket; retainD1Text?: boolean } = {},
  ) {
    if (options.retainD1Text === false && !options.textBucket) throw new Error('external corpus text requires a verified text bucket');
  }

  /** Replay bounded pages without holding a corpus of embedding payloads. */
  async recoverPendingWrites(): Promise<void> {
    for (;;) {
      const pending = await this.db.prepare(
        'SELECT id, payload FROM corpus_mutations WHERE corpus_id = ? AND payload IS NOT NULL ORDER BY id LIMIT 16',
      ).bind(this.corpusId).all<{ id: string; payload: string }>();
      if (!pending.results.length) return;
      await this.completeVectorWrites(pending.results);
    }
  }

  private async completeVectorWrites(entries: { id: string; payload: string }[]): Promise<void> {
    if (!entries.length) return;
    const operations = entries.map((entry) => JSON.parse(entry.payload) as {
      upsert?: VectorizeVector; remove?: string;
    });
    const vectors = operations.flatMap((operation) => operation.upsert ? [operation.upsert] : []);
    const removals = operations.flatMap((operation) => operation.remove ? [operation.remove] : []);
    if (vectors.length) await this.vector.upsert(vectors);
    if (removals.length) await this.vector.deleteByIds(removals);
    // Clearing the outbox is itself atomic. An uncertain acknowledgement causes
    // replay of the same vectors, never omission of their change feed entries.
    await this.db.batch(entries.map((entry) => this.db.prepare(
      'UPDATE corpus_mutations SET payload = NULL, completed_at = ? WHERE id = ?',
    ).bind(new Date().toISOString(), entry.id)));
  }

  async applyBatch(batch: CorpusBatch): Promise<void> {
    if (batch.corpusId !== this.corpusId) throw new Error('corpus store identity mismatch');
    await this.recoverPendingWrites();
    const feed = new Map(batch.changes.map((entry) => [entry.rowId, entry]));
    const units = [
      ...batch.upserts.map((row) => ({ id: mutationId(batch, row.row.id, row.hash), row, rowId: row.row.id })),
      ...batch.removedIds.map((rowId) => ({ id: mutationId(batch, rowId, 'removed'), row: null, rowId })),
    ];
    // At most 16 rows (64 statements with text references) in one D1 transaction. Every statement
    // has <=18 bindings, and each journal payload holds only one vector. A
    // 2,000-row catch-up fits the configured 10,000-subrequest budget, including text readback.
    for (let start = 0; start < units.length; start += 16) {
      const chunk = units.slice(start, start + 16);
      const placeholders = chunk.map(() => '?').join(',');
      const existing = await this.db.prepare(`SELECT id FROM corpus_mutations WHERE id IN (${placeholders})`)
        .bind(...chunk.map((unit) => unit.id)).all<{ id: string }>();
      const done = new Set(existing.results.map((unit) => unit.id));
      const fresh = chunk.filter((unit) => !done.has(unit.id));
      const removedIds = fresh.filter((unit) => !unit.row).map((unit) => unit.rowId);
      const old = new Map<string, RemovedRow>();
      if (removedIds.length) {
        const result = await this.db.prepare(
          `SELECT id, act AS instrument, citation, section, heading, status, source_url AS sourceUrl
           FROM statute_sections WHERE corpus_id = ? AND id IN (${removedIds.map(() => '?').join(',')})`,
        ).bind(batch.corpusId, ...removedIds).all<RemovedRow>();
        for (const row of result.results) old.set(row.id, row);
      }
      const statements: D1PreparedStatement[] = [];
      const pending: { id: string; payload: string }[] = [];
      for (const unit of fresh) {
        const { row, rowId, id } = unit;
        const change = row ? feed.get(rowId) : old.has(rowId) ? removalFeedEntry(batch, old.get(rowId)!) : null;
        if (!change) throw new Error(`missing row or change event for ${rowId}`);
        const payload = JSON.stringify(row?.embedding ? { upsert: {
          id: rowId, values: row.embedding, namespace: 'statutes',
          metadata: { language: row.row.language, jurisdiction: 'CA', fingerprint: row.hash },
        } } : { remove: rowId });
        statements.push(this.db.prepare(
          'INSERT INTO corpus_mutations (id, corpus_id, payload) VALUES (?, ?, ?)',
        ).bind(id, batch.corpusId, payload));
        if (row) statements.push(...await this.upsertStatements([row]));
        else {
          statements.push(this.db.prepare('DELETE FROM statute_sections WHERE id = ? AND corpus_id = ?').bind(rowId, batch.corpusId));
          if (this.options.textBucket) statements.push(this.db.prepare('DELETE FROM statute_text_refs WHERE row_id = ? AND corpus_id = ?').bind(rowId, batch.corpusId));
        }
        statements.push(this.changeStatement(change));
        pending.push({ id, payload });
      }
      if (statements.length) await this.db.batch(statements);
      await this.completeVectorWrites(pending);
    }
  }

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

    const statements = await this.upsertStatements(rows);
    await this.db.batch(statements);

    const vectors = rows
      .filter((row) => row.embedding !== null)
      .map((row) => ({
        id: row.row.id,
        values: row.embedding as number[],
        namespace: 'statutes',
        metadata: { language: row.row.language, jurisdiction: 'CA', fingerprint: row.hash },
      }));
    if (vectors.length > 0) {
      await this.vector.upsert(vectors);
    }
  }

  private searchTextColumn: Promise<boolean> | undefined;

  private async upsertStatements(rows: UpsertRow[]): Promise<D1PreparedStatement[]> {
    this.searchTextColumn ??= this.db.prepare('PRAGMA table_info(statute_sections)')
      .all<{ name: string }>().then((result) => result.results.length === 0 ||
        result.results.some((column) => column.name === 'search_text'));
    const hasSearchText = await this.searchTextColumn;
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      let reference;
      if (this.options.textBucket) {
        reference = await writeImmutableProvisionText(this.options.textBucket, await prepareProvisionText({
          rowId: row.row.id, corpusId: row.row.corpusId, rowFingerprint: row.hash, text: row.row.text,
        }));
      }
      statements.push(this.db
        .prepare(
          `INSERT INTO statute_sections (
             id, corpus_id, act, citation, section, schedule, part, status, heading,
             text, source_url, jurisdiction, in_force, language, topics${hasSearchText ? ", search_text" : ""},
             text_hash, last_changed
           ) VALUES (${Array.from({ length: hasSearchText ? 18 : 17 }, () => "?").join(", ")})
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
          this.options.retainD1Text === false ? '' : row.row.text,
          row.row.source_url,
          'CA',
          row.row.in_force,
          row.row.language,
          null,
          // **Empty, and it has to be here.**
          //
          // `search_text` is `NOT NULL` with no default on the live table, and
          // the migration that drops it needs a table rewrite the database
          // does not have the memory for (`SQLITE_NOMEM`). So the column stays
          // — required, and read by nothing — and an insert has to hand it
          // *something* or the whole batch fails with `NOT NULL constraint
          // failed`, taking the cycle with it.
          //
          // An empty string is the honest value: the column is not written for
          // any reader, and the folded text it used to hold was 250.9 MB of a
          // copy of everything the product serves. It is deliberately **not**
          // in the `ON CONFLICT` clause, so an update leaves whatever is there
          // alone rather than rewriting a value nobody reads.
          ...(hasSearchText ? [''] : []),
          row.hash,
          row.row.lastChanged,
        ));
      if (reference) statements.push(this.db.prepare(UPSERT_TEXT_REFERENCE_SQL).bind(...textReferenceBindings(reference)));
    }
    return statements;
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
  async finishRun(run: PipelineRun, state?: PipelineState): Promise<void> {
    await this.recoverPendingWrites();
    await this.db.batch([this.runStatement(run), ...(state ? [this.stateStatement(state)] : [])]);
  }

  async recordRun(run: PipelineRun): Promise<void> {
    await this.runStatement(run).run();
  }

  private runStatement(run: PipelineRun): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO corpus_runs (
           corpus_id, commit_sha, commit_date, ran_at, added, changed, removed,
           unchanged, embedded, duration_ms, ok, error, parser_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.parserVersion ?? SNAPSHOT_PARSER_VERSION,
      );
  }

  /** Record the changes in the change feed. */
  async recordChanges(changes: ChangeFeedEntry[]): Promise<void> {
    if (changes.length) await this.db.batch(changes.map((change) => this.changeStatement(change)));
  }

  private changeStatement(change: ChangeFeedEntry): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO corpus_changes (
      corpus_id, change, row_id, instrument, citation, section, heading,
      status, summary, source_url, occurred_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(change.corpusId, change.change, change.rowId, change.instrument,
        change.citation, change.section, change.heading, change.status,
        change.summary, change.sourceUrl, change.occurredAt, new Date().toISOString());
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
    await this.stateStatement(state).run();
  }

  private stateStatement(state: PipelineState): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO corpus_state (corpus_id, commit_sha, commit_date, as_of, row_count, last_run_at, parser_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (corpus_id) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           commit_date = excluded.commit_date,
           as_of = excluded.as_of,
           row_count = excluded.row_count,
           last_run_at = excluded.last_run_at,
           parser_version = excluded.parser_version`,
      )
      .bind(
        state.corpusId,
        state.commit,
        state.commitDate,
        state.asOf,
        state.rowCount,
        state.lastRunAt,
        state.parserVersion ?? SNAPSHOT_PARSER_VERSION,
      );
  }

  /** The revision the store is at, if it is at one. */
  async currentCommit(corpusId = this.corpusId): Promise<PipelineState | null> {
    const result = await this.db
      .prepare(
        'SELECT corpus_id, commit_sha, commit_date, as_of, row_count, last_run_at, parser_version FROM corpus_state WHERE corpus_id = ?',
      )
      .bind(corpusId)
      .first<{
        corpus_id: string;
        commit_sha: string;
        commit_date: string;
        as_of: string;
        row_count: number;
        last_run_at: string;
        parser_version: string | null;
      }>();
    if (!result) return null;
    return {
      parserVersion: result.parser_version ?? undefined,
      corpusId: result.corpus_id,
      commit: result.commit_sha,
      commitDate: result.commit_date,
      asOf: result.as_of,
      rowCount: result.row_count,
      lastRunAt: result.last_run_at,
    };
  }
}
