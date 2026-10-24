import { Buffer } from 'node:buffer';
import { rowsForFile } from '../../src/ingest/corpus-rows';
import { fingerprint } from '../../src/ingest/reconcile';
import { IndexDigester, indexKey, indexLine, manifestKey, parseManifest, SNAPSHOT_FORMAT,
  SNAPSHOT_PARSER_VERSION, snapshotNamespace, type SnapshotManifest, type SnapshotPart } from '../../src/ingest/snapshot-format';
import type { SnapshotIndexEntry } from '../../src/ingest/snapshot-diff';
import { FRENCH_INSTRUMENT_PATHS, INSTRUMENT_PATHS, type CorpusRevision, type CorpusSource } from '../../src/ingest/source';

/** No Vectorize access: snapshots preserve the existing index and its bytes. */
export type BuildBucket = Pick<R2Bucket, 'get' | 'head' | 'put' | 'list' | 'delete'>;
const encode = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(Buffer.byteLength(text, 'utf8')));
  new TextEncoder().encodeInto(text, bytes);
  return bytes;
};
export const GROUP_BYTES = 8 * 1024 * 1024;
export const ROW_PART_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_INDEX_PARTITION_BYTES = 16 * 1024 * 1024;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
export const PARTITIONS = ['acts-en-', 'acts-fr-', 'regulations-en-', 'regulations-fr-'] as const;

export interface Artifact extends SnapshotPart { sha256: string; singlePath?: string }
export interface StagePlan {
  revision: CorpusRevision;
  groups: Artifact[];
  files: number;
}
export interface GroupResult {
  partBytes: number;
  rows: Artifact[];
  fragments: { partition: string; artifact: Artifact }[];
  count: number;
  bytes: number;
}
export interface IndexPartition extends Artifact { count: number }
export function stagingPrefix(commit: string): string { return `.snapshot-staging/${SNAPSHOT_PARSER_VERSION}/${commit}/`; }

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Conditional writes prevent replacement of published or staged revision data.
 * A retried write must be byte-identical, including offsets and parser output. */
export async function immutablePut(bucket: BuildBucket, key: string, bytes: Uint8Array<ArrayBuffer>): Promise<Artifact> {
  const digest = await sha256(bytes);
  const result = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: digest },
  });
  if (!result) {
    const existing = await bucket.head(key);
    if (existing?.size !== bytes.byteLength || existing.customMetadata?.sha256 !== digest) {
      throw new Error(`immutable artifact conflict: ${key}`);
    }
  }
  return { key, bytes: bytes.byteLength, sha256: digest };
}

async function artifactBytes(bucket: BuildBucket, artifact: Artifact): Promise<Uint8Array<ArrayBuffer>> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new Error(`missing artifact: ${artifact.key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== artifact.bytes || await sha256(bytes) !== artifact.sha256) {
    throw new Error(`artifact integrity failed: ${artifact.key}`);
  }
  return bytes;
}

/** Decompress the pinned tar only once; every parsing step reads its own group.
 * One oversized instrument can exceed the group target but never MAX_FILE_BYTES. */
export async function stageCorpus(bucket: BuildBucket, source: CorpusSource, revision: CorpusRevision,
  groupBytes = GROUP_BYTES): Promise<StagePlan> {
  const groups: Artifact[] = [];
  let lines: string[] = [];
  let size = 0;
  let files = 0;
  const flush = async () => {
    if (!lines.length) return;
    groups.push(await immutablePut(bucket, `${stagingPrefix(revision.commit)}group-${groups.length}.jsonl`, encode(lines.join(''))));
    lines = [];
    size = 0;
  };
  for await (const file of source.instruments(revision.commit, [...INSTRUMENT_PATHS, ...FRENCH_INSTRUMENT_PATHS])) {
    const rawBytes = Buffer.byteLength(file.content, 'utf8');
    if (rawBytes > MAX_FILE_BYTES) throw new Error(`instrument exceeds bounded parser input: ${file.path}`);
    if (rawBytes >= groupBytes) {
      await flush();
      groups.push({ ...await immutablePut(bucket, `${stagingPrefix(revision.commit)}group-${groups.length}.xml`, encode(file.content)), singlePath: file.path });
      files++;
      continue;
    }
    const line = `${JSON.stringify(file)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    // A large instrument is staged as raw XML: JSON escaping and parsing
    // would keep two additional copies of a 15MB French file in the isolate.
    if (bytes >= groupBytes) {
      await flush();
      groups.push({ ...await immutablePut(bucket, `${stagingPrefix(revision.commit)}group-${groups.length}.xml`, encode(file.content)), singlePath: file.path });
      files++;
      continue;
    }
    if (size && size + bytes > groupBytes) await flush();
    lines.push(line);
    size += bytes;
    files++;
    if (size >= groupBytes || lines.length >= 128) await flush();
  }
  await flush();
  if (!files) throw new Error('refusing to publish an empty corpus');
  return { revision, groups, files };
}

