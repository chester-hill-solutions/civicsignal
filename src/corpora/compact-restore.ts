import { MAX_PROVISION_TEXT_BYTES, provisionTextKey, textSha256, UPSERT_TEXT_REFERENCE_SQL } from './text-store';

/** A fresh corpus store. Protected identity/history tables are copied separately. */
export const COMPACT_CORPUS_SCHEMA = `CREATE TABLE statute_sections (
 id TEXT PRIMARY KEY, corpus_id TEXT NOT NULL, act TEXT NOT NULL, section TEXT NOT NULL,
 heading TEXT, text TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL, jurisdiction TEXT,
 in_force INTEGER NOT NULL DEFAULT 1, topics TEXT, citation TEXT, language TEXT,
 schedule TEXT, part INTEGER, status TEXT, text_hash TEXT, last_changed TEXT
);
CREATE INDEX idx_statute_sections_citation ON statute_sections(citation,section);
CREATE INDEX idx_statute_sections_exact ON statute_sections(act,section,language);
CREATE INDEX idx_statute_sections_jur ON statute_sections(jurisdiction);
CREATE TABLE statute_text_refs (
 row_id TEXT PRIMARY KEY NOT NULL, corpus_id TEXT NOT NULL, row_fingerprint TEXT NOT NULL,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64), object_key TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0), created_at TEXT NOT NULL
);
CREATE INDEX statute_text_refs_corpus_row ON statute_text_refs(corpus_id,row_id);
CREATE TABLE corpus_compact_restore(id INTEGER PRIMARY KEY CHECK(id=1),bundle_sha256 TEXT NOT NULL,revision TEXT NOT NULL);
CREATE TABLE corpus_compact_pages(page INTEGER PRIMARY KEY,sha256 TEXT NOT NULL,after_id TEXT NOT NULL,row_count INTEGER NOT NULL);
`;

export const COMPACT_STATUTE_COLUMNS = ['id','corpus_id','act','section','heading','text','source_url','jurisdiction',
  'in_force','topics','citation','language','schedule','part','status','text_hash','last_changed'] as const;
export const INSERT_COMPACT_STATUTE_SQL = `INSERT INTO statute_sections (${COMPACT_STATUTE_COLUMNS.join(',')}) VALUES (${COMPACT_STATUTE_COLUMNS.map(() => '?').join(',')})`;

export interface CompactRestoreStatement { query: string; params: unknown[] }
export interface CompactRestorePage {
  page: number;
  fromAfter: string;
  through: string;
  rows: number;
  statements: CompactRestoreStatement[];
  sha256: string;
}

export async function compactPageDigest(page: Omit<CompactRestorePage, 'sha256'>): Promise<string> {
  return textSha256(new Uint8Array(new TextEncoder().encode(JSON.stringify(page))));
}

