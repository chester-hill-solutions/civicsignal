/** Fixed offline composition over one finite injected transport. */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROTECTED_ACQUISITION_SOURCE, ProtectedAcquisitionError, captureProtectedAcquisitionFixture,
  type ProtectedAcquisitionFixtureOptions } from './protected-acquisition';
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
    const before = await captureProtectedAcquisitionFacts({
      mode: 'fixture-only', phase: 'before', captureDirectory: join(root, 'before'), owner: admitted,
    });
    let signedUrl: string | undefined;
    const capture = await captureProtectedAcquisitionFixture({
      mode: 'fixture-only', source: PROTECTED_ACQUISITION_SOURCE, captureDirectory: join(root, 'capture'),
      validUntil: options.transport.validUntil, clock: options.transport.clock, limits: options.captureLimits,
      io: { fixtureOnly: true, exchange: (request, signal) => admitted.management(request, signal) },
    }, (url) => { signedUrl = url; });
    const after = await captureProtectedAcquisitionFacts({
      mode: 'fixture-only', phase: 'after', captureDirectory: join(root, 'after'), owner: admitted,
    });
    requireSession(before.factsSha256 === after.factsSha256, 'ACQUISITION_SESSION_FACTS_DRIFT');
    requireSession(signedUrl, 'ACQUISITION_SESSION_EXPORT_DESCRIPTOR');
    const sql = await admitted.downloadSql({
      signedUrl, destination: join(transportDirectory, 'source.private.sql'),
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
