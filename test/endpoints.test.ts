import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { CommitteeCallDetailResponseSchema, CommitteeCallsResponseSchema, CommitteeCorpusPageSchema, CommitteeCorpusSearchResponseSchema, CommitteeCorpusCoverageSchema } from '../src/corpora/committee-corpus';
import { FundingSearchResponse, FundingLookupResponse } from '../src/corpora/funding';
import { localD1 } from '../scripts/lib/local-d1';
import { ApiKeyUsageDO, DurableObjectUsageLedger } from '@chester-hill-solutions/api-billing/durable-object';
import worker from '../src/index';
import type { Capabilities } from '../src/routes/capabilities';
import type { Env } from '../src/types';
import { testD1 } from './helpers/d1';
import { prepareWorkspaceKey } from '../src/key-operations';
import { COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS, INSERT_COMPACT_STATUTE_SQL, applyCompactRestorePage, compactPageDigest } from '../src/corpora/compact-restore';
import { prepareProvisionText, rowFingerprintWithText, textReferenceBindings, UPSERT_TEXT_REFERENCE_SQL, writeImmutableProvisionText } from '../src/corpora/text-store';
import { memoryTextBucket } from './helpers/text-bucket';
import { hansardSpeechId, hansardPolicy, type HansardChamber, type HansardLanguage } from '../src/corpora/hansard';
import { HANSARD_OPENAPI_PATH, HANSARD_PATHS, HansardErrorSchema, HansardLookupResponseSchema, HansardSearchResponseSchema } from '../src/routes/hansard-contract';
import { hansardOpenApi } from '../src/routes/hansard-openapi';
import { GAZETTE_OPENAPI_PATH, GazetteLookupResponseSchema, GazetteSearchResponseSchema } from '../src/routes/gazette-contract';
import { WrittenQuestionLookupResponseSchema, WrittenQuestionSearchResponseSchema,
  WrittenQuestionCoverageResponseSchema, WrittenQuestionChunksResponseSchema } from '../src/routes/written-questions-contract';
import { gazetteOpenApi } from '../src/routes/gazette-openapi';
import { BillBriefSchema } from '../src/corpora/bill-trace';
import { replayBillTrace } from '../scripts/lib/bill-trace-store';
import { BILL_BRIEF_PATH, BILL_OPENAPI_PATH } from '../src/routes/bill-trace';
import { billTraceOpenApi } from '../src/routes/bill-trace-openapi';
import { COMMITTEE_STUDY_BRIEF_PATH } from '../src/routes/committee-study';
import { SourceFeedResponseSchema } from '../src/routes/source-feed-contract';
import { normalizeForSearch } from '../src/text';

const closed: (() => void)[] = [];
type RequestOptions = { method?: string; body?: string; headers?: Record<string, string> };
interface UsageStorage {
  get(name: string): Promise<unknown>;
  put(name: string | Record<string, unknown>, value?: unknown): Promise<void>;
  list(options: { start?: string; end?: string; prefix?: string; limit?: number }): Promise<Map<string, unknown>>;
  delete(names: string | string[]): Promise<void>;
  transaction<T>(work: (transaction: UsageStorage) => Promise<T>): Promise<T>;
}
const generationProviders=['anthropic','openai','google','opencode-zen'] as const;
const generationEndpoints={anthropic:'https://api.anthropic.com/v1/messages',openai:'https://api.openai.com/v1/chat/completions',google:'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent','opencode-zen':'https://opencode.ai/inference/anthropic/v1/messages'};
function providerText(provider:typeof generationProviders[number],text:string){
  return provider==='openai'?{choices:[{message:{content:text}}]}:provider==='google'?{candidates:[{content:{parts:[{text}]}}]}:{content:[{type:'text',text}]};
}
beforeEach(() => vi.restoreAllMocks());
afterEach(() => { for (const close of closed.splice(0)) close(); vi.restoreAllMocks(); });

async function setup(limit = 5) {
  const fixture = testD1();
  closed.push(fixture.close);
  fixture.sqlite.exec("INSERT INTO workspace(id) VALUES('customer_kept')");
  fixture.sqlite.prepare(`INSERT INTO civic_workspace_billing(workspace_id,plan,fuse_limit,fuse_soft_warn,enabled)
    VALUES('customer_kept','free',?,0,1)`).run(limit);
  const key = prepareWorkspaceKey('customer_kept', 'Endpoint test');
  fixture.sqlite.exec(key.sql);
  const counts = new Map<string, unknown>();
  let currentTransaction = Promise.resolve();
  const storage: UsageStorage = { async get(name: string) { return counts.get(name); },
    async put(name: string | Record<string, unknown>, value?: unknown) {
      if (typeof name === 'string') counts.set(name, value);
      else for (const [key, item] of Object.entries(name)) counts.set(key, item);
    },
    async list({ start, end, prefix, limit }) {
      const keys = [...counts.keys()].sort().filter((key) =>
        (start === undefined || key >= start) && (end === undefined || key < end) &&
        (prefix === undefined || key.startsWith(prefix)));
      return new Map(keys.slice(0, limit ?? keys.length).map((key) => [key, counts.get(key)]));
    },
    async delete(names) { for (const name of Array.isArray(names) ? names : [names]) counts.delete(name); },
    async transaction<T>(work: (transaction: UsageStorage) => Promise<T>): Promise<T> {
      const current = currentTransaction;
      let release!: () => void;
      currentTransaction = new Promise<void>((resolve) => { release = resolve; });
      await current;
      const previous = new Map(counts);
      try { return await work(storage); }
      catch (error) { counts.clear(); for (const entry of previous) counts.set(...entry); throw error; }
      finally { release(); }
    } };
  // Exercise the actual shared Durable Object and its HTTP client. Cloudflare
  // supplies lifecycle and input gates; the fixture supplies persistent storage.
  const object = new ApiKeyUsageDO({ storage } as unknown as ConstructorParameters<typeof ApiKeyUsageDO>[0]);
  const names: string[] = [];
  const transport = { unavailable: false, loseNextPost: false, partitionAfterCommit: false };
  const namespace = {
    idFromName(name: string) { names.push(name); return name; },
    get() { return { async fetch(input: string, init?: RequestOptions) {
      if (transport.unavailable) throw new Error('fixture ledger unavailable');
      const response = await object.fetch(new Request(input, init));
      if (init?.method === 'POST' && transport.loseNextPost) {
        transport.loseNextPost = false;
        if (transport.partitionAfterCommit) transport.unavailable = true;
        throw new Error('fixture acknowledgement lost after commit');
      }
      return response;
    } }; },
  };
  const env: Env = { CIVIC_DB: fixture.db, API_KEY_USAGE: namespace as unknown as DurableObjectNamespace };
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { tasks.push(task); }, passThroughOnException() {}, props: {} } as ExecutionContext;
  const send = async (path: string, init: RequestOptions = {}, authenticated = true) => {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set('Authorization', `Bearer ${key.rawKey}`);
    const response = await worker.fetch(new Request('https://example.test' + path, { ...init, headers }), env, ctx);
    await Promise.all(tasks.splice(0));
    return response;
  };
  const count = async () => (await new DurableObjectUsageLedger(env.API_KEY_USAGE!).peekMonthly('customer_kept', limit)).count;
  const rpc = (method: string, params?: unknown) => send('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  fixture.sqlite.exec(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at)
    VALUES('statutes-canada','test-revision','2026-10-22','2026-10-22',1,'2026-10-22T00:00:00Z')`);
  fixture.sqlite.exec(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language)
    VALUES('acts-en-one','statutes-canada','Test Act','T-1','1','in-force','A verified test provision.',
      'https://example.test/act/1','CA',1,'en')`);
  return { ...fixture, env, key, names, send, rpc, count, transport };
}

async function manifest(fixture: Awaited<ReturnType<typeof setup>>): Promise<Capabilities> {
  const response = await fixture.send('/.well-known/civicsignal.json', {}, false);
  expect(response.status).toBe(200);
  return response.json();
}

async function publishedEditions(fixture: Awaited<ReturnType<typeof setup>>, id: string) {
  const source = (await manifest(fixture)).sources.find(item => item.id === id);
  expect(source?.status, id).toBe('available');
  return source?.editions ?? [];
}

