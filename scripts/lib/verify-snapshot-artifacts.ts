import { createHash } from 'node:crypto';
import { indexKey, manifestKey } from '../../src/ingest/snapshot-format';
import { SnapshotReader } from '../../src/ingest/snapshot-source';

export interface ArtifactPin { key: string; bytes: number; sha256: string }

export interface SnapshotArtifactReference {
  commit: string;
  parser: string;
  date: string;
  manifest: ArtifactPin;
  artifacts: number;
  artifactBytes: number;
  rows: number;
}

export interface SnapshotArtifactBudget {
  maxOperations: number;
  maxResponseBytes: number;
  wallMs: number;
  requestMs: number;
}

export type OpenSnapshotArtifact = (key: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

class SnapshotArtifactError extends Error {
  constructor(code: string) { super(`SNAPSHOT_ARTIFACT_${code}`); }
}

function requireArtifact(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SnapshotArtifactError(code);
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function checkPin(pin: { key: string; bytes: number; sha256?: string }): asserts pin is ArtifactPin {
  requireArtifact(typeof pin.key === 'string' && pin.key.length <= 1024 &&
    pin.key.split('/').every(segment => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..') &&
    positive(pin.bytes) && typeof pin.sha256 === 'string' && /^[a-f0-9]{64}$/.test(pin.sha256), 'PIN');
}

async function readChunks(body: ReadableStream<Uint8Array>, observe: (chunk: Uint8Array) => void): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      observe(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function verifySnapshotArtifacts(options: {
  reference: SnapshotArtifactReference;
  budget: SnapshotArtifactBudget;
  open: OpenSnapshotArtifact;
  canonical?: ArtifactPin;
}): Promise<{ artifacts: number; artifactBytes: number; rows: number; manifestSha256: string; canonical?: { sha256: string; bytes: number } }> {
  const reference = { ...options.reference, manifest: { ...options.reference.manifest } };
  const canonical = options.canonical && { ...options.canonical };
  const { maxOperations, maxResponseBytes, wallMs, requestMs } = options.budget;
  const open = options.open;
  requireArtifact(positive(maxOperations) && positive(maxResponseBytes) && positive(wallMs) && positive(requestMs) &&
    wallMs <= 2_147_483_647 && typeof open === 'function', 'BUDGET');
  requireArtifact(typeof reference.commit === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(reference.commit) &&
    typeof reference.parser === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(reference.parser) &&
    typeof reference.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reference.date) &&
    positive(reference.artifacts) && reference.artifacts >= 3 && positive(reference.artifactBytes) && positive(reference.rows), 'REFERENCE');
  checkPin(reference.manifest);
  requireArtifact(reference.manifest.key === manifestKey(reference.commit, reference.parser) &&
    reference.manifest.bytes < reference.artifactBytes, 'MANIFEST_PIN');
  if (canonical) {
    checkPin(canonical);
    requireArtifact(canonical.key !== reference.manifest.key && canonical.key !== indexKey(reference.commit, reference.parser), 'CANONICAL_KEY');
  }
  const expectedOperations = reference.artifacts + (canonical ? 2 : 0);
  const expectedBytes = reference.artifactBytes + (canonical ? 2 * canonical.bytes : 0);
  requireArtifact(positive(expectedOperations) && expectedOperations <= maxOperations &&
    positive(expectedBytes) && expectedBytes <= maxResponseBytes, 'BUDGET');

  const wallDeadline = performance.now() + wallMs;
  let operations = 0;
  let received = 0;
  async function withArtifact(pin: ArtifactPin, consume: (body: ReadableStream<Uint8Array>) => Promise<void>): Promise<void> {
    const started = performance.now();
    const deadline = Math.min(wallDeadline, started + requestMs);
    const controller = new AbortController();
    const signal = controller.signal;
    const timeout = new SnapshotArtifactError('DEADLINE');
    function checkDeadline() {
      if (signal.aborted || performance.now() >= deadline) throw timeout;
    }
    checkDeadline();
    requireArtifact(++operations <= maxOperations, 'BUDGET');

    let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel' | 'releaseLock'> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accepted = false;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(timeout); controller.abort(); }, Math.max(1, Math.ceil(deadline - started)));
    });
    try {
      const pending = Promise.resolve().then(() => {
        checkDeadline();
        return open(pin.key, signal);
      });
      // An adapter can settle after its deadline. Dispose of that body without
      // making progress dependent on how the adapter handles cancellation.
      void pending.then(body => { if (signal.aborted) return body.cancel(); }).catch(() => {});
      const source = await Promise.race([pending, expired]);
      const sourceReader = source.getReader();
      reader = sourceReader;
      checkDeadline();
      let bytes = 0;
      let complete = false;
      const digest = createHash('sha256');
      const checked = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            checkDeadline();
            const next = await Promise.race([sourceReader.read(), expired]);
            checkDeadline();
            if (next.done) {
              requireArtifact(bytes === pin.bytes, 'SIZE');
              requireArtifact(digest.digest('hex') === pin.sha256, 'SHA256');
              complete = true;
              output.close();
              return;
            }
            const chunk = next.value;
            requireArtifact(chunk instanceof Uint8Array && chunk.byteLength <= pin.bytes - bytes, 'SIZE');
            requireArtifact(chunk.byteLength <= maxResponseBytes - received, 'BUDGET');
            bytes += chunk.byteLength;
            received += chunk.byteLength;
            // The adapter may reuse its chunk storage. Verify the same bytes
            // that the manifest parser, row counter, or index reader receives.
            const owned = new Uint8Array(chunk);
            digest.update(owned);
            output.enqueue(owned);
          } catch (error) {
            output.error(error instanceof SnapshotArtifactError ? error : new SnapshotArtifactError('READ'));
          }
        },
      }, { highWaterMark: 0 });
      await Promise.race([consume(checked), expired]);
      checkDeadline();
      requireArtifact(complete, 'INCOMPLETE');
      accepted = true;
    } catch (error) {
      throw error instanceof SnapshotArtifactError ? error : new SnapshotArtifactError('READ_OR_FORMAT');
    } finally {
      clearTimeout(timer);
      if (!accepted) {
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
      reader?.releaseLock();
    }
  }

  const discard = (body: ReadableStream<Uint8Array>) => readChunks(body, () => {});
  if (canonical) await withArtifact(canonical, discard);

  const manifestBytes = new Uint8Array(reference.manifest.bytes);
  let manifestOffset = 0;
  await withArtifact(reference.manifest, body => readChunks(body, chunk => {
    manifestBytes.set(chunk, manifestOffset);
    manifestOffset += chunk.byteLength;
  }));

  let indexBody: ReadableStream<Uint8Array> | undefined;
  const reader = new SnapshotReader({
    async get(key) {
      if (key === reference.manifest.key) return { arrayBuffer: async () => manifestBytes.buffer };
      if (key === indexKey(reference.commit, reference.parser) && indexBody) return {
        body: indexBody,
        arrayBuffer: async () => { throw new SnapshotArtifactError('INDEX_STREAM_REQUIRED'); },
      };
      return null;
    },
  }, reference.commit, { parser: reference.parser });
  const manifest = await reader.manifest().catch(() => { throw new SnapshotArtifactError('MANIFEST_FORMAT'); });
  requireArtifact(manifest.date === reference.date && manifest.rows.count === reference.rows &&
    manifest.rows.parts.length + 2 === reference.artifacts &&
    reference.manifest.bytes + manifest.rows.bytes + manifest.index.bytes === reference.artifactBytes, 'MANIFEST_REFERENCE');

  const parts = manifest.rows.parts.map(part => {
    checkPin(part);
    requireArtifact(part.key !== canonical?.key, 'CANONICAL_KEY');
    return part;
  });
  const index = manifest.index;
  checkPin(index);

  let rows = 0;
  for (const part of parts) {
    let lastByte: number | undefined;
    let hasContent = false;
    await withArtifact(part, body => readChunks(body, chunk => {
      for (let start = 0; start < chunk.length;) {
        const end = chunk.indexOf(10, start);
        const limit = end < 0 ? chunk.length : end;
        // JSON permits space, tab, and carriage return within the framing.
        // Retain whether a line has content when it spans multiple chunks.
        while (!hasContent && start < limit) {
          const byte = chunk[start++]!;
          hasContent = byte !== 32 && byte !== 9 && byte !== 13;
        }
        if (end < 0) break;
        requireArtifact(hasContent, 'ROW_FRAMING');
        hasContent = false;
        rows++;
        start = end + 1;
      }
      if (chunk.byteLength) lastByte = chunk[chunk.byteLength - 1];
      requireArtifact(rows <= reference.rows, 'ROW_COUNT');
    }));
    requireArtifact(lastByte === 10, 'ROW_FRAMING');
  }
  requireArtifact(rows === reference.rows, 'ROW_COUNT');

  await withArtifact(index, async body => {
    indexBody = body;
    await reader.verifyIndex();
  });
  if (canonical) await withArtifact(canonical, discard);
  requireArtifact(operations === expectedOperations && received === expectedBytes, 'ACCOUNTING');
  return {
    artifacts: reference.artifacts,
    artifactBytes: reference.artifactBytes,
    rows,
    manifestSha256: reference.manifest.sha256,
    ...(canonical && { canonical: { sha256: canonical.sha256, bytes: canonical.bytes } }),
  };
}
