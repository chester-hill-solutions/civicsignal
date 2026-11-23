import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifySnapshotArtifacts } from '../scripts/lib/verify-snapshot-artifacts';
import type { PipelineRow } from '../src/ingest/pipeline';
import { fingerprint } from '../src/ingest/reconcile';
import {
  DEFAULT_PART_BYTES, indexDigest, indexKey, indexLine, manifestKey, partKey,
  SNAPSHOT_FORMAT, SNAPSHOT_PARSER_VERSION, snapshotNamespace, type SnapshotManifest,
} from '../src/ingest/snapshot-format';

const commit = 'a'.repeat(40);
const parser = SNAPSHOT_PARSER_VERSION;
const date = '2026-11-16';
const canonicalKey = manifestKey('b'.repeat(40), parser);
const canonicalBody = Buffer.from('{"prior":"complete"}');
const index = indexKey(commit, parser);
const manifest = manifestKey(commit, parser);
const rowKeys = [0, 1].map(position => snapshotNamespace(parser) + partKey(commit, position));
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

function provision(id: string, text: string, language: PipelineRow['language']): PipelineRow {
  return {
    id, text, language, corpusId: 'statutes-canada', instrument: 'Short Titles Act',
    citation: 'A-1', section: '1', status: 'in-force', schedule: null, part: null, heading: 'Short title',
    source_url: 'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
    in_force: 1, embedText: text, lastChanged: date,
  };
}

function snapshot(options: { rowFault?: 'extra' | 'blank' | 'split-whitespace'; indexFault?: 'offset' | 'digest' | 'count' } = {}) {
  const rows = [provision('acts-en-1', 'Short title', 'en'), provision('acts-fr-1', 'Éditeur officiel', 'fr')];
  const files = new Map<string, Buffer>();
  const entries: Parameters<typeof indexLine>[0][] = [];
  let offset = 0;
  const parts = rowKeys.map((key, position) => {
    const row = rows[position]!;
    let line = JSON.stringify(row) + '\n';
    if (position === 0 && options.rowFault === 'blank') line = '\n';
    if (position === 0 && options.rowFault === 'split-whitespace') line = ' \t\r \t\n';
    const payload = options.rowFault === 'extra' && position === 0 ? line + line : line;
    const body = Buffer.from(payload);
    files.set(key, body);
    entries.push({ id: row.id, fp: fingerprint(row), off: offset, len: Buffer.byteLength(line) });
    offset += body.length;
    return { key, bytes: body.length, sha256: hash(body) };
  });
  if (options.indexFault === 'offset') entries[0]!.off++;
  if (options.indexFault === 'count') entries.pop();
  const indexBody = Buffer.from(entries.map(indexLine).join(''));
  files.set(index, indexBody);
  const metadata: SnapshotManifest = {
    format: SNAPSHOT_FORMAT, commit, parser, date,
    rows: { count: rows.length, bytes: offset, partBytes: DEFAULT_PART_BYTES, parts },
    index: {
      key: index, bytes: indexBody.length, entries: rows.length, sha256: hash(indexBody),
      digest: options.indexFault === 'digest' ? 'b'.repeat(32) : indexDigest(entries),
    },
  };
  const body = Buffer.from(JSON.stringify(metadata));
  files.set(manifest, body);
  const reference = {
    commit, parser, date, manifest: { key: manifest, bytes: body.length, sha256: hash(body) },
    artifacts: files.size, artifactBytes: body.length + indexBody.length + offset, rows: rows.length,
  };
  const budget = { maxOperations: reference.artifacts, maxResponseBytes: reference.artifactBytes, wallMs: 10_000, requestMs: 1_000 };
  const calls: string[] = [];
  const open = async (key: string, _signal: AbortSignal) => {
    calls.push(key);
    const file = files.get(key);
    if (!file) throw new Error('fixture object missing');
    return chunks(file);
  };
  return { files, reference, budget, calls, open };
}

function chunks(file: Buffer) {
  const accent = file.indexOf(0xc3);
  const split = accent < 0 ? Math.floor(file.length / 2) : accent + 1;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(file.subarray(0, split));
      controller.enqueue(file.subarray(split));
      controller.close();
    },
  });
}

