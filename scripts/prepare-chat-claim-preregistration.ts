#!/usr/bin/env bun
import { prepareChatClaimPreregistration } from '../src/eval/chat-claim-evidence';
import { namedArgs } from '../src/eval/v1-cli';

try {
  const args = namedArgs(process.argv.slice(2), ['--candidate', '--revision', '--provider', '--model', '--reviewer']);
  const packet = await prepareChatClaimPreregistration({
    candidate: args.get('--candidate'),
    revision: args.get('--revision'),
    provider: args.get('--provider'),
    model: args.get('--model'),
  }, args.get('--reviewer'));
  console.log(JSON.stringify(packet, null, 2));
} catch {
  console.error('Supply the exact serving --candidate, --revision, --provider, --model, and independent --reviewer.');
  process.exitCode = 1;
}
