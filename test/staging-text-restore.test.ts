import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareTextCutover, jsonLines, readCutoverObject, type CutoverTextReference } from '../scripts/prepare-text-cutover';
import { restoreTextStaging, stagingPlan } from '../scripts/restore-text-staging';
import { checkedTarget, hashJson, type StagingRestoreTarget } from '../services/restore/protocol';
import { compactPageDigest, type CompactRestorePage } from '../src/corpora/compact-restore';
import { provisionTextKey,rowFingerprintWithText,textSha256 } from '../src/corpora/text-store';
import { encodeUploadBatch,MAX_UPLOAD_BATCH_BYTES,uploadBatchBytes,type UploadBatchObject } from '../services/restore/upload-batch';
import { metadataBatchBytes,METADATA_BATCH_CAPABILITIES,verifiedMetadataAcknowledgements } from '../services/restore/metadata-batch';
import { testD1 } from './helpers/d1';

const close:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const finish of close.splice(0).reverse())await finish();});
let script='';
beforeAll(async()=>{const output=await build({entryPoints:['services/restore/worker.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});script=output.outputFiles[0]!.text;});

async function first(path:string){for await(const value of jsonLines(path))return value;throw new Error('Empty fixture.');}
async function fixture(largeFirst=false,sectionsPerLanguage=9,headingPadding=0,textBytes=0){
  const directory=await mkdtemp(join(tmpdir(),'civicsignal-stage-restore-'));close.push(()=>rm(directory,{recursive:true,force:true}));
  const original=testD1();close.push(original.close);
  const rows:Record<string,unknown>[]=[];
  for(const language of ['en','fr'])for(let section=1;section<=sectionsPerLanguage;section++){
    const baseText=language==='en'?`Original rule ${section}.`:`Règle originale ${section}.`;
    const paddedCharacters=textBytes-(new TextEncoder().encode(baseText).byteLength-baseText.length);
    const row={id:`acts-${language}-${section}`,corpus_id:'statutes-canada',act:language==='en'?'Test Act':'Loi de test',citation:'T-1',section:String(section),
      status:'in-force',schedule:null,part:null,heading:headingPadding?'Heading '.padEnd(headingPadding,'H'):null,text:largeFirst&&language==='en'&&section===1?'X'.repeat(MAX_UPLOAD_BATCH_BYTES-20):baseText.padEnd(paddedCharacters,language==='en'?'E':'F'),
      source_url:`https://laws-lois.justice.gc.ca/${language}/acts/T-1/section-${section}.html`,jurisdiction:'CA',in_force:1,topics:null,language,last_changed:'2026-10-15'};
    rows.push({...row,text_hash:rowFingerprintWithText(row,row.text)});
  }
  rows.sort((a,b)=>String(a['id'])<String(b['id'])?-1:1);
  for(const row of rows)original.sqlite.prepare(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,heading,text,source_url,language,text_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...['id','corpus_id','act','citation','section','status','heading','text','source_url','language','text_hash'].map((name)=>row[name]) as (string|number|null)[]);
  const input=join(directory,'rows.jsonl');await writeFile(input,rows.map((row)=>JSON.stringify(row)).join('\n')+'\n');
  const receipt=join(directory,'receipt.json');const commit='a'.repeat(40);
  await writeFile(receipt,JSON.stringify({format:1,source:{commit,date:'2026-10-15',parser:'legacy',indexDigest:'b'.repeat(32),rows:rows.length,embedded:rows.length,placeholders:0,dimensions:768},
    files:Object.fromEntries(['manifest.json','vectors.manifest.json','index.jsonl','store.emb'].map((name)=>[`${commit}.${name}`,{bytes:1,sha256:'c'.repeat(64)}])),
    verification:{allRows:true,rows:rows.length,allVectorPositions:true,finite:true,placeholderZeros:true}}));
  const bundle=join(directory,'bundle');
  const manifest=await prepareTextCutover({input,output:bundle,revision:`${commit}:legacy`,objectStorage:'pack',sourceReceipt:receipt,
    createdAt:'2026-10-22T00:00:00Z',publication:{commit,parser:null,date:'2026-10-15',asOf:'2026-10-15',lastRunAt:'2026-10-22T00:00:00Z',rows:rows.length}});
  const target:StagingRestoreTarget={format:1,stageOnly:true,stageId:'stage-fixture',accountId:'a'.repeat(32),d1Id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',r2Bucket:'fixture-stage-texts',adminUrl:'http://localhost'};
  const token='fixture-only-token-'.repeat(3);
  const mf=new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:resolve('dist/miniflare-restore-tests'),workers:[{config:{
    name:`stage-restore-${Date.now()}`,compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],env:{
      RESTORE_DB:{type:'d1',id:target.d1Id,dev:{remote:false}},RESTORE_TEXTS:{type:'r2',name:target.r2Bucket,dev:{remote:false}},
      ...Object.fromEntries(Object.entries({RESTORE_ENABLED:'staging-only',RESTORE_STAGE_ID:target.stageId,RESTORE_ACCOUNT_ID:target.accountId,
        RESTORE_D1_ID:target.d1Id,RESTORE_R2_NAME:target.r2Bucket,RESTORE_TOKEN:token}).map(([key,value])=>[key,{type:'text' as const,value}])),
    },manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:script}}}}}]});
  close.push(()=>mf.dispose());
  const plan=await stagingPlan(bundle);
  const headers={authorization:`Bearer ${token}`,'x-restore-stage':target.stageId,'x-restore-account':target.accountId,'x-restore-d1':target.d1Id,
    'x-restore-r2':target.r2Bucket,'x-restore-plan':plan.planHash,'content-type':'application/json'};
  const send:typeof fetch=async(input,init)=>{
    const url=typeof input==='string'?input:'href' in input?input.href:input.url;
    const request=new Request(url,init);
    const body=['GET','HEAD'].includes(request.method)?undefined:new Uint8Array(await request.arrayBuffer());
    const result=await mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],...(body?{body}:{})});
    return new Response(await result.arrayBuffer(),{status:result.status,headers:[...result.headers]});
  };
  async function call(path:string,body:unknown={},method='POST',override:Record<string,string>={}){
    return send(`${target.adminUrl}/v1/restore/${path}`,{method,headers:{...headers,...override},...(method!=='GET'?{body:body instanceof Uint8Array?body:JSON.stringify(body)}:{})});
  }
  async function upload(){for await(const value of jsonLines(join(bundle,'references.jsonl'))){const ref=value as unknown as CutoverTextReference;
    const result=await call(`object/${ref.contentSha256}`,await readCutoverObject(bundle,ref,manifest),'PUT');expect(result.status).toBe(200);}}
  return {directory,bundle,manifest,plan,target,token,mf,send,call,upload,original,rows};
}

