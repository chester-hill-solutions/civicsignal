/** Fixed first-publication policy, imported only by the qualification entry.
 * Counts are per callback, never a global delivery/reconstruction meter. */
import { createHash } from 'node:crypto';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { manifestKey } from '../../src/ingest/snapshot-format';
import { SourceHeadError, type SourceHeadErrorCode, type SourceHeadRateLimits } from '../../src/ingest/source-head';
import { PARTITIONS, stagingPrefix, type BuildBucket, type CleanupPolicy } from './builder';
import { qualificationRecord, QUALIFICATION_STAGE_ID, QUALIFICATION_SOURCE_START_WINDOW_MS, type Qualification } from './qualification';
import { QUALIFICATION_RECEIPT_BYTES } from './qualification-store';
import { QUALIFICATION_PAYLOADS, QUALIFICATION_REFERENCE, QUALIFICATION_REFERENCE_PINS } from './qualification-reference-data';

export const QUALIFICATION_RUNTIME_DISPOSITION = Object.freeze({
  format: 1, policy: 'fixed-reference-callbacks-v1', globalRawR2AggregateEnforced: false,
  residualPlatformDeliveryReconstructionAndInflightUncertainty: true,
  bindingCancellationGuaranteed: false,
  automaticSourceRetry: false, automaticWorkflowRestart: false,
});
export const QUALIFICATION_ADMISSION_STEP = 'check scheduled qualification admission';
const encoder = new TextEncoder(), canonical = (value: unknown): string => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function requirePolicy(value: unknown, code: string): asserts value { if (!value) throw new Error('Qualification policy refused: ' + code); }
const record = (value: unknown): Record<string, unknown> => { requirePolicy(value && typeof value === 'object' && !Array.isArray(value), 'record'); return value as Record<string, unknown>; };
const phases = { 'diagnostics/admitted.json': 'admitted', 'diagnostics/discovered.json': 'discovered',
  'diagnostics/delegated.json': 'delegated-not-publication', 'diagnostics/published.json': 'published',
  'diagnostics/rejected.json': 'rejected', 'diagnostics/failed.json': 'failed-or-uncertain', 'diagnostics/existing.json': 'existing-publication',
  'attempts/discovery.json': 'discovery', 'attempts/authoritative.json': 'authoritative', 'attempts/archive.json': 'archive' } as const;

function validateReceipt(q: Qualification, key: keyof typeof phases, bytes: Uint8Array) {
  requirePolicy(bytes.length <= QUALIFICATION_RECEIPT_BYTES, 'receipt-size');
  let text: string, parsed: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); parsed = JSON.parse(text); }
  catch { throw new Error('Qualification policy refused: receipt-json'); }
  const value = record(parsed);
  requirePolicy(JSON.stringify(value) + '\n' === text, 'receipt-encoding');
  const expected: Record<string, unknown> = { ...qualificationRecord(q, phases[key]) };
  if (key === 'diagnostics/published.json') {
    requirePolicy(value.count === QUALIFICATION_REFERENCE.rows && typeof value.existing === 'boolean', 'publication-receipt');
    expected.count = value.count; expected.existing = value.existing;
  } else if (key === 'diagnostics/rejected.json') {
    const observed = record(value.observed);
    requirePolicy((observed.cron === null || typeof observed.cron === 'string' && /^[\d* /,-]{1,128}$/.test(observed.cron)) &&
      (observed.scheduledTime === null || Number.isSafeInteger(observed.scheduledTime) && Number(observed.scheduledTime) >= 0) &&
      ['early', 'open', 'expired', 'invalid-clock'].includes(String(value.window)), 'rejection-receipt');
    expected.observed = { cron: observed.cron, scheduledTime: observed.scheduledTime }; expected.window = value.window;
  } else if (key === 'diagnostics/failed.json' && value.sourceFailure !== undefined) {
    const failure = record(value.sourceFailure), safe = new SourceHeadError(failure.code as SourceHeadErrorCode,
      failure.status as number | undefined, (failure.rateLimits ?? {}) as SourceHeadRateLimits);
    expected.sourceFailure = { code: safe.code, ...(safe.status === undefined ? {} : { status: safe.status }),
      ...(Object.keys(safe.rateLimits).length ? { rateLimits: safe.rateLimits } : {}) };
  }
  requirePolicy(canonical(value) === canonical(expected), 'receipt-contract');
}

