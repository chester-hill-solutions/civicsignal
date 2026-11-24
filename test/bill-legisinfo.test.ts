import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBillSpine } from '../scripts/lib/bill-legisinfo';

const fixture = fileURLToPath(new URL('../preview/bills/44-1-s-5/', import.meta.url));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('official S-5 bill spine projection', () => {
  it('derives version and stage records from the compact LEGISinfo field projection', () => {
    const rows = loadBillSpine(fixture, 'legisinfo');
    expect(rows.map((row) => row.id)).toContain('version:first-reading');
    expect(rows.map((row) => row.id)).toContain('version:senate-passed');
    expect(rows.map((row) => row.id)).toContain('version:royal-assent');
    expect(rows.map((row) => row.id)).not.toContain('version:house-committee');
    expect(rows.find((row) => row.id === 'stage:senate:referral')).toMatchObject({
      sourceId: '60123', date: '2022-04-07', chamber: 'senate',
      links: expect.arrayContaining([{ relation: 'referred-to', target: 'senate:study' }]),
    });
    expect(rows.find((row) => row.id === 'stage:house:second-reading')?.links).toContainEqual({
      relation: 'referred-to', target: 'house:study',
    });
    expect(rows.find((row) => row.id === 'stage:house:committee')?.links).toContainEqual({
      relation: 'precedes', target: 'stage:house:report',
    });
    expect(rows.find((row) => row.id === 'version:senate-passed')?.url).toMatchObject({
      en: 'https://www.parl.ca/DocumentViewer/en/44-1/bill/S-5/third-reading',
      fr: 'https://www.parl.ca/documentviewer/fr/44-1/projet-loi/S-5/troisieme-lecture',
    });
  });

  it('uses Vote 338 structured fields and bilingual Journals as independent passage evidence', () => {
    const vote = loadBillSpine(fixture, 'vote')[0];
    expect(vote).toMatchObject({
      id: 'vote:338', sourceId: '338', date: '2023-05-30',
      tally: { yeas: 208, nays: 116, paired: 0, result: 'agreed' },
    });
    const journals = loadBillSpine(fixture, 'journals');
    const house = journals.find((row) => row.id === 'journal:house-202');
    expect(house?.url.en).toContain('/sitting-202/journals');
    expect(house?.url.fr).toContain('/seance-202/journaux');
    expect(house?.division).toEqual({ number: 338, yeas: 208, nays: 116, paired: 0, result: 'agreed' });
    expect(journals.find((row) => row.id === 'journal:senate-133')?.links).toContainEqual({
      relation: 'reports-on', target: 'stage:senate:concurrence',
    });
  });

  it('can load one source group at a time and reports missing input with ENOENT', () => {
    expect(loadBillSpine(fixture, 'legisinfo').length).toBeGreaterThan(0);
    const empty = mkdtempSync(join(tmpdir(), 's5-spine-'));
    temporary.push(empty);
    expect(() => loadBillSpine(empty, 'vote')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
