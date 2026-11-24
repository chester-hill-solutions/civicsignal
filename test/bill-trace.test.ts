import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayBillTrace } from '../scripts/lib/bill-trace-store';
import { CommitteePacketSchema } from '../src/corpora/bill-trace';
import { readBillBrief } from '../src/routes/bill-trace';
import { testD1 } from './helpers/d1';

const source = 'preview/bills/44-1-s-5';

describe('replaying the S-5 source record', () => {
  let fixture: ReturnType<typeof testD1>, directory: string;
  beforeEach(() => {
    fixture = testD1({ schema: '' });
    directory = mkdtempSync(join(tmpdir(), 'civicsignal-s5-'));
    cpSync(source, directory, { recursive: true });
  });
  afterEach(() => { fixture.close(); rmSync(directory, { recursive: true, force: true }); });
  function house() { return CommitteePacketSchema.parse(JSON.parse(readFileSync(join(directory, 'house.json'), 'utf8'))); }
  function setHouse(packet: unknown) { writeFileSync(join(directory, 'house.json'), JSON.stringify(packet)); }
  function eventCount() { return fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM bill_trace_events').get()?.n; }
  function replay() { return replayBillTrace(fixture.sqlite, directory); }

  it('links both editions of the same publications, committee decisions and the third-reading division', async () => {
    const first = replay();
    expect(first.missing).toEqual([]);
    expect(first.events).toBe(first.records);
    expect(replay()).toMatchObject({ events: 0, records: first.records });
    const en = await readBillBrief(fixture.db, 'en');
    const fr = await readBillBrief(fixture.db, 'fr');
    expect(en.bill).toMatchObject({ number: 'S-5', session: 1, parliament: 44, legisinfoId: 11558854 });
    expect(en.complete).toBe(true);
    const stages = en.records.filter((row) => row.kind === 'stage').map((row) => row.id);
    expect(stages).toHaveLength(12);
    expect(stages.indexOf('stage:senate:second-reading')).toBeLessThan(stages.indexOf('stage:senate:referral'));
    expect(stages.slice(-2)).toEqual(['stage:senate:concurrence', 'stage:royal-assent']);
    expect(fr.records.map((record) => record.id)).toEqual(en.records.map((record) => record.id));
    expect(fr.records.filter((record) => record.kind === 'version').map((record) => record.sourceId).sort())
      .toEqual(['11558861', '11903126', '12541741']);
    expect(fr.records.every((record) => record.links.every((edge) => edge.available))).toBe(true);
    for (const chamber of ['house', 'senate']) {
      const amendment = fr.records.find((record) => record.chamber === chamber && record.kind === 'amendment');
      expect(amendment?.links).toContainEqual(expect.objectContaining({ relation: 'reported-in' }));
      expect(amendment?.links).toContainEqual(expect.objectContaining({ relation: 'amends' }));
      expect(amendment?.amendment?.disposition).toBe('adopted');
      expect(fr.records.some((record) => record.chamber === chamber && record.witnesses?.length)).toBe(true);
    }
    expect(fr.records.find((record) => record.kind === 'vote')).toMatchObject({
      date: '2023-05-30', tally: { yeas: 208, nays: 116, paired: 0, result: 'agreed' },
    });
    const english = en.records.find((record) => record.id === 'house:study');
    const french = fr.records.find((record) => record.id === 'house:study');
    expect(french?.committee).toMatchObject({ acronym: 'ENVI', organizationId: 27181, name: expect.stringContaining('Comité') });
    expect(en.records.find((row) => row.id === 'senate:study')?.committee).toMatchObject({ acronym: 'ENEV', organizationId: 16096 });
    expect(french?.url).not.toBe(english?.url);
    expect(french?.label).not.toBe(english?.label);
  });

  it('reports a missing committee and restores its links without inventing record changes', async () => {
    replay();
    rmSync(join(directory, 'house.json'));
    expect(replay()).toMatchObject({ events: 0, missing: ['house'] });
    const brief = await readBillBrief(fixture.db, 'en');
    expect(brief.complete).toBe(false);
    expect(brief.coverage).toContainEqual({ source: 'house', status: 'missing', count: 0 });
    expect(brief.records.some((record) => record.source === 'house')).toBe(false);
    expect(brief.records.flatMap((record) => record.links)).toContainEqual(expect.objectContaining({ target: 'house:report', available: false }));
    cpSync(join(source, 'house.json'), join(directory, 'house.json'));
    expect(replay()).toMatchObject({ events: 0, missing: [] });
    expect((await readBillBrief(fixture.db, 'en')).complete).toBe(true);
  });

  it('rejects conflicting vote evidence, and identifies an unavailable Journal independently of the vote', async () => {
    const { events } = replay();
    const journalFile = join(directory, 'journals.json');
    const packet = JSON.parse(readFileSync(journalFile, 'utf8')) as { records: { id: string; division?: { yeas: number } }[] };
    const row = packet.records.find((item) => item.id === 'journal:house-202');
    if (!row?.division) throw new Error('Missing official House division.');
    row.division.yeas++;
    writeFileSync(journalFile, JSON.stringify(packet));
    expect(replay).toThrow();
    expect(eventCount()).toBe(events);
    rmSync(journalFile);
    expect(replay()).toMatchObject({ events: 0, missing: ['journals'] });
    const partial = await readBillBrief(fixture.db, 'fr');
    expect(partial.complete).toBe(false);
    expect(partial.records.find((item) => item.kind === 'vote')?.tally?.yeas).toBe(208);
    expect(partial.records.some((item) => item.kind === 'journal')).toBe(false);
  });

  it('ignores input ordering, records one correction, and preserves the last committed brief on failure', async () => {
    const initial = replay();
    const packet = house();
    for (const record of packet.records) record.links.reverse();
    packet.records.reverse();
    setHouse(packet);
    expect(replay().events).toBe(0);
    const selected = packet.records.find((record) => record.id === 'house:study');
    if (!selected) throw new Error('Missing House study in test packet.');
    selected.label.fr += ' (correction de test)';
    setHouse(packet);
    expect(replay().events).toBe(1);
    expect(eventCount()).toBe(initial.events + 1);
    fixture.sqlite.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON bill_trace_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    selected.label.fr = 'Autre correction';
    setHouse(packet);
    await expect(Promise.resolve().then(replay)).rejects.toThrow('fixture failure');
    expect((await readBillBrief(fixture.db, 'fr')).records.find((record) => record.id === selected.id)?.label).toContain('correction de test');
    expect(eventCount()).toBe(initial.events + 1);
  });

  it('rejects a wrong bill, duplicate identity or unresolved link before modifying storage', () => {
    const { events } = replay();
    const packet = house();
    setHouse({ ...packet, session: 2 });
    expect(replay).toThrow();
    const [record] = packet.records;
    if (!record) throw new Error('Missing test record.');
    setHouse({ ...packet, records: [...packet.records, record] });
    expect(replay).toThrow('Duplicate bill trace ID');
    record.links.push({ relation: 'documents', target: 'house:missing' });
    setHouse(packet);
    expect(replay).toThrow('Unresolved bill trace link');
    expect(eventCount()).toBe(events);
  });
});
