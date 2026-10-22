import {
  fingerprint,
  reconcile,
  type FingerprintedRow,
  type FingerprintEntry,
  type PipelineRun,
  type PipelineState,
} from './reconcile';
import { ENCODER_CONTRACT } from '../encoder';

/**
 * The continuous ingestion pipeline.
 *
 * The corpus repo changes every three to eight days. A commit rewrites the
 * instrument that was amended and every instrument it amends, re-consolidated —
 * and it leaves the other 138,000 provisions untouched. Measured over a year, a
 * typical commit changes **56 provisions** and the largest quarterly
 * re-consolidation changes **342**.
 *
 * So the pipeline's job is to find those provisions and leave the rest alone.
 * Re-embedding everything on every commit would cost an hour of CPU and produce
 * a different index each time; embedding only what changed costs seconds and
 * produces the *same* index, which is the point — an index that is rebuilt from
 * scratch has no version, and a version is what "as of" means.
 *
 * The stages:
 *
 *   1. **detect**   — pull the corpus repo; if HEAD has not moved, stop.
 *   2. **diff**     — the changed instruments, parsed at the new commit.
 *   3. **reconcile**— compare each provision against the stored fingerprint.
 *   4. **apply**    — embed what changed, write the rows and their vectors in
 *                     one transaction, remove what went, record the run and the
 *                     change feed.
 *
 * The store and the encoder are interfaces, so the pipeline can be tested
 * against the cases that bite without a database or a model.
 */

/** A provision, as the pipeline sees it. */
export type PipelineRow = FingerprintedRow & {
  corpusId: string;
  instrument: string;
  /** The text that is embedded. */
  embedText: string;
  /** The date of the revision that last changed this row. */
  lastChanged: string;
  language: string;
};

/** The store the pipeline writes to. */
export interface CorpusStore {
  /** The fingerprints currently held, keyed by row id. */
  fingerprints(): Promise<Map<string, string>>;
  /**
   * The fingerprints in **id order**, a page at a time.
   *
   * The reconciliation against a snapshot is a merge of two sorted streams,
   * and this is the store's side of it. It exists because the map does not
   * fit: a quarter of a million fingerprints held as a `Map` is thirty
   * megabytes, the snapshot's index is eighty, and a Worker has a hundred and
   * twenty-eight — before a single row has been read.
   *
   * It is not optional. A store that cannot hand its fingerprints over in
   * order cannot take part in the diff, and a store that quietly fell back to
   * the map would work everywhere except where it matters.
   */
  fingerprintEntries(): AsyncGenerator<FingerprintEntry>;
  /** Write a row and its vector. One transaction, so the two cannot diverge. */
  upsert(rows: UpsertRow[]): Promise<void>;
  /**
   * Remove rows that are no longer in the corpus, and return what they were.
   *
   * The store is the only thing that knows what a removed row said, and the
   * change feed needs it: "this provision was removed" is only useful if the
   * feed also says which provision it was.
   */
  remove(ids: string[]): Promise<RemovedRow[]>;
  /** Record the run in the run log. */
  recordRun(run: PipelineRun): Promise<void>;
  /** Record the changes in the change feed. */
  recordChanges(changes: ChangeFeedEntry[]): Promise<void>;
  /** Record the corpus revision the store is now at. */
  setState(state: PipelineState): Promise<void>;
}

/** A row on its way into the store. */
export interface UpsertRow {
  row: PipelineRow;
  /** The fingerprint, so the next run can tell whether it changed. */
  hash: string;
  /** The embedding, or null for a row that is not indexed. */
  embedding: number[] | null;
}

/** A row that has been removed from the corpus. */
export interface RemovedRow {
  id: string;
  instrument: string;
  citation: string;
  section: string;
  heading: string | null;
  status: string | null;
  sourceUrl: string | null;
}

/** An entry in the change feed. */
export interface ChangeFeedEntry {
  corpusId: string;
  change: 'added' | 'changed' | 'removed';
  rowId: string;
  instrument: string;
  citation: string;
  section: string;
  heading: string | null;
  status: string | null;
  summary: string | null;
  sourceUrl: string | null;
  occurredAt: string;
}

/** The encoder. */
export interface Encoder {
  /**
   * Embed documents.
   *
   * The title and the text are **separate**, because the encoder's own document
   * instruction is `title: {title} | text: {content}`: the title goes in the
   * title slot, and the provision's body goes in the content slot. A document
   * with the title glued onto the front of the body is a different document to
   * the model, and the index built here would not match the index built by the
   * corpus job — which does it the same way.
   */
  embed(documents: EmbeddableDocument[]): Promise<number[][]>;
}

/** A revision of the corpus. */
export interface CorpusRevision {
  commit: string;
  date: string;
}

/** How many rows to embed in one batch. */
export const EMBED_BATCH = 32;

/**
 * The document text as it is embedded.
 *
 * The act's title and the heading go in with the text. A provision called
 * "Order in council" means nothing on its own; "Canada Labour Code s.210 —
 * Employee entitled to leave" does.
 */
