import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'civicsignal-load-'));
  fixtures.push(path);
  mkdirSync(join(path, 'scripts/lib'), { recursive: true });
  mkdirSync(join(path, 'dist'));
  for (const script of ['load-corpus.ts', 'lib/d1-load.ts', 'lib/cloudflare-auth.ts']) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(path, 'scripts', script));
  }
  const rows = ['first', 'second', 'third'].map((text) => JSON.stringify({ text })).join('\n');
  writeFileSync(join(path, 'dist/statutes.jsonl'), rows);
  writeFileSync(join(path, 'dist/statutes-fr.jsonl'), rows);
  return path;
}

describe('corpus loader CLI', () => {
  it('resumes each language from its own checkpoint', () => {
    const path = fixture();
    writeFileSync(join(path, 'dist/.load-checkpoint-en'), '2');
    writeFileSync(join(path, 'dist/.load-checkpoint-fr'), '1');
    const result = spawnSync('bun', ['scripts/load-corpus.ts', '--dry-run'], {
      cwd: path, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('load-corpus: 1 en row(s)');
    expect(result.stdout).toContain('load-corpus: 2 fr row(s)');
    expect(readFileSync(join(path, 'dist/.load-checkpoint-en'), 'utf8')).toBe('2');
    expect(readFileSync(join(path, 'dist/.load-checkpoint-fr'), 'utf8')).toBe('1');
  });

  it.each([['--skip', '-1'], ['--limit', 'NaN'], ['--limit', '0']])('refuses invalid %s %s before loading rows', (...args) => {
    const path = fixture();
    const result = spawnSync('bun', ['scripts/load-corpus.ts', '--dry-run', ...args], {
      cwd: path, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${args[0]} must be`);
    expect(result.stdout).not.toContain('load-corpus:');
  });

  it.each([
    ['corpus_publication_guard', 'publication guard is installed'],
    ['CORPUS_PUBLICATION_GUARD', 'publication guard is installed'],
    [null, 'Could not verify the D1 publication schema'],
  ])('refuses legacy writes with schema %s', (guardName, message) => {
    const path = fixture();
    writeFileSync(join(path, 'scripts/lib/cloudflare-auth.ts'), `
      import { appendFileSync } from 'node:fs';
      import { Database } from 'bun:sqlite';
      const db = new Database(':memory:');
      ${guardName ? `db.exec('CREATE TABLE ${guardName}(id TEXT)');` : ''}
      export async function fetchWithAuth(_url: string, init: RequestInit) {
        const { sql } = JSON.parse(String(init.body));
        appendFileSync('queries.log', sql.replace(/\\s+/g, ' ').trim() + '\\n');
        const results = ${guardName ? 'db.query(sql).all()' : '[{ guard_installed: null }]'};
        return Response.json({ success: true, result: [{ results }] });
      }
    `);
    const result = spawnSync('bun', ['scripts/load-corpus.ts', '--lang', 'en'], {
      cwd: path, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readFileSync(join(path, 'queries.log'), 'utf8').trim().split('\n')).toEqual([
      "SELECT EXISTS ( SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'corpus_publication_guard' COLLATE NOCASE ) AS guard_installed",
    ]);
  });
});