async function sourceObjects(f:Awaited<ReturnType<typeof fixture>>,count=18){
  const objects:UploadBatchObject[]=[];let sourceOrdinal=0;
  for await(const row of jsonLines(join(f.bundle,'object-index.jsonl'))){sourceOrdinal++;if(sourceOrdinal>count)break;
    const reference=row as unknown as CutoverTextReference;
    objects.push({sourceOrdinal,sha256:reference.contentSha256,bytes:await readCutoverObject(f.bundle,reference,f.manifest)});
  }
  return objects;
}

async function sourcePages(f:Awaited<ReturnType<typeof fixture>>){const pages:CompactRestorePage[]=[];
  for await(const value of jsonLines(join(f.bundle,'fresh-pages.jsonl')))pages.push(value as unknown as CompactRestorePage);return pages;}

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('isolated staging restore using real local workerd D1 and R2 bindings',()=>{
  it('restores through the actual client, preserves legacy NULL publication and all original rows, and resumes completed audit',async()=>{
    const f=await fixture();const baseline=f.original.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all();
    let calls=0;
    const dry=await restoreTextStaging({bundle:f.bundle,target:f.target,fetch:async()=>{calls++;throw new Error('Plan mode must be offline.');}});
    expect(dry.execute).toBe(false);expect(calls).toBe(0);
    let injected=false;const localFetch:typeof fetch=async(input,init)=>{if(!injected&&init?.method==='PUT'){injected=true;return new Response('retry',{status:503});}return f.send(input,init);};
    const result=await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint:join(f.directory,'progress.json'),fetch:localFetch});
    expect(result).toMatchObject({execute:true,audit:{complete:true,rowsVerified:18,bytesVerified:f.manifest.textBytes}});
    const db=await f.mf.getD1Database('RESTORE_DB');
    expect(await db.prepare('SELECT commit_sha,parser_version,commit_date,row_count FROM corpus_state').first()).toEqual({commit_sha:'a'.repeat(40),parser_version:null,commit_date:'2026-10-15',row_count:18});
    expect(await db.prepare('SELECT count(*) AS count,sum(length(text)) AS bytes FROM statute_sections').first()).toEqual({count:18,bytes:0});
    expect(await db.prepare('SELECT count(*) AS count FROM corpus_runs').first()).toEqual({count:0});
    expect(await db.prepare('SELECT count(*) AS count FROM corpus_changes').first()).toEqual({count:0});
    expect(await db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='workspace' OR name='user'").first()).toEqual({count:0});
    expect(f.original.sqlite.prepare('SELECT * FROM statute_sections ORDER BY id').all()).toEqual(baseline);
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint:join(f.directory,'progress.json'),fetch:f.send})).toMatchObject({audit:{complete:true,rowsVerified:18}});
    const ref=await first(join(f.bundle,'references.jsonl')) as unknown as CutoverTextReference;
    expect((await f.call(`object/${ref.contentSha256}`,await readCutoverObject(f.bundle,ref,f.manifest),'PUT')).status).toBe(409);
  },30_000);

  it('rejects credentials, production/mismatched identities and populated stores before schema writes',async()=>{
    const f=await fixture();
    expect((await f.call('init',f.plan.plan,'POST',{authorization:'Bearer wrong'})).status).toBe(401);
    expect((await f.call('init',f.plan.plan,'POST',{'x-restore-d1':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).status).toBe(403);
    expect(()=>checkedTarget({...f.target,d1Id:'8056b1a0-f858-4f89-a332-91f7f350eb7b'})).toThrow();
    expect(()=>checkedTarget({...f.target,adminUrl:'https://api.civicsignal.chesterhillsolutions.ca'})).toThrow();
    const db=await f.mf.getD1Database('RESTORE_DB');await db.exec('CREATE TABLE protected_sentinel(id INTEGER PRIMARY KEY,value TEXT);');
    await db.prepare('INSERT INTO protected_sentinel VALUES(1,?)').bind('preserved').run();
    expect((await f.call('init',f.plan.plan)).status).toBe(409);
    expect(await db.prepare('SELECT value FROM protected_sentinel WHERE id=1').first()).toEqual({value:'preserved'});
    expect(await db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='statute_sections'").first()).toEqual({count:0});
  },30_000);

  it('rejects an existing application view in both status and initialization',async()=>{
    const f=await fixture();const db=await f.mf.getD1Database('RESTORE_DB');
    await db.exec('CREATE VIEW protected_view AS SELECT 42 AS preserved;');
    expect(await(await f.call('status',undefined,'GET')).json()).toMatchObject({initialized:false,fresh:false});
    expect((await f.call('init',f.plan.plan)).status).toBe(409);
    expect(await db.prepare('SELECT * FROM protected_view').first()).toEqual({preserved:42});
    expect(await db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='statute_sections'").first()).toEqual({count:0});
  },30_000);

  it('does not treat the underscore in the SQLite bookkeeping prefix as a wildcard',async()=>{
    const f=await fixture();const db=await f.mf.getD1Database('RESTORE_DB');
    await db.exec('CREATE TABLE sqliteXhidden (id INTEGER PRIMARY KEY);');
    await db.prepare('INSERT INTO sqliteXhidden VALUES(42)').run();
    expect(await(await f.call('status',undefined,'GET')).json()).toMatchObject({initialized:false,fresh:false});
    expect((await f.call('init',f.plan.plan)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='statute_sections'").first()).toEqual({count:0});
    expect(await db.prepare('SELECT id FROM sqliteXhidden').first()).toEqual({id:42});
  },30_000);

  it('resumes batched source ranges over out-of-order arrival ordinals and uncertain committed uploads',async()=>{
    const f=await fixture();expect((await f.call('init',f.plan.plan)).status).toBe(200);const objects=await sourceObjects(f);
    // A paused four-object checkpoint can have later identical puts committed,
    // and the old concurrent transport assigns arrival ordinals in any order.
    for(const item of objects.slice(0,6).reverse())expect((await f.call(`object/${item.sha256}`,item.bytes,'PUT')).status).toBe(200);
    const checkpoint=join(f.directory,'partial.json');await writeFile(checkpoint,JSON.stringify({format:1,planHash:f.plan.planHash,targetHash:await hashJson(f.target),uploadedObjects:4,appliedPages:0}));
    let frames=0;let lost=false;const withLostAck:typeof fetch=async(input,init)=>{const response=await f.send(input,init);
      if(String(input).endsWith('/objects')){frames++;if(!lost){lost=true;await response.body?.cancel();return new Response('uncertain acknowledgement',{status:503});}}return response;};
    const result=await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,concurrency:4,uploadBatchSize:16,fetch:withLostAck});
    expect(result).toMatchObject({audit:{complete:true,rowsVerified:18,bytesVerified:f.manifest.textBytes}});expect(frames).toBe(2);
    const db=await f.mf.getD1Database('RESTORE_DB');
    expect(await db.prepare('SELECT sha256 FROM stage_restore_objects WHERE ordinal=1').first()).toEqual({sha256:objects[5]!.sha256});
    expect(await db.prepare('SELECT count(*) AS count,max(ordinal) AS last,sum(bytes) AS bytes FROM stage_restore_objects').first()).toEqual({count:18,last:18,bytes:f.manifest.objectsBytes});
    expect(await db.prepare('SELECT cumulative_bytes FROM stage_restore_objects ORDER BY ordinal DESC LIMIT 1').first()).toEqual({cumulative_bytes:f.manifest.objectsBytes});
    expect(JSON.parse(await readFile(checkpoint,'utf8'))).toMatchObject({uploadedObjects:18,appliedPages:2});
  },30_000);

  it('refuses an incomplete acknowledgement set without advancing a checkpoint and safely replays',async()=>{
    const f=await fixture();const checkpoint=join(f.directory,'bad-ack.json');let altered=false;
    const badAck:typeof fetch=async(input,init)=>{const response=await f.send(input,init);if(!altered&&String(input).endsWith('/objects')){
      altered=true;const value=await response.json() as {objects:{sourceOrdinal:number}[]};value.objects[0]!.sourceOrdinal=999;
      return Response.json(value);}return response;};
    await expect(restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,uploadBatchSize:16,fetch:badAck})).rejects.toThrow('exact complete upload source range');
    await expect(readFile(checkpoint)).rejects.toMatchObject({code:'ENOENT'});
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,uploadBatchSize:16,fetch:f.send})).toMatchObject({audit:{complete:true,rowsVerified:18}});
    const db=await f.mf.getD1Database('RESTORE_DB');expect(await db.prepare('SELECT count(*) AS count FROM stage_restore_objects').first()).toEqual({count:18});
  },30_000);

  it('uses the compatible single-object path when framing would exceed the aggregate bound',async()=>{
    const f=await fixture(true);let singles=0;let batches=0;
    const inspect:typeof fetch=async(input,init)=>{if(init?.method==='PUT')singles++;if(String(input).endsWith('/objects'))batches++;return f.send(input,init);};
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint:join(f.directory,'large.json'),uploadBatchSize:16,fetch:inspect}))
      .toMatchObject({audit:{complete:true,rowsVerified:18,bytesVerified:f.manifest.textBytes}});
    expect(singles).toBe(1);expect(batches).toBe(2);
  },30_000);

  it('prevalidates every batched hash and UTF8 object before any write, then recovers a partial immutable failure',async()=>{
    const f=await fixture();expect((await f.call('init',f.plan.plan)).status).toBe(200);const objects=await sourceObjects(f,6);
    const badHash=encodeUploadBatch(objects,18);badHash[badHash.length-1]^=1;
    expect((await f.call('objects',badHash)).status).toBe(422);
    const badUtf8=encodeUploadBatch(objects,18);badUtf8[badUtf8.length-1]=0xff;
    expect((await f.call('objects',badUtf8)).status).toBe(400);
    const db=await f.mf.getD1Database('RESTORE_DB');const bucket=await f.mf.getR2Bucket('RESTORE_TEXTS');
    expect(await db.prepare('SELECT count(*) AS count FROM stage_restore_objects').first()).toEqual({count:0});
    expect(await bucket.get(provisionTextKey(objects[0]!.sha256))).toBeNull();
    // Fixture corruption represents a provider failure; immutable writes cannot
    // repair it. Every other in-flight object must settle before the 503 reply.
    await bucket.put(provisionTextKey(objects[0]!.sha256),'corrupt');const frame=encodeUploadBatch(objects,18);
    expect((await f.call('objects',frame)).status).toBe(503);
    const partial=await db.prepare('SELECT count(*) AS count FROM stage_restore_objects').first<{count:number}>();expect(partial!.count).toBeGreaterThan(0);expect(partial!.count).toBeLessThan(6);
    expect(await(await bucket.get(provisionTextKey(objects[0]!.sha256)))?.text()).toBe('corrupt');
    await bucket.put(provisionTextKey(objects[0]!.sha256),objects[0]!.bytes);
    expect((await f.call('objects',frame)).status).toBe(200);expect((await f.call('objects',frame)).status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS count,max(ordinal) AS last FROM stage_restore_objects').first()).toEqual({count:6,last:6});
  },30_000);

  it('processes four concurrent full 2 MiB frames with sixteen individually verified objects each',async()=>{
    const f=await fixture();expect((await f.call('init',f.plan.plan)).status).toBe(200);
    const payload=MAX_UPLOAD_BATCH_BYTES-uploadBatchBytes(16,0);const objects:UploadBatchObject[]=[];
    for(let at=0;at<16;at++){const bytes=new Uint8Array(Math.floor(payload/16)+(at<payload%16?1:0));bytes.fill(65+at);
      objects.push({sourceOrdinal:at+1,sha256:await textSha256(bytes),bytes});}
    const frame=encodeUploadBatch(objects,18);expect(frame.byteLength).toBe(MAX_UPLOAD_BATCH_BYTES);
    const responses=await Promise.all(Array.from({length:4},()=>f.call('objects',frame)));
    for(const response of responses){expect(response.status).toBe(200);
      const body=await response.json() as {objects:{sourceOrdinal:number;sha256:string;bytes:number;verified:boolean}[]};
      expect(body.objects).toEqual(objects.map((item)=>({sourceOrdinal:item.sourceOrdinal,sha256:item.sha256,bytes:item.bytes.length,verified:true})));}
    const db=await f.mf.getD1Database('RESTORE_DB');expect(await db.prepare('SELECT count(*) AS count,sum(bytes) AS bytes FROM stage_restore_objects').first()).toEqual({count:16,bytes:payload});
    const over=new Uint8Array(MAX_UPLOAD_BATCH_BYTES+1);expect((await f.call('objects',over)).status).toBe(413);
  },30_000);

  it('rolls back failed row/reference pages, refuses arbitrary SQL and never overwrites immutable content',async()=>{
    const f=await fixture();expect((await f.call('init',f.plan.plan)).status).toBe(200);
    const page=await first(join(f.bundle,'fresh-pages.jsonl')) as unknown as CompactRestorePage;
    expect((await f.call('page',page)).status).toBe(503);
    await f.upload();
    const ref=await first(join(f.bundle,'references.jsonl')) as unknown as CutoverTextReference;
    expect((await f.call(`object/${ref.contentSha256}`,new TextEncoder().encode('different'),'PUT')).status).toBe(422);
    const bucket=await f.mf.getR2Bucket('RESTORE_TEXTS');expect(await(await bucket.get(ref.objectKey))?.text()).toBe(f.rows[0]?.['text']);
    const forged=structuredClone(page);forged.statements[0]!.query='DROP TABLE statute_sections';
    forged.sha256=await compactPageDigest({page:forged.page,fromAfter:forged.fromAfter,through:forged.through,rows:forged.rows,statements:forged.statements});
    expect((await f.call('page',forged)).status).toBe(422);
    const db=await f.mf.getD1Database('RESTORE_DB');
    await db.exec("CREATE TRIGGER fail_reference BEFORE INSERT ON statute_text_refs BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    const failed=await f.call('page',page);expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('fixture failure');
    expect(await db.prepare('SELECT count(*) AS count FROM statute_sections').first()).toEqual({count:0});
    expect(await db.prepare('SELECT count(*) AS count FROM corpus_compact_pages').first()).toEqual({count:0});
    await db.exec('DROP TRIGGER fail_reference');
    expect((await f.call('page',page)).status).toBe(200);expect(await(await f.call('page',page)).json()).toMatchObject({skipped:true});
  },30_000);

  it('prevalidates a complete metadata range before writes and replays a partially committed SQL prefix',async()=>{
    const f=await fixture(false,32);expect((await f.call('init',f.plan.plan)).status).toBe(200);await f.upload();const pages=await sourcePages(f);
    const db=await f.mf.getD1Database('RESTORE_DB');const bucket=await f.mf.getR2Bucket('RESTORE_TEXTS');
    const invalid=structuredClone(pages);invalid[3]!.sha256='f'.repeat(64);
    expect((await f.call('pages',{pages:invalid})).status).toBe(422);
    expect((await f.call('pages',{pages:[pages[1],pages[0]]})).status).toBe(422);
    const lastParams=pages[3]!.statements.at(-1)!.params;const key=String(lastParams[4]);const held=await bucket.get(key);const bytes=new Uint8Array(await held!.arrayBuffer());
    await bucket.delete(key);expect((await f.call('pages',{pages})).status).toBe(503);
    expect(await db.prepare('SELECT count(*) AS count FROM statute_sections').first()).toEqual({count:0});
    expect(await db.prepare('SELECT count(*) AS count FROM corpus_compact_pages').first()).toEqual({count:0});await bucket.put(key,bytes);
    const blocked=String(pages[1]!.statements[1]!.params[0]);
    await db.exec(`CREATE TRIGGER fail_second_page BEFORE INSERT ON statute_text_refs WHEN NEW.row_id='${blocked}' BEGIN SELECT RAISE(ABORT,'injected second-page failure'); END;`);
    const failed=await f.call('pages',{pages});expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('injected');
    expect(await db.prepare('SELECT count(*) AS rows FROM statute_sections').first()).toEqual({rows:16});
    expect(await db.prepare('SELECT count(*) AS pages FROM corpus_compact_pages').first()).toEqual({pages:1});
    await db.exec('DROP TRIGGER fail_second_page');const replay=await f.call('pages',{pages});expect(replay.status).toBe(200);const ack=await replay.json();
    expect(verifiedMetadataAcknowledgements(ack,pages,f.plan.planHash)).toBe(true);
    expect((ack as {pages:{skipped:boolean}[]}).pages.map((item)=>item.skipped)).toEqual([true,false,false,false]);
    expect((await f.call('pages',{pages})).status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS rows FROM statute_sections').first()).toEqual({rows:64});
  },30_000);

  it('replays a lost metadata reply without duplicating pages or rows',async()=>{
    const f=await fixture(false,32);let lost=false;let pageRequests=0;
    const uncertain:typeof fetch=async(input,init)=>{const response=await f.send(input,init);if(String(input).endsWith('/pages')){pageRequests++;if(!lost){lost=true;await response.body?.cancel();return new Response('uncertain reply',{status:503});}}return response;};
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint:join(f.directory,'pages.json'),uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:uncertain}))
      .toMatchObject({audit:{complete:true,rowsVerified:64,bytesVerified:f.manifest.textBytes}});
    expect(pageRequests).toBe(2);const db=await f.mf.getD1Database('RESTORE_DB');
    expect(await db.prepare('SELECT count(*) AS pages,sum(row_count) AS rows FROM corpus_compact_pages').first()).toEqual({pages:4,rows:64});
  },30_000);

  it('refuses a mismatched metadata acknowledgement before checkpoint advance and replays the server prefix',async()=>{
    const f=await fixture(false,32);const checkpoint=join(f.directory,'metadata-bad-ack.json');let changed=false;
    const badAck:typeof fetch=async(input,init)=>{const response=await f.send(input,init);if(!changed&&String(input).endsWith('/pages')){changed=true;const value=await response.json() as {pages:{through:string}[]};value.pages[0]!.through='wrong';return Response.json(value);}return response;};
    await expect(restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:badAck})).rejects.toThrow('exact complete metadata range');
    expect(JSON.parse(await readFile(checkpoint,'utf8'))).toMatchObject({uploadedObjects:64,appliedPages:0});
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:f.send}))
      .toMatchObject({audit:{complete:true,rowsVerified:64}});
  },30_000);

  it('restarts with a committed two-page remote prefix and replays the complete original four-page range',async()=>{
    const f=await fixture(false,32);expect((await f.call('init',f.plan.plan)).status).toBe(200);await f.upload();const pages=await sourcePages(f);
    for(const page of pages.slice(0,2))expect((await f.call('page',page)).status).toBe(200);
    const checkpoint=join(f.directory,'partial-page-restart.json');await writeFile(checkpoint,JSON.stringify({format:1,planHash:f.plan.planHash,targetHash:await hashJson(f.target),uploadedObjects:64,appliedPages:0}));
    const ranges:number[][]=[];const skipped:boolean[][]=[];const advances:number[]=[];
    const inspect:typeof fetch=async(input,init)=>{const response=await f.send(input,init);if(String(input).endsWith('/pages')){
      ranges.push((JSON.parse(String(init?.body)) as {pages:CompactRestorePage[]}).pages.map((page)=>page.page));
      const body=await response.json() as {pages:{skipped:boolean}[]};skipped.push(body.pages.map((page)=>page.skipped));return Response.json(body);}return response;};
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint,uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:inspect,
      onProgress(value){if(value&&typeof value==='object'&&'appliedPages' in value)advances.push(Number(value.appliedPages));}})).toMatchObject({audit:{complete:true,rowsVerified:64}});
    expect(ranges).toEqual([[1,2,3,4]]);expect(skipped).toEqual([[true,true,false,false]]);expect(advances).toEqual([4]);
    expect(JSON.parse(await readFile(checkpoint,'utf8'))).toMatchObject({appliedPages:4});
  },30_000);

  it('keeps concurrent page replay and stale audit CAS requests from double-applying source ranges',async()=>{
    const f=await fixture(false,32,0,16*1024);expect((await f.call('init',f.plan.plan)).status).toBe(200);await f.upload();const pages=await sourcePages(f);
    const replies=await Promise.all([f.call('pages',{pages}),f.call('pages',{pages})]);expect(replies.some((reply)=>reply.status===200)).toBe(true);
    expect(replies.every((reply)=>[200,409,503].includes(reply.status))).toBe(true);for(const reply of replies)await reply.body?.cancel();
    expect((await f.call('pages',{pages})).status).toBe(200);expect((await f.call('publish')).status).toBe(200);
    const audits=await Promise.all(Array.from({length:4},()=>f.call('audit',{pages:1})));expect(audits.some((reply)=>reply.status===409)).toBe(true);
    expect(audits.every((reply)=>[200,409].includes(reply.status))).toBe(true);const successes=audits.filter((reply)=>reply.status===200).length;for(const reply of audits)await reply.body?.cancel();
    const db=await f.mf.getD1Database('RESTORE_DB');const state=await db.prepare('SELECT audit_checkpoint FROM stage_restore_session').first<{audit_checkpoint:string}>();
    expect(JSON.parse(state!.audit_checkpoint).rowsVerified).toBe(successes*8);
    expect(await(await f.call('audit',{pages:16})).json()).toMatchObject({phase:'complete',audit:{complete:true,rowsVerified:64}});
    expect(await db.prepare('SELECT count(*) AS pages,sum(row_count) AS rows FROM corpus_compact_pages').first()).toEqual({pages:4,rows:64});
  },30_000);

  it('handles full four-page reference budgets and sixteen strict checkpoints with one metadata request in flight',async()=>{
    const f=await fixture(false,64,0,256*1024);let active=0;let maximum=0;let metadataCalls=0;const auditSizes:number[]=[];
    const inspect:typeof fetch=async(input,init)=>{const path=String(input);if(path.endsWith('/audit'))auditSizes.push(JSON.parse(String(init?.body)).pages);
      if(path.endsWith('/pages')){active++;maximum=Math.max(maximum,active);metadataCalls++;const body=JSON.parse(String(init?.body)) as {pages:CompactRestorePage[]};
        expect(body.pages).toHaveLength(4);expect(new TextEncoder().encode(String(init?.body)).byteLength).toBeLessThanOrEqual(128*1024);
        try{return await f.send(input,init);}finally{active--;}}return f.send(input,init);};
    expect(await restoreTextStaging({bundle:f.bundle,target:f.target,execute:true,token:f.token,checkpoint:join(f.directory,'resource.json'),uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:inspect}))
      .toMatchObject({audit:{complete:true,rowsVerified:128,bytesVerified:32*1024*1024}});
    expect(maximum).toBe(1);expect(metadataCalls).toBe(2);expect(auditSizes).toEqual([16]);
  },90_000);

  it('splits near-limit JSON ranges and falls back to the original page path for excessive reference bytes',async()=>{
    const headed=await fixture(false,32,2500);const pages=await sourcePages(headed);expect(metadataBatchBytes(pages)).toBeGreaterThan(METADATA_BATCH_CAPABILITIES.maxBytes);let frames=0;
    const inspect:typeof fetch=async(input,init)=>{if(String(input).endsWith('/pages')){frames++;expect(new TextEncoder().encode(String(init?.body)).byteLength).toBeLessThanOrEqual(128*1024);}return headed.send(input,init);};
    expect(await restoreTextStaging({bundle:headed.bundle,target:headed.target,execute:true,token:headed.token,checkpoint:join(headed.directory,'json-bound.json'),uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:inspect})).toMatchObject({audit:{complete:true,rowsVerified:64}});expect(frames).toBeGreaterThan(1);
    const large=await fixture(false,8,0,1024*1024+1);let singles=0;let batches=0;
    const inspectLarge:typeof fetch=async(input,init)=>{if(String(input).endsWith('/page'))singles++;if(String(input).endsWith('/pages'))batches++;return large.send(input,init);};
    expect(await restoreTextStaging({bundle:large.bundle,target:large.target,execute:true,token:large.token,checkpoint:join(large.directory,'reference-bound.json'),uploadBatchSize:16,metadataBatchPages:4,auditCheckpoints:16,fetch:inspectLarge})).toMatchObject({audit:{complete:true,rowsVerified:16}});
    expect(singles).toBe(1);expect(batches).toBe(0);
  },90_000);

  it('does not complete publication without a matching page chain or a complete valid text audit',async()=>{
    const f=await fixture();expect((await f.call('init',f.plan.plan)).status).toBe(200);await f.upload();
    expect((await f.call('publish')).status).toBe(409);
    for await(const page of jsonLines(join(f.bundle,'fresh-pages.jsonl')))expect((await f.call('page',page)).status).toBe(200);
    const db=await f.mf.getD1Database('RESTORE_DB');
    const firstPage=await first(join(f.bundle,'fresh-pages.jsonl'));
    await db.prepare('UPDATE corpus_compact_pages SET sha256=? WHERE page=1').bind('f'.repeat(64)).run();
    expect((await f.call('publish')).status).toBe(422);
    expect(await db.prepare('SELECT count(*) AS count FROM corpus_state').first()).toEqual({count:0});
    await db.prepare('UPDATE corpus_compact_pages SET sha256=? WHERE page=1').bind(String(firstPage['sha256'])).run();
    expect((await f.call('publish')).status).toBe(200);
    const ref=await first(join(f.bundle,'references.jsonl')) as unknown as CutoverTextReference;const bucket=await f.mf.getR2Bucket('RESTORE_TEXTS');
    await bucket.put(ref.objectKey,'corrupt');expect((await f.call('audit',{pages:4})).status).toBe(503);
    expect(await db.prepare('SELECT phase,audit_checkpoint FROM stage_restore_session').first()).toEqual({phase:'published',audit_checkpoint:null});
    await bucket.put(ref.objectKey,await readCutoverObject(f.bundle,ref,f.manifest));
    expect(await(await f.call('audit',{pages:4})).json()).toMatchObject({phase:'complete',audit:{rowsVerified:18,complete:true}});
  },30_000);
});
