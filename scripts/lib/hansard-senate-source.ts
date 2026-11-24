import { MAX_HANSARD_XML_BYTES } from '../../src/ingest/hansard';
import { readHansardSource } from './hansard-http';
import { assertCompletedHansardWeek, hansardWeekDates, type HansardSittingRef } from './hansard-week';
import { senateEditionUrl, type SenateEditionRef } from './senate-hansard-html';

const SENATE = 'https://sencanada.ca';
const sessionId = /^[1-9][0-9]*-[1-9][0-9]*$/u;
const debatePath = /^\/en\/content\/sen\/chamber\/([0-9]+)\/debates\/([0-9]+)db_(\d{4}-\d{2}-\d{2})-e\/?$/iu;

export function parseSenateHansardCalendar(html: string, session: string, weekOf: string) {
  if (!sessionId.test(session)) throw new Error('Supply the Senate Parliament and session as N-N.');
  const dates = new Set(hansardWeekDates(weekOf));
  const expectedSession = session.replace('-', '');
  const sittings = new Map<string, HansardSittingRef>();
  let title = '';
  let published = 0;

  const rewriter = new HTMLRewriter() as HTMLRewriter & { transform(input: string): string };
  rewriter
    .on('head title', { text(chunk) { title += chunk.text; } })
    .on('.sc-in-the-chamber-calendar-table-day a[href]', {
      element(node) {
        const href = node.getAttribute('href')?.replaceAll('\\', '/') ?? '';
        const match = debatePath.exec(href);
        if (!match || match[1] !== expectedSession) throw new Error('Unexpected Senate calendar publication link.');
        published++;
        const [, , issue, sittingDate] = match;
        if (!dates.has(sittingDate!)) return;
        const sittingId = `${session}-${Number(issue)}`;
        const prior = sittings.get(sittingId);
        if (prior && prior.sittingDate !== sittingDate) throw new Error('Conflicting Senate issue dates in the calendar.');
        sittings.set(sittingId, { sittingId, sittingDate: sittingDate! });
      },
    });
  rewriter.transform(html);

  if (!published || !title.trim().endsWith(` - ${session}`)) throw new Error('The Senate session calendar was not recognized.');
  return { weekOf, sittings: [...sittings.values()].sort((a, b) => a.sittingDate.localeCompare(b.sittingDate)) };
}

export async function discoverSenateHansardWeek(session: string, weekOf: string, send: typeof fetch = fetch) {
  assertCompletedHansardWeek(weekOf);
  if (!sessionId.test(session)) throw new Error('Supply the Senate Parliament and session as N-N.');
  const url = new URL(`/en/in-the-chamber/debates/${session}`, SENATE);
  const bytes = await readHansardSource(url, send, ['text/html'], 2 * 1024 * 1024);
  if (!bytes) throw new Error('The Senate calendar was unavailable for the requested session.');
  return parseSenateHansardCalendar(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), session, weekOf);
}

export function fetchSenateHansardEdition(expected: SenateEditionRef, send: typeof fetch = fetch) {
  return readHansardSource(senateEditionUrl(expected), send, ['text/html'], MAX_HANSARD_XML_BYTES);
}
