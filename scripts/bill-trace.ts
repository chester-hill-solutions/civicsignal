import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { BillLanguageSchema } from '../src/corpora/bill-trace';
import { readBillBrief } from '../src/routes/bill-trace';
import { localD1 } from './lib/local-d1';
import { replayBillTrace } from './lib/bill-trace-store';

const packet = fileURLToPath(new URL('../preview/bills/44-1-s-5/', import.meta.url));
async function main([command, file, value, ...rest]: string[]) {
  if (!file || rest.length || !['replay', 'brief'].includes(command ?? '')) {
    throw new Error('Usage: bun scripts/bill-trace.ts replay <sqlite-file> [packet-dir] | brief <sqlite-file> <en|fr>');
  }
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { readonly: boolean; create: boolean; strict: true }) => DatabaseSync;
  };
  const replay = command === 'replay';
  const db = new Database(file, { readonly: !replay, create: replay, strict: true });
  try {
    const result = replay ? replayBillTrace(db, value ?? packet) : await readBillBrief(localD1(db), BillLanguageSchema.parse(value));
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

if (import.meta.main) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
