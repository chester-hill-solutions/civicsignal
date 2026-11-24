import { crc32 } from 'node:zlib';

/**
 * The one entry in the GEDS archive.
 *
 * The official download is a ZIP with a single CSV. We read the local header,
 * take exactly the compressed bytes it names, and hand them to
 * `DecompressionStream('deflate-raw')`. That keeps the 245 MB payload out of
 * memory on the way in; only the 11 MB compressed archive is held whole.
 *
 * The central directory is not consulted. The export uses a conventional local
 * header with both sizes filled in (flag 0), and the reader refuses a header it
 * cannot trust rather than guessing.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  checksum: number;
  dataStart: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export function readFirstZipEntry(bytes: Uint8Array): ZipEntry {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || header.getUint32(0, true) !== 0x04034b50) {
    throw new ZipError('not a ZIP archive (missing local file header)');
  }
  const flags = header.getUint16(6, true);
  const method = header.getUint16(8, true);
  const checksum = header.getUint32(14, true);
  const compressedSize = header.getUint32(18, true);
  const uncompressedSize = header.getUint32(22, true);
  const nameLength = header.getUint16(26, true);
  const extraLength = header.getUint16(28, true);
  const nameStart = 30;
  const name = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameStart + nameLength));
  const dataStart = nameStart + nameLength + extraLength;

  if (flags & 0x0008) {
    throw new ZipError('ZIP entry uses a data descriptor; compressed size is not in the local header');
  }
  if (!compressedSize && uncompressedSize) {
    throw new ZipError('ZIP entry has no compressed size');
  }
  if (method !== 0 && method !== 8) {
    throw new ZipError(`unsupported ZIP compression method ${method}`);
  }
  if (dataStart + compressedSize > bytes.length) {
    throw new ZipError('ZIP entry runs past the end of the archive');
  }
  return { name, method, compressedSize, uncompressedSize, checksum, dataStart };
}

/** The decompressed CSV as a byte stream, suitable for `gedsRows`. */
export function openFirstZipEntry(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const entry = readFirstZipEntry(bytes);
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  const csv = entry.method === 0 ? source : source.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  let length = 0;
  let checksum = 0;
  return csv.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > entry.uncompressedSize) throw new ZipError('CSV exceeds its declared size');
      checksum = crc32(chunk, checksum);
      controller.enqueue(chunk);
    },
    flush() {
      if (length !== entry.uncompressedSize || checksum !== entry.checksum) throw new ZipError('CSV size or CRC mismatch');
    },
  }));
}

/** For diagnostics: a ZIP's first entry name without decompressing it. */
export function firstZipEntryName(bytes: Uint8Array): string {
  return readFirstZipEntry(bytes).name;
}
