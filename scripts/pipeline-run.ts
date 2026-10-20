#!/usr/bin/env bun
/**
 * The ingestion pipeline's runner.
 *
 * One cycle of the continuous ingest:
 *
 *   1. pull the corpus repo
 *   2. work out which instruments changed since the revision the store is at
 *   3. parse them at the new revision
 *   4. reconcile, embed what changed, write it
 *
 * The corpus repo is a gigabyte with a hundred and thirty megabytes of history,
 * and it needs a filesystem and a git binary, so it lives on a volume rather
 * than in memory. The clone is shallow — the history is not needed, because the
 * store's own `corpus_state` says which revision it is at.
 *
 *   bun scripts/pipeline-run.ts --once        # one cycle, then exit
 *   bun scripts/pipeline-run.ts --watch       # loop, sleeping between cycles
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRows, parseStatuteXml, type ProvisionStatus } from '../src/ingest/statutes';
import { runPipeline, type PipelineRow } from '../src/ingest/pipeline';
import { PostgresCorpusStore } from '../services/corpus-db/store';

const CORPUS_REPO = 'https://github.com/justicecanada/laws-lois-xml.git';
const CORPUS_DIR = process.env.CORPUS_DIR ?? join(process.env.HOME ?? '.', '.cache', 'civicsignal', 'laws-lois-xml');
/**
 * The encoder is addressed by its domain rather than by a URL.
 *
 * Railway provides every service with its own `RAILWAY_PUBLIC_DOMAIN`, and the
 * encoder's is not known until the encoder exists — so the URL is composed here,
 * at run time, rather than being a guess written into the configuration.
 */
const ENCODER_DOMAIN = process.env.ENCODER_DOMAIN ?? '127.0.0.1';
const ENCODER_PORT = process.env.ENCODER_PORT ?? '8080';
const ENCODER_URL = ENCODER_DOMAIN.includes('://')
  ? ENCODER_DOMAIN
  : `http://${ENCODER_DOMAIN}:${ENCODER_PORT}`;
const ENCODER_TOKEN = process.env.ENCODER_TOKEN ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const CORPUS_ID = 'statutes-canada';
const WATCH_SECONDS = Number(process.env.PIPELINE_INTERVAL_SECONDS ?? 21_600);

const args = process.argv.slice(2);
const once = args.includes('--once') || !args.includes('--watch');

function git(...command: string[]): string {
  return execFileSync('git', ['-C', CORPUS_DIR, ...command], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function log(line: string): void {
  console.log(`${new Date().toISOString()}  ${line}`);
}

function ensureClone(): void {
  if (!existsSync(CORPUS_DIR)) {
    mkdirSync(join(CORPUS_DIR, '..'), { recursive: true });
    log(`cloning ${CORPUS_REPO} …`);
    execFileSync('git', ['clone', '--depth', '50', CORPUS_REPO, CORPUS_DIR], {
      stdio: 'inherit',
    });
    return;
  }
  log('pulling the corpus …');
  try {
    git('pull', '--ff-only');
  } catch (error) {
    log(`pull failed: ${(error as Error).message}`);
  }
}

/** The instruments that changed between two revisions. */
function changedFiles(from: string | null, to: string): string[] {
  const range = from ? `${from}..${to}` : to;
  let output: string;
  try {
    output = git('diff', '--name-only', range);
  } catch {
    output = '';
  }
  return output
    .split('\n')
    .filter((f) => f.endsWith('.xml'))
    .filter((f) => f.startsWith('eng/acts/') || f.startsWith('eng/regulations/'));
}

function commitDate(commit: string): string {
  try {
    return git('show', '-s', '--format=%ad', '--date=short', commit).trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Parse the changed instruments at the current revision. */
function parseChanged(files: string[]): PipelineRow[] {
  const rows: PipelineRow[] = [];
  for (const file of files) {
    const xml = git('show', `HEAD:${file}`);
    const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.xml$/, '');
    const kind = file.includes('/regulations/') ? 'regulations' : 'acts';
    const parsed = parseStatuteXml(xml, { citation: kind === 'regulations' ? stem : undefined });
    if (!parsed) continue;
    for (const row of buildRows(parsed, { kind, language: 'en' })) {
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
        lastChanged: commitDate('HEAD'),
      });
    }
  }
  return rows;
}

async function cycle(): Promise<void> {
  ensureClone();
  const head = git('rev-parse', 'HEAD').trim();

  if (!DATABASE_URL) {
    log('no DATABASE_URL — the pipeline cannot run');
    return;
  }
  const store = new PostgresCorpusStore(DATABASE_URL);
  try {
    const state = await store.currentCommit(CORPUS_ID);
    if (state && state.commit === head) {
      log(`already at ${head.slice(0, 9)} — nothing to do`);
      return;
    }

    const files = changedFiles(state?.commit ?? null, head);
    log(`${files.length} instrument file(s) changed since ${state?.commit?.slice(0, 9) ?? 'nothing'}`);

    const rows = parseChanged(files);
    log(`${rows.length} provision(s) parsed`);

    await runPipeline({
      corpusId: CORPUS_ID,
      previous: state ?? { commit: 'empty', date: '1970-01-01' },
      next: { commit: head, date: commitDate(head) },
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
