import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SnapshotReader } from '../../src/ingest/snapshot-source';
import { IndexDigester, parseVectorsManifest } from '../../src/ingest/snapshot-format';
import type { SnapshotIndexEntry } from '../../src/ingest/snapshot-diff';
import { FileSnapshotBucket } from './file-snapshot';

export const STAGE_ACCOUNT = 'ad5ec479b9a421faa2ed06c3d1c2b23a';
export const STAGE_VECTOR_PREFIX = 'civicsignal-v1-stage-statutes-';
export type VectorMetric = 'cosine' | 'euclidean' | 'dot-product';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const receiptSchema = z.object({
  format: z.literal(1),
  source: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), date: z.string(), parser: z.literal('legacy'),
    indexDigest: z.string().regex(/^[a-f0-9]{32}$/), rows: positive, embedded: z.number().int().nonnegative(),
    placeholders: z.number().int().nonnegative(), dimensions: z.literal(768) }),
  files: z.record(z.string(), z.object({ bytes: positive, sha256: digest })),
  verification: z.object({ allRows: z.literal(true), rows: positive, allVectorPositions: z.literal(true),
    finite: z.literal(true), placeholderZeros: z.literal(true) }),
});
export interface StageVectorTarget { account: string; index: string; metric: VectorMetric }
export interface StageVectorRow { id: string; position: number; metadata: { language: 'en' | 'fr'; jurisdiction: 'CA'; fingerprint: string }; placeholder: boolean }
export interface StageVectorPlan { receiptSha256: string; source: z.infer<typeof receiptSchema>['source']; storePath: string; storeSha256: string; rows: StageVectorRow[] }
export interface RestoreVector { id: string; values: number[]; metadata: StageVectorRow['metadata'] }

export function assertStageVectorTarget(target: StageVectorTarget): void {
  if (target.account !== STAGE_ACCOUNT || target.index === 'civicsignal-statutes-gemma' ||
    !/^civicsignal-v1-stage-statutes-\d{8}$/.test(target.index) ||
    !['cosine', 'euclidean', 'dot-product'].includes(target.metric)) throw new Error('An explicit approved stage account/index/metric is required; production is forbidden.');
}

async function hashFile(path: string): Promise<string> {
  const result = createHash('sha256');
  const file = await open(path, 'r');
  const bytes = Buffer.alloc(1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const read = await file.read(bytes, 0, bytes.length, offset);
      if (!read.bytesRead) break;
      result.update(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead;
    }
    return result.digest('hex');
  } finally { await file.close(); }
}

