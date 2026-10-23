import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import type {DatabaseSync as Sqlite} from 'node:sqlite';
import {chmod,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareTextCutover,jsonLines,sha256File} from '../scripts/prepare-text-cutover';
import {prepareProtectedState} from '../scripts/lib/protected-state';
import {prepareProtectedD1Admission} from '../scripts/lib/protected-state-d1';
import {restoreTextStaging} from '../scripts/restore-text-staging';
import {COMPACT_CORPUS_SCHEMA,COMPACT_STATUTE_COLUMNS,INSERT_COMPACT_STATUTE_SQL,applyCompactRestorePage,type CompactRestorePage} from '../src/corpora/compact-restore';
import {rowFingerprintWithText} from '../src/corpora/text-store';
import {RESTORE_SUPPORT_SCHEMA,type StagingRestoreTarget} from '../services/restore/protocol';
import {PROTECTED_TABLE_COLUMNS,PROTECTED_TABLE_ORDER,protectedPageDigest,protectedRowCanonical,type ProtectedManifest,type ProtectedPage} from '../src/corpora/protected-state-format';
import {PROTECTED_D1_AUTH_SCHEMA} from '../src/corpora/protected-state-d1-schema';
import {compareProtectedD1Keys,type ProtectedD1Admission,type ProtectedD1Identity} from '../src/corpora/protected-state-d1-admission';
import {localD1} from '../scripts/lib/local-d1';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof Sqlite};
const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const commit='a'.repeat(40),date='2026-10-15',baselineTime='2026-10-15T00:00:00Z',sourceTime='2026-10-22T16:37:09Z';
let script='';
beforeAll(async()=>{
 const result=await build({stdin:{loader:'ts',resolveDir:resolve('.'),contents:`
 import {handleRestoreRequest,type RestoreEnv} from './services/restore/worker';
 import {readJsonBody} from './src/http';
 import * as protectedD1 from './src/corpora/protected-state-d1';
 import {ProtectedStateError} from './src/corpora/protected-state-format';
 type Env=RestoreEnv&{RESTORE_DB:D1Database;RESTORE_TEXTS:R2Bucket};
 export default {async fetch(request:Request,env:Env){
  if(new URL(request.url).pathname.startsWith('/v1/restore/'))return handleRestoreRequest(request,env);
  let reads=0;try{const b=await readJsonBody(request,128*1024) as any;let fault=b.fault;
   const db=new Proxy(env.RESTORE_DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    const once=fault;fault=null;
    if(once==='publication')await target.prepare("UPDATE corpus_state SET last_run_at='changed'").run();
    if(once==='sequence')await target.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('corpus_runs',0)").run();
    if(once==='session')await target.prepare('UPDATE protected_state_d1_session SET version=version+1').run();
    if(once==='null-marker')await target.prepare('DELETE FROM protected_state_restore').run();
    return target.batch(statements);
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});let value;
   switch(new URL(request.url).pathname){
    case '/begin':value=await protectedD1.beginProtectedD1(db,b);break;
    case '/corpus':value=await protectedD1.checkProtectedD1CorpusPage(db,b.page,b.identity);break;
    case '/text':value=await protectedD1.checkProtectedD1Text(db,{get:async(key:string)=>{reads++;return env.RESTORE_TEXTS.get(key);}},b.identity);break;
    case '/apply':value=await protectedD1.applyProtectedD1Page(db,b.page,b.identity);break;
    case '/verify':value=await protectedD1.verifyProtectedD1Page(db,b.page,b.identity);break;
    case '/finish':value=await protectedD1.finishProtectedD1(db,b.identity);break;
    default:return new Response('No local fixture operation',{status:404});
   }return Response.json({value,reads});
  }catch(e){return Response.json({code:e instanceof ProtectedStateError?e.code:'FIXTURE_FAILURE',reads},{status:409});}
 }};`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});script=result.outputFiles[0]!.text;
});
async function fixture(historyMode:'highwater'|'zero'|'absent'='highwater'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'protected-d1-')));await chmod(root,0o700);cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source.sqlite'),targetFile=join(root,'target.sqlite'),auth=join(root,'auth.json'),bundle=join(root,'cutover'),output=join(root,'protected');
 const sourceDb=new DatabaseSync(source);for(const name of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())sourceDb.exec(await readFile(join('migrations',name),'utf8'));
 const rows=Array.from({length:18},(_,n)=>{const row={id:`acts-en-${String(n+1).padStart(3,'0')}`,corpus_id:'statutes-canada',act:'Synthetic Act',section:String(n+1),heading:null,text:`Original rule ${n+1}.`,source_url:`https://example.invalid/${n+1}`,jurisdiction:'CA',in_force:1,topics:null,citation:'T-1',language:'en',schedule:null,part:null,status:'in-force',last_changed:date};return {...row,text_hash:rowFingerprintWithText(row,row.text)};});
 for(const row of rows)sourceDb.prepare(INSERT_COMPACT_STATUTE_SQL).run(...COMPACT_STATUTE_COLUMNS.map(k=>row[k]));
 sourceDb.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',commit,date,date,18,sourceTime,null);
 sourceDb.exec(`INSERT INTO workspace VALUES('workspace','Synthetic','synthetic',1,2);
 INSERT INTO civic_workspace_billing VALUES('workspace','free',1200,0,NULL,0);
 INSERT INTO workspace_api_key VALUES('key','workspace','Synthetic','${'b'.repeat(64)}','prefix','["civicsignal.retrieve"]','revoked',NULL,NULL,1,2);`);
 sourceDb.prepare('INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at) VALUES(?,?,?,?,?)').run(2,'statutes-canada',commit,date,date);
 sourceDb.prepare('INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at) VALUES(?,?,?,?,?)').run(120,'statutes-canada',commit,date,date);sourceDb.exec('DELETE FROM corpus_runs WHERE id=120');
 const change=sourceDb.prepare('INSERT INTO corpus_changes(id,corpus_id,change,row_id,instrument,citation,section,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let n=1;n<=19;n++)change.run(n*10,'statutes-canada','removed',`removed-${n}`,'Synthetic Act','T-1','1',date,date);change.run(1000,'statutes-canada','removed','deleted','Synthetic Act','T-1','1',date,date);sourceDb.exec('DELETE FROM corpus_changes WHERE id=1000');
 sourceDb.prepare('INSERT INTO corpus_mutations VALUES(?,?,NULL,?)').run('completed','statutes-canada',date);
 if(historyMode!=='highwater'){sourceDb.exec('DELETE FROM corpus_runs; DELETE FROM corpus_changes');sourceDb.exec(historyMode==='zero'?"UPDATE sqlite_sequence SET seq=0 WHERE name IN ('corpus_runs','corpus_changes')":"DELETE FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes')");}
 sourceDb.close();await chmod(source,0o600);
 const input=join(root,'rows.jsonl');await writeFile(input,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const receipt=join(root,'receipt.json');await writeFile(receipt,JSON.stringify({format:1,source:{commit,date,parser:'legacy',indexDigest:'b'.repeat(32),rows:18,embedded:18,placeholders:0,dimensions:768},files:Object.fromEntries(['manifest.json','vectors.manifest.json','index.jsonl','store.emb'].map(name=>[commit+'.'+name,{bytes:1,sha256:'c'.repeat(64)}])),verification:{allRows:true,rows:18,allVectorPositions:true,finite:true,placeholderZeros:true}}));
 const cutover=await prepareTextCutover({input,output:bundle,revision:commit+':legacy',objectStorage:'pack',sourceReceipt:receipt,createdAt:baselineTime,publication:{commit,parser:null,date,asOf:date,lastRunAt:baselineTime,rows:18}});
 const compactPages:CompactRestorePage[]=[];for await(const p of jsonLines(join(bundle,'fresh-pages.jsonl')))compactPages.push(p as unknown as CompactRestorePage);
 const local=new DatabaseSync(targetFile);local.exec(COMPACT_CORPUS_SCHEMA);for(const p of compactPages)await applyCompactRestorePage(localD1(local),p,{bundleSha256:cutover.freshPagesSha256,revision:cutover.revision});local.exec(RESTORE_SUPPORT_SCHEMA);local.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',commit,date,date,18,baselineTime,null);local.close();await chmod(targetFile,0o600);
 await writeFile(auth,JSON.stringify({customers:[],keys:[]}),{mode:0o600});
 const prepared=await prepareProtectedState({source:{kind:'sqlite',path:source,sha256:await sha256File(source)},legacyAuth:{path:auth,sha256:await sha256File(auth)},targetSqlite:{path:targetFile,sha256:await sha256File(targetFile)},cutoverBundle:{path:bundle,manifestSha256:await sha256File(join(bundle,'manifest.json'))},outputDirectory:output});
 const target:StagingRestoreTarget={format:1,stageOnly:true,stageId:'stage-fixture',accountId:'a'.repeat(32),d1Id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',r2Bucket:'fixture-stage-texts',adminUrl:'http://localhost'};
 const sidecar=join(root,'admission.json'),sealedPagesSha=await sha256File(join(output,'pages.jsonl')),sealedManifestSha=await sha256File(join(output,'manifest.json'));
 const admitted=await prepareProtectedD1Admission({directory:output,manifestSha256:prepared.manifestSha256,cutoverBundle:bundle,target,outputPath:sidecar});
 const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8')) as ProtectedManifest,admission=JSON.parse(await readFile(sidecar,'utf8')) as ProtectedD1Admission,identity:ProtectedD1Identity={admissionSha256:admitted.admissionSha256,manifestSha256:prepared.manifestSha256,target};
 const pages:ProtectedPage[]=[];for await(const p of jsonLines(join(output,'pages.jsonl')))pages.push(p as unknown as ProtectedPage);
 const token='synthetic-restore-token-'.repeat(3),mf=new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:join(root,'registry'),resourcePersistencePath:join(root,'persistence'),workers:[{config:{name:'protected-d1-local',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],env:{RESTORE_DB:{type:'d1',id:target.d1Id,dev:{remote:false}},RESTORE_TEXTS:{type:'r2',name:target.r2Bucket,dev:{remote:false}},...Object.fromEntries(Object.entries({RESTORE_ENABLED:'staging-only',RESTORE_STAGE_ID:target.stageId,RESTORE_ACCOUNT_ID:target.accountId,RESTORE_D1_ID:target.d1Id,RESTORE_R2_NAME:target.r2Bucket,RESTORE_TOKEN:token}).map(([key,value])=>[key,{type:'text' as const,value}]))},manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:script}}}},dev:{outboundService:{type:'fetcher',handler:async()=>{throw Error('External networking forbidden.');}}}}]});cleanup.push(()=>mf.dispose());
 const send:typeof fetch=async(url,init)=>{const r=new Request(url,init),body=['GET','HEAD'].includes(r.method)?undefined:new Uint8Array(await r.arrayBuffer());const response=await mf.dispatchFetch(r.url,{method:r.method,headers:[...r.headers],...(body?{body}:{})});return new Response(await response.arrayBuffer(),{status:response.status,headers:[...response.headers]});};
 await restoreTextStaging({bundle,target,execute:true,token,checkpoint:join(root,'restore.json'),fetch:send});
 const db=await mf.getD1Database('RESTORE_DB');
 async function call(operation:string,extra:Record<string,unknown>={}){const r=await send('http://localhost/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identity,...extra})});const body=await r.json() as {code?:string;value?:{phase:string;complete:boolean;loadedPages:number;verifiedPages:number;compactPages:number;skipped?:boolean};reads?:number};return {status:r.status,...body};}
 const begin=()=>call('begin',{manifest,admission});
 async function corpus(){for(const page of compactPages){const r=await call('corpus',{page});expect(r.status,r.code).toBe(200);}}
 async function text(){let reads=0;for(let n=0;n<3;n++){const r=await call('text');expect(r.status,r.code).toBe(200);reads+=r.reads??0;}expect(reads).toBe(18);}
 async function ready(){expect((await begin()).status).toBe(200);await corpus();await text();}
 async function apply(){for(const page of pages){const r=await call('apply',{page});expect(r.status,r.code).toBe(200);}}
 async function verify(){for(const page of pages){const r=await call('verify',{page});expect(r.status,r.code).toBe(200);}}
 return {root,source,targetFile,bundle,output,manifest,admission,identity,pages,compactPages,mf,db,call,begin,corpus,text,ready,apply,verify,sealedPagesSha,sealedManifestSha};
}

describe('protected D1 fixed assets',()=>{
 it('keeps the only optional auth DDL byte-identical to the checked-in migration',async()=>expect(PROTECTED_D1_AUTH_SCHEMA).toBe(await readFile('migrations/0005_workspace_auth.sql','utf8')));
 it('orders string primary keys using SQLite UTF8 BINARY order',()=>{expect(compareProtectedD1Keys('\u{10000}','\ue000')).toBeGreaterThan(0);expect(compareProtectedD1Keys(1001,120)).toBeGreaterThan(0);});
});
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('protected pages in actual local D1/R2',()=>{
 it('admits actual metadata/refs, freshly reads R2, copies all tables and preserves original highwaters',async()=>{
  const f=await fixture();await f.ready();await f.apply();await f.verify();await f.corpus();const finished=await f.call('finish');expect(finished.status,finished.code).toBe(200);expect(finished.value?.complete).toBe(true);
  const source=new DatabaseSync(f.source,{readOnly:true});try{for(const table of PROTECTED_TABLE_ORDER){const projection=PROTECTED_TABLE_COLUMNS[table].join(','),where=table==='sqlite_sequence'?" WHERE name IN ('corpus_runs','corpus_changes')":'';
   const actual=(await f.db.prepare(`SELECT ${projection} FROM ${table}${where} ORDER BY ${PROTECTED_TABLE_COLUMNS[table][0]}`).all()).results;expect(actual).toEqual(source.prepare(`SELECT ${projection} FROM ${table}${where} ORDER BY ${PROTECTED_TABLE_COLUMNS[table][0]}`).all());}}
  finally{source.close();}
  expect(await sha256File(join(f.output,'pages.jsonl'))).toBe(f.sealedPagesSha);expect(await sha256File(join(f.output,'manifest.json'))).toBe(f.sealedManifestSha);
  const completed=await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first();
  expect(await f.begin()).toMatchObject({status:200,value:{complete:true}});expect(await f.call('finish')).toMatchObject({status:200,value:{complete:true}});
  expect(await f.call('verify',{page:f.pages[0]})).toMatchObject({status:200,value:{skipped:true,complete:true}});
  expect(await f.call('apply',{page:f.pages[0]})).toMatchObject({status:200,value:{skipped:true,complete:true}});
  expect(await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first()).toEqual(completed);
  await f.db.prepare("INSERT INTO corpus_runs(corpus_id,commit_sha,commit_date,ran_at) VALUES('statutes-canada',?,'2026-10-15','time')").bind(commit).run();
  await f.db.prepare("INSERT INTO corpus_changes(corpus_id,change,row_id,instrument,citation,section,occurred_at,recorded_at) VALUES('statutes-canada','changed','next','Act','T-1','1','time','time')").run();
  expect(await f.db.prepare('SELECT (SELECT max(id) FROM corpus_runs) AS runs,(SELECT max(id) FROM corpus_changes) AS changes').first()).toEqual({runs:121,changes:1001});
 },30_000);
 it('refuses protected writes before actual full corpus and fresh text admission',async()=>{const f=await fixture();expect((await f.begin()).status).toBe(200);expect(await f.call('apply',{page:f.pages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_PHASE'});expect(await f.db.prepare('SELECT count(*) AS n FROM workspace').first()).toEqual({n:0});await f.corpus();expect((await f.call('apply',{page:f.pages[0]})).status).toBe(409);},30_000);
 it.each(['zero','absent'] as const)('preserves explicit %s sequence facts for empty histories',async(mode)=>{
  const f=await fixture(mode);await f.ready();await f.apply();await f.verify();await f.corpus();expect(await f.call('finish')).toMatchObject({status:200,value:{complete:true}});
  expect((await f.db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name").all()).results).toEqual(mode==='zero'?[{name:'corpus_changes',seq:0},{name:'corpus_runs',seq:0}]:[]);
 },30_000);
 it('refuses a wrong reference before the first protected row',async()=>{const f=await fixture();expect((await f.begin()).status).toBe(200);await f.db.prepare("UPDATE statute_text_refs SET bytes=bytes+1 WHERE row_id='acts-en-001'").run();expect(await f.call('corpus',{page:f.compactPages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_TEXT_REFERENCE'});expect(await f.db.prepare('SELECT count(*) AS n FROM workspace').first()).toEqual({n:0});},30_000);
 it('rolls back earlier inserts, generated sequence, receipt and cursor on a late SQL constraint failure',async()=>{
  const f=await fixture();await f.ready();const at=f.pages.findIndex(p=>p.table==='corpus_changes');
  for(const page of f.pages.slice(0,at))expect((await f.call('apply',{page})).status).toBe(200);
  const before=await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first();
  const bad=structuredClone(f.pages[at]!);bad.rows[8]![2]='invalid-change';bad.sha256=await protectedPageDigest(bad);
  expect(await f.call('apply',{page:bad})).toMatchObject({status:409,code:'PROTECTED_D1_FAILURE'});
  expect(await f.db.prepare('SELECT count(*) AS n FROM corpus_changes').first()).toEqual({n:0});
  expect(await f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='corpus_changes'").first()).toBeNull();
  expect(await f.db.prepare('SELECT count(*) AS n FROM protected_state_pages').first()).toEqual({n:at});
  expect(await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first()).toEqual(before);
  expect(await f.call('apply',{page:f.pages[at]})).toMatchObject({status:200,value:{loadedPages:at+1}});
 },30_000);
 it('replays a committed page exactly and refuses altered replay rows',async()=>{const f=await fixture();await f.ready();const page=f.pages[0];expect((await f.call('apply',{page})).status).toBe(200);expect(await f.call('apply',{page})).toMatchObject({status:200,value:{skipped:true,loadedPages:1}});await f.db.prepare("UPDATE workspace SET name='changed'").run();expect(await f.call('apply',{page})).toMatchObject({status:409,code:'PROTECTED_D1_REPLAY_ROW'});},30_000);
 it('refuses final reference drift after exact protected verification',async()=>{const f=await fixture();await f.ready();await f.apply();await f.verify();await f.db.prepare("UPDATE statute_text_refs SET bytes=bytes+1 WHERE row_id='acts-en-001'").run();expect(await f.call('corpus',{page:f.compactPages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_TEXT_REFERENCE'});expect((await f.call('finish')).status).toBe(409);},30_000);
 it.each(['missing','corrupt'] as const)('freshly refuses %s R2 bytes despite the old completed restore audit',async(kind)=>{
  const f=await fixture();expect((await f.begin()).status).toBe(200);await f.corpus();
  const bucket=await f.mf.getR2Bucket('RESTORE_TEXTS'),key=String(f.compactPages[0]!.statements[1]!.params[4]);
  if(kind==='missing')await bucket.delete(key);else await bucket.put(key,'corrupt bytes');
  expect(await f.call('text')).toMatchObject({status:409,code:'PROTECTED_D1_FAILURE',reads:8});
  expect(await f.db.prepare('SELECT count(*) AS n FROM workspace').first()).toEqual({n:0});
  expect((await f.call('apply',{page:f.pages[0]})).status).toBe(409);
 },30_000);
 it.each([
  ['unknown trigger',"CREATE TRIGGER unknown_trigger AFTER INSERT ON corpus_mutations BEGIN SELECT 1; END",'PROTECTED_D1_SCHEMA_OBJECT'],
  ['generated column','ALTER TABLE statute_sections ADD COLUMN generated TEXT GENERATED ALWAYS AS (id) VIRTUAL','PROTECTED_D1_SCHEMA_OBJECT'],
  ['partial auth',"CREATE TABLE workspace (id TEXT PRIMARY KEY NOT NULL,name TEXT,slug TEXT,created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))",'PROTECTED_D1_PARTIAL_AUTH'],
  ['unknown view','CREATE VIEW unexpected_view AS SELECT id FROM statute_sections','PROTECTED_D1_SCHEMA_OBJECT'],
 ] as const)('rejects %s schema before session admission',async(_label,sql,code)=>{
  const f=await fixture();await f.db.exec(sql);expect(await f.begin()).toMatchObject({status:409,code});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_restore'").first()).toBeNull();
 },30_000);
 it('rejects exact but populated auth and an altered partial-index predicate',async()=>{
  const f=await fixture();await f.db.batch(PROTECTED_D1_AUTH_SCHEMA.split(';').map(s=>s.trim()).filter(Boolean).map(sql=>f.db.prepare(sql)));
  await f.db.prepare("INSERT INTO workspace VALUES('existing',NULL,NULL,1,2)").run();
  expect(await f.begin()).toMatchObject({status:409,code:'PROTECTED_D1_POPULATED'});
  await f.db.prepare('DELETE FROM workspace').run();await f.db.exec('DROP INDEX workspace_api_key_workspace_idx');
  await f.db.exec("CREATE INDEX workspace_api_key_workspace_idx ON workspace_api_key(workspace_id) WHERE status='revoked'");
  expect(await f.begin()).toMatchObject({status:409,code:'PROTECTED_D1_SCHEMA_OBJECT'});
 },30_000);
 it('refuses a bounded schema inventory overflow',async()=>{
  const f=await fixture();for(let n=0;n<64;n++)await f.db.exec(`CREATE TABLE excess_${n}(id TEXT)`);
  expect(await f.begin()).toMatchObject({status:409,code:'PROTECTED_D1_SCHEMA_BOUND'});
 },30_000);
 it('requires the matching complete restore receipt and exact actual compact marker',async()=>{
  const f=await fixture();await f.db.prepare("UPDATE stage_restore_session SET phase='published'").run();
  expect((await f.begin()).status).toBe(409);
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_restore'").first()).toBeNull();
  await f.db.prepare("UPDATE stage_restore_session SET phase='complete'").run();expect((await f.begin()).status).toBe(200);
  await f.db.prepare('UPDATE corpus_compact_restore SET bundle_sha256=?').bind('f'.repeat(64)).run();
  expect(await f.call('corpus',{page:f.compactPages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_COMPACT_MARKER'});
 },30_000);
 it.each(['publication','sequence','session','null-marker'])('atomically fences a late %s change after preflight',async(fault)=>{
  const f=await fixture();await f.ready();expect(await f.call('apply',{page:f.pages[0],fault})).toMatchObject({status:409,code:'PROTECTED_D1_FAILURE'});
  expect(await f.db.prepare('SELECT (SELECT count(*) FROM workspace) AS rows,(SELECT count(*) FROM protected_state_pages) AS pages').first()).toEqual({rows:0,pages:0});
  expect(JSON.parse((await f.db.prepare('SELECT state_json FROM protected_state_d1_session').first<{state_json:string}>())!.state_json).load.page).toBe(0);
 },30_000);
 it('allows only one committed result when the same page races',async()=>{
  const f=await fixture();await f.ready();const outcomes=await Promise.all([f.call('apply',{page:f.pages[0]}),f.call('apply',{page:f.pages[0]})]);
  expect(outcomes.some(r=>r.status===200)).toBe(true);expect(outcomes.every(r=>r.status===200||r.status===409)).toBe(true);
  expect(await f.db.prepare('SELECT (SELECT count(*) FROM workspace) AS rows,(SELECT count(*) FROM protected_state_pages) AS pages').first()).toEqual({rows:1,pages:1});
  expect(await f.call('apply',{page:f.pages[0]})).toMatchObject({status:200,value:{skipped:true,loadedPages:1}});
 },30_000);
 it('rejects foreign and gapped receipts, extra rows and stale identities',async()=>{
  const f=await fixture();await f.ready();await f.call('apply',{page:f.pages[0]});
  await f.db.prepare("UPDATE protected_state_pages SET sha256=? WHERE page=1").bind('f'.repeat(64)).run();
  expect(await f.call('apply',{page:f.pages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_PAGE_RECEIPT'});
  await f.db.prepare('UPDATE protected_state_pages SET sha256=?,page=2 WHERE page=1').bind(f.pages[0]!.sha256).run();
  expect(await f.call('apply',{page:f.pages[0]})).toMatchObject({status:409,code:'PROTECTED_D1_PAGE_RECEIPT'});
  await f.db.prepare("INSERT INTO workspace VALUES('extra',NULL,NULL,1,2)").run();
  expect(await f.call('apply',{page:f.pages[1]})).toMatchObject({status:409,code:'PROTECTED_D1_PREIMAGE'});
  expect(await f.call('apply',{page:f.pages[1],identity:{...f.identity,admissionSha256:'f'.repeat(64)}})).toMatchObject({status:409,code:'PROTECTED_D1_IDENTITY'});
 },30_000);
 it('does not mistake a valid page hash for sealed membership before the full chain',async()=>{
  const f=await fixture();await f.ready();const bad=structuredClone(f.pages[0]!);bad.rows[0]![1]='unsealed name';bad.sha256=await protectedPageDigest(bad);
  expect((await f.call('apply',{page:bad})).status).toBe(200);
  for(const page of f.pages.slice(1,-1))expect((await f.call('apply',{page})).status).toBe(200);
  expect(await f.call('apply',{page:f.pages.at(-1)})).toMatchObject({status:409,code:'PROTECTED_D1_LOAD_COMPLETE'});
  expect((await f.call('finish')).status).toBe(409);
  expect(await f.db.prepare('SELECT complete FROM protected_state_restore').first()).toEqual({complete:0});
 },30_000);
 it('rejects oversized compact and protected page input before advancing',async()=>{
  const f=await fixture();await f.begin();const compact=structuredClone(f.compactPages[0]!);compact.statements[0]!.params[2]='x'.repeat(65536);
  expect(await f.call('corpus',{page:compact})).toMatchObject({status:409,code:'PROTECTED_D1_COMPACT_BOUNDS'});
  await f.corpus();await f.text();const page=structuredClone(f.pages[0]!);page.rows[0]![1]='x'.repeat(65536);
  expect(await f.call('apply',{page})).toMatchObject({status:409,code:'PROTECTED_D1_PAGE_BOUNDS'});
 },30_000);
 it.each(['unordered','absent-sequence'] as const)('refuses %s facts while preparing a new sidecar from fully validated sealed files',async(kind)=>{
  const f=await fixture(),pages=structuredClone(f.pages),manifest=structuredClone(f.manifest);
  if(kind==='unordered')pages.find(p=>p.table==='corpus_changes')!.rows.reverse();else {pages.splice(pages.findIndex(p=>p.table==='sqlite_sequence'),1);manifest.pages=pages.length;}
  for(const [n,page] of pages.entries()){page.page=n+1;page.sha256=await protectedPageDigest(page);}
  for(const table of PROTECTED_TABLE_ORDER){const rows=pages.filter(p=>p.table===table).flatMap(p=>p.rows);manifest.tables[table]={rows:rows.length,sha256:createHash('sha256').update(rows.map(protectedRowCanonical).join('')).digest('hex')};}
  await writeFile(join(f.output,'pages.jsonl'),pages.map(p=>JSON.stringify(p)).join('\n')+'\n');manifest.pagesSha256=await sha256File(join(f.output,'pages.jsonl'));
  await writeFile(join(f.output,'manifest.json'),JSON.stringify(manifest)+'\n');
  await expect(prepareProtectedD1Admission({directory:f.output,manifestSha256:await sha256File(join(f.output,'manifest.json')),cutoverBundle:f.bundle,target:f.identity.target,outputPath:join(f.root,'new-admission.json')})).rejects.toMatchObject({code:kind==='unordered'?'PROTECTED_D1_KEY_ORDER':'PROTECTED_SEQUENCE_FACTS'});
 },30_000);
});
