import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { truncate } from '@chester-hill-solutions/corpus';
import { z } from 'zod';
import {
  hansardCitation, hansardLanguagePrefix, hansardPolicy, hansardSourceIdPattern, hansardSpeechId, hansardSpeechIdentity,
  type HansardChamber, type HansardLanguage,
} from '../../src/corpora/hansard';
import { HANSARD_FEDERAL } from '../../src/corpora/policies';
import { MAX_HANSARD_XML_BYTES, parseHansardXml } from '../../src/ingest/hansard';
import { normalizeForSearch } from '../../src/text';
import { parseSenateHansard } from './senate-hansard-html';
import { initializeSourceFeed, recordSourceChanges } from './source-feed-store';
import type { FeedRecord } from '../../src/corpora/source-feed';

// Bump when XML parsing or its persisted excerpt/search representation changes.
const HANSARD_PARSER_VERSION = 'hansard-v1';

const sourceId = z.string().regex(hansardSourceIdPattern);
const language = z.enum(['en', 'fr']);
const speech = z.strictObject({
  interventionId: sourceId,
  language,
  speaker: z.string().trim().min(1),
  party: z.string().trim().min(1).optional(),
  excerpt: z.string().min(1).max(HANSARD_FEDERAL.excerptMaxChars).refine((value) => value.trim().length > 0),
  citationUrl: z.string(),
});
const sitting = z.strictObject({
  sittingId: sourceId,
  sittingDate: z.iso.date(),
  speeches: z.array(speech).min(1),
});

export interface HansardEditionMetadata {
  sittingId: string;
  sittingDate: string;
  edition: HansardLanguage;
}

interface HansardEditionImport extends HansardEditionMetadata {
  status: 'imported' | 'unchanged';
  written: number;
  removed: number;
}

