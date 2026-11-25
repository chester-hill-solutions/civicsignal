import { readConsultationDictionary } from '../../src/corpora/consultations';
import { textSha256 } from '../../src/corpora/text-store';
import { parseCsvText } from '../../src/csv';

const sources = {
  csv: { url: 'https://open.canada.ca/static/consultations_open.csv', extension: 'csv', limit: 16 * 1024 * 1024 },
  schema: { url: 'https://open.canada.ca/data/recombinant-published-schema/consultations.json', extension: 'json', limit: 512 * 1024 },
} as const;

const columns = [
  'registration_number', 'partner_departments', 'subjects', 'title_en', 'title_fr', 'description_en',
  'description_fr', 'start_date', 'end_date', 'status', 'profile_page_en', 'profile_page_fr',
  'report_available_online', 'report_link_en', 'report_link_fr', 'owner_org', 'owner_org_title',
];

export interface ConsultationArchive {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  put(key: string, body: Uint8Array<ArrayBuffer>, options: {
    onlyIf: { etagDoesNotMatch: string }; sha256: string;
  }): Promise<{ key: string; size: number } | null>;
}

export interface ConsultationSourceRef {
  input: string;
  archivedAs: string;
  bytes: number;
  sha256: string;
}

export type ConsultationSources = Record<keyof typeof sources, ConsultationSourceRef>;
type Source = typeof sources[keyof typeof sources];

function archiveKey(source: Source, digest: string): string {
  return `consultations/sources/${digest}.${source.extension}`;
}

async function readBytes(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Consultation source exceeds its byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error('Consultation source is empty.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function archivedBytes(bucket: ConsultationArchive, source: Source, ref: ConsultationSourceRef) {
  if (ref.input !== source.url || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.archivedAs !== archiveKey(source, ref.sha256) ||
      !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > source.limit) {
    throw new Error('Invalid consultation archive reference.');
  }
  const object = await bucket.get(ref.archivedAs);
  if (!object || object.size !== ref.bytes) throw new Error('Consultation archive size mismatch or missing object.');
  const bytes = await readBytes(object.body, ref.bytes);
  if (bytes.byteLength !== ref.bytes || await textSha256(bytes) !== ref.sha256) {
    throw new Error('Consultation archive checksum mismatch.');
  }
  return bytes;
}

async function acquire(bucket: ConsultationArchive, source: Source, send: typeof fetch) {
  const response = await send(source.url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200 || !response.body || response.headers.has('content-range')) {
    await response.body?.cancel();
    throw new Error(`Expected a complete consultation ${source.extension} source (HTTP ${response.status}).`);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > source.limit)) {
    await response.body.cancel();
    throw new Error('Invalid consultation source content length.');
  }
  const bytes = await readBytes(response.body, source.limit);
  const encoding = response.headers.get('content-encoding');
  if (length !== null && (!encoding || encoding === 'identity') && Number(length) !== bytes.length) {
    throw new Error('Incomplete consultation source body.');
  }
  const sha256 = await textSha256(bytes);
  const ref = { input: source.url, archivedAs: archiveKey(source, sha256), bytes: bytes.length, sha256 };
  const result = await bucket.put(ref.archivedAs, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256 });
  if (result === null) await archivedBytes(bucket, source, ref);
  else if (result.key !== ref.archivedAs || result.size !== ref.bytes) throw new Error('Invalid consultation archive write receipt.');
  return ref;
}

/** The checkpoint contains only verified object references. Individual originals survive a partial fetch. */
export async function acquireConsultationSources(bucket: ConsultationArchive, send: typeof fetch = fetch): Promise<ConsultationSources> {
  const csv = await acquire(bucket, sources.csv, send);
  const schema = await acquire(bucket, sources.schema, send);
  return { csv, schema };
}

/** Decode the persisted originals so publication and replay both consume the same bytes. */
export async function readConsultationSources(bucket: ConsultationArchive, refs: ConsultationSources) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const csvText = decoder.decode(await archivedBytes(bucket, sources.csv, refs.csv));
  const firstNewline = csvText.search(/[\r\n]/);
  const [header] = firstNewline > 0 ? parseCsvText(csvText.slice(0, firstNewline)) : [];
  if (!header || new Set(header).size !== header.length || columns.some(column => !header.includes(column))) {
    throw new Error('Invalid consultation catalogue header.');
  }
  const dictionaryJson: unknown = JSON.parse(decoder.decode(await archivedBytes(bucket, sources.schema, refs.schema)));
  const dictionary = readConsultationDictionary(dictionaryJson);
  if (!dictionary.subjects.size || !dictionary.statusLabels.size) {
    throw new Error('Invalid consultation data dictionary.');
  }
  return { csvText, dictionaryJson };
}
