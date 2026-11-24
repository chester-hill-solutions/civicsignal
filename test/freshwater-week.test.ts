import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshwaterWeek, reviewMarkdown } from '../scripts/freshwater-week';

describe('review of the federal freshwater file for May 25–29', () => {
  it('keeps the action clock and the amendment reminder on their proper dates', async () => {
    const days = await freshwaterWeek();
    expect(days.map(day => day.date)).toEqual(['2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29']);
    expect(days.map(day => day.response.deadline)).toEqual([null, null, null, '2026-09-25', '2026-09-25']);
    expect(days.every(day => day.response.responseDate === null)).toBe(true);
    const cutoff = days.map(day => day.actions.find(action => action.kind === 'committee-amendments'));
    expect(cutoff.map(action => action?.status)).toEqual([undefined, 'open', 'open', 'cutoff-passed', undefined]);
    expect(cutoff[1]?.dueAt).toBe('2026-05-28T16:00:00-04:00');
  });

  it('counts one presentation for Hansard and the Journals and carries coverage for every day', async () => {
    const week = await freshwaterWeek();
    expect(week.map(day => [day.events.length, day.related.length])).toEqual([[0, 1], [2, 0], [0, 0], [3, 0], [1, 1]]);
    for (const day of week) {
      expect(day.coverage).toHaveLength(5);
      expect(new Set(day.events.map(event => event.id)).size).toBe(day.events.length);
      for (const event of day.events) expect(event.citations.length).toBeGreaterThan(0);
    }
    const presentations = week.flatMap(day => day.events.filter(event => event.id === 'freshwater-report-presented'));
    expect(presentations).toHaveLength(1);
    expect(presentations[0]?.citations.map(c => c.source)).toEqual(['House Journals', 'Recommendations', 'House debates']);
    expect(week[0]?.related[0]?.title).toContain('Q-1010');
    expect(week[4]?.related.map(event => event.id)).toContain('groundwater-hatchery-investment');
    expect(week[4]?.coverage.find(c => c.name === 'Senate debates')?.status).toBe('no-sitting');
  });

  it('reproduces the staffer review from the checked-in source packets', async () => {
    const saved = readFileSync('preview/policy-files/freshwater-2026-05-25/BRIEFS.md', 'utf8');
    expect(reviewMarkdown(await freshwaterWeek())).toBe(saved);
  });
});
