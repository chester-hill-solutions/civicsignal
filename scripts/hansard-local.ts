import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { emitCorpusItem } from '@chester-hill-solutions/corpus';
import { getHansardSpeech, hansardCorpus, senateHansardCorpus } from '../src/corpora/adapters';
import { policyFor } from '../src/corpora/policies';
import { discoverHouseHansardWeek, fetchHouseHansardEdition } from './lib/hansard-house-source';
import { discoverSenateHansardWeek, fetchSenateHansardEdition } from './lib/hansard-senate-source';
import { importHansardEdition, importHansardSitting, importHansardXmlEdition, importSenateEdition } from './lib/hansard-store';
import { readHansardEditionFile, readHansardWeekFiles, replayHansardWeek } from './lib/hansard-week';
import { localD1 } from './lib/local-d1';

export { importHansardSitting };

const USAGE = `Usage:
  bun scripts/hansard-local.ts import <sqlite-file> <sitting.json>
  bun scripts/hansard-local.ts import-xml <sqlite-file> <hansard.xml>
  bun scripts/hansard-local.ts replay-week <sqlite-file> <week.json>
  bun scripts/hansard-local.ts sync-week <sqlite-file> <parliament-session> <monday>
  bun scripts/hansard-local.ts replay-senate-week <sqlite-file> <week.json>
  bun scripts/hansard-local.ts sync-senate-week <sqlite-file> <parliament-session> <monday>
  bun scripts/hansard-local.ts search <sqlite-file> <en|fr> "<phrase>"
  bun scripts/hansard-local.ts search-senate <sqlite-file> <en|fr> "<phrase>"
  bun scripts/hansard-local.ts show <sqlite-file> <speech-id>`;

interface CommandRequest {
  command: string;
  databaseFile: string;
  value: string;
  phrase?: string;
  senate: boolean;
  sync: boolean;
  replay: boolean;
  search: boolean;
  importing: boolean;
}

function validateCommand(args: string[], request: CommandRequest) {
  const { command, databaseFile, value, phrase, sync, search, importing } = request;
  if (!databaseFile || !value) throw new Error(USAGE);
  if (sync) {
    if (args.length !== 4 || !phrase) throw new Error(USAGE);
  } else if (search) {
    if (args.length !== 4 || (value !== 'en' && value !== 'fr') || !phrase?.trim()) throw new Error(USAGE);
  } else if ((!importing && command !== 'show') || args.length !== 3) {
    throw new Error(USAGE);
  }
}

function parseCommand(args: string[]): CommandRequest {
  const [command, databaseFile, value, phrase] = args;
  const senate = command === 'sync-senate-week' || command === 'replay-senate-week' || command === 'search-senate';
  const sync = command === 'sync-week' || command === 'sync-senate-week';
  const replay = command === 'replay-week' || command === 'replay-senate-week';
  const search = command === 'search' || command === 'search-senate';
  const importing = command === 'import' || command === 'import-xml' || replay || sync;
  const request = { command: command ?? '', databaseFile: databaseFile ?? '', value: value ?? '', phrase,
    senate, sync, replay, search, importing };
  validateCommand(args, request);
  return request;
}

interface WeeklyInput {
  weekOf: string;
  sittings: { sittingId: string; sittingDate: string }[];
  load: (expected: { sittingId: string; sittingDate: string; edition: 'en' | 'fr' }) => Uint8Array | null | Promise<Uint8Array | null>;
}

function createCommandContext(sqlite: DatabaseSync) {
  const noNetwork = () => { throw new Error('Hansard local commands do not use the network.'); };
  return {
    db: localD1(sqlite),
    fetch: Object.assign(noNetwork, { preconnect: noNetwork }),
    now: () => new Date(),
  };
}

async function executeCommand(request: CommandRequest, sqlite: DatabaseSync,
  weeklyInput: WeeklyInput | undefined, xmlBytes?: Uint8Array) {
  const { command, value, phrase, senate, search, importing } = request;
  const ctx = createCommandContext(sqlite);
  if (importing) {
    sqlite.exec('PRAGMA foreign_keys = ON');
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1").get()) {
      sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    }
    if (weeklyInput) {
      const { load, ...week } = weeklyInput;
      const result = await replayHansardWeek(sqlite, week, load, senate ? importSenateEdition : importHansardEdition);
      console.log(JSON.stringify(result, null, 2));
      if (!result.complete) process.exitCode = 1;
    } else if (xmlBytes) {
      const result = importHansardXmlEdition(sqlite, xmlBytes);
      console.log(JSON.stringify({ written: result.written, ids: result.ids,
        publicationId: result.publicationId, edition: result.edition, status: result.status, removed: result.removed,
      }, null, 2));
    } else {
      const input: unknown = JSON.parse(readFileSync(value, 'utf8'));
      const ids = importHansardSitting(sqlite, input);
      console.log(JSON.stringify({ written: ids.length, ids }, null, 2));
    }
  } else if (search) {
    const corpus = senate ? senateHansardCorpus : hansardCorpus;
    const results = await corpus.retrieve({ topic: phrase, language: value }, ctx);
    console.log(JSON.stringify(results.map((row) => emitCorpusItem(corpus.policy, row)), null, 2));
  } else {
    const result = await getHansardSpeech(value, ctx);
    const policy = result ? policyFor(result.corpusId) : undefined;
    console.log(JSON.stringify(result && policy ? emitCorpusItem(policy, result) : null, null, 2));
  }
}

async function main(args: string[]) {
  const request = parseCommand(args);
  const { Database: SQLite } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (file: string, options: { readonly: boolean; create: boolean; strict: boolean }) => DatabaseSync;
  };
  const weeklyFiles = request.replay ? readHansardWeekFiles(request.value) : undefined;
  const discover = request.senate ? discoverSenateHansardWeek : discoverHouseHansardWeek;
  const officialWeek = request.sync
    ? { ...await discover(request.value, request.phrase ?? ''),
      load: request.senate ? fetchSenateHansardEdition : fetchHouseHansardEdition }
    : undefined;
  const weeklyInput = weeklyFiles ?? officialWeek;
  const xmlBytes = request.command === 'import-xml' ? readHansardEditionFile(request.value) : undefined;
  const sqlite = new SQLite(request.databaseFile, { readonly: !request.importing, create: request.importing, strict: true });
  try {
    await executeCommand(request, sqlite, weeklyInput, xmlBytes);
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
