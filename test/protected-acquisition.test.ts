import {afterEach,describe,expect,it,vi} from 'vitest';
import {chmodSync,existsSync,fstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureProtectedAcquisitionFixture,PROTECTED_ACQUISITION_SOURCE,ProtectedAcquisitionError,type AcquisitionFixtureRequest,type ProtectedAcquisitionFixtureOptions} from '../scripts/lib/protected-acquisition';

const hooks=vi.hoisted(()=>({afterFsync:undefined as ((fd:number)=>void)|undefined}));
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return {...fs,fsyncSync:(fd:number)=>{fs.fsyncSync(fd);hooks.afterFsync?.(fd);}};});

const privateRoots:string[]=[];
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const hash='a'.repeat(64);
const entries:Record<string,Record<string,unknown>>={
 'customer:fixture':{id:'fixture',plan:'free',fuseLimit:1000,unknownRawField:'PRIVATE RAW FIELD'},
 'key:fixture-key':{id:'fixture-key',customerId:'fixture',kind:'server',secretHash:hash,disabled:true},
 ['keyhash:'+hash]:{id:'fixture-key',customerId:'fixture',kind:'server',secretHash:hash},
};
const signed='https://fixture-export.invalid/private.sql?signature=PRIVATE_SIGNED_QUERY';
function fixture(overrides?:{limits?:ProtectedAcquisitionFixtureOptions['limits'];exchange?:(r:AcquisitionFixtureRequest,s:AbortSignal,base:()=>Promise<{status:number;body:Uint8Array}>)=>Promise<{status:number;body:Uint8Array}>;multiPage?:boolean;noKeys?:boolean}){
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'civicsignal-acquisition-test-')));chmodSync(parent,0o700);privateRoots.push(parent);
 const directory=join(parent,'capture'),calls:AcquisitionFixtureRequest[]=[],signals:AbortSignal[]=[];
 let mono=0,wall=Date.UTC(2026,9,24),polls=0;const pages={a:0,b:0};
 const values=overrides?.noKeys?{}:entries;
 const options:ProtectedAcquisitionFixtureOptions={
  mode:'fixture-only',source:PROTECTED_ACQUISITION_SOURCE,captureDirectory:directory,validUntil:wall+60_000,
  limits:{maxRequests:30,wallMs:10_000,requestMs:1000,kvPages:3,kvNames:10,exportPolls:10,...overrides?.limits},
  clock:{monotonic:()=>mono,wall:()=>wall,sleep:async ms=>{mono+=ms;}},
  io:{fixtureOnly:true,async exchange(request,signal){calls.push(request);signals.push(signal);
   const base=async()=>{
    if(request.kind.startsWith('kv-list')){
     const which=request.kind.endsWith('a')?'a':'b',page=pages[which]++,names=Object.keys(values).sort();
     const selected=overrides?.multiPage?(page===0?names.slice(0,1):names.slice(1)):names;
     return {status:200,body:encode({success:true,result:selected.map(name=>({name,metadata:{fixture:true}})),result_info:{cursor:overrides?.multiPage&&page===0?'private-cursor':''}})};
    }
    if(request.kind.startsWith('kv-value')){
     const name=decodeURIComponent(new URL(request.url).pathname.split('/values/')[1]!);
     return {status:200,body:encode(values[name])};
    }
    polls++;
    return {status:200,body:encode({success:true,result:polls===1?{success:true,messages:['PRIVATE EXPORT MESSAGE'],at_bookmark:'private-bookmark-1'}:{success:true,status:'complete',messages:[],result:{signed_url:signed}}})};
   };
   return overrides?.exchange?overrides.exchange(request,signal,base):base();
  }},
 };
 return {options,directory,parent,calls,signals,setMono:(n:number)=>{mono=n;},getMono:()=>mono,setWall:(n:number)=>{wall=n;},getWall:()=>wall};
}
afterEach(()=>{hooks.afterFsync=undefined;vi.useRealTimers();vi.restoreAllMocks();for(const p of privateRoots.splice(0))rmSync(p,{recursive:true,force:true});});
async function refusal(f:ReturnType<typeof fixture>,code:string){
 await expect(captureProtectedAcquisitionFixture(f.options)).rejects.toMatchObject({code});
 if(existsSync(f.directory)){
  const count=f.calls.length;
  await expect(captureProtectedAcquisitionFixture(f.options)).rejects.toBeInstanceOf(ProtectedAcquisitionError);
  expect(f.calls).toHaveLength(count);
 }
}
describe('fixture-only fixed production acquisition capture core',()=>{
 it('captures two complete paginated views and exact export continuation; retains private raw bytes and revocation',async()=>{
  const f=fixture({multiPage:true});const result=await captureProtectedAcquisitionFixture(f.options);
  expect(result).toMatchObject({fixtureOnly:true,fixtureCaptureComplete:true,requests:12,kvNames:3,kvPages:[2,2],exportPolls:2,downloadRequests:0,downloadPending:true,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false});
  const exports=f.calls.filter(r=>r.kind==='export').map(r=>JSON.parse(r.body!));
  expect(exports).toEqual([
   {output_format:'polling',dump_options:{no_schema:false,no_data:false,tables:[]}},
   {output_format:'polling',dump_options:{no_schema:false,no_data:false,tables:[]},current_bookmark:'private-bookmark-1'},
  ]);
  const lists=f.calls.filter(r=>r.kind.startsWith('kv-list'));
  expect(lists.map(r=>new URL(r.url).searchParams.get('cursor'))).toEqual([null,'private-cursor',null,'private-cursor']);
  const raw=readdirSync(f.directory).filter(n=>n.endsWith('.raw'));
  expect(raw).toHaveLength(12);expect(raw.some(n=>readFileSync(join(f.directory,n),'utf8').includes('PRIVATE RAW FIELD'))).toBe(true);
  const normalized=JSON.parse(readFileSync(join(f.directory,'legacy-auth.private.json'),'utf8'));
  expect(normalized.keys).toHaveLength(1);expect(normalized.keys[0].disabled).toBe(true);expect(normalized.customers[0]).not.toHaveProperty('unknownRawField');
  expect(JSON.parse(readFileSync(join(f.directory,'signed-export-descriptor.private.json'),'utf8'))).toEqual({format:1,url:signed,downloadApproved:false,downloadPerformed:false});
  for(const name of readdirSync(f.directory))expect(statSync(join(f.directory,name)).mode&0o777).toBe(0o600);
  expect(statSync(f.directory).mode&0o777).toBe(0o700);
  expect(JSON.stringify(result)).not.toMatch(/private|signature|secretHash|a{64}/i);
 });
 it('admits an actually empty inventory only after both complete views',async()=>{
  const f=fixture({noKeys:true});const r=await captureProtectedAcquisitionFixture(f.options);expect(r.requests).toBe(4);expect(r.kvNames).toBe(0);
 });
 it.each([{},undefined])('accepts documented optional terminal cursor metadata (%j)',async resultInfo=>{
  const f=fixture({noKeys:true,exchange:async(r,_s,base)=>r.kind.startsWith('kv-list')?{status:200,body:encode({success:true,result:[],...(resultInfo===undefined?{}:{result_info:resultInfo})})}:base()});
  expect((await captureProtectedAcquisitionFixture(f.options)).kvPages).toEqual([1,1]);
 });
 it('does not put credentials or signed-download URLs into the injected management protocol',async()=>{
  const f=fixture();await captureProtectedAcquisitionFixture(f.options);
  for(const request of f.calls){expect(new URL(request.url).origin).toBe('https://api.cloudflare.com');expect(request.credentialScope).toBe('management');expect(request).not.toHaveProperty('headers');expect(request.url).not.toContain('signature=');}
  expect(f.calls.filter(r=>r.method==='POST').every(r=>new URL(r.url).pathname.endsWith('/export'))).toBe(true);
 });
 it.each(['accountId','d1Id','kvNamespaceId'] as const)('refuses changed fixed %s before capture or IO',async field=>{
  const f=fixture();f.options.source={...PROTECTED_ACQUISITION_SOURCE,[field]:'wrong'} as typeof PROTECTED_ACQUISITION_SOURCE;
  await refusal(f,'ACQUISITION_SOURCE');expect(f.calls).toHaveLength(0);expect(existsSync(f.directory)).toBe(false);
 });
 it('has no live mode',async()=>{
  const f=fixture();Object.assign(f.options,{mode:'live'});await refusal(f,'ACQUISITION_FIXTURE_ONLY');expect(f.calls).toHaveLength(0);
 });
 it('refuses a nonprivate parent and aliased parent before IO',async()=>{
  const f=fixture();chmodSync(f.parent,0o755);await refusal(f,'ACQUISITION_LOCAL');expect(f.calls).toHaveLength(0);
  chmodSync(f.parent,0o700);const alias=join(f.parent,'alias');symlinkSync(f.parent,alias);f.options.captureDirectory=join(alias,'another');await expect(captureProtectedAcquisitionFixture(f.options)).rejects.toMatchObject({code:'ACQUISITION_LOCAL'});expect(f.calls).toHaveLength(0);
 });
 it('refuses incomplete pagination when a cursor repeats, preserving raw replies',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>r.kind==='kv-list-a'?{status:200,body:encode({success:true,result:[],result_info:{cursor:'repeat'}})}:base()});
  await refusal(f,'ACQUISITION_KV_CURSOR');expect(f.calls).toHaveLength(2);expect(readdirSync(f.directory).filter(n=>n.endsWith('.raw'))).toHaveLength(2);
 });
 it('refuses duplicate or unrelated namespace entries instead of silently skipping them',async()=>{
  for(const names of [['customer:fixture','customer:fixture'],['unclassified:fixture']]){
   const f=fixture({exchange:async()=>({status:200,body:encode({success:true,result:names.map(name=>({name})),result_info:{cursor:''}})})});
   await refusal(f,names.length===2?'ACQUISITION_KV_DUPLICATE':'ACQUISITION_KV_NAME');expect(f.calls).toHaveLength(1);
  }
 });
 it('refuses same-count value changes across complete views',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{const b=await base();if(r.kind==='kv-value-b'&&r.url.includes('customer'))return {status:200,body:encode({...entries['customer:fixture'],fuseLimit:1001})};return b;}});
  await refusal(f,'ACQUISITION_KV_DRIFT');expect(f.calls.filter(r=>r.kind==='kv-value-b')).toHaveLength(3);expect(existsSync(join(f.directory,'legacy-auth.private.json'))).toBe(false);
 });
 it('refuses inventory metadata drift despite equal names and values',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{const b=await base();if(r.kind==='kv-list-b'){const v=JSON.parse(Buffer.from(b.body).toString());v.result[0].metadata.fixture=false;return {status:200,body:encode(v)};}return b;}});
  await refusal(f,'ACQUISITION_KV_DRIFT');
 });
 it('uses the authoritative collector contract, rejecting a display-only server key',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{const b=await base();if(r.kind.startsWith('kv-list')){const v=JSON.parse(Buffer.from(b.body).toString());v.result=v.result.filter((x:{name:string})=>!x.name.startsWith('keyhash:'));return {status:200,body:encode(v)};}return b;}});
  await refusal(f,'ACQUISITION_AUTH_CONTRACT');expect(existsSync(join(f.directory,'legacy-auth.private.json'))).toBe(false);
 });
 it('refuses expired admission before any capture and expiry during IO before another exchange',async()=>{
  const f=fixture();f.options.validUntil=f.getWall();await refusal(f,'ACQUISITION_EXPIRY');expect(f.calls).toHaveLength(0);
  const g=fixture({exchange:async(_r,_s,base)=>{const b=await base();g.setWall(g.options.validUntil);return b;}});await refusal(g,'ACQUISITION_EXPIRY');expect(g.calls).toHaveLength(1);
 });
 it('refuses expired KV metadata',async()=>{
  const f=fixture({exchange:async()=>({status:200,body:encode({success:true,result:[{name:'customer:fixture',expiration:1}],result_info:{cursor:''}})})});await refusal(f,'ACQUISITION_KV_EXPIRY');
 });
 it.each(['request','pages','names','bytes','export'] as const)('enforces enumerated %s exhaustion without restart',async bound=>{
  const f=fixture({limits:bound==='request'?{maxRequests:1}:bound==='pages'?{kvPages:1,maxRequests:20}:bound==='names'?{kvNames:1,maxRequests:18}:bound==='bytes'?{kvAggregateBytes:1}: {exportPolls:1,maxRequests:20},multiPage:bound==='pages'});
  await refusal(f,({request:'ACQUISITION_REQUEST_BOUND',pages:'ACQUISITION_KV_PAGE_BOUND',names:'ACQUISITION_KV_NAME_BOUND',bytes:'ACQUISITION_KV_BYTE_BOUND',export:'ACQUISITION_EXPORT_BOUND'})[bound]);
 });
 it('rejects raised bounds before IO',async()=>{
  const f=fixture({limits:{maxRequests:2081}});await refusal(f,'ACQUISITION_LIMITS');expect(f.calls).toHaveLength(0);
 });
 it('retains a lost export start and NEVER starts another export or view B',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{if(r.kind==='export')throw Error('PRIVATE provider signed URL or key');return base();}});
  await refusal(f,'ACQUISITION_IO');expect(f.calls.filter(r=>r.kind==='export')).toHaveLength(1);expect(f.calls.some(r=>r.kind.endsWith('-b'))).toBe(false);
  expect(readFileSync(join(f.directory,'capture.failure.json'),'utf8')).not.toContain('PRIVATE');
 });
 it('refuses missing continuation bookmarks without starting a fresh export',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>r.kind==='export'?{status:200,body:encode({success:true,result:{success:true,messages:[]}})}:base()});
  await refusal(f,'ACQUISITION_EXPORT_BOOKMARK');expect(f.calls.filter(r=>r.kind==='export')).toHaveLength(1);
 });
 // Primary schema: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
 it('accepts optional in-progress fields and a stable bookmark across exact continued requests',async()=>{
  let polls=0;const f=fixture({exchange:async(r,_s,base)=>{
   if(r.kind!=='export')return base();polls++;
   return {status:200,body:encode({success:true,result:polls<3?{at_bookmark:'stable-private-bookmark'}:{type:'export',status:'complete',result:{signed_url:signed}}})};
  }});await captureProtectedAcquisitionFixture(f.options);
  expect(f.calls.filter(r=>r.kind==='export').map(r=>JSON.parse(r.body!).current_bookmark)).toEqual([undefined,'stable-private-bookmark','stable-private-bookmark']);
 });
 it.each([false,true])('refuses a changed bookmark on %s completion before another request',async complete=>{
  let polls=0;const f=fixture({exchange:async(r,_s,base)=>{
   if(r.kind!=='export')return base();polls++;
   return {status:200,body:encode({success:true,result:polls===1?{at_bookmark:'original-private-bookmark'}:{at_bookmark:'different-private-bookmark',...(complete?{status:'complete',result:{signed_url:signed}}:{})}})};
  }});await refusal(f,'ACQUISITION_EXPORT_BOOKMARK');
  expect(f.calls.filter(r=>r.kind==='export')).toHaveLength(2);expect(f.calls.some(r=>r.kind.endsWith('-b'))).toBe(false);
  expect(readFileSync(join(f.directory,'request-0006.raw'),'utf8')).toContain('different-private-bookmark');
 });
 it.each([{status:'active',at_bookmark:'private'},{status:'unexpected',at_bookmark:'private'},{type:'other',at_bookmark:'private'},{success:false,at_bookmark:'private'},{messages:'private',at_bookmark:'private'}])('rejects undocumented explicit export fields without another poll',async result=>{
  const f=fixture({exchange:async(r,_s,base)=>r.kind==='export'?{status:200,body:encode({success:true,result})}:base()});
  await refusal(f,'status' in result?'ACQUISITION_EXPORT_STATUS':'ACQUISITION_EXPORT');expect(f.calls.filter(r=>r.kind==='export')).toHaveLength(1);
 });
 it.each(['http://fixture.invalid/a','https://user:pass@fixture.invalid/a','https://fixture.invalid/a#secret'])('refuses unsafe signed descriptor %s without download',async url=>{
  const f=fixture({exchange:async(r,_s,base)=>r.kind==='export'?{status:200,body:encode({success:true,result:{success:true,status:'complete',messages:[],result:{signed_url:url}}})}:base()});await refusal(f,'ACQUISITION_EXPORT_URL');
 });
 it('retains bounded malformed/non-200 replies and stops',async()=>{
  for(const reply of [{status:200,body:Buffer.from('{PRIVATE')},{status:503,body:Buffer.from('PRIVATE body')}]){
   const f=fixture({exchange:async()=>reply});await refusal(f,reply.status===200?'ACQUISITION_RESPONSE_JSON':'ACQUISITION_HTTP');expect(f.calls).toHaveLength(1);expect(readFileSync(join(f.directory,'request-0001.raw'))).toEqual(reply.body);
   expect(JSON.parse(readFileSync(join(f.directory,'request-0001.ack.json'),'utf8'))).toMatchObject({kind:'transport-observation',status:reply.status,invalidStatus:false,bytes:reply.body.length});
   expect(existsSync(join(f.directory,'capture.result.json'))).toBe(false);
  }
 });
 it('rejects over-cap reply before persisting the bytes',async()=>{
  const f=fixture({limits:{responseBytes:8},exchange:async()=>({status:200,body:Buffer.alloc(9)})});await refusal(f,'ACQUISITION_RESPONSE_BOUND');expect(existsSync(join(f.directory,'request-0001.raw'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.directory,'request-0001.ack.json'),'utf8'))).toMatchObject({status:200,rawSha256:null,bodyWithinCap:false,bytes:9});
 });
 it('retains an explicit invalid-status fact without persisting the invalid status value',async()=>{
  const f=fixture({exchange:async()=>({status:NaN,body:Buffer.from('private raw')})});await refusal(f,'ACQUISITION_RESPONSE_SCHEMA');expect(f.calls).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.directory,'request-0001.ack.json'),'utf8'))).toMatchObject({kind:'transport-observation',status:null,invalidStatus:true,bodyWithinCap:true});
 });
 it('checks monotonic deadline after synchronous exchange work, before accepting a reply',async()=>{
  const f=fixture({exchange:async(_r,_s,base)=>{const b=await base();f.setMono(f.getMono()+1001);return b;}});await refusal(f,'ACQUISITION_TIMEOUT');expect(f.calls).toHaveLength(1);
 });
 it('keeps attempts separate from dispatch when the final pre-wire microtask crosses its deadline',async()=>{
  const f=fixture();let admitted=false,ticks=0;const path=join(f.directory,'request-0001.intent.json');
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)admitted=true;};
  f.options.clock!.monotonic=()=>admitted?(++ticks>=3?1001:0):0;
  await refusal(f,'ACQUISITION_TIMEOUT');expect(f.calls).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(f.directory,'capture.failure.json'),'utf8'))).toMatchObject({attempts:1,sent:0,ioSettled:true});
 });
 it('preserves pre-wire expiry rather than relabeling it as a dispatched IO failure',async()=>{
  const f=fixture();let admitted=false,ticks=0;const wall=f.getWall(),path=join(f.directory,'request-0001.intent.json');
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)admitted=true;};
  f.options.clock!.wall=()=>admitted&&++ticks>=2?f.options.validUntil:wall;
  await refusal(f,'ACQUISITION_EXPIRY');expect(f.calls).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(f.directory,'capture.failure.json'),'utf8'))).toMatchObject({attempts:1,sent:0});
 });
 it('snapshots the admitted expiry so IO cannot extend it during capture',async()=>{
  const f=fixture({exchange:async(_r,_s,base)=>{const b=await base(),expired=f.options.validUntil;f.options.validUntil+=60_000;f.setWall(expired);return b;}});
  await refusal(f,'ACQUISITION_EXPIRY');expect(f.calls).toHaveLength(1);
 });
 it('makes failure override a result whose fsync succeeded before the final deadline check',async()=>{
  const f=fixture(),path=join(f.directory,'capture.result.json');let injected=false;
  hooks.afterFsync=fd=>{if(!injected&&existsSync(path)&&fstatSync(fd).ino===statSync(path).ino){injected=true;f.setMono(10_000);}};
  await refusal(f,'ACQUISITION_TIMEOUT');expect(injected).toBe(true);
  expect(JSON.parse(readFileSync(path,'utf8'))).toMatchObject({standaloneAcceptance:false,acceptanceRequiresSuccessfulSettledOwner:true});
  expect(JSON.parse(readFileSync(join(f.directory,'capture.failure.json'),'utf8'))).toMatchObject({code:'ACQUISITION_TIMEOUT',ioSettled:true});
 });
 it('does not accept terminal fsync failure even when result bytes remain present',async()=>{
  const f=fixture(),path=join(f.directory,'capture.result.json');let injected=false;
  hooks.afterFsync=fd=>{if(!injected&&existsSync(path)&&fstatSync(fd).ino===statSync(path).ino){injected=true;throw Error('PRIVATE persistence error');}};
  await refusal(f,'ACQUISITION_LOCAL');expect(injected).toBe(true);expect(existsSync(path)).toBe(true);expect(existsSync(join(f.directory,'capture.failure.json'))).toBe(true);
 });
 it('aborts ignored IO and records unsettled uncertainty; no continuation can overlap it',async()=>{
  vi.useFakeTimers();const f=fixture({exchange:async()=>new Promise(()=>{})});
  const outcome=captureProtectedAcquisitionFixture(f.options).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(1000);expect((await outcome).error).toMatchObject({code:'ACQUISITION_TIMEOUT',ioSettled:false});
  expect(f.signals[0].aborted).toBe(true);expect(f.calls).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.directory,'capture.failure.json'),'utf8')).ioSettled).toBe(false);
  await expect(captureProtectedAcquisitionFixture(f.options)).rejects.toBeInstanceOf(ProtectedAcquisitionError);expect(f.calls).toHaveLength(1);
 });
 it('retains late ignored-abort fulfilment without a second send or late raw acknowledgement',async()=>{
  vi.useFakeTimers();let finish!:(reply:{status:number;body:Uint8Array})=>void;
  const f=fixture({exchange:async()=>new Promise(r=>{finish=r;})});const outcome=captureProtectedAcquisitionFixture(f.options).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(1000);expect((await outcome).error).toMatchObject({ioSettled:false});
  finish({status:200,body:encode({success:true,result:[],result_info:{cursor:''}})});await Promise.resolve();await Promise.resolve();
  expect(f.calls).toHaveLength(1);expect(existsSync(join(f.directory,'request-0001.raw'))).toBe(false);
 });
 it('preserves terminal persistence failure and refuses reuse instead of silently accepting',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{const b=await base();if(r.kind==='kv-value-b'&&!existsSync(join(f.directory,'capture.result.json')))writeFileSync(join(f.directory,'capture.result.json'),'retained conflicting terminal',{mode:0o600});return b;}});
  await refusal(f,'ACQUISITION_LOCAL');expect(readFileSync(join(f.directory,'capture.result.json'),'utf8')).toBe('retained conflicting terminal');expect(existsSync(join(f.directory,'capture.failure.json'))).toBe(true);
 });
 it('persists intent before IO; a request ack failure ends the sequence',async()=>{
  const f=fixture({exchange:async(r,_s,base)=>{expect(existsSync(join(f.directory,`request-${String(r.ordinal).padStart(4,'0')}.intent.json`))).toBe(true);writeFileSync(join(f.directory,'request-0001.ack.json'),'existing',{mode:0o600});return base();}});
  await refusal(f,'ACQUISITION_LOCAL');expect(f.calls).toHaveLength(1);expect(existsSync(join(f.directory,'request-0001.raw'))).toBe(true);
 });
});
