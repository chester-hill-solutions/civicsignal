/** Fixed offline composition over one finite injected transport. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync,
  type BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROTECTED_ACQUISITION_SOURCE, ProtectedAcquisitionError, captureProtectedAcquisitionFixture,
  type FixtureCaptureFilePin, type ProtectedAcquisitionFixtureOptions } from './protected-acquisition';
import { ProtectedAcquisitionFactsError, captureProtectedAcquisitionFacts } from './protected-acquisition-facts';
import { ProtectedAcquisitionTransportError, createFixtureAcquisitionTransport,
  type AcquisitionTransportOptions } from './protected-acquisition-transport';
import { privatePath } from './protected-state';

interface FixtureAcquisitionSessionOptions {
  mode: 'fixture-only';
  sessionDirectory: string;
  transport: Omit<AcquisitionTransportOptions, 'fixtureOnly' | 'journalDirectory'>;
  captureLimits?: ProtectedAcquisitionFixtureOptions['limits'];
}

export class ProtectedAcquisitionSessionError extends Error {
  constructor(readonly code: string, readonly ioSettled = true) {
    super(code);
    this.name = 'ProtectedAcquisitionSessionError';
  }
}

function requireSession(value: unknown, code: string): asserts value {
  if (!value) throw new ProtectedAcquisitionSessionError(code);
}

function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

const inputDrift = 'ACQUISITION_SESSION_INPUT_DRIFT';
const metadataBytes = 512 * 1024;
interface InputDigest { sha256: string; bytes?: number }
interface SealedInput { path: string; identity: BigIntStats; parent: BigIntStats; sha256: string }

function sameInput(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function inputStat(path: string, directory: boolean): BigIntStats {
  const identity = lstatSync(path, { bigint: true });
  requireSession(realpathSync(path) === path && identity.uid === BigInt(process.getuid?.() ?? -1) &&
    (directory ? identity.isDirectory() && (identity.mode & 0o777n) === 0o700n :
      identity.isFile() && identity.nlink === 1n && (identity.mode & 0o777n) === 0o600n), inputDrift);
  return identity;
}

function inputCheck<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof ProtectedAcquisitionTransportError || error instanceof ProtectedAcquisitionSessionError) throw error;
    throw new ProtectedAcquisitionSessionError(inputDrift);
  }
}

function sealInput(path: string, maximum: number, check: () => void, buffer: Buffer, expected?: InputDigest): SealedInput {
  return inputCheck(() => {
    check();
    const parent = inputStat(dirname(path), true);
    const identity = inputStat(path, false);
    requireSession(identity.size <= BigInt(maximum) &&
      (expected?.bytes === undefined || identity.size === BigInt(expected.bytes)), inputDrift);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let sha256: string;
    try {
      requireSession(sameInput(identity, fstatSync(fd, { bigint: true })), inputDrift);
      const digest = createHash('sha256');
      const size = Number(identity.size);
      let position = 0;
      while (position < size) {
        check();
        const count = readSync(fd, buffer, 0, Math.min(buffer.byteLength, size - position), position);
        requireSession(count > 0, inputDrift);
        digest.update(buffer.subarray(0, count));
        position += count;
      }
      requireSession(readSync(fd, buffer, 0, 1, position) === 0 &&
        sameInput(identity, fstatSync(fd, { bigint: true })), inputDrift);
      sha256 = digest.digest('hex');
      requireSession(!expected || sha256 === expected.sha256, inputDrift);
    } finally { closeSync(fd); }
    requireSession(sameInput(identity, inputStat(path, false)) && sameInput(parent, inputStat(dirname(path), true)), inputDrift);
    check();
    return { path, identity, parent, sha256 };
  });
}

function sealFacts(directory: string, facts: Awaited<ReturnType<typeof captureProtectedAcquisitionFacts>>,
  seal: (path: string, maximum: number, expected?: InputDigest) => SealedInput) {
  const names = ['facts.intent.json', 'facts.result.json', 'd1-schema.raw.json'];
  if (facts.sequenceTable === 'present') names.push('d1-sequences.raw.json');
  return [seal(join(directory, 'source-facts.json'), metadataBytes, { sha256: facts.observationSha256 }),
    ...names.map(name => seal(join(directory, name), metadataBytes))];
}

export async function runFixtureAcquisitionSession(options: FixtureAcquisitionSessionOptions) {
  let owner: Awaited<ReturnType<typeof createFixtureAcquisitionTransport>> | undefined;
  try {
    requireSession(options.mode === 'fixture-only', 'ACQUISITION_SESSION_FIXTURE_ONLY');
    const root = options.sessionDirectory;
    requireSession(root === resolve(root), 'ACQUISITION_SESSION_DIRECTORY');
    await privatePath(dirname(root), true);
    mkdirSync(root, { mode: 0o700 });
    syncDirectory(dirname(root));

    const transportDirectory = join(root, 'transport');
    const admitted = await createFixtureAcquisitionTransport({
      ...options.transport, fixtureOnly: true, journalDirectory: transportDirectory,
    });
    owner = admitted;
    const check = () => admitted.accept(() => {});
    const buffer = Buffer.alloc(64 * 1024);
    const seal = (path: string, maximum: number, expected?: InputDigest) => sealInput(path, maximum, check, buffer, expected);
    const { responseBytes, downloadBytes } = admitted.snapshot().limits;
    const beforeDirectory = join(root, 'before');
    const captureDirectory = join(root, 'capture');
    const afterDirectory = join(root, 'after');
    const before = await captureProtectedAcquisitionFacts({
      mode: 'fixture-only', phase: 'before', captureDirectory: beforeDirectory, owner: admitted,
    });
    const sealedInputs = sealFacts(beforeDirectory, before, seal);
    let privateCapture: { signedUrl: string; pins: ReadonlyMap<string, FixtureCaptureFilePin> } | undefined;
    const rawResponses = new Map<number, InputDigest>();
    const capture = await captureProtectedAcquisitionFixture({
      mode: 'fixture-only', source: PROTECTED_ACQUISITION_SOURCE, captureDirectory,
      validUntil: options.transport.validUntil, clock: options.transport.clock, limits: options.captureLimits,
      io: { fixtureOnly: true, async exchange(request, signal) {
        const response = await admitted.management(request, signal);
        rawResponses.set(request.ordinal, { bytes: response.body.byteLength, sha256: createHash('sha256').update(response.body).digest('hex') });
        return response;
      } },
    }, (signedUrl, pins) => { privateCapture = { signedUrl, pins }; });
    requireSession(privateCapture, 'ACQUISITION_SESSION_EXPORT_DESCRIPTOR');
    const { signedUrl, pins } = privateCapture;
    requireSession(pins.size === 4 + 3 * capture.requests, inputDrift);
    function sealCapture(name: string, raw?: InputDigest) {
      const expected = pins.get(name);
      requireSession(expected && (!raw || expected.bytes === raw.bytes && expected.bytes <= responseBytes &&
        expected.sha256 === raw.sha256), inputDrift);
      return seal(join(captureDirectory, name), expected.bytes, expected);
    }
    for (const name of ['capture.intent.json', 'signed-export-descriptor.private.json', 'capture.result.json', 'legacy-auth.private.json']) {
      sealedInputs.push(sealCapture(name));
    }
    for (let ordinal = 1; ordinal <= capture.requests; ordinal++) {
      const expected = rawResponses.get(ordinal);
      requireSession(expected, inputDrift);
      const stem = `request-${String(ordinal).padStart(4, '0')}`;
      sealedInputs.push(sealCapture(stem + '.intent.json'), sealCapture(stem + '.raw', expected), sealCapture(stem + '.ack.json'));
    }
    const after = await captureProtectedAcquisitionFacts({
      mode: 'fixture-only', phase: 'after', captureDirectory: afterDirectory, owner: admitted,
    });
    requireSession(before.factsSha256 === after.factsSha256, 'ACQUISITION_SESSION_FACTS_DRIFT');
    sealedInputs.push(...sealFacts(afterDirectory, after, seal));
    const sqlPath = join(transportDirectory, 'source.private.sql');
    const sql = await admitted.downloadSql({ signedUrl, destination: sqlPath });

    // Facts and KV captures were sealed before later exchanges could change
    // them. Reopen the fixed inputs by identity and compare every byte before
    // handing them off. The SQL starts from its checked download digest.
    for (const input of sealedInputs) {
      const readback = seal(input.path, Number(input.identity.size), input);
      requireSession(sameInput(input.identity, readback.identity) && sameInput(input.parent, readback.parent), inputDrift);
    }
    sealedInputs.push(seal(sqlPath, downloadBytes, sql));
    inputCheck(() => {
      for (const input of sealedInputs) {
        check();
        requireSession(sameInput(input.identity, inputStat(input.path, false)) &&
          sameInput(input.parent, inputStat(dirname(input.path), true)), inputDrift);
      }
    });

    return admitted.accept(() => {
      const transport = admitted.snapshot();
      requireSession(sql.bytes > 0, 'ACQUISITION_SESSION_EMPTY_SQL');
      const observations = before.requests + capture.requests + after.requests + 1;
      requireSession(transport.ioSettled && observations === transport.requests &&
        observations === transport.sent, 'ACQUISITION_SESSION_ACCOUNTING');
      const result = {
        format: 1, fixtureOnly: true, fixtureSessionComplete: true, providerAuthenticated: false,
        globalQuiescenceEstablished: false, productionAcquisitionQualified: false,
        standaloneAcceptance: false, acceptanceRequiresSuccessfulSettledOwner: true,
        automaticRetry: false, automaticResume: false, requests: transport.requests,
        responseBytes: transport.receivedBytes,
        facts: { sha256: before.factsSha256, before: before.observationSha256, after: after.observationSha256 },
        kvNames: capture.kvNames, kvPages: capture.kvPages, exportPolls: capture.exportPolls,
        sql: { bytes: sql.bytes, sha256: sql.sha256 },
      } as const;
      const fd = openSync(join(transportDirectory, 'session.result.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, JSON.stringify(result) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDirectory(transportDirectory);
      return result;
    });
  } catch (error) {
    const known = error instanceof ProtectedAcquisitionSessionError || error instanceof ProtectedAcquisitionError ||
      error instanceof ProtectedAcquisitionFactsError || error instanceof ProtectedAcquisitionTransportError;
    if (owner) {
      try { owner.accept(() => { throw error; }); } catch { /* The owner retains its terminal fence. */ }
    }
    throw new ProtectedAcquisitionSessionError(known ? error.code : 'ACQUISITION_SESSION_LOCAL',
      (!known || error.ioSettled) && (owner?.snapshot().ioSettled ?? true));
  }
}
