import { parseCorpusTextMode } from '../corpora/text-store';
import { FundingSource } from '../corpora/funding';
import { hansardLanguagePrefix, hansardPolicy } from '../corpora/hansard';
import { ParliamentCollection, ParliamentSession } from '../corpora/parliament-catalogue';
import { GEDS_OPENAPI_PATH } from '../geds/openapi';
import type { CorpusAvailability } from '../corpora/types';
import type { Env } from '../types';
import { BILL_OPENAPI_PATH, readBillBrief } from './bill-trace';
import { COMMITTEE_OPENAPI_PATH, COMMITTEE_STUDY_BRIEF_PATH } from './committee-study';
import { FUNDING_OPENAPI_PATH } from './funding';
import { DEPARTMENTAL_OPENAPI_PATH } from './departmental-publications';
import { CONSULTATIONS_OPENAPI_PATH } from './consultations';
import { GAZETTE_OPENAPI_PATH } from './gazette-contract';
import { HANSARD_OPENAPI_PATH, HANSARD_PATHS } from './hansard-contract';
import { PARLIAMENT_OPENAPI_PATH } from './parliament-catalogue';
import { WRITTEN_QUESTIONS_OPENAPI_PATH } from './written-questions-contract';
import { SOURCE_FEED_PATHS } from './source-feed-contract';
import freshwaterStudy from '../../preview/committees/envi-freshwater.json';

export interface DiscoveryEdition {
  scope: string;
  language: 'en' | 'fr';
  editionType?: 'extra';
  observedAt?: string;
  latestRecordDate?: string;
  publishedAt?: string;
  coverageThrough?: string;
  revision?: string;
  request: string;
}
export interface DiscoverySource {
  id: string;
  name: string;
  status: 'available' | 'disabled' | 'empty' | 'unavailable';
  question: string;
  openapi?: string;
  editions: DiscoveryEdition[];
}
type Definition = Pick<DiscoverySource, 'id' | 'name' | 'question' | 'openapi'>;
type EditionKey = Pick<DiscoveryEdition, 'scope' | 'language'>;
type Result = EditionKey & { editionType?: string | null } & {
  [Field in 'observedAt' | 'latestRecordDate' | 'publishedAt' | 'coverageThrough' | 'revision']?: string | null;
};
const languages = "WITH languages(language) AS (VALUES ('en'),('fr')) ";
const topic = (language: string) => language === 'fr' ? 'apprentissage' : 'apprenticeship';
const requestPath = (path: string, params: Record<string, string>) => path + '?' + new URLSearchParams(params);
const definition = (id: string, name: string, question: string, openapi: string): Definition => ({ id, name, question, openapi });

interface DiscoveryContext { env: Env; accessReady: boolean }

export async function discoveryContext(env: Env): Promise<DiscoveryContext> {
  const db = env.AUTH_DB ?? env.CIVIC_DB;
  if (!db || !env.API_KEY_USAGE) return { env, accessReady: false };
  try {
    // Check the retrieval schema without reading or touching any workspace key or usage record.
    const result = await db.prepare(`SELECT 1 FROM workspace_api_key k JOIN civic_workspace_billing b USING (workspace_id)
      WHERE k.status='active' AND b.enabled=1 LIMIT 0`).all();
    return { env, accessReady: result.success };
  } catch {
    return { env, accessReady: false };
  }
}

async function inspect(info: Definition, enabled: boolean, accessReady: boolean, load: () => Promise<DiscoveryEdition[]>): Promise<DiscoverySource> {
  if (!enabled) return { ...info, status: 'disabled', editions: [] };
  if (!accessReady) return { ...info, status: 'unavailable', editions: [] };
  try {
    const editions = await load();
    return { ...info, status: editions.length ? 'available' : 'empty', editions };
  } catch {
    return { ...info, status: 'unavailable', editions: [] };
  }
}

async function editions(db: D1Database | undefined, sql: string, path: (r: Result) => string, args: string[] = []) {
  if (!db) throw new Error('Missing source storage');
  const statement = db.prepare(sql);
  const result = await (args.length ? statement.bind(...args) : statement).all<Result>();
  if (!result.success) throw new Error('Cannot verify publication');
  return result.results.map(row => ({
    scope: row.scope, language: row.language, ...(row.editionType === 'extra' ? { editionType: 'extra' as const } : {}), observedAt: row.observedAt ?? undefined,
    latestRecordDate: row.latestRecordDate ?? undefined, publishedAt: row.publishedAt ?? undefined,
    coverageThrough: row.coverageThrough ?? undefined, revision: row.revision ?? undefined, request: path(row),
  }));
}

