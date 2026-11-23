import { describe, expect, it } from 'vitest';
import { retrievalCacheKey, VECTOR_FLOOR } from '../src/corpora/adapters';
import { POSTGRES_VECTOR_FLOOR } from '../src/corpora/postgres-adapters';

const query = { topic: 'cache contract fixture', language: 'fr', limit: 3 };
const revision = 'fixture-source:statutes-v2';

describe('retrieval cache admission', () => {
  it('does not reuse orders or refusals made under the permissive response contract', () => {
    // Captured from 35c55e6 before complete, finite Jev response validation.
    expect(retrievalCacheKey(query, revision, true)).not.toBe('retrieval:v2:1211e120828a9c28bd92bcf973ff307c');
  });

  // Captured before applying the floor to the eligible returned rows.
  it.each([
    { id: 'vectorize', floor: VECTOR_FLOOR, useJev: false, oldKey: 'retrieval:v2:985bd5869e13db7e0900466693de4401' },
    { id: 'vectorize', floor: VECTOR_FLOOR, useJev: true, oldKey: 'retrieval:v2:cbac572a51960bc2db2f85b199d6de03' },
    { id: 'postgres-cosine', floor: POSTGRES_VECTOR_FLOOR, useJev: false, oldKey: 'retrieval:v2:cef628988157f9b11b2a8fe8e7cdc420' },
    { id: 'postgres-cosine', floor: POSTGRES_VECTOR_FLOOR, useJev: true, oldKey: 'retrieval:v2:5e01a34de9e356fb7969a06f2bc427cc' },
  ])('excludes the prior eligibility policy for $id with Jev configured $useJev', ({ id, floor, useJev, oldKey }) => {
    const key = retrievalCacheKey(query, revision, useJev, { id, floor });
    expect(key).toMatch(/^retrieval:v2:[a-f0-9]{32}$/);
    expect(key).not.toBe(oldKey);
  });
});
