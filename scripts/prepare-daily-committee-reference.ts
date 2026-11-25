/** Build the private daily acceptance reference from a sealed committee database and call receipt. */
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CommitteeCallSchema } from '../src/corpora/committee-corpus';
import {
  committeeCallExpected, committeeCallRelated, committeeCallRows, committeeCallTime, committeeCutoff,
  committeeSession, type CommitteeCallsReceipt,
} from '../test/helpers/acquired-committee';

const [database, receiptFile, baseFile, directory = 'dist/daily/references/committee'] = process.argv.slice(2);
if (!database || !receiptFile || !baseFile) {
  throw new Error('Usage: bun scripts/prepare-daily-committee-reference.ts DATABASE CALL_RECEIPT SEALED_BASE [OUTPUT_DIRECTORY]');
}
const base = z.object({
  session: z.string(), sourceAndLocalServingTablesMatch: z.literal(true),
  servingTables: z.object({ cutoff: z.string(), cc_records: z.object({ count: z.number() }),
    cc_links: z.object({ count: z.number() }), cc_passages: z.object({ count: z.number() }) }),
  calls: z.object({ editionRows: z.number() }),
}).parse(JSON.parse(readFileSync(baseFile, 'utf8')));
const receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as CommitteeCallsReceipt;
strictEqual(receipt.session, committeeSession);
strictEqual(base.session, receipt.session);
const asOf = committeeCallTime(receipt.observedAt);
const editionKey = ({ id, language }: { id: string; language: string }) => `${id}/${language}`;
const supplemental = z.object({
  listingUrl: z.string().optional(), contentWarningText: z.string().nullable().optional(),
  pendingDigest: z.string().nullable().optional(), contentConflict: z.boolean().optional(),
});

const db = new DatabaseSync(database, { readOnly: true });
try {
  db.exec('BEGIN');
  const cutoff = committeeCutoff(db);
  strictEqual(cutoff, base.servingTables.cutoff);
  for (const table of ['cc_records', 'cc_links', 'cc_passages'] as const) {
    strictEqual(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session=?`).get(committeeSession)?.n,
      base.servingTables[table].count);
  }
  const rows = committeeCallRows(db);
  strictEqual(rows.length, base.calls.editionRows);
  const committeeName = db.prepare("SELECT title FROM cc_records WHERE session=? AND language=? AND id=? AND kind='committee'");
  const calls = rows.map(row => {
    const expected = committeeCallExpected(db, row, asOf);
    const info = supplemental.parse(row.metadata);
    const name = committeeName.get(committeeSession, row.language, row.committee_id)?.title ?? null;
    return CommitteeCallSchema.parse({ ...expected, committee: { id: row.committee_id, name },
      listingUrl: info.listingUrl ?? row.url, contentWarningText: info.contentWarningText ?? null,
      pendingChange: Boolean(info.pendingDigest), contentConflict: info.contentConflict === true });
  });
  const listed = calls.filter(call => call.listed);
  deepStrictEqual(listed.map(editionKey).sort(), receipt.calls.map(editionKey).sort());
  const byEdition = new Map(calls.map(call => [editionKey(call), call]));
  for (const recorded of receipt.calls) {
    const call = byEdition.get(editionKey(recorded));
    ok(call, 'Missing receipt edition in the committee database');
    deepStrictEqual([call.title, call.url, call.committee.id, call.instructionUrl, call.deadline, call.contentWarning,
      call.lastListedAt], [recorded.title, recorded.citation, recorded.committeeId, recorded.instructionUrl,
      recorded.deadline, recorded.hasContentWarning, asOf]);
  }
  for (const recorded of receipt.droppedCalls ?? []) {
    const call = byEdition.get(editionKey(recorded));
    strictEqual(call?.listed, false);
    strictEqual(call?.lastListedAt, committeeCallTime(recorded.lastListedAt));
  }
  const related = calls.map(call => ({ id: call.id, language: call.language,
    counts: committeeCallRelated(db, call.language, call.study?.id ?? null) }));
  function search(language: 'en' | 'fr', term: string) {
    return committeeCallRows(db, term).filter(row => row.language === language).map(row => row.id);
  }
  const apprenticeship = { en: search('en', 'apprenticeship'), fr: search('fr', 'apprentissage') };
  const content = Buffer.from(JSON.stringify({ session: committeeSession, cutoff, asOf, calls, related, apprenticeship }));
  const digest = createHash('sha256').update(content).digest('hex');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, digest + '.json');
  try {
    writeFileSync(path, content, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    deepStrictEqual(readFileSync(path), content);
  }
  console.log(JSON.stringify({ key: `daily/references/committee/${digest}.json`, sha256: digest, bytes: content.length,
    path, session: committeeSession, cutoff, asOf, editions: calls.length, apprenticeship }));
} finally {
  db.close();
}