function seedHansard(fixture: Awaited<ReturnType<typeof setup>>, chamber: HansardChamber, language: HansardLanguage,
  date = '2026-04-23') {
  const sittingId = chamber === 'house' ? '45-1-109' : '45-1-67';
  const intervention = (date === '2026-04-23' ? '8' : '9') + '-1';
  const id = hansardSpeechId(language, sittingId, intervention, chamber);
  const sourceUrl = chamber === 'house' ? `https://www.ourcommons.ca/${language}/debates#Int-${intervention}`
    : `https://sencanada.ca/${language}/debates#${intervention.split('-')[0]}`;
  const excerpt = language === 'fr' ? 'Le réseau ferroviaire est à l’étude.' : 'The railway network is under review.';
  fixture.sqlite.prepare(`INSERT INTO hansard_speeches
    (id, corpus_id, speaker, sitting_date, excerpt, source_url, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, hansardPolicy(chamber).id, 'Synthetic speaker', date, excerpt, sourceUrl, normalizeForSearch(excerpt));
  return { id, sourceUrl, excerpt };
}

describe('Polytechnics Canada funding recommendations against the acquired catalogues', () => {
  const fundingPath = process.env.CIVICSIGNAL_FUNDING_SQLITE;
  const committeePath = process.env.CIVICSIGNAL_COMMITTEES_D1;

  it.skipIf(!fundingPath || !committeePath).each([
    { language: 'en', brief: '559b791939da59abd8bd6d51', asks: ['100M/year applied AI', 'apprentice waitlists'],
      grant: 'Applied Research and Development', infrastructure: 'infrastructure expansion' },
    { language: 'fr', brief: '29cd8309b3885e7f4b96e874', asks: ['100 millions artificielle appliquée', 'attente apprentis capacité'],
      grant: 'recherche et développement appliquée', infrastructure: 'expansion des infrastructures' },
  ])('follows both recommendations to the brief and related published terms in $language', async (example) => {
    const fixture = await setup(12);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    fixture.env.AUTH_DB = fixture.db;
    if (!fundingPath || !committeePath) throw new Error('Funding and committee snapshots are required.');
    const open = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      closed.push(() => db.close());
      return localD1(db);
    };
    fixture.env.CIVIC_DB = open(fundingPath);
    fixture.env.COMMITTEE_DB = open(committeePath);
    fixture.env.FUNDING_PREVIEW = fixture.env.COMMITTEE_CORPUS_PREVIEW = 'on';
    const read = async (path: string, parameters: Record<string, string>) => {
      const response = await fixture.send(path + '?' + new URLSearchParams({ language: example.language, ...parameters }));
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const capabilities = await manifest(fixture);
    const guide = await (await fixture.send('/llms.txt', {}, false)).text();
    const home = await (await fixture.send('/', {}, false)).text();
    const recipe = capabilities.researchQuestions.find(q => q.language === example.language);
    if (!recipe) throw new Error('Missing apprenticeship question.');
    expect(recipe).toMatchObject({ id: 'apprenticeship', status: 'available', missingSources: [] });
    for (const [id, field] of [['esdc', 'observedAt'], ['committees', 'coverageThrough']] as const) {
      const src = capabilities.sources.find(source => source.id === id);
      const date = src?.editions.find(row => row.language === example.language)?.[field];
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(guide).toContain(date);
      expect(home).toContain(`href="${src?.openapi}"`);
    }
    expect(await fixture.count()).toBe(0);
    for (const step of recipe.steps) {
      expect(guide).toContain(step.request);
      const response = await fixture.send(step.request);
      expect(response.status, step.request).toBe(200);
      if (step.source === 'esdc') {
        const page = FundingSearchResponse.parse(await response.json());
        expect(page.items.some(item => normalizeForSearch(item.title).includes(normalizeForSearch(example.infrastructure)))).toBe(true);
      } else {
        const page = CommitteeCorpusSearchResponseSchema.parse(await response.json());
        expect(page.items.length).toBeGreaterThan(0);
        if (step.request.includes('kind=brief')) expect(page.items.some(item => item.citation.url.includes('/BR14118467/'))).toBe(true);
        else expect(page.items.some(item => item.citation.url.startsWith('https://') && item.speaker &&
          item.parents.some(parent => parent.id === 'house-huma'))).toBe(true);
      }
    }
    const document = 'house-fina-submission-' + example.brief;
    for (const query of example.asks) {
      const page = CommitteeCorpusSearchResponseSchema.parse(await read('/api/committees/search', {
        query, session: '45-1', committeeId: 'house-fina', studyId: document, kind: 'brief', limit: '10',
      }));
      expect(page.items).toContainEqual(expect.objectContaining({ position: 1, citation: expect.objectContaining({
        id: document, language: example.language, url: expect.stringContaining('/BR14118467/'),
      }) }));
    }

    async function program(source: string, query: string) {
      const path = '/api/funding-programs';
      const page = FundingSearchResponse.parse(await read(path, { query, source, limit: '100' }));
      const hit = page.items.find(item => normalizeForSearch(item.title).includes(normalizeForSearch(query)));
      if (!hit) throw new Error('Missing funded program for ' + query);
      const { item } = FundingLookupResponse.parse(await read(path + '/' + hit.id, {}));
      if (!item) throw new Error('Missing edition for ' + hit.id);
      expect(item).toMatchObject({ language: example.language, availability: 'published', id: hit.id });
      return item;
    }
    const grant = await program('nserc', example.grant);
    expect(grant.sections.some(s => s.field === 'amount' && /150[ ,  ]000/.test(s.text))).toBe(true);
    expect(grant.sections.some(s => s.field === 'partners' && /partn|parten/i.test(s.text))).toBe(true);
    expect(grant.sections.some(s => /polytechni/i.test(s.text))).toBe(true);
    const infrastructure = await program('esdc', example.infrastructure);
    expect(infrastructure.status).toBe('closed');
    const terms = infrastructure.sections.map(section => section.text).join(' ');
    expect(terms).toMatch(/union|syndic/i);
    expect(terms).toMatch(/Red Seal|Sceau rouge/i);
    expect(terms).toMatch(/November 12|12 novembre/i);
    const amount = infrastructure.sections.filter(section => section.field === 'amount').map(section => section.text).join(' ');
    expect(amount).toMatch(/\$3M|3\s000\s000\s*\$/);
    expect(amount).toMatch(/\$10M|10\s000\s000\s*\$/);
    expect(await fixture.count()).toBe(6 + recipe.steps.length);
  }, 30_000);
});

describe('deployment discovery', () => {
  it('limits the apprenticeship question to published sources in the requested language', async () => {
    const fixture = await setup();
    fixture.env.FUNDING_PREVIEW = 'on';
    fixture.sqlite.exec(readFileSync('preview/funding/migrations/0001_funding.sql', 'utf8'));
    const observed = '2026-11-22T09:00:00Z';
    fixture.sqlite.prepare("INSERT INTO funding_catalogues VALUES ('esdc',?,'r1','{}','[]')").run(observed);
    fixture.sqlite.exec(`INSERT INTO funding_editions VALUES ('esdc','esdc-test','fr','r1','Expansion des infrastructures',
      'https://www.canada.ca/fr/','closed',NULL,'metadata-only','[]','expansion des infrastructures')`);
    const caps = await manifest(fixture);
    expect(caps.sources.find(s => s.id === 'esdc')).toMatchObject({ status: 'available',
      editions: [{ language: 'fr', observedAt: observed }] });
    expect(caps.researchQuestions.find(q => q.language === 'en')).toMatchObject({ status: 'unavailable', steps: [] });
    const recipe = caps.researchQuestions.find(q => q.language === 'fr');
    expect(recipe).toMatchObject({ status: 'partial', missingSources: ['committees'], steps: [{ source: 'esdc' }] });
    expect(await fixture.count()).toBe(0);
    const step = recipe?.steps[0];
    if (!step) throw new Error('Missing French ESDC step');
    expect((await fixture.send(step.request)).status).toBe(200);
    expect(await fixture.count()).toBe(1);
  });

  it('withholds query requests when the bound authorization database lacks its schema', async () => {
    const fixture = await setup();
    const auth = testD1({ schema: '' });
    closed.push(auth.close);
    fixture.env.AUTH_DB = auth.db;
    fixture.env.BILL_PREVIEW = 'on';
    const caps = await manifest(fixture);
    expect(caps.sources.find(source => source.id === 'freshwater-study')).toMatchObject({ status: 'unavailable', editions: [] });
    expect(caps.mcp.tools).toEqual([]);
    expect(await fixture.count()).toBe(0);
  });

  it('isolates unreadable sources and offers only verified editions and requests', async () => {
    const fixture = await setup();
    fixture.env.PUBLIC_API_BASE_URL = 'https://different.example';
    fixture.env.HANSARD_PREVIEW = fixture.env.FUNDING_PREVIEW = fixture.env.COMMITTEE_CORPUS_PREVIEW = 'on';
    seedHansard(fixture, 'house', 'fr');
    const caps = await manifest(fixture);
    expect(caps.baseUrl).toBe('https://example.test');
    expect(caps.sources.find(s => s.id === 'hansard-federal')).toMatchObject({ status: 'available',
      editions: [{ language: 'fr', latestRecordDate: '2026-04-23' }] });
    expect(caps.sources.find(s => s.id === 'hansard-senate')).toMatchObject({ status: 'empty', editions: [] });
    expect(caps.sources.find(s => s.id === 'committees')).toMatchObject({ status: 'unavailable', editions: [] });
    expect(caps.sources.find(s => s.id === 'canada-gazette')).toMatchObject({ status: 'disabled', editions: [] });
    expect(caps.researchQuestions[0]).toMatchObject({ status: 'unavailable', steps: [], missingSources: ['committees', 'esdc'] });
    expect(caps.unavailableCoverage.map(c => c.corpusId)).not.toContain('hansard-federal');
    expect(await fixture.count()).toBe(0);
  });
});

describe('Hansard preview HTTP contract', () => {
  it.each(['house', 'senate'] as const)('searches and resolves a cited %s speech by ID', async (chamber) => {
    const fixture = await setup();
    fixture.env.HANSARD_PREVIEW = 'on';
    const { id, sourceUrl, excerpt } = seedHansard(fixture, chamber, 'fr');
    seedHansard(fixture, chamber, 'en');
    seedHansard(fixture, chamber, 'fr', '2026-04-22');
    seedHansard(fixture, chamber === 'house' ? 'senate' : 'house', 'fr');
    const base = HANSARD_PATHS[chamber];
    const response = await fixture.send(`${base}?topic=RESEAU&language=fr&since=2026-04-23&until=2026-04-23&limit=1`);
    expect(response.status).toBe(200);
    const { items, count } = HansardSearchResponseSchema.parse(await response.json());
    expect(count).toBe(1);
    expect(items).toMatchObject([{ id, chamber, corpusId: hansardPolicy(chamber).id,
      citationGranularity: chamber === 'house' ? 'intervention' : 'section', redistribution: 'cite-only',
      citationUrl: sourceUrl, excerpt, language: 'fr', sittingDate: '2026-04-23' }]);

    const exact = await fixture.send(`${base}/${encodeURIComponent(id)}`);
    expect(exact.status).toBe(200);
    expect(HansardLookupResponseSchema.parse(await exact.json()).item).toEqual(items[0]);
    const english = await fixture.send(`${base}?topic=railway&language=en`);
    expect(english.status).toBe(200);
    expect(HansardSearchResponseSchema.parse(await english.json()).items).toMatchObject([{ chamber, language: 'en' }]);
    expect(await fixture.count()).toBe(3);
  });

  it('distinguishes disabled preview, missing edition, no matches, and a missing speech', async () => {
    const fixture = await setup();
    seedHansard(fixture, 'house', 'en');
    const base = HANSARD_PATHS.house;
    const disabled = await fixture.send(`${base}?topic=railway&language=en`);
    expect(disabled.status).toBe(501);
    expect(HansardErrorSchema.parse(await disabled.json()).code).toBe('UNSUPPORTED_COVERAGE');
    fixture.env.HANSARD_PREVIEW = 'on';

    const unavailable = await fixture.send(`${base}?topic=railway&language=fr`);
    expect(unavailable.status).toBe(503);
    expect(HansardErrorSchema.parse(await unavailable.json()).code).toBe('RETRIEVAL_UNAVAILABLE');
    const unknownSpeech = await fixture.send(`${base}/hansard:en:45-1-109:missing`);
    expect(unknownSpeech.status).toBe(404);
    expect(HansardErrorSchema.parse(await unknownSpeech.json()).code).toBe('NOT_FOUND');
    expect(await fixture.count()).toBe(0);

    const empty = await fixture.send(`${base}?topic=missing&language=en`);
    expect(empty.status).toBe(200);
    expect(HansardSearchResponseSchema.parse(await empty.json())).toEqual({ items: [], count: 0 });
    expect(await fixture.count()).toBe(1);
  });

  it('rejects invalid arguments and unauthenticated requests without consuming usage', async () => {
    const fixture = await setup();
    fixture.env.HANSARD_PREVIEW = 'on';
    const base = HANSARD_PATHS.senate;
    const valid = `${base}?topic=rail&language=en`;
    const denied = await fixture.send(valid, {}, false);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(HansardErrorSchema.parse(await denied.json()).code).toBe('KEY_REQUIRED');
    const method = await fixture.send(valid, { method: 'POST' });
    expect(method.status).toBe(405);
    expect(HansardErrorSchema.parse(await method.json()).code).toBe('METHOD_NOT_ALLOWED');

    for (const path of [
      `${base}?topic=rail`, `${base}?topic=+&language=en`, `${base}?topic=rail&language=de`,
      `${valid}&since=2026-02-30`, `${valid}&since=2026-04-23&until=2026-04-22`,
      `${valid}&language=fr`, `${valid}&limit=101`, `${valid}&limit=1e1`, `${valid}&unknown=value`,
      `${base}/hansard:en:45-1-109:8-1`, `${base}/%E0%A4`, `${base}/senate-hansard:en:45-1-67:8-1?topic=rail`,
    ]) {
      const response = await fixture.send(path);
      expect(response.status, path).toBe(400);
      expect(HansardErrorSchema.parse(await response.json()).code).toBe('INVALID_ARGUMENT');
    }
    expect(await fixture.count()).toBe(0);
  });

  it('uses the shared quota and exposes its typed refusal', async () => {
    const fixture = await setup(1);
    fixture.env.HANSARD_PREVIEW = 'on';
    seedHansard(fixture, 'senate', 'en');
    const path = `${HANSARD_PATHS.senate}?topic=railway&language=en`;
    expect((await fixture.send(path)).status).toBe(200);
    const refused = await fixture.send(path);
    expect(refused.status).toBe(429);
    expect(HansardErrorSchema.parse(await refused.json())).toMatchObject({ code: 'FUSE_EXCEEDED', count: 1 });
    expect(await fixture.count()).toBe(1);
  });

  it('serves OpenAPI with both chambers, parameters, examples, and workspace bearer auth', async () => {
    const fixture = await setup();
    const response = await fixture.send(HANSARD_OPENAPI_PATH, {}, false);
    expect(response.status).toBe(200);
    const doc = await response.json<ReturnType<typeof hansardOpenApi>>();
    expect(doc).toEqual(hansardOpenApi());
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes.workspaceKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(Object.keys(doc.paths)).toHaveLength(6);
    for (const base of Object.values(HANSARD_PATHS)) {
      const feed = doc.paths[`${base}/changes`].get;
      const feedPage = SourceFeedResponseSchema.parse(feed.responses[200].content['application/json'].example);
      expect(base).toBe('/api/debates/' + feedPage.scope.source);
      const search = doc.paths[base].get;
      expect(search.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'language', required: true }),
        expect.objectContaining({ name: 'limit', required: false, schema: expect.objectContaining({ default: 25 }) }),
      ]));
      expect(HansardSearchResponseSchema.parse(search.responses[200].content['application/json'].example).count).toBe(1);
      const lookup = doc.paths[`${base}/{speechId}`].get;
      expect(lookup.parameters).toMatchObject([{ name: 'speechId', in: 'path', required: true }]);
      expect(HansardLookupResponseSchema.parse(lookup.responses[200].content['application/json'].example).item.id).toBeTruthy();
    }
    expect(await fixture.count()).toBe(0);
  });
});

describe('House written questions through the Worker', () => {
  it('meters successful retrieval separately from a rejected unauthenticated lookup', async () => {
    const fixture = await setup();
    fixture.env.WRITTEN_QUESTIONS_PREVIEW = 'on';
    fixture.sqlite.exec(readFileSync('preview/written-questions/migrations/0001_written_questions.sql', 'utf8'));
    fixture.sqlite.prepare(`INSERT INTO questions(session, number, language, url, text, status, metadata_json, source_hash, acquisition)
      VALUES ('45-1', 7, 'en', ?, 'Which records are available?', 'awaiting_response', '{}', ?, 'complete')`)
      .run('https://www.ourcommons.ca/written-questions/45-1/q-7', 'a'.repeat(64));
    const path = '/api/written-questions/45-1/7/en';
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    const response = await fixture.send(path);
    expect(response.status).toBe(200);
    expect(WrittenQuestionLookupResponseSchema.parse(await response.json())).toMatchObject({
      state: 'found', answerState: 'no-reply', question: { number: 7, status: 'awaiting_response' },
    });
    expect(await fixture.count()).toBe(1);
  });

  const localSource = process.env.CIVICSIGNAL_WRITTEN_QUESTIONS_D1;
  it.skipIf(!localSource)('reads the materialized House session through authenticated HTTP', async () => {
    const fixture = await setup(12);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    if (!localSource) throw new Error('Set CIVICSIGNAL_WRITTEN_QUESTIONS_D1 to the local preview database.');
    const sqlite = new DatabaseSync(localSource, { readOnly: true });
    closed.push(() => sqlite.close());
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(sqlite);
    fixture.env.WRITTEN_QUESTIONS_PREVIEW = 'on';
    expect(await publishedEditions(fixture, 'written-questions')).toMatchObject([{ language: 'en' }, { language: 'fr' }]);
    const base = '/api/written-questions';
    const read = async (path: string) => {
      const response = await fixture.send(base + path);
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const paper = WrittenQuestionLookupResponseSchema.parse(await read('/45-1/1/en'));
    expect(paper).toMatchObject({ state: 'found', answerState: 'available', documents: [
      expect.objectContaining({ attribution: { publisher: 'House of Commons of Canada', surrogate: 'Library of Parliament' } }),
    ] });
    const french = WrittenQuestionLookupResponseSchema.parse(await read('/45-1/1010/fr'));
    expect(french).toMatchObject({ state: 'found', documents: expect.arrayContaining([
      expect.objectContaining({ kind: 'reply', respondent: 'Ministère des Services aux Autochtones' }),
    ]) });
    const annex = WrittenQuestionLookupResponseSchema.parse(await read('/45-1/1204/en'));
    expect(annex).toMatchObject({ state: 'found', documents: expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', url: expect.stringContaining('budget.canada.ca/') }),
    ]) });
    const results = WrittenQuestionSearchResponseSchema.parse(await read('?query=logement&language=fr&kind=reply&limit=5'));
    expect(results.items.length).toBeGreaterThan(0);
    const coverage = WrittenQuestionCoverageResponseSchema.parse(await read('/coverage?session=45-1'));
    expect(coverage.coverage.map(row => row.questions)).toEqual([1709, 1709]);
    const big = WrittenQuestionLookupResponseSchema.parse(await read('/45-1/280/en'));
    if (big.state !== 'found') throw new Error('Q-280 missing from authenticated full-session lookup.');
    const item = big.documents.find(document => document.hasMore);
    if (!item) throw new Error('Expected a paged sessional paper for Q-280.');
    const chunks = WrittenQuestionChunksResponseSchema.parse(await read(
      '/45-1/280/en/chunks?documentKey=' + encodeURIComponent(item.documentKey) + '&offset=1&limit=1'));
    expect(chunks.chunks[0]?.index).toBe(1);
    expect(chunks.chunks[0]?.text.length).toBeGreaterThan(0);
    expect(await fixture.count()).toBe(7);
  });
});

describe('Gazette preview through the Worker', () => {
  it('publishes OpenAPI and checks access and preview configuration before billing', async () => {
    const fixture = await setup();
    const path = '/api/gazette?language=fr&part=II&topic=agriculture';
    const document = await fixture.send(GAZETTE_OPENAPI_PATH, {}, false);
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual(gazetteOpenApi());
    expect((await fixture.send(path, { method: 'POST' })).status).toBe(405);
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path)).status).toBe(501);
    fixture.env.GAZETTE_PREVIEW = 'on';
    expect(await (await fixture.send(path)).json()).toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE' });
    fixture.env.GAZETTE_DB = fixture.db;
    const uninitialized = await fixture.send(path);
    expect(uninitialized.status).toBe(503);
    expect(await uninitialized.json()).toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE' });
    expect(await fixture.count()).toBe(0);
  });

  it('recalls replayed records in both languages and parts, using the workspace allowance', async () => {
    const fixture = await setup(9);
    const dir = mkdtempSync(join(tmpdir(), 'civicsignal-gazette-endpoint-'));
    const file = join(dir, 'gazette.sqlite');
    closed.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('bun', ['--no-env-file', 'scripts/gazette-local.ts', 'replay', file, 'test/fixtures/gazette/week.json']);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    const sqlite = new DatabaseSync(file, { readOnly: true });
    closed.unshift(() => sqlite.close());
    fixture.env.GAZETTE_PREVIEW = 'on';
    fixture.env.GAZETTE_DB = localD1(sqlite);
    for (const part of ['I', 'II']) {
      for (const language of ['en', 'fr']) {
        const record = sqlite.prepare('SELECT id, title, citation_url FROM gazette_records WHERE part = ? AND language = ? ORDER BY id LIMIT 1')
          .get(part, language);
        if (!record || typeof record.title !== 'string') throw new Error('The Gazette fixture edition is empty.');
        const query = new URLSearchParams({ part, language, topic: record.title, since: '2026-04-20', until: '2026-04-26' });
        const search = await fixture.send('/api/gazette?' + query);
        expect(search.status).toBe(200);
        const { items } = GazetteSearchResponseSchema.parse(await search.json());
        const hit = items.find((item) => item.id === record.id);
        expect(hit).toMatchObject({ part, language, citationUrl: record.citation_url, redistribution: 'metadata-only' });
        const lookup = await fixture.send('/api/gazette/' + encodeURIComponent(String(record.id)));
        expect(lookup.status).toBe(200);
        expect(GazetteLookupResponseSchema.parse(await lookup.json()).item).toEqual(hit);
      }
    }
    const noMatches = '/api/gazette?part=I&language=fr&topic=introuvable-404';
    const empty = await fixture.send(noMatches);
    expect(empty.status).toBe(200);
    expect(GazetteSearchResponseSchema.parse(await empty.json()).items).toEqual([]);
    expect((await fixture.send(noMatches)).status).toBe(429);
    expect(await fixture.count()).toBe(9);
  });
});

describe('bill committee brief through the Worker', () => {
  it('documents and serves the replay with workspace auth, coverage and usage checks', async () => {
    const fixture = await setup(1);
    const path = '/api/bills/44/1/S-5/brief?language=fr';
    const openapi = await fixture.send(BILL_OPENAPI_PATH, {}, false);
    expect(openapi.status).toBe(200);
    expect((await openapi.json<ReturnType<typeof billTraceOpenApi>>()).paths[BILL_BRIEF_PATH].get.operationId).toBe('getBillCommitteeBrief');
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path, { method: 'POST' })).status).toBe(405);
    expect((await fixture.send(path)).status).toBe(501);
    fixture.env.BILL_PREVIEW = 'on';
    expect((await fixture.send(path)).status).toBe(503);
    fixture.env.BILL_DB = fixture.db;
    expect((await fixture.send(path)).status).toBe(503);
    expect((await fixture.send('/api/bills/44/1/s-5/brief')).status).toBe(400);
    expect((await fixture.send(path + '&language=en')).status).toBe(400);
    expect((await fixture.send(path.replace('/44/', '/45/'))).status).toBe(501);
    expect(await fixture.count()).toBe(0);
    replayBillTrace(fixture.sqlite, 'preview/bills/44-1-s-5');
    expect(await publishedEditions(fixture, 'bill-trace')).toHaveLength(2);
    expect(await publishedEditions(fixture, 'freshwater-study')).toHaveLength(2);
    const response = await fixture.send(path);
    expect(response.status).toBe(200);
    const brief = BillBriefSchema.parse(await response.json());
    expect(brief).toMatchObject({ complete: true, language: 'fr', bill: { number: 'S-5' } });
    expect(brief.records.some((record) => record.tally?.yeas === 208)).toBe(true);
    expect(await fixture.count()).toBe(1);
    expect((await fixture.send(path)).status).toBe(429);
  });
});

describe('committee study brief through the Worker', () => {
  it('requires an enabled preview and meters one successful historical lookup', async () => {
    const fixture = await setup(1);
    const path = COMMITTEE_STUDY_BRIEF_PATH + '?language=fr&asOf=2026-05-28';
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path, { method: 'POST' })).status).toBe(405);
    expect((await fixture.send(path)).status).toBe(501);
    fixture.env.BILL_PREVIEW = 'on';
    expect((await fixture.send(path + '&asOf=2026-09-25')).status).toBe(400);
    expect(await fixture.count()).toBe(0);
    const response = await fixture.send(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ language: 'fr', asOf: '2026-05-28' });
    expect(await fixture.count()).toBe(1);
    expect((await fixture.send(path)).status).toBe(429);
  });
});

describe('session committee corpus through the Worker', () => {
  it('publishes discovery and checks authentication, preview state and usage', async () => {
    const fixture = await setup();
    const base = '/api/committees';
    const spec = await fixture.send(base + '/openapi.json', {}, false);
    expect(spec.status).toBe(200);
    expect(await spec.json()).toMatchObject({ paths: { '/api/committees/search': { get: {} } } });
    const path = base + '/45-1?language=en';
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path)).status).toBe(501);
    fixture.env.COMMITTEE_CORPUS_PREVIEW = 'on';
    expect((await fixture.send(path)).status).toBe(503);
    fixture.env.COMMITTEE_DB = fixture.db;
    fixture.sqlite.exec(readFileSync('preview/committees/migrations/0001_committee_preview.sql', 'utf8'));
    const response = await fixture.send(path);
    expect(response.status).toBe(200);
    expect(CommitteeCorpusPageSchema.parse(await response.json()).items).toEqual([]);
    expect(await fixture.count()).toBe(1);
  });

  const databasePath = process.env.CIVICSIGNAL_COMMITTEES_D1;
  it.skipIf(!databasePath)('traverses real bilingual committee publications with a workspace key', async () => {
    if (!databasePath) throw new Error('Set CIVICSIGNAL_COMMITTEES_D1 to the local committee D1 database.');
    const fixture = await setup(20);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    const sqlite = new DatabaseSync(databasePath, { readOnly: true });
    closed.push(() => sqlite.close());
    fixture.env.COMMITTEE_CORPUS_PREVIEW = 'on';
    fixture.env.COMMITTEE_DB = localD1(sqlite);
    let successful = 0;
    const read = async (path: string) => {
      const response = await fixture.send('/api/committees' + path);
      expect(response.status, path).toBe(200);
      successful++;
      return response.json();
    };

    const joint = await read('/45-1/joint-regs?language=fr');
    expect(joint).toMatchObject({ state: 'found', record: { chamber: 'joint', kind: 'committee', language: 'fr' } });
    const studies = CommitteeCorpusPageSchema.parse(await read('/45-1/house-envi/studies?language=en&limit=1'));
    const later = CommitteeCorpusPageSchema.parse(await read('/45-1/house-envi/studies?language=en&limit=1&offset=1'));
    expect(studies.hasMore).toBe(true);
    expect(later.items[0]?.id).not.toBe(studies.items[0]?.id);
    const report = await read('/45-1/documents/house-envi-report-2?language=en');
    expect(report).toMatchObject({ state: 'found', links: expect.arrayContaining([
      expect.objectContaining({ relation: 'government-response' }),
    ]) });
    const english = CommitteeCorpusSearchResponseSchema.parse(await read('/search?session=45-1&committeeId=house-envi&language=en&kind=evidence&query=water&limit=5'));
    expect(english.items.some(hit => hit.citation.url.includes('ourcommons.ca') && hit.text && hit.speaker)).toBe(true);
    const french = CommitteeCorpusSearchResponseSchema.parse(await read('/search?session=45-1&committeeId=house-envi&language=fr&kind=evidence&query=eau&limit=5'));
    expect(french.items.some(hit => hit.text && hit.citation.language === 'fr')).toBe(true);

    const brief = '/45-1/documents/senate-soci-submission-7ac33f1fab2a138082b2997a';
    const submission = await read(brief + '?language=en');
    expect(submission).toMatchObject({ state: 'found', record: { metadata: { organization: 'Digital Research Alliance of Canada' } },
      links: expect.arrayContaining([expect.objectContaining({ id: 'senate-soci-study-soci-s-5', direction: 'parent' })]) });
    expect(await read('/45-1/senate-soci/studies/senate-soci-study-soci-s-5?language=en'))
      .toMatchObject({ state: 'found', record: { title: expect.stringContaining('S-5'), kind: 'study' } });
    const pages = await read(brief + '/passages?language=en&limit=1');
    expect(pages).toMatchObject({ items: [expect.objectContaining({ text: null, position: 0 })] });
    const nextPage = await read(brief + '/passages?language=en&offset=1&limit=1');
    expect(nextPage).toMatchObject({ items: [expect.objectContaining({ position: 1 })] });
    const missingMinutes = await read('/45-1/documents/house-secu-minutes-12?language=fr');
    expect(missingMinutes).toMatchObject({ state: 'found', record: { status: 'unavailable', metadata: { reason: 'HTTP 404' } } });
    const coverage = CommitteeCorpusCoverageSchema.parse(await read('/coverage?session=45-1&language=en&limit=1'));
    expect(coverage.cutoff).toBeTruthy();
    expect(coverage.counts.length).toBeGreaterThan(0);
    expect(await fixture.count()).toBe(successful);
  });
});

describe('source change feeds through authenticated Worker routes', () => {
  const sources = [
    { source: 'gazette', path: '/api/gazette/changes', directory: 'gazette', file: 'part-i-en.html',
      cli: 'gazette-local', replay: 'replay', topic: 'export control', original: 'Export Control List' },
    { source: 'house', path: '/api/debates/house/changes', directory: 'hansard', file: 'sitting-en.xml',
      cli: 'hansard-local', replay: 'replay-week', topic: 'housing regulation', original: 'housing regulation' },
    { source: 'senate', path: '/api/debates/senate/changes', directory: 'senate-hansard', file: 'issue-en.html',
      cli: 'hansard-local', replay: 'replay-senate-week', topic: 'rail connection', original: 'rail connection' },
  ] as const;

  it.each(sources)('resumes the $source watch when a corrected edition loses its original term', async (source) => {
    const fixture = await setup(3);
    const query = new URLSearchParams({ language: 'en', topic: source.topic, limit: '1' });
    const path = source.path + '?' + query;
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path)).status).toBe(501);
    expect((await fixture.send(path, { method: 'POST' })).status).toBe(405);

    const dir = mkdtempSync(join(tmpdir(), 'civicsignal-feed-http-'));
    closed.push(() => rmSync(dir, { recursive: true, force: true }));
    const input = join(dir, 'fixtures');
    cpSync(join('test/fixtures', source.directory), input, { recursive: true });
    const file = join(dir, 'preview.sqlite');
    const replay = () => execFileSync('bun', ['--no-env-file', 'scripts/' + source.cli + '.ts', source.replay, file, join(input, 'week.json')]);
    replay();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    const sqlite = new DatabaseSync(file, { readOnly: true });
    closed.unshift(() => sqlite.close());
    fixture.env.AUTH_DB = fixture.db;
    if (source.source === 'gazette') {
      fixture.env.GAZETTE_PREVIEW = 'on';
      fixture.env.GAZETTE_DB = localD1(sqlite);
    } else {
      fixture.env.HANSARD_PREVIEW = 'on';
      fixture.env.CIVIC_DB = localD1(sqlite);
    }
    expect((await publishedEditions(fixture, source.source + '-changes')).some(e => e.observedAt && e.latestRecordDate)).toBe(true);
    if (source.source === 'gazette') expect(await publishedEditions(fixture, 'canada-gazette')).toHaveLength(4);
    const poll = async (cursor?: string) => {
      const response = await fixture.send(path + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      expect(response.status).toBe(200);
      return SourceFeedResponseSchema.parse(await response.json());
    };
    const baseline = await poll();
    expect(baseline.scope).toMatchObject({ source: source.source, language: 'en' });
    expect(baseline.events).toMatchObject([{ kind: 'added', matches: { before: false, after: true } }]);
    const changedFile = join(input, source.file);
    const initial = readFileSync(changedFile, 'utf8');
    expect(initial).toContain(source.original);
    writeFileSync(changedFile, initial.replace(source.original, 'revised subject'));
    replay();
    const corrected = await poll(baseline.nextCursor);
    expect(corrected.events).toMatchObject([{ kind: 'corrected', recordId: baseline.events[0]?.recordId,
      citationUrl: baseline.events[0]?.citationUrl, matches: { before: true, after: false } }]);
    replay();
    expect(await poll(corrected.nextCursor)).toMatchObject({ events: [], hasMore: false, nextCursor: corrected.nextCursor });
    expect((await fixture.send(path)).status).toBe(429);
    expect(await fixture.count()).toBe(3);
  }, 30_000);
});

describe('HTTP and MCP access and metering', () => {
  it.each(['supported', 'outside', 'clarify', 'recovered', 'invalid'] as const)('runs opt-in hybrid scope and evidence through the HTTP route (%s)', async (outcome) => {
    const fixture = await setup();
    const revision = 'f'.repeat(40);
    const text = 'Le Conseil peut convoquer des témoins et leur ordonner de témoigner aux audiences.';
    fixture.sqlite.prepare('UPDATE corpus_state SET commit_sha = ?, parser_version = ?').run(revision, 'statutes-v2');
    fixture.sqlite.prepare(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language,heading)
      VALUES('acts-fr-board','statutes-canada','Code canadien du travail','L-2','16','in-force',?,'https://laws-lois.justice.gc.ca/fr/lois/L-2/section-16.html','CA',1,'fr','Pouvoirs du Conseil')`).run(text);
    const bytes = new TextEncoder().encode(JSON.stringify([{ id: 'acts-fr-board', heading: 'Pouvoirs du Conseil', lead: text }])).buffer;
    const range = { offset: 0, length: bytes.byteLength };
    const catalog = { revision: `${revision}:statutes-v2`, labourParts: { 'fr:16': 'PARTIE I Relations du travail' },
      instruments: [{ title: 'Code canadien du travail', citation: 'L-2', language: 'fr', ...range }] };
    const read = vi.fn(async (path: string) => path.endsWith('catalog.json') ? { size: 150, json: async () => catalog }
      : { size: bytes.byteLength, range, arrayBuffer: async () => bytes });
    fixture.env.CORPORA = { get: read } as unknown as R2Bucket;
    fixture.env.HYBRID_SEARCH = 'on';
    fixture.env.SEARCH_ZEN_KEY = 'fixture-search-key';
    fixture.env.ENCODER_TOKEN = 'fixture-encoder-key';
    fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array(768).fill(0.1)] }); } };
    const vector = vi.fn(async () => ({ matches: [] }));
    fixture.env.VECTORIZE = { query: vector };
    let evidenceCalls = 0;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const user = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (user.passages) evidenceCalls++;
      const decision = user.passages ? {
        status: 'supported', candidate: 1, quote: outcome === 'invalid' || (outcome === 'recovered' && evidenceCalls === 1)
          ? 'Un extrait inventé ne passe pas la vérification.' : text,
      } : outcome === 'outside' ? { action: 'outside' } : { action: 'search', act: 'Code canadien du travail', phrase: 'pouvoirs du Conseil' };
      if (user.passages) expect(user.passages[0].statutoryPart).toBe('PARTIE I Relations du travail');
      return Response.json(providerText('openai', JSON.stringify(decision)));
    });
    const exact = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(exact.status).toBe(200);
    expect(provider).not.toHaveBeenCalled();
    const topic = outcome === 'clarify' ? 'Qui décide si mon poste peut faire partie d’une unité de négociation?'
      : 'Quels sont les pouvoirs du Conseil canadien des relations industrielles selon le Code canadien du travail?';
    const response = await fixture.send('/api/statutes?language=fr&topic=' + encodeURIComponent(topic));
    expect(vector.mock.calls).toMatchObject([[expect.any(Array), { topK: 20, filter: { language: 'fr' } }]]);
    const body = await response.json() as { retrieval: unknown; items: { id: string }[] };
    expect(response.status).toBe(outcome === 'invalid' ? 502 : 200);
    const supported = outcome === 'supported' || outcome === 'recovered';
    const retried = outcome === 'recovered' || outcome === 'invalid';
    expect(body.retrieval).toMatchObject([{ mode: 'hybrid', decision: supported ? 'answer' : outcome === 'invalid' ? 'error' : 'refuse' }]);
    expect(evidenceCalls).toBe(outcome === 'outside' || outcome === 'clarify' ? 0 : 1 + Number(retried));
    expect(provider).toHaveBeenCalledTimes(1 + evidenceCalls);
    if (supported) {
      expect(body.items[0].id).toBe('acts-fr-board');
      expect(await fixture.count()).toBe(2); // One unit each for the exact lookup and the hybrid search.
    }
    if (retried) {
      expect(body.retrieval).toMatchObject([{ hybrid: { evidenceRetry: true } }]);
    }
    if (outcome === 'outside') expect(body.items).toEqual([]);
    if (outcome === 'clarify') expect(body.retrieval).toMatchObject([{ hybrid: { scope: 'clarify', evidence: false } }]);
    if (outcome === 'invalid') expect(await fixture.count()).toBe(1);
  });

  it('holds the last workspace unit before the caller-paid provider starts', async () => {
    const fixture = await setup(1);
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let finishProvider!: () => void;
    const finish = new Promise<void>((resolve) => { finishProvider = resolve; });
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      providerStarted();
      await finish;
      return Response.json(providerText('openai', '[Test Act](https://example.test/act/1)'));
    });
    const chat = () => fixture.send('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CivicSignal-BYOK-Provider': 'openai', 'X-CivicSignal-BYOK-Key': 'fixture-only' },
      body: JSON.stringify({ topic: 'Test Act section 1', messages: [{ role: 'user', content: 'Give the citation.' }] }),
    });

    const first = chat();
    try {
      await started;
      const second = await chat();
      expect(second.status).toBe(429);
      const lookup = await fixture.send('/api/statutes?act=Test+Act&section=1');
      expect(lookup.status).toBe(429);
      expect(await fixture.count()).toBe(0);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      finishProvider();
    }
    expect((await first).status).toBe(200);
    expect(await fixture.count()).toBe(1);
  });

  it('hides discovery and refuses corpus reads during an open publication', async () => {
    const fixture = await setup();
    fixture.sqlite.exec(`INSERT INTO corpus_publication_guard(corpus_id,generation,target_commit,target_date)
      VALUES('statutes-canada',1,'next-revision','2026-10-23')`);
    const vector = vi.fn(async () => ({ matches: [] }));
    fixture.env.VECTORIZE = { query: vector };

    for (const path of ['/api/statutes?act=Test+Act&section=1', '/api/brief?topic=leave', '/api/changes?after=7']) {
      const response = await fixture.send(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE' });
    }
    const match = await fixture.send('/api/match', {
      method: 'POST', body: JSON.stringify({ vector: Array(768).fill(0.1) }),
    });
    expect(match.status).toBe(503);
    const capabilities = await fixture.send('/.well-known/civicsignal.json', {}, false);
    expect(await capabilities.json()).toMatchObject({ endpoints: [], mcp: { tools: [] } });
    expect(await (await fixture.rpc('tools/list')).text()).not.toContain('cite_provision');
    expect(vector).not.toHaveBeenCalled();
    expect(await fixture.count()).toBe(0);
  });

  it('discards a semantic result when the generation changes during the request', async () => {
    const fixture = await setup();
    const vector = vi.fn(async () => {
      fixture.sqlite.exec(`INSERT INTO corpus_publication_guard(corpus_id,generation)
        VALUES('statutes-canada',1)`);
      fixture.sqlite.exec("UPDATE statute_sections SET text='New generation text' WHERE id='acts-en-one'");
      return { matches: [{ id: 'acts-en-one', score: 0.9 }] };
    });
    fixture.env.VECTORIZE = { query: vector };
    fixture.env.ENCODER_TOKEN = 'synthetic-local-only';
    fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array(768).fill(0.1)] }); } };
    const crossed = await fixture.send('/api/statutes?topic=leave');
    expect(crossed.status).toBe(503);
    const body = await crossed.json();
    expect(body).toMatchObject({ code: 'RETRIEVAL_UNAVAILABLE' });
    expect(body).not.toHaveProperty('items');
    expect(await fixture.count()).toBe(0);
    expect(vector).toHaveBeenCalledTimes(1);

    const settled = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(settled.status).toBe(200);
    expect(await settled.text()).toContain('New generation text');
    expect(await fixture.count()).toBe(1);
  });

  it('serves and meters a semantic answer when the cache read fails', async () => {
    const fixture = await setup();
    const get = vi.fn(async () => { throw new Error('private-cache-error'); });
    const put = vi.fn(async () => {});
    const vector = vi.fn(async () => ({ matches: [{ id: 'acts-en-one', score: 0.9 }] }));
    fixture.env.CIVIC_CACHE = { get, put } as unknown as KVNamespace;
    fixture.env.VECTORIZE = { query: vector };
    fixture.env.ENCODER_TOKEN = 'synthetic-local-only';
    fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array(768).fill(0.1)] }); } };

    const response = await fixture.send('/api/statutes?topic=test+rule&language=en');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      items: [{ id: 'acts-en-one', citationUrl: 'https://example.test/act/1' }],
      retrieval: [{ decision: 'answer', cache: 'miss', cacheFailure: 'read' }],
    });
    expect(JSON.stringify(body)).not.toContain('private-cache-error');
    expect(await fixture.count()).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(vector).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a cached answer with conflicting shared-text byte contracts before billing', async () => {
    const fixture = await setup(), storage = memoryTextBucket();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = fixture.sqlite.prepare('SELECT * FROM statute_sections WHERE id=?').get('acts-en-one')!;
    const text = String(original.text);
    for (const id of ['acts-en-one', 'acts-en-two']) {
      const row = { ...original, id };
      const hash = rowFingerprintWithText(row, text);
      if (id !== original.id) fixture.sqlite.prepare(`INSERT INTO statute_sections
        (id,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language)
        SELECT ?,corpus_id,act,citation,section,status,text,source_url,jurisdiction,in_force,language FROM statute_sections WHERE id=?`).run(id, original.id);
      fixture.sqlite.prepare('UPDATE statute_sections SET text_hash=?,text=? WHERE id=?').run(hash, '', id);
      const artifact = await prepareProvisionText({ rowId: id, corpusId: 'statutes-canada', rowFingerprint: hash, text });
      await writeImmutableProvisionText(storage.bucket, artifact);
      await fixture.db.prepare(UPSERT_TEXT_REFERENCE_SQL).bind(...textReferenceBindings(artifact.reference)).run();
    }
    fixture.sqlite.prepare('UPDATE corpus_state SET row_count=2 WHERE corpus_id=?').run('statutes-canada');
    fixture.env.CORPUS_TEXT_MODE = 'r2';
    fixture.env.CORPORA = storage.bucket as unknown as R2Bucket;
    const vector = vi.fn(async () => ({ matches: [] })), encoder = vi.fn(async () => Response.json({ vectors: [] }));
    fixture.env.VECTORIZE = { query: vector };
    fixture.env.ENCODER_TOKEN = 'synthetic-local-only';
    fixture.env.ENCODER_SERVICE = { fetch: encoder };
    fixture.env.CIVIC_CACHE = { get: async () => ({ decision: 'answer', anyRelevant: 1, order: ['acts-en-one', 'acts-en-two'] }),
      put: async () => {} } as unknown as KVNamespace;
    const route = '/api/statutes?topic=shared+test+rule&language=en&limit=2', before = storage.reads();
    const valid = await fixture.send(route);
    expect(valid.status).toBe(200);
    expect(await fixture.count()).toBe(1);
    expect(storage.reads() - before).toBe(1);
    fixture.sqlite.prepare('UPDATE statute_text_refs SET bytes=bytes+1 WHERE row_id=?').run('acts-en-two');
    const failed = await fixture.send(route), body = await failed.json();
    expect(failed.status).toBe(502);
    expect(body).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retrieval: [expect.objectContaining({ cache: 'hit', decision: 'error',
      scoreSource: 'none', providers: { encoder: 'not-called', vector: 'not-called', reranker: 'disabled', rows: 'error' } })] });
    expect(await fixture.count()).toBe(1);
    expect(vector).not.toHaveBeenCalled(); expect(encoder).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'claude-haiku-4-5', mode: 'messages', endpoint: 'https://opencode.ai/inference/anthropic/v1/messages' },
    { model: 'deepseek-v4.1-flash', mode: 'completions', endpoint: 'https://opencode.ai/inference/openai/v1/chat/completions' },
  ])('routes one authenticated Zen $model chat through retrieval, generation and shared usage', async ({ model, mode, endpoint }) => {
    const fixture = await setup();
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-zen-generation-key');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(128);
      const system = mode === 'messages' ? body.system : body.messages[0]?.content;
      expect(system).toContain('A verified test provision.');
      expect(system).toContain('https://example.test/act/1');
      expect(String(init?.body)).not.toContain('fixture-zen-generation-key');
      const answer = 'Test Act section 1: https://example.test/act/1';
      return Response.json(mode === 'messages' ? { content: [{ type: 'text', text: answer }] }
        : { choices: [{ message: { content: answer } }] });
    });
    const request = { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': 'opencode-zen', 'x-civicsignal-byok-key': 'fixture-zen-generation-key' },
      body: JSON.stringify({ provider: 'opencode-zen', ...(mode === 'completions' ? { model } : {}), topic: 'Test Act section 1', maxTokens: 128,
        messages: [{ role: 'user', content: 'Give the cited statute name and its link.' }] }) };
    expect((await fixture.send('/api/chat', request, false)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();expect(await fixture.count()).toBe(0);
    const response = await fixture.send('/api/chat', request);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'opencode-zen', model,
      answer: 'Test Act section 1: https://example.test/act/1', cited: [expect.objectContaining({ corpusId: 'statutes-canada', redistribution: 'open' })] });
    expect(body.retrieval).toEqual([expect.objectContaining({ corpusId: 'statutes-canada', mode: 'exact' })]);
    expect(JSON.stringify(body)).not.toContain('fixture-zen-generation-key');
    expect(send).toHaveBeenCalledTimes(1);expect(await fixture.count()).toBe(1);
    expect(new Set(fixture.names)).toEqual(new Set(['customer:customer_kept']));
  });
  it.each([{ provider: 'google' }, { model: 'gpt-4.1-mini' }])('refuses unsupported Zen routing before generation or billing', async (change) => {
    const fixture = await setup(),send = vi.spyOn(globalThis, 'fetch');
    const response = await fixture.send('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': 'opencode-zen', 'x-civicsignal-byok-key': 'fixture-zen-generation-key' },
      body: JSON.stringify({ provider: 'opencode-zen', topic: 'Test Act section 1', maxTokens: 128,
        messages: [{ role: 'user', content: 'Give the cited statute name and its link.' }], ...change }) });
    expect(response.status).toBe(400);expect(send).not.toHaveBeenCalled();expect(await fixture.count()).toBe(0);
  });
  it.each(generationProviders.flatMap(provider=>(['http401','http429','http503','transport','json','shape','body-limit','fetch-timeout','body-timeout'] as const).map(kind=>({provider,kind}))))('reports safe $provider $kind generation failure at the Worker HTTP/metering boundary',async({provider,kind})=>{
    const fixture=await setup(),key='fixture-generation-key-must-stay-private',prompt='fixture-private-prompt',detail='fixture-private-upstream-detail';
    const logs=vi.spyOn(console,'error').mockImplementation(()=>{});
    let started!:()=>void;const sent=new Promise<void>(resolve=>{started=resolve;});
    const timeout=kind.endsWith('timeout');if(timeout)vi.useFakeTimers();
    const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      expect(String(input)).toBe(generationEndpoints[provider]);expect(init?.method).toBe('POST');expect(init?.redirect).toBe('manual');started();
      if(kind==='fetch-timeout')return new Promise<Response>(()=>{});
      if(kind==='body-timeout')return new Response(new ReadableStream<Uint8Array>({start(){},cancel(){}}));
      if(kind.startsWith('http'))return new Response(key+' '+prompt+' '+detail,{status:Number(kind.slice(4))});
      if(kind==='transport')throw new Error(key+' '+prompt+' '+detail);
      if(kind==='json')return new Response(key+' '+prompt+' '+detail);
      if(kind==='body-limit')return new Response('x'.repeat(256*1024+1));
      return Response.json(provider==='openai'?{choices:[{message:{content:{private:detail}}}]}:provider==='google'?{candidates:[{content:{parts:{private:detail}}}]}:{content:{private:detail}});
    });
    try{
      const pending=fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':provider,'x-civicsignal-byok-key':key},
        body:JSON.stringify({provider,topic:'Test Act section 1',maxTokens:128,messages:[{role:'user',content:prompt}]})});
      if(timeout){await sent;await vi.advanceTimersByTimeAsync(30_001);}
      const response=await pending,body=await response.json() as Record<string,unknown>;
      expect(response.status).toBe(502);expect(body).toMatchObject({code:'UPSTREAM_UNAVAILABLE',error:'The request could not complete. Retry later.',retrieval:[expect.objectContaining({mode:'exact'})]});
      const phase=kind.startsWith('http')?'upstream-http':kind==='transport'?'transport':kind==='json'?'response-parse':kind==='shape'?'response-validation':timeout?'timeout':'response-body';
      const generation={provider,phase,...(kind.startsWith('http')?{upstreamStatus:Number(kind.slice(4))}:kind==='transport'||kind==='fetch-timeout'?{}:{upstreamStatus:200})};
      expect(body.generation).toEqual(generation);expect(body).not.toHaveProperty('upstreamStatus');
      expect(send).toHaveBeenCalledTimes(1);expect(await fixture.count()).toBe(0);
      for(const privateValue of [key,prompt,detail]){expect(JSON.stringify(body)).not.toContain(privateValue);expect(JSON.stringify(logs.mock.calls)).not.toContain(privateValue);}
    }finally{if(timeout)vi.useRealTimers();}
  });
  it.each(generationProviders.flatMap(provider=>['missing','empty','whitespace','key-echo'].map(kind=>({provider,kind}))))('refuses $provider $kind generation without consuming usage',async({provider,kind})=>{
    const fixture=await setup(),key='fixture-private-generation-key',logs=vi.spyOn(console,'error').mockImplementation(()=>{});
    const text=kind==='empty'?'':kind==='whitespace'?' \n\t ':key;
    const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(kind==='missing'?{}:providerText(provider,text)));
    const response=await fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':provider,'x-civicsignal-byok-key':key},
      body:JSON.stringify({provider,topic:'Test Act section 1',maxTokens:128,messages:[{role:'user',content:'fixture-private-prompt'}]})});
    const body=await response.json() as Record<string,unknown>;
    expect({status:response.status,usage:await fixture.count()}).toEqual({status:502,usage:0});
    expect(body).toMatchObject({code:'UPSTREAM_UNAVAILABLE',generation:{provider,phase:'response-validation',upstreamStatus:200}});
    expect(send).toHaveBeenCalledTimes(1);expect(JSON.stringify(body)).not.toContain(key);expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
  });
  it.each([
    ...[123,{}].flatMap(text=>[false,true].map(mixed=>({provider:'google',reply:{candidates:[{content:{parts:[...(mixed?[{text:'valid'}]:[]),{text}]}}]}}))),
    ...['anthropic','opencode-zen'].flatMap(provider=>[123,{}].map(text=>({provider,reply:{content:[{type:'text',text:'valid'},{type:'text',text}]}}))),
    {provider:'openai',reply:{choices:{0:{message:{content:'valid'}}}}},
    {provider:'google',reply:{candidates:{0:{content:{parts:[{text:'valid'}]}}}}},
  ])('rejects malformed $provider text/schema without coercion or partial acceptance: $reply',async({provider,reply})=>{
    const fixture=await setup();vi.spyOn(console,'error').mockImplementation(()=>{});
    const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(reply));
    const response=await fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':provider,'x-civicsignal-byok-key':'fixture-private-key'},
      body:JSON.stringify({provider,topic:'Test Act section 1',maxTokens:128,messages:[{role:'user',content:'Give the citation.'}]})});
    expect({status:response.status,usage:await fixture.count()}).toEqual({status:502,usage:0});
    expect(await response.json()).toMatchObject({generation:{provider,phase:'response-validation',upstreamStatus:200}});expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['google','anthropic','opencode-zen'] as const)('preserves legitimate nontext %s parts beside valid text',async provider=>{
    const fixture=await setup(),answer='A verified cited answer: https://example.test/act/1';
    const reply=provider==='google'?{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'fixture'}},{text:answer}]}}]}:
      {content:[{type:'tool_use',id:'fixture',name:'fixture',input:{}},{type:'text',text:answer}]};
    const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(reply));
    const response=await fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':provider,'x-civicsignal-byok-key':'fixture-private-key'},
      body:JSON.stringify({provider,topic:'Test Act section 1',maxTokens:128,messages:[{role:'user',content:'Give the citation.'}]})});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({answer});expect(await fixture.count()).toBe(1);expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(generationProviders)('bills one valid %s generation exactly once',async provider=>{
    const fixture=await setup(),send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(providerText(provider,'A verified cited answer: https://example.test/act/1')));
    const response=await fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':provider,'x-civicsignal-byok-key':'fixture-private-key'},
      body:JSON.stringify({provider,topic:'Test Act section 1',maxTokens:128,messages:[{role:'user',content:'Give the citation.'}]})});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({provider,answer:'A verified cited answer: https://example.test/act/1'});expect(await fixture.count()).toBe(1);expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(generationProviders)('returns empty-material %s chat as one retrieval unit with zero generation fetches', async provider => {
    const fixture = await setup(), send = vi.spyOn(globalThis, 'fetch');
    const response = await fixture.send('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': provider, 'x-civicsignal-byok-key': 'fixture-private-key' }, body: JSON.stringify({ provider,
        topic: 'Test Act section 999999', maxTokens: 128, messages: [{ role: 'user', content: 'Give the provision.' }] }) });
    expect({ status: response.status, usage: await fixture.count(), providerCalls: send.mock.calls.length }).toEqual({ status: 200, usage: 1, providerCalls: 0 });
    const models = { anthropic: 'claude-sonnet-4-5', openai: 'gpt-4.1-mini', google: 'gemini-2.5-flash', 'opencode-zen': 'claude-haiku-4-5' };
    expect(await response.json()).toMatchObject({ answer: 'The retrieved material does not contain an answer to this question.',
      provider, model: models[provider], cited: [], generation: { status: 'skipped', reason: 'no-retrieved-material' },
      retrieval: [expect.objectContaining({ mode: 'exact', decision: 'refuse' })] });
    expect(await fixture.count()).toBe(1); expect(send).not.toHaveBeenCalled();
  });
  it.each(generationProviders.flatMap(provider => ['missing', 'unretrieved', 'query', 'fragment', 'reference', 'html', 'nested', 'escaped', 'prefix', 'unicode-prefix', 'numeric-prefix', 'userinfo', 'url-label', 'wrong-path', 'suffix'].map(kind => ({ provider, kind }))))('refuses actual-200 $provider $kind links before successful usage', async ({ provider, kind }) => {
    const fixture = await setup(), key = 'fixture-private-generation-key', url = 'https://example.test/act/1';
    const answers: Record<string, string> = { missing: 'A private uncited answer.', unretrieved: `${url} https://unretrieved.invalid/private`,
      prefix: 'prefix' + url, 'unicode-prefix': 'é' + url, 'numeric-prefix': '1' + url, userinfo: url.replace('https://', 'https://user@'),
      'url-label': `[${url}](https://unretrieved.invalid)`, 'wrong-path': url + '/other', suffix: url + '.evil',
      query: url + '?altered=1', fragment: url + '#altered', reference: `[source][ref]\n[ref]: ${url}`,
      html: `<a href="${url}">source</a>`, nested: `[source](${url}(altered))`, escaped: `[source](${url.replace('/act/', '/act/\\')})` };
    const answer = answers[kind]!, logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(providerText(provider, answer), { status: 200 }));
    const response = await fixture.send('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': provider, 'x-civicsignal-byok-key': key }, body: JSON.stringify({ provider,
        topic: 'Test Act section 1', maxTokens: 128, messages: [{ role: 'user', content: 'fixture-private-prompt' }] }) });
    const body = await response.json() as Record<string, unknown>;
    expect({ status: response.status, usage: await fixture.count() }).toEqual({ status: 502, usage: 0 });
    expect(body).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', generation: { provider, phase: 'response-validation', upstreamStatus: 200 } });
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![1]?.redirect).toBe('manual');
    for (const value of [answer, key, 'fixture-private-prompt']) {
      expect(JSON.stringify(body)).not.toContain(value); expect(JSON.stringify(logs.mock.calls)).not.toContain(value);
    }
  });
  it.each(generationProviders.flatMap(provider => ['> ', '- ', '> 2) > - '].flatMap(prefix =>
    ['//unretrieved.invalid/private-path', '/private-relative-path', 'https://unretrieved.invalid/private-absolute'].map(target => ({ provider, prefix, target })))))('refuses actual-200 $provider container reference $prefix $target before usage', async ({ provider, prefix, target }) => {
    const fixture = await setup(), key = 'fixture-private-generation-key', url = 'https://example.test/act/1';
    const answer = `${prefix}[r]: ${target}\n\n[r]\n\nSee <${url}>`;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(providerText(provider, answer), { status: 200 }));
    const response = await fixture.send('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': provider, 'x-civicsignal-byok-key': key }, body: JSON.stringify({ provider,
        topic: 'Test Act section 1', maxTokens: 128, messages: [{ role: 'user', content: 'fixture-private-prompt' }] }) });
    const body = await response.json() as Record<string, unknown>;
    expect({ status: response.status, usage: await fixture.count() }).toEqual({ status: 502, usage: 0 });
    expect(body).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', generation: { provider, phase: 'response-validation', upstreamStatus: 200 } });
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![1]?.redirect).toBe('manual');
    for (const value of [answer, target, key, 'fixture-private-prompt']) {
      expect(JSON.stringify(body)).not.toContain(value); expect(JSON.stringify(logs.mock.calls)).not.toContain(value);
    }
  });
  it.each(generationProviders.flatMap(provider => ['bare', 'markdown', 'autolink'].map(form => ({ provider, form }))))('bills one exact retrieved $provider $form citation exactly once', async ({ provider, form }) => {
    const fixture = await setup(), url = 'https://example.test/act/1';
    const answer = form === 'bare' ? `A provision: ${url}` : form === 'markdown' ? `A [provision](${url}).` : `A provision: <${url}>.`;
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(providerText(provider, answer)));
    const response = await fixture.send('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-civicsignal-byok-provider': provider, 'x-civicsignal-byok-key': 'fixture-private-key' }, body: JSON.stringify({ provider,
        topic: 'Test Act section 1', maxTokens: 128, messages: [{ role: 'user', content: 'Give the citation.' }] }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ provider, answer, cited: [expect.objectContaining({ citationUrl: url })] });
    expect(await fixture.count()).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps a failed retrieval distinct from generation and never calls or bills a model',async()=>{
    const fixture=await setup(),send=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected external call'));
    const logs=vi.spyOn(console,'error').mockImplementation(()=>{});
    fixture.env.VECTORIZE={async query(){return {matches:[]};}};
    fixture.env.ENCODER_TOKEN='fixture-only';fixture.env.ENCODER_SERVICE={async fetch(){throw new Error('fixture-private-encoder-detail');}};
    const response=await fixture.send('/api/chat',{method:'POST',headers:{'content-type':'application/json','x-civicsignal-byok-provider':'opencode-zen','x-civicsignal-byok-key':'fixture-private-key'},
      body:JSON.stringify({provider:'opencode-zen',topic:'Employment rights without an exact citation',messages:[{role:'user',content:'fixture-private-prompt'}]})});
    const body=await response.json() as Record<string,unknown>;
    expect(response.status).toBe(502);expect(body).not.toHaveProperty('generation');
    expect(body.retrieval).toEqual([expect.objectContaining({decision:'error',providers:expect.objectContaining({encoder:'error'})})]);
    expect(send).not.toHaveBeenCalled();expect(await fixture.count()).toBe(0);expect(JSON.stringify(body)).not.toContain('fixture-private-encoder-detail');expect(JSON.stringify(logs.mock.calls)).not.toContain('fixture-private-encoder-detail');
  });
  it('rejects unauthenticated HTTP and MCP before corpus retrieval', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/brief?topic=leave', {}, false)).status).toBe(401);
    const response = await fixture.send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, false);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(await fixture.count()).toBe(0);
  });
  it('does not bill MCP discovery or malformed tool arguments', async () => {
    const fixture = await setup();
    const listed = await fixture.rpc('tools/list');
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('cite_provision');
    const invalid = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act' } });
    expect(await invalid.text()).toMatch(/error|isError/);
    expect(await fixture.count()).toBe(0);
  });
  it('bills one successful MCP retrieval exactly once and preserves counter names', async () => {
    const fixture = await setup(1);
    const first = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
    const refused = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(await refused.text()).toContain('Monthly usage fuse exceeded');
    expect(await fixture.count()).toBe(1);
    expect(new Set(fixture.names)).toEqual(new Set(['customer:customer_kept']));
  });
  it('does not bill failed MCP database retrieval', async () => {
    const fixture = await setup();
    fixture.sqlite.exec('DROP TABLE statute_sections');
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(await response.text()).toMatch(/error|isError/);
    expect(await fixture.count()).toBe(0);
  });
  it('recovers a lost ledger acknowledgement without a second unit', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
  });
  it('reports an uncertain committed operation when its acknowledgement cannot be recovered', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    fixture.transport.partitionAfterCommit = true;
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'USAGE_UNAVAILABLE', uncertain: true });
    expect(body.operationId).toEqual(expect.any(String));
    // A permanent partition cannot make HTTP delivery atomic with the ledger.
    // The committed receipt remains available for operator reconciliation.
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(1);
  });
  it('preserves uncertain usage receipts in MCP tool errors', async () => {
    const fixture = await setup();
    fixture.transport.loseNextPost = true;
    fixture.transport.partitionAfterCommit = true;
    const response = await fixture.rpc('tools/call', { name: 'cite_provision', arguments: { act: 'Test Act', section: '1' } });
    const body = await response.text();
    expect(body).toContain('USAGE_UNAVAILABLE');
    expect(body).not.toContain('FUSE_EXCEEDED');
    expect(body).toMatch(/"uncertain"\s*:\s*true/);
    expect(body).toContain('operationId');
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(1);
  });
  it.each([false, true])('refuses a ledger outage for unlimited or soft plans (soft=%s)', async (soft) => {
    const fixture = await setup();
    fixture.sqlite.prepare("UPDATE civic_workspace_billing SET plan='enterprise',fuse_limit=?,fuse_soft_warn=?").run(soft ? 1 : 0, soft ? 1 : 0);
    fixture.transport.unavailable = true;
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('USAGE_UNAVAILABLE');
    fixture.transport.unavailable = false;
    expect(await fixture.count()).toBe(0);
  });
  it('validates HTTP method, body, and vector before any unit is consumed', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/match')).status).toBe(405);
    expect((await fixture.send('/api/match', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fixture.send('/api/match', { method: 'POST', body: JSON.stringify({ vector: [1] }) })).status).toBe(400);
    expect(await fixture.count()).toBe(0);
  });
  it('meters successful HTTP vector matches and never bills an upstream failure', async () => {
    const fixture = await setup();
    fixture.env.VECTORIZE = { async query() { return { matches: [{ id: 'acts-en-one', score: 0.9 }] }; } };
    const body = JSON.stringify({ vector: Array.from({ length: 768 }, (_, at) => at ? 0 : 1) });
    const ok = await fixture.send('/api/match', { method: 'POST', body });
    expect(ok.status).toBe(200);
    expect(await fixture.count()).toBe(1);
    fixture.env.VECTORIZE.query = async () => { throw new Error('private upstream details'); };
    const failed = await fixture.send('/api/match', { method: 'POST', body });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('private upstream details');
    expect(await fixture.count()).toBe(1);
  });
  it('serves exact HTTP citations without an encoder and rejects unsupported coverage without billing', async () => {
    const fixture = await setup();
    const response = await fixture.send('/api/statutes?act=Test+Act&section=1&language=en');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A verified test provision.');
    expect(await fixture.count()).toBe(1);
    for (const path of ['/api/news?topic=leave', '/api/debates?topic=leave', '/api/statutes?topic=leave&jurisdiction=ON',
      '/api/brief?topic=leave&since=2020-01-01']) {
      expect((await fixture.send(path)).status).toBe(501);
    }
    expect((await fixture.send('/api/statutes?topic=leave&limit=NaN')).status).toBe(400);
    expect(await fixture.count()).toBe(1);
  });
  it.each((['http', 'mcp'] as const).flatMap(transport =>
    (['missing-source', 'corpus-mismatch'] as const).map(fault => ({ transport, fault }))))(
    'rejects $fault before successful $transport brief usage', async ({ transport, fault }) => {
      const fixture = await setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (fault === 'missing-source') fixture.sqlite.exec("UPDATE statute_sections SET source_url = ''");
      else fixture.sqlite.exec("UPDATE statute_sections SET corpus_id = 'unknown-corpus'");

      if (transport === 'http') {
        const response = await fixture.send('/api/brief?act=Test+Act&section=1&language=en');
        expect(response.status, `Usage after malformed brief: ${await fixture.count()}`).toBe(502);
        expect(await response.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      } else {
        fixture.env.VECTORIZE = { async query() { return { matches: [{ id: 'acts-en-one', score: 0.9 }] }; } };
        fixture.env.ENCODER_TOKEN = 'fixture-only';
        fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array(768).fill(0.1)] }); } };
        const response = await fixture.rpc('tools/call', { name: 'brief_topic', arguments: { topic: 'housing', language: 'en' } });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body, `Usage after malformed brief: ${await fixture.count()}`).toMatch(/"isError"\s*:\s*true/);
        expect(body).toContain('UPSTREAM_UNAVAILABLE');
      }
      expect(await fixture.count()).toBe(0);
    },
  );
  it('serves a bounded change feed and refuses an unpublished corpus without billing', async () => {
    const fixture = await setup();
    expect((await fixture.send('/api/changes?limit=1')).status).toBe(200);
    expect(await fixture.count()).toBe(1);
    fixture.sqlite.exec('DELETE FROM corpus_state');
    expect((await fixture.send('/api/changes')).status).toBe(503);
    expect((await fixture.send('/api/brief?act=Test+Act&section=1')).status).toBe(503);
    expect(await fixture.count()).toBe(1);
  });
  it('serves restored compact metadata through strict R2 and retains binding rollback and usage history', async () => {
    const fixture = await setup();
    const original = fixture.sqlite.prepare('SELECT * FROM statute_sections').get()!;
    const text = String(original.text);
    original.text_hash = rowFingerprintWithText(original, text);
    fixture.sqlite.prepare('UPDATE statute_sections SET text_hash=? WHERE id=?').run(original.text_hash, original.id);
    const fresh = testD1({ schema: COMPACT_CORPUS_SCHEMA });
    closed.push(fresh.close);
    // Copy protected identity and publication rows. The corpus restore cannot
    // reset a workspace or the existing external usage namespace.
    for (const table of ['workspace', 'civic_workspace_billing', 'workspace_api_key', 'corpus_state', 'corpus_mutations', 'corpus_publication_guard']) {
      const ddl = fixture.sqlite.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)?.sql;
      fresh.sqlite.exec(String(ddl));
      for (const row of fixture.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        fresh.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
          .run(...Object.values(row));
      }
    }
    const storage = memoryTextBucket();
    const artifact = await prepareProvisionText({ rowId: String(original.id), corpusId: 'statutes-canada',
      rowFingerprint: String(original.text_hash), text });
    await writeImmutableProvisionText(storage.bucket, artifact);
    const pageData = { page: 1, fromAfter: '', through: String(original.id), rows: 1,
      statements: [{ query: INSERT_COMPACT_STATUTE_SQL, params: COMPACT_STATUTE_COLUMNS.map((column) => column === 'text' ? '' : original[column] ?? null) },
        { query: UPSERT_TEXT_REFERENCE_SQL, params: textReferenceBindings(artifact.reference) }] };
    await applyCompactRestorePage(fresh.db, { ...pageData, sha256: await compactPageDigest(pageData) },
      { bundleSha256: 'b'.repeat(64), revision: 'test-revision:legacy' });
    expect(fresh.sqlite.prepare('SELECT sum(length(text)) AS bytes FROM statute_sections').get()?.bytes).toBe(0);
    fixture.env.CIVIC_DB = fresh.db;
    fixture.env.CORPUS_TEXT_MODE = 'r2';
    fixture.env.CORPORA = storage.bucket as unknown as R2Bucket;
    const exact = await fixture.send('/api/statutes?act=Test+Act&section=1&language=en');
    expect(exact.status).toBe(200);
    expect(await exact.text()).toContain(text);
    fixture.env.VECTORIZE = { async query() { return { matches: [{ id: String(original.id), score: 0.99 }] }; } };
    fixture.env.ENCODER_TOKEN = 'fixture-only';
    fixture.env.ENCODER_SERVICE = { async fetch() { return Response.json({ vectors: [Array.from({ length: 768 }, (_, at) => at ? 0 : 1)] }); } };
    const semantic = await fixture.send('/api/statutes?topic=test+provision&language=en');
    expect(semantic.status).toBe(200);
    expect(await semantic.text()).toContain(text);
    expect(await fixture.count()).toBe(2);
    storage.objects.clear();
    expect((await fixture.send('/api/statutes?act=Test+Act&section=1')).status).toBe(502);
    expect(await fixture.count()).toBe(2);
    fixture.env.CIVIC_DB = fixture.db;
    fixture.env.CORPUS_TEXT_MODE = 'd1';
    delete fixture.env.CORPORA;
    const rollback = await fixture.send('/api/statutes?act=Test+Act&section=1');
    expect(rollback.status).toBe(200);
    expect(await rollback.text()).toContain(text);
    expect(await fixture.count()).toBe(3);
  });
});

