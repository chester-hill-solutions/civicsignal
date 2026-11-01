import type { TextObjectBucket } from '../../src/corpora/text-store';

export function memoryTextBucket() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  let reads = 0;
  let writes = 0;
  const bucket: TextObjectBucket = {
    async get(key) {
      reads++;
      const data = objects.get(key);
      return data ? { size: data.byteLength, body: new Response(data.slice()).body! } : null;
    },
    async put(key, bytes, options) {
      writes++;
      if (objects.has(key) && options.onlyIf.etagDoesNotMatch === '*') return null;
      objects.set(key, bytes.slice());
      return {};
    },
  };
  return { bucket, objects, reads: () => reads, writes: () => writes };
}
