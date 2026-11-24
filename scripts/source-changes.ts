import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { matchSourceFeed, parseSourceFeedRequest, readSourceFeed } from '../src/routes/source-feed';
import { localD1 } from './lib/local-d1';

/** Inspect a local replay using the same filters, cursors and SQL as the Worker. */
async function main(args: string[]) {
  const [file, path] = args;
  if (args.length !== 2 || !file || !path) throw new Error('Usage: bun scripts/source-changes.ts <sqlite-file> "<feed path and query>"');
  const url = new URL(path, 'https://local.invalid');
  const source = matchSourceFeed(url.pathname);
  if (!source) throw new Error('Supply a Gazette, House or Senate changes path.');
  const query = parseSourceFeedRequest(source, url);
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { readonly: true; strict: true }) => DatabaseSync;
  };
  const sqlite = new Database(file, { readonly: true, strict: true });
  try {
    console.log(JSON.stringify(await readSourceFeed(localD1(sqlite), { source, query }), null, 2));
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
