#!/usr/bin/env bun
/**
 * Both cycles, against the same change.
 *
 * There are two ways to bring the store up to a revision, and they must agree
 * — because the deployed one is the one that writes, and the new one is the
 * one that will.
 *
 *   **the file cycle**   asks GitHub which files changed between two
 *                        revisions, fetches each one at the old revision and
 *                        at the new, and compares the provisions it parses out
 *                        of them. Its ceiling is GitHub's: the compare
 *                        endpoint names at most 300 files.
 *
 *   **the snapshot cycle** compares two indexes — the store's fingerprints
 *                        against the snapshot's — and fetches only the
 *                        provisions that moved, by byte range. Its ceiling is
 *                        none: the gap can be a day or a year.
 *
 * A cycle is only correct if it writes the same provisions either way, so this
 * runs both against one real corpus change and compares what they did:
 *
 *   - the added, changed and removed counts;
 *   - the ids written, and each written row's fingerprint;
 *   - the documents handed to the encoder (the vectors are a function of
 *     these, so equal documents are equal vectors);
 *   - the removals, and what the store said they were;
 *   - the revision and row count the store is left at.
 *
 * The `unchanged` count is **not** compared, because the two count different
 * things and both are right: the file cycle counts the provisions in the
 * changed files that did not change (three and a half thousand of them), and
 * the snapshot cycle counts the provisions the corpus holds that did not
 * change (the whole rest of it).
 *
 *     bun scripts/check-cycles.ts --from b7292cf --to 0507465
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  embeddableText,
  type ChangeFeedEntry,
  type CorpusStore,
  type PipelineRow,
  type RemovedRow,
  type UpsertRow,
} from '../src/ingest/pipeline';
import { runIncrementalPipeline } from '../src/ingest/incremental-pipeline';
import { runSnapshotPipeline } from '../src/ingest/snapshot-pipeline';
import { GitHubCorpusSource } from '../src/ingest/source';
import { SnapshotReader, type SnapshotBucket } from '../src/ingest/snapshot-source';
import { fingerprint, fingerprintsOf } from '../src/ingest/reconcile';
import { parseSnapshotIndex } from '../src/ingest/snapshot-diff';
import { FileSnapshotBucket } from './lib/file-snapshot';

const CORPUS_ID = 'statutes-canada';

const args = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const from = arg('--from');
const to = arg('--to');
const dir = arg('--dir') ?? 'dist/snapshot';
if (!from || !to) {
  console.error('usage: bun scripts/check-cycles.ts --from <sha> --to <sha> [--dir dist/snapshot]');
  process.exit(2);
}

/** The fingerprints of one index file. */
function indexFingerprints(path: string): Map<string, string> {
  return parseSnapshotIndex(readFileSync(path, 'utf8'));
}

/**
 * A store that holds fingerprints, and rows only for what it was given.
 *
 * The production store holds the whole corpus. This one holds the whole
 * corpus's *identity* — which is all a reconciliation compares — and reads a
 * removed row back out of the snapshot the store is at when the feed asks
 * what the removed provision said. That is exactly what D1 does, one query
 * cheaper.
 */
class ParityStore implements CorpusStore {
  readonly written = new Map<string, PipelineRow>();
  readonly removed: RemovedRow[] = [];
  readonly changes: ChangeFeedEntry[] = [];
  readonly runs: unknown[] = [];
  state: Record<string, unknown> | null = null;

  constructor(
    private readonly hashes: Map<string, string>,
    private readonly before: SnapshotReader,
  ) {}

  async fingerprints(): Promise<Map<string, string>> {
    return new Map(this.hashes);
  }

  async *fingerprintEntries() {
    yield* fingerprintsOf(this.hashes);
  }

  async upsert(rows: UpsertRow[]): Promise<void> {
    for (const entry of rows) {
      this.written.set(entry.row.id, entry.row);
      this.hashes.set(entry.row.id, entry.hash);
    }
  }

  async remove(ids: string[]): Promise<RemovedRow[]> {
    const index = await this.before.index();
    const entries = ids.flatMap((id) => {
      const entry = index.get(id);
      return entry ? [entry] : [];
    });
    const rows = await this.before.rows(entries);
    const out: RemovedRow[] = rows.map((row) => ({
      id: row.id,
      instrument: row.instrument,
      citation: row.citation,
      section: row.section,
      heading: row.heading,
      status: row.status,
      sourceUrl: row.source_url,
    }));
    for (const id of ids) this.hashes.delete(id);
    this.removed.push(...out);
    return out;
  }

  async recordRun(run: unknown): Promise<void> {
    this.runs.push(run);
  }

  async recordChanges(changes: ChangeFeedEntry[]): Promise<void> {
    this.changes.push(...changes);
  }

  async setState(state: Record<string, unknown>): Promise<void> {
    this.state = state;
  }
}

/** The encoder's input, remembered so the two arms can be compared on it. */
function recordingEncoder() {
  const documents: string[] = [];
  return {
    documents,
    encoder: {
      async embed(input: { title: string; text: string }[]): Promise<number[][]> {
        for (const document of input) documents.push(`${document.title}\u0000${document.text}`);
        return input.map(() => new Array(768).fill(0));
      },
    },
  };
}

/** A bucket that counts the requests made through it. */
function countingBucket(inner: SnapshotBucket): { bucket: SnapshotBucket; reads: () => number } {
  let reads = 0;
  const wrap = (object: Awaited<ReturnType<SnapshotBucket['get']>>) => object;
  return {
    bucket: {
      async get(key: string, options?: { range: { offset: number; length: number } }) {
        reads++;
        return wrap(options ? inner.get(key, options) : inner.get(key));
      },
    } as SnapshotBucket,
    reads: () => reads,
  };
}

