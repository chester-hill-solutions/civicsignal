import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CONSULTATION_SOURCE, parseConsultationCsv } from '../src/corpora/consultations';
import { materializeConsultations } from '../src/corpora/consultations-materialize';

type Value = string | number | null;
interface LocalDatabase {
  exec(query: string): unknown;
  prepare(query: string): {
    get(...values: Value[]): unknown;
    all(...values: Value[]): unknown[];
    run(...values: Value[]): unknown;
  };
}

function args(argv: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--csv', '--schema', '--db', '--observed-at', '--receipt'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    options[flag] = value;
  }
  if (!options['--csv'] || !options['--schema']) {
    throw new Error('Usage: bun scripts/materialize-consultations.ts --csv <path|https-url> --schema <path|https-url> [--db <path>] [--observed-at <iso>] [--receipt <path>]');
  }
  return {
    csv: options['--csv'],
    schema: options['--schema'],
    db: resolve(options['--db'] ?? 'data/corpus/consultations/catalogue.sqlite'),
    observedAt: options['--observed-at'] ?? new Date().toISOString(),
    receipt: resolve(options['--receipt'] ?? 'dist/consultations/receipt.json'),
  };
}

async function bytesFor(input: string): Promise<Uint8Array> {
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error(`Invalid source URL: ${input}`); }
    if (url.protocol !== 'https:') throw new Error('Only https URLs may be fetched.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${input}: HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return readFileSync(input);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceInfo = (input: string, archivedAs: string, bytes: Uint8Array) => ({
  input,
  archivedAs,
  bytes: bytes.byteLength,
});

async function main() {
  const started = Date.now();
  const options = args(process.argv.slice(2));
  const [csvBytes, schemaBytes] = await Promise.all([bytesFor(options.csv), bytesFor(options.schema)]);
  const csvSha256 = sha256(csvBytes);
  const schemaSha256 = sha256(schemaBytes);
  const sourceDir = resolve(dirname(options.db), 'sources');
  mkdirSync(sourceDir, { recursive: true });
  const csvArchive = resolve(sourceDir, `${csvSha256}.csv`);
  const schemaArchive = resolve(sourceDir, `${schemaSha256}.json`);
  writeFileSync(csvArchive, csvBytes);
  writeFileSync(schemaArchive, schemaBytes);

  const csvText = new TextDecoder().decode(csvBytes);
  const dictionaryJson: unknown = JSON.parse(new TextDecoder().decode(schemaBytes));
  const csvSource = sourceInfo(options.csv, csvArchive, csvBytes);
  const schemaSource = sourceInfo(options.schema, schemaArchive, schemaBytes);
  mkdirSync(dirname(options.db), { recursive: true });
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { create: boolean }) => LocalDatabase & { close(): void };
  };
  const db = new Database(options.db, { create: true });
  try {
    const result = materializeConsultations(db, {
      csvText,
      dictionaryJson,
      observedAt: options.observedAt,
      csvSha256,
      schemaSha256,
      csvSource,
      schemaSource,
    });
    const receipt = {
      source: CONSULTATION_SOURCE,
      observedAt: result.observedAt,
      revision: result.revision,
      csv: {
        input: options.csv,
        sha256: csvSha256,
        bytes: csvBytes.byteLength,
        rows: parseConsultationCsv(csvText).rows.length,
      },
      schema: { input: options.schema, sha256: schemaSha256, bytes: schemaBytes.byteLength },
      counts: result.counts,
      durationMs: Date.now() - started,
      versions: { bun: process.versions.bun ?? 'unknown' },
    };
    mkdirSync(dirname(options.receipt), { recursive: true });
    writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