describe('current parliamentary catalogues through the Worker', () => {
  it('serves public documentation and requires an authorized workspace for each source', async () => {
    const fixture = await setup(20);
    const spec = await fixture.send('/api/parliament/openapi.json', {}, false);
    expect(spec.status).toBe(200);
    expect(Object.keys((await spec.json() as { paths: object }).paths)).toHaveLength(29);
    const { materializeParliament } = await import('../scripts/materialize-parliament');
    for (const collection of ['bills', 'house-votes', 'senate-votes'] as const) {
      const base = '/api/parliament/' + collection;
      const page = base + '?language=fr&query=reglement&limit=1';
      const key = collection === 'bills' ? 's-2' : '2';
      const url = { bills: 'https://www.parl.ca', 'house-votes': 'https://www.ourcommons.ca', 'senate-votes': 'https://sencanada.ca' }[collection];
      fixture.env.PARLIAMENT_CATALOGUE_PREVIEW = undefined;
      expect((await fixture.send(page, {}, false)).status).toBe(401);
      expect((await fixture.send(page)).status).toBe(501);
      fixture.env.PARLIAMENT_CATALOGUE_PREVIEW = 'on';
      const records = [key, key.replace('2', '3')].flatMap(number => ['en', 'fr'].map(language => ({
        key: number, language, title: language === 'fr' ? 'Un règlement' : 'A regulation', summary: 'Status',
        details: collection === 'bills' ? { kind: 'bill', legisInfoId: 22, status: 'Status' }
          : collection === 'senate-votes' ? { kind: 'senate-vote', result: 'Adoptée', yeas: 48, nays: 13, abstentions: 0 }
          : { kind: 'house-vote', result: 'Adoptée', yeas: 32, nays: 6, paired: 0 },
        date: '2026-11-23', url: url + '/' + language + '/' + number,
      })));
      const receipt = materializeParliament(fixture.sqlite, { collection, records, session: '45-1', observedAt: '2026-11-23T15:00:00Z' });
      expect(await (await fixture.send(base + '/coverage')).json()).toMatchObject({ recordsPerLanguage: 2, latestRecordDate: '2026-11-23', basis: 'publisher-inventory', revision: receipt.revision });
      expect(await (await fixture.send(page)).json()).toMatchObject({ items: [{ key, title: 'Un règlement' }], nextOffset: 1 });
      expect(await (await fixture.send(page + '&offset=1&revision=' + receipt.revision)).json()).toMatchObject({ nextOffset: null, items: [{ key: key.replace('2', '3') }] });
      expect((await fixture.send(page + '&revision=' + '0'.repeat(64))).status).toBe(400);
      expect((await fixture.send(page + '&language=en')).status).toBe(400);
      expect(await (await fixture.send(base + '/' + key + '?language=en')).json()).toMatchObject({ item: { title: 'A regulation' } });
      expect((await fixture.send(base + '/coverage?session=44-1')).status).toBe(501);
    }
    expect(await publishedEditions(fixture, 'parliament')).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'bills/45-1' })]));
    expect(await fixture.count()).toBe(12);
  });

  it.each(['house', 'senate'])('reads cited %s decisions and member histories across a session', async chamber => {
    const fixture = await setup(24);
    const { materializeParliament } = await import('../scripts/materialize-parliament');
    const host = chamber === 'house' ? 'https://www.ourcommons.ca' : 'https://sencanada.ca';
    const observedAt = '2026-11-23T20:00:00Z';
    fixture.env.PARLIAMENT_CATALOGUE_PREVIEW = 'on';
    for (const child of ['passages', 'members']) {
      const journal = child === 'passages';
      const collection = chamber + (journal ? '-journals' : '-roll-calls');
      const base = '/api/parliament/' + collection;
      const secondKey = journal && chamber === 'house' ? '1A' : !journal && chamber === 'senate' ? 'j16-3' : '2';
      const records = ['1', secondKey].flatMap(key => ['en', 'fr'].map(language => {
        const url = host + '/' + language + '/' + key;
        const text = language === 'fr' ? 'Motion adoptée' : 'Motion agreed to';
        const member = { name: 'Renée Example', position: 'yea', paired: chamber === 'house', memberId: '15', affiliation: null,
          province: null, constituency: null, url: null };
        const unavailable = key === secondKey && language === 'fr';
        const details = journal ? { kind: chamber + '-journal', status: unavailable ? 'unavailable' : 'published',
          passages: unavailable ? [] : [{ text, url, links: [{ label: 'Motion', url }] }] }
          : { kind: chamber + '-roll-call', members: [member], ...(key.startsWith('j') ? { journalIssue: '16', journalVoteOrdinal: 3 } : {}) };
        return { key, language, url, title: 'Session', summary: '', date: '2026-11-23', details };
      }));
      const receipt = materializeParliament(fixture.sqlite, { collection, records, session: '45-1', observedAt });
      const scoped = base + '/1/' + child + '?language=fr';
      expect((await fixture.send(scoped, {}, false)).status).toBe(401);
      expect(await (await fixture.send(scoped)).json()).toMatchObject({ items: [{ edition: { key: '1', language: 'fr' },
        ordinal: 1, ...(journal ? { passage: { text: 'Motion adoptée' } } : { member: { memberId: '15', position: 'yea' } }) }] });
      const session = base + '/' + child + '?language=en&limit=1&query=' + (journal ? 'agreed' : 'renee&memberId=15&position=yea');
      expect(await (await fixture.send(session)).json()).toMatchObject({ nextOffset: 1, items: [{ edition: { key: '1' } }] });
      expect(await (await fixture.send(session + '&offset=1&revision=' + receipt.revision)).json()).toMatchObject({
        nextOffset: null, items: [{ edition: { key: secondKey } }] });
      expect((await fixture.send(session + '&revision=' + 'a'.repeat(64))).status).toBe(400);
      if (journal) {
        expect(await (await fixture.send(base + '/coverage')).json()).toMatchObject({ unavailableEditions: { en: 0, fr: 1 } });
        expect(await (await fixture.send(base + '/' + secondKey + '?language=fr')).json()).toMatchObject({ item: { details: { status: 'unavailable', passageCount: 0 } } });
        expect((await fixture.send(scoped + '&position=yea')).status).toBe(400);
      } else {
        if (chamber === 'senate') {
          expect(await (await fixture.send(base + '/coverage')).json()).toMatchObject({ journalOnlyRecordsPerLanguage: 1 });
          expect(await (await fixture.send(base + '/j16-3?language=en')).json()).toMatchObject({
            item: { details: { journalIssue: '16', journalVoteOrdinal: 3 } },
          });
        }
        const paired = await fixture.send(scoped + '&position=paired');
        expect(await paired.json()).toMatchObject({ items: chamber === 'house'
          ? [{ member: { name: 'Renée Example', position: 'yea', paired: true } }] : [] });
        expect(await (await fixture.send(scoped + '&position=nay')).json()).toMatchObject({ items: [] });
        expect(await (await fixture.send(base + '/1?language=fr')).json()).toMatchObject({ item: { details: { memberCount: 1 } } });
      }
    }
  });

  const cataloguesPath = process.env.CIVICSIGNAL_PARLIAMENT_SQLITE;
  it.skipIf(!cataloguesPath)('serves the materialized official inventories in both languages', async () => {
    const fixture = await setup(20);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    if (!cataloguesPath) throw new Error('Missing materialized parliamentary database.');
    const sqlite = new DatabaseSync(cataloguesPath, { readOnly: true });
    closed.push(() => sqlite.close());
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(sqlite);
    fixture.env.PARLIAMENT_CATALOGUE_PREVIEW = 'on';
    for (const collection of ['bills', 'house-votes', 'senate-votes']) {
      const path = '/api/parliament/' + collection;
      for (const language of ['en', 'fr']) {
        const res = await fixture.send(path + '?limit=1&language=' + language);
        expect(res.status).toBe(200);
        const { items, coverage } = await res.json() as { items: { key: string; url: string }[]; coverage: { recordsPerLanguage: number } };
        expect(coverage.recordsPerLanguage).toBeGreaterThan(0);
        expect(await (await fixture.send(path + '/' + items[0].key + '?language=' + language)).json())
          .toMatchObject({ item: { url: items[0].url, language } });
      }
    }
  });
  const chambersPath = process.env.CIVICSIGNAL_CHAMBERS_SQLITE;
  it.skipIf(!chambersPath)('retrieves a cited decision and an individual vote from each official chamber edition', async () => {
    if (!chambersPath) throw new Error('Missing published chamber database.');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const sqlite = new DatabaseSync(chambersPath, { readOnly: true });
    closed.push(() => sqlite.close());
    const fixture = await setup(32);
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(sqlite);
    fixture.env.PARLIAMENT_CATALOGUE_PREVIEW = 'on';
    for (const chamber of ['house', 'senate']) {
      for (const language of ['en', 'fr']) {
        for (const [collection, child] of [['journals', 'passages'], ['roll-calls', 'members']]) {
          const base = '/api/parliament/' + chamber + '-' + collection;
          const qs = '?limit=1&language=' + language;
          const filter = child === 'passages' ? '&query=motion' : '&position=yea';
          const page = await fixture.send(base + '/' + child + qs + filter);
          expect(page.status).toBe(200);
          const { items } = await page.json() as { items: { edition: { key: string; url: string }; ordinal: number }[] };
          expect(items[0].edition.url).toMatch(/^https:/);
          expect(await (await fixture.send(base + '/' + items[0].edition.key + '/' + child + qs + filter)).json())
            .toMatchObject({ items: [items[0]] });
          expect(await (await fixture.send(base + '/' + items[0].edition.key + '?language=' + language)).json())
            .toMatchObject({ item: { url: items[0].edition.url, language } });
        }
      }
    }
    const house = await fixture.send('/api/parliament/house-journals/170/passages?language=fr&query=198');
    expect(await house.json()).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ passage: expect.objectContaining({ links: expect.arrayContaining([
        expect.objectContaining({ url: 'https://www.ourcommons.ca/deputes/fr/votes/45/1/198' }),
      ]) }) }),
    ]) });
    const position = await fixture.send('/api/parliament/house-roll-calls/198/members?language=en&memberId=110791');
    expect(await position.json()).toMatchObject({ items: [{ member: { name: 'Buckley Belanger', paired: true, position: 'yea' } }] });
    const senate = await fixture.send('/api/parliament/senate-journals/102/passages?language=en&query=adopted%20on%20division');
    expect(await senate.json()).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ edition: expect.objectContaining({ key: '102', date: '2026-11-17' }) }),
    ]) });
    for (const language of ['en', 'fr']) {
      const path = '/api/parliament/senate-roll-calls/j16-3';
      const vote = await fixture.send(path + '?language=' + language);
      expect(await vote.json()).toMatchObject({
        coverage: { journalOnlyRecordsPerLanguage: 1 },
        item: { details: { journalIssue: '16', journalVoteOrdinal: 3, memberCount: 80, tally: { yeas: 6, nays: 67, abstentions: 7 } } },
      });
      const yeas = await fixture.send(path + '/members?position=yea&language=' + language);
      const body = await yeas.json() as { items: { member: { name: string } }[] };
      expect(body.items).toHaveLength(6);
      expect(body.items.map(hit => hit.member.name)).toContain('Pate');
    }
  });
});

