import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { firstValue } from '../src/geds/db';
import {
  getOrganizationPeople,
  getPerson,
  getPersonContact,
  readContext,
  searchOrganizations,
  searchPeople,
} from '../src/geds/repository';
import { gedsDatabase, refreshFixture, required } from './helpers/geds';

async function count(db: ReturnType<typeof gedsDatabase>['db'], sql: string) {
  return Number((await firstValue<{ n: number }>(db, sql))?.n ?? 0);
}

describe('GEDS refresh, snapshots and historical reads', () => {
  it('creates and reapplies the GEDS schema on an existing CivicSignal database', () => {
    const { raw } = gedsDatabase({ includeGedsMigration: false });
    const migration = readFileSync(new URL('../preview/geds/migrations/0010_geds.sql', import.meta.url), 'utf8');
    raw.exec(migration);
    raw.exec(migration);
    const table = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'geds_snapshots'").get();
    expect(table).toBeTruthy();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM geds_snapshots').get()).toEqual({ count: 0 });
    raw.close();
  });

  it('imports, resolves both languages, and keeps an earlier role after a move', async () => {
    const { db, archive } = gedsDatabase();
    const a = await refreshFixture(db, archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
    expect(a.changed).toBe(true);
    expect(a.counts.sourceRows).toBe(4);
    expect(a.counts.people).toBe(3);
    expect(a.counts.officeListings).toBe(1);
    expect(a.counts.roles).toBe(4);
    expect(a.languageCoverage.en.title).toBe(4);
    expect(a.languageCoverage.fr.title).toBe(4);
    expect(a.observation.archived).toBe(true);

    const english = await searchOrganizations(await readContext(db, { lang: 'en' }), {
      q: 'Corporate Management Branch',
    });
    const french = await searchOrganizations(await readContext(db, { lang: 'fr' }), {
      q: 'Direction générale de la gestion intégrée',
    });
    expect(english.items).toHaveLength(1);
    expect(french.items).toHaveLength(1);
    expect(required(english.items[0]).id).toBe(required(french.items[0]).id);
    expect(required(french.items[0]).name).toBe('Direction générale de la gestion intégrée');

    const people = await searchPeople(await readContext(db, { lang: 'en' }), { q: 'Jordan Lee' });
    expect(people.items).toHaveLength(1);
    const jordan = required(people.items[0]);
    const jordanId = jordan.id;
    expect(jordan.contact?.value).toBe('613-555-0101');
    expect(jordan.contact?.citation.text).toContain('GEDS');
    expect(jordan.contact?.citation.resourceUrl).toContain('gedsOpenData.zip');

    const b = await refreshFixture(db, archive, 'snapshot-b.csv', '2026-02-01T00:00:00Z');
    expect(b.changed).toBe(true);
    expect(b.counts.removed).toBe(1);
    expect(b.counts.added).toBeGreaterThanOrEqual(1);

    const afterMove = await searchPeople(await readContext(db, { lang: 'en' }), { q: 'Jordan Lee' });
    expect(afterMove.items).toHaveLength(1);
    const movedJordan = required(afterMove.items[0]);
    expect(movedJordan.id).toBe(jordanId);
    expect(movedJordan.title.en).toBe('Manager, Programs');
    expect(movedJordan.organization.name).toBe('Programs Branch');

    const old = await readContext(db, { lang: 'en', asOf: '2026-01-15' });
    const oldPerson = await getPerson(old, jordanId);
    expect(oldPerson.roles).toHaveLength(1);
    expect(required(oldPerson.roles[0]).title.en).toBe('Senior Analyst');
    expect(required(oldPerson.roles[0]).organization.name).toBe('Corporate Management Branch');

    const oldContact = await getPersonContact(old, jordanId, {});
    expect(oldContact.contact?.value).toBe('613-555-0101');
    expect(oldContact.reachedVia).toBe('direct');

    const newContact = await getPersonContact(await readContext(db, { lang: 'en' }), jordanId, {});
    expect(newContact.contact?.value).toBe('613-555-0201');
    expect(newContact.contact?.citation.asOf).toBeTruthy();
  });

  it('replays the same export with stable ids, zero new snapshots and zero change events', async () => {
    const { db, archive } = gedsDatabase();
    await refreshFixture(db, archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
    await refreshFixture(db, archive, 'snapshot-b.csv', '2026-02-01T00:00:00Z');
    const snapshotsBefore = await count(db, 'SELECT COUNT(*) AS n FROM geds_snapshots');
    const changesBefore = await count(db, 'SELECT COUNT(*) AS n FROM geds_changes');
    const rolesBefore = await count(db, 'SELECT COUNT(*) AS n FROM geds_roles');
    const peopleBefore = await count(db, 'SELECT COUNT(*) AS n FROM geds_persons');

    const replay = await refreshFixture(db, archive, 'snapshot-b.csv', '2026-03-01T00:00:00Z');
    expect(replay.changed).toBe(false);
    expect(replay.counts.changes).toBe(0);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM geds_snapshots')).toBe(snapshotsBefore);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM geds_changes')).toBe(changesBefore);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM geds_roles')).toBe(rolesBefore);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM geds_persons')).toBe(peopleBefore);
  });

  it('distinguishes same-name people and returns a unit with only a general office number', async () => {
    const { db, archive } = gedsDatabase();
    await refreshFixture(db, archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
    const smiths = await searchPeople(await readContext(db, { lang: 'en' }), { q: 'Alex Smith' });
    expect(smiths.items).toHaveLength(2);
    expect(required(smiths.items[0]).id).not.toBe(required(smiths.items[1]).id);
    expect(required(smiths.items[0]).email).not.toBe(required(smiths.items[1]).email);

    const office = await searchOrganizations(await readContext(db, { lang: 'en' }), {
      q: 'General Office',
    });
    expect(office.items).toHaveLength(1);
    const people = await getOrganizationPeople(await readContext(db, { lang: 'en' }), required(office.items[0]).id, {});
    expect(people.items).toHaveLength(0);
    expect(people.officeContact).not.toBeNull();
    const officeContact = required(people.officeContact);
    const contact = required(officeContact.contact);
    expect(contact.isGeneralOffice).toBe(true);
    expect(contact.label).toContain('General office');
    expect(contact.citation.text).toContain('613-555-0100');
  });

  it('rejects an asOf before the first observation rather than inventing a state', async () => {
    const { db, archive } = gedsDatabase();
    await refreshFixture(db, archive, 'snapshot-a.csv', '2026-01-01T00:00:00Z');
    await expect(readContext(db, { asOf: '2025-01-01' })).rejects.toMatchObject({
      code: 'NO_SNAPSHOT_AS_OF',
      status: 404,
    });
  });
});