async function main(): Promise<void> {
  const fromShort = from!.slice(0, 9);
  const toShort = to!.slice(0, 9);

  const before = readFileSync(join(dir, `${from!}.index.jsonl`), 'utf8');
  const held = parseSnapshotIndex(before);
  // The corpus's size at the revision being moved to — the ground truth the
  // two cycles' states are checked against.
  const corpusSize = indexFingerprints(join(dir, `${to!}.index.jsonl`)).size;
  console.log(`${held.size} provision(s) in the store at ${fromShort}`);

  const source = new GitHubCorpusSource({ token: process.env.GITHUB_TOKEN || undefined });
  const head = await source.head();
  if (head.commit !== to) {
    console.log(`  note: the corpus head is ${head.commit.slice(0, 9)}, not ${toShort}`);
  }

  // ── the file cycle ───────────────────────────────────────────────────────
  const fileStore = new ParityStore(new Map(held), new SnapshotReader(new FileSnapshotBucket(dir), from!));
  const fileEncoder = recordingEncoder();
  console.log(`\nfile cycle: ${fromShort} → ${toShort}`);
  const fileRun = await runIncrementalPipeline({
    corpusId: CORPUS_ID,
    previous: { commit: from!, date: '', rowCount: held.size },
    next: { commit: to!, date: head.date },
    source,
    store: fileStore,
    encoder: fileEncoder.encoder,
    now: new Date(),
    logger: (line) => console.log(`  ${line}`),
  });

  // ── the snapshot cycle ───────────────────────────────────────────────────
  const counting = countingBucket(new FileSnapshotBucket(dir));
  const snapshotStore = new ParityStore(
    new Map(held),
    new SnapshotReader(new FileSnapshotBucket(dir), from!),
  );
  const snapshotEncoder = recordingEncoder();
  console.log(`\nsnapshot cycle: ${fromShort} → ${toShort}`);
  const snapshotRun = await runSnapshotPipeline({
    corpusId: CORPUS_ID,
    revision: { commit: to!, date: head.date },
    source: new SnapshotReader(counting.bucket, to!),
    store: snapshotStore,
    encoder: snapshotEncoder.encoder,
    now: new Date(),
    logger: (line) => console.log(`  ${line}`),
  });

  // ── what they did ────────────────────────────────────────────────────────
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const counts = (run: typeof fileRun) =>
    `${run.counts.added} added, ${run.counts.changed} changed, ${run.counts.removed} removed`;
  const same =
    fileRun.counts.added === snapshotRun.counts.added &&
    fileRun.counts.changed === snapshotRun.counts.changed &&
    fileRun.counts.removed === snapshotRun.counts.removed;
  checks.push({
    name: 'the counts',
    ok: same,
    detail: `file ${counts(fileRun)} / snapshot ${counts(snapshotRun)}`,
  });

  const fileIds = [...fileStore.written.keys()].sort();
  const snapshotIds = [...snapshotStore.written.keys()].sort();
  const onlyFile = fileIds.filter((id) => !snapshotStore.written.has(id));
  const onlySnapshot = snapshotIds.filter((id) => !fileStore.written.has(id));
  checks.push({
    name: 'the ids written',
    ok: onlyFile.length === 0 && onlySnapshot.length === 0,
    detail:
      onlyFile.length === 0 && onlySnapshot.length === 0
        ? `${fileIds.length} both`
        : `${onlyFile.length} only from the files, ${onlySnapshot.length} only from the snapshot`,
  });

  const differing = fileIds.filter((id) => {
    const a = fileStore.written.get(id);
    const b = snapshotStore.written.get(id);
    return !a || !b || fingerprint(a) !== fingerprint(b);
  });
  checks.push({
    name: 'the rows themselves',
    ok: differing.length === 0,
    detail:
      differing.length === 0
        ? `${fileIds.length} provision(s) written, every fingerprint the same`
        : `${differing.length} row(s) differ, first: ${differing.slice(0, 3).join(', ')}`,
  });

  const fileDocs = [...fileEncoder.documents].sort();
  const snapshotDocs = [...snapshotEncoder.documents].sort();
  checks.push({
    name: 'the documents embedded',
    ok: fileDocs.length === snapshotDocs.length && fileDocs.every((doc, i) => doc === snapshotDocs[i]),
    detail: `${fileDocs.length} / ${snapshotDocs.length}`,
  });

  const fileRemoved = fileStore.removed.map((row) => row.id).sort();
  const snapshotRemoved = snapshotStore.removed.map((row) => row.id).sort();
  checks.push({
    name: 'the removals',
    ok: fileRemoved.join() === snapshotRemoved.join(),
    detail: `${fileRemoved.length} / ${snapshotRemoved.length}`,
  });

  checks.push({
    name: 'the state left behind',
    ok:
      fileStore.state?.commit === to &&
      snapshotStore.state?.commit === to &&
      fileStore.state?.rowCount === corpusSize &&
      snapshotStore.state?.rowCount === corpusSize,
    detail:
      `both at ${toShort}, ${corpusSize} provision(s) in the corpus — ` +
      `file says ${fileStore.state?.rowCount}, snapshot says ${snapshotStore.state?.rowCount}`,
  });

  console.log('\nwhat the two cycles did');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  }
  console.log(
    `\nthe snapshot cycle read ${counting.reads()} range(s) for ${snapshotIds.length} row(s), ` +
      `${snapshotRun.embedded} embedded in ${snapshotRun.durationMs} ms`,
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed — the two cycles do not agree`);
    process.exit(1);
  }
  console.log('\nthe two cycles agree');
}

await main();
