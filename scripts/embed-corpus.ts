#!/usr/bin/env bun
/**
 * Embed the statute corpus.
 *
 * Reads `dist/statutes.jsonl` (the ingest output), embeds every section, and writes
 * a compact binary vector file next to it. The vectors are written as float32 in a
 * single flat array with a small header, because 191,025 sections at 1,024 dimensions
 * is 783 MB and JSON would be three times that.
 *
 * The embedding endpoint is a local `wrangler dev` Worker (tools/embed-worker),
 * because the Workers AI binding in local dev authenticates with the operator's
 * Cloudflare session. That is a development convenience only — production would
 * call Workers AI directly from the product Worker, or a self-hosted
 * EmbeddingGemma service.
 *
 *   bun run embed:statutes
 *   bun run embed:statutes -- --endpoint http://127.0.0.1:8799/embed
 *   bun run embed:statutes -- --limit 1000 --model bge-m3
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BATCH = 100;
/**
 * The embedding model's context window is 8,192 tokens. At roughly four characters
 * per token that is about 32,000 characters, and the corpus contains sections far
 * larger than that — the longest is 246,646 characters, some seven times the
 * window. Those sections are truncated for embedding, and the count is reported,
 * because a silently truncated provision is a section that will not be retrievable
 * by its tail.
 */
const MAX_CHARS = 24000;

interface Args {
  endpoint: string;
  input: string;
  output: string;
  limit: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    endpoint: 'http://127.0.0.1:8799/embed',
    input: 'dist/statutes.jsonl',
    output: 'dist/statutes.emb',
    limit: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--endpoint') args.endpoint = argv[++i] ?? args.endpoint;
    else if (arg === '--input') args.input = argv[++i] ?? args.input;
    else if (arg === '--output') args.output = argv[++i] ?? args.output;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

/** The text that represents a section for retrieval: its heading, then its text. */
export function documentText(section: {
  act: string;
  heading: string | null;
  text: string;
}): string {
  return [section.act, section.heading ?? '', section.text].filter(Boolean).join('\n').trim();
}

/** Truncate to the embedding window, and report whether it happened. */
export function prepareText(
  section: { act: string; heading: string | null; text: string },
): { text: string; truncated: boolean } {
  const full = documentText(section);
  if (full.length <= MAX_CHARS) return { text: full, truncated: false };
  return { text: full.slice(0, MAX_CHARS), truncated: true };
}

interface Row {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.input)) {
    console.error(`missing ${args.input} — run the statute ingest first`);
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const line of readFileSync(args.input, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    rows.push(row);
    if (args.limit && rows.length >= args.limit) break;
  }
  console.log(`embedding ${rows.length} section(s) via ${args.endpoint}`);

  const prepared = rows.map(prepareText);
  const texts = prepared.map((p) => p.text);
  const truncated = prepared.filter((p) => p.truncated).length;
  if (truncated > 0) {
    console.log(`  ${truncated} section(s) exceed the ${MAX_CHARS}-character window and are truncated`);
  }
  const vectors: number[][] = [];
  const started = Date.now();

  let failed = 0;

  const post = async (chunk: string[]): Promise<number[][]> => {
    const response = await fetch(args.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: chunk }),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { vectors: number[][] };
    if (body.vectors.length !== chunk.length) {
      throw new Error(`returned ${body.vectors.length} vectors for ${chunk.length} texts`);
    }
    return body.vectors;
  };

  // A batch that the model rejects is split, so one oversized document cannot take
  // the whole job down. A single document that still fails is reported and skipped.
  const postRobust = async (chunk: string[], label: string): Promise<number[][]> => {
    try {
      return await post(chunk);
    } catch (error) {
      if (chunk.length === 1) {
        failed++;
        console.error(`  skipped one document (${label}): ${(error as Error).message.slice(0, 120)}`);
        return [];
      }
      const half = Math.floor(chunk.length / 2);
      const left = await postRobust(chunk.slice(0, half), label);
      const right = await postRobust(chunk.slice(half), label);
      return [...left, ...right];
    }
  };

  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const result = await postRobust(chunk, `rows ${i}-${i + chunk.length - 1}`);
    vectors.push(...result);

    if ((i / BATCH) % 50 === 0) {
      const done = Math.min(i + BATCH, texts.length);
      const rate = done / ((Date.now() - started) / 1000);
      const eta = Math.round((texts.length - done) / rate);
      console.log(`  ${done}/${texts.length}  ${rate.toFixed(0)}/s  eta ${eta}s`);
    }
  }

  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) throw new Error('no vectors returned');
  if (failed > 0) console.log(`  ${failed} document(s) could not be embedded and are absent from the store`);

  // Header: magic, count, dims. Then the flat float32 payload.
  const header = new ArrayBuffer(16);
  const view = new DataView(header);
  view.setUint32(0, 0x43535356, true); // "CVSV"
  view.setUint32(4, vectors.length, true);
  view.setUint32(8, dims, true);
  view.setUint32(12, 0, true);

  const payload = new Float32Array(vectors.length * dims);
  let offset = 0;
  for (const vector of vectors) {
    for (const value of vector) payload[offset++] = value;
  }

  const out = Buffer.concat([Buffer.from(header), Buffer.from(payload.buffer)]);
  writeFileSync(args.output, out);
  const mb = statSync(args.output).size / 1024 / 1024;
  console.log(`wrote ${args.output} — ${vectors.length} vectors x ${dims} dims, ${mb.toFixed(1)} MB`);
}

await main();
