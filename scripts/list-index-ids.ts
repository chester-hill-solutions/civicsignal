#!/usr/bin/env bun
/**
 * List the ids a Vectorize index holds.
 *
 * The index's own API lists its vector identifiers, so "what does the index
 * hold" is a question with a fact for an answer. That matters because the
 * alternative — a checkpoint that says how far the job got — is a claim, and a
 * claim about a job that ran three at a time was wrong twice.
 *
 * The cursor is the awkward part: the API hands one back with each page, and a
 * cursor that has expired is refused with "appears to be corrupted". So a
 * broken cursor restarts the listing from the beginning, and the pages are
 * merged: the listing is slower than it needs to be and never wrong.
 *
 *     bun scripts/list-index-ids.ts civicsignal-statutes-gemma > dist/index-ids.json
 */
import { fetchWithAuth } from './lib/cloudflare-auth';
import { writeFileSync } from 'node:fs';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const index = process.argv[2] ?? process.env.VECTORIZE_INDEX ?? 'civicsignal-statutes-gemma';
const pageSize = 1000;

const ids = new Set<string>();
let total = 0;
let restarts = 0;

async function list(): Promise<void> {
  let cursor: string | undefined;
  do {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${index}/list?count=${pageSize}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const response = await fetchWithAuth(url, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      if (body.includes('corrupted')) {
        // The cursor has expired. Start again from the top: the pages merge,
        // and a listing that takes twice as long is better than a listing that
        // stops early and calls itself complete.
        restarts++;
        if (restarts > 5) throw new Error(`the cursor kept expiring: ${body.slice(0, 200)}`);
        cursor = undefined;
        continue;
      }
      throw new Error(`the index refused to list: ${response.status} ${body.slice(0, 200)}`);
    }
    const body = (await response.json()) as {
      result?: { vectors?: { id: string }[]; nextCursor?: string; totalCount?: number };
    };
    for (const vector of body.result?.vectors ?? []) ids.add(vector.id);
    total = body.result?.totalCount ?? total;
    cursor = body.result?.nextCursor;
  } while (cursor);
}

await list();
console.error(`  the index reports ${total.toLocaleString()} vector(s); the listing found ${ids.size.toLocaleString()}`);
if (process.argv[3]) {
  writeFileSync(process.argv[3], JSON.stringify([...ids]));
  console.error(`  wrote ${process.argv[3]}`);
} else {
  for (const id of ids) console.log(id);
}
