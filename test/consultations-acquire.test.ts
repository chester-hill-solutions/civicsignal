import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { acquireConsultationSources, readConsultationSources } from '../services/consultations/acquire';
import { memoryBucket } from './helpers/snapshot-qualification';

const csv = new Uint8Array(readFileSync('test/fixtures/consultations/catalogue.csv'));
const schema = new Uint8Array(readFileSync('test/fixtures/consultations/schema.json'));
const csvUrl = 'https://open.canada.ca/static/consultations_open.csv';
const schemaUrl = 'https://open.canada.ca/data/recombinant-published-schema/consultations.json';
const checksum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function publisher(csvResponse = () => new Response(csv), schemaResponse = () => new Response(schema)): typeof fetch {
  return async (url, init) => {
    expect(init?.redirect).toBe('manual');
    if (url === csvUrl) return csvResponse();
    if (url === schemaUrl) return schemaResponse();
    throw new Error('Unexpected source URL.');
  };
}

describe('scheduled consultation acquisition', () => {
  it('archives exact publisher bytes and reuses both originals on replay', async () => {
    const archive = memoryBucket();
    const refs = await acquireConsultationSources(archive.bucket, publisher());
    expect(refs.csv).toEqual({ input: csvUrl, archivedAs: `consultations/sources/${checksum(csv)}.csv`, bytes: csv.length, sha256: checksum(csv) });
    expect(refs.schema.sha256).toBe(checksum(schema));
    expect(archive.objects.get(refs.csv.archivedAs)?.bytes).toEqual(csv);
    await expect(readConsultationSources(archive.bucket, refs)).resolves.toEqual({
      csvText: new TextDecoder().decode(csv), dictionaryJson: JSON.parse(new TextDecoder().decode(schema)),
    });
    await expect(acquireConsultationSources(archive.bucket, publisher())).resolves.toEqual(refs);
    expect(archive.writes).toEqual([refs.csv.archivedAs, refs.schema.archivedAs]);
  });

  it('rejects substituted originals on archived replay and on a conditional write conflict', async () => {
    const archive = memoryBucket();
    const refs = await acquireConsultationSources(archive.bucket, publisher());
    const stored = archive.objects.get(refs.csv.archivedAs);
    if (!stored) throw new Error('Expected archived CSV.');
    stored.bytes[0] ^= 1;
    await expect(readConsultationSources(archive.bucket, refs)).rejects.toThrow('checksum mismatch');
    await expect(acquireConsultationSources(archive.bucket, publisher())).rejects.toThrow('checksum mismatch');
    expect(archive.writes).toHaveLength(2);
    const foreign = { ...refs, csv: { ...refs.csv, archivedAs: refs.schema.archivedAs } };
    await expect(readConsultationSources(archive.bucket, foreign)).rejects.toThrow('Invalid consultation archive reference');
  });

  it.each([302, 206, 503])('rejects HTTP %i before writing', async (status) => {
    const archive = memoryBucket();
    await expect(acquireConsultationSources(archive.bucket, publisher(() => new Response(csv, { status }))))
      .rejects.toThrow('Expected a complete consultation');
    expect(archive.writes).toHaveLength(0);
  });

  it('detects a short response and bounds a streamed dictionary without a length header', async () => {
    const archive = memoryBucket();
    await expect(acquireConsultationSources(archive.bucket, publisher(() => new Response(csv, {
      headers: { 'content-length': String(csv.length + 1) },
    })))).rejects.toThrow('Incomplete consultation source body');
    expect(archive.writes).toHaveLength(0);
    let cancelled = false;
    const oversized = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(96 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await expect(acquireConsultationSources(archive.bucket, publisher(undefined, oversized))).rejects.toThrow('byte limit');
    expect(cancelled).toBe(true);
    expect(archive.writes).toHaveLength(1);
  });

  it('refuses an error document or an unrelated dictionary before materialization', async () => {
    const archive = memoryBucket();
    const html = await acquireConsultationSources(archive.bucket, publisher(() => new Response('<html>unavailable</html>')));
    await expect(readConsultationSources(archive.bucket, html)).rejects.toThrow('Invalid consultation catalogue header');
    const empty = await acquireConsultationSources(archive.bucket, publisher(undefined, () => Response.json({ resources: [] })));
    await expect(readConsultationSources(archive.bucket, empty)).rejects.toThrow('Invalid consultation data dictionary');
  });
});
