import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CONSULTATION_SOURCE,
  ConsultationFactsSchema,
  type ConsultationFacts,
  consultationFromRow,
  parseConsultationCsv,
  readConsultationDictionary,
} from './consultations';

type SqlValue = string | number | null;
interface LocalDatabase {
  exec(query: string): unknown;
  prepare(query: string): {
    get(...values: SqlValue[]): unknown;
    all(...values: SqlValue[]): unknown[];
    run(...values: SqlValue[]): unknown;
  };
}

export interface ConsultationMaterializerInput {
  csvText: string;
  dictionaryJson: unknown;
  observedAt: string;
  csvSha256: string;
  schemaSha256: string;
  csvSource?: Record<string, unknown>;
  schemaSource?: Record<string, unknown>;
}

const migration = new URL('../../preview/consultations/migrations/0001_consultations.sql', import.meta.url);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function changedPaths(previous: unknown, next: unknown, path = ''): string[] {
  if (canonical(previous) === canonical(next)) return [];
  if (previous && next && typeof previous === 'object' && typeof next === 'object' &&
    !Array.isArray(previous) && !Array.isArray(next)) {
    const left = previous as Record<string, unknown>;
    const right = next as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .flatMap((key) => changedPaths(left[key], right[key], path ? `${path}.${key}` : key));
  }
  if (path === 'statusCode') return ['status.code'];
  if (path === 'reportAvailableOnline') return ['report.available'];
  return [path];
}

/**
 * The facts the publisher controls. State and its agreement with the raw code are
 * derived from the observation instant, so a later refresh must not record them
 * as a publisher change or move the catalogue revision.
 */
type PublishedConsultationFacts = Omit<ConsultationFacts, 'stateAtObservation' | 'statusAgreesWithDates'>;

function publishedFacts(facts: ConsultationFacts): PublishedConsultationFacts {
  const { stateAtObservation: _state, statusAgreesWithDates: _agrees, ...published } = facts;
  return published;
}

const CHANGE_CATEGORIES = [
  'end-extended',
  'end-shortened',
  'start-moved',
  'status-changed',
  'report-changed',
  'edition-changed',
  'other',
] as const;
type ChangeCategory = typeof CHANGE_CATEGORIES[number];

function classifyChange(
  previous: PublishedConsultationFacts,
  next: PublishedConsultationFacts,
  fields: string[],
): ChangeCategory[] {
  const categories = new Set<ChangeCategory>();
  const handled = new Set<string>();
  const changed = (field: string) => fields.includes(field);

  if (changed('dates.end')) {
    handled.add('dates.end');
    if (previous.dates.end === null || next.dates.end === null) categories.add('other');
    else categories.add(next.dates.end > previous.dates.end ? 'end-extended' : 'end-shortened');
  }
  if (changed('dates.start')) {
    handled.add('dates.start');
    categories.add('start-moved');
  }
  if (changed('status.code')) {
    handled.add('status.code');
    categories.add('status-changed');
  }

  for (const field of fields) {
    if (field === 'report.available' || /^editions\.(en|fr)\.reportUrl(?:\.|$)/.test(field)) {
      handled.add(field);
      categories.add('report-changed');
    }
    if (field === 'institution' || field.startsWith('institution.') ||
      field === 'subjects' || field.startsWith('subjects.') ||
      field === 'partnerDepartments' || field.startsWith('partnerDepartments.') ||
      /^editions\.(en|fr)\.(title|description)(?:\.|$)/.test(field)) {
      handled.add(field);
      categories.add('edition-changed');
    }
  }
  if (fields.some((field) => !handled.has(field))) categories.add('other');
  return CHANGE_CATEGORIES.filter((category) => categories.has(category));
}

type ConsultationChangeSample = {
  id: string;
  event: 'added' | 'changed' | 'removed';
  categories: string[];
  changedFields: string[];
};

function emptyCategories() {
  return {
    'end-extended': 0,
    'end-shortened': 0,
    'start-moved': 0,
    'status-changed': 0,
    'report-changed': 0,
    'edition-changed': 0,
    other: 0,
  };
}

function normalizedObservedAt(value: string): string {
  if (!z.iso.datetime({ offset: true }).safeParse(value).success || !Number.isFinite(Date.parse(value))) {
    throw new Error('observedAt must be an ISO instant.');
  }
  return new Date(value).toISOString();
}