describe('GEDS directory through the Worker', () => {
  const gedsFixturePath = process.env.CIVICSIGNAL_GEDS_FIXTURE_SQLITE;
  const gedsExportPath = process.env.CIVICSIGNAL_GEDS_SQLITE;
  it.skipIf(!gedsFixturePath)('serves the locally imported directory transfer fixture', async () => {
    if (!gedsFixturePath) throw new Error('Missing local fixture database.');
    const fixture = await setup(5);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(gedsFixturePath, { readOnly: true });
    closed.push(() => db.close());
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(db);
    fixture.env.GEDS_PREVIEW = 'on';
    for (const [lang, name] of [['en', 'Programs Branch'], ['fr', 'Direction des programmes']]) {
      const response = await fixture.send('/api/organizations?exact=true&lang=' + lang + '&q=' + encodeURIComponent(name));
      expect(response.status).toBe(200);
      const data = await response.json() as { items: { id: string; name: string }[] };
      expect(data.items).toHaveLength(1);
      const members = await fixture.send('/api/organizations/' + data.items[0].id + '/people?lang=' + lang);
      expect(await members.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: 'Jordan Lee' })]) });
    }
  });
  it.skipIf(!gedsExportPath)('resolves one real unit from both published names and cites the imported contact', async () => {
    if (!gedsExportPath) throw new Error('Missing the imported GEDS export.');
    const fixture = await setup(6);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(gedsExportPath, { readOnly: true });
    closed.push(() => db.close());
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(db);
    fixture.env.GEDS_PREVIEW = 'on';

    const english = await fixture.send('/api/organizations?exact=true&lang=en&q=' + encodeURIComponent('Privy Council Office'));
    expect(english.status).toBe(200);
    const en = await english.json() as { items: { id: string; nameEn: string; nameFr: string }[] };
    const unit = en.items[0];
    if (!unit) throw new Error('The imported export did not resolve Privy Council Office.');
    expect(unit.nameEn).toBe('Privy Council Office');
    const french = await fixture.send('/api/organizations?exact=true&lang=fr&q=' + encodeURIComponent(unit.nameFr));
    expect(french.status).toBe(200);
    expect((await french.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(unit.id);

    const members = await fixture.send(`/api/organizations/${unit.id}/people?descendants=true&limit=5&lang=en`);
    expect(members.status).toBe(200);
    type Member = { id: string; name: string; contact: { value: string; citation: {
      datasetId: string; resourceUrl: string; text: string; snapshotId: string } } | null };
    const page = await members.json() as { items: Member[]; page: { total: number } };
    expect(page.page.total).toBeGreaterThan(0);
    const cited = page.items.find((person) => person.contact);
    if (!cited?.contact) throw new Error('No member of the real unit published a contact.');
    expect(cited.contact.citation.datasetId).toBe('8ec4a9df-b76b-4a67-8f93-cdbc2e040098');
    expect(cited.contact.citation.resourceUrl).toContain('gedsOpenData.zip');
    expect(cited.contact.citation.snapshotId).toBeTruthy();
    expect(cited.contact.citation.text).toContain(cited.contact.value);

    const historical = await fixture.send('/api/organizations?q=Privy&asOf=2020-01-01&lang=en');
    expect(historical.status).toBe(404);
    expect((await historical.json() as { code: string }).code).toBe('NO_SNAPSHOT_AS_OF');
    expect(await fixture.count()).toBe(3);
  });
  it('serves discovery and meters an authenticated French organization lookup', async () => {
    const fixture = await setup(4);
    const path = '/api/organizations?lang=fr&q=gestion';
    const doc = await fixture.send('/api/geds/openapi.json', {}, false);
    expect(doc.status).toBe(200);
    expect(await doc.json()).toMatchObject({ paths: { '/api/people': { get: {} } } });
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path)).status).toBe(501);
    const { gedsDatabase, refreshFixture } = await import('./helpers/geds');
    const directory = gedsDatabase();
    closed.push(() => directory.raw.close());
    await refreshFixture(directory.db, directory.archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
    fixture.env.AUTH_DB = fixture.db;
    fixture.env.CIVIC_DB = localD1(directory.raw);
    fixture.env.GEDS_PREVIEW = 'on';
    expect(await publishedEditions(fixture, 'geds')).toHaveLength(2);
    const found = await fixture.send(path);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ language: 'fr', items: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) });
    expect(await fixture.count()).toBe(1);
  });
});

