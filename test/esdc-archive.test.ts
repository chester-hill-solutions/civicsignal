import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readEsdcInventory } from '../services/funding/esdc/archive';
import type { FundingInventory } from '../src/corpora/funding';

const observedAt = '2026-11-25T14:00:00.000Z';
const indexes = {
  en: 'https://www.canada.ca/en/employment-social-development/services/funding/programs.html',
  fr: 'https://www.canada.ca/fr/emploi-developpement-social/services/financement/programmes.html',
};
const requested = 'https://canada.ca/detail', resolved = 'https://www.canada.ca/en/detail';
const missing = 'https://www.canada.ca/fr/missing';
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const terminalKey = `funding/esdc/observations/${observedAt}/pages/${sha(missing)}.json`;
function fixture() {
  const bodies = new Map<string, string>();
  const sources = [indexes.en, indexes.fr, requested, 'https://www.canada.ca/extra'].map(url => {
    const body = `<html>${url}</html>`, digest = sha(body);
    bodies.set(`funding/esdc/sources/${digest}.html`, body);
    return { url, resolvedUrl: url === requested ? resolved : url, sha256: digest, bytes: Buffer.byteLength(body), etag: null, lastModified: null };
  });
  const packet: FundingInventory = { source: 'esdc', observedAt, indexes: { ...indexes }, sources,
    records: [{ id: 'esdc-grant', language: 'en', title: 'Grant', url: requested, status: 'open', statusText: null,
      availability: 'published', sections: [{ field: 'overview', heading: 'Terms', text: 'Cited text', url: resolved + '#terms' }] }],
    gaps: [{ id: 'esdc-grant', language: 'en', url: missing, reason: 'confirmed-detail-http-404' },
      { id: 'esdc-grant', language: 'fr', url: missing, reason: 'No unique counterpart established from the independently listed calls and publisher language links.' }] };
  bodies.set(terminalKey, JSON.stringify({ url: missing, status: 404 }));
  const requestedKeys: string[] = [];
  const bucket = { async get(key: string) {
    requestedKeys.push(key);
    const value = bodies.get(key);
    if (value === undefined) return null;
    const bytes = Uint8Array.from(new TextEncoder().encode(value));
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  } };
  function checkpoint() {
    const encoded = JSON.stringify(packet), sha256 = sha(encoded), key = `funding/esdc/inventories/${sha256}.json`;
    bodies.set(key, encoded);
    return { key, sha256, bytes: Buffer.byteLength(encoded), sources: sources.length,
      sourceBytes: sources.reduce((sum, file) => sum + file.bytes, 0) };
  }
  return { packet, bodies, sources, bucket, checkpoint, requestedKeys };
}

describe('ESDC archived acquisition', () => {
  it('verifies the inventory, every distinct original, redirect citations and an observation-specific terminal checkpoint', async () => {
    const f = fixture();
    expect(await readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).toEqual(f.packet);
    expect(f.requestedKeys.sort()).toEqual([...f.bodies.keys()].sort());
  });
  it('checks uncited objects and their lengths as well as hashes', async () => {
    const f = fixture(), ref = f.checkpoint(), file = f.sources[3];
    const key = `funding/esdc/sources/${file.sha256}.html`;
    f.bodies.delete(key);
    await expect(readEsdcInventory(f.bucket, ref, observedAt)).rejects.toThrow('Missing or truncated');
    f.bodies.set(key, 'x'.repeat(file.bytes));
    await expect(readEsdcInventory(f.bucket, ref, observedAt)).rejects.toThrow('checksum mismatch');
  });
  it('rejects a corrupt packet, swapped observation, unpinned archive key, and count mismatch', async () => {
    const f = fixture(), ref = f.checkpoint();
    await expect(readEsdcInventory(f.bucket, { ...ref, key: 'funding/nserc/inventories/' + ref.sha256 + '.json' }, observedAt)).rejects.toThrow('inventory key');
    await expect(readEsdcInventory(f.bucket, ref, '2026-11-24T01:00:00Z')).rejects.toThrow('acquisition checkpoint');
    await expect(readEsdcInventory(f.bucket, { ...ref, sources: ref.sources + 1 }, observedAt)).rejects.toThrow('acquisition checkpoint');
    f.bodies.set(ref.key, ' '.repeat(ref.bytes));
    await expect(readEsdcInventory(f.bucket, ref, observedAt)).rejects.toThrow('checksum mismatch');
  });
  it('requires the official indexes and government originals, including redirect destinations', async () => {
    const f = fixture();
    f.packet.indexes.en = requested;
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('official indexes');
    f.packet.indexes.en = indexes.en;
    f.sources[2].resolvedUrl = 'https://canada.ca.example.org/publisher';
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('publisher URL');
  });
  it('keeps terminal HTTP evidence scoped to the edition gap and verifies status and original URL', async () => {
    const f = fixture();
    f.bodies.delete(terminalKey);
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('Missing ESDC terminal');
    for (const marker of [{ url: missing, status: 410 }, { url: resolved, status: 404 }]) {
      f.bodies.set(terminalKey, JSON.stringify(marker));
      await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('HTTP checkpoint mismatch');
    }
    f.packet.gaps[1].id = 'esdc-unrelated';
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('Unaccounted ESDC gap');
  });
  it('rejects published citations to a terminal page or to an unobserved government alias', async () => {
    const f = fixture();
    f.packet.records[0].sections[0].url = missing;
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('unarchived page');
    f.packet.records[0].sections[0].url = 'https://canada.ca/en/detail';
    await expect(readEsdcInventory(f.bucket, f.checkpoint(), observedAt)).rejects.toThrow('unarchived page');
  });
});
