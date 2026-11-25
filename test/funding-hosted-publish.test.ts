import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeFunding } from '../scripts/materialize-funding';
import { publishFunding } from '../services/funding/publish';
import { testD1 } from './helpers/d1';

const migration = (file: string) => readFileSync(`preview/funding/migrations/${file}.sql`, 'utf8');
const schema = migration('0001_funding') + migration('0002_funding_commit_guard');
const close: Array<() => void> = [];
function open(schema: string) {
  const f = testD1({ schema });
  close.push(f.close);
  return f;
}
afterEach(() => { while (close.length) close.pop()?.(); });

function inventory(day: number, programs: string[], change = '', source: 'nserc' | 'esdc' = 'nserc') {
  const origin = source === 'nserc' ? 'https://nserc.canada.ca' : 'https://www.canada.ca';
  return {
    source, observedAt: `2026-11-${day}T12:00:00Z`,
    indexes: { en: origin + '/en/', fr: origin + '/fr/' }, gaps: [],
    records: programs.flatMap(program => ['en', 'fr'].map(language => {
      const url = `${origin}/${language}/${program}`;
      return { id: source + '-' + program, language, url, title: program, availability: 'published', status: 'ongoing', statusText: null,
        sections: [{ field: 'eligibility', heading: language === 'fr' ? 'Admissibilité' : 'Eligibility', url,
          text: program === 'alpha' && language === 'en' ? 'Eligible institutions' + change : 'Existing terms' }] };
    })),
  };
}

function compare(local: ReturnType<typeof open>, hosted: ReturnType<typeof open>) {
  for (const [table, order] of [['funding_catalogues', 'source'], ['funding_editions', 'id,language'],
    ['funding_sections', 'id,language,section_index'], ['funding_versions', 'id,language,observed_at']]) {
    const select = `SELECT * FROM ${table} ORDER BY ${order}`;
    expect(hosted.sqlite.prepare(select).all()).toEqual(local.sqlite.prepare(select).all());
  }
}

describe('private D1 funding publication', () => {
  it('matches all serving tables and recorded changes across replacements and replays', async () => {
    const local = open(''), hosted = open(schema);
    for (const payload of [inventory(20, ['alpha', 'beta']), inventory(21, ['beta', 'alpha']),
      inventory(22, ['alpha', 'gamma'], ' revised'), inventory(23, ['alpha', 'beta'])]) {
      const expected = materializeFunding(local.sqlite, payload);
      expect(await publishFunding(hosted.db, 'nserc', payload)).toMatchObject(expected);
      compare(local, hosted);
    }
    const same = inventory(23, ['alpha', 'beta']);
    expect(await publishFunding(hosted.db, 'nserc', same)).toMatchObject({ replayed: true, rowsWritten: 0 });
    await expect(publishFunding(hosted.db, 'nserc', inventory(23, ['alpha']))).rejects.toThrow('conflicting');
    await expect(publishFunding(hosted.db, 'nserc', inventory(20, ['alpha']))).rejects.toThrow('newer');
  });

  it('keeps the previous serving state when the commit fails and reuses private deltas on retry', async () => {
    const local = open(''), hosted = open(schema);
    const before = inventory(20, ['alpha']);
    materializeFunding(local.sqlite, before);
    await publishFunding(hosted.db, 'nserc', before);
    hosted.sqlite.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON funding_catalogues BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    const after = inventory(21, ['alpha', 'beta']);
    await expect(publishFunding(hosted.db, 'nserc', after)).rejects.toThrow('injected failure');
    compare(local, hosted);
    expect(hosted.sqlite.prepare('SELECT COUNT(*) AS n FROM funding_pending_editions').get()?.n).toBe(2);
    hosted.sqlite.exec('DROP TRIGGER fail_publication');
    materializeFunding(local.sqlite, after);
    await publishFunding(hosted.db, 'nserc', after);
    compare(local, hosted);
    expect(hosted.sqlite.prepare('SELECT COUNT(*) AS n FROM funding_pending_editions').get()?.n).toBe(0);
  });

  it('rejects a diff whose head moved and recomputes it on retry', async () => {
    const local = open(''), hosted = open(schema);
    const older = inventory(20, ['alpha']), newer = inventory(21, ['beta']), latest = inventory(22, ['gamma']);
    await publishFunding(hosted.db, 'nserc', older);
    const batch = hosted.db.batch.bind(hosted.db);
    hosted.db.batch = async statements => {
      hosted.db.batch = batch;
      await publishFunding(hosted.db, 'nserc', newer);
      return batch(statements);
    };
    await expect(publishFunding(hosted.db, 'nserc', latest)).rejects.toThrow(/CHECK/);
    for (const packet of [older, newer]) materializeFunding(local.sqlite, packet);
    compare(local, hosted);
    await publishFunding(hosted.db, 'nserc', latest);
    materializeFunding(local.sqlite, latest);
    compare(local, hosted);
  });

  it('checks the expected source before touching either catalogue', async () => {
    const hosted = open(schema);
    await expect(publishFunding(hosted.db, 'esdc', inventory(20, ['alpha']))).rejects.toThrow('esdc');
    expect(hosted.sqlite.prepare('SELECT COUNT(*) AS n FROM funding_catalogues').get()?.n).toBe(0);
  });

  it('publishes ESDC deltas beside NSERC without changing the NSERC serving rows or history', async () => {
    const local = open(''), hosted = open(schema);
    const nserc = inventory(20, ['alpha', 'beta']);
    materializeFunding(local.sqlite, nserc);
    await publishFunding(hosted.db, 'nserc', nserc);
    for (const esdc of [inventory(20, ['alpha', 'beta'], '', 'esdc'), inventory(21, ['alpha', 'gamma'], ' revised', 'esdc')]) {
      materializeFunding(local.sqlite, esdc);
      await publishFunding(hosted.db, 'esdc', esdc);
      compare(local, hosted);
    }
    expect(hosted.sqlite.prepare("SELECT COUNT(*) AS n FROM funding_versions WHERE source='nserc'").get()?.n).toBe(4);
  });

  const archived = process.env.CIVICSIGNAL_NSERC_FUNDING_REFERENCE;
  it.skipIf(!archived)('matches every column of the acquired NSERC catalogue and leaves zero duplicate history on replay', async () => {
    if (!archived) throw new Error('Missing NSERC reference.');
    const local = open(''), hosted = open(schema);
    const packet = JSON.parse(readFileSync(archived, 'utf8'));
    const expected = materializeFunding(local.sqlite, packet);
    expect(await publishFunding(hosted.db, 'nserc', packet)).toMatchObject(expected);
    expect(await publishFunding(hosted.db, 'nserc', packet)).toMatchObject({ replayed: true, rowsWritten: 0 });
    compare(local, hosted);
  });
});
