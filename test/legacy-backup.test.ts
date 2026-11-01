import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLegacyBackup } from '../scripts/verify-legacy-backup';
import { fingerprint } from '../src/ingest/reconcile';
import { indexDigest } from '../src/ingest/snapshot-format';
import type { PipelineRow } from '../src/ingest/pipeline';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'civicsignal-legacy-proof-'));
  directories.push(directory);
  const revision = 'a'.repeat(40);
  const rows: PipelineRow[] = [
    { id: 'acts-en-1', corpusId: 'statutes-canada', instrument: 'Test Act', citation: 'T-1', section: '1',
      status: 'in-force', schedule: null, part: null, heading: 'Provision', text: 'A verified provision.',
      source_url: 'https://example.test/1', in_force: 1, language: 'en', embedText: '', lastChanged: '2026-10-15' },
    { id: 'acts-fr-2', corpusId: 'statutes-canada', instrument: 'Loi de test', citation: 'T-1', section: '2',
      status: 'placeholder', schedule: null, part: null, heading: null, text: '[Amendment]',
      source_url: 'https://example.test/2', in_force: 1, language: 'fr', embedText: '', lastChanged: '2026-10-15' },
  ];
  let off = 0;
  const entries = rows.map((row) => {
    const len = Buffer.byteLength(JSON.stringify(row) + '\n');
    const entry = { id: row.id, fp: fingerprint(row), off, len }; off += len; return entry;
  });
  const rowKey = `${revision}.rows.000.jsonl`;
  const indexKey = `${revision}.index.jsonl`;
  const index = entries.map((entry) => JSON.stringify(entry) + '\n').join('');
  writeFileSync(join(directory, rowKey), rows.map((row) => JSON.stringify(row) + '\n').join(''));
  writeFileSync(join(directory, indexKey), index);
  writeFileSync(join(directory, `${revision}.manifest.json`), JSON.stringify({ format: 1, commit: revision, date: '2026-10-15',
    rows: { count: 2, bytes: off, partBytes: off, parts: [{ key: rowKey, bytes: off }] },
    index: { key: indexKey, bytes: Buffer.byteLength(index), entries: 2 } }));
  writeFileSync(join(directory, `${revision}.vectors.manifest.json`), JSON.stringify({ format: 1, commit: revision, dims: 768,
    count: 2, bytes: 6144, parts: [{ key: `${revision}.vectors.000.f32`, bytes: 6144, count: 2, from: 0 }],
    index: { entries: 2, digest: indexDigest(entries) }, embedded: 1, notEmbedded: 1 }));
  const store = Buffer.alloc(6160); store.writeUInt32LE(0x43535356); store.writeUInt32LE(2, 4); store.writeUInt32LE(768, 8);
  store.writeFloatLE(1, 16);
  const storePath = join(directory, `${revision}.store.emb`); writeFileSync(storePath, store);
  return { directory, revision, store, storePath, rowPath: join(directory, rowKey) };
}

describe('legacy backup local proof', () => {
  it('checks every fingerprint and vector position before sealing file hashes', async () => {
    const fixture = setup();
    const receipt = await verifyLegacyBackup(fixture);
    expect(receipt.source).toMatchObject({ rows: 2, embedded: 1, placeholders: 1, parser: 'legacy' });
    expect(receipt.verification.allVectorPositions).toBe(true);
    expect(receipt.files[`${fixture.revision}.store.emb`]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('refuses a changed provision behind the same index and byte count', async () => {
    const fixture = setup();
    writeFileSync(fixture.rowPath, readFileSync(fixture.rowPath, 'utf8').replace('verified', 'modified'));
    await expect(verifyLegacyBackup(fixture)).rejects.toThrow(/fingerprint/);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses a non-finite vector (%s)', async (value) => {
    const fixture = setup(); fixture.store.writeFloatLE(value, 16); writeFileSync(fixture.storePath, fixture.store);
    await expect(verifyLegacyBackup(fixture)).rejects.toThrow(/non-finite/);
  });
  it('refuses vector values at a placeholder position', async () => {
    const fixture = setup(); fixture.store.writeFloatLE(1, 16 + 3072); writeFileSync(fixture.storePath, fixture.store);
    await expect(verifyLegacyBackup(fixture)).rejects.toThrow(/placeholder/);
  });
});
