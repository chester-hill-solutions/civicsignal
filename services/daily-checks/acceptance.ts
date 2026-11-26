import { z } from 'zod';
import { CommitteeCallSchema, CommitteeCallsResponseSchema, CommitteeCallDetailResponseSchema, CommitteeCorpusSearchResponseSchema } from '../../src/corpora/committee-corpus';
import { ConsultationCoverageSchema, ConsultationLookupResponseSchema, ConsultationSearchResponseSchema } from '../../src/corpora/consultations';
import { FundingCatalogueCoverage, FundingLookupResponse, FundingSearchResponse, type FundingSource } from '../../src/corpora/funding';
import { checkedFundingInventory, fundingDigest, fundingRevision } from '../../src/corpora/funding-publication';
import { textSha256 } from '../../src/corpora/text-store';
import { normalizeForSearch } from '../../src/text';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const Inputs = z.strictObject({
  consultations: z.string().regex(/^consultations-\d+$/), nserc: z.string().regex(/^nserc-\d+$/),
  esdc: z.string().regex(/^esdc-\d+$/), committee: digest,
});
export type Inputs = z.infer<typeof Inputs>;
type Language = 'en' | 'fr';
type Read = (path: string, parameters?: Record<string, string>) => Promise<unknown>;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function same(actual: unknown, expected: unknown, label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label + ' differs from its retained reference.');
}

interface Archive { get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null> }

async function jsonObject(bucket: Archive, key: string, limit: number, checksum?: string): Promise<unknown> {
  const object = await bucket.get(key);
  assert(object && object.size > 0 && object.size <= limit, 'Missing or oversized reference: ' + key);
  const bytes = new Uint8Array(await object.arrayBuffer());
  assert(bytes.length === object.size, 'Truncated reference: ' + key);
  if (checksum) assert(await textSha256(bytes) === checksum, 'Reference digest mismatch: ' + key);
  return JSON.parse(new TextDecoder().decode(bytes));
}

const consultationReceipt = z.object({ instanceId: z.string(), observedAt: z.string(),
  sources: z.object({ csv: z.object({ sha256: digest }), schema: z.object({ sha256: digest }) }),
  published: z.object({ rows: z.number().positive(), revision: digest }),
  lookup: z.object({ id: z.string(), titles: z.object({ en: z.string(), fr: z.string() }) }),
});
export async function checkConsultations(read: Read, bucket: Archive, instance: string) {
  const receipt = consultationReceipt.parse(await jsonObject(bucket, `consultations/runs/${instance}.json`, 65536));
  assert(receipt.instanceId === instance, 'Consultations receipt identity mismatch.');
  const { observedAt: asOf, lookup } = receipt;
  const coverage = ConsultationCoverageSchema.parse(await read('/api/consultations/coverage', { asOf }));
  same([coverage.observedAt, coverage.counts.total, coverage.csvSha256, coverage.schemaSha256],
    [asOf, receipt.published.rows, receipt.sources.csv.sha256, receipt.sources.schema.sha256], 'Consultation coverage');
  const detail = ConsultationLookupResponseSchema.parse(await read('/api/consultations/' + lookup.id, { asOf }));
  assert(detail.item?.id === lookup.id && detail.observedAt === asOf && detail.revisions.length > 0, 'Missing consultation detail or history.');
  for (const language of ['en', 'fr'] as const) {
    const title = lookup.titles[language];
    same(detail.item.editions[language].title, title, 'Consultation lookup');
    const page = ConsultationSearchResponseSchema.parse(await read('/api/consultations', { language, query: title.slice(0, 200), asOf, limit: '100' }));
    assert(page.observedAt === asOf && page.items.some(row => row.id === lookup.id && row.title === title), 'Consultation search missing cited edition.');
  }
  return { instance, observedAt: asOf, rows: coverage.counts.total, sample: lookup.id, revision: receipt.published.revision };
}

const related = z.object({ id: z.string(), language: z.enum(['en', 'fr']),
  counts: z.object({ submissions: z.number(), evidence: z.number(), meetings: z.number() }) });
const committeeRef = z.strictObject({ session: z.literal('45-1'), cutoff: z.string(), asOf: z.string(),
  calls: CommitteeCallSchema.array().min(1), related: related.array(),
  apprenticeship: z.object({ en: z.string().array(), fr: z.string().array() }),
});

export async function checkCommittees(read: Read, bucket: Archive, hash: string) {
  const ref = committeeRef.parse(await jsonObject(bucket, `daily/references/committee/${hash}.json`, 4 * 1024 * 1024, hash));
  const base = '/api/committees/' + ref.session + '/calls';
  for (const language of ['en', 'fr'] as const) {
    const params = { language, asOf: ref.asOf, limit: '100' };
    const expected = ref.calls.filter(row => row.language === language);
    assert(expected.length > 0, 'Missing reference language for committee calls.');
    const calls = [];
    for (let offset = 0; offset < expected.length; offset += 100) {
      const page = CommitteeCallsResponseSchema.parse(await read(base, { ...params, offset: String(offset) }));
      assert(page.asOf === ref.asOf && page.session === ref.session && page.offset === offset &&
        page.hasMore === (offset + page.items.length < expected.length), 'Committee call page metadata mismatch.');
      calls.push(...page.items);
    }
    same(calls, expected, 'Committee call editions');
    const query = language === 'fr' ? 'apprentissage' : 'apprenticeship';
    const matched = ref.apprenticeship[language], ids: string[] = [];
    for (let offset = 0; offset < Math.max(1, matched.length); offset += 100) {
      const page = CommitteeCallsResponseSchema.parse(await read(base, { ...params, query, offset: String(offset) }));
      assert(page.asOf === ref.asOf && page.hasMore === (offset + page.items.length < matched.length), 'Committee search page mismatch.');
      ids.push(...page.items.map(row => row.id));
    }
    same(ids, matched, 'Dated apprenticeship call search');
    const sample = expected.find(row => row.study?.id);
    assert(sample, 'No linked committee study to verify.');
    const detail = CommitteeCallDetailResponseSchema.parse(await read(base + '/' + sample.id, { asOf: ref.asOf, language }));
    assert(detail.state === 'found' && detail.asOf === ref.asOf, 'Committee call detail unavailable.');
    same(detail.item, sample, 'Call to study link');
    same(detail.related, ref.related.find(row => row.id === sample.id && row.language === language)?.counts, 'Related study items');
  }
  return { session: ref.session, cutoff: ref.cutoff, asOf: ref.asOf, editions: ref.calls.length, referenceSha256: hash };
}

