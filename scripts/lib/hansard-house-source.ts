import type { HansardLanguage } from '../../src/corpora/hansard';
import { MAX_HANSARD_XML_BYTES } from '../../src/ingest/hansard';
import { assertCompletedHansardWeek, hansardWeekDates, type HansardSittingRef } from './hansard-week';
import { readHansardSource } from './hansard-http';

const HOUSE = 'https://www.ourcommons.ca';
const SESSION = /^([1-9][0-9]*)-([1-9][0-9]*)$/u;
const SITTING = /^([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)$/u;

/** Read one calendar widget response, requiring visible coverage of all seven dates. */
export function parseHouseHansardCalendar(html: string, session: string, weekOf: string) {
  if (!SESSION.test(session)) throw new Error('Supply the House Parliament and session as N-N.');
  const days = new Set(hansardWeekDates(weekOf));
  const seen = new Set<string>();
  const sittings: HansardSittingRef[] = [];
  if (!/<table\b[^>]*\sclass=["']publications-calendar["']/iu.test(html)) throw new Error('House calendar markup was not recognized.');
  for (const [, attributes = '', body = ''] of html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/giu)) {
    const date = /<div\b[^>]*\sclass=["'](\d{4}-\d{2}-\d{2})["']/iu.exec(body)?.[1];
    if (!date || !days.has(date)) continue;
    if (seen.has(date)) throw new Error(`Duplicate date in the House calendar: ${date}.`);
    seen.add(date);
    const classes = /\sclass=["']([^"']*)["']/iu.exec(attributes)?.[1]?.split(/\s+/u);
    if (!classes?.includes('chamber-meeting')) continue;

    const links = [...body.matchAll(/<a\b[^>]*\shref=["']\/documentviewer\/en\/([0-9]+-[0-9]+)\/house\/sitting-([1-9][0-9]*)\/(?:hansard|journals|order-notice)["']/giu)];
    const link = links[0];
    if (links.length !== 1 || link?.[1] !== session) throw new Error(`Could not identify the House sitting for ${date}.`);
    sittings.push({ sittingDate: date, sittingId: `${session}-${link[2]}` });
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
