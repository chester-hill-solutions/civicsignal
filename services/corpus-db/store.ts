import postgres from 'postgres';
import type {
  ChangeFeedEntry,
  CorpusStore,
  PipelineRow,
  RemovedRow,
  UpsertRow,
} from '../../src/ingest/pipeline';
import type { PipelineRun, PipelineState } from '../../src/ingest/reconcile';
import { fingerprintsOf } from '../../src/ingest/reconcile';

/**
 * The Postgres implementation of the corpus store.
 *
 * The rows and their vectors are written in **one transaction**. That is the
 * whole reason the corpus moved to Postgres rather than living beside a separate
 * vector index: a successful embedding followed by a failed row write used to
 * leave the index pointing at a provision the store did not have, and finding
 * that took a manifest and a script.
 *
 * The transaction covers the upserts, the removals, the change feed, the run log
 * and the corpus state. Either the store is at the new revision, or it is exactly
 * where it was.
 */
export class PostgresCorpusStore implements CorpusStore {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.sql = postgres(connectionString, {
      max: options.max ?? 4,
      // The vectors are large; a transaction that carries 32 of them is fine, but
      // the idle timeout has to outlast a slow embedding round trip.
      idle_timeout: 30,
      connect_timeout: 15,
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async fingerprints(): Promise<Map<string, string>> {
    const rows = await this.sql<{ id: string; text_hash: string }[]>`
      SELECT id, text_hash FROM statute_provisions WHERE corpus_id = 'statutes-canada'
    `;
    return new Map(rows.map((row) => [row.id, row.text_hash]));
  }

  /**
   * The same fingerprints, in id order.
   *
   * Postgres will page this itself, but this store is the one being retired —
   * the corpus is on D1 now — so it sorts the map it already reads rather than
   * growing a cursor it will never be asked for twice.
   */
  async *fingerprintEntries() {
    yield* fingerprintsOf(await this.fingerprints());
  }

  async upsert(rows: UpsertRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.sql.begin(async (tx) => {
      for (const row of rows) {
        await tx`
          INSERT INTO statute_provisions (
            id, corpus_id, instrument, citation, section, schedule, part, status,
            heading, text, source_url, jurisdiction, in_force, language,
            search_text, text_hash, last_changed, embedding
          ) VALUES (
            ${row.row.id}, ${row.row.corpusId}, ${row.row.instrument}, ${row.row.citation},
            ${row.row.section}, ${row.row.schedule}, ${row.row.part}, ${row.row.status},
            ${row.row.heading}, ${row.row.text}, ${row.row.source_url}, 'CA',
            ${row.row.in_force === 1}, ${row.row.language},
            ${searchText(row.row)}, ${row.hash}, ${row.row.lastChanged},
            ${row.embedding ? this.sql.array(row.embedding) : null}
          )
          ON CONFLICT (id) DO UPDATE SET
            instrument = EXCLUDED.instrument,
            citation = EXCLUDED.citation,
            section = EXCLUDED.section,
            schedule = EXCLUDED.schedule,
            part = EXCLUDED.part,
            status = EXCLUDED.status,
            heading = EXCLUDED.heading,
            text = EXCLUDED.text,
            source_url = EXCLUDED.source_url,
            in_force = EXCLUDED.in_force,
            search_text = EXCLUDED.search_text,
            text_hash = EXCLUDED.text_hash,
            last_changed = EXCLUDED.last_changed,
            embedding = EXCLUDED.embedding
        `;
      }
    });
  }

  async remove(ids: string[]): Promise<RemovedRow[]> {
    if (ids.length === 0) return [];
    const removed: RemovedRow[] = [];
    await this.sql.begin(async (tx) => {
      const rows = await tx<RemovedRow[]>`
        DELETE FROM statute_provisions
         WHERE id IN ${tx(ids)}
        RETURNING id, instrument, citation, section, heading, status, source_url
      `;
      removed.push(...rows);
    });
    return removed;
  }

  async recordChanges(changes: ChangeFeedEntry[]): Promise<void> {
    if (changes.length === 0) return;
    await this.sql.begin(async (tx) => {
      for (const change of changes) {
        await tx`
          INSERT INTO corpus_changes (
            corpus_id, change, row_id, instrument, citation, section, heading,
            status, summary, source_url, occurred_at, recorded_at
          ) VALUES (
            ${change.corpusId}, ${change.change}, ${change.rowId}, ${change.instrument},
            ${change.citation}, ${change.section}, ${change.heading}, ${change.status},
            ${change.summary}, ${change.sourceUrl}, ${change.occurredAt}, now()
          )
        `;
      }
    });
  }

  async recordRun(run: PipelineRun): Promise<void> {
    await this.sql`
      INSERT INTO corpus_runs (
        corpus_id, commit_sha, commit_date, ran_at, added, changed, removed,
        unchanged, embedded, duration_ms, ok, error
      ) VALUES (
        ${run.corpusId}, ${run.commit}, ${run.commitDate}, ${run.ranAt},
        ${run.counts.added}, ${run.counts.changed}, ${run.counts.removed},
        ${run.counts.unchanged}, ${run.embedded}, ${run.durationMs}, ${run.ok},
        ${run.error ?? null}
      )
    `;
  }

  async setState(state: PipelineState): Promise<void> {
    await this.sql`
      INSERT INTO corpus_state (
        corpus_id, commit_sha, commit_date, as_of, row_count, indexed_count, last_run_at
      ) VALUES (
        ${state.corpusId}, ${state.commit}, ${state.commitDate}, ${state.asOf},
        ${state.rowCount},
        (SELECT count(*) FROM statute_provisions WHERE corpus_id = ${state.corpusId} AND embedding IS NOT NULL),
        ${state.lastRunAt}
      )
      ON CONFLICT (corpus_id) DO UPDATE SET
        commit_sha = EXCLUDED.commit_sha,
        commit_date = EXCLUDED.commit_date,
        as_of = EXCLUDED.as_of,
        row_count = EXCLUDED.row_count,
        indexed_count = EXCLUDED.indexed_count,
        last_run_at = EXCLUDED.last_run_at
    `;
  }

  /** The revision the store is at, so the pipeline knows where to diff from. */
  async currentCommit(corpusId: string): Promise<{ commit: string; date: string } | null> {
    const rows = await this.sql<{ commit_sha: string; commit_date: string }[]>`
      SELECT commit_sha, commit_date FROM corpus_state WHERE corpus_id = ${corpusId}
    `;
    const row = rows[0];
    if (!row) return null;
    return { commit: row.commit_sha, date: String(row.commit_date).slice(0, 10) };
  }
}

/**
 * The token bag the lexical path searches.
 *
 * Lowercased and collapsed, because Postgres's `to_tsvector` does its own
 * stemming and the index is on the *normalised* form.
 */
function searchText(row: PipelineRow): string {
  return [row.instrument, row.section, row.heading ?? '', row.text]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
