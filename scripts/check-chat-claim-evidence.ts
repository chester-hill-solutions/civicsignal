#!/usr/bin/env bun
import { readFileSync, statSync } from 'node:fs';
import { verifyChatClaimEvidence } from '../src/eval/chat-claim-evidence';
import { namedArgs } from '../src/eval/v1-cli';

function readEvidence(path: string | undefined): unknown {
  if (!path) throw new Error('Missing evidence path');
  const file = statSync(path);
  if (!file.isFile() || file.size > 64 * 1024 * 1024) throw new Error('Invalid evidence file');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

try {
  const args = namedArgs(process.argv.slice(2), ['--plan', '--capture', '--review']);
  const result = await verifyChatClaimEvidence(
    readEvidence(args.get('--plan')), readEvidence(args.get('--capture')), readEvidence(args.get('--review')),
  );
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
} catch {
  console.error('Supply readable JSON evidence with --plan, --capture, and --review.');
  process.exitCode = 1;
}
