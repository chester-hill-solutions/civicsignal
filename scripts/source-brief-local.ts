import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { BilingualBriefSchema, readBilingualBrief, type BriefOptions } from './lib/bilingual-brief';

const USAGE = `Usage:
  bun scripts/source-brief-local.ts <sqlite-file> [--state brief.json] [--topic-en TEXT] [--topic-fr TEXT]

Reads the local Gazette/Hansard source-feed journal and prints one bilingual JSON brief.
Use --state to resume the topics and cursors from a saved brief.
Supply both topic arguments to select different terms.`;

function parseArgs(args: string[]): { file: string; options: BriefOptions } {
  const [file, ...rest] = args;
  if (!file) throw new Error(USAGE);
  let saved: BriefOptions = {};
  const topics: NonNullable<BriefOptions['topics']> = {};
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag || value === undefined || seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === '--state') {
      const parsed = BilingualBriefSchema.pick({ schemaVersion: true, cursors: true, topics: true }).strip()
        .safeParse(JSON.parse(readFileSync(value, 'utf8')));
      if (!parsed.success) throw new Error('The state file must contain the topics and cursors from a saved brief.');
      saved = { topics: parsed.data.topics, cursors: parsed.data.cursors };
    } else if (flag === '--topic-en' && value.trim()) topics.en = value.trim();
    else if (flag === '--topic-fr' && value.trim()) topics.fr = value.trim();
    else throw new Error(USAGE);
  }
  return { file, options: { ...saved, topics: Object.keys(topics).length ? topics : saved.topics } };
}

async function main(args: string[]) {
  const { file, options } = parseArgs(args);
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { readonly: boolean; strict: boolean }) => DatabaseSync;
  };
  const sqlite = new Database(file, { readonly: true, strict: true });
  try {
    console.log(JSON.stringify(await readBilingualBrief(sqlite, options), null, 2));
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
