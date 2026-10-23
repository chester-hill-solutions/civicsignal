#!/usr/bin/env bun
/** Preparation only. Apply the reviewed SQL to D1; never write legacy KV keys. */
import { writeFileSync } from 'node:fs';
import { prepareKeyRevocation, prepareWorkspaceKey } from '../src/key-operations';

const argv = process.argv.slice(2);
const known = new Set(['--workspace', '--name', '--output', '--revoke']);
const args = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]!;
  const value = argv[i + 1];
  if (!known.has(key) || args.has(key) || !value || value.startsWith('--')) throw new Error('Unknown, repeated or incomplete argument.');
  args.set(key, value);
}
const workspace = args.get('--workspace');
const output = args.get('--output');
if (!workspace || !output || (!args.has('--revoke') && !args.has('--name'))) {
  throw new Error('Usage: bun scripts/mint-key.ts --workspace <existing workspace> --name <name> --output <new.sql> [or --revoke <key id>]');
}
if (args.has('--revoke')) {
  writeFileSync(output, prepareKeyRevocation(workspace, args.get('--revoke')!), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ workspace, revokedKeyId: args.get('--revoke'), output, applied: false }));
} else {
  const prepared = prepareWorkspaceKey(workspace, args.get('--name')!);
  writeFileSync(output, prepared.sql, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ workspace, id: prepared.id, output, applied: false }));
  console.log('Raw key (shown once; valid only after applying the SQL):');
  console.log(prepared.rawKey);
}
