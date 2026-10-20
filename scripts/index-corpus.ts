/**
 * Index the corpus: embed every provision and write the vectors.
 *
 * The index holds **no text**. Only the vector and a little metadata — the
 * language, the jurisdiction. The canonical row, its text and its licence
 * policy live in the database, and an item is fetched from there and passed
 * through the licence gate before it is returned. An index that held the text
 * would be a second copy of the corpus that bypassed the gate.
 *
 * The model and the index have to agree. A vector from a different model is a
 * vector into a different space, and the nearest neighbour in the wrong space
 * is not near anything. So the dimension here is the dimension of the index,
 * and both are read from one place.
 *
 *     bun scripts/index-corpus.ts                  # both languages
 *     bun scripts/index-corpus.ts --lang fr
 *     bun scripts/index-corpus.ts --limit 1000     # a sample
 *     bun scripts/index-corpus.ts --dry-run
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchWithAuth } from './lib/cloudflare-auth';

const ROOT = new URL('..', import.meta.url).pathname;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const INDEX_NAME = process.env.VECTORIZE_INDEX ?? 'civicsignal-statutes';
const MODEL = process.env.EMBEDDING_MODEL ?? '@cf/baai/bge-m3';

/**
 * A local encoder, when the corpus is embedded with the model that ships.
 *
 * EmbeddingGemma 2 is served from the `.litertlm` artefact — the same file the
 * browser runs — and the service applies the model's own document instruction
 * to the title and the text. So the call is the same shape as the hosted one,
 * and only the address and the token change.
 */
const ENDPOINT = process.env.EMBEDDER_URL ?? '';
const TOKEN = process.env.ENCODER_TOKEN ?? '';

/**
 * The character window.
 *
 * bge-m3 takes 8,192 tokens. The corpus's longest provision is 303,526
 * characters, which is roughly 75,000 tokens, so the tail of the longest
 * provisions has to go somewhere. It is truncated here, and the truncation is
 * counted and reported rather than hidden: a corpus that quietly drops the end
 * of a provision is a corpus that answers questions about the first half of
 * the law and calls it the law.
 *
 * The LiteRT-LM runtime does not have this problem — it chunks an over-long
 * input and averages the embeddings — which is one of the things the model
 * comparison is about.
 */
const MAX_CHARS = 24_000;

/**
 * The token budget for one embedding call.
 *
 * Workers AI caps the **whole request**, not the model: 60,000 tokens across
 * every text in the call, and a batch of a hundred ordinary provisions comes to
 * 271,000 — which is refused, not truncated. So the batch is sized by tokens
 * rather than by rows.
 *
 * **The characters-to-token ratio is 1.5 for this corpus, and four is far too
 * generous.** That was measured rather than assumed: one provision of 224
 * characters reports 59 tokens, five of 1,025 characters report 540, and
 * twenty of 10,405 report 6,980. The ratio falls as the batch grows because
 * there is a per-text overhead, so the estimate has to be conservative for the
 * batch size that is actually used.
 */
const CHARS_PER_TOKEN = 1.3;
const TOKEN_BUDGET = 45_000;

/** How many embedding calls run at once. */
const CONCURRENCY = 4;

/** How many vectors go in one upsert. */
const UPSERT_BATCH = 500;

