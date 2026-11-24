import type { HansardLanguage } from '../../src/corpora/hansard';
import { MAX_HANSARD_XML_BYTES } from '../../src/ingest/hansard';
import { assertCompletedHansardWeek, hansardWeekDates, type HansardSittingRef } from './hansard-week';
import { readHansardSource } from './hansard-http';

const HOUSE = 'https://www.ourcommons.ca';
const SESSION = /^([1-9][0-9]*)-([1-9][0-9]*)$/u;
const SITTING = /^([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)$/u;
const DATE_CLASS = /<div\b[^>]*\sclass=["'](\d{4}-\d{2}-\d{2})["']/iu;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function linkedTablingDate(attrs: string, day: string, session: string) {
  const linkSession = /\shref=["']\/documentviewer\/en\/([0-9]+-[0-9]+)\/house\/sitting-[1-9][0-9]*[A-Z]\/journals["']/iu.exec(attrs)?.[1];
  const label = /\saria-label=["']([a-z]+) ([1-9][0-9]?), (\d{4}) Adjournment tabling link to publication["']/iu.exec(attrs);
  if (linkSession !== session || label?.[2] !== day) return;
  const month = MONTHS.indexOf(label[1]?.toLowerCase() ?? '') + 1;
  if (month) return `${label[3]}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function adjournmentTablingDate(body: string, session: string, previous: string | undefined, next: string | undefined) {
  if (!/<div\b[^>]*\sclass=["']adjournment-tabling["']/iu.test(body)) return;
  const day = /<div\b[^>]*\sclass=["']date["']\s*>\s*([1-9][0-9]?)\s*<\/div>/iu.exec(body)?.[1];
  if (!day) return;

  // An unlinked tabling cell has no full date of its own. Require explicitly
  // dated neighbors in the same row and month, with exactly one day between them.
  const month = previous?.slice(0, 8);
  let adjacentDate: string | undefined;
  if (month && previous && next?.slice(0, 8) === month &&
      Number(previous.slice(8)) + 1 === Number(day) && Number(next.slice(8)) - 1 === Number(day)) {
    adjacentDate = month + day.padStart(2, '0');
  }

  const anchors = [...body.matchAll(/<a\b([^>]*)>/giu)];
  if (anchors.length === 0) return adjacentDate;
  if (anchors.length !== 1) return;
  const date = linkedTablingDate(anchors[0]?.[1] ?? '', day, session);
  if (adjacentDate && adjacentDate !== date) return;
  return date;
}

function houseSitting(body: string, session: string, date: string): HansardSittingRef {
  const links = [...body.matchAll(/<a\b[^>]*\shref=["']\/documentviewer\/en\/([0-9]+-[0-9]+)\/house\/sitting-([1-9][0-9]*)\/(?:hansard|journals|order-notice)["']/giu)];
  const link = links[0];
  if (links.length !== 1 || link?.[1] !== session) throw new Error(`Could not identify the House sitting for ${date}.`);
  return { sittingDate: date, sittingId: `${session}-${link[2]}` };
}

/** Read one calendar widget response, requiring visible coverage of all seven dates. */
export function parseHouseHansardCalendar(html: string, session: string, weekOf: string) {
  if (!SESSION.test(session)) throw new Error('Supply the House Parliament and session as N-N.');
  const days = new Set(hansardWeekDates(weekOf));
  const seen = new Set<string>();
  const sittings: HansardSittingRef[] = [];
  const tables = [...html.matchAll(/<table\b[^>]*\sclass=["']publications-calendar["'][^>]*>([\s\S]*?)<\/table>/giu)];
  if (!tables.length) throw new Error('House calendar markup was not recognized.');
  const rows = tables.flatMap(([, table = '']) => [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]);
  for (const [, row = ''] of rows) {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/giu)];
    const dates = cells.map(([, , body = '']) => DATE_CLASS.exec(body)?.[1]);
    for (const [index, [, attributes = '', body = '']] of cells.entries()) {
      const tablingDate = adjournmentTablingDate(body, session, dates[index - 1], dates[index + 1]);
      const date = dates[index] ?? tablingDate;
      if (!date || !days.has(date)) continue;
      if (seen.has(date)) throw new Error(`Duplicate date in the House calendar: ${date}.`);
      seen.add(date);
      const chamberMeeting = /\sclass=["']([^"']*)["']/iu.exec(attributes)?.[1]?.split(/\s+/u).includes('chamber-meeting');
      if (tablingDate && (tablingDate !== date || chamberMeeting)) {
        throw new Error(`Conflicting adjournment tabling cell in the House calendar: ${date}.`);
      }
      if (chamberMeeting) sittings.push(houseSitting(body, session, date));
    }
  }
  if (seen.size !== days.size || new Set(sittings.map((sitting) => sitting.sittingId)).size !== sittings.length) {
    throw new Error('The House calendar did not provide unique coverage of the requested week.');
  }
  return { weekOf, sittings: sittings.sort((a, b) => a.sittingDate.localeCompare(b.sittingDate)) };
}

export async function discoverHouseHansardWeek(session: string, weekOf: string, send: typeof fetch = fetch) {
  assertCompletedHansardWeek(weekOf);
  const match = SESSION.exec(session);
  if (!match) throw new Error('Supply the House Parliament and session as N-N.');
  const url = new URL('/documentviewer/en/SessionPublicationCalendarsWidget', HOUSE);
  url.search = new URLSearchParams({
    organization: 'HOC', publicationTypeId: '37', parliament: match[1]!, session: match[2]!,
  }).toString();
  const bytes = await readHansardSource(url, send, ['text/html'], 2 * 1024 * 1024);
  if (!bytes) throw new Error('The House calendar was unavailable for the requested session.');
  const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  return parseHouseHansardCalendar(html, session, weekOf);
}

export function fetchHouseHansardEdition(sitting: HansardSittingRef & { edition: HansardLanguage }, send: typeof fetch = fetch) {
  const match = SITTING.exec(sitting.sittingId);
  if (!match) throw new Error('Invalid House sitting identity.');
  const number = match[3]!.padStart(3, '0');
  const letter = sitting.edition === 'en' ? 'E' : 'F';
  const url = new URL(`/Content/House/${match[1]}${match[2]}/Debates/${number}/HAN${number}-${letter}.XML`, HOUSE);
  return readHansardSource(url, send, ['text/xml', 'application/xml'], MAX_HANSARD_XML_BYTES);
}
