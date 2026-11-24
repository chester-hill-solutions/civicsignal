import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CommitteeCallDetailResponseSchema } from '../../src/corpora/committee-corpus';
import { ConsultationCoverageSchema, ConsultationLookupResponseSchema } from '../../src/corpora/consultations';
import { FundingCatalogueCoverage, FundingLookupResponse, FundingSource, FundingVersionsResponse } from '../../src/corpora/funding';
import { COMMITTEE_CORPUS_PATH, prepareCommitteeCorpus } from '../../src/routes/committee-corpus';
import { CONSULTATIONS_API_PATH, prepareConsultations } from '../../src/routes/consultations';
import { FUNDING_API_PATH, prepareFunding } from '../../src/routes/funding';
import type { Env } from '../../src/types';
import { localD1 } from './local-d1';

const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
  Database: new (path: string, options: { readonly: true; create: false; strict: true }) => DatabaseSync;
};
const language = z.enum(['en', 'fr']);
const instant = z.string().transform(value => new Date(value).toISOString());
const id = z.string().min(1);
const count = z.number().int().nonnegative();
const changes = z.object({ added: count, changed: count, removed: count });
const callKey = z.object({ id, language });
const consultationReceipt = z.object({
  observedAt: instant,
  revision: id,
  csv: z.object({ sha256: id }),
  schema: z.object({ sha256: id }),
  counts: changes.extend({ rows: count, stale: count }),
});
const callsReceipt = z.object({
  session: id,
  observedAt: instant,
  calls: z.array(callKey.extend({ title: id, citation: id })),
  droppedCalls: z.array(callKey.extend({ lastListedAt: instant })),
});
const fundingReceipt = z.object({
  source: FundingSource, observedAt: instant, revision: id, editions: count, gaps: count, events: changes,
});

type Prepare = (url: URL) => ((env: Env) => () => Promise<unknown>) | undefined;

function requireMatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasChanges(events: z.output<typeof changes>) {
  return events.added + events.changed + events.removed > 0;
}

async function withDatabase<T>(path: string, verify: (database: DatabaseSync) => Promise<T>) {
  const db = new Database(path, { readonly: true, create: false, strict: true });
  try {
    db.exec('BEGIN');
    return await verify(db);
  } finally {
    db.close();
  }
}

function route(prepare: Prepare, env: Env, path: string, query: Record<string, string>) {
  const url = new URL(path, 'http://localhost');
  url.search = new URLSearchParams(query).toString();
  const handler = prepare(url);
  requireMatch(handler, `No serving route for ${path}`);
  return handler(env)();
}

export function verifyConsultations(path: string, input: unknown) {
  const expected = consultationReceipt.parse(input);
  return withDatabase(path, async db => {
    const env = { CIVIC_DB: localD1(db, { existingReadTransaction: true }), CONSULTATIONS_PREVIEW: 'on' };
    const lookup = (suffix: string) => route(prepareConsultations, env,
      `${CONSULTATIONS_API_PATH}/${suffix}`, { asOf: expected.observedAt });
    const coverage = ConsultationCoverageSchema.parse(await lookup('coverage'));
    const catalogue = db.prepare('SELECT revision FROM consultations_catalogues WHERE source=?').get(coverage.source);
    requireMatch(coverage.observedAt === expected.observedAt && catalogue?.revision === expected.revision
      && coverage.csvSha256 === expected.csv.sha256 && coverage.schemaSha256 === expected.schema.sha256
      && coverage.counts.total === expected.counts.rows && coverage.counts.stale === expected.counts.stale,
    'Consultation coverage does not match the acquired observation, input hashes and record counts');

    const change = db.prepare(`SELECT id,event,revision FROM consultations_revisions
      WHERE observed_at=? ORDER BY event='removed',id LIMIT 1`).get(expected.observedAt);
    requireMatch(change || !hasChanges(expected.counts), 'Local consultation serving store is missing the acquired change');
    const sample = change ?? db.prepare(`SELECT id,revision FROM consultations_records
      WHERE removed_at IS NULL AND json_extract(facts_json,'$.editions.fr.title') <> '' ORDER BY id LIMIT 1`).get();
    requireMatch(typeof sample?.id === 'string', 'Consultation lookup has no sample record');
    const detail = ConsultationLookupResponseSchema.parse(await lookup(sample.id));
    requireMatch(detail.item?.revision === sample.revision
      && Boolean(detail.item?.editions.en.title) && Boolean(detail.item?.editions.fr.title),
    `Consultation ${sample.id} did not return both titles at the expected revision`);
    requireMatch(!change || detail.revisions.some(revision => revision.observedAt === expected.observedAt
      && revision.revision === change.revision && revision.event === change.event),
    `Consultation ${sample.id} did not return the acquired revision event`);
    return { database: path, observedAt: coverage.observedAt, revision: expected.revision,
      record: sample.id, event: change?.event ?? null, languages: ['en', 'fr'] };
  });
}