interface Args {
  lang: 'en' | 'fr' | 'both';
  limit: number | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { lang: 'both', limit: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang') {
      const value = argv[++i];
      if (value !== 'en' && value !== 'fr' && value !== 'both') {
        throw new Error(`--lang must be one of en, fr, both (got "${value ?? ''}")`);
      }
      args.lang = value;
    } else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

interface Row {
  id: string;
  act: string;
  section: string;
  heading: string | null;
  text: string;
  status: string;
  jurisdiction: string;
  language: string;
}

/**
 * The text a provision is embedded as.
 *
 * The instrument's name and the section label go in, because the title is what
 * disambiguates: two provisions called "Application" from two different Acts
 * are not the same provision.
 */
function documentText(row: Row): string {
  const title = `${row.act} s. ${row.section}${row.heading ? ` — ${row.heading}` : ''}`;
  return `${title}\n${row.text}`.slice(0, MAX_CHARS);
}

/**
 * The batches.
 *
 * **The budget is the count times the longest text in the batch, not the sum of
 * the texts.** Workers AI's bge-m3 pads every input in a batch to the longest
 * one, and the context check is against that padded total. It was measured
 * rather than guessed: a batch of 63 texts and one of 12,860 characters was
 * refused at "170,919 tokens", which is exactly 63 × 2,713 — the 12,860
 * characters tokenised on their own. A batch of 20 short texts and the same
 * long one was billed 56,973 tokens, again exactly 21 × 2,713.
 *
 * So the only way to spend the budget is to **group texts of similar length**,
 * which is what the sort below is for. Without it, one long provision drags
 * every other text in its batch up to its own length, and the batch holds nine
 * provisions instead of two hundred.
 *
 * The order of the rows does not matter to the index — every vector carries
 * its row's id — so sorting them by length is free.
 */
function batches(rows: Row[]): Row[][] {
  const sorted = [...rows].sort((a, b) => documentText(a).length - documentText(b).length);
  const out: Row[][] = [];
  let batch: Row[] = [];
  let longest = 0;

  for (const row of sorted) {
    const length = documentText(row).length;
    const tokens = Math.ceil(length / CHARS_PER_TOKEN);
    // The padded cost: every text in the batch counts as the longest one.
    if (batch.length > 0 && (batch.length + 1) * Math.max(longest, tokens) > TOKEN_BUDGET) {
      out.push(batch);
      batch = [];
      longest = 0;
    }
    batch.push(row);
    longest = Math.max(longest, tokens);
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/**
 * Fetch, with a retry.
 *
 * The socket is closed by the far end under load — a closed connection is a
 * transient failure, not a refusal, and the difference matters: a refusal is
 * permanent and the batch is wrong, while a closed socket is a hiccup and the
 * same request will work a moment later.
 */
async function fetchWithRetry(url: string, init: RequestInit, what: string): Promise<Response> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === 5) throw new Error(`${what} failed: ${String(error).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`${what} failed after six attempts`);
}

async function embed(texts: string[], titles: string[]): Promise<number[][]> {
  const response = ENDPOINT
    ? await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
          },
          body: JSON.stringify({ texts, titles }),
        },
        'the embedding call',
      )
    : await fetchWithAuth(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: texts }),
        },
      );
  if (!response.ok) {
    throw new Error(`the embedding model refused: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { result?: { data?: number[][] }; vectors?: number[][] };
  // The hosted API wraps the vectors in `result`; the local service returns
  // them directly.
  const vectors = body.result?.data ?? body.vectors;
  if (!vectors || vectors.length !== texts.length) {
    throw new Error(`the embedding model returned ${vectors?.length ?? 0} of ${texts.length} vectors`);
  }
  return vectors;
}

async function upsert(vectors: { id: string; values: number[]; metadata: Record<string, string> }[]): Promise<void> {
  const response = await fetchWithAuth(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors }),
    },
  );
  if (!response.ok) {
    throw new Error(`the index refused: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const langs = args.lang === 'both' ? (['en', 'fr'] as const) : ([args.lang] as const);

  for (const lang of langs) {
    const file = join(ROOT, 'dist', lang === 'fr' ? 'statutes-fr.jsonl' : 'statutes.jsonl');
    const all = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row);

    // A placeholder is not a provision. It is an editorial marker — the text
    // lives in an amending instrument — and eleven thousand identical vectors
    // in the index crowd out everything else.
    const rows = all.filter((r) => r.status !== 'placeholder');
    const truncated = rows.filter((r) => r.text.length > MAX_CHARS).length;
    const selected = args.limit ? rows.slice(0, args.limit) : rows;

    console.log(
      `index-corpus: ${selected.length.toLocaleString()} ${lang} row(s) to embed` +
        (truncated ? `, ${truncated.toLocaleString()} truncated at ${MAX_CHARS.toLocaleString()} characters` : ''),
    );
    if (args.dryRun) continue;

    const started = Date.now();
    let done = 0;
    let tokens = 0;

    const allBatches = batches(selected);
    console.log(`  ${allBatches.length.toLocaleString()} batch(es)`);
    let next = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const batch = allBatches[index];
        if (!batch) return;
        // The hosted model is given the bare text; the local service is given the
    // text and the title separately, because the model's own document
    // instruction puts them together.
    const texts = ENDPOINT
      ? batch.map((r) => String(r.text).slice(0, MAX_CHARS))
      : batch.map(documentText);
        const cost = texts.reduce((sum, t) => sum + Math.ceil(t.length / CHARS_PER_TOKEN), 0);
        try {
          const vectors = await embed(
            texts,
            batch.map((r) => `${r.act} s.${r.section}${r.heading ? ` — ${r.heading}` : ''}`),
          );
          for (let start = 0; start < vectors.length; start += UPSERT_BATCH) {
            const slice = vectors.slice(start, start + UPSERT_BATCH);
            await upsert(
              slice.map((values, k) => {
                const row = batch[start + k]!;
                return {
                  id: row.id,
                  values,
                  metadata: { language: row.language, jurisdiction: row.jurisdiction },
                };
              }),
            );
          }
          tokens += cost;
        } catch (error) {
          failed++;
          console.error(`  ${String(error).slice(0, 160)}`);
        }
        done += batch.length;
        // The boundary is crossed, not hit: a batch can be nine thousand rows
        // long, so `done % 5_000` would never be zero and the progress would
        // never print.
        if (Math.floor(done / 5_000) > Math.floor((done - batch.length) / 5_000) || done === selected.length) {
          const rate = done / ((Date.now() - started) / 1000);
          const left = Math.round((selected.length - done) / rate);
          console.log(
            `  ${done.toLocaleString()} / ${selected.length.toLocaleString()} ` +
              `(${rate.toFixed(0)}/s, about ${Math.round(left / 60)} min left)`,
          );
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failed) throw new Error(`${failed} batch(es) failed to index`);

    const cost = (tokens / 1_000_000) * 0.012;
    console.log(
      `index-corpus: ${lang} indexed — about ${(tokens / 1_000_000).toFixed(1)}M tokens, $${cost.toFixed(2)}`,
    );
  }
}

await main();
