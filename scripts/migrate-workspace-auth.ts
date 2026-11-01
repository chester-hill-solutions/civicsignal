#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authMigrationSql, prepareAuthMigration } from '../src/auth-migration';

// Preparation only. The release runbook applies the reviewed file after backup.
const args = process.argv.slice(2);
const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const input = value('--input');
const output = value('--output');
if (!input || !output || args.includes('--apply')) {
  console.error('Usage: bun scripts/migrate-workspace-auth.ts --input <KV export.json> --output <reviewed migration.sql>');
  process.exit(1);
}
if (resolve(input) === resolve(output)) throw new Error('Input and output must be different files.');
const data: unknown = JSON.parse(readFileSync(input, 'utf8'));
const prepared = prepareAuthMigration(data);
writeFileSync(output, '-- Apply migrations/0005_workspace_auth.sql first. Preserve the existing usage Durable Object namespace.\n' + authMigrationSql(data) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ ...prepared.summary, output: resolve(output), applied: false }));