export function verifyCommitteeCalls(path: string, input: unknown) {
  const expected = callsReceipt.parse(input);
  return withDatabase(path, async db => {
    const env = { COMMITTEE_DB: localD1(db, { existingReadTransaction: true }), COMMITTEE_CORPUS_PREVIEW: 'on' };
    const editions = [...expected.calls.map(call => ({ ...call, listed: true, lastListedAt: expected.observedAt })),
      ...expected.droppedCalls.map(call => ({ ...call, listed: false, title: undefined, citation: undefined }))];
    for (const call of editions) {
      const path = `${COMMITTEE_CORPUS_PATH}/${expected.session}/calls/${call.id}`;
      const response = CommitteeCallDetailResponseSchema.parse(await route(prepareCommitteeCorpus, env,
        path, { language: call.language, asOf: expected.observedAt }));
      requireMatch(response.state === 'found' && response.item.language === call.language
        && response.item.listed === call.listed && response.item.lastListedAt === call.lastListedAt
        && (!call.listed || (response.item.title === call.title && response.item.url === call.citation)),
      `Committee call ${call.id}/${call.language} did not match the acquired listing observation`);
    }
    const listed = db.prepare(`SELECT count(*) AS total FROM cc_records WHERE session=? AND kind='call'
      AND coalesce(json_extract(metadata_json,'$.listed'),1) <> 0`).get(expected.session);
    requireMatch(listed?.total === expected.calls.length, 'Local committee serving store has a different listed call count');
    return { database: path, observedAt: expected.observedAt, listedEditions: expected.calls.length,
      droppedEditions: expected.droppedCalls.length };
  });
}

async function fundingEdition(db: DatabaseSync, env: Env, expected: z.output<typeof fundingReceipt>,
  editionLanguage: z.output<typeof language>) {
  const change = db.prepare(`SELECT id,event,revision FROM funding_versions WHERE source=? AND language=?
    AND observed_at=? ORDER BY event='removed',id LIMIT 1`).get(expected.source, editionLanguage, expected.observedAt);
  const sample = change ?? db.prepare('SELECT id,revision FROM funding_editions WHERE source=? AND language=? ORDER BY id LIMIT 1')
    .get(expected.source, editionLanguage);
  if (!sample || typeof sample.id !== 'string') return null;
  const path = `${FUNDING_API_PATH}/${sample.id}`;
  const query = { language: editionLanguage };
  const detail = FundingLookupResponse.parse(await route(prepareFunding, env, path, query));
  const matches = sample.event === 'removed'
    ? detail.item === null
    : detail.item?.id === sample.id && detail.item.language === editionLanguage && detail.item.revision === sample.revision;
  requireMatch(matches && detail.revision === expected.revision,
    `Funding lookup for ${sample.id}/${editionLanguage} did not match the acquired edition`);
  if (change) {
    const history = FundingVersionsResponse.parse(await route(prepareFunding, env, `${path}/versions`, query));
    requireMatch(history.items.some(item => item.observedAt === expected.observedAt
      && item.revision === change.revision && item.event === change.event),
    `Funding lookup for ${sample.id}/${editionLanguage} did not return the acquired revision event`);
  }
  return { id: sample.id, language: editionLanguage, event: change?.event ?? null };
}

async function fundingSource(db: DatabaseSync, env: Env, expected: z.output<typeof fundingReceipt>) {
  const coverage = FundingCatalogueCoverage.parse(await route(prepareFunding, env,
    `${FUNDING_API_PATH}/coverage`, { source: expected.source }));
  requireMatch(coverage.observedAt === expected.observedAt && coverage.revision === expected.revision
    && coverage.records === expected.editions && coverage.gaps.length === expected.gaps,
  `Funding coverage for ${expected.source} did not match the acquired observation`);
  const samples = await Promise.all(language.options.map(async editionLanguage => {
    const sample = await fundingEdition(db, env, expected, editionLanguage);
    requireMatch(sample || coverage.recordsPerLanguage[editionLanguage].total === 0,
      `Funding has no lookup sample for ${expected.source}/${editionLanguage}`);
    return sample;
  }));
  requireMatch(samples.some(sample => sample?.event) || !hasChanges(expected.events),
    `Local funding serving store is missing the acquired change for ${expected.source}`);
  return { source: expected.source, observedAt: coverage.observedAt, revision: coverage.revision, samples };
}

export function verifyFunding(path: string, input: unknown) {
  const expected = z.array(fundingReceipt).parse(input);
  requireMatch(expected.length === 2 && new Set(expected.map(receipt => receipt.source)).size === 2,
    'Expected one observation for each funding source');
  return withDatabase(path, async db => {
    const env = { CIVIC_DB: localD1(db, { existingReadTransaction: true }), FUNDING_PREVIEW: 'on' };
    const sources = await Promise.all(expected.map(receipt => fundingSource(db, env, receipt)));
    return { database: path, sources };
  });
}
