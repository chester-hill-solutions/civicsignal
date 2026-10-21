#!/usr/bin/env bun
/**
 * Check the Postgres corpus adapter against a real Postgres.
 *
 * The unit tests prove the adapter asks the right questions with a fake
 * runner. This proves the questions are *answerable* — that the table has the
 * columns the adapter names, that the placeholder translation produces valid
 * SQL, that the boolean reads as a boolean, and that the cosine comes back as a
 * similarity and not a distance.
 *
 *     DATABASE_URL=postgres://... bun scripts/check-postgres-adapter.ts
 *
 * It seeds two rows, asks for them, and reports what it found. It writes
 * nothing it does not clean up.
 */
import postgres from 'postgres';
import { postgresCorpusContext } from '../src/corpora/postgres-context';
import { postgresStatutesCorpus } from '../src/corpora/postgres-adapters';
import { toVectorLiteral } from '../src/corpora/postgres-vector';

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.CORPUS_DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('set DATABASE_URL to the corpus database');
  process.exit(2);
}

const CORPUS_ID = 'statutes-canada';
const EN_ID = 'check-en-1';
const FR_ID = 'check-fr-1';

/** A unit vector, so the cosine is a known number. */
function unit(seed: number): number[] {
  const vector = new Array(768).fill(0);
  vector[seed] = 1;
  return vector;
}

const { context, sql } = postgresCorpusContext({ databaseUrl: DATABASE_URL });

await sql`DELETE FROM statute_provisions WHERE id IN (${EN_ID}, ${FR_ID})`;

await sql`
  INSERT INTO statute_provisions (
    id, corpus_id, instrument, citation, section, status, heading, text,
    source_url, jurisdiction, in_force, language, search_text, text_hash, last_changed, embedding
  ) VALUES
    (${EN_ID}, ${CORPUS_ID}, 'Canada Labour Code', 'L.C. 1992, c. 22', '210', 'in-force',
     'Rights', 'An employer shall grant leave.', 'https://example.test/210', 'CA', true, 'en',
     'employer leave rights', 'en-hash', '2026-10-15', ${toVectorLiteral(unit(3))}),
    (${FR_ID}, ${CORPUS_ID}, 'Code canadien du travail', 'L.C. 1992, c. 22', '210', 'in-force',
     'Droits', 'Un employeur doit accorder une pause.', 'https://example.test/210-fr', 'CA', true, 'fr',
     'employeur pause droits', 'fr-hash', '2026-10-15', ${toVectorLiteral(unit(9))})
`;

const found = await postgresStatutesCorpus.retrieve({ topic: 'leave' }, context);
console.log(`  a topic search found ${found.length} row(s)`);
for (const item of found) {
  console.log(`    ${item.id}  ${item.title}`);
}

const french = await postgresStatutesCorpus.retrieve({ topic: 'droits', language: 'fr' }, context);
console.log(`  the same search in French found ${french.length} row(s)`);
for (const item of french) {
  console.log(`    ${item.id}  ${item.title}  inForce=${item.extra?.inForce}`);
}

const matches = await context.vector!.query(unit(9), 3, { language: 'fr' });
console.log(`  the vector index returned ${matches.length} match(es)`);
for (const match of matches) {
  console.log(`    ${match.id}  score=${match.score.toFixed(4)}`);
}

await sql`DELETE FROM statute_provisions WHERE id IN (${EN_ID}, ${FR_ID})`;
await sql.end({ timeout: 5 });

const ok =
  found.length === 1 &&
  found[0]?.id === EN_ID &&
  french.length === 1 &&
  french[0]?.id === FR_ID &&
  french[0]?.extra?.inForce === true &&
  matches.length === 1 &&
  matches[0]?.id === FR_ID &&
  matches[0]!.score > 0.999;

console.log(ok ? '  the adapter is correct' : '  THE ADAPTER IS WRONG');
process.exit(ok ? 0 : 1);
