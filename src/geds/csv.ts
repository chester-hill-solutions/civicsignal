import type { GedsRawRow } from './types';
import { CsvError, CsvParser } from '../csv';

export { CsvError } from '../csv';

/**
 * The export's CSV reader.
 *
 * Two details are not optional:
 *
 *   * **ISO-8859-1.** The catalogue says the file is Latin-1 and the file is
 *     Latin-1. Decoding it as UTF-8 turns every accented name into a replacement
 *     character, which is both wrong and irreversible.
 *   * **Quoted newlines.** Names and addresses contain commas and newlines
 *     inside quotes. A `split('\n')` makes 197,688 rows out of 189,994 records
 *     and silently mangles the rest.
 *
 * The parser is streaming: it holds one row rather than the 245 MB file. That
 * matters because the same code runs in a Worker's refresh path.
 *
 * The shared state machine in `src/csv.ts` also repairs the publisher's 15
 * malformed records in the October 25, 2026 export, which repeat an unescaped
 * quote inside a quoted field (for example `"... SERVICES D"IDENTITÉ NUMÉrique"`).
 * A strict reader closes the field there and splits the record into extra
 * columns; this one keeps the quote as text and the row whole.
 */

export const GEDS_COLUMNS = [
  'Surname',
  'GivenName',
  'Initials',
  'Prefix (EN)',
  'Prefix (FR)',
  'Suffix (EN)',
  'Suffix (FR)',
  'Title (EN)',
  'Title (FR)',
  'Telephone Number',
  'Fax Number',
  'TDD Number',
  'Secure Telephone Number',
  'Secure Fax Number',
  'Alternate Telephone Number',
  'Email',
  'Street Address (EN)',
  'Street Address (FR)',
  'Country (EN)',
  'Country (FR)',
  'Province (EN)',
  'Province (FR)',
  'City (EN)',
  'City (FR)',
  'Postal Code',
  'PO Box (EN)',
  'PO Box (FR)',
  'Mailstop',
  'Building (EN)',
  'Building (FR)',
  'Floor',
  'Room',
  'Administrative Assistant',
  'Administrative Assistant Telephone Number',
  'Executive Assistant',
  'Executive Assistant Telephone Number',
  'Department Acronym',
  'Department Name (EN)',
  'Department Name (FR)',
  'Organization Acronym',
  'Organization Name (EN)',
  'Organization Name (FR)',
  'Organization Structure (EN)',
  'Organization Structure (FR)',
] as const;

const required = new Set<string>(['Surname', 'GivenName', 'Department Acronym', 'Organization Structure (EN)']);

export type ChunkSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export async function* streamChunks(source: ChunkSource): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in Object(source)) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk;
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Decode Latin-1 without the WHATWG windows-1252 remapping. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

export async function* csvRows(source: ChunkSource): AsyncGenerator<string[]> {
  const parser = new CsvParser();
  for await (const chunk of streamChunks(source)) yield* parser.read(decodeLatin1(chunk));
  yield* parser.finish();
}

export interface CsvHeader {
  names: string[];
  index: Map<string, number>;
}

export function readHeader(row: string[]): CsvHeader {
  const names = row.map((name) => name.replace(/^\uFEFF/, '').trim());
  const index = new Map<string, number>();
  names.forEach((name, i) => {
    if (name && index.has(name)) throw new CsvError(`duplicate CSV column: ${name}`);
    if (name) index.set(name, i);
  });
  for (const name of required) {
    if (!index.has(name)) throw new CsvError(`missing required CSV column: ${name}`);
  }
  return { names, index };
}

export function rowFromValues(header: CsvHeader, values: string[]): GedsRawRow {
  if (values.length !== header.names.length) throw new CsvError('CSV row width differs from its header');
  const out: Record<string, string> = {};
  for (const name of GEDS_COLUMNS) {
    const i = header.index.get(name);
    out[name] = i == null ? '' : (values[i] ?? '');
  }
  return out as unknown as GedsRawRow;
}

/** GEDS rows with a 1-based source row number (the header is not a row). */
export async function* gedsRows(source: ChunkSource): AsyncGenerator<{ row: GedsRawRow; sourceRow: number }> {
  let header: CsvHeader | undefined;
  let sourceRow = 0;
  for await (const values of csvRows(source)) {
    if (!header) {
      header = readHeader(values);
      continue;
    }
    sourceRow++;
    yield { row: rowFromValues(header, values), sourceRow };
  }
  if (!header) throw new CsvError('the export is empty');
}

/** Test and fixture helper: parse a string as the export's Latin-1 text. */
export function rowsFromString(text: string): { row: GedsRawRow; sourceRow: number }[] {
  const parser = new CsvParser();
  const [columns, ...rows] = [...parser.read(text), ...parser.finish()];
  if (!columns) return [];
  const header = readHeader(columns);
  return rows.map((values, index) => ({ row: rowFromValues(header, values), sourceRow: index + 1 }));
}
