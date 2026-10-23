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
import { rowFingerprintWithText } from '../src/corpora/text-store';
import { testD1 } from './helpers/d1';

const close:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const finish of close.splice(0).reverse())await finish();});
let script='';
beforeAll(async()=>{const output=await build({entryPoints:['services/restore/worker.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});script=output.outputFiles[0]!.text;});

async function first(path:string){for await(const value of jsonLines(path))return value;throw new Error('Empty fixture.');}
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'civicsignal-stage-restore-'));close.push(()=>rm(directory,{recursive:true,force:true}));
  const original=testD1();close.push(original.close);
  const rows:Record<string,unknown>[]=[];
  for(const language of ['en','fr'])for(let section=1;section<=9;section++){
    const row={id:`acts-${language}-${section}`,corpus_id:'statutes-canada',act:language==='en'?'Test Act':'Loi de test',citation:'T-1',section:String(section),
      status:'in-force',schedule:null,part:null,heading:null,text:language==='en'?`Original rule ${section}.`:`Règle originale ${section}.`,
      source_url:`https://laws-lois.justice.gc.ca/${language}/acts/T-1/section-${section}.html`,jurisdiction:'CA',in_force:1,topics:null,language,last_changed:'2026-10-15'};
    rows.push({...row,text_hash:rowFingerprintWithText(row,row.text)});
  }
  rows.sort((a,b)=>String(a['id'])<String(b['id'])?-1:1);
  for(const row of rows)original.sqlite.prepare(`INSERT INTO statute_sections(id,corpus_id,act,citation,section,status,text,source_url,language,text_hash) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(...['id','corpus_id','act','citation','section','status','text','source_url','language','text_hash'].map((name)=>row[name]) as (string|number|null)[]);
  const input=join(directory,'rows.jsonl');await writeFile(input,rows.map((row)=>JSON.stringify(row)).join('\n')+'\n');
  const receipt=join(directory,'receipt.json');const commit='a'.repeat(40);
  await writeFile(receipt,JSON.stringify({format:1,source:{commit,date:'2026-10-15',parser:'legacy',indexDigest:'b'.repeat(32),rows:18,embedded:18,placeholders:0,dimensions:768},
    files:Object.fromEntries(['manifest.json','vectors.manifest.json','index.jsonl','store.emb'].map((name)=>[`${commit}.${name}`,{bytes:1,sha256:'c'.repeat(64)}])),
    verification:{allRows:true,rows:18,allVectorPositions:true,finite:true,placeholderZeros:true}}));
  const bundle=join(directory,'bundle');
  const manifest=await prepareTextCutover({input,output:bundle,revision:`${commit}:legacy`,objectStorage:'pack',sourceReceipt:receipt,
    createdAt:'2026-10-22T00:00:00Z',publication:{commit,parser:null,date:'2026-10-15',asOf:'2026-10-15',lastRunAt:'2026-10-22T00:00:00Z',rows:18}});
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