type Rule = { get: Set<string>; head: Set<string>; put: Set<string>; list: boolean; delete: boolean; calls: number; timeoutMs: number };
const rule = (get: string[] = [], put: string[] = [], head: string[] = [], calls = get.length + put.length + head.length, timeoutMs = 600000): Rule =>
  ({ get: new Set(get), put: new Set(put), head: new Set(head), list: false, delete: false, calls, timeoutMs });

function assertPolicyQualification(q: Qualification) {
  const deadline = q.identity.runtimeDeadline;
  requirePolicy(Number.isSafeInteger(deadline) && deadline! > q.identity.event.scheduledTime && deadline! <= q.identity.event.scheduledTime + 10800000, 'missing-runtime-deadline');
  requirePolicy(canonical(q.identity.revision) === canonical(QUALIFICATION_REFERENCE.revision) && q.identity.parser === QUALIFICATION_REFERENCE.parser, 'reference-identity');
  requirePolicy(q.identity.stageId === QUALIFICATION_STAGE_ID && q.identity.sourceAttempts === 3 && q.identity.sourceStartWindowMs === QUALIFICATION_SOURCE_START_WINDOW_MS &&
    /^[a-z][a-z0-9-]{0,39}$/.test(q.identity.id) && q.digest === sha(encoder.encode(JSON.stringify(q.identity))) &&
    q.prefix === `qualifications/${q.identity.id}/${q.digest}/` && q.instanceId === `qual-${q.digest}`, 'qualification-identity');
}
function referencePolicy() {
  const prefix = stagingPrefix(QUALIFICATION_REFERENCE.revision.commit), manifest = manifestKey(QUALIFICATION_REFERENCE.revision.commit, QUALIFICATION_REFERENCE.parser);
  const payloads = new Map(QUALIFICATION_PAYLOADS.map(([key, bytes, sha256]) => [key, { bytes, sha256 }]));
  const staged = [...payloads.keys()].filter(key => key.startsWith(prefix)), rows = [...payloads.keys()].filter(key => key.includes('.rows.g'));
  const groups = staged.filter(key => /^group-\d+\.(jsonl|xml)$/.test(key.slice(prefix.length)));
  const rules = new Map<string, Rule>();
  const receipt = (name: keyof typeof phases) => name;
  rules.set('scheduled entry', rule([receipt('diagnostics/admitted.json'), receipt('attempts/discovery.json'), receipt('diagnostics/discovered.json'),
    receipt('diagnostics/delegated.json'), receipt('diagnostics/failed.json'), receipt('diagnostics/existing.json'), receipt('diagnostics/rejected.json'), manifest],
    ['diagnostics/admitted.json', 'attempts/discovery.json', 'diagnostics/discovered.json', 'diagnostics/delegated.json', 'diagnostics/failed.json', 'diagnostics/existing.json', 'diagnostics/rejected.json'],
    ['diagnostics/failed.json'], 16, 900000));
  rules.set(QUALIFICATION_ADMISSION_STEP, rule(['diagnostics/admitted.json', 'diagnostics/discovered.json']));
  rules.set('check authoritative source commit date', rule(['attempts/authoritative.json'], ['attempts/authoritative.json']));
  rules.set('check published revision', rule([manifest]));
  rules.set('stage pinned corpus once', rule(['attempts/archive.json'], [...groups, 'attempts/archive.json'], groups, 2 + groups.length * 2, 3600000));
  for (const groupKey of groups) {
    const group = Number(/^group-(\d+)\./.exec(groupKey.slice(prefix.length))![1]);
    const outputs = [...rows.filter(key => key.includes(`.rows.g${String(group).padStart(4, '0')}.`)),
      ...staged.filter(key => key.startsWith(prefix + 'index-') && key.endsWith(`-${group}.jsonl`))];
    rules.set(`parse file group ${group}`, rule([groupKey], outputs, outputs));
  }
  for (const partition of PARTITIONS) {
    const fragments = staged.filter(key => key.startsWith(prefix + `index-${partition}-`)), sorted = prefix + `sorted-${partition}.jsonl`;
    rules.set(`sort ${partition} index`, rule(fragments, [sorted], [sorted]));
  }
  const sorted = PARTITIONS.map(partition => prefix + `sorted-${partition}.jsonl`), index = [...payloads.keys()].find(key => key.endsWith('.index.jsonl'))!;
  rules.set('publish immutable snapshot manifest last', rule(sorted, [index, manifest], [...rows, index, manifest]));
  rules.set('remove this revision staging objects', { ...rule([], [], [], 2 * staged.length + 1), list: true, delete: true });
  rules.set('record qualification publication outcome', rule(['diagnostics/published.json'], ['diagnostics/published.json']));
  return { prefix, payloads, staged, rules };
}
/** Event-independent source definition, suitable for a pinned accounting record. */
export function qualificationRuntimePolicyDefinition() {
  const { payloads, staged, rules } = referencePolicy();
  const value = { ...QUALIFICATION_RUNTIME_DISPOSITION, referencePins: QUALIFICATION_REFERENCE_PINS,
    payloadPolicySha256: sha(encoder.encode(canonical(QUALIFICATION_PAYLOADS))),
    payloadObjects: payloads.size, payloadBytes: QUALIFICATION_REFERENCE.payloadBytes,
    receiptObjects: Object.keys(phases).length, receiptBytes: 10 * QUALIFICATION_RECEIPT_BYTES,
    metadataAndPlatformAccountingOverheadQualified: false,
    maximumRuntimeMs: 10800000, maximumCleanupLists: staged.length + 1, maximumCleanupDeletes: staged.length,
    workflowTraversalMaximumR2Calls: [...rules].filter(([name]) => name !== 'scheduled entry').reduce((sum, [, value]) => sum + value.calls, 0),
    scheduledCallbackMaximumR2Calls: rules.get('scheduled entry')!.calls,
    payloadCollisionHeadsPerTraversal: payloads.size,
    callbacks: [...rules].map(([name, value]) => ({ name, maximumR2Calls: value.calls, timeoutMs: value.timeoutMs, retries: 0,
      timeoutEnforcement: name === 'scheduled entry' ? 'scheduled-host-wall-limit-and-pre-post-await-clocks' : 'workflow-step-host-timeout-and-pre-post-await-clocks',
      maximumBodyReadBytes: [...value.get].reduce((sum, key) => sum + (payloads.get(key)?.bytes ?? QUALIFICATION_RECEIPT_BYTES), 0),
      maximumBodyWriteBytes: [...value.put].reduce((sum, key) => sum + (payloads.get(key)?.bytes ?? QUALIFICATION_RECEIPT_BYTES), 0),
      eachObjectGetHeadPutKeyAtMostOnce: true, eachDeletedKeyAtMostOnce: true,
      methodsAndKeysSha256: sha(encoder.encode(canonical({ get: [...value.get], head: [...value.head], put: [...value.put], list: value.list, delete: value.delete }))) })) };
  return { ...value, policyDefinitionDigest: sha(encoder.encode(canonical(value))) };
}
/** Pure event binding; no credentials, authorization or platform-cost meter. */
export function qualificationRuntimePolicyDescriptor(q: Qualification) {
  assertPolicyQualification(q);
  const value = { ...qualificationRuntimePolicyDefinition(), qualification: q.digest, runtimeDeadline: q.identity.runtimeDeadline };
  return { ...value, policyDigest: sha(encoder.encode(canonical(value))) };
}
export function qualificationRuntime(bucket: BuildBucket, q: Qualification, clock: { wall?: () => number; monotonic?: () => number } = {}) {
  assertPolicyQualification(q);
  const { prefix, payloads, staged, rules } = referencePolicy(), deadline = q.identity.runtimeDeadline;
  const wall = clock.wall ?? Date.now, monotonic = clock.monotonic ?? (() => performance.now()), startedWall = wall(), startedMono = monotonic();
  let lastWall = startedWall, lastMono = startedMono;
  let active: { rule: Rule; remaining: number; deadlineMono: number; deadlineWall: number; open: boolean; bodyFailed: boolean;
    readers: Set<() => void>; seen: Set<string>; lists: number; deletes: number } | undefined;
  function check() {
    const at = wall(), mono = monotonic();
    requirePolicy(Number.isFinite(at) && Number.isFinite(mono) && at >= lastWall && mono >= lastMono && at < deadline! &&
      mono - startedMono < deadline! - startedWall && (!active || active.open && mono < active.deadlineMono && at < active.deadlineWall), 'deadline');
    lastWall = at; lastMono = mono;
  }
  check();
  function select(method: 'get' | 'head' | 'put', physical: string) {
    check(); requirePolicy(active?.open && typeof physical === 'string' && physical.startsWith(q.prefix), 'callback');
    const key = physical.slice(q.prefix.length);
    requirePolicy(active.rule[method].has(key) && (payloads.has(key) || key in phases), 'key-or-method');
    const reservation = method + ':' + key;
    requirePolicy(!active.seen.has(reservation), 'callback-key-spent'); active.seen.add(reservation);
    return { key, attempt: active };
  }
  async function call<T>(attempt: NonNullable<typeof active>, operation: () => Promise<T>): Promise<T> {
    check(); requirePolicy(active === attempt && attempt.open && attempt.remaining-- > 0, 'callback-call-cap');
    let value: T;
    try { value = await operation(); } catch { throw new Error('Qualification R2 operation failed or is uncertain.'); }
    check(); requirePolicy(active === attempt && attempt.open, 'late-completion'); return value;
  }
  function metadata(object: R2Object, key: string) {
    const expected = payloads.get(key);
    requirePolicy(object.key === q.prefix + key && Number.isSafeInteger(object.size) && object.size >= 0, 'object-metadata');
    if (expected) requirePolicy(object.size === expected.bytes && canonical(object.customMetadata) === canonical({ sha256: expected.sha256 }), 'payload-metadata');
    else requirePolicy(object.size <= QUALIFICATION_RECEIPT_BYTES && canonical(object.customMetadata ?? {}) === '{}', 'receipt-metadata');
  }
  const controlled: BuildBucket = {
    async get(physical: string, options?: R2GetOptions) {
      const { key, attempt } = select('get', physical); requirePolicy(options === undefined, 'get-options');
      const object = await call(attempt, () => bucket.get(physical)); if (!object) return null;
      try { metadata(object, key); } catch (error) { attempt.bodyFailed = true; void object.body?.cancel().catch(() => {}); throw error; }
      requirePolicy(object.body instanceof ReadableStream, 'missing-body');
      const reader = object.body.getReader(), expected = payloads.get(key), chunks: Uint8Array[] = [], digest = createHash('sha256'); let count = 0;
      const cancel = () => { attempt.readers.delete(cancel); void reader.cancel().catch(() => {}); }; attempt.readers.add(cancel);
      const body = new ReadableStream<Uint8Array>({ async pull(out) {
        try {
          check(); requirePolicy(active === attempt && attempt.open, 'body-callback'); const next = await reader.read(); check();
          if (next.done) {
            requirePolicy(count === object.size, 'body-size');
            if (expected) requirePolicy(digest.digest('hex') === expected.sha256, 'body-hash');
            else { const bytes = new Uint8Array(count); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } validateReceipt(q, key as keyof typeof phases, bytes); }
            attempt.readers.delete(cancel); reader.releaseLock(); out.close(); return;
          }
          requirePolicy(next.value instanceof Uint8Array && count + next.value.length <= object.size, 'body-overflow');
          count += next.value.length; digest.update(next.value); if (!expected) chunks.push(next.value.slice()); out.enqueue(next.value);
        } catch (error) { attempt.bodyFailed = true; cancel(); out.error(error instanceof Error && error.message.startsWith('Qualification policy refused:') ? error : new Error('Qualification R2 body failed or is uncertain.')); }
      }, cancel() { attempt.bodyFailed = true; cancel(); } });
      const response = new Response(body);
      return new Proxy(object, { get(target, property) {
        if (property === 'body') return body; if (property === 'bodyUsed') return response.bodyUsed;
        if (['arrayBuffer', 'bytes', 'text', 'json', 'blob'].includes(String(property))) return Reflect.get(response, property, response).bind(response);
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    async head(physical) { const { key, attempt } = select('head', physical); const value = await call(attempt, () => bucket.head(physical)); if (value) metadata(value, key); return value; },
    async put(physical, input, options) {
      const { key, attempt } = select('put', physical);
      requirePolicy(input instanceof Uint8Array || input instanceof ArrayBuffer, 'put-body-type');
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), expected = payloads.get(key);
      if (expected) {
        requirePolicy(bytes.length === expected.bytes && sha(bytes) === expected.sha256, 'put-bytes');
        requirePolicy(canonical(options) === canonical({ onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: expected.sha256 } }), 'put-metadata');
      } else {
        validateReceipt(q, key as keyof typeof phases, bytes);
        requirePolicy(canonical(options) === canonical({ onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } }), 'receipt-options');
      }
      return call(attempt, () => bucket.put(physical, bytes, options));
    },
    async list(options) {
      check(); const attempt = active; requirePolicy(attempt?.open && attempt.rule.list && options?.prefix === q.prefix + prefix && options.limit === 500 &&
        !options.cursor && !options.delimiter && !options.startAfter, 'list-options');
      requirePolicy(++attempt.lists <= staged.length + 1, 'cleanup-list-cap');
      const page = await call(attempt, () => bucket.list(options));
      requirePolicy(page.objects.length <= staged.length && !page.delimitedPrefixes?.length && new Set(page.objects.map(value => value.key)).size === page.objects.length, 'list-bound');
      for (const value of page.objects) requirePolicy(staged.includes(value.key.slice(q.prefix.length)) && value.key.startsWith(q.prefix) && value.size === payloads.get(value.key.slice(q.prefix.length))!.bytes, 'list-key');
      requirePolicy(page.objects.length > 0 || page.truncated === false, 'empty-truncated-list'); return page;
    },
    async delete(keys) {
      check(); const attempt = active, values = typeof keys === 'string' ? [keys] : keys;
      requirePolicy(attempt?.open && attempt.rule.delete && values.length > 0 && values.length <= staged.length && new Set(values).size === values.length &&
        values.every(key => key.startsWith(q.prefix) && staged.includes(key.slice(q.prefix.length))), 'delete-keys');
      requirePolicy(++attempt.deletes <= staged.length && values.every(key => !attempt.seen.has('delete:' + key)), 'cleanup-delete-cap');
      for (const key of values) attempt.seen.add('delete:' + key);
      await call(attempt, () => bucket.delete(values));
    },
  };
  async function run<T>(name: string, callback: () => Promise<T>): Promise<T> {
    check(); requirePolicy(!active, 'concurrent-callback'); const selected = rules.get(name); requirePolicy(selected, 'step-name');
    const attempt = { rule: selected, remaining: selected.calls, deadlineMono: monotonic() + selected.timeoutMs, deadlineWall: wall() + selected.timeoutMs,
      open: true, bodyFailed: false, readers: new Set<() => void>(), seen: new Set<string>(), lists: 0, deletes: 0 }; active = attempt;
    try { const value = await callback(); check(); requirePolicy(!attempt.bodyFailed && attempt.readers.size === 0, 'incomplete-body'); return value; }
    finally { attempt.open = false; for (const cancel of [...attempt.readers]) cancel(); if (active === attempt) active = undefined; }
  }
  const config = (name: string): WorkflowStepConfig => { const selected = rules.get(name); requirePolicy(selected, 'step-name'); return { retries: { limit: 0, delay: '1 second' }, timeout: selected.timeoutMs }; };
  const step = <T extends Rpc.Serializable<T>>(native: WorkflowStep, name: string, callback: () => Promise<T>) => native.do(name, config(name), () => run(name, callback));
  const cleanup: CleanupPolicy = { maximumLists: staged.length + 1, maximumDeletes: staged.length, allowedKeys: new Set(staged), check };
  return { bucket: controlled, check, run, config, step, cleanup, evidence: qualificationRuntimePolicyDescriptor(q) };
}
