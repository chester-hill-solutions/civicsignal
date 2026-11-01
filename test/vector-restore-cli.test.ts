import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { indexDigest, SNAPSHOT_PARSER_VERSION as parser, snapshotNamespace } from '../src/ingest/snapshot-format';

/** A same-size index with a changed fingerprint must fail before credential
 * loading or any remote fetch, in both supported parser identities. */
describe('vector restoration CLI identity gate', () => {
  it.each([undefined, parser])('refuses a same-count changed fingerprint before network (%s)', (selected) => {
    const dir = mkdtempSync(join(tmpdir(), 'civicsignal-vector-gate-'));
    const commit = 'a'.repeat(40);
    const prefix = `${snapshotNamespace(selected)}${commit}`;
    try {
      mkdirSync(join(dir, snapshotNamespace(selected)), { recursive: true });
      const entry = { id: 'acts-en-1', fp: 'new-fingerprint', off: 0, len: 1 };
      const index = `${JSON.stringify(entry)}\n`;
      const sha = createHash('sha256').update(index).digest('hex');
      writeFileSync(join(dir, `${prefix}.index.jsonl`), index);
      writeFileSync(join(dir, `${prefix}.manifest.json`), JSON.stringify({ format: 1, commit, parser: selected, date: '2026-10-22',
        rows: { count: 1, bytes: 1, partBytes: 1, parts: [{ key: `${prefix}.rows.000.jsonl`, bytes: 1, sha256: '0'.repeat(64) }] },
        index: { key: `${prefix}.index.jsonl`, bytes: Buffer.byteLength(index), entries: 1, digest: indexDigest([entry]), sha256: sha } }));
      writeFileSync(join(dir, `${prefix}.vectors.manifest.json`), JSON.stringify({ format: 1, commit, parser: selected, dims: 768,
        count: 1, bytes: 3072, parts: [{ key: `${prefix}.vectors.000.f32`, bytes: 3072, count: 1, from: 0, sha256: '0'.repeat(64) }],
        index: { entries: 1, digest: indexDigest([{ ...entry, fp: 'old-fingerprint' }]) }, embedded: 1, notEmbedded: 0 }));
      for (const script of ['build-vector-store.ts', 'check-stored-vectors.ts']) {
        const result = spawnSync('bun', [resolve('scripts', script), '--revision', commit, '--dir', dir, '--parser', selected ?? 'legacy'], { encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/exact snapshot index/);
        expect(result.stderr).not.toMatch(/token|ENOENT|fetch failed/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
