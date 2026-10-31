/**
 * Fixture-only acquisition protocol core. No credential selector, fetch, CLI,
 * live entry point, writer control, SQL query or signed-download adapter exists.
 * Raw replies, cursors, bookmarks, signed URLs and auth data stay private.
 * Unknown namespace prefixes are retained in their raw page and refused; this
 * is NOT a complete raw namespace backup when unclassified names are present.
 * A result is never standalone acceptance: any failure/partial/uncertainty
 * overrides it, including a deadline crossed during its final fsync.
 * Export shape: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
 * KV shape: https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/
 * In progress has no status; at_bookmark remains stable during the job. Export
 * service availability/maintenance and signed-origin approval remain LIVE gates.
 */
import {createHash} from 'node:crypto';
import {closeSync,constants,fsyncSync,mkdirSync,openSync,writeSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {collectLegacyAuth} from '../../src/auth-export';
import {normalizeAuthExport,prepareAuthMigration} from '../../src/auth-migration';
import {privatePath} from './protected-state';

// D1/KV identities are also present in the retained eight-GET production binding
// result a973640e… (2026-10-24 01:10 UTC). They are expectations, not fresh proof.
export const PROTECTED_ACQUISITION_SOURCE = Object.freeze({
 accountId:'ad5ec479b9a421faa2ed06c3d1c2b23a',
 d1Id:'8056b1a0-f858-4f89-a332-91f7f350eb7b',
 kvNamespaceId:'2d0152b0958c48fab4a98b3046e0c08e',
});
export const PROTECTED_ACQUISITION_LIMITS = Object.freeze({
 maxRequests:2080,wallMs:1_800_000,requestMs:15_000,minStartSpacingMs:334,
 responseBytes:262_144,kvPages:10,kvNames:1000,kvNamesPerPage:100,
 kvAggregateBytes:64*1024*1024,exportPolls:60,
});
type Limits = {[K in keyof typeof PROTECTED_ACQUISITION_LIMITS]:number};
type Source = typeof PROTECTED_ACQUISITION_SOURCE;
type Kind = 'kv-list-a'|'kv-value-a'|'export'|'kv-list-b'|'kv-value-b';
export interface AcquisitionFixtureRequest {
 readonly ordinal:number; readonly kind:Kind; readonly method:'GET'|'POST';
 readonly url:string; readonly body:string|null;
 readonly credentialScope:'management'; readonly responseBytes:number;
}
export interface AcquisitionFixtureIO {
 readonly fixtureOnly:true;
 /** Fulfil only after the whole bounded reply AND transport cleanup settle.
  * Abort must be observed by the injected adapter. If it ignores abort, the
  * core ends with ioSettled:false and NEVER continues; the caller must settle
  * that IO/process. The retained directory permanently refuses another run. */
 exchange(request:AcquisitionFixtureRequest,signal:AbortSignal):Promise<{status:number;body:Uint8Array}>;
}
export interface ProtectedAcquisitionFixtureOptions {
 mode:'fixture-only'; source:Source; captureDirectory:string; validUntil:number;
 io:AcquisitionFixtureIO;
 /** Smaller bounds and deterministic clocks are for offline fixtures. */
 limits?:Partial<Limits>;
 clock?:{monotonic:()=>number;wall:()=>number;sleep:(ms:number)=>Promise<void>};
}
export class ProtectedAcquisitionError extends Error {
 constructor(readonly code:string,readonly ioSettled=true){super(code);this.name='ProtectedAcquisitionError';}
}
const fail=(code:string):never=>{throw new ProtectedAcquisitionError(code);};
function requireFact(value:unknown,code:string):asserts value {if(!value)fail(code);}
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,unknown>=>{
 requireFact(value!==null&&typeof value==='object'&&!Array.isArray(value),'ACQUISITION_RESPONSE_SCHEMA');
 return value as Record<string,unknown>;
};
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 const encoded=JSON.stringify(value);requireFact(typeof encoded==='string','ACQUISITION_SOURCE');return encoded;
}
function json(bytes:Uint8Array):unknown {
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}
 catch{fail('ACQUISITION_RESPONSE_JSON');}
}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function exclusive(directory:string,name:string,bytes:Uint8Array){
 requireFact(/^[a-z0-9.-]+$/.test(name),'ACQUISITION_CAPTURE_NAME');
 const fd=openSync(resolve(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);requireFact(n>0,'ACQUISITION_DURABILITY');at+=n;}fsyncSync(fd);}finally{closeSync(fd);}
 syncDirectory(directory);return sha(bytes);
}
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
function limits(value:Partial<Limits>|undefined){
 const result={...PROTECTED_ACQUISITION_LIMITS,...value};
 for(const key of Object.keys(result) as (keyof Limits)[]){
  requireFact(Number.isSafeInteger(result[key])&&result[key]>0&&result[key]<=PROTECTED_ACQUISITION_LIMITS[key],'ACQUISITION_LIMITS');
 }
 // This is the partial collector's ceiling, NOT a capacity claim for facts,
 // identity/control observations, the SQL download or complete acquisition.
 requireFact(result.maxRequests<=2*(result.kvPages+result.kvNames)+result.exportPolls,'ACQUISITION_LIMITS');
 requireFact(result.kvNamesPerPage>=10,'ACQUISITION_LIMITS');
 return result;
}
const BASE='https://api.cloudflare.com/client/v4';
const KV=`/accounts/${PROTECTED_ACQUISITION_SOURCE.accountId}/storage/kv/namespaces/${PROTECTED_ACQUISITION_SOURCE.kvNamespaceId}`;
const EXPORT=`/accounts/${PROTECTED_ACQUISITION_SOURCE.accountId}/d1/database/${PROTECTED_ACQUISITION_SOURCE.d1Id}/export`;
const PREFIXES=['customer:','key:','keyhash:'];
type View={names:string[];entries:Map<string,string>;values:Map<string,{sha256:string;row:Record<string,unknown>}>;rawBytes:number;pages:number};

