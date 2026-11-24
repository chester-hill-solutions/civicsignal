import { z } from 'zod';
import { readCommitteeStudyBrief } from '../src/routes/committee-study';
import house from '../preview/policy-files/freshwater-2026-05-25/house.json';
import senate from '../preview/policy-files/freshwater-2026-05-25/senate.json';
import gazette from '../preview/policy-files/freshwater-2026-05-25/gazette.json';
import envi from '../preview/policy-files/freshwater-2026-05-25/envi.json';
import journals from '../preview/policy-files/freshwater-2026-05-25/journals.json';

const rule109 = '[Standing Order 109 EN](https://www.ourcommons.ca/procedure/standing-orders/chap13-e.html) · [FR](https://www.ourcommons.ca/procedure/standing-orders/chap13-f.html)';
const dates = ['2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'] as const;
const weekday = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const url = z.url({ protocol: /^https$/ });
const links = z.strictObject({ en: url, fr: url });
type Links = z.infer<typeof links>;
const match = z.strictObject({ id: z.string().min(1), title: z.string().min(1), reason: z.string().min(1), urls: links, related: z.boolean().default(false),
  also: z.array(z.strictObject({ source: z.string().min(1), urls: links })).default([]) });
const row = z.strictObject({
  date: z.iso.date(), status: z.enum(['checked', 'no-sitting', 'no-issue', 'no-meeting', 'gap']),
  checked: z.array(links), matches: z.array(match), note: z.string().min(1),
});
const inputs = { 'House Journals': journals, 'House debates': house, ENVI: envi, 'Senate debates': senate, Gazette: gazette };

function sourceWeek(name: string, input: unknown) {
  const rows = row.array().parse(input);
  if (rows.length !== dates.length || rows.some((entry, i) => entry.date !== dates[i])) {
    throw new Error(`Expected one dated ${name} record for each sitting day.`);
  }
  for (const entry of rows) {
    if (entry.status !== 'gap' && !entry.checked.length) throw new Error(`Missing ${name} citation on ${entry.date}.`);
    if (entry.status !== 'checked' && entry.matches.length) throw new Error(`Unexpected matches on ${entry.date}.`);
  }
  return rows.map(entry => ({ name, ...entry }));
}

type Source = ReturnType<typeof sourceWeek>[number];
type Citation = { source: string; urls: Links };
function groupEvents(sources: Source[], related: boolean) {
  const events = new Map<string, { id: string; title: string; reason: string; citations: Citation[] }>();
  for (const source of sources) {
    for (const hit of source.matches.filter(hit => hit.related === related)) {
      const citation = { source: source.name, urls: hit.urls };
      const event = events.get(hit.id);
      if (event) event.citations.push(citation, ...hit.also);
      else events.set(hit.id, { id: hit.id, title: hit.title, reason: hit.reason, citations: [citation, ...hit.also] });
    }
  }
  return [...events.values()];
}

const hearing = {
  en: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-39/evidence',
  fr: 'https://www.noscommunes.ca/DocumentViewer/fr/45-1/ENVI/reunion-39/temoignages',
};
function dailyActions(date: string, response: Awaited<ReturnType<typeof readCommitteeStudyBrief>>['response']) {
  const actions: {
    kind: 'committee-amendments' | 'government-response';
    owner: 'members-proposing-amendments' | 'government';
    status: 'open' | 'cutoff-passed' | 'awaiting-presentation';
    dueAt?: string; dueDate?: string; text: string; urls: Links;
  }[] = [];
  if (date >= '2026-05-26' && date <= '2026-05-28') {
    const text = date === '2026-05-28'
      ? 'The committee’s written-amendment cutoff for C-241 passed at 4 p.m. Ottawa time. Check the clause-by-clause record before describing any amendment as accepted.'
      : 'For an office preparing amendments to C-241, route proposed wording to the responsible member before Thursday, May 28 at 4 p.m. Ottawa time. This was a committee amendment deadline.';
    actions.push({ kind: 'committee-amendments', owner: 'members-proposing-amendments',
      status: date === '2026-05-28' ? 'cutoff-passed' : 'open', dueAt: '2026-05-28T16:00:00-04:00', text, urls: hearing });
  }
  if (response.status === 'awaiting-presentation') {
    actions.push({ kind: 'government-response', owner: 'government', status: 'awaiting-presentation', text: 'Watch for presentation of Report 5. ENVI requested a government response on May 5. The 120-day clock starts at presentation, so a calendar due date is still pending.',
      urls: { en: 'https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-37/minutes',
        fr: 'https://www.noscommunes.ca/DocumentViewer/fr/45-1/ENVI/reunion-37/proces-verbal' } });
  } else if (response.deadline && response.status === 'pending') {
    actions.push({ kind: 'government-response', owner: 'government', status: 'open', dueDate: response.deadline, text: `Track ${response.deadline} for the government’s response to Report 5. Compare its eventual commitments with recommendations 50 and 52 on Indigenous monitoring and comparable water data.`,
      urls: { en: 'https://www.ourcommons.ca/documentviewer/en/45-1/ENVI/report-5/page-21',
        fr: 'https://www.noscommunes.ca/documentviewer/fr/45-1/ENVI/rapport-5/page-21' } });
  }
  return actions;
}