/** No credentials/network. Verify all immutable inputs and every row/vector before restore. */
export async function prepareStageVectorPlan(options: { directory: string; revision: string; receipt: string; receiptSha256: string;
  progress?: (message: string) => void }): Promise<StageVectorPlan> {
  if (!/^[a-f0-9]{40}$/.test(options.revision) || !/^[a-f0-9]{64}$/.test(options.receiptSha256)) throw new Error('Full revision and receipt SHA-256 are required.');
  const receiptBytes = await readFile(options.receipt);
  if (sha(receiptBytes) !== options.receiptSha256) throw new Error('Legacy receipt SHA-256 mismatch.');
  const receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString('utf8')));
  const source = receipt.source;
  if (source.commit !== options.revision || source.rows !== source.embedded + source.placeholders || receipt.verification.rows !== source.rows) throw new Error('Legacy receipt source/count identity mismatch.');
  for (const [name, expected] of Object.entries(receipt.files)) {
    if (!new RegExp(`^${options.revision}\\.(?:manifest\\.json|vectors\\.manifest\\.json|index\\.jsonl|rows\\.\\d+\\.jsonl|store\\.emb)$`).test(name)) throw new Error('Invalid legacy artifact path.');
    options.progress?.(`Checking pinned legacy artifact ${name}.`);
    const path = join(options.directory, name);
    if ((await lstat(path)).isSymbolicLink() || (await stat(path)).size !== expected.bytes || await hashFile(path) !== expected.sha256) throw new Error(`Legacy artifact bytes/hash mismatch: ${name}`);
  }
  const reader = new SnapshotReader(new FileSnapshotBucket(options.directory), options.revision);
  const manifest = await reader.manifest();
  const vectorManifestName = `${options.revision}.vectors.manifest.json`;
  const vectors = parseVectorsManifest(await readFile(join(options.directory, vectorManifestName), 'utf8'));
  const required = [`${options.revision}.manifest.json`, manifest.index.key, vectorManifestName, ...manifest.rows.parts.map(part => part.key), `${options.revision}.store.emb`];
  if (required.some(name => !receipt.files[name]) || Object.keys(receipt.files).length !== required.length) throw new Error('Legacy receipt must cover exactly both manifests, index, every row part and assembled store.');
  if (manifest.parser !== undefined || vectors.parser !== undefined || manifest.commit !== source.commit || vectors.commit !== source.commit ||
    manifest.date !== source.date || manifest.rows.count !== source.rows || vectors.count !== source.rows || vectors.dims !== source.dimensions ||
    vectors.index.digest !== source.indexDigest || vectors.embedded !== source.embedded || vectors.notEmbedded !== source.placeholders) throw new Error('Legacy manifest/receipt identity mismatch.');
  const storePath = join(options.directory, `${options.revision}.store.emb`);
  const store = await open(storePath, 'r');
  const rows: StageVectorRow[] = [];
  const indexDigest = new IndexDigester();
  let position = 0;
  let placeholders = 0;
  try {
    const header = Buffer.alloc(16);
    if ((await store.read(header, 0, 16, 0)).bytesRead !== 16 || header.readUInt32LE(0) !== 0x43535356 ||
      header.readUInt32LE(4) !== source.rows || header.readUInt32LE(8) !== source.dimensions || header.readUInt32LE(12) !== 0 ||
      (await store.stat()).size !== 16 + source.rows * source.dimensions * 4) throw new Error('Legacy vector store header/size mismatch.');
    let pending: SnapshotIndexEntry[] = [];
    const flush = async () => {
      const found = await reader.rows(pending);
      if (found.length !== pending.length) throw new Error('Missing indexed legacy row.');
      const bytes = Buffer.alloc(pending.length * source.dimensions * 4);
      if ((await store.read(bytes, 0, bytes.length, 16 + position * source.dimensions * 4)).bytesRead !== bytes.length) throw new Error('Truncated legacy vector payload.');
      for (let at = 0; at < pending.length; at++) {
        const row = found[at]!; const entry = pending[at]!;
        if (row.id !== entry.id || row.corpusId !== 'statutes-canada' || !['en', 'fr'].includes(row.language) || row.id.length > 64) throw new Error('Legacy row identity/language is invalid for Vectorize.');
        let zero = true;
        for (let dim = 0; dim < source.dimensions; dim++) {
          const value = bytes.readFloatLE((at * source.dimensions + dim) * 4);
          if (!Number.isFinite(value)) throw new Error('Non-finite legacy vector value.');
          if (value !== 0) zero = false;
        }
        const placeholder = row.status === 'placeholder';
        if (zero !== placeholder) throw new Error(`Only verified placeholders may have zero vectors: ${row.id}`);
        if (placeholder) placeholders++;
        rows.push({ id: row.id, position: position + at, placeholder,
          metadata: { language: row.language === 'en' ? 'en' : 'fr', jurisdiction: 'CA', fingerprint: entry.fp } });
      }
      position += pending.length;
      if (position % 10000 === 0) options.progress?.(`Verified ${position} legacy row/vector pairs.`);
      pending = [];
    };
    for await (const entry of reader.indexEntries()) {
      indexDigest.add(entry); pending.push(entry);
      if (pending.length === 500) await flush();
    }
    if (pending.length) await flush();
  } finally { await store.close(); }
  if (position !== source.rows || placeholders !== source.placeholders || indexDigest.digest() !== source.indexDigest) throw new Error('Legacy ordered index/vector/placeholder count mismatch.');
  return { receiptSha256: options.receiptSha256, source, storePath,
    storeSha256: receipt.files[`${options.revision}.store.emb`]!.sha256, rows };
}

