import { applyCompactRestorePage, COMPACT_CORPUS_SCHEMA, verifyCompactRestorePage, type CompactRestorePage } from '../../src/corpora/compact-restore';
import { auditProvisionTextPage, MAX_PROVISION_TEXT_BYTES, provisionTextKey, readVerifiedProvisionText, textSha256,
  writeImmutableProvisionText, type ProvisionTextReference, type TextParityCheckpoint } from '../../src/corpora/text-store';
import { readJsonBody, RequestInputError } from '../../src/http';
import { checkedRestorePlan, checkedTarget, digestPattern, hashJson, nextPageChain, RESTORE_SUPPORT_SCHEMA,
  RestoreInputError, type RestorePlan, type StagingRestoreTarget } from './protocol';
import { isFreshRestoreDatabase } from './fresh-schema';
import { decodeUploadBatch, MAX_UPLOAD_BATCH_BYTES, UPLOAD_BATCH_CAPABILITIES, UPLOAD_BATCH_PARALLELISM,
  type UploadBatchAcknowledgement } from './upload-batch';
import { applyMetadataBatch,checkedMetadataBatch,METADATA_BATCH_CAPABILITIES,AUDIT_CAPABILITIES } from './metadata-batch';

/** This contract is exercised against actual local D1/R2 bindings. The disabled
 * checked-in config has no bindings; generated staging config supplies them. */
export interface RestoreEnv {
  RESTORE_ENABLED?: string; RESTORE_STAGE_ID?: string; RESTORE_ACCOUNT_ID?: string; RESTORE_D1_ID?: string; RESTORE_R2_NAME?: string;
  RESTORE_TOKEN?: string; RESTORE_DB?: D1Database; RESTORE_TEXTS?: R2Bucket;
}
interface Session {
  plan_sha256: string; plan_json: string; stage_id: string; account_id: string; d1_id: string; r2_name: string;
  phase: 'loading' | 'checking' | 'published' | 'complete'; page_check_after: number; page_check_chain: string; audit_checkpoint: string | null;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });

