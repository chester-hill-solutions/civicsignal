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
  const parsed = parseHouseCalendar(html, session, days);
  if (parsed.calendarDates.length !== days.size) throw new Error('The House calendar did not provide unique coverage of the requested week.');
  return { weekOf, sittings: parsed.sittings.sort((a, b) => a.sittingDate.localeCompare(b.sittingDate)) };
}

export function parseHouseHansardSessionCalendar(html: string, session: string, cutoff: string) {
  if (!SESSION.test(session) || !/^\d{4}-\d{2}-\d{2}$/u.test(cutoff)) throw new Error('Invalid House session or cutoff.');
  const parsed = parseHouseCalendar(html, session, undefined, cutoff);
  assertContinuousHouseCalendar(parsed.calendarDates);
  return { cutoff, calendarDates: parsed.calendarDates.filter((date) => date <= cutoff),
    sittings: parsed.sittings.filter((sitting) => sitting.sittingDate <= cutoff) };
}

function parseHouseCalendar(html: string, session: string, requiredDates?: Set<string>, cutoff?: string) {
  const seen = new Set<string>();
  const sittings: HansardSittingRef[] = [];
  const tables = [...html.matchAll(/<table\b[^>]*\sclass=["']publications-calendar["'][^>]*>([\s\S]*?)<\/table>/giu)];
  if (!tables.length) throw new Error('House calendar markup was not recognized.');
  const rows = tables.flatMap(([, table = '']) => [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]);
  for (const [, row = ''] of rows) {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/giu)];
    const dates = cells.map(([, , body = '']) => DATE_CLASS.exec(body)?.[1]);
    for (const [index, cell] of cells.entries()) parseHouseCalendarCell({ cell, dates, index, session, requiredDates, cutoff, seen, sittings });
  }
  if (requiredDates && seen.size !== requiredDates.size) throw new Error('The House calendar did not provide unique coverage of the requested week.');
  if (new Set(sittings.map((sitting) => sitting.sittingId)).size !== sittings.length) throw new Error('The House calendar contains duplicate sitting identities.');
  return { calendarDates: [...seen].sort(), sittings };
}

function parseHouseCalendarCell(input: {
  cell: RegExpMatchArray; dates: Array<string | undefined>; index: number; session: string;
  requiredDates?: Set<string>; cutoff?: string; seen: Set<string>; sittings: HansardSittingRef[];
}): void {
  const { cell, dates, index, session, requiredDates, cutoff, seen, sittings } = input;
  const attributes = cell[1] ?? '';
  const body = cell[2] ?? '';
  const tablingDate = adjournmentTablingDate(body, session, dates[index - 1], dates[index + 1]);
  const date = dates[index] ?? tablingDate;
  if (!date || (requiredDates && !requiredDates.has(date))) return;
  if (seen.has(date)) throw new Error(`Duplicate date in the House calendar: ${date}.`);
  seen.add(date);
  if (cutoff && date > cutoff) return;
  const chamberMeeting = /\sclass=["']([^"']*)["']/iu.exec(attributes)?.[1]?.split(/\s+/u).includes('chamber-meeting');
  if (tablingDate && (tablingDate !== date || chamberMeeting)) throw new Error(`Conflicting adjournment tabling cell in the House calendar: ${date}.`);
  if (chamberMeeting) sittings.push(houseSitting(body, session, date));
}

function assertContinuousHouseCalendar(dates: string[]): void {
  if (!dates.length) throw new Error('The House session calendar contains no dated calendar cells.');
  const start = new Date(`${dates[0]}T00:00:00Z`);
  const end = new Date(`${dates.at(-1)}T00:00:00Z`);
  const seen = new Set(dates);
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!seen.has(day.toISOString().slice(0, 10))) throw new Error('The House session calendar has a gap in its visible date coverage.');
  }
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

export async function discoverHouseHansardSession(session: string, cutoff: string, send: typeof fetch = fetch) {
  if (!SESSION.test(session)) throw new Error('Supply the House Parliament and session as N-N.');
  const match = SESSION.exec(session);
  const parliament = match?.[1];
  const sessionNumber = match?.[2];
  if (!parliament || !sessionNumber) throw new Error('Supply the House Parliament and session as N-N.');
  const url = houseCalendarUrl(parliament, sessionNumber);
  const bytes = await readHansardSource(url, send, ['text/html'], 2 * 1024 * 1024);
  if (!bytes) throw new Error('The House calendar was unavailable for the requested session.');
  const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  return { url: url.href, bytes, ...parseHouseHansardSessionCalendar(html, session, cutoff) };
}

function houseCalendarUrl(parliament: string, session: string): URL {
  const url = new URL('/documentviewer/en/SessionPublicationCalendarsWidget', HOUSE);
  url.search = new URLSearchParams({ organization: 'HOC', publicationTypeId: '37', parliament, session }).toString();
  return url;
}

export function fetchHouseHansardEdition(sitting: HansardSittingRef & { edition: HansardLanguage }, send: typeof fetch = fetch) {
  const match = SITTING.exec(sitting.sittingId);
  if (!match) throw new Error('Invalid House sitting identity.');
  const number = match[3]!.padStart(3, '0');
  const letter = sitting.edition === 'en' ? 'E' : 'F';
  const url = new URL(`/Content/House/${match[1]}${match[2]}/Debates/${number}/HAN${number}-${letter}.XML`, HOUSE);
  return readHansardSource(url, send, ['text/xml', 'application/xml'], MAX_HANSARD_XML_BYTES);
}
