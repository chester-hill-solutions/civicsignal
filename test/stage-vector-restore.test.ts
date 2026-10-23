import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint } from '../src/ingest/reconcile';
import { indexDigest } from '../src/ingest/snapshot-format';
import type { PipelineRow } from '../src/ingest/pipeline';
import { applyStageVectorPlan, assertStageVectorTarget, prepareStageVectorPlan, restoreVectors, StageVectorApi, STAGE_ACCOUNT, type RestoreVector, type StageVectorTarget, type StageVectorTransport } from '../scripts/lib/stage-vector-restore';

const revision = 'a'.repeat(40);
const target: StageVectorTarget = { account: STAGE_ACCOUNT, index: 'civicsignal-v1-stage-statutes-20261022', metric: 'cosine' };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(count = 4) {
  const directory = await mkdtemp(join(tmpdir(), 'stage-vector-restore-')); directories.push(directory);
  const rows: PipelineRow[] = Array.from({ length: count }, (_, at) => ({ id: `acts-${at === count - 1 ? 'fr' : 'en'}-${String(at).padStart(4, '0')}`, corpusId: 'statutes-canada', instrument: 'Fixture Act', citation: 'F-1', section: String(at),
    heading: 'Fixture', text: at === 1 ? '[Reserved]' : 'A substantive bilingual provision é.', status: at === 1 ? 'placeholder' : 'in-force',
    schedule: null, part: null, source_url: 'https://example.test', in_force: 1, language: at === count - 1 ? 'fr' : 'en', embedText: '', lastChanged: '2026-10-15' }));
  let offset = 0;
  const entries = rows.map(row => { const line = JSON.stringify(row) + '\n'; const entry = { id: row.id, fp: fingerprint(row), off: offset, len: Buffer.byteLength(line) }; offset += entry.len; return entry; });
  const rowName = `${revision}.rows.000.jsonl`;
  const manifest = { format: 1, commit: revision, date: '2026-10-15', rows: { count, bytes: offset, partBytes: 67108864, parts: [{ key: rowName, bytes: offset }] }, index: { key: `${revision}.index.jsonl`, bytes: Buffer.byteLength(entries.map(entry => JSON.stringify(entry) + '\n').join('')), entries: count } };
  const vectors = { format: 1, commit: revision, dims: 768, count, bytes: count * 768 * 4,
    parts: [{ key: `${revision}.vectors.000.f32`, bytes: count * 768 * 4, from: 0, count }], index: { entries: count, digest: indexDigest(entries) }, embedded: count - 1, notEmbedded: 1 };
  const store = Buffer.alloc(16 + count * 768 * 4);
  store.writeUInt32LE(0x43535356, 0); store.writeUInt32LE(count, 4); store.writeUInt32LE(768, 8);
  for (let row = 0; row < count; row++) if (row !== 1) store.writeFloatLE(0.5, 16 + row * 768 * 4);
  const files: Record<string, Buffer> = {
    [`${revision}.manifest.json`]: Buffer.from(JSON.stringify(manifest)), [`${revision}.vectors.manifest.json`]: Buffer.from(JSON.stringify(vectors)),
    [`${revision}.index.jsonl`]: Buffer.from(entries.map(entry => JSON.stringify(entry) + '\n').join('')),
    [rowName]: Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join('')), [`${revision}.store.emb`]: store,
  };
  const receipt = { format: 1, source: { commit: revision, date: '2026-10-15', parser: 'legacy', indexDigest: vectors.index.digest, rows: count, embedded: count - 1, placeholders: 1, dimensions: 768 },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])),
    verification: { allRows: true, rows: count, allVectorPositions: true, finite: true, placeholderZeros: true } };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  const receiptPath = join(directory, 'receipt.json');
  const seal = async () => { for (const name of Object.keys(files)) { const bytes = await readFile(join(directory, name)); receipt.files[name] = { bytes: bytes.length, sha256: hash(bytes) }; } const bytes = JSON.stringify(receipt); await writeFile(receiptPath, bytes); return hash(bytes); };
  const receiptSha256 = await seal();
  return { directory, receipt, receiptPath, receiptSha256, store, entries, seal,
    prepare: (pin = receiptSha256) => prepareStageVectorPlan({ directory, revision, receipt: receiptPath, receiptSha256: pin }) };
}

