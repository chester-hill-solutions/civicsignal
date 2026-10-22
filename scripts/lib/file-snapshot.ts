/**
 * A snapshot, as a directory of files.
 *
 * The production snapshot lives in R2, and the pipeline reads it through the
 * bucket interface. But a **script** wants to read what `build-snapshot.ts`
 * just wrote, before it is published — and a check that could only run against
 * R2 would be a check nobody runs.
 *
 * So this is a bucket over a directory: `get(key)` is a file, and `get(key,
 * {range})` is a file read from an offset. Same interface, same range logic,
 * same rows out. If the two ever disagree, the interface was the thing that
 * was wrong.
 *
 * The body is streamed in megabyte chunks rather than read whole, because the
 * whole point of the streaming read is that the twenty-four megabyte index is
 * never in memory at once — and a bucket that handed it over as one buffer
 * would put it back.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotBucket, SnapshotObject } from '../../src/ingest/snapshot-source';

/** How much of a file is read at a time when it is streamed. */
const CHUNK_BYTES = 1024 * 1024;

export class FileSnapshotBucket implements SnapshotBucket {
  constructor(private readonly directory: string) {}

  get(key: string): Promise<SnapshotObject | null>;
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<SnapshotObject | null>;
  async get(
    key: string,
    options?: { range: { offset: number; length: number } },
  ): Promise<SnapshotObject | null> {
    const path = join(this.directory, key);
    if (!existsSync(path)) return null;

    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const offset = options?.range.offset ?? 0;
      const length = options?.range.length ?? size - offset;

      if (options?.range) {
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, offset);
        const bytes = buffer.subarray(0, read);
        return { arrayBuffer: async () => toArrayBuffer(bytes) };
      }

      // No range: a body to stream, and the whole file if one is asked for.
      let position = offset;
      let closed = false;
      const finish = () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      };
      return {
        arrayBuffer: async () => {
          const buffer = Buffer.alloc(length);
          const read = readSync(fd, buffer, 0, length, offset);
          return toArrayBuffer(buffer.subarray(0, read));
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (position >= offset + length) {
              finish();
              controller.close();
              return;
            }
            const size = Math.min(CHUNK_BYTES, offset + length - position);
            const buffer = Buffer.alloc(size);
            const read = readSync(fd, buffer, 0, size, position);
            if (read <= 0) {
              finish();
              controller.close();
              return;
            }
            position += read;
            controller.enqueue(new Uint8Array(buffer.subarray(0, read)));
          },
          cancel() {
            finish();
          },
        }),
      };
    } finally {
      // The stream holds the descriptor open until it is done; the range path
      // is finished with it here.
      if (options?.range) closeSync(fd);
    }
  }
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
