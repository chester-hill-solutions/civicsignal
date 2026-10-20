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

/**
 * The embedding model's context window is 8,192 tokens. At roughly four characters
 * per token that is about 32,000 characters, and the corpus contains sections far
 * larger than that — the longest is 246,646 characters, some seven times the
 * window. Those sections are truncated for embedding, and the count is reported,
 * because a silently truncated provision is a section that will not be retrievable
 * by its tail.
 */
/**
 * The embedding window, in characters.
 *
 * It is a per-model limit, and the difference is not a detail.
 *
 * Workers AI's bge-mm has an 8,192-token window and counts tokens generously, so
 * 24,000 characters fit in one request. EmbeddingGemma 2 through LiteRT-LM has a
 * **1,024**-token compiled signature — the bundle advertises 8,192, but the
 * runtime's largest compiled signature is 1,024 — and a hosted API refuses an
 * input that is longer.
 *
 * The LiteRT-LM runtime can be told to **chunk** an over-long input and average
 * the chunk embeddings instead, which is why the encoder service drives the
 * runtime directly rather than through the OpenAI-compatible server: the server
 * does not expose that option. With it, a provision of any length is
 * represented, and the corpus stays one row per provision.
 *
 * So this limit is a safety net for the models that cannot chunk, not the
 * mechanism. The measurement that set it — the longest prefix of the densest
 * provision that fits in 1,024 tokens is 4,720 characters of text — is why the
 * number is not generous.
 */
const MAX_CHARS = 24000;

/**
 * The model's limit is on the whole request, not on each document: a batch that
 * totals more than 60,000 tokens is rejected outright, however many documents it
 * contains. Batches are therefore budgeted by tokens, not by count — a hundred
 * short sections fit easily, and ten long ones do not.
 */
const MAX_BATCH_TOKENS = 20000;

interface Args {
  endpoint: string;
  input: string;
  output: string;
  model: string;
  limit: number | undefined;
  /**
   * The most documents in one request. A hosted API is bounded by its token
   * budget; a local runtime is bounded by memory, and it holds the whole batch.
   */
  maxBatch: number;
  /** The embedding window, in characters. Model-dependent. */
  maxChars: number;
  /** A bearer token, when the encoder is behind one. */
  token: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    endpoint: 'http://127.0.0.1:8799/embed',
    input: 'dist/statutes.jsonl',
    output: '',
    model: '@cf/baai/bge-m3',
    limit: undefined,
    maxBatch: 250,
    maxChars: MAX_CHARS,
    token: process.env.ENCODER_TOKEN ?? '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--endpoint') args.endpoint = argv[++i] ?? args.endpoint;
    else if (arg === '--model') args.model = argv[++i] ?? args.model;
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--input') args.input = argv[++i] ?? args.input;
    else if (arg === '--output') args.output = argv[++i] ?? args.output;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--max-batch') args.maxBatch = Number(argv[++i]) || args.maxBatch;
    else if (arg === '--max-chars') args.maxChars = Number(argv[++i]) || args.maxChars;
    else if (arg === '--token') args.token = argv[++i] ?? args.token;
  }
  return args;
}

/**
 * The title of a provision, for a model that wants one.
 *
 * EmbeddingGemma 2's document instruction is `title: {title} | text: {content}`,
 * and a provision has exactly those two things: a heading and a body. The title
 * carries the instrument and the section as well as the heading, because that is
 * what disambiguates — two provisions called "Application" from two different Acts
 * are not the same provision, and a retrieval that cannot tell them apart returns
 * one when the caller asked for the other.
 */
export function documentTitle(section: {
  act: string;
  section: string;
  heading: string | null;
}): string {
  return [section.act, `s.${section.section}`, section.heading ?? '']
    .filter(Boolean)
    .join(' — ')
    .trim();
}

/**
 * Truncate to the embedding window, and report whether it happened.
 *
 * The title counts against the window, because the model's document instruction
 * puts them together: `title: {title} | text: {content}`. Truncating the content
 * to the full window would push the document past it.
 */