const fundingReceipt = z.object({ instanceId: z.string(), observedAt: z.string(),
  inventory: z.object({ key: z.string(), sha256: digest }), published: z.object({ revision: digest }) });

interface ProgramCheck { instance: string; source: FundingSource; id: string; language: Language; query: string }
async function checkProgram(read: Read, bucket: Archive, { instance, source, id, language, query }: ProgramCheck) {
  const receipt = fundingReceipt.parse(await jsonObject(bucket, `funding/${source}/runs/${instance}.json`, 65536));
  assert(receipt.instanceId === instance && receipt.inventory.key === `funding/${source}/inventories/${receipt.inventory.sha256}.json`, 'Funding receipt identity mismatch.');
  const archive = checkedFundingInventory(await jsonObject(bucket, receipt.inventory.key, 16 * 1024 * 1024, receipt.inventory.sha256));
  assert(archive.source === source && archive.observedAt === receipt.observedAt && fundingRevision(archive) === receipt.published.revision, 'Funding receipt revision mismatch.');
  const coverage = FundingCatalogueCoverage.parse(await read('/api/funding-programs/coverage', { source }));
  assert(Date.parse(coverage.observedAt) === Date.parse(receipt.observedAt), 'Funding coverage is from a different observation.');
  same([coverage.revision, coverage.records, coverage.gaps], [receipt.published.revision, archive.records.length, archive.gaps], 'Funding coverage');
  const expected = archive.records.find(row => row.id === id && row.language === language);
  assert(expected, 'Policy example absent from current funding catalogue: ' + id);
  const search = FundingSearchResponse.parse(await read('/api/funding-programs', { source, language, query, limit: '100' }));
  const needle = normalizeForSearch(query);
  const matches = archive.records.filter(row => row.language === language && normalizeForSearch([
    row.title, row.id, row.statusText, ...row.sections.flatMap(s => [s.heading, s.text]),
  ].filter(Boolean).join(' ')).includes(needle));
  const expectedHits = new Map(matches.map(row => [row.id, row]));
  assert(search.revision === coverage.revision && search.items.length === Math.min(100, matches.length) &&
    new Set(search.items.map(row => row.id)).size === search.items.length && search.items.some(row => row.id === id), 'Funding search failed the policy example.');
  for (const hit of search.items) {
    const row = expectedHits.get(hit.id);
    assert(row && row.title === hit.title && row.url === hit.url && row.status === hit.status, 'Funding search returned an unverified citation.');
  }
  const result = FundingLookupResponse.parse(await read('/api/funding-programs/' + id, { language }));
  assert(result.item && result.revision === coverage.revision, 'Funding detail revision mismatch.');
  const { revision, ...content } = result.item;
  assert(fundingDigest(content) === fundingDigest(expected) && revision === fundingDigest(expected), 'Funding terms differ from publisher capture.');
  return { source, instance, id, editionRevision: revision, catalogue: coverage.revision, sections: content.sections.length };
}

export async function checkFinanceBrief(read: Read, language: Language) {
  const french = language === 'fr';
  const brief = 'house-fina-submission-' + (french ? '29cd8309b3885e7f4b96e874' : '559b791939da59abd8bd6d51');
  for (const query of french ? ['100 millions artificielle appliquée', 'attente apprentis capacité'] : ['100M/year applied AI', 'apprentice waitlists']) {
    const page = CommitteeCorpusSearchResponseSchema.parse(await read('/api/committees/search',
      { query, session: '45-1', committeeId: 'house-fina', studyId: brief, language, kind: 'brief', limit: '10' }));
    assert(page.items.some(row => row.citation.id === brief && row.citation.language === language && row.citation.url.includes('/BR14118467/')), 'Missing Finance Committee brief citation.');
  }
  return brief;
}

export function checkFundingProgram(read: Read, bucket: Archive, source: FundingSource, instance: string, language: Language) {
  const french = language === 'fr';
  const [id, query] = source === 'nserc'
    ? ['nserc-applied-research-and-development-grants', french ? 'recherche et développement appliquée' : 'Applied Research and Development']
    : ['esdc-utip-infrastructure-expansion', french ? 'expansion des infrastructures' : 'infrastructure expansion'];
  return checkProgram(read, bucket, { source, instance: Inputs.shape[source].parse(instance), id, language, query });
}

export async function checkRecommendations(read: Read, bucket: Archive, params: Inputs, language: Language) {
  const brief = await checkFinanceBrief(read, language);
  const grant = await checkFundingProgram(read, bucket, 'nserc', params.nserc, language);
  const apprenticeship = await checkFundingProgram(read, bucket, 'esdc', params.esdc, language);
  return { language, brief, grant, apprenticeship };
}