/** Replay the documented publication dates of this one file; no live or delivery bindings. */
export async function freshwaterWeek() {
  const sources = Object.entries(inputs).map(([name, input]) => sourceWeek(name, input));
  return Promise.all(dates.map(async (date, i) => {
    const coverage = sources.flatMap(week => week.filter(entry => entry.date === date));
    const { response } = await readCommitteeStudyBrief('en', date);
    return { date, weekday: weekday[i], events: groupEvents(coverage, false), actions: dailyActions(date, response),
      response, related: groupEvents(coverage, true),
      coverage: coverage.map(({ name, status, checked, note }) => ({ name, status, checked, note })) };
  }));
}

const sourceLinks = (label: string, urls: Links) => `[${label} EN](${urls.en}) · [FR](${urls.fr})`;

function coverageCell(source: Awaited<ReturnType<typeof freshwaterWeek>>[number]['coverage'][number], count: number) {
  const states = { checked: count ? String(count) : '0', 'no-sitting': 'No sitting', 'no-issue': 'No issue',
    'no-meeting': 'No meeting', gap: 'Gap' };
  const label = states[source.status];
  const first = source.checked[0];
  return first ? `[${label}](${first.en})` : label;
}

export function reviewMarkdown(days: Awaited<ReturnType<typeof freshwaterWeek>>) {
  const out = [
    '# Federal freshwater governance', '', '**Daily policy briefs · May 25–29, 2026 · 45th Parliament, 1st session**', '',
    'This file follows the House Standing Committee on Environment and Sustainable Development (ENVI), its freshwater report, Canada Water Agency spending and Bill C-241 on flood and drought forecasting. Each brief takes the position of a staffer at the close of that Ottawa sitting day. The dates describe the published parliamentary record. This replay cannot establish when a feed first saw a document or whether its initial text later changed.', '',
    'By Friday, the House had received the freshwater report and ENVI’s estimates report covering the Agency. The amendment window for C-241 had closed. The outstanding dated action was the government’s response to the freshwater report, due September 25.', '',
    '## What the week covered', '',
    'Counts show direct matches. Project-level leads appear separately. A floor statement and its entry in the Journals can describe the same event. The briefs below count it once and link both. Zero means the checked edition had no retained match. “No sitting,” “No meeting” and “No issue” identify days without a scheduled source record. A gap means the source could not be verified.', '',
    '| Day | House Journals | House debates | ENVI | Senate debates | Gazette I/II |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const day of days) {
    const cells = day.coverage.map(source => coverageCell(source, day.events.filter(event => event.citations.some(c => c.source === source.name)).length));
    out.push(`| ${day.weekday} | ${cells.join(' | ')} |`);
  }
  out.push('', 'House and Senate floor checks cover the published editions in both languages. The committee check covers ENVI meetings and selected reports. Gazette coverage uses issue schedules and index titles. Other committees, consultations, departmental announcements and the text of every Gazette instrument remain outside this review. The Saturday, May 30 Part I issue is included in Friday’s index check under the Gazette’s usual advance-release schedule. Its actual posting time is unverified. [Gazette publication schedule](https://gazette.gc.ca/pi-ip/ds-p1-eng.html)', '',
    'The watch terms included C-241, flood and drought forecasting, freshwater (eau douce, eaux douces), Canada Water Agency (Agence canadienne de l’eau) and the Canada Water Act (Loi sur les ressources en eau du Canada). We checked the French bill and report titles as well. Related drinking-water service records are flagged separately. A procedural decision, a recommendation or an estimates vote alone establishes no change to the law in force.', '');
  for (const day of days) {
    out.push(`## ${day.weekday}, May ${Number(day.date.slice(-2))}`, '');
    if (!day.events.length) out.push('No new direct match in the checked sources.', '');
    for (const event of day.events) {
      out.push(`**${event.title}** ${event.reason} ${event.citations.map(c => sourceLinks(c.source, c.urls)).join(' · ')}`, '');
    }
    for (const lead of day.related) out.push(`**Related lead.** ${lead.title} ${lead.reason} ${lead.citations.map(c => sourceLinks('Record', c.urls)).join(' · ')}`, '');
    for (const action of day.actions) {
      const rule = action.kind === 'government-response' ? ' · ' + rule109 : '';
      out.push(`**Action.** ${action.text} ${sourceLinks('Source', action.urls)}${rule}`, '');
    }
    for (const source of day.coverage.filter(item => item.status === 'gap')) out.push(`**Coverage gap.** ${source.name}. ${source.note}`, '');
  }
  out.push('## Staffer review', '',
    'Should Q-1010 and the Charlo groundwater project enter the main watchlist, stay as related leads, or drop out? Which event or deadline would have changed your work that week? For a missed item, record its date and official link so we can check the source coverage and search terms.', '',
    'The source ledger includes the two language links, edition checks and coverage notes for every day. Run `bun scripts/freshwater-week.ts` for JSON or add `--markdown` to regenerate this review. [Source records](./)', '');
  return out.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--markdown')) throw new Error('Use freshwater-week.ts [--markdown].');
  const week = await freshwaterWeek();
  if (args.length) process.stdout.write(reviewMarkdown(week));
  else console.log(JSON.stringify(week, null, 2));
}