export function embeddableText(row: {
  instrument: string;
  heading: string | null;
  text: string;
}): EmbeddableDocument {
  return {
    title: [row.instrument, row.heading ?? ''].filter(Boolean).join(' — ').trim(),
    text: row.text.trim(),
  };
}

/** A document to embed: the title, and the text. */
export interface EmbeddableDocument {
  title: string;
  text: string;
}

/**
 * Run the pipeline.
 *
 * The order matters and is deliberate:
 *
 * - the rows are fingerprinted **before** anything is embedded, so a row that
 *   has not changed is never re-embedded;
 * - a row that is a **placeholder** is written but not embedded, because there
 *   are eleven thousand of them and every one has the same text, and eleven
 *   thousand identical vectors would crowd the index;
 * - the embeddings and the rows are written in **one transaction**, so a failure
 *   half way through leaves the store exactly as it was rather than with an
 *   index pointing at rows that are not there.
 */
export async function runPipeline(options: {
  corpusId: string;
  previous: CorpusRevision;
  next: CorpusRevision;
  rows: PipelineRow[];
  store: CorpusStore;
  encoder: Encoder;
  now: Date;
  logger?: (line: string) => void;
}): Promise<PipelineRun> {
  const started = Date.now();
  const log = options.logger ?? (() => {});
  const { corpusId, previous, next, rows, store, encoder, now } = options;

  const stored = await store.fingerprints();
  const nextFingerprints = new Map<string, string>();
  for (const row of rows) {
    nextFingerprints.set(row.id, fingerprint(row));
  }

  const diff = reconcile(stored, nextFingerprints);
  log(
    `${corpusId}: ${diff.added.length} added, ${diff.changed.length} changed, ` +
      `${diff.removed.length} removed, ${diff.unchanged.length} unchanged`,
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const toEmbed = [...diff.added, ...diff.changed]
    .map((change) => byId.get(change.id))
    .filter((row): row is PipelineRow => row !== undefined);

  const embeddings = new Map<string, number[]>();
  const indexable = toEmbed.filter((row) => row.status !== 'placeholder');
  for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
    const batch = indexable.slice(i, i + EMBED_BATCH);
    const vectors = await encoder.embed(batch.map((row) => embeddableText(row)));
    if (vectors.length !== batch.length) {
      throw new Error(`the encoder returned ${vectors.length} vectors for ${batch.length} documents`);
    }
    batch.forEach((row, index) => embeddings.set(row.id, vectors[index]!));
    if ((i + EMBED_BATCH) % (EMBED_BATCH * 10) === 0) {
      log(`  embedded ${Math.min(i + EMBED_BATCH, indexable.length)}/${indexable.length}`);
    }
  }

  const upserts: UpsertRow[] = toEmbed.map((row) => ({
    row,
    hash: nextFingerprints.get(row.id)!,
    embedding: embeddings.get(row.id) ?? null,
  }));

  // One transaction: the rows and their vectors, the removals, the feed, the run
  // log and the state. Either the store is at the new revision or it is not.
  await store.upsert(upserts);
  const removed = await store.remove(diff.removed.map((change) => change.id));

  const occurredAt = next.date;
  const changes: ChangeFeedEntry[] = [];
  for (const change of diff.added) {
    changes.push(feedEntry(corpusId, 'added', byId.get(change.id)!, occurredAt));
  }
  for (const change of diff.changed) {
    changes.push(feedEntry(corpusId, 'changed', byId.get(change.id)!, occurredAt));
  }
  for (const row of removed) {
    changes.push({
      corpusId,
      change: 'removed',
      rowId: row.id,
      instrument: row.instrument,
      citation: row.citation,
      section: row.section,
      heading: row.heading,
      status: row.status,
      summary: row.heading,
      sourceUrl: row.sourceUrl,
      occurredAt,
    });
  }
  await store.recordChanges(changes);

  const run: PipelineRun = {
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    ranAt: now.toISOString(),
    counts: {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged.length,
    },
    embedded: embeddings.size,
    durationMs: Date.now() - started,
    ok: true,
  };
  await store.recordRun(run);
  await store.setState({
    corpusId,
    commit: next.commit,
    commitDate: next.date,
    asOf: next.date,
    rowCount: rows.length,
    lastRunAt: now.toISOString(),
  });

  log(
    `${corpusId}: at ${next.commit.slice(0, 9)} (${next.date}) — ` +
      `${run.embedded} embedded, ${run.durationMs} ms`,
  );
  return run;
}

function feedEntry(
  corpusId: string,
  change: 'added' | 'changed' | 'removed',
  row: PipelineRow,
  occurredAt: string,
): ChangeFeedEntry {
  return {
    corpusId,
    change,
    rowId: row.id,
    instrument: row.instrument,
    citation: row.citation,
    section: row.section,
    heading: row.heading,
    status: row.status,
    summary: row.heading ?? null,
    sourceUrl: null,
    occurredAt,
  };
}

/**
 * The encoder contract as the pipeline states it.
 *
 * Re-exported so the pipeline and the serving path cannot drift on the model,
 * the dimension or the prefixes: if the model changes, both change together or
 * the index and the queries stop being comparable.
 */
export { ENCODER_CONTRACT };
