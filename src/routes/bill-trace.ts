import { attributionFor } from '@chester-hill-solutions/corpus';
import { AccessError } from '../access';
import { BILL_KEY, PILOT_BILL, BillBriefSchema, BillLanguageSchema, BillRecordSchema, BillSourceSchema,
  type BillBrief, type BillLanguage } from '../corpora/bill-trace';
import { BILLS_CANADA } from '../corpora/policies';
import { RequestInputError } from '../http';
import type { Env } from '../types';

export const BILL_BRIEF_PATH = '/api/bills/{parliament}/{session}/{number}/brief';
export const BILL_OPENAPI_PATH = '/api/bills/openapi.json';
const route = /^\/api\/bills\/(\d+)\/(\d+)\/([cs]-\d+)\/brief$/i;

export function prepareBillBrief(url: URL): ((env: Env) => () => Promise<BillBrief>) | undefined {
  const match = route.exec(url.pathname);
  if (!match) return undefined;
  return (env) => {
    if (env.BILL_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The bill trace preview is disabled.', 501);
    if (`${match[1]}-${match[2]}/${match[3]?.toLowerCase()}` !== BILL_KEY) {
      throw new AccessError('UNSUPPORTED_COVERAGE', 'The bill trace preview covers S-5 in the 44th Parliament, first session.', 501);
    }
    const params = [...url.searchParams];
    const language = BillLanguageSchema.safeParse(url.searchParams.get('language'));
    if (params.length !== 1 || !language.success) throw new RequestInputError('Supply one language argument, en or fr.');
    const db = env.BILL_DB;
    if (!db) throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The bill trace database is unavailable.', 503);
    return () => readBillBrief(db, language.data);
  };
}

export async function readBillBrief(db: D1Database, language: BillLanguage): Promise<BillBrief> {
  try {
    const rows = await db.prepare('SELECT source, available, records_json FROM bill_trace_sources WHERE bill_key = ?')
      .bind(BILL_KEY).all<{ source: string; available: number; records_json: string }>();
    if (!rows.success || rows.results.length !== BillSourceSchema.options.length) throw new Error('Incomplete replay state.');
    const availableIds = new Set<string>();
    const documents = BillSourceSchema.options.map((source) => {
      const row = rows.results.find((entry) => entry.source === source);
      if (!row) throw new Error('Missing replay status.');
      const available = row.available === 1;
      const records = available ? BillRecordSchema.array().parse(JSON.parse(row.records_json)) : [];
      for (const record of records) availableIds.add(record.id);
      return { source, available, records };
    });
    if (!documents.some((doc) => doc.available)) throw new Error('No sources available.');
    const records = documents.flatMap((doc) => doc.records.map((record) => ({ ...record, source: doc.source,
      committee: record.committee ? { ...record.committee, name: record.committee.name[language] } : undefined,
      label: record.label[language], url: record.url[language],
      links: record.links.map((edge) => ({ ...edge, available: availableIds.has(edge.target) })) })));
    records.sort((a, b) => (a.sourceDateTime ?? a.date ?? '').localeCompare(b.sourceDateTime ?? b.date ?? '')
      || a.id.localeCompare(b.id));
    return BillBriefSchema.parse({
      bill: { ...PILOT_BILL, title: PILOT_BILL.title[language], url: PILOT_BILL.url[language] }, language,
      complete: documents.every((doc) => doc.available),
      coverage: documents.map((doc) => ({ source: doc.source, status: doc.available ? 'available' : 'missing', count: doc.records.length })),
      records, attribution: attributionFor(BILLS_CANADA),
    });
  } catch {
    throw new AccessError('RETRIEVAL_UNAVAILABLE', 'The bill trace has no readable replay.', 503);
  }
}