function funding({ env, accessReady }: DiscoveryContext, source: typeof FundingSource.options[number]) {
  const esdc = source === 'esdc';
  return inspect(definition(source, esdc ? 'ESDC funding calls' : 'NSERC College and Community Innovation',
      esdc ? 'Which calls fund apprenticeship training capacity, who can apply, and when did they close?' :
        'Which grants support applied research partnerships with colleges?', FUNDING_OPENAPI_PATH), env.FUNDING_PREVIEW === 'on', accessReady,
      () => editions(env.FUNDING_DB ?? env.CIVIC_DB, languages + `SELECT c.source AS scope, l.language, c.observed_at AS observedAt, c.revision
      FROM funding_catalogues c CROSS JOIN languages l WHERE c.source=? AND EXISTS
      (SELECT 1 FROM funding_editions e LEFT JOIN funding_sections s USING (source,id,language)
       WHERE e.source=c.source AND e.language=l.language)`,
      r => requestPath('/api/funding-programs', { source, language: r.language, query: esdc
        ? (r.language === 'fr' ? 'expansion des infrastructures' : 'infrastructure expansion')
        : (r.language === 'fr' ? 'recherche et développement appliquée' : 'applied research and development') }), [source]));
}

function departmentalPublications({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('departmental-publications', 'ECCC audits and evaluations',
    'What did the Lake Winnipeg evaluation recommend?', DEPARTMENTAL_OPENAPI_PATH),
    env.DEPARTMENTAL_PUBLICATIONS_PREVIEW === 'on', accessReady, () => editions(env.DEPARTMENTAL_PUBLICATIONS_DB,
      `SELECT 'ECCC' AS scope,p.language,i.cutoff AS observedAt,i.revision FROM dp_passages p
       CROSS JOIN dp_inventory i WHERE i.singleton=1 GROUP BY p.language`,
      row => requestPath('/api/departmental-publications', { language: row.language, query: 'Winnipeg' })));
}

function consultations({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('consultations', 'Government of Canada consultations',
      'Which federal consultations ask about artificial intelligence, and when do they close?', CONSULTATIONS_OPENAPI_PATH),
    env.CONSULTATIONS_PREVIEW === 'on', accessReady, () =>
      editions(env.CONSULTATIONS_DB ?? env.CIVIC_DB, languages + `SELECT c.source AS scope,l.language,c.observed_at AS observedAt,c.revision
      FROM consultations_catalogues c CROSS JOIN languages l
      WHERE c.source='canada' AND EXISTS (SELECT 1 FROM consultations_records r WHERE r.owner_org<>'')`,
      r => requestPath('/api/consultations', { language: r.language,
        query: r.language === 'fr' ? 'intelligence artificielle' : 'artificial intelligence' })));
}

function committees({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('committees', 'Parliamentary committees', 'Who raised apprenticeship waitlists in committee evidence or a submission?', COMMITTEE_OPENAPI_PATH),
    env.COMMITTEE_CORPUS_PREVIEW === 'on', accessReady, () => editions(env.COMMITTEE_DB, languages + `SELECT s.session AS scope,
    l.language, s.cutoff AS coverageThrough FROM cc_snapshot s CROSS JOIN languages l WHERE EXISTS
    (SELECT 1 FROM cc_records r WHERE r.session=s.session AND r.language=l.language) AND EXISTS
    (SELECT 1 FROM cc_passages p JOIN cc_fts_docsize f ON f.id=p.rowid
     WHERE p.session=s.session AND p.language=l.language)
    ORDER BY s.session,l.language`, r => requestPath('/api/committees/search', { session: r.scope, language: r.language,
      query: r.language === 'fr' ? 'attente apprentis capacité' : 'apprentice waitlists' })));
}

function parliament({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('parliament', 'Parliamentary catalogues', 'Which bills, proceedings and recorded votes concern my file?', PARLIAMENT_OPENAPI_PATH),
    env.PARLIAMENT_CATALOGUE_PREVIEW === 'on', accessReady, () => editions(env.CIVIC_DB, `SELECT c.collection || '/' || c.session AS scope,
    e.language,c.observed_at AS observedAt,c.revision,max(e.date) AS latestRecordDate FROM parliament_catalogues c
    JOIN parliament_editions e USING(collection,session) GROUP BY c.collection,c.session,e.language ORDER BY scope,e.language`,
    r => { const [collection, session] = r.scope.split('/');
      return requestPath('/api/parliament/' + ParliamentCollection.parse(collection), { session: ParliamentSession.parse(session), language: r.language }); }));
}