export async function restoreVectors(plan: StageVectorPlan, selected: readonly StageVectorRow[]): Promise<RestoreVector[]> {
  const file = await open(plan.storePath, 'r');
  try {
    const result: RestoreVector[] = [];
    for (const row of selected) {
      if (row.placeholder) continue;
      const bytes = Buffer.alloc(plan.source.dimensions * 4);
      if ((await file.read(bytes, 0, bytes.length, 16 + row.position * bytes.length)).bytesRead !== bytes.length) throw new Error('Truncated vector during restore.');
      const values = Array.from({ length: plan.source.dimensions }, (_, dim) => bytes.readFloatLE(dim * 4));
      if (values.some(value => !Number.isFinite(value)) || values.every(value => value === 0)) throw new Error('Invalid restore vector.');
      result.push({ id: row.id, values, metadata: row.metadata });
    }
    return result;
  } finally { await file.close(); }
}

export interface StageVectorRequest { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'error'; signal?: AbortSignal }
export type StageVectorTransport = (input: string, init?: StageVectorRequest) => Promise<Response>;

export class StageVectorApi {
  constructor(readonly target: StageVectorTarget, private readonly authToken: () => string,
    private readonly send: StageVectorTransport = (input, init) => fetch(input, init), private readonly pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    assertStageVectorTarget(target);
  }
  private async request<T>(suffix: string, init: StageVectorRequest = {}): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers = { ...init.headers, Authorization: `Bearer ${this.authToken()}` };
        const response = await this.send(`https://api.cloudflare.com/client/v4/accounts/${this.target.account}/vectorize/v2/indexes/${this.target.index}${suffix}`,
          { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 2) { await this.pause(250 * 2 ** attempt); continue; }
        }
        const body = await response.json() as { success?: boolean; result?: T };
        if (!response.ok || body.success !== true || body.result === undefined) throw new Error(`Vectorize request failed (${response.status}); inspect operator credentials and target.`);
        return body.result;
      } catch (error) {
        if (attempt === 2) throw new Error(error instanceof Error && error.message.startsWith('Vectorize request failed') ? error.message : 'Vectorize transport/response failure; rerun with the same journal.');
        await this.pause(250 * 2 ** attempt);
      }
    }
    throw new Error('Vectorize attempts exhausted.');
  }
  descriptor() { return this.request<{ name?: string; created_on?: string; config?: { dimensions?: number; metric?: string } }>(''); }
  info() { return this.request<{ dimensions?: number; vectorCount?: number; processedUpToMutation?: string }>('/info'); }
  async upsert(vectors: readonly RestoreVector[]): Promise<string> {
    if (!vectors.length || vectors.length > 100) throw new Error('Restore upsert batch must contain 1 to 100 vectors.');
    const body = vectors.map(vector => JSON.stringify(vector)).join('\n') + '\n';
    const result = await this.request<{ mutationId?: string }>('/upsert?unparsable-behavior=error', { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body });
    if (!result.mutationId) throw new Error('Vectorize upsert returned no mutation acknowledgement.');
    return result.mutationId;
  }
  async verify(vectors: readonly RestoreVector[]): Promise<void> {
    for (let at = 0; at < vectors.length; at += 20) {
      const chunk = vectors.slice(at, at + 20);
      let verified = false;
      for (let poll = 0; poll < 12; poll++) {
        const actual = await this.request<{ id?: string; values?: number[]; metadata?: Record<string, unknown> }[]>('/get_by_ids', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: chunk.map(vector => vector.id), returnValues: true }),
        });
        const byId = new Map(actual.map(vector => [vector.id, vector]));
        verified = actual.length === chunk.length && byId.size === chunk.length && chunk.every(expected => {
          const vector = byId.get(expected.id);
          return vector?.values?.length === expected.values.length && vector.values.every((value, dim) => Number.isFinite(value) && Math.fround(value) === expected.values[dim]) &&
            Object.entries(expected.metadata).every(([key, value]) => vector.metadata?.[key] === value);
        });
        if (verified) break;
        if (poll < 11) await this.pause(5000);
      }
      if (!verified) throw new Error('Stage vector readback did not match values/IDs/fingerprints/language/jurisdiction within the bounded visibility window.');
    }
  }
  async requireCount(count: number): Promise<void> {
    for (let poll = 0; poll < 12; poll++) {
      const info = await this.info();
      if (info.dimensions !== 768 || !Number.isSafeInteger(info.vectorCount)) throw new Error('Invalid Vectorize info descriptor.');
      if (info.vectorCount === count) return;
      if (poll < 11) await this.pause(5000);
    }
    throw new Error('Stage index count differs from the verified baseline.');
  }
}

