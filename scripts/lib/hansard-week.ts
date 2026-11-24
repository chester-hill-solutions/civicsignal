import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { HansardLanguage } from '../../src/corpora/hansard';
import { MAX_HANSARD_XML_BYTES } from '../../src/ingest/hansard';
import { importHansardEdition } from './hansard-store';

const sittingFields = {
  sittingId: z.string().regex(/^[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*$/u),
  sittingDate: z.iso.date(),
};
const week = z.strictObject({
  weekOf: z.iso.date(),
  sittings: z.array(z.strictObject(sittingFields)),
});
const file = z.string().trim().min(1).nullable();
const localWeek = z.strictObject({
  weekOf: z.iso.date(),
  sittings: z.array(z.strictObject({ ...sittingFields, en: file, fr: file })),
});
type HansardWeek = z.infer<typeof week>;
export type HansardSittingRef = HansardWeek['sittings'][number];
type ExpectedEdition = HansardSittingRef & { edition: HansardLanguage };
type EditionResult = ReturnType<typeof importHansardEdition> |
  (ExpectedEdition & ({ status: 'missing' } | { status: 'failed'; error: string }));

export function hansardWeekDates(weekOf: string): string[] {
  const start = new Date(z.iso.date().parse(weekOf) + 'T00:00:00Z');
  if (start.getUTCDay() !== 1) throw new Error('Supply the Monday that starts the Hansard week.');
  return Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  });
}

export function assertCompletedHansardWeek(weekOf: string) {
  const dates = hansardWeekDates(weekOf);
  const today = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const calendarDate = ['year', 'month', 'day'].map((type) => today.find((part) => part.type === type)?.value).join('-');
  if (dates[6]! >= calendarDate) throw new Error('Supply a completed sitting week.');
}

export function readHansardEditionFile(path: string): Uint8Array {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_HANSARD_XML_BYTES) {
    throw new Error('Expected a local Hansard publication file within the file limit.');
  }
  return readFileSync(path);
}

export function readHansardWeekFiles(path: string) {
  const manifest = localWeek.parse(JSON.parse(readFileSync(path, 'utf8')));
  const files = new Map(manifest.sittings.map((entry) => [entry.sittingId, { en: entry.en, fr: entry.fr }]));
  return {
    weekOf: manifest.weekOf,
    sittings: manifest.sittings.map(({ sittingId, sittingDate }) => ({ sittingId, sittingDate })),
    load(edition: ExpectedEdition) {
      const input = files.get(edition.sittingId)?.[edition.edition];
      return input ? readHansardEditionFile(resolve(dirname(path), input)) : null;
    },
  };
}

/** Reconcile each published language independently so source gaps can be retried. */
export async function replayHansardWeek(
  sqlite: DatabaseSync,
  input: HansardWeek,
  load: (expected: ExpectedEdition) => Uint8Array | null | Promise<Uint8Array | null>,
  importEdition: (sqlite: DatabaseSync, bytes: Uint8Array, expected: ExpectedEdition) =>
    ReturnType<typeof importHansardEdition> = importHansardEdition,
) {
  const { weekOf, sittings } = week.parse(input);
  const dates = new Set(hansardWeekDates(weekOf));
  if (new Set(sittings.map(({ sittingId }) => sittingId)).size !== sittings.length ||
      sittings.some(({ sittingDate }) => !dates.has(sittingDate))) {
    throw new Error('The Hansard week contains a duplicate sitting or a date outside the week.');
  }

  const editions: EditionResult[] = [];
  for (const sitting of sittings) {
    for (const edition of ['en', 'fr'] as const) {
      const expected = { ...sitting, edition };
      try {
        const bytes = await load(expected);
        editions.push(bytes === null ? { ...expected, status: 'missing' } : importEdition(sqlite, bytes, expected));
      } catch (error) {
        editions.push({ ...expected, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const counts = { imported: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const result of editions) counts[result.status]++;
  return { weekOf, complete: counts.missing + counts.failed === 0, counts, editions };
}