function writtenQuestions({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('written-questions', 'House written questions', 'What has a department said in replies about apprenticeship?', WRITTEN_QUESTIONS_OPENAPI_PATH),
    env.WRITTEN_QUESTIONS_PREVIEW === 'on', accessReady, () => editions(env.CIVIC_DB, `SELECT q.session AS scope,q.language,
    s.completed_at AS publishedAt, max(q.last_checked) AS observedAt, max(q.asked_on) AS latestRecordDate,s.source_sha256 AS revision
    FROM wq_materialization_state s CROSS JOIN questions q WHERE s.singleton=1 AND s.indexed_passage_count>0
    GROUP BY q.session,q.language HAVING EXISTS (SELECT 1 FROM wq_fts f WHERE f.session=q.session AND f.language=q.language)
    ORDER BY q.session,q.language`,
    r => requestPath('/api/written-questions', { session: r.scope, language: r.language, query: topic(r.language) })));
}

function directory({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('geds', 'Federal directory', 'Which offices appear in the federal directory under Employment and Social Development?', GEDS_OPENAPI_PATH),
    env.GEDS_PREVIEW === 'on', accessReady, () => editions(env.CIVIC_DB, languages + `SELECT s.snapshot_id AS scope,l.language,s.effective_at AS coverageThrough,
    s.published_at AS publishedAt,s.source_date AS latestRecordDate,
    (SELECT max(fetched_at) FROM geds_observations WHERE zip_sha256=s.zip_sha256) AS observedAt,s.csv_sha256 AS revision FROM geds_snapshots s CROSS JOIN languages l
    WHERE s.seq=(SELECT max(seq) FROM geds_snapshots WHERE status='published') AND s.organization_count>0
    AND EXISTS (SELECT 1 FROM geds_organizations o WHERE o.valid_from_seq<=s.seq AND (o.valid_to_seq IS NULL OR o.valid_to_seq>s.seq))`,
    r => requestPath('/api/organizations', { lang: r.language, q: r.language === 'fr' ? 'Emploi' : 'Employment' })));
}

function hansard({ env, accessReady }: DiscoveryContext, chamber: keyof typeof HANSARD_PATHS) {
  return inspect(definition(hansardPolicy(chamber).id, chamber === 'house' ? 'House Hansard' : 'Senate Hansard',
      'What did members say about apprenticeship in debate?', HANSARD_OPENAPI_PATH), env.HANSARD_PREVIEW === 'on', accessReady, async () => {
      const byLanguage = await Promise.all((['en', 'fr'] as const).map(language => editions(env.CIVIC_DB,
        'SELECT ? AS scope,? AS language,max(sitting_date) AS latestRecordDate FROM hansard_speeches WHERE corpus_id=? AND id GLOB ? HAVING max(sitting_date) IS NOT NULL',
        () => requestPath(HANSARD_PATHS[chamber], { language, topic: topic(language) }),
        [chamber, language, hansardPolicy(chamber).id, hansardLanguagePrefix(language, chamber) + '*'])));
      return byLanguage.flat();
    });
}

function gazetteIssues({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('canada-gazette', 'Canada Gazette', 'What notices or instruments appeared in the indexed issues?', GAZETTE_OPENAPI_PATH),
    env.GAZETTE_PREVIEW === 'on', accessReady, () => editions(env.GAZETTE_DB,
      `SELECT part AS scope,language,'regular' AS editionType,issue_date AS latestRecordDate,imported_at AS publishedAt,content_sha256 AS revision
       FROM gazette_editions e WHERE record_count>0 AND EXISTS (SELECT 1 FROM gazette_records r
         WHERE r.part=e.part AND r.language=e.language AND r.issue_date=e.issue_date
         AND r.volume=e.volume AND r.issue_number=e.issue_number)
       UNION ALL
       SELECT part AS scope,language,'extra' AS editionType,issue_date AS latestRecordDate,imported_at AS publishedAt,content_sha256 AS revision
       FROM gazette_extra_editions e WHERE record_count>0 AND EXISTS (SELECT 1 FROM gazette_extra_records r
         WHERE r.part=e.part AND r.language=e.language AND r.issue_date=e.issue_date
         AND r.volume=e.volume AND r.extra_number=e.extra_number)
       ORDER BY latestRecordDate DESC,scope,language`,
      row => requestPath('/api/gazette', { part: row.scope, language: row.language,
        ...(row.editionType === 'extra' ? { editionType: 'extra' } : {}),
        since: String(row.latestRecordDate), until: String(row.latestRecordDate), topic: topic(row.language) })));
}