const pendingSchema = z.object({ from: z.number().int().nonnegative(), through: positive, digest,
  mutationId: z.string().min(1).optional(), acknowledgedAt: z.string().datetime().optional() });
const journalFields = { identity: z.string(), account: z.string(), index: z.string(), createdOn: z.string(),
  nextPosition: z.number().int().nonnegative(), verifiedVectors: z.number().int().nonnegative(), complete: z.boolean() };
const legacyJournalSchema = z.object({ ...journalFields, format: z.literal(1), pending: pendingSchema.optional() });
const windowJournalSchema = z.object({ ...journalFields, format: z.literal(2), pending: z.array(pendingSchema).max(100) });
const journalSchema = z.discriminatedUnion('format', [legacyJournalSchema, windowJournalSchema]);
type WindowJournal = z.infer<typeof windowJournalSchema>;

/** Sync before rename and sync its directory before a network send/checkpoint acknowledgement. */
async function saveJournal(path: string, journal: WindowJournal) {
  const temporary = `${path}.next-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(journal, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Resume only the same target creation and artifact identity; readbacks precede checkpoints. */
export async function applyStageVectorPlan(plan: StageVectorPlan, api: StageVectorApi, options: { journal: string; maxBatches: number;
  pendingWindow?: number; progress?: (message: string) => void }) {
  assertStageVectorTarget(api.target);
  if (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 3000) throw new Error('maxBatches must be 1 to 3000.');
  const window = options.pendingWindow ?? 1;
  if (!Number.isSafeInteger(window) || window < 1 || window > 100) throw new Error('pendingWindow must be 1 to 100.');
  const descriptor = await api.descriptor();
  if (descriptor.name !== api.target.index || descriptor.config?.dimensions !== plan.source.dimensions || descriptor.config.metric !== api.target.metric || !descriptor.created_on) throw new Error('Stage index descriptor/name/dimensions/metric/creation identity mismatch.');
  const identity = sha(JSON.stringify({ receipt: plan.receiptSha256, store: plan.storeSha256, source: plan.source, target: api.target, createdOn: descriptor.created_on }));
  let journal: WindowJournal;
  try {
    const decoded = journalSchema.parse(JSON.parse(await readFile(options.journal, 'utf8')));
    journal = decoded.format === 1 ? { ...decoded, format: 2, pending: decoded.pending ? [decoded.pending] : [] } : decoded;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await api.requireCount(0);
    journal = { format: 2, identity, account: api.target.account, index: api.target.index, createdOn: descriptor.created_on,
      nextPosition: 0, verifiedVectors: 0, pending: [], complete: false };
  }
  if (journal.identity !== identity || journal.account !== api.target.account || journal.index !== api.target.index || journal.createdOn !== descriptor.created_on || journal.nextPosition > plan.source.rows) throw new Error('Stage restore journal target/artifact identity mismatch.');
  if ((journal.nextPosition !== plan.source.rows && journal.nextPosition % 100 !== 0) ||
    journal.verifiedVectors !== plan.rows.slice(0, journal.nextPosition).filter(row => !row.placeholder).length ||
    (journal.complete && (journal.nextPosition !== plan.source.rows || journal.pending.length))) throw new Error('Invalid stage restore checkpoint counts.');
  let through = journal.nextPosition;
  // Validate every pending range and digest before any new write, including when
  // the operator resumes with a smaller window than was previously submitted.
  for (const [at, pending] of journal.pending.entries()) {
    if (through >= plan.source.rows || pending.from !== through || pending.through !== Math.min(plan.source.rows, through + 100)) throw new Error('Pending restore ranges are not the exact contiguous source positions.');
    const vectors = await restoreVectors(plan, plan.rows.slice(pending.from, pending.through));
    if (pending.digest !== sha(JSON.stringify(vectors)) || pending.acknowledgedAt && !pending.mutationId ||
      !vectors.length && pending.mutationId || vectors.length && !pending.mutationId && at !== journal.pending.length - 1) throw new Error('Pending restore batch differs from verified source or acknowledgement order.');
    through = pending.through;
  }
  if (journal.complete) {
    // A completed journal never overwrites a later pipeline revision. Recheck
    // the current values/metadata rather than treating an old receipt as live proof.
    for (let at = 0; at < plan.rows.length; at += 100) await api.verify(await restoreVectors(plan, plan.rows.slice(at, at + 100)));
    await api.requireCount(plan.source.embedded);
    return { complete: true, nextPosition: journal.nextPosition, verifiedVectors: journal.verifiedVectors, batches: 0,
      verifiedBatches: 0, pendingBatches: 0, receiptSha256: plan.receiptSha256, target: api.target, documentEmbeddings: 0, reverified: true };
  }
  const save = () => saveJournal(options.journal, journal);
  await save();
  let batches = 0;
  let verifiedBatches = 0;
  const submit = async (pending: z.infer<typeof pendingSchema>, vectors: RestoreVector[]) => {
    if (!vectors.length || pending.mutationId) return;
    if (batches >= options.maxBatches) throw new Error('The invocation submission allowance is exhausted.');
    // A call (including a replay after uncertain transport) consumes one logical
    // submission. Its existing bounded REST retries still send identical values.
    batches++;
    pending.mutationId = await api.upsert(vectors);
    pending.acknowledgedAt = new Date().toISOString();
    await save();
    options.progress?.(`Acknowledged stage positions ${pending.from}-${pending.through}; pending batches ${journal.pending.length}.`);
  };
  const verifyOldest = async () => {
    const pending = journal.pending[0]!;
    const vectors = await restoreVectors(plan, plan.rows.slice(pending.from, pending.through));
    await submit(pending, vectors);
    if (vectors.length) await api.verify(vectors);
    journal.nextPosition = pending.through;
    journal.verifiedVectors += vectors.length;
    journal.pending.shift();
    await save();
    verifiedBatches++;
    options.progress?.(`Verified stage positions ${journal.nextPosition}/${plan.source.rows}; vectors ${journal.verifiedVectors}; pending batches ${journal.pending.length}.`);
  };
  // Drain prior acknowledgements first. They do not consume this invocation's
  // new-submission allowance, and no reset/re-upsert follows mere visibility lag.
  while (journal.pending.length) await verifyOldest();
  while (journal.nextPosition < plan.rows.length) {
    while (journal.pending.length < window && batches < options.maxBatches) {
      const from = journal.pending.at(-1)?.through ?? journal.nextPosition;
      if (from === plan.rows.length) break;
      const next = Math.min(plan.rows.length, from + 100);
      const vectors = await restoreVectors(plan, plan.rows.slice(from, next));
      const pending = { from, through: next, digest: sha(JSON.stringify(vectors)) };
      journal.pending.push(pending);
      await save(); // The exact intended batch is durable before any POST.
      await submit(pending, vectors);
    }
    if (!journal.pending.length) break;
    await verifyOldest();
  }
  if (journal.nextPosition === plan.source.rows) {
    if (journal.pending.length || journal.verifiedVectors !== plan.source.embedded) throw new Error('Restored vector count differs from the receipt.');
    await api.requireCount(plan.source.embedded); journal.complete = true; await save();
  }
  return { complete: journal.complete, nextPosition: journal.nextPosition, verifiedVectors: journal.verifiedVectors, batches,
    verifiedBatches, pendingBatches: journal.pending.length, receiptSha256: plan.receiptSha256, target: api.target, documentEmbeddings: 0 };
}