function checkedRecords(csvText: string, dictionaryJson: unknown, observedAt: string) {
  const { rows } = parseConsultationCsv(csvText);
  if (rows.length === 0) throw new Error('Consultations CSV contains no rows.');

  const dictionary = readConsultationDictionary(dictionaryJson);
  const pairs = new Set<string>();
  const ids = new Set<string>();
  const records = rows.map((row) => {
    const pair = JSON.stringify([row.owner_org?.trim() ?? '', row.registration_number?.trim() ?? '']);
    if (pairs.has(pair)) throw new Error('Consultations CSV contains a duplicate owner_org and registration_number pair.');
    pairs.add(pair);

    const record = consultationFromRow(row, dictionary, observedAt);
    const facts = ConsultationFactsSchema.parse(record.facts);
    if (ids.has(facts.id)) throw new Error(`Consultations CSV contains duplicate id: ${facts.id}`);
    ids.add(facts.id);

    for (const [field, entries, labels] of [
      ['subjects', facts.subjects, dictionary.subjects],
      ['partnerDepartments', facts.partnerDepartments, dictionary.partnerDepartments],
    ] as const) {
      if (entries.some((entry) => labels.has(entry.code) && entry.label === null)) {
        throw new Error(`Consultation ${field} label is missing for a code provided by the dictionary.`);
      }
    }
    return record;
  });
  return records;
}

type MaterializationCounts = {
  rows: number;
  added: number;
  changed: number;
  unchanged: number;
  stale: number;
  removed: number;
};

type ConsultationChanges = {
  added: number;
  removed: number;
  categories: ReturnType<typeof emptyCategories>;
  sample: ConsultationChangeSample[];
};

type ExistingConsultationRow = {
  id: string;
  observed_at: string;
  first_observed_at: string;
  revision: number;
  facts_json: string;
  removed_at: string | null;
};

type PriorConsultationRecords = {
  rows: ExistingConsultationRow[];
  byId: Map<string, ExistingConsultationRow>;
};

type MaterializedConsultation = ReturnType<typeof consultationFromRow>;

type MaterializationContext = {
  db: LocalDatabase;
  observedAt: string;
  counts: MaterializationCounts;
  changes: ConsultationChanges;
};

function readPriorRecords(db: LocalDatabase): PriorConsultationRecords {
  const rows = db.prepare(
    'SELECT id, observed_at, first_observed_at, revision, facts_json, removed_at FROM consultations_records',
  ).all() as ExistingConsultationRow[];
  return { rows, byId: new Map(rows.map((row) => [row.id, row])) };
}

function persistPresentRecord(
  context: MaterializationContext,
  record: MaterializedConsultation,
  previous: ExistingConsultationRow | undefined,
): void {
  const { db, observedAt, counts, changes } = context;
  const { facts, searchText } = record;
  const previousFacts = previous ? JSON.parse(previous.facts_json) as ConsultationFacts : undefined;
  const reappeared = Boolean(previous && previous.removed_at !== null);
  const didChange = Boolean(previous && !reappeared &&
    canonical(publishedFacts(previousFacts as ConsultationFacts)) !== canonical(publishedFacts(facts)));
  const revision = previous ? previous.revision + (didChange || reappeared ? 1 : 0) : 1;
  const firstObservedAt = previous?.first_observed_at ?? observedAt;
  db.prepare(`INSERT INTO consultations_records
    (id, owner_org, registration_number, status_code, start_date, end_date, state_at_observation,
     report_available, observed_at, first_observed_at, revision, facts_json, search_en, search_fr, removed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET owner_org=excluded.owner_org,
     registration_number=excluded.registration_number, status_code=excluded.status_code,
     start_date=excluded.start_date, end_date=excluded.end_date,
     state_at_observation=excluded.state_at_observation, report_available=excluded.report_available,
     observed_at=excluded.observed_at, revision=excluded.revision, facts_json=excluded.facts_json,
     search_en=excluded.search_en, search_fr=excluded.search_fr, removed_at=NULL`)
    .run(
      facts.id,
      facts.ownerOrg,
      facts.registrationNumber,
      facts.statusCode,
      facts.dates.start,
      facts.dates.end,
      facts.stateAtObservation,
      facts.reportAvailableOnline === null ? null : Number(facts.reportAvailableOnline),
      observedAt,
      firstObservedAt,
      revision,
      canonical(facts),
      searchText.en,
      searchText.fr,
      null,
    );

  if (!previous || reappeared || didChange) {
    const event: ConsultationChangeSample['event'] = !previous || reappeared ? 'added' : 'changed';
    const fields = previous && !reappeared
      ? changedPaths(publishedFacts(previousFacts as ConsultationFacts), publishedFacts(facts))
        .sort((a, b) => a.localeCompare(b, 'en'))
      : [];
    db.prepare(`INSERT INTO consultations_revisions
      (id, observed_at, revision, event, changed_fields_json, facts_json) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id, observed_at) DO UPDATE SET revision=excluded.revision, event=excluded.event,
       changed_fields_json=excluded.changed_fields_json, facts_json=excluded.facts_json`)
      .run(facts.id, observedAt, revision, event, JSON.stringify(fields), canonical(facts));
    counts[event]++;
    const categories = event === 'changed'
      ? classifyChange(
        publishedFacts(previousFacts as ConsultationFacts),
        publishedFacts(facts),
        fields,
      )
      : [];
    for (const category of categories) changes.categories[category]++;
    changes.sample.push({ id: facts.id, event, categories, changedFields: fields });
  } else {
    counts.unchanged++;
  }
}