function billTrace({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('bill-trace', 'S-5 bill history (44-1)', 'How did S-5 move through committee and a recorded vote?', BILL_OPENAPI_PATH),
    env.BILL_PREVIEW === 'on', accessReady, async () => {
      if (!env.BILL_DB) throw new Error('Missing bill database');
      const brief = await readBillBrief(env.BILL_DB, 'en');
      const latestRecordDate = brief.records.map(r => r.date).filter((date): date is string => Boolean(date)).sort().at(-1);
      return brief.records.length ? (['en', 'fr'] as const).map(language => ({ scope: '44-1/s-5', language, latestRecordDate,
        request: requestPath('/api/bills/44/1/s-5/brief', { language }) })) : [];
    });
}

function freshwater({ env, accessReady }: DiscoveryContext) {
  return inspect(definition('freshwater-study', 'House freshwater study', 'What did the committee recommend and how did the government respond?', COMMITTEE_OPENAPI_PATH),
    env.BILL_PREVIEW === 'on', accessReady, async () => (['en', 'fr'] as const).map(language => ({ scope: '45-1/ENVI/freshwater',
      language, coverageThrough: freshwaterStudy.coverageThrough, request: requestPath(COMMITTEE_STUDY_BRIEF_PATH, { language }) })));
}

function changes({ env, accessReady }: DiscoveryContext, source: keyof typeof SOURCE_FEED_PATHS) {
  const gazette = source === 'gazette';
  return inspect(definition(source + '-changes', source + ' publication changes', 'Which published records were added, corrected or removed?',
      gazette ? GAZETTE_OPENAPI_PATH : HANSARD_OPENAPI_PATH), (gazette ? env.GAZETTE_PREVIEW : env.HANSARD_PREVIEW) === 'on', accessReady,
      () => editions(gazette ? env.GAZETTE_DB : env.CIVIC_DB, `SELECT coalesce(part, source) AS scope,language,max(observed_at) AS observedAt,
      max(publication_date) AS latestRecordDate,
      i.journal_id || '/' || coalesce((SELECT max(seq) FROM source_feed_events e WHERE e.source=d.source AND e.language=d.language AND e.part IS d.part),0) AS revision
      FROM source_feed_editions d CROSS JOIN source_feed_identity i WHERE source=? AND i.singleton=1
      AND length(i.journal_id)=32 AND i.journal_id NOT GLOB '*[^0-9a-f]*'
      GROUP BY source,part,language ORDER BY scope,language`,
      r => requestPath(SOURCE_FEED_PATHS[source], { language: r.language, ...(gazette ? { part: r.scope } : {}) }), [source]));
}

export function discoverSources(context: DiscoveryContext) {
  return Promise.all([
    ...FundingSource.options.map(source => funding(context, source)),
    consultations(context), departmentalPublications(context), committees(context), parliament(context), writtenQuestions(context), directory(context),
    hansard(context, 'house'), hansard(context, 'senate'), gazetteIssues(context), billTrace(context), freshwater(context),
    changes(context, 'gazette'), changes(context, 'house'), changes(context, 'senate'),
  ]);
}

export async function statuteSource({ env, accessReady }: DiscoveryContext, publication: CorpusAvailability | undefined): Promise<DiscoverySource> {
  const info = { id: 'statutes-canada', name: 'Federal statutes and regulations', question: 'What does a cited federal provision say?' };
  return inspect(info, Boolean(env.CIVIC_DB), accessReady, async () => {
    if (!publication?.available) {
      if (publication?.rowCount === 0) return [];
      throw new Error('Publication unavailable');
    }
    if (parseCorpusTextMode(env.CORPUS_TEXT_MODE) !== 'd1' && !env.CORPORA) throw new Error('Text unavailable');
    if (!env.CIVIC_DB) throw new Error('Missing statute storage');
    // Pick a citation that exists in each served language, including monolingual previews.
    const db = env.CIVIC_DB;
    const rows = await Promise.all((['en', 'fr'] as const).map(async language => {
      const row = await db.prepare(`SELECT act,section FROM statute_sections WHERE corpus_id=?
        AND language=? AND act<>'' AND section<>'' LIMIT 1`).bind(info.id, language).first<{ act: string; section: string }>();
      return row ? [{ scope: 'CA', language, coverageThrough: publication.asOf, observedAt: publication.lastRunAt,
        revision: publication.revision, request: requestPath('/api/statutes', { ...row, language }) }] : [];
    }));
    return rows.flat();
  });
}
