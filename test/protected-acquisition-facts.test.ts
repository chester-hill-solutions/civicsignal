import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync as Sqlite} from 'node:sqlite';
import {captureProtectedAcquisitionFixture,PROTECTED_ACQUISITION_SOURCE,type AcquisitionFixtureRequest} from '../scripts/lib/protected-acquisition';
import {createFixtureAcquisitionTransport,type AcquisitionTransportLimits,type AcquisitionSendInit} from '../scripts/lib/protected-acquisition-transport';
import {captureProtectedAcquisitionFacts,PROTECTED_ACQUISITION_FACT_QUERIES as queries} from '../scripts/lib/protected-acquisition-facts';

const hooks=vi.hoisted(()=>({afterFsync:undefined as ((path:string)=>void)|undefined,afterRead:undefined as ((path:string,bytes:number,position:number)=>void)|undefined,paths:new Map<number,string>()}));
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return {...fs,
 openSync:(...args:Parameters<typeof fs.openSync>)=>{const fd=fs.openSync(...args);hooks.paths.set(fd,String(args[0]));return fd;},
 closeSync:(fd:number)=>{hooks.paths.delete(fd);fs.closeSync(fd);},
 fsyncSync:(fd:number)=>{fs.fsyncSync(fd);hooks.afterFsync?.(hooks.paths.get(fd)??'');},
 readSync:(fd:number,value:Uint8Array,offset:number,length:number,position:number)=>{const bytes=fs.readSync(fd,value,offset,length,position);hooks.afterRead?.(hooks.paths.get(fd)??'',bytes,position);return bytes;},
};});
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof Sqlite};
const roots:string[]=[],databases:Sqlite[]=[];
const source=PROTECTED_ACQUISITION_SOURCE,base=`https://api.cloudflare.com/client/v4/accounts/${source.accountId}`;
const endpoint=`${base}/d1/database/${source.d1Id}/query`,origin='https://fixture-export.invalid';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const envelope=(results:unknown[])=>({success:true,errors:[],result:[{success:true,results,meta:{duration:1,changed_db:false}}]});
const list:AcquisitionFixtureRequest={ordinal:1,kind:'kv-list-a',method:'GET',url:`${base}/storage/kv/namespaces/${source.kvNamespaceId}/keys?limit=100`,body:null,credentialScope:'management',responseBytes:262144};
async function fixture(options:{withoutSequenceTable?:boolean;limits?:Partial<AcquisitionTransportLimits>;send?:(url:string,init:AcquisitionSendInit,normal:()=>Response)=>Promise<Response>}={}){
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'civic-acquisition-facts-')));chmodSync(parent,0o700);roots.push(parent);
 const db=new DatabaseSync(':memory:');databases.push(db);
 db.exec(`CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY${options.withoutSequenceTable?'':' AUTOINCREMENT'});CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY${options.withoutSequenceTable?'':' AUTOINCREMENT'});`);
 if(!options.withoutSequenceTable)db.exec("INSERT INTO sqlite_sequence VALUES('corpus_runs',0),('corpus_changes',120);");
 const calls:{url:string;init:AcquisitionSendInit}[]=[];let selected=0,mono=0;const wall=Date.UTC(2026,9,31);
 const owner=await createFixtureAcquisitionTransport({fixtureOnly:true,journalDirectory:join(parent,'owner'),validUntil:wall+60000,signedDownloadOrigin:origin,
  limits:{maxRequests:30,wallMs:10000,managementMs:1000,downloadMs:1000,responseBytes:262144,downloadBytes:1024,aggregateResponseBytes:10*1024*1024,minStartSpacingMs:0,...options.limits},
  clock:{monotonic:()=>mono,wall:()=>wall,sleep:async ms=>{mono+=ms;}},
  syntheticCredential:()=>{selected++;expect(existsSync(join(parent,'facts-before','facts.intent.json'))||existsSync(join(parent,'owner','exchange-0001.intent.json'))).toBe(true);return {fixtureOnly:true,value:'SYNTHETIC_MANAGEMENT_CREDENTIAL_0123456789',expiresAt:wall+60000};},
  send:async(url,init)=>{calls.push({url,init});const normal=()=>{
   if(url===endpoint){const sql=JSON.parse(String(init.body)).sql;expect(Object.values(queries)).toContain(sql);return new Response(JSON.stringify(envelope(db.prepare(sql).all())));}
   if(url.endsWith('/export'))return new Response(JSON.stringify({success:true,result:{status:'complete',result:{signed_url:origin+'/raw.sql'}}}));
   if(url.startsWith(origin))return new Response('CREATE TABLE captured(id INTEGER);');
   return new Response(JSON.stringify({success:true,result:[],result_info:{cursor:''}}));
  };return options.send?options.send(url,init,normal):normal();},
 });
 const before=join(parent,'facts-before'),after=join(parent,'facts-after');
 return {owner,parent,db,calls,before,after,wall,selected:()=>selected,setMono:(n:number)=>{mono=n;},clock:{monotonic:()=>mono,wall:()=>wall,sleep:async(ms:number)=>{mono+=ms;}},
  collect:(phase:'before'|'after'='before')=>captureProtectedAcquisitionFacts({mode:'fixture-only',phase,captureDirectory:phase==='before'?before:after,owner}),
  observation:(phase:'before'|'after'='before')=>JSON.parse(readFileSync(join(phase==='before'?before:after,'source-facts.json'),'utf8')),
 };
}
afterEach(()=>{hooks.afterFsync=undefined;hooks.afterRead=undefined;hooks.paths.clear();vi.useRealTimers();vi.restoreAllMocks();for(const db of databases.splice(0))db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe('fixed source/schema/original-sequence observations under one acquisition owner',()=>{
 it('captures actual SQLite query shapes, preserves zero and highwater, and pins private raw bytes',async()=>{
  const f=await fixture(),result=await f.collect(),saved=f.observation();
  expect(result).toMatchObject({fixtureOnly:true,factsCaptureComplete:true,requests:2,schemaObjects:3,sequenceTable:'present',providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false,sourceSchemaClassified:false,standaloneAcceptance:false});
  expect(saved.facts.sequences).toEqual({tablePresence:'present',facts:{corpus_runs:{presence:'present',value:0},corpus_changes:{presence:'present',value:120}}});
  for(const ref of Object.values(saved.responses) as {path:string;sha256:string;bytes:number}[]){const raw=readFileSync(ref.path);expect(hash(raw)).toBe(ref.sha256);expect(raw.byteLength).toBe(ref.bytes);}
  expect(result.observationSha256).toBe(hash(readFileSync(join(f.before,'source-facts.json'))));
  expect(f.calls.map(c=>({url:c.url,method:c.init.method,body:c.init.body}))).toEqual(Object.values(queries).map(sql=>({url:endpoint,method:'POST',body:JSON.stringify({sql})})));
  expect(f.owner.snapshot()).toMatchObject({requests:2,sent:2,terminal:false,ioSettled:true});expect(f.selected()).toBe(1);
  expect(statSync(f.before).mode&0o777).toBe(0o700);for(const name of readdirSync(f.before))expect(statSync(join(f.before,name)).mode&0o777).toBe(0o600);
  expect(JSON.stringify(result)).not.toContain('CREATE TABLE');expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_MANAGEMENT');
 });
 it('keeps an absent entry distinct from a present zero after a complete successful sequence query',async()=>{
  const f=await fixture();f.db.exec("DELETE FROM sqlite_sequence WHERE name='corpus_changes'");await f.collect();
  expect(f.observation().facts.sequences.facts).toEqual({corpus_runs:{presence:'present',value:0},corpus_changes:{presence:'absent'}});
 });
 it('uses positive schema absence instead of sending a query to a nonexistent sequence table',async()=>{
  const f=await fixture({withoutSequenceTable:true});expect(await f.collect()).toMatchObject({requests:1,sequenceTable:'absent'});
  expect(f.observation().responses.sequences).toBeNull();expect(f.observation().facts.sequences).toEqual({tablePresence:'absent',facts:{corpus_runs:{presence:'absent'},corpus_changes:{presence:'absent'}}});expect(f.calls).toHaveLength(1);
 });
 it('uses SQLite UTF-8 BINARY ordering for non-BMP schema names',async()=>{
  const f=await fixture();f.db.exec('CREATE TABLE "\uffff"(id INTEGER); CREATE TABLE "\u{10000}"(id INTEGER);');
  await expect(f.collect()).resolves.toMatchObject({schemaObjects:5});
 });
 it('compares point-in-time facts without asserting a common freeze or authenticating before/after data',async()=>{
  const f=await fixture(),before=await f.collect();const same=await f.collect('after');expect(same.factsSha256).toBe(before.factsSha256);
  expect(same.globalQuiescenceEstablished).toBe(false);expect(same.productionAcquisitionQualified).toBe(false);expect(f.owner.snapshot().requests).toBe(4);expect(f.selected()).toBe(1);
  const g=await fixture(),a=await g.collect();g.db.exec("UPDATE sqlite_sequence SET seq=1 WHERE name='corpus_runs'");expect((await g.collect('after')).factsSha256).not.toBe(a.factsSha256);
 });
 it('shares the original KV/export/KV, auth normalization and signed-download owner without resetting its counters',async()=>{
  const f=await fixture();await f.collect();const core=await captureProtectedAcquisitionFixture({mode:'fixture-only',source,captureDirectory:join(f.parent,'core'),validUntil:f.wall+60000,
   io:{fixtureOnly:true,exchange:(request,signal)=>f.owner.management(request,signal)},clock:f.clock,limits:{maxRequests:10,wallMs:10000,requestMs:1000,kvPages:1,kvNames:10,exportPolls:2}});
  expect(core).toMatchObject({fixtureCaptureComplete:true,requests:3,kvNames:0,downloadPending:true});
  await f.owner.downloadSql({signedUrl:origin+'/raw.sql',destination:join(f.parent,'owner','source.private.sql')});await f.collect('after');
  expect(f.owner.snapshot()).toMatchObject({requests:8,sent:8,terminal:false});expect(f.selected()).toBe(1);expect(f.calls.filter(c=>c.url.startsWith(origin)).every(c=>Object.keys(c.init.headers).length===0)).toBe(true);
 });
 it.each([
  {success:false,result:[]},{success:true,errors:[{message:'PRIVATE'}],result:[]},
  {success:true,result:[{success:true,results:[]},{success:true,results:[]}]},
  {success:true,result:[{success:false,results:[]}]},{success:true,result:[{success:true,error:'PRIVATE',results:[]}]},
  {success:true,result:[{success:true}]},
 ])('retains refused schema replies without treating missing or failed results as absence: %j',async body=>{
  const f=await fixture({send:async()=>new Response(JSON.stringify(body))});await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_RESPONSE'});
  expect(readFileSync(join(f.before,'d1-schema.raw.json'),'utf8')).toBe(JSON.stringify(body));expect(f.calls).toHaveLength(1);expect(f.owner.snapshot().terminal).toBe(true);
  await expect(f.owner.management(list)).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(1);
 });
 it.each(['invalid-json','invalid-utf8'] as const)('refuses %s without exposing response bytes in errors',async kind=>{
  const f=await fixture({send:async()=>new Response(kind==='invalid-json'?'PRIVATE RAW JSON':new Uint8Array([0xff]))});
  await expect(f.collect()).rejects.toMatchObject({message:'ACQUISITION_FACTS_JSON'});expect(f.owner.snapshot().terminal).toBe(true);
 });
 it('retains HTTP refusals privately and terminally fences the same owner',async()=>{
  const f=await fixture({send:async()=>new Response('PRIVATE PROVIDER BODY',{status:503})});await expect(f.collect()).rejects.toHaveProperty('code');
  expect(readFileSync(join(f.before,'d1-schema.raw.json'),'utf8')).toBe('PRIVATE PROVIDER BODY');expect(f.owner.snapshot().terminal).toBe(true);expect(f.calls).toHaveLength(1);
 });
 it('refuses the inventory limit sentinel before querying sequences',async()=>{
  const f=await fixture();for(let i=0;i<64;i++)f.db.exec(`CREATE TABLE fixture_${i}(id INTEGER)`);
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_SCHEMA_BOUND'});expect(f.calls).toHaveLength(1);
 });
 it.each([
  [{type:'table',name:'z',tbl_name:'z',sql:null},{type:'table',name:'a',tbl_name:'a',sql:null}],
  [{type:'table',name:'a',tbl_name:'a',sql:null},{type:'table',name:'a',tbl_name:'a',sql:null}],
  [{type:'table',name:'a',tbl_name:'a',sql:12}],
 ].map(rows=>({rows})))('refuses malformed or unordered schema projections',async ({rows})=>{
  const f=await fixture({send:async()=>new Response(JSON.stringify(envelope(rows)))});await expect(f.collect()).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(1);expect(f.owner.snapshot().terminal).toBe(true);
 });
 it.each([
  [{name:'corpus_runs',seq:null}],[{name:'corpus_runs',seq:-1}],[{name:'corpus_runs',seq:Number.MAX_SAFE_INTEGER+1}],
  [{name:'unknown',seq:0}],[{name:'corpus_runs',seq:1},{name:'corpus_runs',seq:1}],
  [{name:'corpus_runs',seq:0},{name:'corpus_changes',seq:0}],
  [{name:'corpus_changes',seq:0},{name:'corpus_runs',seq:0},{name:'unknown',seq:0}],
 ].map(rows=>({rows})))('never invents original sequence facts from malformed rows: %j',async ({rows})=>{
  const f=await fixture({send:async(_u,init,normal)=>JSON.parse(String(init.body)).sql===queries['d1-sequences']?new Response(JSON.stringify(envelope(rows))):normal()});
  await expect(f.collect()).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(2);expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'source-facts.json'))).toBe(false);
 });
 it.each([
  {body:JSON.stringify({sql:'SELECT private FROM workspace'})},{body:JSON.stringify({sql:queries['d1-schema'],params:[]})},
  {body:JSON.stringify({sql:queries['d1-schema']+';DELETE FROM workspace'})},{method:'GET'},
  {url:endpoint.replace(source.d1Id,'f'.repeat(32))},{url:endpoint+'?extra=1'},
 ])('refuses any widening of the fixed facts request before credential selection',async change=>{
  const f=await fixture();await expect(f.owner.management({ordinal:1,kind:'d1-schema',method:'POST',url:endpoint,body:JSON.stringify({sql:queries['d1-schema']}),credentialScope:'management',responseBytes:262144,...change} as AcquisitionFixtureRequest)).rejects.toHaveProperty('code');
  expect(f.selected()).toBe(0);expect(f.calls).toEqual([]);expect(f.owner.snapshot().terminal).toBe(true);
 });
 it('keeps facts and later acquisition calls within the same cumulative request ceiling',async()=>{
  const f=await fixture({limits:{maxRequests:2}});await f.collect();await expect(f.owner.management(list)).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_REQUEST_BOUND'});expect(f.calls).toHaveLength(2);
 });
 it('keeps a lost transport acknowledgement terminal and conservatively unsettled',async()=>{
  const f=await fixture({limits:{managementMs:20},send:async()=>new Promise(()=>{})});
  const result=await f.collect().then(()=>null,error=>error);expect(result).toMatchObject({ioSettled:false});
  expect(f.calls).toHaveLength(1);expect(f.owner.snapshot()).toMatchObject({terminal:true,ioSettled:false});await expect(f.owner.management(list)).rejects.toHaveProperty('code');
 });
 it.each(['facts.intent.json','d1-schema.raw.json'] as const)('a %s persistence failure preserves the consumed directory and fences later work',async target=>{
  const f=await fixture();let fired=false;hooks.afterFsync=path=>{if(!fired&&path.endsWith('/'+target)){fired=true;throw Error('PRIVATE filesystem path');}};
  await expect(f.collect()).rejects.toMatchObject({message:'ACQUISITION_FACTS_LOCAL_OR_OWNER'});expect(f.calls).toHaveLength(target==='facts.intent.json'?0:1);expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
  const sent=f.calls.length;await expect(f.collect()).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(sent);
 });
 it('detects same-size raw-byte replacement before accepting a hash-linked observation',async()=>{
  const f=await fixture();let fired=false;hooks.afterFsync=path=>{if(!fired&&path.endsWith('/d1-schema.raw.json')){fired=true;const raw=readFileSync(path);raw[0]^=1;writeFileSync(path,raw);}};
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_FILE_DRIFT'});expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'source-facts.json'))).toBe(false);
 });
 it.each(['in-place','replacement','hardlink','permissions'] as const)('refuses retained raw %s drift during a later exchange',async kind=>{
  let target='';const f=await fixture({send:async(_u,init,normal)=>{
   const response=normal();if(JSON.parse(String(init.body)).sql===queries['d1-sequences']){
    const path=join(target,'d1-schema.raw.json'),bytes=readFileSync(path);
    if(kind==='in-place'){bytes[0]^=1;writeFileSync(path,bytes);}
    else if(kind==='replacement'){renameSync(path,path+'.original');writeFileSync(path,bytes,{mode:0o600});}
    else if(kind==='hardlink')linkSync(path,path+'.alias');else chmodSync(path,0o644);
   }return response;
  }});target=f.before;
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_FILE_DRIFT'});
  expect(f.calls).toHaveLength(2);expect(f.owner.snapshot()).toMatchObject({terminal:true,ioSettled:true});
  expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
  await expect(f.owner.management(list)).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(2);
 });
 it.each(['facts.intent.json','d1-schema.raw.json','d1-sequences.raw.json','source-facts.json','facts.result.json'] as const)(
  'refuses retained %s drift at the final directory fsync boundary',async target=>{
   const f=await fixture();let fired=false;
   hooks.afterFsync=path=>{if(!fired&&path===f.before&&existsSync(join(f.before,'facts.result.json'))){
    fired=true;const file=join(f.before,target),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);
   }};
   await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_FILE_DRIFT'});expect(fired).toBe(true);
   expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
  });
 it('refuses earlier-artifact drift during the final result readback',async()=>{
  const f=await fixture();let reads=0,fired=false;
  hooks.afterRead=(path,bytes,position)=>{if(path.endsWith('/facts.result.json')&&bytes>0&&position===0&&++reads===2){
   fired=true;const file=join(f.before,'d1-schema.raw.json'),raw=readFileSync(file);raw[0]^=1;writeFileSync(file,raw);
  }};
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_FILE_DRIFT'});expect(fired).toBe(true);
  expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
 });
 it.each(['in-place','replacement'] as const)('refuses %s drift after final descriptors open but before final readback',async kind=>{
  const f=await fixture();let boundaries=0,fired=false;
  hooks.afterFsync=path=>{if(path===f.before&&existsSync(join(f.before,'facts.result.json'))&&++boundaries===2){
   fired=true;const file=join(f.before,'d1-schema.raw.json'),bytes=readFileSync(file);
   if(kind==='in-place'){bytes[0]^=1;writeFileSync(file,bytes);}
   else{renameSync(file,file+'.original');writeFileSync(file,bytes,{mode:0o600});}
  }};
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_FILE_DRIFT'});expect(fired).toBe(true);
  expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
 });
 it('uses the same owner deadline throughout final readback',async()=>{
  const f=await fixture();let reads=0,fired=false;
  hooks.afterRead=(path,bytes,position)=>{if(path.endsWith('/facts.result.json')&&bytes>0&&position===0&&++reads===2){fired=true;f.setMono(10000);}};
  await expect(f.collect()).rejects.toHaveProperty('code');expect(fired).toBe(true);
  expect(f.owner.snapshot().terminal).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);
 });
 it('refuses a final fsync overrun even when a result file was written',async()=>{
  const f=await fixture();hooks.afterFsync=path=>{if(path.endsWith('/facts.result.json'))f.setMono(10000);};
  await expect(f.collect()).rejects.toHaveProperty('code');expect(existsSync(join(f.before,'facts.result.json'))).toBe(true);expect(existsSync(join(f.before,'facts.failure.json'))).toBe(true);expect(f.owner.snapshot().terminal).toBe(true);
 });
 it.each(['directory','symlink'] as const)('refuses a facts %s replacement during an exchange without redirecting evidence writes',async kind=>{
  let target='';const f=await fixture({send:async(_u,_i,normal)=>{renameSync(target,target+'.retained');if(kind==='directory')mkdirSync(target,{mode:0o700});else{mkdirSync(target+'.foreign',{mode:0o700});symlinkSync(target+'.foreign',target);}return normal();}});target=f.before;
  await expect(f.collect()).rejects.toMatchObject({code:'ACQUISITION_FACTS_DIRECTORY_DRIFT'});expect(readdirSync(target)).toEqual([]);expect(existsSync(join(target+'.retained','facts.intent.json'))).toBe(true);expect(f.owner.snapshot().terminal).toBe(true);expect(f.calls).toHaveLength(1);
 });
 it('refuses parent replacement without writing through the new parent',async()=>{
  let target='';const f=await fixture({send:async(_u,_i,normal)=>{const response=normal();renameSync(target,target+'.retained');roots.push(target+'.retained');mkdirSync(target,{mode:0o700});return response;}});target=f.parent;
  await expect(f.collect()).rejects.toHaveProperty('code');expect(readdirSync(target)).toEqual([]);expect(existsSync(join(target+'.retained','facts-before','facts.intent.json'))).toBe(true);expect(f.calls).toHaveLength(1);
 });
 it('never reuses an existing observation directory or treats its earlier result as standalone acceptance',async()=>{
  const f=await fixture(),a=await f.collect();await expect(f.collect()).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(2);expect(f.owner.snapshot().terminal).toBe(true);expect(a.standaloneAcceptance).toBe(false);
 });
});
