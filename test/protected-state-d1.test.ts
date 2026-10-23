import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import type {DatabaseSync as Sqlite} from 'node:sqlite';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
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
import {readProtectedRestoreBody,PROTECTED_BODY_TIMEOUT_MS} from '../services/restore/protected';
import {inspectProtectedD1Client,runProtectedD1InitialWindow} from '../scripts/lib/protected-state-d1-client';
import {protectedD1ClientMain} from '../scripts/protected-state-d1';
const clientFsyncFault=vi.hoisted(()=>({afterSync:undefined as ((path:string)=>void)|undefined,beforeRead:undefined as ((path:string)=>void)|undefined}));
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>(),paths=new Map<number,string>();
 return {...actual,openSync:(...args:Parameters<typeof actual.openSync>)=>{const fd=actual.openSync(...args);paths.set(fd,String(args[0]));return fd;},
  closeSync:(fd:number)=>{paths.delete(fd);actual.closeSync(fd);},fsyncSync:(fd:number)=>{actual.fsyncSync(fd);clientFsyncFault.afterSync?.(paths.get(fd)??'');}};
});
vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,readFile:(...args:Parameters<typeof actual.readFile>)=>{clientFsyncFault.beforeRead?.(String(args[0]));return actual.readFile(...args);}};
});
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
 type Env=RestoreEnv&{RESTORE_DB:D1Database;RESTORE_TEXTS:R2Bucket;PROTECTED_FIXTURE_ENV:string};
 export default {async fetch(request:Request,env:Env){
  if(new URL(request.url).pathname.startsWith('/v1/restore/')){
   let reads=0;const bucket=new Proxy(env.RESTORE_TEXTS,{get(target,key){if(key==='get')return (...args:Parameters<R2Bucket['get']>)=>{reads++;return target.get(...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
   const overrides=new URL(request.url).pathname.startsWith('/v1/restore/protected/')?JSON.parse(env.PROTECTED_FIXTURE_ENV):{};
   const response=await handleRestoreRequest(request,{...env,...overrides,RESTORE_TEXTS:bucket});response.headers.set('x-fixture-r2-reads',String(reads));return response;
  }
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
    case '/status':value=await protectedD1.getProtectedD1Status(db,b.identity);break;
    case '/begin':value=await protectedD1.beginProtectedD1(db,b);break;
    case '/corpus':value=await protectedD1.checkProtectedD1CorpusPage(db,b.page,b.identity);break;
    case '/text':{const status=await protectedD1.getProtectedD1Status(db,b.identity);value=await protectedD1.checkProtectedD1Text(db,{get:async(key:string)=>{reads++;return env.RESTORE_TEXTS.get(key);}},b.identity,b.expectedSessionVersion??(status.initialized?status.version:-1));break;}
    case '/apply':value=await protectedD1.applyProtectedD1Page(db,b.page,b.identity);break;
    case '/verify':value=await protectedD1.verifyProtectedD1Page(db,b.page,b.identity);break;
    case '/finish':value=await protectedD1.finishProtectedD1(db,b.identity);break;
    default:return new Response('No local fixture operation',{status:404});
   }return Response.json({value,reads});
  }catch(e){return Response.json({code:e instanceof ProtectedStateError?e.code:'FIXTURE_FAILURE',reads},{status:409});}
 }};`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});script=result.outputFiles[0]!.text;
});
async function fixture(historyMode:'highwater'|'zero'|'absent'='highwater',envOverrides:Record<string,string|undefined>={}){
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
 const token='synthetic-restore-token-'.repeat(3),mf=new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:join(root,'registry'),resourcePersistencePath:join(root,'persistence'),workers:[{config:{name:'protected-d1-local',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],env:{RESTORE_DB:{type:'d1',id:target.d1Id,dev:{remote:false}},RESTORE_TEXTS:{type:'r2',name:target.r2Bucket,dev:{remote:false}},...Object.fromEntries(Object.entries({RESTORE_ENABLED:'staging-only',RESTORE_STAGE_ID:target.stageId,RESTORE_ACCOUNT_ID:target.accountId,RESTORE_D1_ID:target.d1Id,RESTORE_R2_NAME:target.r2Bucket,RESTORE_TOKEN:token,RESTORE_PROTECTED_ENABLED:'staging-only',RESTORE_PROTECTED_MANIFEST_SHA256:identity.manifestSha256,RESTORE_PROTECTED_ADMISSION_SHA256:identity.admissionSha256,PROTECTED_FIXTURE_ENV:JSON.stringify(envOverrides)}).map(([key,value])=>[key,{type:'text' as const,value}]))},manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:script}}}},dev:{outboundService:{type:'fetcher',handler:async()=>{throw Error('External networking forbidden.');}}}}]});cleanup.push(()=>mf.dispose());
 const send:typeof fetch=async(url,init)=>{const r=new Request(url,init),body=['GET','HEAD'].includes(r.method)?undefined:new Uint8Array(await r.arrayBuffer());const response=await mf.dispatchFetch(r.url,{method:r.method,headers:[...r.headers],...(body?{body}:{})});return new Response(await response.arrayBuffer(),{status:response.status,headers:[...response.headers]});};
 await restoreTextStaging({bundle,target,execute:true,token,checkpoint:join(root,'restore.json'),fetch:send});
 const db=await mf.getD1Database('RESTORE_DB');
 async function call(operation:string,extra:Record<string,unknown>={}){const r=await send('http://localhost/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identity,...extra})});const body=await r.json() as {code?:string;value?:{phase:string;complete:boolean;loadedPages:number;verifiedPages:number;compactPages:number;skipped?:boolean};reads?:number};return {status:r.status,...body};}
 const begin=()=>call('begin',{manifest,admission});
 const protectedHeaders={'authorization':'Bearer '+token,'content-type':'application/json','x-restore-stage':target.stageId,'x-restore-account':target.accountId,'x-restore-d1':envOverrides.RESTORE_D1_ID??target.d1Id,'x-restore-r2':envOverrides.RESTORE_R2_NAME??target.r2Bucket,'x-restore-plan':admission.compactPlanSha256,'x-protected-manifest':identity.manifestSha256,'x-protected-admission':identity.admissionSha256};
 async function protectedCall(operation:string,body:unknown={},headers:Record<string,string>={},method=operation==='status'?'GET':'POST'):Promise<Record<string,unknown>&{status:number;reads:number;phase?:string;version?:number}>{
  const response=await send('http://localhost/v1/restore/protected/'+operation,{method,headers:{...protectedHeaders,...headers},...(method==='GET'?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
  const value=await response.json() as Record<string,unknown>;return {status:response.status,reads:Number(response.headers.get('x-fixture-r2-reads')),...value};
 }
 async function corpus(){for(const page of compactPages){const r=await call('corpus',{page});expect(r.status,r.code).toBe(200);}}
 async function text(){let reads=0;for(let n=0;n<3;n++){const r=await call('text');expect(r.status,r.code).toBe(200);reads+=r.reads??0;}expect(reads).toBe(18);}
 async function ready(){expect((await begin()).status).toBe(200);await corpus();await text();}
 async function apply(){for(const page of pages){const r=await call('apply',{page});expect(r.status,r.code).toBe(200);}}
 async function verify(){for(const page of pages){const r=await call('verify',{page});expect(r.status,r.code).toBe(200);}}
 const client={directory:output,manifestSha256:prepared.manifestSha256,admissionPath:sidecar,admissionSha256:admitted.admissionSha256,admissionFileSha256:admitted.fileSha256,cutoverBundle:bundle,target,journalDirectory:join(root,'client-journal'),credential:()=>token,fetch:send};
 return {root,source,targetFile,bundle,output,manifest,admission,identity,pages,compactPages,mf,db,call,begin,corpus,text,ready,apply,verify,sealedPagesSha,sealedManifestSha,protectedCall,protectedHeaders,send,client};
}

describe('protected D1 fixed assets',()=>{
 it('keeps the only optional auth DDL byte-identical to the checked-in migration',async()=>expect(PROTECTED_D1_AUTH_SCHEMA).toBe(await readFile('migrations/0005_workspace_auth.sql','utf8')));
 it('orders string primary keys using SQLite UTF8 BINARY order',()=>{expect(compareProtectedD1Keys('\u{10000}','\ue000')).toBeGreaterThan(0);expect(compareProtectedD1Keys(1001,120)).toBeGreaterThan(0);});
});
describe('protected HTTP bounded input',()=>{
 it('rejects an oversized declared length before reading the stream',async()=>{
  const request=new Request('http://localhost',{method:'POST',headers:{'content-type':'application/json','content-length':'999999'},body:'{}'});
  await expect(readProtectedRestoreBody(request,1024)).rejects.toMatchObject({code:'PROTECTED_HTTP_BODY_BOUND',status:413});
 });
 it('cancels a stalled stream at the total body deadline',async()=>{
  vi.useFakeTimers();let cancelled=false;
  try{const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),init:RequestInit&{duplex:'half'}={method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'};
   const pending=readProtectedRestoreBody(new Request('http://localhost',init),1024);
   const rejected=expect(pending).rejects.toMatchObject({code:'PROTECTED_HTTP_BODY_TIMEOUT',status:408});
   await vi.advanceTimersByTimeAsync(PROTECTED_BODY_TIMEOUT_MS);await rejected;expect(cancelled).toBe(true);
  }finally{vi.useRealTimers();}
 });
 it('rejects immediately fulfilled chunks that starve the deadline timer',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});let elapsed=0,pulls=0,cancelled=false;
  vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  try{const stream=new ReadableStream<Uint8Array>({pull(controller){
    elapsed+=110;pulls++;controller.enqueue(new TextEncoder().encode(pulls===1?'{}':' '));if(pulls===51)controller.close();
   },cancel(){cancelled=true;}},{highWaterMark:0}),init:RequestInit&{duplex:'half'}={method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'};
   await expect(readProtectedRestoreBody(new Request('http://localhost',init),1024)).rejects.toMatchObject({code:'PROTECTED_HTTP_BODY_TIMEOUT',status:408});
   expect(pulls).toBe(Math.ceil(PROTECTED_BODY_TIMEOUT_MS/110));expect(cancelled).toBe(true);
  }finally{vi.restoreAllMocks();vi.useRealTimers();}
 });
 it.each([PROTECTED_BODY_TIMEOUT_MS-1,PROTECTED_BODY_TIMEOUT_MS])('checks the absolute deadline when EOF arrives at %i ms',async(eofAt)=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});let elapsed=0,pulls=0;
  vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  try{const stream=new ReadableStream<Uint8Array>({pull(controller){
    if(++pulls===1)controller.enqueue(new TextEncoder().encode('{}'));else{elapsed=eofAt;controller.close();}
   }},{highWaterMark:0}),init:RequestInit&{duplex:'half'}={method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'};
   const body=readProtectedRestoreBody(new Request('http://localhost',init),1024);
   if(eofAt<PROTECTED_BODY_TIMEOUT_MS)await expect(body).resolves.toEqual({});
   else await expect(body).rejects.toMatchObject({code:'PROTECTED_HTTP_BODY_TIMEOUT',status:408});
   expect(pulls).toBe(2);
  }finally{vi.restoreAllMocks();vi.useRealTimers();}
 });
});
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('protected HTTP in actual local D1/R2',()=>{
 it.each([
  ['default disabled',{RESTORE_PROTECTED_ENABLED:''}],
  ['missing manifest pin',{RESTORE_PROTECTED_MANIFEST_SHA256:''}],
  ['missing admission pin',{RESTORE_PROTECTED_ADMISSION_SHA256:''}],
 ] as const)('refuses %s before a protected session exists',async(_name,env)=>{
  const f=await fixture('highwater',env);expect(await f.protectedCall('status')).toMatchObject({status:403,code:'PROTECTED_HTTP_DISABLED',reads:0});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_d1_session'").first()).toBeNull();
 },30_000);
 it('requires authentication, all resource identities and both exact pins',async()=>{
  const f=await fixture();
  for(const [header,value,status] of [['authorization','Bearer invalid',401],['x-restore-stage','stage-wrong',403],['x-restore-account','f'.repeat(32),403],['x-restore-d1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',403],['x-restore-r2','other-stage-texts',403],['x-restore-plan','f'.repeat(64),409],['x-protected-manifest','f'.repeat(64),403],['x-protected-admission','',403]] as const){
   expect(await f.protectedCall('status',{}, {[header]:value})).toMatchObject({status,reads:0});
  }
  expect(await f.protectedCall('status')).toMatchObject({status:200,initialized:false,reads:0});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_d1_session'").first()).toBeNull();
 },30_000);
 it.each([
  {RESTORE_D1_ID:'8056b1a0-f858-4f89-a332-91f7f350eb7b'},
  {RESTORE_R2_NAME:'civicsignal-corpus'},
 ])('preserves the production target refusal %j',async(env)=>{
  const f=await fixture('highwater',env);expect(await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission})).toMatchObject({status:400,reads:0});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_d1_session'").first()).toBeNull();
 },30_000);
 it('requires the completed compact session and exact admission/plan before protected rows',async()=>{
  const f=await fixture();await f.db.prepare("UPDATE stage_restore_session SET phase='published'").run();
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission})).toMatchObject({status:409,reads:0});
  await f.db.prepare("UPDATE stage_restore_session SET phase='complete'").run();
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:{...f.admission,compactPlanSha256:'f'.repeat(64)}})).toMatchObject({status:409,code:'PROTECTED_HTTP_PLAN'});
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:{...f.admission,protectedChainSha256:'f'.repeat(64)}})).toMatchObject({status:409,code:'PROTECTED_ADMISSION_IDENTITY'});
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission,identity:f.identity})).toMatchObject({status:400,code:'PROTECTED_HTTP_FIELDS'});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_d1_session'").first()).toBeNull();
 },30_000);
 it('bounds and validates raw HTTP input and never returns its protected payload',async()=>{
  const f=await fixture(),before=await f.protectedCall('status');
  const examples:[unknown,Record<string,string>,number,string][]=[
   [new Uint8Array([0xff]),{},400,'PROTECTED_HTTP_JSON'],
   [new Uint8Array(66561),{},413,'PROTECTED_HTTP_BODY_BOUND'],
   [{page:{sql:'SECRET SQL CUSTOMER'}},{'content-type':'text/plain'},415,'PROTECTED_HTTP_CONTENT_TYPE'],
  ];
  for(const [body,headers,status,code]of examples){const response=await f.protectedCall('page',body,headers);expect(response).toMatchObject({status,code,reads:0});expect(JSON.stringify(response)).not.toContain('SECRET');}
  expect(await f.protectedCall('status?unexpected=1')).toMatchObject({status:400,code:'PROTECTED_HTTP_QUERY'});
  expect(await f.protectedCall('status',{}, {},'POST')).toMatchObject({status:404,code:'PROTECTED_HTTP_ENDPOINT'});
  expect(await f.protectedCall('finish',{sql:'SECRET SQL CUSTOMER'})).toMatchObject({status:400,code:'PROTECTED_HTTP_FIELDS'});
  expect(await f.protectedCall('status')).toEqual(before);
 },30_000);
 it('roundtrips every phase, reconciles a lost text reply, and keeps safe status and completed replay read-only',async()=>{
  const f=await fixture();expect(await f.protectedCall('status')).toMatchObject({status:200,initialized:false});
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission})).toMatchObject({status:200,phase:'checking-corpus',version:0});
  for(const page of f.compactPages)expect((await f.protectedCall('corpus',{page})).status).toBe(200);
  const before=await f.protectedCall('status');expect(before.phase).toBe('checking-text');
  // The first successful response is discarded, as if its acknowledgement was lost.
  const lost=await f.send('http://localhost/v1/restore/protected/text',{method:'POST',headers:f.protectedHeaders,body:JSON.stringify({expectedSessionVersion:before.version})});expect(lost.status).toBe(200);await lost.body?.cancel();
  const observed=await f.protectedCall('status');expect(observed).toMatchObject({version:Number(before.version)+1,textRows:8});
  expect(await f.protectedCall('text',{expectedSessionVersion:before.version})).toMatchObject({status:409,code:'PROTECTED_D1_VERSION',reads:0});
  expect(await f.protectedCall('text',{})).toMatchObject({status:400,code:'PROTECTED_HTTP_FIELDS',reads:0});
  expect(await f.protectedCall('text',{expectedSessionVersion:-1})).toMatchObject({status:400,code:'PROTECTED_HTTP_VERSION',reads:0});
  let current=observed;while(current.phase==='checking-text'){const response=await f.protectedCall('text',{expectedSessionVersion:current.version});expect(response.status).toBe(200);current=await f.protectedCall('status');}
  expect(current).toMatchObject({phase:'loading',textRows:18,textComplete:true});
  for(const page of f.pages)expect((await f.protectedCall('page',{page})).status).toBe(200);
  const loaded=await f.protectedCall('status');expect(loaded.phase).toBe('checking-protected');
  expect(await f.protectedCall('page',{page:f.pages[0]})).toMatchObject({status:200,skipped:true,version:loaded.version});
  for(const page of f.pages)expect((await f.protectedCall('verify',{page})).status).toBe(200);
  expect(await f.protectedCall('status')).toMatchObject({phase:'checking-corpus-final'});
  for(const page of f.compactPages)expect((await f.protectedCall('corpus',{page})).status).toBe(200);
  expect(await f.protectedCall('finish')).toMatchObject({status:200,phase:'complete',complete:true});
  const completed=await f.protectedCall('status'),state=await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first();
  const allowed=['status','reads','initialized','phase','version','compactPages','compactRows','compactChain','loadedPages','loadedChain','verifiedPages','verifiedChain','textRows','textBytes','textComplete','complete'];
  expect(Object.keys(completed).sort()).toEqual(allowed.sort());expect(JSON.stringify(completed)).not.toMatch(/workspace|customer|publication|after|row_id|cursor|key/);
  expect(await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission})).toMatchObject({status:200,version:completed.version,complete:true});
  expect(await f.protectedCall('finish')).toMatchObject({status:200,version:completed.version,complete:true});
  expect(await f.protectedCall('verify',{page:f.pages[0]})).toMatchObject({status:200,skipped:true,version:completed.version});
  expect(await f.protectedCall('page',{page:f.pages[0]})).toMatchObject({status:200,skipped:true,version:completed.version});
  expect(await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first()).toEqual(state);
  expect(await sha256File(join(f.output,'pages.jsonl'))).toBe(f.sealedPagesSha);expect(await sha256File(join(f.output,'manifest.json'))).toBe(f.sealedManifestSha);
 },30_000);
 it('reconciles committed page replay exactly and refuses changed rows through HTTP',async()=>{
  const f=await fixture();await f.ready();expect(await f.protectedCall('page',{page:f.pages[0]})).toMatchObject({status:200,skipped:false});
  const before=await f.protectedCall('status');expect(await f.protectedCall('page',{page:f.pages[0]})).toMatchObject({status:200,skipped:true,version:before.version});
  await f.db.prepare("UPDATE workspace SET name='altered protected value'").run();
  const rejected=await f.protectedCall('page',{page:f.pages[0]});expect(rejected).toMatchObject({status:409,code:'PROTECTED_D1_REPLAY_ROW'});expect(JSON.stringify(rejected)).not.toContain('altered');
 },30_000);
});
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('protected pages in actual local D1/R2',()=>{
 it('keeps reordered target identity keys usable after begin',async()=>{
  const f=await fixture(),t=f.identity.target,target:StagingRestoreTarget={adminUrl:t.adminUrl,r2Bucket:t.r2Bucket,d1Id:t.d1Id,accountId:t.accountId,stageId:t.stageId,stageOnly:true,format:1},identity={...f.identity,target};
  expect(Object.keys(target)).not.toEqual(Object.keys(t));
  expect(await f.call('begin',{manifest:f.manifest,admission:f.admission,identity})).toMatchObject({status:200,value:{phase:'checking-corpus'}});
  const status=await f.call('status',{identity});expect(status).toMatchObject({status:200,value:{initialized:true,phase:'checking-corpus'}});
  expect(await f.call('status')).toEqual(status);
  expect(await f.call('begin',{manifest:f.manifest,admission:f.admission,identity})).toMatchObject({status:200,value:{phase:'checking-corpus'}});
  expect(await f.call('corpus',{page:f.compactPages[0],identity})).toMatchObject({status:200});
 },30_000);
 it.each(['T EXT','T/**/EXT'])('rejects altered-affinity type %s before session admission',async(type)=>{
  const f=await fixture(),sql=PROTECTED_D1_AUTH_SCHEMA.replace('id TEXT PRIMARY KEY',`id ${type} PRIMARY KEY`);
  await f.db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(statement=>f.db.prepare(statement)));
  expect(await f.begin()).toMatchObject({status:409,code:'PROTECTED_D1_SCHEMA_OBJECT'});
  expect(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='protected_state_d1_session'").first()).toBeNull();
 },30_000);
 it('accepts harmless token spacing and comments in the exact auth schema',async()=>{
  const f=await fixture(),sql=PROTECTED_D1_AUTH_SCHEMA.replace('id TEXT PRIMARY KEY','id /* separator */ TEXT PRIMARY KEY').replace("status = 'active'","status /* separator */ = 'active'");
  await f.db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(statement=>f.db.prepare(statement)));
  expect(await f.begin()).toMatchObject({status:200,value:{phase:'checking-corpus'}});
 },30_000);
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
 it('fences a text-specific session change after R2 reads inside its audit batch',async()=>{
  const f=await fixture();await f.begin();await f.corpus();
  const before=await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first<{state_json:string;version:number}>();
  expect(await f.call('text',{fault:'session',expectedSessionVersion:before!.version})).toMatchObject({status:409,code:'PROTECTED_D1_FAILURE',reads:8});
  const after=await f.db.prepare('SELECT state_json,version FROM protected_state_d1_session').first<{state_json:string;version:number}>();
  expect(after).toEqual({state_json:before!.state_json,version:before!.version+1});
  expect(JSON.parse(after!.state_json).audit).toBeNull();
  expect(await f.db.prepare('SELECT count(*) AS n FROM workspace').first()).toEqual({n:0});
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
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('durable initial protected admission windows',()=>{
 async function journalText(directory:string):Promise<string>{let text='';for(const name of await readdir(directory)){const path=join(directory,name),info=await lstat(path);expect(info.mode&0o777).toBe(info.isDirectory()?0o700:0o600);text+=info.isDirectory()?await journalText(path):await readFile(path,'utf8');}return text;}
 it('seals without credentials or networking, then resumes exact small windows and stops before text/auth rows',async()=>{
  const f=await fixture();let credentials=0,sends=0,active=0,peak=0;
  const options={...f.client,credential:()=>{credentials++;return f.client.credential();},fetch:(async(url,init)=>{sends++;active++;peak=Math.max(peak,active);try{return await f.send(url,init);}finally{active--;}}) as typeof fetch,maxRequests:4};
  expect(await inspectProtectedD1Client(options)).toMatchObject({execute:false,compactPages:2,corpusRows:18});expect(credentials).toBe(0);expect(sends).toBe(0);
  const first=await runProtectedD1InitialWindow(options);expect(first).toMatchObject({outcome:'bounded',attempts:3,progress:{phase:'checking-corpus',compactPages:1,version:1}});
  const second=await runProtectedD1InitialWindow(options);expect(second).toMatchObject({outcome:'checking-text',attempts:2,progress:{compactPages:2,version:2,textRows:0}});
  expect(await runProtectedD1InitialWindow(options)).toMatchObject({outcome:'checking-text',attempts:1});expect(peak).toBe(1);
  expect(await f.db.prepare('SELECT count(*) AS n FROM workspace').first()).toEqual({n:0});
  const state=JSON.parse((await f.db.prepare('SELECT state_json FROM protected_state_d1_session').first<{state_json:string}>())!.state_json);expect(state.audit).toBeNull();expect(state.phase).toBe('checking-text');
  const text=await journalText(options.journalDirectory);for(const secret of ['Synthetic','key_hash','Bearer ',f.client.credential(),f.root])expect(text).not.toContain(secret);
 },30_000);
 it('fsyncs an exclusive request intent before selecting the credential',async()=>{
  const f=await fixture();let selected=false;
  const r=await runProtectedD1InitialWindow({...f.client,maxRequests:1,credential:async()=>{const path=join(f.client.journalDirectory,'window-000001','request-0001.intent.json');expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({step:'status',attempt:1});expect((await lstat(path)).mode&0o777).toBe(0o600);selected=true;return f.client.credential();}});
  expect(r).toMatchObject({outcome:'bounded',attempts:1,progress:{initialized:false}});expect(selected).toBe(true);
 },30_000);
 it.each(['begin','corpus'] as const)('reconciles a committed lost %s reply through one GET, ends the window, and never resends it',async(lostStep)=>{
  const f=await fixture();let lost=false;const posts:string[]=[];
  const send:typeof fetch=async(url,init)=>{const step=new URL(String(url)).pathname.split('/').at(-1)!;if(init?.method==='POST')posts.push(step==='corpus'?step+':'+JSON.parse(String(init.body)).page.page:step);
   const response=await f.send(url,init);if(step===lostStep&&!lost){lost=true;await response.body?.cancel();throw new Error('PRIVATE '+f.client.credential());}return response;};
  const first=await runProtectedD1InitialWindow({...f.client,fetch:send});expect(first.outcome).toBe('reconciled');expect(first.requests.at(-1)?.kind).toBe('ack');
  const before=[...posts];expect(await runProtectedD1InitialWindow({...f.client,fetch:send})).toMatchObject({outcome:'checking-text'});
  expect(posts.filter(p=>p==='begin')).toHaveLength(1);expect(posts.filter(p=>p==='corpus:1')).toHaveLength(1);expect(before.length).toBe(lostStep==='begin'?1:2);
  expect(await journalText(f.client.journalDirectory)).not.toContain('PRIVATE');
 },30_000);
 it('never treats unchanged status as a fence for a late POST or permission to resend',async()=>{
  const f=await fixture();let sends=0;
  const send:typeof fetch=async(url,init)=>{sends++;if(init?.method==='POST')throw new Error('lost before reply');return f.send(url,init);};
  const result=await runProtectedD1InitialWindow({...f.client,fetch:send});expect(result).toMatchObject({outcome:'unresolved',attempts:3,progress:{initialized:false}});expect(sends).toBe(3);
  // The original uncertain begin could still commit after that unchanged GET.
  expect((await f.protectedCall('begin',{manifest:f.manifest,admission:f.admission})).status).toBe(200);
  let credentials=0;await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{credentials++;return f.client.credential();},fetch:async()=>{sends++;throw Error('must not send');}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_UNRESOLVED'});expect(credentials).toBe(0);expect(sends).toBe(3);
 },30_000);
 it('requires fresh remote parity with the complete durable receipt prefix',async()=>{
  const f=await fixture();expect((await runProtectedD1InitialWindow({...f.client,maxRequests:4})).outcome).toBe('bounded');
  await f.db.prepare('UPDATE protected_state_d1_session SET version=version+1').run();let posts=0;
  const result=await runProtectedD1InitialWindow({...f.client,fetch:async(url,init)=>{if(init?.method==='POST')posts++;return f.send(url,init);}});expect(result.outcome).toBe('failed');expect(result.attempts).toBe(1);expect(posts).toBe(0);
 },30_000);
 it.each(['protected','admission','cutover'] as const)('refuses %s source drift before credentials, networking or a new journal',async(kind)=>{
  const f=await fixture(),path=kind==='protected'?join(f.output,'pages.jsonl'):kind==='admission'?f.client.admissionPath:join(f.bundle,'objects.pack');await writeFile(path,'PRIVATE corrupted source');let selected=0,sends=0;
  await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{selected++;return f.client.credential();},fetch:async()=>{sends++;throw Error('must not send');}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_LOCAL_OR_TRANSPORT'});
  expect(selected).toBe(0);expect(sends).toBe(0);await expect(lstat(f.client.journalDirectory)).rejects.toMatchObject({code:'ENOENT'});
 },30_000);
 it('refuses competing and crash windows without repairing their markers',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});let secondSelected=0;
  const first=runProtectedD1InitialWindow({...f.client,maxRequests:1,fetch:async(url,init)=>{entered();await gate;return f.send(url,init);}});
  await seen;try{await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{secondSelected++;return f.client.credential();}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_CRASH_OR_COMPETING_WINDOW'});}finally{release();}
  expect(secondSelected).toBe(0);await first;
  const directory=join(f.client.journalDirectory,'window-000002');await mkdir(directory,{mode:0o700});await writeFile(join(directory,'started.json'),'partial',{mode:0o600});
  await expect(runProtectedD1InitialWindow(f.client)).rejects.toMatchObject({code:'PROTECTED_CLIENT_CRASH_OR_COMPETING_WINDOW'});expect(await readFile(join(directory,'started.json'),'utf8')).toBe('partial');
 },30_000);
 it('refuses a partial/tampered acknowledgement prefix and preserves its bytes',async()=>{
  const f=await fixture();await runProtectedD1InitialWindow({...f.client,maxRequests:1});const path=join(f.client.journalDirectory,'window-000001','request-0001.ack.json');await writeFile(path,'{"partial":');
  let selected=0;await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{selected++;return f.client.credential();}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_LOCAL_OR_TRANSPORT'});expect(selected).toBe(0);expect(await readFile(path,'utf8')).toBe('{"partial":');
 },30_000);
 it('reserves an extra GET attempt and its complete time budget before any POST',async()=>{
  const f=await fixture();let posts=0;
  expect(await runProtectedD1InitialWindow({...f.client,wallMs:1000,requestMs:700,fetch:async(url,init)=>{if(init?.method==='POST')posts++;return f.send(url,init);}})).toMatchObject({outcome:'bounded',attempts:1});expect(posts).toBe(0);
 },30_000);
 it.each([{maxRequests:65},{wallMs:300001},{requestMs:15001},{maxRequests:0}])('refuses limits beyond hard bounds %j before credentials',async(bounds)=>{
  const f=await fixture();let selected=0;await expect(runProtectedD1InitialWindow({...f.client,...bounds,credential:()=>{selected++;return '';}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_LIMITS'});expect(selected).toBe(0);
 },30_000);
 it.each(['redirect','oversize','invalid-json'] as const)('bounds/refuses %s replies without automatic retries or payload leakage',async(kind)=>{
  const f=await fixture();let sends=0;const result=await runProtectedD1InitialWindow({...f.client,fetch:async()=>{sends++;return kind==='redirect'?new Response('PRIVATE',{status:302,headers:{location:'https://production.invalid'}}):new Response(kind==='oversize'?'PRIVATE'.repeat(3000):'PRIVATE invalid JSON');}});
  expect(result).toMatchObject({outcome:'failed',attempts:1});expect(sends).toBe(1);expect(await journalText(f.client.journalDirectory)).not.toContain('PRIVATE');
 },30_000);
 it('bounds a stalled response body and cancels it',async()=>{
  const f=await fixture();let cancelled=false;vi.spyOn(performance,'now').mockReturnValue(0);
  try{const result=await runProtectedD1InitialWindow({...f.client,requestMs:20,fetch:async()=>new Response(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}))});
   expect(result).toMatchObject({outcome:'failed',attempts:1,code:'PROTECTED_CLIENT_REQUEST_TIMEOUT'});expect(cancelled).toBe(true);
  }finally{vi.restoreAllMocks();}
 },30_000);
 it('refuses reconciliation while the failed POST body cancellation remains unsettled',async()=>{
  const f=await fixture();let sends=0,cancelPending=false;vi.spyOn(performance,'now').mockReturnValue(0);
  try{const result=await runProtectedD1InitialWindow({...f.client,requestMs:1000,fetch:async(url,init)=>{sends++;const response=await f.send(url,init);
    if(init?.method!=='POST')return response;
    await response.body?.cancel();return new Response(new ReadableStream<Uint8Array>({cancel(){cancelPending=true;return new Promise(()=>{});}}),{status:503});}});
   expect(result).toMatchObject({outcome:'unresolved',attempts:2,progress:{initialized:false}});expect(sends).toBe(2);expect(cancelPending).toBe(true);
   expect((await f.protectedCall('status')).phase).toBe('checking-corpus');let selected=0;
   await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{selected++;return f.client.credential();},fetch:async()=>{sends++;throw Error('must not send');}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_UNRESOLVED'});
   expect(selected).toBe(0);expect(sends).toBe(2);
  }finally{vi.restoreAllMocks();}
 },30_000);
 it.each(['request-0001.ack.json','result.json','accepted.json'])('refuses normal acceptance when %s fsync crosses the wall and preserves the durable ack',async(faultFile)=>{
  const f=await fixture();let clock=0;vi.spyOn(performance,'now').mockImplementation(()=>clock);
  clientFsyncFault.afterSync=path=>{if(path.endsWith('/'+faultFile))clock=11;};
  try{await expect(runProtectedD1InitialWindow({...f.client,maxRequests:1,wallMs:10,requestMs:5,fetch:async()=>Response.json({initialized:false})})).rejects.toMatchObject({code:'PROTECTED_CLIENT_WALL'});
   clientFsyncFault.afterSync=undefined;const directory=join(f.client.journalDirectory,'window-000001'),path=join(directory,'request-0001.ack.json'),ack=await readFile(path,'utf8');
   expect(JSON.parse(ack)).toMatchObject({kind:'ack',progress:{initialized:false}});await expect(lstat(join(directory,'request-0001.failure.json'))).rejects.toMatchObject({code:'ENOENT'});
   let selected=0,sends=0;await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{selected++;return f.client.credential();},fetch:async()=>{sends++;throw Error('must not send');}})).rejects.toBeDefined();
   expect(selected).toBe(0);expect(sends).toBe(0);expect(await readFile(path,'utf8')).toBe(ack);
  }finally{clientFsyncFault.afterSync=undefined;vi.restoreAllMocks();}
 },30_000);
 it('preserves acknowledged POST progress as failed without a second terminal or reconciliation after an ack fsync overrun',async()=>{
  const f=await fixture();let clock=0,sends=0;vi.spyOn(performance,'now').mockImplementation(()=>clock);
  clientFsyncFault.afterSync=path=>{if(path.endsWith('/request-0002.ack.json'))clock=3001;};
  try{await expect(runProtectedD1InitialWindow({...f.client,maxRequests:3,wallMs:3000,requestMs:1000,fetch:async(url,init)=>{sends++;return f.send(url,init);}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_WALL'});
   const directory=join(f.client.journalDirectory,'window-000001'),result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
   expect(result).toMatchObject({outcome:'failed',attempts:2,progress:{phase:'checking-corpus',version:0,compactPages:0},code:'PROTECTED_CLIENT_WALL'});expect(sends).toBe(2);
   expect((await readdir(directory)).sort()).toEqual(['request-0001.ack.json','request-0001.intent.json','request-0002.ack.json','request-0002.intent.json','result.json','started.json']);
  }finally{clientFsyncFault.afterSync=undefined;vi.restoreAllMocks();}
 },30_000);
 it('cancels a late response and never overlaps another request with the unsettled send',async()=>{
  const f=await fixture();let cancelled=false,sends=0,clock=0;vi.spyOn(performance,'now').mockImplementation(()=>clock);
  try{const result=await runProtectedD1InitialWindow({...f.client,requestMs:5,fetch:async()=>{sends++;clock=6;await new Promise(r=>setTimeout(r,30));return new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}));}});
   expect(result).toMatchObject({outcome:'failed',attempts:1});await new Promise(r=>setTimeout(r,40));expect(sends).toBe(1);expect(cancelled).toBe(true);
  }finally{vi.restoreAllMocks();}
 },30_000);
 it('checks the monotonic request deadline after credential selection before sending',async()=>{
  const f=await fixture();let clock=0,sends=0;vi.spyOn(performance,'now').mockImplementation(()=>clock);
  try{const result=await runProtectedD1InitialWindow({...f.client,requestMs:5,credential:()=>{clock=6;return f.client.credential();},fetch:async()=>{sends++;throw Error('must not send');}});expect(result).toMatchObject({outcome:'failed',attempts:1,code:'PROTECTED_CLIENT_REQUEST_TIMEOUT'});expect(sends).toBe(0);}finally{vi.restoreAllMocks();}
 },30_000);
 it('refuses an exhausted overall wall after full sealing without selecting credentials or creating a journal',async()=>{
  const f=await fixture();let selected=0,sends=0;vi.spyOn(performance,'now').mockReturnValueOnce(0).mockReturnValue(300001);
  try{await expect(runProtectedD1InitialWindow({...f.client,credential:()=>{selected++;return '';},fetch:async()=>{sends++;throw Error('must not send');}})).rejects.toMatchObject({code:'PROTECTED_CLIENT_WALL'});
   expect(selected).toBe(0);expect(sends).toBe(0);await expect(lstat(f.client.journalDirectory)).rejects.toMatchObject({code:'ENOENT'});
  }finally{vi.restoreAllMocks();}
 },30_000);
 it('enforces the monotonic deadline while immediately fulfilled chunks starve the timer',async()=>{
  const f=await fixture();let clock=0,cancelled=false;vi.spyOn(performance,'now').mockImplementation(()=>clock);
  try{const result=await runProtectedD1InitialWindow({...f.client,requestMs:5,fetch:async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){clock+=6;controller.enqueue(new TextEncoder().encode('{"initialized":false}'));},cancel(){cancelled=true;}},{highWaterMark:0}))});
   expect(result).toMatchObject({outcome:'failed',attempts:1,code:'PROTECTED_CLIENT_REQUEST_TIMEOUT'});expect(cancelled).toBe(true);
  }finally{vi.restoreAllMocks();}
 },30_000);
 it('defaults the thin CLI to source-only inspection without a journal or execution mode',async()=>{
  const f=await fixture(),target=join(f.root,'client-target.json');await writeFile(target,JSON.stringify(f.client.target),{mode:0o600});
  const result=await protectedD1ClientMain(['--directory',f.output,'--manifest-sha256',f.client.manifestSha256,'--admission',f.client.admissionPath,'--admission-sha256',f.client.admissionSha256,'--admission-file-sha256',f.client.admissionFileSha256,'--cutover',f.bundle,'--target',target]);
  expect(result).toMatchObject({execute:false,compactPages:2});await expect(lstat(f.client.journalDirectory)).rejects.toMatchObject({code:'ENOENT'});
 },30_000);
 it('refuses an oversized private CLI target before reading its bytes',async()=>{
  const f=await fixture(),target=join(f.root,'client-target.json');await writeFile(target,'PRIVATE invalid JSON'.padEnd(16*1024+1,'x'),{mode:0o600});
  let targetReads=0;clientFsyncFault.beforeRead=path=>{if(path===target)targetReads++;};
  try{await expect(protectedD1ClientMain(['--directory',f.output,'--manifest-sha256',f.client.manifestSha256,'--admission',f.client.admissionPath,'--admission-sha256',f.client.admissionSha256,'--admission-file-sha256',f.client.admissionFileSha256,'--cutover',f.bundle,'--target',target])).rejects.toMatchObject({code:'PROTECTED_CLIENT_TARGET_BOUND'});expect(targetReads).toBe(0);
   await expect(lstat(f.client.journalDirectory)).rejects.toMatchObject({code:'ENOENT'});
  }finally{clientFsyncFault.beforeRead=undefined;}
 },30_000);
});