function checkedPage(page: CompactRestorePage): Omit<CompactRestorePage, 'sha256'> {
  if (!Number.isSafeInteger(page.page) || page.page < 1 || !Number.isSafeInteger(page.rows) || page.rows < 1 || page.rows > 16 ||
      typeof page.fromAfter !== 'string' || typeof page.through !== 'string' || !Array.isArray(page.statements) ||
      page.statements.length !== page.rows * 2) throw new Error('Invalid compact restore page bounds.');
  let previous = page.fromAfter;
  for (let at = 0; at < page.statements.length; at += 2) {
    const metadata = page.statements[at]!;
    const reference = page.statements[at + 1]!;
    if (!metadata || !reference || !Array.isArray(metadata.params) || !Array.isArray(reference.params) || metadata.query !== INSERT_COMPACT_STATUTE_SQL || reference.query !== UPSERT_TEXT_REFERENCE_SQL ||
        metadata.params.length !== COMPACT_STATUTE_COLUMNS.length || reference.params.length !== 7) throw new Error('Unexpected compact restore statement.');
    if (![...metadata.params, ...reference.params].every((value) => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) {
      throw new Error('Compact restore parameters must be scalar SQL values.');
    }
    const id = metadata.params[0];
    const hash = metadata.params[15];
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id <= previous || metadata.params[1] !== 'statutes-canada' || metadata.params[5] !== '' ||
        typeof hash !== 'string' || !/^[a-f0-9]{32}$/.test(hash) || reference.params[0] !== id || reference.params[1] !== 'statutes-canada' ||
        reference.params[2] !== hash || typeof reference.params[3] !== 'string' || reference.params[4] !== provisionTextKey(reference.params[3]) ||
        typeof reference.params[5] !== 'number' || !Number.isSafeInteger(reference.params[5]) || reference.params[5] < 1 || reference.params[5] > MAX_PROVISION_TEXT_BYTES) {
      throw new Error('Compact restore metadata/reference identity mismatch.');
    }
    previous = id;
  }
  if (previous !== page.through) throw new Error('Compact restore page cursor mismatch.');
  return { page: page.page, fromAfter: page.fromAfter, through: page.through, rows: page.rows, statements: page.statements };
}

export async function verifyCompactRestorePage(page: CompactRestorePage): Promise<void> {
  if (await compactPageDigest(checkedPage(page)) !== page.sha256) throw new Error('Compact restore page digest mismatch.');
}

/** Plain INSERTs and a required fresh-store marker prevent accidental source updates.
 * The marker, metadata, references and page journal commit in one D1 transaction. */
export async function applyCompactRestorePage(db: D1Database, page: CompactRestorePage,
  identity: { bundleSha256: string; revision: string }): Promise<{ skipped: boolean; through: string; rows: number }> {
  if (!/^[a-f0-9]{64}$/.test(identity.bundleSha256) || !identity.revision) throw new Error('A verified bundle identity is required.');
  await verifyCompactRestorePage(page);
  const target = await db.prepare('SELECT bundle_sha256,revision FROM corpus_compact_restore WHERE id=1').first<{ bundle_sha256: string; revision: string }>();
  if (target && (target.bundle_sha256 !== identity.bundleSha256 || target.revision !== identity.revision)) throw new Error('The target belongs to another compact restore.');
  if (!target) {
    const populated = await db.prepare('SELECT (SELECT count(*) FROM statute_sections)+(SELECT count(*) FROM statute_text_refs) AS count').first<{ count: number }>();
    if (Number(populated?.count) !== 0) throw new Error('Compact restore requires a fresh empty corpus store.');
  }
  const recorded = await db.prepare('SELECT sha256 FROM corpus_compact_pages WHERE page=?').bind(page.page).first<{ sha256: string }>();
  if (recorded) {
    if (recorded.sha256 !== page.sha256) throw new Error('A different compact restore page already occupies this checkpoint.');
    return { skipped: true, through: page.through, rows: page.rows };
  }
  const latest = await db.prepare('SELECT page,after_id FROM corpus_compact_pages ORDER BY page DESC LIMIT 1').first<{ page: number; after_id: string }>();
  if (page.page !== (latest?.page ?? 0) + 1 || page.fromAfter !== (latest?.after_id ?? '')) throw new Error('Compact restore pages must be applied in cursor order.');
  const statements: D1PreparedStatement[] = [];
  if (!target) statements.push(db.prepare('INSERT INTO corpus_compact_restore(id,bundle_sha256,revision) VALUES(1,?,?)').bind(identity.bundleSha256, identity.revision));
  statements.push(...page.statements.map((statement) => db.prepare(statement.query).bind(...statement.params)));
  statements.push(db.prepare('INSERT INTO corpus_compact_pages(page,sha256,after_id,row_count) VALUES(?,?,?,?)').bind(page.page, page.sha256, page.through, page.rows));
  await db.batch(statements);
  return { skipped: false, through: page.through, rows: page.rows };
}
