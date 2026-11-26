import { createHash } from 'node:crypto';
import { z } from 'zod';

const session = z.literal('45-1');
const language = z.enum(['en', 'fr']);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: true, precision: null }).refine(value => !/\.\d{7}/.test(value));
const url = z.url({ protocol: /^https$/ });
const instance = z.string().regex(/^house-calls-\d+$/);
const id = z.string().regex(/^house-[a-z0-9]+-call-\d+$/);
const metadata = z.strictObject({
  delivery: z.literal('excerpt'), termsUrl: z.literal('https://apps.ourcommons.ca/en/important-notices'),
  committeeCode: z.string().regex(/^[A-Z0-9]+$/), listingUrl: url, studyId: z.string().regex(/^\d+$/),
  instructionUrl: url.nullable(), instructions: z.string().nullable(),
  deadline: z.strictObject({ text: z.string(), instant: instant.nullable(), timeZone: z.string().nullable() }).nullable(),
  contentWarning: z.boolean(), contentWarningText: z.string().nullable(), listed: z.boolean(),
  lastListedAt: instant, observedAt: instant, firstObservedAt: instant,
  revision: z.number().int().positive(), contentDigest: digest, pendingDigest: digest.nullable(), contentConflict: z.boolean(),
});
const call = z.strictObject({ session, id, language, kind: z.literal('call'), chamber: z.literal('house'),
  committee_id: z.string(), title: z.string().min(1), url, status: z.literal('indexed'), metadata });
const source = z.looseObject({ url, resolvedUrl: url.optional(), language, chamber: z.enum(['house', 'senate']),
  checked: instant, state: z.enum(['archived','unavailable']), sha256: digest.optional(), bytes: z.number().int().positive().optional(),
  key: z.string().optional(), status: z.number().int().optional(), error: z.string().optional(),
  listing: z.enum(['call-listing-present','no-call-listing-in-archived-html','unreadable']).optional() });
export const HousePacket = z.strictObject({ session, instanceId: instance, scheduledTime: z.number().int().nonnegative(),
  observedAt: instant, priorSha256: digest, calls: call.array().min(2), sources: source.array().min(2) });
export type HousePacket = z.infer<typeof HousePacket>;
const prior = z.strictObject({ id, language, title: z.string(), metadata_json: z.string() });
export const HouseBase = z.strictObject({ session, cutoff: instant, prior: prior.array(), observedAt: instant,
  headInstance: instance.nullable() });
export type HouseBase = z.infer<typeof HouseBase>;
const lastInstance = 'SELECT instance_id FROM cc_house_runs WHERE session=? ORDER BY scheduled_time DESC LIMIT 1';
const priorSelect = "SELECT id,language,title,metadata_json FROM cc_records WHERE session=? AND kind='call' AND chamber='house'";
const key = (row: { id: string; language: string }) => row.id + '/' + row.language;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function micros(value: string) {
  const milliseconds = Date.parse(value);
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return milliseconds * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

/** SQLite's source uses sorted keys and compact JSON. Python content digests use spaces. */
function sortedJson(value: unknown, spaced = false): string {
  const comma = spaced ? ', ' : ',', colon = spaced ? ': ' : ':';
  if (Array.isArray(value)) return '[' + value.map(item => sortedJson(item, spaced)).join(comma) + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k,v]) => JSON.stringify(k) + colon + sortedJson(v, spaced)).join(comma) + '}';
  }
  return JSON.stringify(value);
}

export async function readHouseBase(db: D1Database, requestedSession: string): Promise<HouseBase> {
  const current = session.parse(requestedSession);
  const [snapshot, runs, records] = await db.batch<Record<string,unknown>>([
    db.prepare('SELECT cutoff FROM cc_snapshot WHERE session=?').bind(current),
    db.prepare('SELECT instance_id,observed_at FROM cc_house_runs WHERE session=? ORDER BY scheduled_time DESC LIMIT 1').bind(current),
    db.prepare(priorSelect + ' ORDER BY id,language').bind(current),
  ]);
  const rows = prior.array().parse(records.results);
  const dates = rows.map(row => instant.parse(JSON.parse(row.metadata_json).observedAt));
  const latest = dates.sort((a,b) => micros(b) - micros(a))[0];
  return HouseBase.parse({ session: current, cutoff: snapshot.results[0]?.cutoff, prior: rows,
    headInstance: runs.results[0]?.instance_id ?? null, observedAt: runs.results[0]?.observed_at ?? latest });
}

