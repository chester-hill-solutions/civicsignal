import { describe, expect, it } from 'vitest';
import { readCommitteeStudyBrief, responseState, prepareCommitteeStudyBrief,
  COMMITTEE_STUDY_BRIEF_PATH } from '../src/routes/committee-study';
import type { Env } from '../src/types';
import { committeeStudyOpenApi } from '../src/routes/committee-study-openapi';

describe('House ENVI freshwater study preview', () => {
  it('hides events and citations dated after the effective asOf date', async () => {
    const brief = await readCommitteeStudyBrief('en', '2026-09-24');
    expect(brief.asOf).toBe('2026-09-24');
    expect(brief.events.some((event) => event.type === 'government-response')).toBe(false);
    expect(brief.response).toMatchObject({ status: 'pending', requestDate: '2026-05-05', responseDate: null, deadline: '2026-09-25' });
    expect(brief.response.citations.every((citation) => citation.url !== 'https://www.ourcommons.ca/committees/en/ENVI/Work?parl=45&session=1')).toBe(true);
  });

  it('keeps the May 5 request out of earlier history and exposes its recorded state afterward', async () => {
    const april = await readCommitteeStudyBrief('en', '2026-05-04');
    const may = await readCommitteeStudyBrief('en', '2026-05-05');
    expect(april.events.some((event) => event.id === 'freshwater-report-adopted')).toBe(false);
    expect(april.response.status).toBe('no-request-in-record');
    expect(may.events.some((event) => event.id === 'freshwater-report-adopted')).toBe(true);
    expect(may.response).toMatchObject({ status: 'awaiting-presentation', requestDate: '2026-05-05', presentationDate: null });
    expect(may.response.citations.some((citation) => /Standing Order 109|article 109/i.test(citation.label))).toBe(true);
    expect(may.response.citations.some((citation) => citation.url.endsWith('/chap13-e.html'))).toBe(true);
    const mayFr = await readCommitteeStudyBrief('fr', '2026-05-05');
    expect(mayFr.response.citations.some((citation) => citation.url.endsWith('/chap13-f.html'))).toBe(true);
  });

  it('marks the official response fulfilled on its tabled date and localizes citations', async () => {
    const en = await readCommitteeStudyBrief('en', '2026-09-25');
    const fr = await readCommitteeStudyBrief('fr', '2026-09-25');
    expect(en.response).toMatchObject({ status: 'fulfilled', presentationDate: '2026-05-28', deadline: '2026-09-25', responseDate: '2026-09-25' });
    expect(en.study).toMatchObject({ parliament: 45, session: 1, committee: 'ENVI', studyActivityId: 13298665 });
    expect(en.events.some((event) => event.type === 'government-response')).toBe(true);
    expect(fr.study.title).not.toBe(en.study.title);
    expect(fr.publisher).not.toBe(en.publisher);
    expect(fr.events.map((event) => event.label)).not.toEqual(en.events.map((event) => event.label));
    expect(fr.response.citations.map((citation) => citation.label)).not.toEqual(en.response.citations.map((citation) => citation.label));
    expect(fr.events.map((event) => event.citations.map((citation) => citation.url))
      .some((urls, index) => JSON.stringify(urls) !== JSON.stringify(en.events[index]?.citations.map((citation) => citation.url)))).toBe(true);
  });

  it('computes the 120 calendar day boundary and handles dates before presentation', () => {
    expect(responseState('2026-09-24', '2026-05-05', '2026-05-28', null)).toMatchObject({ status: 'pending', deadline: '2026-09-25' });
    expect(responseState('2026-09-25', '2026-05-05', '2026-05-28', null)).toMatchObject({ status: 'pending', deadline: '2026-09-25' });
    expect(responseState('2026-09-26', '2026-05-05', '2026-05-28', null)).toMatchObject({ status: 'overdue', deadline: '2026-09-25' });
    expect(responseState('2026-05-04', '2026-05-05', null, '2026-09-25')).toMatchObject({ status: 'no-request-in-record', requestDate: null, presentationDate: null, responseDate: null });
    expect(responseState('2026-05-05', '2026-05-05', null, '2026-09-25')).toMatchObject({ status: 'awaiting-presentation', requestDate: '2026-05-05', presentationDate: null, responseDate: null });
  });

  it('uses a strict query contract, a checked coverage horizon, and the shared preview flag', async () => {
    const env = { BILL_PREVIEW: 'on' } as Env;
    const prepare = (query: string) => prepareCommitteeStudyBrief(new URL(`https://example.test${COMMITTEE_STUDY_BRIEF_PATH}${query}`));
    const defaultReader = prepare('?language=en')?.(env);
    expect(defaultReader).toBeTypeOf('function');
    expect((await defaultReader?.())?.asOf).toBe('2026-09-25');
    expect(prepare('?language=fr&asOf=2026-09-25')?.(env)).toBeTypeOf('function');
    expect(() => prepare('?language=en&asOf=2026-02-30')?.(env)).toThrow();
    expect(() => prepare('?language=en&asOf=2026-09-26')?.(env)).toThrow();
    expect(() => prepare('?language=en&language=fr')?.(env)).toThrow();
    expect(() => prepare('?language=en&extra=1')?.(env)).toThrow();
    expect(() => prepare('?language=en')?.({} as Env)).toThrow();
    const api = committeeStudyOpenApi();
    expect(api.paths[COMMITTEE_STUDY_BRIEF_PATH]?.get.operationId).toBe('getHouseEnviFreshwaterStudyBrief');
    expect(api.paths[COMMITTEE_STUDY_BRIEF_PATH]?.get.parameters[1]?.description).toContain('Defaults to the packet coverage date');
  });
});