/** A successful fixture capture stops BEFORE downloading SQL or qualifying a
 * production source. Any failed/uncertain/persisted attempt is non-resumable. */
export async function captureProtectedAcquisitionFixture(options:ProtectedAcquisitionFixtureOptions){
 let directory:string|undefined,attempts=0,sent=0,ioSettled=true,exportPolls=0;
 try{
  requireFact(options.mode==='fixture-only'&&options.io.fixtureOnly===true,'ACQUISITION_FIXTURE_ONLY');
  requireFact(canonical(options.source)===canonical(PROTECTED_ACQUISITION_SOURCE),'ACQUISITION_SOURCE');
  const cap=limits(options.limits),validUntil=options.validUntil,exchange=options.io.exchange.bind(options.io);
  const suppliedClock=options.clock,clock={monotonic:suppliedClock?.monotonic??(()=>performance.now()),wall:suppliedClock?.wall??(()=>Date.now()),sleep:suppliedClock?.sleep??((ms:number)=>new Promise<void>(r=>setTimeout(r,ms)))};
  const started=clock.monotonic(),startedAt=clock.wall();let last=started-cap.minStartSpacingMs,observedMono=started,observedWall=startedAt;
  requireFact(Number.isFinite(started)&&Number.isFinite(startedAt)&&Number.isFinite(validUntil)&&validUntil>startedAt+cap.wallMs&&validUntil<=startedAt+86_400_000,'ACQUISITION_EXPIRY');
  const check=(requestEnd=Infinity)=>{
   const now=clock.monotonic(),wall=clock.wall();
   requireFact(Number.isFinite(now)&&now>=observedMono&&now-started<cap.wallMs&&now<requestEnd,'ACQUISITION_TIMEOUT');observedMono=now;
   requireFact(Number.isFinite(wall)&&wall>=observedWall&&wall<validUntil,'ACQUISITION_EXPIRY');observedWall=wall;
  };
  const requested=resolve(options.captureDirectory);
  await privatePath(dirname(requested),true);check();
  // mkdir is an exclusive claim. A changed output name requires a separately
  // reviewed caller; this core has no resume/restart or marker deletion path.
  mkdirSync(requested,{mode:0o700});directory=requested;syncDirectory(dirname(requested));
  await privatePath(directory,true);check();
  const save=(name:string,value:unknown)=>exclusive(directory!,name,bytes(value));
  const startSha256=save('capture.intent.json',{format:1,fixtureOnly:true,source:PROTECTED_ACQUISITION_SOURCE,limits:cap,startedAt,validUntil,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false});check();
  const receipts:{intentSha256:string;rawSha256:string;ackSha256:string}[]=[];
  async function request<T>(kind:Kind,path:string,body:string|null,parse:(body:Uint8Array)=>T):Promise<T>{
   check();requireFact(ioSettled,'ACQUISITION_UNSETTLED');
   while(clock.monotonic()-last<cap.minStartSpacingMs){await clock.sleep(cap.minStartSpacingMs-(clock.monotonic()-last));check();}
   requireFact(attempts<cap.maxRequests,'ACQUISITION_REQUEST_BOUND');
   const end=Math.min(started+cap.wallMs,clock.monotonic()+cap.requestMs),ordinal=++attempts;
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   const stem=`request-${String(ordinal).padStart(4,'0')}`;
   const descriptor:AcquisitionFixtureRequest=Object.freeze({ordinal,kind,method:kind==='export'?'POST':'GET',url:BASE+path,body,credentialScope:'management',responseBytes:cap.responseBytes});
   try{
    const intentSha256=save(stem+'.intent.json',{format:1,request:descriptor,previousSha256:receipts.at(-1)?.ackSha256??startSha256});check(end);
    const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ProtectedAcquisitionError('ACQUISITION_TIMEOUT',ioSettled));},Math.min(cap.requestMs,Math.max(1,end-clock.monotonic())));});
    let dispatched=false;
    const pending=Promise.resolve().then(()=>{check(end);ioSettled=false;dispatched=true;last=clock.monotonic();sent++;return exchange(descriptor,controller.signal);});
    // Always observe late fulfilment/rejection. No new request follows an error,
    // even if the injected exchange ignores abort and remains unsettled.
    const settled=pending.then(value=>{ioSettled=true;return value;},error=>{ioSettled=true;throw !dispatched&&error instanceof ProtectedAcquisitionError?error:new ProtectedAcquisitionError('ACQUISITION_IO');});
    const reply=await Promise.race([settled,expired]);check(end);
    const bodyWithinCap=reply.body instanceof Uint8Array&&reply.body.byteLength<=cap.responseBytes;
    const rawSha256=bodyWithinCap?exclusive(directory!,stem+'.raw',reply.body):null;check(end);
    const validStatus=Number.isInteger(reply.status)&&reply.status>=100&&reply.status<=599;
    // This acknowledges the private transport capture, not domain acceptance.
    // Keep actual HTTP status even if HTTP/schema validation fails next.
    const ackSha256=save(stem+'.ack.json',{format:1,kind:'transport-observation',intentSha256,rawSha256,status:validStatus?reply.status:null,invalidStatus:!validStatus,bytes:reply.body instanceof Uint8Array?reply.body.byteLength:null,bodyWithinCap});check(end);
    requireFact(bodyWithinCap&&rawSha256!==null,'ACQUISITION_RESPONSE_BOUND');
    requireFact(validStatus,'ACQUISITION_RESPONSE_SCHEMA');
    requireFact(reply.status===200,'ACQUISITION_HTTP');
    const result=parse(reply.body);check(end);
    receipts.push({intentSha256,rawSha256,ackSha256});return result;
   }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
  }
  async function view(which:'a'|'b'):Promise<View>{
   const result:View={names:[],entries:new Map(),values:new Map(),rawBytes:0,pages:0};let cursor='';const cursors=new Set<string>();
   do{
    requireFact(result.pages<cap.kvPages,'ACQUISITION_KV_PAGE_BOUND');
    const query=new URLSearchParams({limit:String(cap.kvNamesPerPage)});if(cursor)query.set('cursor',cursor);
    cursor=await request(`kv-list-${which}`,KV+'/keys?'+query,null,raw=>{
     result.rawBytes+=raw.length;requireFact(result.rawBytes<=cap.kvAggregateBytes,'ACQUISITION_KV_BYTE_BOUND');
     const envelope=object(json(raw)),info=envelope['result_info']===undefined?{}:object(envelope['result_info']),rows=envelope['result'];
     requireFact(envelope['success']===true&&Array.isArray(rows)&&rows.length<=cap.kvNamesPerPage&&(info['cursor']===undefined||typeof info['cursor']==='string'&&info['cursor'].length<=4096),'ACQUISITION_RESPONSE_SCHEMA');
     for(const value of rows){const entry=object(value),name=entry['name'];
      requireFact(typeof name==='string'&&Buffer.byteLength(name,'utf8')<=512&&PREFIXES.some(prefix=>name.startsWith(prefix)&&name.length>prefix.length),'ACQUISITION_KV_NAME');
      requireFact(!result.entries.has(name),'ACQUISITION_KV_DUPLICATE');
      if(entry['expiration']!==undefined)requireFact(Number.isSafeInteger(entry['expiration'])&&Number(entry['expiration'])*1000>clock.wall(),'ACQUISITION_KV_EXPIRY');
      result.entries.set(name,canonical(entry));requireFact(result.entries.size<=cap.kvNames,'ACQUISITION_KV_NAME_BOUND');
     }
     const next=info['cursor'] as string|undefined;if(next){requireFact(!cursors.has(next),'ACQUISITION_KV_CURSOR');cursors.add(next);}return next??'';
    });result.pages++;
   }while(cursor);
   result.names=[...result.entries.keys()].sort();
   for(const name of result.names){
    await request(`kv-value-${which}`,KV+'/values/'+encodeURIComponent(name),null,raw=>{
     result.rawBytes+=raw.length;requireFact(result.rawBytes<=cap.kvAggregateBytes,'ACQUISITION_KV_BYTE_BOUND');
     result.values.set(name,{sha256:sha(raw),row:object(json(raw))});
    });
   }
   return result;
  }
  const first=await view('a');let bookmark:string|undefined,signed:string|undefined;
  while(!signed){
   requireFact(exportPolls<cap.exportPolls,'ACQUISITION_EXPORT_BOUND');exportPolls++;
   const body=JSON.stringify({output_format:'polling',dump_options:{no_schema:false,no_data:false,tables:[]},...(bookmark===undefined?{}:{current_bookmark:bookmark})});
   const next=await request('export',EXPORT,body,raw=>{
    const envelope=object(json(raw));requireFact(envelope['success']===true,'ACQUISITION_EXPORT');
    const value=object(envelope['result']);
    requireFact((value['success']===undefined||value['success']===true)&&(value['type']===undefined||value['type']==='export')&&(value['messages']===undefined||Array.isArray(value['messages'])&&value['messages'].every(m=>typeof m==='string')),'ACQUISITION_EXPORT');
    requireFact(value['status']===undefined||value['status']==='complete'||value['status']==='error','ACQUISITION_EXPORT_STATUS');
    if(value['at_bookmark']!==undefined)requireFact(typeof value['at_bookmark']==='string'&&value['at_bookmark'].length>0&&value['at_bookmark'].length<=4096&&(bookmark===undefined||value['at_bookmark']===bookmark),'ACQUISITION_EXPORT_BOOKMARK');
    requireFact(value['status']!=='error','ACQUISITION_EXPORT');
    if(value['status']==='complete'){
     const url=object(value['result'])['signed_url'];requireFact(typeof url==='string'&&url.length<=16384,'ACQUISITION_EXPORT_URL');
     const parsed=(()=>{try{return new URL(url);}catch{return fail('ACQUISITION_EXPORT_URL');}})();
     requireFact(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.hash&&(!parsed.port||parsed.port==='443'),'ACQUISITION_EXPORT_URL');
     return {signed:url};
    }
    requireFact(typeof value['at_bookmark']==='string'&&value['at_bookmark'].length>0&&value['at_bookmark'].length<=4096,'ACQUISITION_EXPORT_BOOKMARK');
    return {bookmark:value['at_bookmark']};
   });
   if('signed' in next)signed=next.signed;else bookmark=next.bookmark;
  }
  // No origin is declared trustworthy and NO request is made to the signed URL.
  save('signed-export-descriptor.private.json',{format:1,url:signed,downloadApproved:false,downloadPerformed:false});check();
  const second=await view('b');check();
  requireFact(canonical(first.names)===canonical(second.names),'ACQUISITION_KV_DRIFT');
  for(const name of first.names)requireFact(first.entries.get(name)===second.entries.get(name)&&first.values.get(name)!.sha256===second.values.get(name)!.sha256,'ACQUISITION_KV_DRIFT');
  const normalized=await(async()=>{try{
   const value=normalizeAuthExport(await collectLegacyAuth({list:async prefix=>first.names.filter(name=>name.startsWith(prefix)),get:async name=>first.values.get(name)!.row}));
   prepareAuthMigration(value);return value;
  }catch{return fail('ACQUISITION_AUTH_CONTRACT');}})();
  check();save('legacy-auth.private.json',normalized);check();
  const summary={format:1,fixtureOnly:true,fixtureCaptureComplete:true,standaloneAcceptance:false,acceptanceRequiresSuccessfulSettledOwner:true,requests:sent,kvNames:first.names.length,kvPages:[first.pages,second.pages],exportPolls,downloadPending:true,downloadRequests:0,sqlFactsCaptured:false,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false,automaticRetry:false,automaticResume:false} as const;
  save('capture.result.json',{...summary,receipts});check();return summary;
 }catch(error){
  const code=error instanceof ProtectedAcquisitionError?error.code:'ACQUISITION_LOCAL';
  if(directory){try{exclusive(directory,'capture.failure.json',bytes({format:1,code,attempts,sent,exportPolls,ioSettled,automaticRetry:false,automaticResume:false,preserved:true,productionAcquisitionQualified:false}));}catch{/* Retain the exclusive claim and every partial; never restart. */}}
  throw new ProtectedAcquisitionError(code,ioSettled);
 }
}