type Call = z.infer<typeof call>;
const listingUrl = (lang: string) => 'https://www.ourcommons.ca/Committees/' + lang + '/Participate';

function checkRow(row: Call) {
  const m = row.metadata, committee = 'house-' + m.committeeCode.toLowerCase();
  const study = `https://www.ourcommons.ca/committees/${row.language}/${m.committeeCode}/StudyActivity?studyActivityId=${m.studyId}`;
  if (row.committee_id !== committee || row.id !== committee + '-call-' + m.studyId ||
      row.url !== study || m.listingUrl !== listingUrl(row.language)) throw new Error('Invalid House call identity or citation.');
  const content = { studyId: m.studyId, instructions: m.instructions, instructionUrl: m.instructionUrl, deadline: m.deadline };
  if (m.contentDigest !== sha(sortedJson(content, true))) throw new Error('House call content digest mismatch.');
}

export function housePriorDigest(rows: HouseBase['prior']) {
  const sorted = [...rows].sort((a,b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return sha(sortedJson(sorted.map(row => [row.id, row.language, { title: row.title, metadata: JSON.parse(row.metadata_json) }])));
}

function checkFreshness(base: HouseBase, packet: HousePacket) {
  if (housePriorDigest(base.prior) !== packet.priorSha256) throw new Error('House packet was built against different prior call editions.');
  if (packet.instanceId !== 'house-calls-' + packet.scheduledTime) throw new Error('House occurrence key mismatch.');
  if (base.headInstance && packet.scheduledTime <= Number(base.headInstance.slice('house-calls-'.length))) {
    throw new Error('Stale House calls occurrence.');
  }
  const previous = micros(base.observedAt) + (/\.\d/.test(base.observedAt) ? 0 : 999999);
  const pages = packet.sources.filter(page => page.chamber === 'house');
  const times = pages.map(page => micros(page.checked));
  if (!pages.length || !times.every(at => at > previous) || Math.max(...times) !== micros(packet.observedAt)) {
    throw new Error('House calls require a later complete publisher observation.');
  }
  const captured = new Set(pages.filter(p => p.state === 'archived' && p.sha256 && p.bytes &&
    p.key === 'committee/house-calls/sources/' + p.sha256 + '.html').map(p => p.language + '/' + p.url));
  for (const lang of ['en','fr']) {
    if (!captured.has(lang + '/' + listingUrl(lang)) || !packet.calls.some(row => row.language === lang && row.metadata.listed)) {
      throw new Error('House calls require both nonempty official listings.');
    }
  }
  if (captured.size !== pages.length || packet.calls.some(row => row.metadata.listed && !captured.has(row.language + '/' + row.url))) {
    throw new Error('Missing or duplicate House source evidence.');
  }
}

function checkListed(row: Call, old: z.infer<typeof metadata> | undefined, observedAt: string) {
  const m = row.metadata;
  if (m.observedAt !== observedAt || m.lastListedAt !== observedAt || m.firstObservedAt !== (old?.firstObservedAt ?? observedAt)) {
    throw new Error('Invalid House call observation dates.');
  }
  if (!old) {
    if (m.revision !== 1 || m.pendingDigest !== null) throw new Error('Invalid initial House call revision.');
    return;
  }
  const changed = old.contentDigest !== m.contentDigest;
  if (m.revision !== old.revision + Number(changed) || (changed &&
      (m.contentConflict || m.pendingDigest !== null || old.pendingDigest !== m.contentDigest))) {
    throw new Error('Unconfirmed House call revision.');
  }
}

function prepareCalls(base: HouseBase, packet: HousePacket) {
  const previous = new Map(base.prior.map(row => [key(row), row]));
  const seen = new Set<string>();
  const counts = { calls: 0, added: 0, changed: 0, unchanged: 0, dropped: 0, pending: 0, conflicts: 0 };
  const rows = packet.calls.map(row => {
    checkRow(row);
    const k = key(row);
    if (seen.has(k)) throw new Error('Duplicate House call edition.');
    seen.add(k);
    const before = previous.get(k);
    const old = before && metadata.parse(JSON.parse(before.metadata_json));
    const m = row.metadata;
    if (m.listed) {
      checkListed(row, old, packet.observedAt);
      counts.calls++;
      if (!old) counts.added++;
      else if (m.revision > old.revision) counts.changed++;
      else counts.unchanged++;
      if (m.pendingDigest) counts.pending++;
      if (m.contentConflict) counts.conflicts++;
    } else {
      if (!old || before?.title !== row.title || sortedJson({ ...old, listed: false }) !== sortedJson(m)) {
        throw new Error('A dropped House call must retain its prior publication.');
      }
      if (old.listed) counts.dropped++;
    }
    return { id:row.id, language:row.language, title:row.title, url:row.url,
      committee:row.committee_id, study:row.committee_id + '-study-' + m.studyId,
      listed:m.listed, metadata_json:sortedJson(m) };
  });
  for (const [k, old] of previous) {
    if (!seen.has(k) && JSON.parse(old.metadata_json).listed !== false) throw new Error('Missing dropped House call edition.');
  }
  return { rows:JSON.stringify(rows), counts };
}

const studyInfo = z.strictObject({ id:z.string(), language, title:z.string().optional() });
const resultSchema = z.strictObject({ session, instanceId:instance, scheduledTime:z.number(), observedAt:instant, cutoff:instant,
  packetSha256:digest, counts:z.strictObject({ calls:z.number(), added:z.number(), changed:z.number(), unchanged:z.number(),
    dropped:z.number(), pending:z.number(), conflicts:z.number() }), studiesNotYetInCorpus:studyInfo.array(), studyTitlesRepaired:studyInfo.array() });
type Result = z.infer<typeof resultSchema>;
const studyJoin = `s.session=? AND s.id=j.value->>'$.study' AND s.language=j.value->>'$.language'
  AND s.kind='study' AND s.chamber='house' AND s.committee_id=j.value->>'$.committee'`;
const actionTitle = "lower(trim(s.title)) IN ('participate','participez')";

async function previousCommit(db: D1Database, instanceId: string, packetHash: string, contentHash: string) {
  const priorRun = await db.prepare('SELECT packet_sha256,content_sha256,result_json FROM cc_house_runs WHERE instance_id=?')
    .bind(instanceId).first<{packet_sha256:string; content_sha256:string; result_json:string}>();
  if (!priorRun) return null;
  if (priorRun.packet_sha256 !== packetHash || priorRun.content_sha256 !== contentHash) throw new Error('Conflicting House packet for an existing occurrence.');
  return resultSchema.parse(JSON.parse(priorRun.result_json));
}

export async function publishHouse(db: D1Database, inputBase: HouseBase, input: unknown, packetSha256?: string): Promise<Result> {
  const base = HouseBase.parse(inputBase), packet = HousePacket.parse(input);
  const contentHash = sha(sortedJson(packet)), packetHash = digest.parse(packetSha256 ?? contentHash);
  const existing = await previousCommit(db, packet.instanceId, packetHash, contentHash);
  if (existing) return existing;
  checkFreshness(base, packet);
  const { rows, counts } = prepareCalls(base, packet);
  const summary = JSON.stringify({ session:packet.session,instanceId:packet.instanceId,scheduledTime:packet.scheduledTime,
    observedAt:packet.observedAt,cutoff:base.cutoff,packetSha256:packetHash,counts });
  const priorRows = JSON.stringify(base.prior);
  const current = packet.session;
  // Put the ledger, rows, relationship inserts and permitted title repairs in the same D1 transaction.
  const statements = [
    db.prepare(`INSERT INTO cc_house_guard SELECT
      (SELECT cutoff FROM cc_snapshot WHERE session=?) IS ? AND (${lastInstance}) IS ? AND
      (SELECT COUNT(*) FROM (${priorSelect}))=json_array_length(?) AND
      NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN cc_records r ON r.session=? AND r.id=j.value->>'$.id'
        AND r.language=j.value->>'$.language' AND r.kind='call' AND r.chamber='house'
        WHERE r.title IS NOT j.value->>'$.title' OR r.metadata_json IS NOT j.value->>'$.metadata_json') AND
      NOT EXISTS (SELECT 1 FROM json_each(?) j JOIN cc_records r ON r.session=? AND r.id=j.value->>'$.id'
        AND r.language=j.value->>'$.language' WHERE r.kind IS NOT 'call' OR r.chamber IS NOT 'house')`)
      .bind(current,base.cutoff,current,base.headInstance,current,priorRows,priorRows,current,rows,current),
    db.prepare(`INSERT INTO cc_house_runs VALUES(?,?,?,?,?,?,json_set(?,
      '$.studiesNotYetInCorpus',json((SELECT json_group_array(json_object('id',j.value->>'$.study','language',j.value->>'$.language'))
        FROM json_each(?) j LEFT JOIN cc_records s ON ${studyJoin} WHERE j.value->>'$.listed' AND s.id IS NULL)),
      '$.studyTitlesRepaired',json((SELECT json_group_array(json_object('id',s.id,'language',s.language,'title',j.value->>'$.title'))
        FROM json_each(?) j JOIN cc_records s ON ${studyJoin} WHERE j.value->>'$.listed' AND ${actionTitle}))))`)
      .bind(packet.instanceId,current,packet.scheduledTime,packet.observedAt,packetHash,contentHash,summary,rows,current,rows,current),
    db.prepare(`INSERT INTO cc_records(session,id,language,kind,chamber,committee_id,title,url,status,metadata_json)
      SELECT ?,value->>'$.id',value->>'$.language','call','house',value->>'$.committee',value->>'$.title',value->>'$.url',
        'indexed',value->>'$.metadata_json' FROM json_each(?) WHERE true ON CONFLICT(session,id,language) DO UPDATE SET
        title=excluded.title,metadata_json=excluded.metadata_json WHERE cc_records.title IS NOT excluded.title
        OR cc_records.metadata_json IS NOT excluded.metadata_json`).bind(current,rows),
    db.prepare(`INSERT OR IGNORE INTO cc_links(session,language,parent_id,child_id,relation)
      SELECT ?,value->>'$.language',value->>'$.committee',value->>'$.id','publishes'
      FROM json_each(?) WHERE value->>'$.listed'`).bind(current,rows),
    db.prepare(`INSERT OR IGNORE INTO cc_links(session,language,parent_id,child_id,relation)
      SELECT ?,s.language,s.id,j.value->>'$.id','study-call'
      FROM json_each(?) j JOIN cc_records s ON ${studyJoin} WHERE j.value->>'$.listed'`).bind(current,rows,current),
    db.prepare(`UPDATE cc_records AS s SET title=j.value->>'$.title' FROM json_each(?) j WHERE ${studyJoin}
      AND j.value->>'$.listed' AND ${actionTitle}`).bind(rows,current),
    db.prepare('DELETE FROM cc_house_guard'),
    db.prepare('SELECT result_json FROM cc_house_runs WHERE instance_id=?').bind(packet.instanceId),
  ];
  try {
    const result = await db.batch<{result_json:string}>(statements);
    return resultSchema.parse(JSON.parse(String(result[result.length-1].results[0].result_json)));
  } catch (error) {
    const committed = await previousCommit(db, packet.instanceId, packetHash, contentHash);
    if (committed) return committed;
    throw error;
  }
}
