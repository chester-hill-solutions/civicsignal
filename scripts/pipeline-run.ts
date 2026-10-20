#!/usr/bin/env bun
/**
 * The ingestion pipeline's runner.
 *
 * One cycle of the continuous ingest:
 *
 *   1. ask the corpus repository what revision it is at
 *   2. if that is the revision the store is already at, stop
 *   3. stream the instruments at that revision and parse each one
 *   4. reconcile against the store, embed what changed, write it
 *
 * There is no clone, no volume and no git binary. The corpus is a public git
 * repository and the pipeline needs two things from it — the current revision and
 * the content of the instruments at that revision — and both come over HTTPS.
 * The only state is the commit SHA, which is already in `corpus_state`.
 *
 * The whole tree is parsed on every run rather than only the changed files,
 * because the reconciliation is by provision: the store holds a fingerprint for
 * every provision, and a provision whose fingerprint is unchanged is unchanged.
 * Parsing 5,868 instruments takes about eighty seconds; a commit that changes
 * fifty-six of them costs six seconds of embedding and nothing else.
 *
 *   bun scripts/pipeline-run.ts --once        # one cycle, then exit
 *   bun scripts/pipeline-run.ts --watch       # loop, sleeping between cycles
 */
import { buildRows, parseStatuteXml, type ProvisionStatus } from '../src/ingest/statutes';
import { runPipeline, type PipelineRow } from '../src/ingest/pipeline';
import { GitHubCorpusSource, type CorpusSource } from '../src/ingest/source';
import { PostgresCorpusStore } from '../services/corpus-db/store';

const ENCODER_DOMAIN = process.env.ENCODER_DOMAIN ?? '127.0.0.1';
const ENCODER_PORT = process.env.ENCODER_PORT ?? '8080';
const ENCODER_URL = ENCODER_DOMAIN.includes('://')
  ? ENCODER_DOMAIN
  : `http://${ENCODER_DOMAIN}:${ENCODER_PORT}`;
const ENCODER_TOKEN = process.env.ENCODER_TOKEN ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const CORPUS_ID = 'statutes-canada';
const WATCH_SECONDS = Number(process.env.PIPELINE_INTERVAL_SECONDS ?? 21_600);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

const args = process.argv.slice(2);
const once = args.includes('--once') || !args.includes('--watch');

function log(line: string): void {
  console.log(`${new Date().toISOString()}  ${line}`);
}

/** The kind and language of an instrument, from where it sits in the corpus. */
function classify(path: string): { kind: 'acts' | 'regulations'; language: 'en' | 'fr' } {
  if (path.startsWith('fra/lois/')) return { kind: 'acts', language: 'fr' };
  if (path.startsWith('fra/reglements/')) return { kind: 'regulations', language: 'fr' };
  if (path.startsWith('eng/regulations/')) return { kind: 'regulations', language: 'en' };
  return { kind: 'acts', language: 'en' };
}

/** Parse the instruments at a revision into the rows the store holds. */
async function parseInstruments(
  source: CorpusSource,
  revision: string,
  date: string,
): Promise<PipelineRow[]> {
  const rows: PipelineRow[] = [];
  let files = 0;
  for await (const file of source.instruments(revision)) {
    files++;
    const { kind, language } = classify(file.path);
    // A regulation's citation is its file stem; a statute's is in the document.
    const stem = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.xml$/, '');
    const parsed = parseStatuteXml(file.content, {
      citation: kind === 'regulations' ? stem : undefined,
    });
    if (!parsed) continue;
    for (const row of buildRows(parsed, { kind, language })) {
      rows.push({
        id: row.id,
        corpusId: CORPUS_ID,
        instrument: row.act,
        citation: row.citation,
        section: row.section,
        schedule: row.schedule,
        part: row.part,
        status: row.status as ProvisionStatus,
        heading: row.heading,
        text: row.text,
        source_url: row.source_url,
        in_force: row.in_force,
        language: row.language,
        embedText: '',
        lastChanged: date,
      });
    }
  }
  log(`  ${files} instrument file(s) parsed into ${rows.length} provision(s)`);
  return rows;
}

async function cycle(): Promise<void> {
  if (!DATABASE_URL) {
    log('no DATABASE_URL — the pipeline cannot run');
    return;
  }
  const source = new GitHubCorpusSource({ token: GITHUB_TOKEN || undefined });
  const store = new PostgresCorpusStore(DATABASE_URL);

  try {
    const head = await source.head();
    const state = await store.currentCommit(CORPUS_ID);
    if (state && state.commit === head.commit) {
      log(`already at ${head.commit.slice(0, 9)} (${head.date}) — nothing to do`);
      return;
    }
    log(`the corpus is at ${head.commit.slice(0, 9)} (${head.date})`);

    const rows = await parseInstruments(source, head.commit, head.date);

    await runPipeline({
      corpusId: CORPUS_ID,
      previous: state ?? { commit: 'empty', date: '1970-01-01' },
      next: { commit: head.commit, date: head.date },
      rows,
      store,
      encoder: {
        async embed(documents: string[]) {
          const response = await fetch(`${ENCODER_URL.replace(/\/$/, '')}/v1/embeddings`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(ENCODER_TOKEN ? { authorization: `Bearer ${ENCODER_TOKEN}` } : {}),
            },
            body: JSON.stringify({ model: 'embeddinggemma-2-270m', input: documents }),
          });
          if (!response.ok) throw new Error(`the encoder returned ${response.status}`);
          const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
          const ordered = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
          return ordered.map((item) => item.embedding);
        },
      },
      now: new Date(),
      logger: log,
    });
  } finally {
    await store.close();
  }
}

if (once) {
  await cycle();
} else {
  for (;;) {
    try {
      await cycle();
    } catch (error) {
      log(`the cycle failed: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_SECONDS));
  }
}