async function authorize(request: Request, env: RestoreEnv) {
  if (env.RESTORE_ENABLED !== 'staging-only' || !env.RESTORE_DB || !env.RESTORE_TEXTS || !env.RESTORE_TOKEN ||
      env.RESTORE_TOKEN.length < 32 || env.RESTORE_TOKEN.length > 512) throw new RestoreInputError('Staging restore is disabled.', 403);
  const authorization = request.headers.get('authorization') ?? '';
  const incoming = authorization.startsWith('Bearer ') && authorization.length <= 1024 ? authorization.slice(7) : '';
  const encoder = new TextEncoder();
  const [expected, supplied] = await Promise.all([env.RESTORE_TOKEN, incoming].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  if (!incoming || !crypto.subtle.timingSafeEqual(expected!, supplied!)) throw new RestoreInputError('Restore authentication required.', 401);
  const target = checkedTarget({ format: 1, stageOnly: true, stageId: env.RESTORE_STAGE_ID, accountId: env.RESTORE_ACCOUNT_ID,
    d1Id: env.RESTORE_D1_ID, r2Bucket: env.RESTORE_R2_NAME, adminUrl: new URL(request.url).origin });
  for (const [header, value] of [['x-restore-stage',target.stageId],['x-restore-account',target.accountId],['x-restore-d1',target.d1Id],['x-restore-r2',target.r2Bucket]]) {
    if (request.headers.get(header!) !== value) throw new RestoreInputError('The staging resource identity does not match.', 403);
  }
  const planHash = request.headers.get('x-restore-plan') ?? '';
  if (!digestPattern.test(planHash)) throw new RestoreInputError('A checked restore plan identity is required.');
  return { db: env.RESTORE_DB, bucket: env.RESTORE_TEXTS, target, planHash };
}

async function currentSession(db: D1Database) {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_restore_session'").first();
  return table ? db.prepare('SELECT * FROM stage_restore_session WHERE id=1').first<Session>() : null;
}

function checkSession(session: Session | null, target: StagingRestoreTarget, planHash: string): asserts session is Session {
  if (!session) throw new RestoreInputError('Initialize the fresh staging restore first.', 409);
  if (session.plan_sha256 !== planHash || session.stage_id !== target.stageId || session.account_id !== target.accountId ||
      session.d1_id !== target.d1Id || session.r2_name !== target.r2Bucket) throw new RestoreInputError('This target belongs to another restore plan.', 409);
}

async function status(db: D1Database, target: StagingRestoreTarget, planHash: string) {
  const session = await currentSession(db);
  if (!session) {
    return { target, initialized: false, fresh: await isFreshRestoreDatabase(db),uploadBatch:UPLOAD_BATCH_CAPABILITIES,metadataBatch:METADATA_BATCH_CAPABILITIES,auditProtocol:AUDIT_CAPABILITIES };
  }
  checkSession(session, target, planHash);
  const plan=checkedRestorePlan(JSON.parse(session.plan_json));
  const journal=await db.prepare(`SELECT coalesce(max(ordinal),0) AS objects,
    coalesce((SELECT cumulative_bytes FROM stage_restore_objects ORDER BY ordinal DESC LIMIT 1),0) AS objectBytes FROM stage_restore_objects`).first<{objects:number;objectBytes:number}>();
  const metadata=session.phase==='loading'?await db.prepare(`SELECT (SELECT count(*) FROM statute_sections) AS rows,
    (SELECT count(*) FROM statute_text_refs) AS refs,(SELECT count(*) FROM corpus_compact_pages) AS pages`).first():
    {rows:plan.rowCount,refs:plan.rowCount,pages:plan.pageCount};
  const counts={...metadata,...journal};
  return { target, initialized: true, planHash, phase: session.phase, counts, checkedPages: session.page_check_after,uploadBatch:UPLOAD_BATCH_CAPABILITIES,metadataBatch:METADATA_BATCH_CAPABILITIES,auditProtocol:AUDIT_CAPABILITIES,
    countsVerifiedAtPublication:session.phase!=='loading',
    audit: session.audit_checkpoint ? JSON.parse(session.audit_checkpoint) as TextParityCheckpoint : null };
}

async function objectBytes(request: Request,validateUtf8=true) {
  if (Number(request.headers.get('content-length')) > MAX_PROVISION_TEXT_BYTES) throw new RestoreInputError('The object exceeds 2 MiB.',413);
  const reader = request.body?.getReader();
  if (!reader) throw new RestoreInputError('A non-empty text object is required.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
      if (length > MAX_PROVISION_TEXT_BYTES) { await reader.cancel(); throw new RestoreInputError('The object exceeds 2 MiB.',413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new RestoreInputError('A non-empty text object is required.');
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  if(validateUtf8)checkedUtf8(bytes);
  return bytes;
}

function checkedUtf8(bytes:Uint8Array<ArrayBuffer>) {
  try {new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch {throw new RestoreInputError('The text must be valid UTF-8.');}
}

/** Arrival ordinal remains the existing journal's counter. Source ordinals in
 * batch descriptors/acks bind only the pinned client request's source range. */
async function commitObject(db:D1Database,bucket:R2Bucket,plan:RestorePlan,sha:string,bytes:Uint8Array<ArrayBuffer>) {
  const reference:ProvisionTextReference={rowId:'stage-upload',corpusId:'statutes-canada',rowFingerprint:'0'.repeat(32),contentSha256:sha,
    objectKey:provisionTextKey(sha),bytes:bytes.byteLength,createdAt:plan.publication.lastRunAt};
  await writeImmutableProvisionText(bucket,{reference,bytes});
  await db.prepare(`INSERT OR IGNORE INTO stage_restore_objects(ordinal,object_key,sha256,bytes,cumulative_bytes)
    SELECT (SELECT coalesce(max(ordinal),0)+1 FROM stage_restore_objects),?,?,?,
    coalesce((SELECT cumulative_bytes FROM stage_restore_objects ORDER BY ordinal DESC LIMIT 1),0)+?
    WHERE (SELECT coalesce(max(ordinal),0) FROM stage_restore_objects)<?`)
    .bind(reference.objectKey,sha,bytes.byteLength,bytes.byteLength,plan.objectCount).run();
  const recorded=await db.prepare('SELECT sha256,bytes FROM stage_restore_objects WHERE object_key=?').bind(reference.objectKey).first<{sha256:string;bytes:number}>();
  if(recorded?.sha256!==sha||recorded.bytes!==bytes.byteLength)throw new RestoreInputError('The planned unique-object bound was exceeded.',409);
  return {verified:true as const,sha256:sha,bytes:bytes.byteLength};
}

async function initialize(request: Request, db: D1Database, target: StagingRestoreTarget, planHash: string) {
  const plan = checkedRestorePlan(await readJsonBody(request,32*1024));
  if (await hashJson(plan) !== planHash || plan.schemaSha256 !== await textSha256(new Uint8Array(new TextEncoder().encode(COMPACT_CORPUS_SCHEMA)))) throw new RestoreInputError('The plan or fresh schema identity differs.',422);
  const existing = await currentSession(db);
  if (existing) { checkSession(existing,target,planHash); return; }
  if (!await isFreshRestoreDatabase(db)) throw new RestoreInputError('Only a fresh empty staging database can be initialized.',409);
  const statements = (COMPACT_CORPUS_SCHEMA + RESTORE_SUPPORT_SCHEMA).split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql));
  statements.push(db.prepare(`INSERT INTO stage_restore_session(id,plan_sha256,plan_json,stage_id,account_id,d1_id,r2_name,phase,page_check_chain) VALUES(1,?,?,?,?,?,?,'loading',?)`)
    .bind(planHash,JSON.stringify(plan),target.stageId,target.accountId,target.d1Id,target.r2Bucket,'0'.repeat(64)));
  await db.batch(statements);
}

async function publish(db: D1Database, session: Session, plan: RestorePlan) {
  if (session.phase === 'published' || session.phase === 'complete') return;
  if(session.phase==='loading'){
  const counts = await db.prepare(`SELECT (SELECT count(*) FROM statute_sections) AS rows,(SELECT count(*) FROM statute_text_refs) AS refs,
    (SELECT count(*) FROM corpus_compact_pages) AS pages,(SELECT coalesce(sum(row_count),0) FROM corpus_compact_pages) AS pageRows,
    (SELECT coalesce(max(ordinal),0) FROM stage_restore_objects) AS objects,
    coalesce((SELECT cumulative_bytes FROM stage_restore_objects ORDER BY ordinal DESC LIMIT 1),0) AS bytes`).first<Record<string,number>>();
  if (!counts || counts['rows'] !== plan.rowCount || counts['refs'] !== plan.rowCount || counts['pages'] !== plan.pageCount ||
      counts['pageRows'] !== plan.rowCount || counts['objects'] !== plan.objectCount || counts['bytes'] !== plan.objectBytes) throw new RestoreInputError('The complete object and metadata counts are required before publication.',409);
  await db.prepare("UPDATE stage_restore_session SET phase='checking' WHERE id=1 AND phase='loading'").run();
  }
  const batch = await db.prepare('SELECT page,sha256 FROM corpus_compact_pages WHERE page>? ORDER BY page LIMIT 64').bind(session.page_check_after).all<{page:number;sha256:string}>();
  let after = session.page_check_after; let chain = session.page_check_chain;
  for (const page of batch.results) { if (page.page !== after+1) throw new RestoreInputError('The metadata page journal is incomplete.',422);
    chain = await nextPageChain(chain,page.sha256); after = page.page; }
  if (after === plan.pageCount) {
    if (chain !== plan.pagesChainSha256) throw new RestoreInputError('The restored page journal differs from the checked bundle.',422);
    const p = plan.publication;
    await db.batch([
      db.prepare('INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at,parser_version) VALUES(?,?,?,?,?,?,?)')
        .bind('statutes-canada',p.commit,p.date,p.asOf,p.rows,p.lastRunAt,p.parser),
      db.prepare("UPDATE stage_restore_session SET phase='published',page_check_after=?,page_check_chain=? WHERE id=1 AND page_check_after=? AND phase='checking'")
        .bind(after,chain,session.page_check_after),
    ]);
  } else {
    const updated = await db.prepare("UPDATE stage_restore_session SET page_check_after=?,page_check_chain=? WHERE id=1 AND page_check_after=? AND phase='checking'")
      .bind(after,chain,session.page_check_after).run();
    if (updated.meta.changes !== 1) throw new RestoreInputError('A concurrent publication step advanced; retry status.',409);
  }
}

export async function handleRestoreRequest(request: Request, env: RestoreEnv): Promise<Response> {
  try {
    const {db,bucket,target,planHash} = await authorize(request,env);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/v1/restore/status') return json(await status(db,target,planHash));
    if (request.method === 'POST' && path === '/v1/restore/init') { await initialize(request,db,target,planHash); return json(await status(db,target,planHash)); }
    const session = await currentSession(db); checkSession(session,target,planHash);
    const plan = checkedRestorePlan(JSON.parse(session.plan_json));
    const object = /^\/v1\/restore\/object\/([a-f0-9]{64})$/.exec(path);
    if (request.method === 'PUT' && object) {
      if (session.phase === 'complete') throw new RestoreInputError('The completed restore is read-only.',409);
      const sha = object[1]!; const bytes = await objectBytes(request);
      if (await textSha256(bytes) !== sha) throw new RestoreInputError('The object content digest differs.',422);
      return json(await commitObject(db,bucket,plan,sha,bytes));
    }
    if(request.method==='POST'&&path==='/v1/restore/objects'){
      if(session.phase==='complete')throw new RestoreInputError('The completed restore is read-only.',409);
      const frame=await objectBytes(request,false);
      if(frame.byteLength>MAX_UPLOAD_BATCH_BYTES)throw new RestoreInputError('The complete upload batch exceeds 2 MiB.',413);
      const objects=decodeUploadBatch(frame,plan.objectCount);
      // Every descriptor/content pair validates before the first R2/SQL write.
      for(const item of objects){checkedUtf8(item.bytes);if(await textSha256(item.bytes)!==item.sha256)throw new RestoreInputError('The object content digest differs.',422);}
      const acknowledgements:UploadBatchAcknowledgement[]=Array(objects.length);let position=0;let failed=false;let failure:unknown;
      async function worker(){while(!failed&&position<objects.length){const at=position++;const item=objects[at]!;
        try{acknowledgements[at]={sourceOrdinal:item.sourceOrdinal,...await commitObject(db,bucket,plan,item.sha256,item.bytes)};}catch(error){failed=true;failure=error;}}}
      // All in-flight binding work settles before either success or error reply.
      const outcomes=await Promise.allSettled(Array.from({length:Math.min(UPLOAD_BATCH_PARALLELISM,objects.length)},()=>worker()));
      const unexpected=outcomes.find((outcome)=>outcome.status==='rejected');if(unexpected?.status==='rejected')throw unexpected.reason;
      if(failed)throw failure;
      return json({verified:true,objects:acknowledgements});
    }
    if(request.method==='POST'&&path==='/v1/restore/pages'){
      if(session.phase!=='loading')throw new RestoreInputError('Metadata loading is closed.',409);
      const pages=await checkedMetadataBatch(await readJsonBody(request,METADATA_BATCH_CAPABILITIES.maxBytes),plan.pageCount);
      return json({verified:true,planHash,pages:await applyMetadataBatch(db,bucket,plan,pages)});
    }
    if (request.method === 'POST' && path === '/v1/restore/page') {
      if (session.phase !== 'loading') throw new RestoreInputError('Metadata loading is closed.',409);
      const page = await readJsonBody(request) as CompactRestorePage;
      try { await verifyCompactRestorePage(page); } catch { throw new RestoreInputError('Invalid checked metadata page.',422); }
      if (page.page > plan.pageCount) throw new RestoreInputError('The metadata page exceeds the plan.',422);
      for (let at=1;at<page.statements.length;at+=2) {
        const params = page.statements[at]!.params;
        await readVerifiedProvisionText(bucket,{rowId:String(params[0]),corpusId:String(params[1]),rowFingerprint:String(params[2]),
          contentSha256:String(params[3]),objectKey:String(params[4]),bytes:Number(params[5]),createdAt:String(params[6])});
      }
      return json(await applyCompactRestorePage(db,page,{bundleSha256:plan.pagesSha256,revision:plan.revision}));
    }
    if (request.method === 'POST' && path === '/v1/restore/publish') {
      await readJsonBody(request,1024); await publish(db,session,plan); return json(await status(db,target,planHash));
    }
    if (request.method === 'POST' && path === '/v1/restore/audit') {
      const body = await readJsonBody(request,1024) as {pages?:unknown};
      const pages = body?.pages ?? 1;
      if (!Number.isSafeInteger(pages) || Number(pages)<1 || Number(pages)>AUDIT_CAPABILITIES.maxCheckpoints) throw new RestoreInputError('An audit request contains between one and sixteen bounded checkpoints.');
      if (session.phase === 'complete') return json(await status(db,target,planHash));
      if (session.phase !== 'published') throw new RestoreInputError('Publish the fully checked metadata before its text audit.',409);
      let stored = session.audit_checkpoint;
      for (let at=0;at<Number(pages);at++) {
        const checkpoint = await auditProvisionTextPage(db,bucket,{expectedRevision:plan.revision,mode:'r2',
          ...(stored ? {checkpoint:JSON.parse(stored) as TextParityCheckpoint} : {})});
        if (checkpoint.complete && checkpoint.bytesVerified !== plan.textBytes) throw new RestoreInputError('The audited byte total differs from the plan.',422);
        const next = JSON.stringify(checkpoint);
        const updated = await db.prepare('UPDATE stage_restore_session SET audit_checkpoint=?,phase=? WHERE id=1 AND phase=? AND audit_checkpoint IS ?')
          .bind(next,checkpoint.complete?'complete':'published','published',stored).run();
        if (updated.meta.changes !== 1) throw new RestoreInputError('A concurrent audit step advanced; retry status.',409);
        stored = next;
        if (checkpoint.complete) break;
      }
      return json(await status(db,target,planHash));
    }
    throw new RestoreInputError('No such staging restore endpoint.',404);
  } catch (error) {
    if (error instanceof RestoreInputError || error instanceof RequestInputError) return json({error:'restore_rejected',message:error.message},error.status);
    return json({error:'restore_failed',message:'The staging restore step failed. Its committed checkpoint is safe to retry.'},503);
  }
}

export default {fetch:handleRestoreRequest} satisfies ExportedHandler<RestoreEnv>;
