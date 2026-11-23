/** Exercise CHS usage transactions in a real local SQLite Durable Object. No remote bindings. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const generated = await build({ stdin: { resolveDir: process.cwd(), contents: `
import { ApiKeyUsageDO, DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
export { ApiKeyUsageDO };
const now = Date.UTC(2026, 9, 22);
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const ledger = new DurableObjectUsageLedger(env.USAGE, { failureMode: 'closed' });
  if (url.pathname === '/seed') {
    const stub = env.USAGE.get(env.USAGE.idFromName('customer:kept-workspace'));
    return stub.fetch('https://usage/consume?month=2026-10&limit=5', { method: 'POST' });
  }
  if (url.pathname === '/peek') return Response.json(await ledger.peekMonthly('kept-workspace', 5, now));
  const operationId = url.searchParams.get('operation');
  if (url.pathname === '/reserve') return Response.json(await ledger.reserveMonthly('reservation-workspace', 1, now, operationId));
  if (url.pathname === '/reserved-peek') return Response.json(await ledger.peekMonthly('reservation-workspace', 1, now));
  if (url.pathname === '/settle') return Response.json(await ledger.consumeReservedMonthly('reservation-workspace', 1, now, { operationId }));
  if (url.pathname === '/release') {
    await ledger.releaseMonthly('reservation-workspace', 1, now, operationId);
    return Response.json({ released: true });
  }
  if (url.pathname === '/compete') return Response.json(await ledger.consumeMonthly('reservation-workspace', 1, now, { operationId }));
  return Response.json(await ledger.consumeMonthly('kept-workspace', 5, now, { operationId: url.searchParams.get('operation') }));
}};` }, bundle: true, format: 'esm', platform: 'browser', write: false });
const mf = new Miniflare({ telemetry: { enabled: false },
  unsafeDevRegistryPath: resolve('dist/miniflare-usage-registry'), workers: [{ config: {
    name: 'usage-runtime-proof', compatibilityDate: '2026-10-22',
    env: { USAGE: { type: 'durable-object', worker: 'usage-runtime-proof', exportName: 'ApiKeyUsageDO' } },
    exports: { ApiKeyUsageDO: { type: 'durable-object', storage: 'sqlite' } },
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: generated.outputFiles![0]!.text } } },
  } }] });
type Acknowledgement = { allowed: boolean; count: number; recorded?: boolean; operationId?: string; released?: true };
async function call(path: string): Promise<Acknowledgement> {
  const response = await mf.dispatchFetch('https://local-usage-proof.invalid' + path);
  assert.equal(response.status, 200);
  return await response.json() as Acknowledgement;
}
try {
  assert.equal((await call('/seed')).count, 1);
  const repeated = await Promise.all(Array.from({ length: 12 }, () => call('/consume?operation=one-shared-operation')));
  assert.ok(repeated.every((result) => result.allowed && result.count === 2 && result.recorded));
  const competing = await Promise.all(Array.from({ length: 20 }, (_, i) => call('/consume?operation=distinct-' + i)));
  assert.equal(competing.filter((result) => result.allowed).length, 3);
  assert.equal((await call('/peek')).count, 5);
  const replay = await call('/consume?operation=one-shared-operation');
  assert.ok(replay.allowed && replay.count === 2 && replay.recorded);
  const refusedReplay = await call('/consume?operation=' + competing.find((result) => !result.allowed)!.operationId);
  assert.equal(refusedReplay.allowed, false);
  assert.equal((await call('/peek')).count, 5);
  const holds = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/reserve?operation=chat-' + i)));
  assert.equal(holds.filter((result) => result.allowed).length, 1);
  assert.equal((await call('/reserved-peek')).count, 0);
  assert.equal((await call('/compete?operation=mcp')).allowed, false);
  assert.equal((await call('/release?operation=' + holds.find((result) => result.allowed)!.operationId)).released, true);
  assert.equal((await call('/reserve?operation=chat-retry')).allowed, true);
  const settlements = await Promise.all(Array.from({ length: 6 }, () => call('/settle?operation=chat-retry')));
  assert.ok(settlements.every((result) => result.allowed && result.count === 1 && result.recorded));
  assert.equal((await call('/reserved-peek')).count, 1);
  const evidence = { runtime: 'local workerd SQLite Durable Object', packageVersion: '0.1.2',
    legacyCounterPreserved: true, concurrentSameOperationRequests: 12, sameOperationUnits: 1,
    distinctCompetingRequests: 20, acceptedWithinRemainingAllowance: 3, finalCount: 5,
    acceptedAndRefusedReceiptsReplayWithoutIncrement: true,
    concurrentReservationsForOneUnit: 6, confirmedReservations: 1, holdPreservesCommittedCount: true,
    competesWithOrdinaryConsumption: true, failedWorkReleaseReturnsUnit: true, sameReservationSettlements: 6,
    reservationSettlementUnits: 1, remoteMutations: 0 };
  const output = resolve('dist/usage-runtime-proof.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} finally { await mf.dispose(); }
