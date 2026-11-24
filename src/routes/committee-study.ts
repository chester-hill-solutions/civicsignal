import { AccessError } from '../access';
import { CommitteeStudyBriefSchema, CommitteeStudyLanguageSchema, CommitteeStudyPacketSchema,
  type CommitteeStudyBrief, type CommitteeStudyLanguage } from '../corpora/committee-study';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import packetJson from '../../preview/committees/envi-freshwater.json';

export const COMMITTEE_STUDY_BRIEF_PATH = '/api/committees/house/ENVI/studies/freshwater/brief';
export const COMMITTEE_OPENAPI_PATH = '/api/committees/openapi.json';
const route = /^\/api\/committees\/house\/ENVI\/studies\/freshwater\/brief$/i;
const packet = CommitteeStudyPacketSchema.parse(packetJson);

export function prepareCommitteeStudyBrief(url: URL): ((env: Env) => () => Promise<CommitteeStudyBrief>) | undefined {
  if (!route.test(url.pathname)) return undefined;
  return (env) => {
    if (env.BILL_PREVIEW !== 'on') throw new AccessError('UNSUPPORTED_COVERAGE', 'The committee study preview is disabled.', 501);
    const params = [...url.searchParams];
    const language = CommitteeStudyLanguageSchema.safeParse(url.searchParams.get('language'));
    if (params.some(([key]) => key !== 'language' && key !== 'asOf') ||
      params.filter(([key]) => key === 'language').length !== 1 || params.filter(([key]) => key === 'asOf').length > 1 ||
      !language.success) throw new RequestInputError('Supply language=en or fr, and optionally one asOf=YYYY-MM-DD.');
    const rawAsOf = url.searchParams.get('asOf');
    const asOf = rawAsOf === null ? packet.coverageThrough : parseDate(rawAsOf);
    if (asOf > packet.coverageThrough) {
      throw new RequestInputError(`asOf cannot be later than the known historical coverage date, ${packet.coverageThrough}.`);
    }
    return async () => readCommitteeStudyBrief(language.data, asOf);
  };
}

function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !CommitteeStudyBriefSchema.shape.asOf.safeParse(value).success) {
    throw new RequestInputError('asOf must be a real calendar date in YYYY-MM-DD format.');
  }
  return value;
}

function addCalendarDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function responseState(asOf: string, requestDate: string | null, presentationDate: string | null, responseDate: string | null) {
  const deadline = presentationDate ? addCalendarDays(presentationDate, 120) : null;
  const visibleResponseDate = responseDate && responseDate <= asOf ? responseDate : null;
  const visibleRequestDate = requestDate && requestDate <= asOf ? requestDate : null;
  const status = !visibleRequestDate ? 'no-request-in-record' as const : !presentationDate ? 'awaiting-presentation' as const
    : visibleResponseDate ? 'fulfilled' as const : deadline && asOf > deadline ? 'overdue' as const : 'pending' as const;
  return { status, requestDate: visibleRequestDate, presentationDate, deadline, responseDate: visibleResponseDate };
}

export async function readCommitteeStudyBrief(language: CommitteeStudyLanguage, asOf: string): Promise<CommitteeStudyBrief> {
  const visible = packet.events.filter((event) => event.date <= asOf);
  const requestDate = packet.events.find((event) => event.type === 'report')?.date ?? null;
  const sourceResponseDate = visible.find((event) => event.type === 'government-response')?.date ?? null;
  const presentationEvent = packet.events.find((event) => event.type === 'presentation');
  const presentationDate = presentationEvent && presentationEvent.date <= asOf ? presentationEvent.date : null;
  const response = { ...responseState(asOf, requestDate, presentationDate, sourceResponseDate),
    citations: packet.responseCitations.filter((citation) => citation.date <= asOf)
      .map((citation) => ({ label: citation.label[language], url: citation.url[language] })) };
  return CommitteeStudyBriefSchema.parse({
    study: { parliament: 45, session: 1, committee: 'ENVI', studyActivityId: 13298665,
      title: packet.study.title[language], url: packet.study.url[language] },
    language, asOf, coverageThrough: packet.coverageThrough, publisher: packet.publisher[language],
    events: visible.map((event) => ({ id: event.id, date: event.date, type: event.type,
      label: event.label[language], citations: event.citations.map((citation) => ({ label: citation.label[language], url: citation.url[language] })) })),
    response,
  });
}
