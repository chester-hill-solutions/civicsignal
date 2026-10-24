#!/usr/bin/env bun
/** Local workerd + DevTools sampling of the actual bounded group builder.
 * Requires permission to bind ephemeral localhost ports. It never contacts
 * Cloudflare. Sampled maxima are evidence, not a hosted memory-limit proof.
 * bun scripts/probe-snapshot-worker-memory.ts --file /clone/fra/lois/I-3.3.xml --path fra/lois/I-3.3.xml --out dist/memory.json
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const arg = (flag: string) => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const file = arg('--file');
const sourcePath = arg('--path');
if (!file || !sourcePath) throw new Error('--file and --path are required');
const output = resolve(arg('--out') ?? 'dist/snapshot-worker-memory.json');
const sourceDigests = Object.fromEntries(await Promise.all(['services/snapshot/builder.ts', 'src/ingest/statutes.ts', 'src/ingest/corpus-rows.ts', 'src/ingest/reconcile.ts'].map(async (path) =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const generated = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {buildGroup} from './services/snapshot/builder.ts';
export default {async fetch(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
  const bucket = { async get() { return { arrayBuffer: async () => bytes.buffer }; }, async put(_key, value) { return { size: value.byteLength }; } };
  const plan = { revision: { commit: 'a'.repeat(40), date: '2026-10-15' }, groups: [{ key: 'input', bytes: bytes.length, sha256, singlePath: request.headers.get('x-instrument-path') }], files: 1 };
  const result = await buildGroup(bucket, plan, 0, 0);
  return Response.json({ count: result.count, bytes: result.bytes });
}};` }, bundle: true, format: 'esm', platform: 'browser', external: ['node:*'], write: false });
const mf = new Miniflare({ inspectorPort: 0, telemetry: { enabled: false },
  unsafeDevRegistryPath: resolve('dist/miniflare-snapshot-registry'), workers: [{ config: {
    name: 'snapshot-group-memory', compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: generated.outputFiles![0]!.text } } },
  } }] });
interface HeapUsage { usedSize: number; totalSize: number; backingStorageSize?: number; embedderHeapUsedSize?: number }
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const inspector = await mf.getInspectorURL();
  const http = new URL(inspector);
  http.protocol = 'http:';
  http.pathname = '/json/list';
  const targets = await (await fetch(http)).json() as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((candidate) => candidate.id.includes('snapshot-group-memory')) ?? targets[0]!;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((yes, no) => { socket!.addEventListener('open', () => yes(), { once: true }); socket!.addEventListener('error', no, { once: true }); });
  let id = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown };
    if (value.id) { const request = waiting.get(value.id); waiting.delete(value.id); value.error ? request?.reject(value.error) : request?.resolve(value.result); }
  });
  const call = (method: string) => new Promise<unknown>((yes, no) => {
    const current = ++id;
    waiting.set(current, { resolve: yes, reject: no });
    socket!.send(JSON.stringify({ id: current, method }));
  });
  await call('Runtime.enable');
  const samples: HeapUsage[] = [];
  let pending = false;
  timer = setInterval(async () => {
    if (pending) return;
    pending = true;
    try { samples.push(await call('Runtime.getHeapUsage') as HeapUsage); }
    finally { pending = false; }
  }, 5);
  const content = await readFile(file, 'utf8');
  const response = await mf.dispatchFetch('https://local-snapshot-memory.invalid', {
    method: 'POST', headers: { 'x-instrument-path': sourcePath }, body: content,
  });
  const result = await response.json();
  clearInterval(timer);
  samples.push(await call('Runtime.getHeapUsage') as HeapUsage);
  const evidence = { sourceDigests, status: response.status, sourcePath, inputBytes: Buffer.byteLength(content), result,
    samples: samples.length, maxUsed: Math.max(...samples.map((sample) => sample.usedSize)),
    maxBacking: Math.max(...samples.map((sample) => sample.backingStorageSize ?? 0)),
    maxCombined: Math.max(...samples.map((sample) => sample.usedSize + (sample.backingStorageSize ?? 0) + (sample.embedderHeapUsedSize ?? 0))),
    provenHostedMemoryLimit: false,
    methodology: 'Runtime.getHeapUsage sampled every 5ms during actual buildGroup in local workerd. Includes the synthetic input buffer; does not guarantee capture of every instantaneous peak. node:v8/process memory APIs return zeroes in Workers and are unusable for this measurement.',
    values: samples };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, values: undefined }));
} finally { clearInterval(timer); socket?.close(); await mf.dispose(); }
