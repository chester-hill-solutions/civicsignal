import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('legacy Vectorize index CLI', () => {
  it.each([
    ['civicsignal-statutes-gemma', 'Use the corpus pipeline'],
    ['civicsignal-v1-stage-statutes-20261122', 'Use the corpus pipeline'],
    ['CIVICSIGNAL-V1-STAGE-STATUTES-20261122', 'Use the corpus pipeline'],
    ['other/../civicsignal-statutes-gemma', 'must be an index name'],
  ])('refuses %s before embedding', (index, message) => {
    const run = spawnSync('bun', ['--no-env-file', 'scripts/index-corpus.ts'], {
      encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, VECTORIZE_INDEX: index },
    });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain(message);
  });
});