function fakeApi(options: { mismatch?: boolean; loseAck?: boolean; metric?: string; initial?: number } = {}) {
  const held = new Map<string, RestoreVector>();
  let writes = 0; let requests = 0; let lose = options.loseAck ?? false;
  const send: StageVectorTransport = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    expect(url.hostname).toBe('api.cloudflare.com'); expect(url.pathname).toContain(`/${target.account}/vectorize/v2/indexes/${target.index}`);
    if (url.pathname.endsWith('/info')) return Response.json({ success: true, result: { dimensions: 768, vectorCount: held.size + (options.initial ?? 0) } });
    if (url.pathname.endsWith('/upsert')) {
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-ndjson');
      const vectors = String(init?.body).trim().split('\n').map(line => JSON.parse(line) as RestoreVector);
      expect(vectors.length).toBeLessThanOrEqual(100); writes++;
      for (const vector of vectors) held.set(vector.id, vector);
      if (lose) { lose = false; throw new Error('Synthetic response loss after commit'); }
      return Response.json({ success: true, result: { mutationId: `mutation-${writes}` } });
    }
    if (url.pathname.endsWith('/get_by_ids')) {
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      expect(body.ids.length).toBeLessThanOrEqual(20);
      return Response.json({ success: true, result: body.ids.flatMap(id => {
        const vector = held.get(id); if (!vector) return [];
        return [{ ...vector, metadata: { ...vector.metadata, ...(options.mismatch ? { fingerprint: 'wrong' } : {}) } }];
      }) });
    }
    return Response.json({ success: true, result: { name: target.index, created_on: '2026-10-23T00:00:00Z', config: { dimensions: 768, metric: options.metric ?? 'cosine' } } });
  };
  return { api: new StageVectorApi(target, () => 'synthetic-fixture-token', send, async () => {}), held, writes: () => writes, requests: () => requests };
}