const canonical = { key: canonicalKey, bytes: canonicalBody.length, sha256: hash(canonicalBody) };

function budgetWithCanonical(budget: ReturnType<typeof snapshot>['budget']) {
  return { ...budget, maxOperations: budget.maxOperations + 2, maxResponseBytes: budget.maxResponseBytes + 2 * canonical.bytes };
}

describe('snapshot artifact verification', () => {
  it('verifies each artifact once and brackets the checks with the two canonical reads', async () => {
    const fixture = snapshot();
    let canonicalReads = 0;
    const open = async (key: string, signal: AbortSignal) => {
      if (key !== canonicalKey) return fixture.open(key, signal);
      canonicalReads++;
      fixture.calls.push(key);
      return chunks(canonicalBody);
    };
    await expect(verifySnapshotArtifacts({ ...fixture, open, canonical, budget: budgetWithCanonical(fixture.budget) })).resolves.toEqual({
      artifacts: fixture.reference.artifacts, artifactBytes: fixture.reference.artifactBytes,
      rows: 2, manifestSha256: fixture.reference.manifest.sha256,
      canonical: { sha256: canonical.sha256, bytes: canonical.bytes },
    });
    expect(canonicalReads).toBe(2);
    expect(fixture.calls.at(0)).toBe(canonicalKey);
    expect(fixture.calls.at(1)).toBe(manifest);
    expect(fixture.calls.at(-1)).toBe(canonicalKey);
    expect(fixture.calls.slice(1, -1).sort()).toEqual([...fixture.files.keys()].sort());
  });

  it('accepts the same snapshot at the exact artifact-only budget', async () => {
    const fixture = snapshot();
    await expect(verifySnapshotArtifacts(fixture)).resolves.toEqual({
      artifacts: 4, artifactBytes: fixture.reference.artifactBytes, rows: 2, manifestSha256: fixture.reference.manifest.sha256,
    });
    expect(fixture.calls.at(0)).toBe(manifest);
    expect([...fixture.calls].sort()).toEqual([...fixture.files.keys()].sort());
  });

  it('rejects an unpinned manifest before following its artifact keys', async () => {
    const fixture = snapshot();
    fixture.files.set(manifest, Buffer.alloc(fixture.reference.manifest.bytes, 0x78));
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow('SNAPSHOT_ARTIFACT_SHA256');
    expect(fixture.calls).toEqual([manifest]);
  });

  it('cancels an oversized body without waiting for the stream to finish', async () => {
    const fixture = snapshot();
    let cancelled = 0;
    const open = async (key: string, _signal: AbortSignal) => {
      fixture.calls.push(key);
      return new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.alloc(fixture.reference.manifest.bytes + 1)); },
        cancel() { cancelled++; },
      });
    };
    await expect(verifySnapshotArtifacts({ ...fixture, open })).rejects.toThrow('SNAPSHOT_ARTIFACT_SIZE');
    expect(fixture.calls).toEqual([manifest]);
    expect(cancelled).toBe(1);
  });

  it.each(['missing', 'truncated', 'substituted', 'oversized'] as const)('refuses a %s row part without retrying', async fault => {
    const fixture = snapshot();
    const key = rowKeys[0]!;
    const body = fixture.files.get(key)!;
    if (fault === 'missing') fixture.files.delete(key);
    if (fault === 'truncated') fixture.files.set(key, body.subarray(0, body.length - 1));
    if (fault === 'substituted') fixture.files.set(key, Buffer.from(body.toString().replace('Short title', 'False title')));
    if (fault === 'oversized') fixture.files.set(key, Buffer.concat([body, Buffer.from('!')]));
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow();
    expect(fixture.calls.filter(call => call === key)).toHaveLength(1);
    expect(new Set(fixture.calls).size).toBe(fixture.calls.length);
  });

  it('counts row records even when all part sizes and checksums were pinned', async () => {
    const fixture = snapshot({ rowFault: 'extra' });
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow();
  });

  it.each(['blank', 'split-whitespace'] as const)('rejects a pinned %s row line', async rowFault => {
    const fixture = snapshot({ rowFault });
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow('SNAPSHOT_ARTIFACT_ROW_FRAMING');
    expect(fixture.calls).toContain(rowKeys[0]);
    expect(fixture.calls).not.toContain(index);
  });

  it.each(['offset', 'digest', 'count'] as const)('retains the index %s check with valid artifact sizes and hashes', async indexFault => {
    const fixture = snapshot({ indexFault });
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow();
    expect(fixture.calls.filter(key => key === index)).toHaveLength(1);
  });

  it.each(['length', 'hash'] as const)('checks the streamed index %s', async fault => {
    const fixture = snapshot();
    const body = fixture.files.get(index)!;
    fixture.files.set(index, fault === 'length' ? body.subarray(0, body.length - 1) : Buffer.from(body.toString().replace('acts-en-1', 'acts-en-0')));
    await expect(verifySnapshotArtifacts(fixture)).rejects.toThrow();
    expect(fixture.calls.filter(key => key === index)).toHaveLength(1);
  });

  it.each([1, 2])('rejects equal-length canonical drift on canonical read %i', async failOn => {
    const fixture = snapshot();
    let reads = 0;
    const open = async (key: string, signal: AbortSignal) => {
      if (key !== canonicalKey) return fixture.open(key, signal);
      fixture.calls.push(key);
      return chunks(++reads === failOn ? Buffer.alloc(canonical.bytes, 0x78) : canonicalBody);
    };
    await expect(verifySnapshotArtifacts({ ...fixture, open, canonical, budget: budgetWithCanonical(fixture.budget) })).rejects.toThrow();
    expect(reads).toBe(failOn);
    if (failOn === 1) expect(fixture.calls).toEqual([canonicalKey]);
    else expect(fixture.calls.slice(1, -1).sort()).toEqual([...fixture.files.keys()].sort());
  });

  it.each(['maxOperations', 'maxResponseBytes'] as const)('refuses a %s shortfall and keeps both canonical reads inside the same budget', async cap => {
    const fixture = snapshot();
    const budget = budgetWithCanonical(fixture.budget);
    budget[cap]--;
    const open = async (key: string, signal: AbortSignal) => {
      if (key !== canonicalKey) return fixture.open(key, signal);
      fixture.calls.push(key);
      return chunks(canonicalBody);
    };
    await expect(verifySnapshotArtifacts({ ...fixture, open, canonical, budget })).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it.each(['request', 'wall'] as const)('aborts a stalled read at its %s deadline without another open', async kind => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const fixture = snapshot();
      const signals: AbortSignal[] = [];
      let cancelled = 0;
      const open = async (key: string, signal: AbortSignal) => {
        fixture.calls.push(key);
        signals.push(signal);
        return new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
      };
      const budget = { ...fixture.budget, wallMs: kind === 'wall' ? 25 : 1_000, requestMs: kind === 'request' ? 25 : 1_000 };
      const refused = expect(verifySnapshotArtifacts({ ...fixture, open, budget })).rejects.toThrow('SNAPSHOT_ARTIFACT_DEADLINE');
      await vi.advanceTimersByTimeAsync(25);
      await refused;
      expect(fixture.calls).toEqual([manifest]);
      expect(signals[0]?.aborted).toBe(true);
      expect(cancelled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a late body after timing out its open without replaying the request', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const fixture = snapshot();
      let resolveBody!: (value: ReadableStream<Uint8Array>) => void;
      const pending = new Promise<ReadableStream<Uint8Array>>(resolve => { resolveBody = resolve; });
      const signals: AbortSignal[] = [];
      const open = (key: string, signal: AbortSignal) => {
        fixture.calls.push(key);
        signals.push(signal);
        return pending;
      };
      const refused = expect(verifySnapshotArtifacts({ ...fixture, open, budget: { ...fixture.budget, requestMs: 25 } }))
        .rejects.toThrow('SNAPSHOT_ARTIFACT_DEADLINE');
      await vi.advanceTimersByTimeAsync(25);
      await refused;
      let cancelled = 0;
      resolveBody(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.calls).toEqual([manifest]);
      expect(signals[0]?.aborted).toBe(true);
      expect(cancelled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
