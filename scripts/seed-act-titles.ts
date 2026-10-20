#!/usr/bin/env bun
/**
 * Seed the instrument titles into KV, for citation parsing.
 *
 * The brief resolves a citation structurally when the question names one — "section
 * 210 of the Canada Labour Code" is a key, not a similarity. To do that it needs the
 * list of Act titles the corpus actually contains, because the citation's title and
 * the corpus's title are often not the same string.
 *
 *   bun run seed:act-titles            # local
 *   bun run seed:act-titles -- --remote
 */
import { readFileSync } from 'node:fs';
import { storeActTitles } from '../src/corpora/act-titles';

const remote = process.argv.includes('--remote');
const path = 'dist/act-titles.json';

const titles = JSON.parse(readFileSync(path, 'utf8')) as string[];
console.log(`seeding ${titles.length} instrument titles into KV${remote ? ' (remote)' : ' (local)'}`);

const { getCloudflareContext } = await import('wrangler');
const ctx = await getCloudflareContext({ environment: remote ? undefined : undefined });
const env = ctx.env as Record<string, unknown>;
await storeActTitles(env as never, titles);
console.log('done');