export function prepareText(
  section: { act: string; section: string; heading: string | null; text: string },
  maxChars = MAX_CHARS,
): { text: string; truncated: boolean; title: string } {
  const title = documentTitle(section);
  const room = Math.max(512, maxChars - title.length - 32);
  const full = section.text.trim();
  if (full.length <= room) return { text: full, truncated: false, title };
  return { text: full.slice(0, room), truncated: true, title };
}

interface Row {
  status?: string;
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) {
    const slug = args.model.replace(/^@cf\//, '').replace(/[^a-z0-9]+/gi, '-');
    args.output = `dist/statutes.${slug}.emb`;
  }
  if (!existsSync(args.input)) {
    console.error(`missing ${args.input} — run the statute ingest first`);
    process.exit(1);
  }

  const rows: Row[] = [];
  let placeholders = 0;
  for (const line of readFileSync(args.input, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    // A placeholder is a gap in the consolidation: "[Amendment]" means the
    // provision exists but its text lives in an amending instrument. There are
    // nearly eleven thousand of them and every one has the same text, so embedding
    // them puts eleven thousand identical vectors into the index and crowds
    // everything else out. They stay in the store — a citation still resolves —
    // and they stay out of the index.
    if (row.status === 'placeholder') {
      placeholders++;
      continue;
    }
    rows.push(row);
    if (args.limit && rows.length >= args.limit) break;
  }
  console.log(`embedding ${rows.length} section(s) with ${args.model} via ${args.endpoint}`);
  if (placeholders > 0) {
    console.log(`  ${placeholders.toLocaleString()} placeholder section(s) excluded from the index`);
  }

  // The manifest that ties a vector back to its row. Without it, the index and
  // the corpus would have to be in the same order by accident, and the first row
  // that moved would silently point every match at the wrong provision.
  const manifestPath = args.output.replace(/\.emb$/, '') + '.rows.json';
  writeFileSync(manifestPath, JSON.stringify(rows.map((r) => r.id)));
  console.log(`  wrote ${manifestPath}`);

  const prepared = rows.map((row) => prepareText(row, args.maxChars));
  const texts = prepared.map((p) => p.text);
  const truncated = prepared.filter((p) => p.truncated).length;
  if (truncated > 0) {
    console.log(
      `  ${truncated} section(s) exceed the ${args.maxChars}-character window and are truncated ` +
        `(${((truncated / prepared.length) * 100).toFixed(1)}%)`,
    );
  }
  const vectors: number[][] = [];
  const started = Date.now();

  let failed = 0;

  // Group the documents into batches that fit the token budget.
  const batches: { start: number; end: number }[] = [];
  let start = 0;
  let tokens = 0;
  for (let i = 0; i < texts.length; i++) {
    // Workers AI counts roughly twice what a four-characters-per-token estimate
    // gives on this corpus — a 45,000-token budget was reported as 92,820 tokens —
    // so the estimate is deliberately pessimistic and the budget carries margin.
    const estimate = Math.ceil(texts[i]!.length / 2.5);
    if ((tokens + estimate > MAX_BATCH_TOKENS || i - start >= args.maxBatch) && i > start) {
      batches.push({ start, end: i });
      start = i;
      tokens = 0;
    }
    tokens += estimate;
  }
  if (start < texts.length) batches.push({ start, end: texts.length });
  console.log(`  ${batches.length} batch(es) within a ${MAX_BATCH_TOKENS}-token budget`);

  const post = async (chunk: { text: string; title: string }[]): Promise<number[][]> => {
    const response = await fetch(args.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
      },
      body: JSON.stringify({
        texts: chunk.map((c) => c.text),
        titles: chunk.map((c) => c.title),
        model: args.model,
      }),
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
  const postRobust = async (chunk: { text: string; title: string }[], label: string): Promise<number[][]> => {
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

  for (const [index, batch] of batches.entries()) {
    const chunk = prepared.slice(batch.start, batch.end);
    const result = await postRobust(chunk, `rows ${batch.start}-${batch.end - 1}`);
    vectors.push(...result);

    if (index % 50 === 0) {
      const done = batch.end;
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
