#!/usr/bin/env bun
/** Local, non-destructive full-corpus verification. No Cloudflare credentials
 * or remote resources are used. The output directory is immutable per parser.
 * bun scripts/validate-snapshot-workflow.ts --corpus /path/to/clean/clone --out dist/snapshot-check
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stageCorpus, buildGroup, sortIndexPartition, publishSnapshot, PARTITIONS,
  type BuildBucket, type GroupResult, type IndexPartition } from '../services/snapshot/builder';
import { rowsForFile } from '../src/ingest/corpus-rows';
import { SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';
import type { CorpusSource } from '../src/ingest/source';

const arg = (flag: string) => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const corpusArg = arg('--corpus');
if (!corpusArg) throw new Error('--corpus must name a clean local justicecanada/laws-lois-xml clone');
const corpus = resolve(corpusArg);
const root = resolve(arg('--out') ?? `dist/snapshot-validation-${SNAPSHOT_PARSER_VERSION}`);
const git = (...args: string[]) => execFileSync('git', ['-C', corpus, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('local corpus has modifications; use a clean pinned clone');
const revision = { commit: git('rev-parse', 'HEAD'), date: git('show', '-s', '--format=%cs', 'HEAD') };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const parserSources = Object.fromEntries(await Promise.all(['statutes.ts', 'corpus-rows.ts', 'reconcile.ts'].map(async (name) =>
  [name, hash(await readFile(new URL(`../src/ingest/${name}`, import.meta.url)))])));
const parserSourceDigest = hash(JSON.stringify(parserSources));
const trees = ['eng/acts', 'eng/regulations', 'fra/lois', 'fra/reglements'];
const pathFor = (key: string) => {
  if (key.startsWith('/') || key.split('/').some((part) => part === '..')) throw new Error('artifact path escapes validation directory');
  return join(root, key);
};
const bucket: BuildBucket = {
  async head(key: string) {
    try { return { size: (await stat(pathFor(key))).size, customMetadata: JSON.parse(await readFile(`${pathFor(key)}.metadata.json`, 'utf8')) }; }
    catch { return null; }
  },
  async get(key: string, options?: R2GetOptions) {
    const file = Bun.file(pathFor(key));
    if (!await file.exists()) return null;
    const range = options?.range;
    if (range && !('offset' in range && 'length' in range)) throw new Error('local verifier supports offset+length ranges');
    const body = range ? file.slice(range.offset, range.offset! + range.length!) : file;
    return { arrayBuffer: () => body.arrayBuffer(), text: () => body.text(), body: body.stream() };
  },
  async put(key: string, value: unknown, options?: R2PutOptions) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (!(bytes instanceof Uint8Array)) throw new Error('local verifier only accepts bounded byte artifacts');
    await mkdir(dirname(pathFor(key)), { recursive: true });
    try { await writeFile(pathFor(key), bytes, { flag: options?.onlyIf ? 'wx' : 'w' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST' && options?.onlyIf) return null; throw error; }
    await writeFile(`${pathFor(key)}.metadata.json`, JSON.stringify(options?.customMetadata ?? {}));
    return { size: bytes.byteLength };
  },
  async list(options?: R2ListOptions) {
    const names = await readdir(root, { recursive: true });
    return { objects: names.filter((name) => name.startsWith(options?.prefix ?? '') && !name.endsWith('.metadata.json'))
      .slice(0, options?.limit ?? 500).map((key) => ({ key })) };
  },
  async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) { await unlink(pathFor(key)); await unlink(`${pathFor(key)}.metadata.json`); } },
} as unknown as BuildBucket; // File objects model the small R2 API subset used by the builder.

const source: CorpusSource = {
  head: async () => revision,
  async *instruments() {
    for (const tree of trees) for (const name of (await readdir(join(corpus, tree))).sort()) {
      if (name.endsWith('.xml')) yield { path: `${tree}/${name}`, content: await readFile(join(corpus, tree, name), 'utf8') };
    }
  },
  changedFiles: async () => { throw new Error('unused'); },
  fileAt: async () => { throw new Error('unused'); },
};
const started = performance.now();
await mkdir(root, { recursive: true });
const plan = await stageCorpus(bucket, source, revision);
console.log(JSON.stringify({ stage: 'staged', files: plan.files, groups: plan.groups.length }));
const groups: GroupResult[] = [];
let offset = 0;
for (let group = 0; group < plan.groups.length; group++) {
  const result = await buildGroup(bucket, plan, group, offset);
  groups.push(result);
  offset += result.bytes;
  if (group % 10 === 0) console.log(JSON.stringify({ stage: 'parsed', group, rows: groups.reduce((sum, item) => sum + item.count, 0) }));
}
const partitions: IndexPartition[] = [];
for (const partition of PARTITIONS) partitions.push(await sortIndexPartition(bucket, revision.commit, partition, groups));
const manifest = await publishSnapshot(bucket, plan, groups, partitions);
const buildMs = performance.now() - started;

// Construct a separate reference directly from every XML file. Compare every
// serialized row, including language/date fields outside the fingerprint, and
// every UTF-8 index offset/length. This is stronger than self-reading samples.
const expected = new Map<string, string>();
for await (const file of source.instruments(revision.commit)) for (const row of rowsForFile({ ...file, date: revision.date })) {
  if (expected.has(row.id)) throw new Error(`duplicate reference id: ${row.id}`);
  expected.set(row.id, hash(JSON.stringify(row)));
}
const index = new Map<string, { off: number; len: number }>();
for (const line of (await readFile(pathFor(manifest.index.key), 'utf8')).trim().split('\n')) {
  const entry = JSON.parse(line) as { id: string; off: number; len: number };
  index.set(entry.id, entry);
}
let checked = 0;
offset = 0;
for (const part of manifest.rows.parts) {
  const bytes = await readFile(pathFor(part.key));
  if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw new Error(`invalid part bytes: ${part.key}`);
  let local = 0;
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const row = JSON.parse(line) as { id: string };
    const entry = index.get(row.id);
    const length = Buffer.byteLength(`${line}\n`);
    if (!entry || entry.off !== offset + local || entry.len !== length || expected.get(row.id) !== hash(line)) throw new Error(`source/index/row parity failed: ${row.id}`);
    expected.delete(row.id);
    checked++;
    local += length;
  }
  offset += bytes.length;
}
if (expected.size || checked !== manifest.rows.count || checked !== index.size) throw new Error('reference or snapshot count mismatch');
const result = { revision, parser: SNAPSHOT_PARSER_VERSION, parserSourceDigest, parserSources, files: plan.files, groups: plan.groups.length,
  checked, exactRowJSON: true, allOffsets: true, allUTF8Lengths: true, rowBytes: manifest.rows.bytes,
  index: manifest.index, buildMs, totalMs: performance.now() - started,
  limitation: 'Local parity and timing; does not establish hosted Workers CPU or memory limits.' };
await writeFile(join(root, 'validation-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