function applyPresentRecords(
  context: MaterializationContext,
  records: MaterializedConsultation[],
  priorById: Map<string, ExistingConsultationRow>,
): void {
  for (const record of records) {
    persistPresentRecord(context, record, priorById.get(record.facts.id));
  }
}

function markRemovedRecord(
  context: MaterializationContext,
  previous: ExistingConsultationRow,
): void {
  const { db, observedAt, counts, changes } = context;
  const revision = previous.revision + 1;
  db.prepare('UPDATE consultations_records SET revision=?, removed_at=? WHERE id=? AND removed_at IS NULL')
    .run(revision, observedAt, previous.id);
  db.prepare(`INSERT INTO consultations_revisions
    (id, observed_at, revision, event, changed_fields_json, facts_json) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id, observed_at) DO UPDATE SET revision=excluded.revision, event=excluded.event,
     changed_fields_json=excluded.changed_fields_json, facts_json=excluded.facts_json`)
    .run(previous.id, observedAt, revision, 'removed', '[]', previous.facts_json);
  counts.removed++;
  changes.sample.push({ id: previous.id, event: 'removed', categories: [], changedFields: [] });
}

function markAbsentRecords(
  context: MaterializationContext,
  priorRows: ExistingConsultationRow[],
  presentIds: Set<string>,
): void {
  for (const previous of priorRows) {
    if (!presentIds.has(previous.id) && previous.removed_at === null) {
      markRemovedRecord(context, previous);
    }
  }
}

function countStaleRecords(db: LocalDatabase, observedAt: string): number {
  const result = db.prepare(
    'SELECT COUNT(*) AS count FROM consultations_records WHERE removed_at IS NULL AND observed_at < ?',
  ).get(observedAt) as { count: number };
  return Number(result.count);
}

function writeCatalogueRow(
  db: LocalDatabase,
  input: ConsultationMaterializerInput,
  observedAt: string,
  revision: string,
): void {
  db.prepare(`INSERT INTO consultations_catalogues
    (source, observed_at, revision, csv_sha256, schema_sha256, csv_source_json, schema_source_json)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at, revision=excluded.revision,
     csv_sha256=excluded.csv_sha256, schema_sha256=excluded.schema_sha256,
     csv_source_json=excluded.csv_source_json, schema_source_json=excluded.schema_source_json`)
    .run(
      CONSULTATION_SOURCE,
      observedAt,
      revision,
      input.csvSha256,
      input.schemaSha256,
      canonical(input.csvSource ?? {}),
      canonical(input.schemaSource ?? {}),
    );
}

function sortAndLimitSample(changes: ConsultationChanges): void {
  changes.sample.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  changes.sample = changes.sample.slice(0, 50);
}

/** Publish one observed consultations catalogue and its record-level history atomically. */
export function materializeConsultations(db: LocalDatabase, input: ConsultationMaterializerInput): {
  observedAt: string;
  revision: string;
  counts: { rows: number; added: number; changed: number; unchanged: number; stale: number; removed: number };
  changes: {
    added: number;
    removed: number;
    categories: ReturnType<typeof emptyCategories>;
    sample: ConsultationChangeSample[];
  };
} {
  if (!/^[a-f0-9]{64}$/.test(input.csvSha256) || !/^[a-f0-9]{64}$/.test(input.schemaSha256)) {
    throw new Error('Consultation source hashes must be 64 lowercase hexadecimal characters.');
  }
  const observedAt = normalizedObservedAt(input.observedAt);
  const records = checkedRecords(input.csvText, input.dictionaryJson, observedAt);
  const sortedFacts = records.map(({ facts }) => publishedFacts(facts)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const revision = hash(canonical({
    source: CONSULTATION_SOURCE,
    records: sortedFacts,
    csvSha256: input.csvSha256,
    schemaSha256: input.schemaSha256,
  }));
  const counts = { rows: records.length, added: 0, changed: 0, unchanged: 0, stale: 0, removed: 0 };
  const changes = { added: 0, removed: 0, categories: emptyCategories(), sample: [] as ConsultationChangeSample[] };
  const context = { db, observedAt, counts, changes };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(migration, 'utf8'));
    const oldCatalogue = db.prepare(
      'SELECT observed_at FROM consultations_catalogues WHERE source=?',
    ).get(CONSULTATION_SOURCE) as { observed_at: string } | undefined;
    if (oldCatalogue && oldCatalogue.observed_at > observedAt) {
      throw new Error('A newer consultation observation already exists.');
    }

    const prior = readPriorRecords(db);
    const presentIds = new Set(records.map(({ facts }) => facts.id));
    applyPresentRecords(context, records, prior.byId);
    markAbsentRecords(context, prior.rows, presentIds);
    counts.stale = countStaleRecords(db, observedAt);
    changes.removed = counts.removed;
    changes.added = counts.added;
    writeCatalogueRow(db, input, observedAt, revision);
    sortAndLimitSample(changes);
    db.exec('COMMIT');
    return { observedAt, revision, counts, changes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