/** Parse one group with the same rowsForFile used by ingestion. Row order is
 * file order; only index fragments are sorted in the following steps. */
export async function buildGroup(bucket: BuildBucket, plan: StagePlan, group: number, baseOffset: number,
  partBytes = ROW_PART_BYTES): Promise<GroupResult> {
  const raw = new TextDecoder().decode(await artifactBytes(bucket, plan.groups[group]!));
  const rows: Artifact[] = [];
  const fragments = new Map<string, string[]>();
  let lines: string[] = [];
  let size = 0;
  let total = 0;
  let count = 0;
  const flush = async () => {
    if (!lines.length) return;
    rows.push(await immutablePut(bucket,
      `${snapshotNamespace(SNAPSHOT_PARSER_VERSION)}${plan.revision.commit}.rows.g${String(group).padStart(4, '0')}.${String(rows.length).padStart(3, '0')}.jsonl`, encode(lines.join(''))));
    lines = [];
    size = 0;
  };
  const groupArtifact = plan.groups[group]!;
  function* files() {
    if (groupArtifact.singlePath) { yield { path: groupArtifact.singlePath, content: raw }; return; }
    for (const line of raw.split('\n')) if (line.trim()) yield JSON.parse(line) as { path: string; content: string };
  }
  for (const file of files()) {
    for (const row of rowsForFile({ ...file, date: plan.revision.date })) {
      const rowLine = `${JSON.stringify(row)}\n`;
      const len = Buffer.byteLength(rowLine, 'utf8');
      if (len > MAX_FILE_BYTES) throw new Error(`snapshot row exceeds read bound: ${row.id}`);
      if (size && size + len > partBytes) await flush();
      lines.push(rowLine);
      size += len;
      const partition = PARTITIONS.find((prefix) => row.id.startsWith(prefix));
      if (!partition) throw new Error(`unrecognized snapshot id: ${row.id}`);
      const entries = fragments.get(partition) ?? [];
      entries.push(indexLine({ id: row.id, fp: fingerprint(row), off: baseOffset + total, len }));
      fragments.set(partition, entries);
      total += len;
      count++;
    }
  }
  await flush();
  const outputs: GroupResult['fragments'] = [];
  for (const [partition, entries] of fragments) {
    outputs.push({ partition, artifact: await immutablePut(bucket,
      `${stagingPrefix(plan.revision.commit)}index-${partition}-${group}.jsonl`, encode(entries.join(''))) });
  }
  return { partBytes, rows, fragments: outputs, count, bytes: total };
}

/** Each tree is sorted on its own. An explicit ceiling fails closed if the
 * corpus outgrows this bounded in-memory index sort. Rows are never collected. */
