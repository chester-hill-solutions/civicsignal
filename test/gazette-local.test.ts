import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifest = fileURLToPath(new URL('./fixtures/gazette/week.json', import.meta.url));

describe('Gazette local CLI', () => {
  it('replays synthetic issue indexes idempotently and supports metadata-only search and exact lookup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'civicsignal-gazette-'));
    const database = join(directory, 'preview.sqlite');
    const run = (...args: string[]) => {
      const result = spawnSync('bun', ['scripts/gazette-local.ts', ...args], { encoding: 'utf8', timeout: 60_000 });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Gazette CLI command failed.');
      return result.stdout;
    };
    try {
      const first = JSON.parse(run('replay', database, manifest)) as { complete: boolean; editions: Array<{ status: string }> };
      expect(first).toMatchObject({ complete: true, editions: Array(4).fill({ status: 'imported' }) });
      const second = JSON.parse(run('replay', database, manifest)) as { complete: boolean; editions: Array<{ status: string }> };
      expect(second).toMatchObject({ complete: true, editions: Array(4).fill({ status: 'unchanged' }) });

      const search = JSON.parse(run('search', database, 'en', 'I', 'export control')) as { items?: Array<{ id: string; citationUrl?: string }> };
      expect(search.items?.length).toBeGreaterThan(0);
      const result = search.items?.[0];
      if (!result) throw new Error('Expected Gazette search result.');
      const shown = JSON.parse(run('show', database, result.id)) as { item?: { id: string; citationUrl: string } };
      expect(shown.item?.id).toBe(result.id);
      expect(shown.item?.citationUrl ?? result.citationUrl).toContain('gazette.gc.ca/rp-pr/p1/2026/2026-04-25/html/');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
