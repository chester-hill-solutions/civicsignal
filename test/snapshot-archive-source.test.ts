import { describe, expect, it, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readTar } from '../src/ingest/source';
import { checkedTarChunks, snapshotArchive, SNAPSHOT_LONGNAME_MAX_BYTES } from '../services/snapshot/archive-source';
import { MAX_FILE_BYTES, stageCorpus } from '../services/snapshot/builder';
import { archive, files, memoryBucket, revision } from './helpers/snapshot-qualification';

async function* single(value: Uint8Array) { yield value; }
async function consume(input: AsyncIterable<Uint8Array>) { for await (const _ of input) {} }
function advertisedHeader(size: number, type = '0') {
  const header = gunzipSync(archive()).subarray(0, 512).slice();
  header.write(size.toString(8).padStart(11, '0') + '\0', 124); header.write(type, 156); header.fill(32, 148, 156);
  header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return new Uint8Array(header);
}

describe('shared bounded snapshot archive framing', () => {
  it('checks complete framing across arbitrary chunk boundaries without altering parser bytes', async () => {
    const bytes = new Uint8Array(gunzipSync(archive())), selected = [];
    async function* chunks() { for (let at = 0; at < bytes.length; at += 37) yield bytes.subarray(at, at + 37); }
    const guarded = checkedTarChunks(chunks());
    for await (const file of readTar(guarded)) selected.push(file.content.toString('utf8'));
    await consume(guarded); expect(selected).toEqual(files.map(file => file.content));
  });
  it('reproduces the unguarded partial-read defect and refuses the same valid gzip before a stage plan can publish', async () => {
    const partial = new Uint8Array(gunzipSync(archive()).subarray(0, 1543)), old = [];
    for await (const file of readTar(single(partial))) old.push(file);
    expect(old).toHaveLength(1); // old reader silently accepts the truncated tail
    const h = memoryBucket(), send = vi.fn(async () => new Response(new Uint8Array(gzipSync(partial))));
    await expect(stageCorpus(h.bucket, snapshotArchive({ send }), revision)).rejects.toThrow('failed or is uncertain');
    expect(h.objects.size).toBe(0); // no final plan and no manifest
  });
  it.each([
    [MAX_FILE_BYTES + 1, '0'], [MAX_FILE_BYTES + 1, '\0'], [SNAPSHOT_LONGNAME_MAX_BYTES + 1, 'L'],
  ])('rejects oversized advertised entry size %i type %s before forwarding its header or requesting its body', async (size, type) => {
    let pulls = 0;
    async function* input() { pulls++; yield advertisedHeader(size as number, type as string); pulls++; throw new Error('body must not be requested'); }
    const guarded = checkedTarChunks(input());
    await expect(guarded.next()).rejects.toThrow('entry exceeds'); expect(pulls).toBe(1);
  });
  it.each(['header', 'body', 'padding', 'single-zero', 'no-zero', 'after-end', 'checksum', 'number', 'dangling-name'] as const)('refuses malformed tar framing: %s', async mode => {
    const valid = new Uint8Array(gunzipSync(archive())); let bytes: Uint8Array<ArrayBuffer> = valid;
    if (mode === 'header') bytes = valid.slice(0, 1031);
    if (mode === 'body') bytes = valid.slice(0, 1543);
    if (mode === 'padding') bytes = valid.slice(0, 1900);
    if (mode === 'single-zero') bytes = valid.slice(0, valid.length - 512);
    if (mode === 'no-zero') bytes = valid.slice(0, valid.length - 1024);
    if (mode === 'after-end') bytes = new Uint8Array([...valid, 1]);
    if (mode === 'checksum') { bytes = valid.slice(); bytes[0] ^= 1; }
    if (mode === 'number') { bytes = valid.slice(); bytes[124] = 57; }
    if (mode === 'dangling-name') bytes = new Uint8Array([...advertisedHeader(0, 'L'), ...new Uint8Array(1024)]);
    await expect(consume(checkedTarChunks(single(bytes)))).rejects.toThrow();
  });
  it('fails if compressed framing ends after one zero block even though the content parser already returned', async () => {
    const raw = gunzipSync(archive()).subarray(0, gunzipSync(archive()).length - 512);
    const send = vi.fn(async () => new Response(new Uint8Array(gzipSync(raw))));
    const selected = []; let failure = false;
    try { for await (const file of snapshotArchive({ send }).instruments(revision.commit, ['eng/', 'fra/'])) selected.push(file); }
    catch { failure = true; }
    expect(selected).toHaveLength(2); expect(failure).toBe(true); // cannot return a successful complete stage plan
  });
  it('rejects a split-NUL size in a complete gzip that otherwise hides a real entry from readTar', async () => {
    const raw = gunzipSync(archive()), header = Buffer.from(advertisedHeader(1, '5'));
    header.write('0000000000\0' + '1', 124); header.fill(32, 148, 156);
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    // A guard removing every NUL sees size1 and consumes the zero block as
    // body/padding. readTar sees size0 and stops at that block, losing file2.
    const split = new Uint8Array(Buffer.concat([raw.subarray(0, 1024), header, Buffer.alloc(512), raw.subarray(1024)]));
    const old = []; for await (const file of readTar(single(split))) old.push(file); expect(old).toHaveLength(1);
    const send = vi.fn(async () => new Response(new Uint8Array(gzipSync(split))));
    await expect(stageCorpus(memoryBucket().bucket, snapshotArchive({ send }), revision)).rejects.toThrow('failed or is uncertain');
    await expect(consume(checkedTarChunks(single(split)))).rejects.toThrow('numeric suffix');
  });
  it('checks its absolute deadline after an asynchronous admission with no timer opportunity', async () => {
    let clock = 0;
    const send = vi.fn(async () => new Response(archive()));
    const source = snapshotArchive({ timeoutMs: 5, monotonicNow: () => clock, beforeSend: async () => { clock = 20; }, send });
    await expect((async () => { for await (const _ of source.instruments(revision.commit, ['eng/'])) {} })()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('does not report success if the stream/drain completes after the absolute archive deadline', async () => {
    let clock = 0;
    const source = snapshotArchive({ timeoutMs: 100, monotonicNow: () => clock, send: async () => new Response(archive()) });
    let selected = 0;
    await expect((async () => { for await (const _ of source.instruments(revision.commit, ['eng/', 'fra/'])) { selected++; if (selected === 2) clock = 100; } })()).rejects.toThrow();
    expect(selected).toBe(2);
  });
});
