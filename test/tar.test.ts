import { describe, expect, it } from 'vitest';
import { readTar } from '../src/ingest/source';

/**
 * The tar reader.
 *
 * The pipeline streams the corpus's tree rather than extracting it, so this is
 * the piece that decides whether the pipeline needs a gigabyte of disk or none.
 * The format is old and simple, and the ways it goes wrong are all in the
 * padding and the name handling, so those are what is tested here.
 */

/**
 * Build a tar archive in memory.
 *
 * A name longer than 100 bytes cannot go in the name field, so the format has
 * two ways to carry it: the ustar prefix field, and the GNU long-name entry.
 * This helper writes the GNU one, because that is the interesting path.
 */
function tar(entries: { name: string; content?: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    if (entry.name.length > 100) {
      const nameBytes = Buffer.from(entry.name + '\0', 'utf8');
      blocks.push(tarHeader('././@LongLink', nameBytes.length, 'L'));
      blocks.push(nameBytes);
      const padding = (512 - (nameBytes.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
    const header = tarHeader(entry.name.slice(0, 100), content.length, entry.type ?? '0');
    blocks.push(header);
    if (content.length) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** One tar header block. */
function tarHeader(name: string, size: number, type: string): Buffer {
  {
    const content = Buffer.from('', 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write(type, 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    // The checksum is computed with the checksum field itself read as spaces.
    header.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    return header;
  }
}

async function* chunks(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buffer.length; i += size) {
    yield buffer.subarray(i, i + size);
  }
}

async function readAll(buffer: Buffer, chunkSize = 512): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for await (const entry of readTar(chunks(buffer, chunkSize))) {
    out.push({ path: entry.path, content: entry.content.toString('utf8') });
  }
  return out;
}

describe('the tar reader', () => {
  it('reads a file', async () => {
    const entries = await readAll(tar([{ name: 'eng/acts/C-34.xml', content: '<Statute/>' }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('eng/acts/C-34.xml');
    expect(entries[0]!.content).toBe('<Statute/>');
  });

  it('reads several files in order', async () => {
    const entries = await readAll(
      tar([
        { name: 'a.xml', content: 'one' },
        { name: 'b.xml', content: 'two' },
        { name: 'c.xml', content: 'three' },
      ]),
    );
    expect(entries.map((e) => e.content)).toEqual(['one', 'two', 'three']);
  });

  it('skips directories', async () => {
    const entries = await readAll(
      tar([
        { name: 'eng/', type: '5' },
        { name: 'eng/acts/', type: '5' },
        { name: 'eng/acts/C-34.xml', content: 'x' },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('eng/acts/C-34.xml');
  });

  /**
   * The content is padded to the block size, and the padding is not part of the
   * file. Getting it wrong means every file after the first has trailing nulls,
   * which the XML parser tolerates and the text hash does not.
   */
  it('strips the padding', async () => {
    const entries = await readAll(tar([{ name: 'a.xml', content: 'x'.repeat(600) }]));
    expect(entries[0]!.content).toHaveLength(600);
    expect(entries[0]!.content).not.toContain('\0');
  });

  it('reads a file that spans several chunks', async () => {
    const content = 'y'.repeat(5000);
    const entries = await readAll(tar([{ name: 'big.xml', content }]), 512);
    expect(entries[0]!.content).toHaveLength(5000);
  });

  it('reads the same archive at any chunk size', async () => {
    const archive = tar([
      { name: 'a.xml', content: 'one' },
      { name: 'b.xml', content: 'two'.repeat(1000) },
      { name: 'c.xml', content: 'three' },
    ]);
    const reference = await readAll(archive, 512);
    for (const size of [512, 1024, 4096, 65536]) {
      const entries = await readAll(archive, size);
      expect(entries).toEqual(reference);
    }
  });

  it('reads an empty file', async () => {
    const entries = await readAll(tar([{ name: 'empty.xml', content: '' }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe('');
  });

  /**
   * The corpus's own paths are long enough that some of them need a long-name
   * entry, and the archive uses the GNU form.
   */
  it('reads a long name', async () => {
    const name = `laws-lois-xml-main/eng/regulations/${'a'.repeat(90)}.xml`;
    const entries = await readAll(tar([{ name, content: 'x' }]));
    expect(entries[0]!.path).toBe(name);
  });

  it('stops at the end-of-archive marker', async () => {
    const entries = await readAll(
      tar([
        { name: 'a.xml', content: 'one' },
        { name: 'b.xml', content: 'two' },
      ]),
    );
    expect(entries).toHaveLength(2);
  });

  it('reads the corpus archive itself', async () => {
    // The real archive, if it is on disk. It is not fetched by the test; it is
    // whatever the last local run left behind.
    const { existsSync, readFileSync } = await import('node:fs');
    const path = '/tmp/corpus.tar.gz';
    if (!existsSync(path)) return;
    const { gunzipSync } = await import('node:zlib');
    const raw = gunzipSync(readFileSync(path));
    let xml = 0;
    let english = 0;
    for await (const entry of readTar(chunks(raw, 1 << 20))) {
      if (!entry.path.endsWith('.xml')) continue;
      xml++;
      const normalised = entry.path.replace(/^[^/]+\//, '');
      if (normalised.startsWith('eng/acts/') || normalised.startsWith('eng/regulations/')) english++;
    }
    expect(xml).toBeGreaterThan(15000);
    expect(english).toBe(5868);
  });
});
