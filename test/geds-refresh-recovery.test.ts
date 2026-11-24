import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { sha256Hex } from '../src/geds/hash';
import { refreshGeds } from '../src/geds/refresh';
import { getPerson, getPersonContact, readContext, searchOrganizations, searchPeople } from '../src/geds/repository';
import { fixtureBytes, gedsDatabase, refreshFixture, required } from './helpers/geds';

const january = '2026-01-01T00:00:00.000Z';
const february = '2026-02-01T00:00:00.000Z';
const march = '2026-03-01T00:00:00.000Z';

function editedTelephone(): Uint8Array {
  const source = Buffer.from(fixtureBytes('snapshot-a.csv')).toString('latin1');
  return Buffer.from(source.replace('613-555-0101', '613-555-0199'), 'latin1');
}

describe('GEDS refresh recovery', () => {
  it('discards a different interrupted original before a new snapshot can expose its versions', async () => {
    const { db, raw, archive } = gedsDatabase();
    const first = await refreshFixture(db, archive, 'snapshot-a.csv', january);
    const moved = fixtureBytes('snapshot-b.csv');
    async function* interruptedSource() {
      yield moved;
      throw new Error('input stream interrupted');
    }

    await expect(refreshGeds({
      db, archive, now: new Date(february), csvStream: interruptedSource(), zipSha256: sha256Hex(moved),
    })).rejects.toThrow('input stream interrupted');
    const abandoned = raw.prepare("SELECT seq FROM geds_snapshots WHERE status = 'building'").get();
    const abandonedSeq = Number(required(abandoned).seq);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM geds_roles WHERE valid_from_seq = ?').get(abandonedSeq))
      .toEqual({ n: 1 });
    expect((await readContext(db, {})).snapshot.seq).toBe(first.snapshot?.seq);

    const replacement = await refreshGeds({ db, archive, now: new Date(march), csvBytes: editedTelephone() });
    const current = await readContext(db, {});
    expect(current.snapshot.seq).toBe(replacement.snapshot?.seq);
    expect(raw.prepare('SELECT status FROM geds_snapshots WHERE seq = ?').get(abandonedSeq))
      .toEqual({ status: 'discarded' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM geds_changes WHERE seq = ?').get(abandonedSeq))
      .toEqual({ n: 0 });
    const programs = await searchOrganizations(current, { q: 'Programs Branch' });
    expect(programs.items).toHaveLength(0);

    const jordan = required((await searchPeople(current, { q: 'Jordan Lee' })).items[0]);
    const currentPerson = await getPerson(current, jordan.id);
    expect(currentPerson.roles).toHaveLength(1);
    expect(jordan.contact?.value).toBe('613-555-0199');
    const oldContext = await readContext(db, { asOf: january });
    const historical = await getPerson(oldContext, jordan.id);
    expect(historical.roles).toHaveLength(1);
    expect((await getPersonContact(oldContext, jordan.id, {})).contact?.value).toBe('613-555-0101');
    raw.close();
  });

  it('records a new ZIP containing the same CSV without changing the publication', async () => {
    const { db, raw, archive } = gedsDatabase();
    const first = await refreshFixture(db, archive, 'snapshot-a.csv', january);
    const csv = fixtureBytes('snapshot-a.csv');
    const zipBytes = new Uint8Array(30 + csv.length);
    const header = new DataView(zipBytes.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint32(14, crc32(csv), true);
    header.setUint32(18, csv.length, true);
    header.setUint32(22, csv.length, true);
    zipBytes.set(csv, 30);

    const repack = await refreshGeds({ db, archive, zipBytes, now: new Date(february) });
    expect(repack.changed).toBe(false);
    expect(repack.snapshot).toEqual(first.snapshot);
    expect(repack.observation.zipSha256).not.toBe(first.observation.zipSha256);
    expect(repack.observation.csvSha256).toBe(first.observation.csvSha256);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM geds_observations WHERE changed = 0").get()).toEqual({ n: 1 });
    expect(raw.prepare("SELECT COUNT(DISTINCT last_seen_seq) AS n FROM geds_roles").get()).toEqual({ n: 1 });
    raw.close();
  });

  it('measures each published language field and retains the coverage on replays', async () => {
    const { db, raw, archive } = gedsDatabase();
    const source = Buffer.from(fixtureBytes('snapshot-a.csv')).toString('latin1')
      .replace(',Analyste principal,', ',,')
      .replaceAll(',Example Department,', ',,')
      .replace(',Bureau principal,', ',,');
    const csvBytes = Buffer.from(source, 'latin1');
    const published = await refreshGeds({ db, archive, csvBytes, now: new Date(january) });
    const expectedCoverage = {
      en: { rows: 4, title: 4, department: 0, organization: 4 },
      fr: { rows: 4, title: 3, department: 4, organization: 3 },
    };
    expect(published.languageCoverage).toEqual(expectedCoverage);
    const key = required(published.snapshot?.manifestKey);
    expect(await archive.getJson(key)).toMatchObject({ languageCoverage: expectedCoverage });

    const archivedReplay = await refreshGeds({ db, archive, csvBytes, now: new Date(february) });
    const plainReplay = await refreshGeds({ db, csvBytes, now: new Date(march) });
    for (const replay of [archivedReplay, plainReplay]) {
      expect(replay.changed).toBe(false);
      expect(replay.counts.officeListings).toBe(published.counts.officeListings);
      expect(replay.languageCoverage).toEqual(expectedCoverage);
      expect(replay.missing).toEqual(published.missing);
      expect(replay.unresolved).toEqual(published.unresolved);
    }
    raw.close();
  });

  it('resumes the same original and includes checkpointed rows in its measurements', async () => {
    const { db, raw, archive } = gedsDatabase();
    await refreshFixture(db, archive, 'snapshot-a.csv', january);
    const [header, firstRow] = Buffer.from(fixtureBytes('snapshot-a.csv')).toString('latin1').split('\r\n');
    const csvBytes = Buffer.from([required(header), ...Array<string>(501).fill(required(firstRow)), ''].join('\r\n'), 'latin1');
    const input = { db, archive, csvBytes, now: new Date(february) };

    await expect(refreshGeds({
      ...input,
      onProgress(rows) {
        if (rows === 500) throw new Error('stopped after checkpoint');
      },
    })).rejects.toThrow('stopped after checkpoint');
    expect(raw.prepare("SELECT last_row_no FROM geds_snapshots WHERE status = 'building'").get())
      .toEqual({ last_row_no: 500 });

    const completed = await refreshGeds({ ...input, now: new Date(march) });
    expect(completed.resume).toEqual({ resumed: true, lastRowNo: 500 });
    expect(completed.snapshot).toMatchObject({ effectiveAt: february, publishedAt: march });
    expect(completed.counts).toMatchObject({ sourceRows: 501, unchanged: 501, roles: 1 });
    expect(completed.duplicateRoleKeys).toBe(500);
    raw.close();
  });

  it('rolls back version closure and the observation when the publication fails', async () => {
    const { db, raw, archive } = gedsDatabase();
    const first = await refreshFixture(db, archive, 'snapshot-a.csv', january);
    raw.exec(`CREATE TRIGGER reject_geds_publication BEFORE UPDATE OF status ON geds_snapshots
      WHEN NEW.status = 'published' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END`);

    await expect(refreshFixture(db, archive, 'snapshot-b.csv', february)).rejects.toThrow('publication interrupted');
    expect((await readContext(db, {})).snapshot.seq).toBe(first.snapshot?.seq);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM geds_roles WHERE valid_to_seq IS NOT NULL').get())
      .toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM geds_observations').get())
      .toEqual({ n: 1 });

    raw.exec('DROP TRIGGER reject_geds_publication');
    const second = await refreshFixture(db, archive, 'snapshot-b.csv', march);
    expect(second.resume.resumed).toBe(true);
    expect((await readContext(db, {})).snapshot.seq).toBe(second.snapshot?.seq);
    raw.close();
  });

  it('prevents a build from writing or publishing after another adapter takes its place', async () => {
    const { db, raw, archive } = gedsDatabase();
    await refreshFixture(db, archive, 'snapshot-a.csv', january);
    const otherDb = { prepare: db.prepare.bind(db), exec: raw.exec.bind(raw) };
    const moved = fixtureBytes('snapshot-b.csv');
    async function* supersededSource() {
      const midpoint = moved.indexOf(10, moved.indexOf(10) + 1) + 1;
      yield moved.subarray(0, midpoint);
      await expect(refreshGeds({ db, csvBytes: editedTelephone() })).rejects.toThrow('already running');
      await refreshGeds({ db: otherDb, archive, now: new Date(march), csvBytes: editedTelephone() });
      yield moved.subarray(midpoint);
    }

    await expect(refreshGeds({
      db, archive, now: new Date(february), csvStream: supersededSource(), zipSha256: sha256Hex(moved),
    })).rejects.toThrow('publication base changed');
    const current = await readContext(db, {});
    expect(current.snapshot.effective_at).toBe(march);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM geds_roles r
      JOIN geds_snapshots s ON s.seq = r.valid_from_seq WHERE s.status = 'discarded'`).get()).toEqual({ n: 0 });
    raw.close();
  });
});
