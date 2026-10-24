#!/usr/bin/env bun
/** Read a consistent, quiesced legacy KV key/customer backup. No raw keys are stored. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { normalizeAuthExport, prepareAuthMigration } from '../src/auth-migration';
import { collectLegacyAuth } from '../src/auth-export';

const argv = process.argv.slice(2);
const output = argv[argv.indexOf('--output') + 1];
if (argv.length !== 3 || !argv.includes('--remote') || !argv.includes('--output') || !output || output.startsWith('--')) {
  throw new Error('Usage: bun scripts/export-workspace-auth.ts --remote --output <new backup.json>. Freeze legacy key changes first.');
}
const wrangler = (args: string[]) => execFileSync('bun', ['x', '--no-install', 'wrangler', ...args], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
const list = (prefix: string): { name: string }[] => JSON.parse(wrangler(['kv', 'key', 'list', '--binding', 'API_KEYS', '--prefix', prefix, '--remote']));
const get = (name: string): Record<string, unknown> => JSON.parse(wrangler(['kv', 'key', 'get', name, '--binding', 'API_KEYS', '--remote', '--text']));
const collected = await collectLegacyAuth({
  async list(prefix) { return list(prefix).map(({ name }) => name); },
  async get(name) { return get(name); },
});
const data = { exportedAt: new Date().toISOString(), source: 'API_KEYS legacy KV', ...normalizeAuthExport(collected) };
const { summary } = prepareAuthMigration(data);
writeFileSync(output, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ ...summary, output, readOnly: true }));
