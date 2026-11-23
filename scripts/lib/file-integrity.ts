import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** Bounded reads also avoid long-lived Bun ReadStream stalls on large exports. */
export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  const file = await open(path, 'r');
  const buffer = new Uint8Array(1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.byteLength, offset);
      if (!read.bytesRead) break;
      digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
    }
    return digest.digest('hex');
  } finally { await file.close(); }
}
