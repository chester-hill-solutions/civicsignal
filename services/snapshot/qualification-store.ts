import type { BuildBucket } from './builder';

export const QUALIFICATION_RECEIPT_BYTES = 2048;

/** Internal logical keys are exactly the existing builder's keys. R2 sees only
 * this qualification's physical prefix, including list cursors and cleanup. */
export function qualificationBucket(bucket: BuildBucket, prefix: string): BuildBucket {
  if (!/^qualifications\/[a-z][a-z0-9-]{0,39}\/[a-f0-9]{64}\/$/.test(prefix)) throw new Error('Invalid qualification namespace.');
  function physical(key: string) {
    if (typeof key !== 'string' || !key || key.length > 768 || key.startsWith('/') || key.includes('\\') || /[\x00-\x1f\x7f]/.test(key) ||
      key.split('/').some(part => part === '.' || part === '..') || !/^(snapshots\/statutes-v2\/|\.snapshot-staging\/statutes-v2\/)/.test(key)) {
      throw new Error('Qualification key is outside the builder namespace.');
    }
    return prefix + key;
  }
  const get: BuildBucket['get'] = (async (key: string, options?: R2GetOptions) => bucket.get(physical(key), options)) as BuildBucket['get'];
  const put: BuildBucket['put'] = (async (key: string, value: Parameters<BuildBucket['put']>[1], options?: R2PutOptions) =>
    bucket.put(physical(key), value, options)) as BuildBucket['put'];
  return {
    get, put,
    head: key => bucket.head(physical(key)),
    async list(options) {
      if (!options?.prefix || options.delimiter || options.startAfter) throw new Error('Qualification list requires an explicit builder prefix.');
      const expected = physical(options.prefix);
      // Cursors are opaque R2 continuations. Bind them to this exact prefix so
      // neither another qualification nor a different list can reuse one.
      let cursor: string | undefined;
      if (options.cursor) {
        let value: unknown;
        try { if (options.cursor.length > 8192) throw new Error(); value = JSON.parse(options.cursor); } catch { throw new Error('Invalid qualification cursor.'); }
        if (!Array.isArray(value) || value.length !== 2 || value[0] !== expected || typeof value[1] !== 'string') throw new Error('Foreign qualification cursor.');
        cursor = value[1];
      }
      const page = await bucket.list({ ...options, prefix: expected, cursor });
      const objects = page.objects.map(object => {
        if (!object.key.startsWith(expected)) throw new Error('R2 returned an object outside the qualification list.');
        const key = object.key.slice(prefix.length);
        physical(key);
        return { ...object, key };
      });
      if (page.delimitedPrefixes?.length) throw new Error('Unexpected qualification list delimiters.');
      const next = page.truncated ? JSON.stringify([expected, page.cursor]) : undefined;
      return { ...page, objects, ...(page.truncated ? { cursor: next! } : {}) } as R2Objects;
    },
    async delete(keys) {
      // Published parts and diagnostics never enter the deletion API.
      const values = typeof keys === 'string' ? [keys] : keys;
      if (values.some(key => !key.startsWith('.snapshot-staging/statutes-v2/'))) throw new Error('Qualification deletion is restricted to staging.');
      await bucket.delete(values.map(physical));
    },
  };
}

/** Conditional create + exact bounded readback. A false return is never
 * permission to repeat a side effect; an unknown acknowledgement fails closed. */
export async function qualificationReceipt(bucket: Pick<R2Bucket, 'put' | 'get'>, key: string, value: unknown): Promise<boolean> {
  const bytes = new TextEncoder().encode(JSON.stringify(value) + '\n');
  if (bytes.length > QUALIFICATION_RECEIPT_BYTES) throw new Error('Qualification receipt exceeds its bound.');
  const created = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  const stored = await bucket.get(key);
  if (!stored || stored.size !== bytes.length || stored.size > QUALIFICATION_RECEIPT_BYTES) throw new Error('Qualification receipt readback failed.');
  const actual = new Uint8Array(await stored.arrayBuffer());
  if (actual.length !== bytes.length || actual.some((value, i) => value !== bytes[i])) throw new Error('Qualification receipt identity conflict.');
  return created !== null && typeof created === 'object' && created.key === key && created.size === bytes.length;
}

export async function assertQualificationReceipt(bucket: Pick<R2Bucket, 'get'>, key: string, value: unknown) {
  const expected = new TextEncoder().encode(JSON.stringify(value) + '\n');
  const stored = await bucket.get(key);
  if (!stored || stored.size !== expected.length || stored.size > QUALIFICATION_RECEIPT_BYTES) throw new Error('Qualification admission is absent.');
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.length !== expected.length || bytes.some((value, i) => value !== expected[i])) throw new Error('Qualification admission differs.');
}
