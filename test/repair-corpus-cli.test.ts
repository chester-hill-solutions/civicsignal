import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(schema: 'legacy' | 'guarded' | 'unreadable', args: string[], hasMissing = true) {
  const path = mkdtempSync(join(tmpdir(), 'civicsignal-repair-'));
  fixtures.push(path);
  mkdirSync(join(path, 'scripts/lib'), { recursive: true });
  mkdirSync(join(path, 'dist'));
  for (const script of ['repair-corpus.ts', 'lib/d1-load.ts']) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(path, 'scripts', script));
  }
  writeFileSync(join(path, 'dist/statutes.jsonl'), '{"id":"keep"}\n' + (hasMissing ? '{"id":"missing"}\n' : ''));
  const requestLog = join(path, 'requests.jsonl');
  writeFileSync(requestLog, '');
  writeFileSync(join(path, 'scripts/lib/cloudflare-auth.ts'), `
    import { appendFileSync } from 'node:fs';
    export async function fetchWithAuth(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body));
      const {sql, params} = request;
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n');
      let results = [];
      if (sql.startsWith('SELECT id')) results = [{id:'keep'}, {id:'stale'}];
      else if (sql.startsWith('SELECT EXISTS')) {
        if (${JSON.stringify(schema)} === 'unreadable') return new Response('', {status: 503});
        results = [{guard_installed: ${schema === 'guarded' ? 1 : 0}}];
      } else if (sql.startsWith('DELETE')) results = [{id:params[0]}];
      else if (!sql.startsWith('INSERT')) throw new Error('Unexpected fixture request.');
      return Response.json({success:true,result:[{success:true,results}]});
    }
  `);
  const result = spawnSync('bun', ['scripts/repair-corpus.ts', '--lang', 'en', ...args], {
    cwd: path, encoding: 'utf8', timeout: 5000,
  });
  const requests = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { sql: string; params: unknown[] });
  return { ...result, requests };
}

describe('corpus repair CLI', () => {
  it('reads the diff and plans pruning without executing any writes in dry-run mode', () => {
    const result = run('guarded', ['--dry-run', '--prune']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map(({ sql }) => sql)).toEqual(['SELECT id FROM statute_sections WHERE language = ?']);
    expect(result.stdout).toContain('planned 1 insert(s), 1 delete(s)');
    expect(result.stdout).toContain('executed 0 insert(s), 0 delete(s)');
  });

  it.each(['guarded', 'unreadable'] as const)('refuses writes when the schema is %s', (schema) => {
    const result = run(schema, ['--prune']);
    expect(result.status).not.toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.requests.every(({ sql }) => sql.startsWith('SELECT'))).toBe(true);
  });

  it('refuses pruning without inserts when the publication guard is present', () => {
    const result = run('guarded', ['--prune'], false);
    expect(result.status).not.toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.requests.every(({ sql }) => sql.startsWith('SELECT'))).toBe(true);
  });

  it('retains insert and prune behavior after confirming the legacy schema', () => {
    const result = run('legacy', ['--prune']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map(({ sql }) => sql.split(' ')[0])).toEqual(['SELECT', 'SELECT', 'INSERT', 'SELECT', 'DELETE']);
    expect(result.requests[4]?.params).toEqual(['stale']);
    expect(result.stdout).toContain('planned 1 insert(s), 1 delete(s)');
    expect(result.stdout).toContain('executed 1 insert(s), 1 delete(s), 0 failed insert(s)');
  });

  it('rejects a misspelled option before opening the transport', () => {
    const result = run('legacy', ['--dry-ru', '--prune']);
    expect(result.status).not.toBe(0);
    expect(result.requests).toEqual([]);
  });
});
