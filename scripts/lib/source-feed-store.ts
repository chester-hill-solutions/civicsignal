import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { FeedChangeKind, FeedRecord, FeedScope } from '../../src/corpora/source-feed';

const schema = readFileSync(new URL('../../preview/source-feed/migrations/0001_source_feed.sql', import.meta.url), 'utf8');

export function initializeSourceFeed(sqlite: DatabaseSync): void {
  sqlite.exec(schema);
}

/** Called inside the transaction that imports the source records. The baseline is
 * the first locally observed edition; historical changes before it are unknown. */
export function recordSourceChanges(sqlite: DatabaseSync, scope: FeedScope, before: FeedRecord[], after: FeedRecord[]): void {
  const observedAt = new Date().toISOString();
  const identity = [scope.source, scope.language, scope.editionId] as const;
  const baseline = sqlite.prepare(`INSERT INTO source_feed_editions
    (source, language, edition_id, part, publication_date, observed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, language, edition_id) DO NOTHING`).run(...identity, scope.part ?? null, scope.publicationDate, observedAt);
  const insertEvent = sqlite.prepare(`INSERT INTO source_feed_events
    (source, language, edition_id, part, kind, record_id, publication_date, observed_at, citation_url, label, before_search, after_search)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let changed = false;
  function append(kind: FeedChangeKind, record: FeedRecord, previousText: string | null, currentText: string | null) {
    insertEvent.run(...identity, scope.part ?? null, kind, record.id, record.publicationDate, observedAt,
      record.citationUrl, record.label, previousText, currentText);
    changed = true;
  }
  const oldRows = new Map(before.map((row) => [row.id, row]));
  const newRows = new Map(after.map((row) => [row.id, row]));
  if (Number(baseline.changes) === 1) {
    for (const id of [...oldRows.keys()].sort()) {
      const row = oldRows.get(id);
      if (row) append('added', row, null, row.searchText);
    }
  }
  for (const id of [...new Set([...oldRows.keys(), ...newRows.keys()])].sort()) {
    const old = oldRows.get(id);
    const current = newRows.get(id);
    if (old && current) {
      if (old.fingerprint !== current.fingerprint) append('corrected', current, old.searchText, current.searchText);
    } else if (current) {
      append('added', current, null, current.searchText);
    } else if (old) {
      append('removed', old, old.searchText, null);
    }
  }
  if (Number(baseline.changes) === 0) {
    sqlite.prepare(`UPDATE source_feed_editions SET publication_date = ?, observed_at = ?
      WHERE source = ? AND language = ? AND edition_id = ? AND (publication_date <> ? OR ? = 1)`)
      .run(scope.publicationDate, observedAt, ...identity, scope.publicationDate, Number(changed));
  }
}