function localWrite<T>(sqlite: DatabaseSync, write: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS local_hansard_editions (
      sitting_id TEXT NOT NULL,
      edition TEXT NOT NULL CHECK (edition IN ('en', 'fr')),
      sitting_date TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      xml_sha256 TEXT NOT NULL,
      PRIMARY KEY (sitting_id, edition),
      UNIQUE (parser_version, xml_sha256)
    )`);
    initializeSourceFeed(sqlite);
    const result = write();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function feedRecords(sqlite: DatabaseSync, chamber: HansardChamber, sittingId: string,
  edition: HansardLanguage): FeedRecord[] {
  const corpusId = hansardPolicy(chamber).id;
  const idPrefix = `${hansardLanguagePrefix(edition, chamber)}${sittingId}:`;
  const rows = sqlite.prepare(`SELECT id, speaker, party, sitting_date AS publicationDate, excerpt,
      source_url AS citationUrl FROM hansard_speeches WHERE corpus_id = ? AND id GLOB ?`)
    .all(corpusId, `${idPrefix}*`) as { id: string; speaker: string; party: string | null; publicationDate: string;
      excerpt: string; citationUrl: string }[];
  return rows.flatMap((row) => {
    const identity = hansardSpeechIdentity(row.id);
    if (!identity || identity.chamber !== chamber || identity.sittingId !== sittingId || identity.language !== edition ||
        !row.id.startsWith(idPrefix)) return [];
    const excerpt = truncate(row.excerpt, hansardPolicy(chamber).excerptMaxChars);
    return [{
      id: row.id,
      citationUrl: row.citationUrl,
      publicationDate: row.publicationDate,
      label: row.speaker,
      searchText: normalizeForSearch(excerpt),
      fingerprint: createHash('sha256').update(JSON.stringify([
        row.speaker, row.party, row.publicationDate, row.citationUrl, excerpt,
      ])).digest('hex'),
    }];
  });
}

function recordSittingChanges(sqlite: DatabaseSync,
  scope: { chamber: HansardChamber; sittingId: string; sittingDate: string; editions: HansardLanguage[] },
  before: Map<HansardLanguage, FeedRecord[]>) {
  for (const edition of scope.editions) {
    recordSourceChanges(sqlite, {
      source: scope.chamber,
      language: edition,
      editionId: scope.sittingId,
      publicationDate: scope.sittingDate,
    }, before.get(edition) ?? [], feedRecords(sqlite, scope.chamber, scope.sittingId, edition));
  }
}

function upsertSpeeches(sqlite: DatabaseSync, { sittingId, sittingDate, speeches }: z.infer<typeof sitting>,
  chamber: HansardChamber): string[] {
  const policy = hansardPolicy(chamber);
  if (speeches.some(({ citationUrl }) => !hansardCitation(citationUrl, chamber)?.hash)) {
    throw new Error('Expected an anchored citation URL for the source chamber.');
  }
  const ids = speeches.map(({ language, interventionId }) => hansardSpeechId(language, sittingId, interventionId, chamber));
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Hansard speech identity in the sitting.');

  const upsert = sqlite.prepare(`INSERT INTO hansard_speeches
    (id, corpus_id, speaker, party, sitting_date, excerpt, source_url, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      speaker = excluded.speaker, party = excluded.party, sitting_date = excluded.sitting_date,
      excerpt = excluded.excerpt, source_url = excluded.source_url, search_text = excluded.search_text
    WHERE hansard_speeches.corpus_id = excluded.corpus_id`);
  for (const [index, entry] of speeches.entries()) {
    const id = ids[index];
    if (!id) throw new Error('Hansard speech identity is missing.');
    const result = upsert.run(id, policy.id, entry.speaker, entry.party ?? null,
      sittingDate, entry.excerpt, entry.citationUrl, normalizeForSearch(entry.excerpt));
    if (Number(result.changes) !== 1) throw new Error('Hansard speech identity belongs to another corpus.');
  }
  return ids;
}

export function importHansardSitting(sqlite: DatabaseSync, input: unknown): string[] {
  const publication = sitting.parse(input);
  return localWrite(sqlite, () => {
    const editions = [...new Set(publication.speeches.map((entry) => entry.language))];
    const before = new Map(editions.map((edition) => [edition,
      feedRecords(sqlite, 'house', publication.sittingId, edition)]));
    const ids = upsertSpeeches(sqlite, publication, 'house');
    const invalidate = sqlite.prepare('DELETE FROM local_hansard_editions WHERE sitting_id = ? AND edition = ?');
    for (const language of new Set(publication.speeches.map((entry) => entry.language))) {
      invalidate.run(publication.sittingId, language);
    }
    recordSittingChanges(sqlite, {
      chamber: 'house', sittingId: publication.sittingId, sittingDate: publication.sittingDate, editions,
    }, before);
    return ids;
  });
}

function verifyMetadata(actual: HansardEditionMetadata, expected?: HansardEditionMetadata) {
  if (expected && (actual.sittingId !== expected.sittingId || actual.sittingDate !== expected.sittingDate
    || actual.edition !== expected.edition)) {
    throw new Error(`Hansard metadata mismatch. Expected ${expected.sittingId} ${expected.sittingDate} ${expected.edition}, ` +
      `received ${actual.sittingId} ${actual.sittingDate} ${actual.edition}.`);
  }
}

function removeObsoleteSpeeches(sqlite: DatabaseSync, { sittingId, edition }: HansardEditionMetadata, ids: string[],
  chamber: HansardChamber) {
  const current = new Set(ids);
  const corpus = hansardPolicy(chamber).id;
  const prior = sqlite.prepare('SELECT id FROM hansard_speeches WHERE corpus_id = ? AND id GLOB ?')
    .all(corpus, `${hansardLanguagePrefix(edition, chamber)}${sittingId}:*`) as { id: string }[];
  const remove = sqlite.prepare('DELETE FROM hansard_speeches WHERE corpus_id = ? AND id = ?');
  let removed = 0;
  for (const { id } of prior) {
    if (!current.has(id) && hansardSpeechIdentity(id)) removed += Number(remove.run(corpus, id).changes);
  }
  return removed;
}

interface DebateEditionImportInput {
  bytes: Uint8Array;
  chamber: HansardChamber;
  parse: (source: string) => { edition: unknown; sitting: unknown };
  expected?: HansardEditionMetadata;
  parsedPublication?: { edition: unknown; sitting: unknown };
}

function importDebateEdition(sqlite: DatabaseSync, { bytes, chamber, parse, expected, parsedPublication }: DebateEditionImportInput): HansardEditionImport {
  if (bytes.byteLength > MAX_HANSARD_XML_BYTES) throw new Error('Hansard publication exceeds the local file limit.');
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const parserVersion = chamber === 'house' ? HANSARD_PARSER_VERSION : 'senate-hansard-html-v1';
  // Retain the House's existing keys. Scope Senate replay state to its own chamber.
  const statePrefix = chamber === 'house' ? '' : 'senate:';

  return localWrite(sqlite, () => {
    const committed = sqlite.prepare(`SELECT sitting_id AS sittingId, sitting_date AS sittingDate, edition
      FROM local_hansard_editions WHERE parser_version = ? AND xml_sha256 = ?`)
      .get(parserVersion, sourceSha256) as HansardEditionMetadata | undefined;
    if (committed) {
      const metadata = { ...committed, sittingId: committed.sittingId.slice(statePrefix.length) };
      verifyMetadata(metadata, expected);
      const existing = feedRecords(sqlite, chamber, metadata.sittingId, metadata.edition);
      recordSourceChanges(sqlite, {
        source: chamber, language: metadata.edition, editionId: metadata.sittingId, publicationDate: metadata.sittingDate,
      }, existing, existing);
      return { ...metadata, status: 'unchanged', written: 0, removed: 0 };
    }

    const publication = parsedPublication ??
      parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    const parsed = sitting.parse(publication.sitting);
    const { sittingId, sittingDate } = parsed;
    const metadata: HansardEditionMetadata = { sittingId, sittingDate, edition: language.parse(publication.edition) };
    verifyMetadata(metadata, expected);
    const priorRecords = feedRecords(sqlite, chamber, sittingId, metadata.edition);
    const ids = upsertSpeeches(sqlite, parsed, chamber);
    const removed = removeObsoleteSpeeches(sqlite, metadata, ids, chamber);
    sqlite.prepare(`INSERT INTO local_hansard_editions (sitting_id, edition, sitting_date, parser_version, xml_sha256)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sitting_id, edition) DO UPDATE SET sitting_date = excluded.sitting_date,
        parser_version = excluded.parser_version, xml_sha256 = excluded.xml_sha256`)
      .run(statePrefix + sittingId, metadata.edition, sittingDate, parserVersion, sourceSha256);
    recordSourceChanges(sqlite, {
      source: chamber, language: metadata.edition, editionId: sittingId, publicationDate: sittingDate,
    }, priorRecords, feedRecords(sqlite, chamber, sittingId, metadata.edition));
    return { ...metadata, status: 'imported', written: ids.length, removed };
  });
}

export function importHansardEdition(sqlite: DatabaseSync, bytes: Uint8Array,
  expected?: HansardEditionMetadata): HansardEditionImport {
  return importDebateEdition(sqlite, { bytes, chamber: 'house', parse: parseHansardXml, expected });
}

export function importHansardXmlEdition(sqlite: DatabaseSync, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_HANSARD_XML_BYTES) throw new Error('Hansard publication exceeds the local file limit.');
  const publication = parseHansardXml(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  const result = importDebateEdition(sqlite, {
    bytes, chamber: 'house', parse: parseHansardXml, parsedPublication: publication,
  });
  const ids = publication.sitting.speeches.map(({ language, interventionId }) =>
    hansardSpeechId(language, publication.sitting.sittingId, interventionId, 'house'));
  return { ...result, ids, publicationId: publication.publicationId };
}

export function importSenateEdition(sqlite: DatabaseSync, bytes: Uint8Array, expected: HansardEditionMetadata): HansardEditionImport {
  return importDebateEdition(sqlite, {
    bytes, chamber: 'senate', parse: (html) => parseSenateHansard(html, expected), expected,
  });
}
