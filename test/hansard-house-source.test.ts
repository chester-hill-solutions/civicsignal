import { describe, expect, it, vi } from 'vitest';
import { discoverHouseHansardWeek, fetchHouseHansardEdition, parseHouseHansardCalendar }
  from '../scripts/lib/hansard-house-source';
import { hansardWeekDates } from '../scripts/lib/hansard-week';

const weekOf = '2026-04-20';
const session = '45-1';
const dates = hansardWeekDates(weekOf);

function calendar(links: Record<string, string> = {}, shown = dates, replacements: Record<string, string> = {}) {
  const cells = shown.map((date) => {
    if (replacements[date]) return replacements[date];
    const link = links[date];
    return `<td class="${link ? 'chamber-meeting ' : ' '}"><div><div class="${date}">` +
      (link ? `<a href="${link}"><div class="date">${date.slice(-2)}</div></a>` : '') +
      '</div></div></td>';
  });
  return `<table class="publications-calendar"><tbody><tr>${cells.join('')}</tr></tbody></table>`;
}

function tablingCell(link = '', day = '22', classes = ' ') {
  const visibleDay = `<div class="date">${day}</div>`;
  const body = link ? `<a ${link}>${visibleDay}</a>` : visibleDay;
  return `<td class="${classes}"><div><div class="adjournment-tabling">${body}</div></div></td>`;
}

const tabledJournal = 'href="/documentviewer/en/45-1/house/sitting-106A/journals" ' +
  'aria-label="April 22, 2026 Adjournment tabling link to publication"';

describe('official House Hansard source', () => {
  it('discovers one covered week and keeps sitting entries with a fallback publication link', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(calendar({
      '2026-04-20': '/documentviewer/en/45-1/house/sitting-106/hansard',
      '2026-04-23': '/documentviewer/en/45-1/house/sitting-109/order-notice',
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    expect(await discoverHouseHansardWeek(session, weekOf, send)).toEqual({
      weekOf,
      sittings: [
        { sittingId: '45-1-106', sittingDate: '2026-04-20' },
        { sittingId: '45-1-109', sittingDate: '2026-04-23' },
      ],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toBe(
      'https://www.ourcommons.ca/documentviewer/en/SessionPublicationCalendarsWidget?organization=HOC&publicationTypeId=37&parliament=45&session=1',
    );
  });

  it('requires all dates and refuses a sitting from a different session', () => {
    expect(parseHouseHansardCalendar(calendar(), session, weekOf).sittings).toEqual([]);
    expect(() => parseHouseHansardCalendar(calendar({}, dates.slice(0, -1)), session, weekOf))
      .toThrow('coverage');
    expect(() => parseHouseHansardCalendar(calendar({ [weekOf]: '/documentviewer/en/44-1/house/sitting-16/hansard' }), session, weekOf))
      .toThrow('Could not identify');
  });

  it('counts a dated adjournment tabling as a covered day without a Hansard sitting', () => {
    const html = calendar({ [weekOf]: '/documentviewer/en/45-1/house/sitting-106/hansard' }, dates,
      { '2026-04-22': tablingCell(tabledJournal) });
    expect(parseHouseHansardCalendar(html, session, weekOf)).toEqual({
      weekOf, sittings: [{ sittingDate: weekOf, sittingId: '45-1-106' }],
    });
  });

  it('dates an unlinked tabling cell only between matching adjacent dates in the same row', () => {
    const cell = tablingCell();
    const html = calendar({}, dates, { '2026-04-22': cell });
    expect(parseHouseHansardCalendar(html, session, weekOf)).toEqual({ weekOf, sittings: [] });
    expect(() => parseHouseHansardCalendar(html.replace(cell, '</tr><tr>' + cell), session, weekOf)).toThrow('coverage');
    expect(() => parseHouseHansardCalendar(html.replace(cell, tablingCell('', '23')), session, weekOf)).toThrow('coverage');
  });

  it.each([
    tabledJournal.replace('45-1', '44-1'),
    tabledJournal.replace('April 22', 'April 23'),
    tabledJournal.replace('April 22', 'May 22'),
    tabledJournal.replace('106A/journals', '106/hansard'),
  ])('refuses an inconsistent tabling link without inferring its date', (link) => {
    const html = calendar({}, dates, { '2026-04-22': tablingCell(link) });
    expect(() => parseHouseHansardCalendar(html, session, weekOf)).toThrow('coverage');
  });

  it('refuses duplicate dates and a tabling cell also marked as a chamber meeting', () => {
    const duplicate = calendar({}, [...dates, weekOf]);
    expect(() => parseHouseHansardCalendar(duplicate, session, weekOf)).toThrow('Duplicate date');
    const conflicting = calendar({}, dates, { '2026-04-22': tablingCell(tabledJournal, '22', 'chamber-meeting') });
    expect(() => parseHouseHansardCalendar(conflicting, session, weekOf)).toThrow('Conflicting adjournment');
  });

  it('refuses the current week before requesting the calendar', async () => {
    const send = vi.fn<typeof fetch>();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Midnight in UTC is still Sunday in Ottawa.
      vi.setSystemTime(new Date('2026-04-27T01:00:00Z'));
      await expect(discoverHouseHansardWeek(session, weekOf, send)).rejects.toThrow('completed');
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pads the sitting path and selects the requested XML edition', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response('<Hansard/>', { headers: { 'Content-Type': 'text/xml' } }));
    const bytes = await fetchHouseHansardEdition({ sittingId: '45-1-1', sittingDate: weekOf, edition: 'fr' }, send);
    expect(new TextDecoder().decode(bytes!)).toBe('<Hansard/>');
    expect(String(send.mock.calls[0]![0])).toBe('https://www.ourcommons.ca/Content/House/451/Debates/001/HAN001-F.XML');
  });

  it('reports an actual House 404 as absent and treats an unexpected response as a failure', async () => {
    const sitting = { sittingId: '45-1-106', sittingDate: weekOf, edition: 'en' } as const;
    await expect(fetchHouseHansardEdition(sitting, async () => new Response(null, { status: 404 }))).resolves.toBeNull();
    await expect(fetchHouseHansardEdition(sitting, async () => new Response(null, {
      status: 302, headers: { Location: '/ErrorPage/Default.aspx?StatusCode=404' },
    }))).resolves.toBeNull();
    await expect(fetchHouseHansardEdition(sitting, async () => new Response(null, {
      status: 302, headers: { Location: 'https://example.test/ErrorPage/Default.aspx?StatusCode=404' },
    }))).rejects.toThrow('HTTP 302');
    await expect(fetchHouseHansardEdition(sitting, async () => new Response('Error page', {
      headers: { 'Content-Type': 'text/html' },
    }))).rejects.toThrow('text/html');
  });
});