describe('committee calls through the Worker against the acquired corpus', () => {
  const committeePath = process.env.CIVICSIGNAL_COMMITTEES_D1;
  it.skipIf(!committeePath)('computes the open state, answers a dated zero, and follows a real call to its study', async () => {
    if (!committeePath) throw new Error('The committee corpus is required.');
    const fixture = await setup(6);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
    fixture.env.AUTH_DB = fixture.db;
    const db = new DatabaseSync(committeePath, { readOnly: true });
    closed.push(() => db.close());
    fixture.env.COMMITTEE_DB = localD1(db);
    fixture.env.COMMITTEE_CORPUS_PREVIEW = 'on';

    const list = await fixture.send('/api/committees/45-1/calls?language=en');
    expect(list.status).toBe(200);
    const english = CommitteeCallsResponseSchema.parse(await list.json());
    expect(english.items.length).toBeGreaterThanOrEqual(15);
    expect(english.items.every(item => item.committee.id.startsWith('house-'))).toBe(true);
    expect(english.items.some(item => item.status === 'open' && item.statusBasis === 'deadline')).toBe(true);
    const health = english.items.find(item => item.id === 'house-hesa-call-13632808');
    if (!health) throw new Error('The Health committee call is missing.');
    expect(health.study?.title).toBe('Diagnostic Imaging Capacity');
    expect(health.instructionUrl).toMatch(/^https:\/\/www\.ourcommons\.ca\/committee-participation\//u);

    const zero = CommitteeCallsResponseSchema.parse(await (await fixture.send(
      '/api/committees/45-1/calls?language=en&query=apprenticeship')).json());
    expect(zero.items).toEqual([]);
    expect(zero.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(zero.hasMore).toBe(false);

    const detail = CommitteeCallDetailResponseSchema.parse(await (await fixture.send(
      `/api/committees/45-1/calls/${health.id}?language=en`)).json());
    expect(detail.state).toBe('found');
    if (detail.state === 'found') {
      expect(detail.item.instructions).not.toBeNull();
      expect(detail.related.submissions).toBeGreaterThan(0);
    }
    const french = CommitteeCallDetailResponseSchema.parse(await (await fixture.send(
      `/api/committees/45-1/calls/${health.id}?language=fr`)).json());
    expect(french.state).toBe('found');
    expect(await fixture.count()).toBe(4);
  });
});

describe('funding programme API through the Worker', () => {
  it('publishes public discovery, enforces preview and workspace auth, and meters cited bilingual requests', async () => {
    const fixture = await setup(4);
    const { materializeFunding } = await import('../scripts/materialize-funding');
    const indexes = { en: 'https://nserc.canada.ca/en/cci', fr: 'https://nserc.canada.ca/fr/cci' };
    const edition = (id: string, language: 'en' | 'fr') => ({
      id, language,
      title: id === 'nserc-alpha' ? language === 'fr' ? 'Subvention de renouvellement' : 'Renewal Grant'
        : language === 'fr' ? 'Bourse de recherche' : 'Research Fellowship',
      url: `https://nserc.canada.ca/${language}/${id}`,
      status: id === 'nserc-alpha' ? 'open' : 'closed',
      statusText: id === 'nserc-alpha' ? language === 'fr' ? 'Les demandes sont ouvertes.' : 'Applications are open.' : null,
      availability: 'published',
      sections: [{ field: 'eligibility', heading: language === 'fr' ? 'Admissibilité' : 'Eligibility',
        text: id === 'nserc-alpha'
          ? language === 'fr' ? 'Le programme finance le renouvellement des laboratoires canadiens.'
            : 'The programme funds renewal of Canadian research laboratories.'
          : language === 'fr' ? 'Le programme soutient les chercheurs canadiens.' : 'The programme supports Canadian researchers.',
        url: `https://nserc.canada.ca/${language}/${id}#eligibility` }],
    });
    const published = materializeFunding(fixture.sqlite, { source: 'nserc', observedAt: '2026-11-23T18:00:00Z', indexes,
      records: ['nserc-alpha', 'nserc-beta'].flatMap(id => (['en', 'fr'] as const).map(language => edition(id, language))), gaps: [] });

    const discovery = await fixture.send('/.well-known/civicsignal.json', {}, false);
    expect(discovery.status).toBe(200);
    const specResponse = await fixture.send('/api/funding-programs/openapi.json', {}, false);
    expect(specResponse.status).toBe(200);
    const spec = await specResponse.json() as { paths: Record<string, { get?: { security?: unknown[] } }> };
    expect(spec.paths).toHaveProperty('/api/funding-programs');
    expect(spec.paths['/api/funding-programs/openapi.json']?.get?.security).toEqual([]);

    const path = '/api/funding-programs?source=nserc&language=fr&query=renouvellement&limit=1';
    expect((await fixture.send(path, {}, false)).status).toBe(401);
    expect((await fixture.send(path, { headers: { Authorization: 'Bearer invalid-key' } }, false)).status).toBe(401);
    expect((await fixture.send(path)).status).toBe(501);
    expect(await fixture.count()).toBe(0);

    fixture.env.FUNDING_PREVIEW = 'on';
    expect((await fixture.send('/api/funding-programs?source=nserc&language=fr&limit=not-a-number')).status).toBe(400);
    expect(await fixture.count()).toBe(0);
    const result = await fixture.send(path);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ source: 'nserc', revision: published.revision,
      items: [{ id: 'nserc-alpha', language: 'fr', revision: expect.any(String),
        match: { section: 'eligibility', url: 'https://nserc.canada.ca/fr/nserc-alpha#eligibility',
          snippet: expect.stringContaining('renouvellement') } }],
    });
    const lookup = await fixture.send('/api/funding-programs/nserc-alpha?language=fr');
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ item: { id: 'nserc-alpha', title: 'Subvention de renouvellement', sections: [{ field: 'eligibility' }] } });
    const history = await fixture.send('/api/funding-programs/nserc-alpha/versions?language=fr');
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ revision: published.revision, items: [{ event: 'added', edition: { language: 'fr' } }] });
    const coverage = await fixture.send('/api/funding-programs/coverage?source=nserc');
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toMatchObject({ source: 'nserc', revision: published.revision,
      records: 4, recordsPerLanguage: { en: { total: 2, searchable: 2, metadataOnly: 0 }, fr: { total: 2, searchable: 2, metadataOnly: 0 } } });
    expect(await fixture.count()).toBe(4);
    expect((await fixture.send(path)).status).toBe(429);
    expect(await fixture.count()).toBe(4);
  });
});