export async function sortIndexPartition(bucket: BuildBucket, commit: string, partition: string,
  groups: GroupResult[]): Promise<IndexPartition> {
  const fragments = groups.flatMap((group) => group.fragments.filter((fragment) => fragment.partition === partition).map((fragment) => fragment.artifact));
  const total = fragments.reduce((sum, fragment) => sum + fragment.bytes, 0);
  if (total > MAX_INDEX_PARTITION_BYTES) throw new Error(`index partition exceeds bounded sort: ${partition}`);
  const lines: string[] = [];
  for (const fragment of fragments) {
    const text = new TextDecoder().decode(await artifactBytes(bucket, fragment));
    for (const line of text.split('\n')) if (line.trim()) lines.push(line);
  }
  // JSON starts with {"id":"; raw lexical order is the id order for ASCII ids.
  lines.sort();
  let previous = '';
  for (const line of lines) {
    const entry = JSON.parse(line) as SnapshotIndexEntry;
    if (entry.id <= previous) throw new Error(`duplicate or unordered snapshot id: ${entry.id}`);
    previous = entry.id;
  }
  const artifact = await immutablePut(bucket,
    `${stagingPrefix(commit)}sorted-${partition}.jsonl`, encode(lines.length ? `${lines.join('\n')}\n` : ''));
  return { ...artifact, count: lines.length };
}

/** Publication is manifest-last. Every part is checked before the manifest
 * becomes visible, and a retry cannot overwrite an existing revision. */
export async function publishSnapshot(bucket: BuildBucket, plan: StagePlan, groups: GroupResult[],
  partitions: IndexPartition[]): Promise<SnapshotManifest> {
  const rows = groups.flatMap((group) => group.rows);
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  const bytes = groups.reduce((sum, group) => sum + group.bytes, 0);
  const indexBytes = partitions.reduce((sum, partition) => sum + partition.bytes, 0);
  if (!count || indexBytes > MAX_INDEX_BYTES) throw new Error('snapshot is empty or index exceeds publication bound');
  if (partitions.reduce((sum, partition) => sum + partition.count, 0) !== count) throw new Error('snapshot index count mismatch');
  for (const part of rows) {
    const head = await bucket.head(part.key);
    if (head?.size !== part.bytes || head.customMetadata?.sha256 !== part.sha256) throw new Error(`snapshot part unavailable: ${part.key}`);
  }
  const joined = new Uint8Array(indexBytes);
  const digester = new IndexDigester();
  let at = 0;
  let previous = '';
  for (const partition of partitions) {
    const part = await artifactBytes(bucket, partition);
    joined.set(part, at);
    at += part.length;
    // Scan one partition at a time without splitting the complete index.
    const text = new TextDecoder().decode(part);
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end === -1) break;
      const entry = JSON.parse(text.slice(start, end)) as SnapshotIndexEntry;
      if (entry.id <= previous) throw new Error(`snapshot index is not in id order: ${entry.id}`);
      if (entry.off < 0 || entry.len <= 0 || entry.off + entry.len > bytes) throw new Error(`snapshot offset outside rows: ${entry.id}`);
      previous = entry.id;
      digester.add(entry);
      start = end + 1;
    }
  }
  const index = await immutablePut(bucket, indexKey(plan.revision.commit, SNAPSHOT_PARSER_VERSION), joined);
  const digest = digester.digest();
  const manifest: SnapshotManifest = {
    format: SNAPSHOT_FORMAT, commit: plan.revision.commit, parser: SNAPSHOT_PARSER_VERSION, date: plan.revision.date,
    rows: { count, bytes, partBytes: groups[0]!.partBytes, parts: rows },
    index: { ...index, entries: count, digest },
  };
  parseManifest(JSON.stringify(manifest));
  await immutablePut(bucket, manifestKey(plan.revision.commit, SNAPSHOT_PARSER_VERSION), encode(JSON.stringify(manifest)));
  return manifest;
}

/** Only staging data belonging to this revision is eligible for deletion. */
export async function cleanupStaging(bucket: BuildBucket, commit: string): Promise<void> {
  for (;;) {
    const page = await bucket.list({ prefix: stagingPrefix(commit), limit: 500 });
    if (!page.objects.length) return;
    await bucket.delete(page.objects.map((object) => object.key));
  }
}
