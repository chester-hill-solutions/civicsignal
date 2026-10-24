#!/usr/bin/env bun
/** Loopback-only controlled staging relay. Never logs auth/BYOK/query/body. */
import { FileRelayLedger, MAX_RELAY_BODY_BYTES, MAX_STAGING_REQUESTS, stagingRequestRelay, stagingTarget } from './lib/staging-request-relay';

const args = process.argv.slice(2);
const flags = new Set(['--target', '--ledger', '--limit', '--port', '--timeout-ms']);
function value(flag: string): string | undefined { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; }
if (args.includes('--help')) {
  console.log('usage: bun scripts/staging-request-proxy.ts --target https://civicsignal-v1-stage-api-<suffix>.<account>.workers.dev --ledger <existing-parent>/serving-requests.jsonl [--limit 160] [--port 0] [--timeout-ms 30000] [--inspect]');
  process.exit(0);
}
const seen = new Set<string>();
for (let at = 0; at < args.length; at++) {
  if (seen.has(args[at]!)) throw new Error('duplicate staging relay option');
  seen.add(args[at]!);
  if (args[at] === '--inspect') continue;
  if (!flags.has(args[at]!) || args[at + 1] === undefined || args[at + 1]!.startsWith('--')) throw new Error('invalid staging relay option; use --help');
  at++;
}
const targetArg = value('--target');
const path = value('--ledger');
if (!targetArg || !path) throw new Error('explicit --target and --ledger are required; there is no default target or budget reset');
const targetOrigin = stagingTarget(targetArg);
const limit = Number(value('--limit') ?? MAX_STAGING_REQUESTS);
const port = Number(value('--port') ?? 0);
const timeoutMs = Number(value('--timeout-ms') ?? 30_000);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
if (args.includes('--inspect')) {
  console.log(JSON.stringify(FileRelayLedger.inspect(path, targetOrigin, limit), null, 2));
} else {
  const ledger = new FileRelayLedger({ path, targetOrigin, limit });
  let server: ReturnType<typeof Bun.serve>;
  try {
    const relay = stagingRequestRelay({ targetOrigin, ledger, timeoutMs });
    server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: MAX_RELAY_BODY_BYTES,
      idleTimeout: 60, fetch: relay });
  } catch (error) { ledger.close(); throw error; }
  console.log(JSON.stringify({ listen: server.url.origin, ...ledger.status(),
    provenanceEnvironment: 'staging', measurement: 'observed latency includes local body-read, durable fsync reservation and relay overhead; proxy-prepare response header measures work before upstream send' }, null, 2));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.stop(true);
    ledger.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
