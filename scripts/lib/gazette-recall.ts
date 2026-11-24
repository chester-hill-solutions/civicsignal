import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { parseGazetteRequest, runGazetteRequest } from '../../src/routes/gazette';
import { GAZETTE_PATHS } from '../../src/routes/gazette-contract';
import { localD1 } from './local-d1';

/** Read the replayed SQLite file with the same query validation and SQL as the Worker. */
export async function recallGazette(args: string[]) {
  const [command, file, value, part, topic] = args;
  const url = new URL(GAZETTE_PATHS.search, 'https://local.invalid');
  if (!file || !value) throw new Error('Supply a Gazette database file and a search or record ID.');
  if (command === 'search' && part && topic && args.length === 5) {
    url.search = new URLSearchParams({ language: value, part, topic }).toString();
  } else if (command !== 'show' || args.length !== 3) {
    throw new Error('Use search <db> <en|fr> <I|II> <topic> or show <db> <id>.');
  }
  const request = parseGazetteRequest(command === 'show' ? { pathId: encodeURIComponent(value) } : {}, url);
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { readonly: boolean; strict: boolean }) => DatabaseSync;
  };
  const sqlite = new Database(file, { readonly: true, strict: true });
  try {
    const response = await runGazetteRequest(localD1(sqlite), request);
    return response;
  } finally {
    sqlite.close();
  }
}
