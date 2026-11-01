import { describe, expect, it } from 'vitest';
import { retrievalCacheKey } from '../src/corpora/adapters';

// Captured from 35c55e6 before complete, finite Jev response validation. Those
// entries retain no authority flags with which to qualify the new contract.
const query = { topic: 'cache contract fixture', language: 'fr', limit: 3 };
const revision = 'fixture-source:statutes-v2';

describe('Jev response contract cache admission', () => {
  it('does not reuse orders or refusals made under the permissive response contract', () => {
    expect(retrievalCacheKey(query, revision, true)).not.toBe('retrieval:v2:1211e120828a9c28bd92bcf973ff307c');
  });

  it('preserves the unaffected vector-only cache identity', () => {
    expect(retrievalCacheKey(query, revision, false)).toBe('retrieval:v2:985bd5869e13db7e0900466693de4401');
  });
});
