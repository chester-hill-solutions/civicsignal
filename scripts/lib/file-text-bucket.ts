import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_PROVISION_TEXT_BYTES, provisionTextKey, type TextObjectReader } from '../../src/corpora/text-store';
import type { TextCutoverManifest } from '../prepare-text-cutover';

export interface PackedTextLocation { objectKey: string; contentSha256: string; bytes: number; packOffset?: number }

/** A local R2 read boundary. Packed objects share one descriptor and are read
 * only at their checked offsets; nothing materializes the full text pack. */
export class FileTextBucket implements TextObjectReader {
  private constructor(private readonly directory: string, private readonly manifest: TextCutoverManifest,
    private readonly locate: (key: string) => PackedTextLocation | undefined, private readonly pack?: FileHandle) {}

  static async open(directory: string, manifest: TextCutoverManifest, locate: (key: string) => PackedTextLocation | undefined) {
    return new FileTextBucket(directory, manifest, locate, manifest.objectStorage === 'pack' ? await open(join(directory, 'objects.pack'), 'r') : undefined);
  }

  async close() { await this.pack?.close(); }

  async get(key: string) {
    const location = this.locate(key);
    if (!location) return null;
    if (key !== location.objectKey || key !== provisionTextKey(location.contentSha256) || !Number.isSafeInteger(location.bytes) ||
        location.bytes < 1 || location.bytes > MAX_PROVISION_TEXT_BYTES) throw new Error('Invalid local text object location.');
    let bytes: Uint8Array<ArrayBuffer>;
    if (this.pack) {
      const offset = location.packOffset;
      if (!Number.isSafeInteger(offset) || offset! < 0 || offset! + location.bytes > this.manifest.objectsBytes) throw new Error('Invalid local text object range.');
      bytes = new Uint8Array(location.bytes);
      let filled = 0;
      while (filled < bytes.byteLength) {
        const read = await this.pack.read(bytes, filled, bytes.byteLength - filled, offset! + filled);
        if (!read.bytesRead) throw new Error('Truncated local text object pack.');
        filled += read.bytesRead;
      }
    } else {
      const path = join(this.directory, 'objects', key);
      if ((await stat(path)).size !== location.bytes) throw new Error('Local text object size mismatch.');
      bytes = new Uint8Array(await readFile(path));
    }
    return { size: bytes.byteLength, body: new Response(bytes).body! };
  }
}
