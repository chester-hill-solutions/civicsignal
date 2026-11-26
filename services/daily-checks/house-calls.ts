import type { z } from 'zod';
import { CommitteeCallDetailResponseSchema, CommitteeCallsResponseSchema, CommitteeDetailResponseSchema, type CommitteeCall } from '../../src/corpora/committee-corpus';
import { callFromRow } from '../../src/routes/committee-corpus';
import { HousePacket } from '../house/publish';
import { inventoryReference, readVerified, type PacketRef } from '../house/archive';

type CallRow = z.infer<typeof HousePacket>['calls'][number];
type Read = (path: string, params?: Record<string, string>) => Promise<unknown>;
type Language = 'en' | 'fr';
type Linked = { id: string; kind: string; title: string; url: string };

export function requireMatch(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error('House product verification: ' + message);
}

async function expectedCalls(db: D1Database, rows: CallRow[], language: Language, asOf: string) {
  const ids = [...new Set(rows.flatMap(row => [row.committee_id, row.committee_id + '-study-' + row.metadata.studyId]))];
  const linked = new Map<string, Linked>();
  for (let start = 0; start < ids.length; start += 75) {
    const chunk = ids.slice(start, start + 75);
    const found = await db.prepare(`SELECT id,kind,title,url FROM cc_records WHERE session='45-1' AND language=?
      AND kind IN ('study','committee') AND id IN (${chunk.map(() => '?').join(',')})`).bind(language, ...chunk).all<Linked>();
    for (const entry of found.results) linked.set(entry.id, entry);
  }
  const expected = new Map<string, CommitteeCall>();
  for (const row of rows) {
    const study = linked.get(row.committee_id + '-study-' + row.metadata.studyId);
    const committee = linked.get(row.committee_id);
    expected.set(row.id, callFromRow({ ...row, metadata_json: JSON.stringify(row.metadata),
      committee_title: committee?.title, study_id: study?.id, study_title: study?.title, study_url: study?.url }, asOf));
  }
  requireMatch(expected.size === rows.length, 'duplicate packet edition');
  return expected;
}

async function checkStudy(read: Read, db: D1Database, item: CommitteeCall, asOf: string) {
  requireMatch(item.study, 'missing sample study');
  const { study, language } = item;
  const counts = await db.prepare(`SELECT COUNT(*) FILTER (WHERE r.kind IN ('brief','submission')) AS submissions,
    COUNT(*) FILTER (WHERE r.kind='evidence') AS evidence, COUNT(*) FILTER (WHERE r.kind='meeting') AS meetings
    FROM cc_links l JOIN cc_records r ON r.session=l.session AND r.language=l.language AND r.id=l.child_id
    WHERE l.session='45-1' AND l.language=? AND l.parent_id=?`).bind(language, study.id).first<{
      submissions: number; evidence: number; meetings: number;
    }>();
  const detail = CommitteeCallDetailResponseSchema.parse(await read('/api/committees/45-1/calls/' + item.id, { language, asOf }));
  requireMatch(detail.state === 'found' && detail.asOf === asOf && JSON.stringify(detail.item) === JSON.stringify(item), 'sample call detail');
  requireMatch(counts && detail.related.submissions === counts.submissions && detail.related.evidence === counts.evidence &&
    detail.related.meetings === counts.meetings, 'related study counts');
  const record = CommitteeDetailResponseSchema.parse(await read('/api/committees/45-1/' + item.committee.id + '/studies/' + study.id,
    { language, limit: '1' }));
  requireMatch(record.state === 'found' && record.record.id === study.id && record.record.language === language &&
    record.record.committeeId === item.committee.id && record.record.title === study.title && record.record.url === study.url, 'linked study detail');
  return { callId: item.id, studyId: study.id, related: detail.related };
}

export async function checkHouseLanguage(read: Read, db: D1Database, rows: CallRow[], language: Language, asOf: string) {
  const expected = await expectedCalls(db, rows, language, asOf);
  const seen = new Set<string>();
  let offset = 0, listed = 0;
  for (;;) {
    const page = CommitteeCallsResponseSchema.parse(await read('/api/committees/45-1/calls', { language, asOf, limit: '100', offset: String(offset) }));
    requireMatch(page.session === '45-1' && page.asOf === asOf && page.offset === offset && page.limit === 100, 'list metadata');
    for (const item of page.items) {
      requireMatch(item.language === language && !seen.has(item.id), 'unexpected or repeated edition');
      seen.add(item.id);
      const match = expected.get(item.id);
      if (match) requireMatch(JSON.stringify(item) === JSON.stringify(match), 'edition differs from captured packet: ' + item.id + '/' + language);
      else requireMatch(!item.listed, 'listed edition absent from packet: ' + item.id);
      if (item.listed) listed++;
    }
    if (!page.hasMore) break;
    requireMatch(page.items.length === page.limit, 'incomplete list page');
    offset += page.items.length;
  }
  requireMatch([...expected.keys()].every(id => seen.has(id)), 'packet edition missing from product');
  const sample = [...expected.values()].find(item => item.listed && item.study) ?? [...expected.values()].find(item => item.study);
  return { language, listed, newlyDropped: rows.length - listed, retainedUnlisted: seen.size - rows.length,
    sample: sample ? await checkStudy(read, db, sample, asOf) : null };
}

export interface HouseServingInput { observedAt: string; cutoff: string; packetRef: PacketRef }
export interface HouseServingEnv { ARCHIVE: R2Bucket; COMMITTEE_DB: D1Database }

export async function checkHousePacket(read: Read, env: HouseServingEnv, input: HouseServingInput) {
  const ref = inventoryReference(input.packetRef);
  const bytes = await readVerified(env.ARCHIVE, ref);
  const packet = HousePacket.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  requireMatch(packet.observedAt === input.observedAt, 'packet observation differs from publication');
  const asOf = new Date(input.observedAt).toISOString();
  const seal = () => env.COMMITTEE_DB.prepare("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").first<string>('cutoff');
  requireMatch(await seal() === input.cutoff, 'published cutoff has moved');
  const out = [];
  for (const language of ['en', 'fr'] as const) {
    out.push(await checkHouseLanguage(read, env.COMMITTEE_DB, packet.calls.filter(row => row.language === language), language, asOf));
  }

  requireMatch(await seal() === input.cutoff, 'cutoff changed during product reads');
  return { observedAt: input.observedAt, cutoff: input.cutoff, packetSha256: ref.sha256, languages: out };
}