describe('stage-only vector restore', () => {
  it('validates values/IDs/metadata, skips only verified placeholders and restores all substantive vectors', async () => {
    const test = await fixture(); const plan = await test.prepare();
    expect(plan.rows.filter(row => row.placeholder)).toHaveLength(1);
    const api = fakeApi();
    const result = await applyStageVectorPlan(plan, api.api, { journal: join(test.directory, 'journal.json'), maxBatches: 1 });
    expect(result).toMatchObject({ complete: true, verifiedVectors: 3, documentEmbeddings: 0 });
    expect(api.held.size).toBe(3); expect(api.held.has('acts-en-0001')).toBe(false);
    expect(api.held.get('acts-fr-0003')?.metadata.language).toBe('fr');
    expect(api.held.get('acts-en-0000')).toEqual({ id: 'acts-en-0000', values: [0.5, ...Array(767).fill(0)], metadata: { language: 'en', jurisdiction: 'CA', fingerprint: test.entries[0]!.fp } });
  });
  it('rejects production account/index names before token access or network', () => {
    let tokens = 0;
    expect(() => new StageVectorApi({ ...target, index: 'civicsignal-statutes-gemma' }, () => { tokens++; return ''; })).toThrow('production');
    expect(() => assertStageVectorTarget({ ...target, account: 'b'.repeat(32) })).toThrow();
    expect(() => assertStageVectorTarget({ ...target, index: 'civicsignal-other-stage' })).toThrow();
    expect(tokens).toBe(0);
  });
  it('rejects a changed artifact/receipt before any network write', async () => {
    const test = await fixture(); const api = fakeApi();
    await writeFile(join(test.directory, `${revision}.index.jsonl`), 'corrupt');
    await expect(test.prepare()).rejects.toThrow('hash mismatch'); expect(api.requests()).toBe(0);
    await expect(test.prepare('0'.repeat(64))).rejects.toThrow('receipt SHA-256');
  });
  it('independently refuses bad float values even if receipt verification booleans claim success', async () => {
    const test = await fixture(); test.store.writeFloatLE(Number.NaN, 16);
    await writeFile(join(test.directory, `${revision}.store.emb`), test.store);
    await expect(test.prepare(await test.seal())).rejects.toThrow('Non-finite');
  });
  it('independently refuses zero substantive vectors even with resealed artifact hashes', async () => {
    const test = await fixture(); test.store.writeFloatLE(0, 16);
    await writeFile(join(test.directory, `${revision}.store.emb`), test.store);
    await expect(test.prepare(await test.seal())).rejects.toThrow('Only verified placeholders');
  });
  it('refuses an index fingerprint mismatch despite freshly resealed file hashes', async () => {
    const test = await fixture();
    const entries = test.entries.map((entry, at) => ({ ...entry, fp: at ? entry.fp : '0'.repeat(32) }));
    await writeFile(join(test.directory, `${revision}.index.jsonl`), entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    await expect(test.prepare(await test.seal())).rejects.toThrow('fingerprint mismatch');
  });
  it('checks the actual descriptor metric and empty target before any upsert', async () => {
    const test = await fixture(); const plan = await test.prepare();
    const wrong = fakeApi({ metric: 'dot-product' });
    await expect(applyStageVectorPlan(plan, wrong.api, { journal: join(test.directory, 'wrong.json'), maxBatches: 1 })).rejects.toThrow('descriptor');
    expect(wrong.writes()).toBe(0);
    const populated = fakeApi({ initial: 1 });
    await expect(applyStageVectorPlan(plan, populated.api, { journal: join(test.directory, 'populated.json'), maxBatches: 1 })).rejects.toThrow('count differs');
    expect(populated.writes()).toBe(0);
  });
  it('replays identical upserts after an acknowledgement loss without duplicate IDs', async () => {
    const test = await fixture(); const plan = await test.prepare(); const api = fakeApi({ loseAck: true });
    expect((await applyStageVectorPlan(plan, api.api, { journal: join(test.directory, 'journal.json'), maxBatches: 1 })).complete).toBe(true);
    expect(api.writes()).toBe(2); expect(api.held.size).toBe(3);
  });
  it('journals a pending batch until actual metadata/value readback succeeds', async () => {
    const test = await fixture(); const plan = await test.prepare(); const options = { mismatch: true }; const api = fakeApi(options); const journal = join(test.directory, 'journal.json');
    await expect(applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).rejects.toThrow('readback');
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ nextPosition: 0, verifiedVectors: 0, pending: { mutationId: 'mutation-1' } });
    options.mismatch = false;
    expect((await applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).complete).toBe(true);
    expect(api.writes()).toBe(1);
  });
  it('rejects a stale complete journal when values or fingerprints have since changed, without overwriting them', async () => {
    const test = await fixture(); const plan = await test.prepare(); const options = { mismatch: false }; const api = fakeApi(options); const journal = join(test.directory, 'journal.json');
    await applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 });
    options.mismatch = true;
    await expect(applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).rejects.toThrow('readback');
    expect(api.writes()).toBe(1);
  });
  it('rejects edited checkpoint counts rather than silently skipping vector verification', async () => {
    const test = await fixture(); const plan = await test.prepare(); const api = fakeApi(); const journal = join(test.directory, 'journal.json');
    await applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 });
    const data = JSON.parse(await readFile(journal, 'utf8')); data.verifiedVectors = 999;
    await writeFile(journal, JSON.stringify(data));
    await expect(applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).rejects.toThrow('checkpoint counts');
    expect(api.writes()).toBe(1);
  });
  it('bounds work and resumes at a verified checkpoint with the same immutable source', async () => {
    const test = await fixture(105); const plan = await test.prepare(); const api = fakeApi(); const journal = join(test.directory, 'journal.json');
    expect(await applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).toMatchObject({ complete: false, nextPosition: 100, verifiedVectors: 99 });
    expect(await applyStageVectorPlan(plan, api.api, { journal, maxBatches: 1 })).toMatchObject({ complete: true, nextPosition: 105, verifiedVectors: 104 });
    expect(api.writes()).toBe(2);
    const held = await restoreVectors(plan, plan.rows.slice(100)); expect(held).toHaveLength(5);
  });
});
