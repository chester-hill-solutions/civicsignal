#!/usr/bin/env bun
/**
 * Does the live index hold the document vectors the encoder produces?
 *
 * The search sends a **query** vector to the index, so a low score could be a
 * query fault or a document fault. The query side is cleared: the production
 * encoder agrees with the evaluation encoder at 0.998.
 *
 * This test clears the document side. It takes one provision, builds the
 * document text the corpus embeds — `embeddableText`, from `src/ingest/pipeline` —
 * embeds it on the document route, and asks the index for it. A provision must
 * find itself, and at a score near 1. A score far below 1 means the vectors in
 * the index are not the vectors this encoder produces for that text.
 *
 *     CIVICSIGNAL_KEY=… bun scripts/diagnose-documents.ts ["Criminal Code section 322", …]
 */
const API = 'https://api.civicsignal.chesterhillsolutions.ca';
const ENCODER = 'https://civicsignal-encoder.chester-hill-solutions.workers.dev';
import { readFileSync } from 'node:fs';

const apiKey = process.env.CIVICSIGNAL_KEY ?? '';
if (!apiKey) {
  console.error('set CIVICSIGNAL_KEY');
  process.exit(1);
}
const token = readFileSync(`${process.env.HOME ?? '.'}/.civicsignal/encoder-token`, 'utf8').trim();

const citations = process.argv.slice(2);
const targets =
  citations.length > 0 ? citations : ['Criminal Code section 322', 'Competition Act section 36'];

interface Item {
  id: string;
  title: string;
  body?: string;
  extra?: { act?: string; section?: string };
}

async function fetchProvision(topic: string): Promise<Item | undefined> {
  const url = `${API}/api/statutes?topic=${encodeURIComponent(topic)}&limit=1`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`statutes ${response.status}`);
  const body = (await response.json()) as { items?: Item[] };
  return body.items?.[0];
}

async function embedDocument(title: string, text: string): Promise<number[]> {
  const response = await fetch(`${ENCODER}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ texts: [text], titles: [title] }),
  });
  if (!response.ok) throw new Error(`embed ${response.status}: ${(await response.text()).slice(0, 120)}`);
  return ((await response.json()) as { vectors: number[][] }).vectors[0]!;
}

async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(`${ENCODER}/embed-query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!response.ok) throw new Error(`embed-query ${response.status}`);
  return ((await response.json()) as { vectors: number[][] }).vectors[0]!;
}

async function match(vector: number[], topK = 3): Promise<{ id: string; score: number }[]> {
  const response = await fetch(`${API}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ vector, topK, corpus: 'statutes-canada' }),
  });
  if (!response.ok) throw new Error(`match ${response.status}`);
  return ((await response.json()) as { matches?: { id: string; score: number }[] }).matches ?? [];
}

for (const citation of targets) {
  const item = await fetchProvision(citation);
  if (!item) {
    console.log(`${citation}: no provision`);
    continue;
  }
  const act = item.extra?.act ?? '';
  const heading = item.title.includes(' — ') ? item.title.split(' — ').slice(1).join(' — ') : '';
  const title = [act, heading].filter(Boolean).join(' — ').trim();
  const text = (item.body ?? '').trim();

  console.log(`\n${citation}`);
  console.log(`  row ${item.id}  title "${title}"  ${text.length} chars`);

  const documentVector = await embedDocument(title, text);
  const selfMatch = await match(documentVector);
  console.log(
    `  the document finds: ${selfMatch[0]!.score.toFixed(4)} ${selfMatch[0]!.id}` +
      `${selfMatch[0]!.id === item.id ? '   ✓ itself' : `   ✗ not itself (${item.id})`}`,
  );
  console.log(
    `    then            ${selfMatch[1]?.score.toFixed(4) ?? '—'} ${selfMatch[1]?.id ?? '—'}`,
  );

  const queryVector = await embedQuery(citation);
  const queryMatch = await match(queryVector);
  console.log(
    `  the citation finds: ${queryMatch[0]!.score.toFixed(4)} ${queryMatch[0]!.id}` +
      `${queryMatch[0]!.id === item.id ? '   ✓ itself' : `   ✗ not itself (${item.id})`}`,
  );
}
