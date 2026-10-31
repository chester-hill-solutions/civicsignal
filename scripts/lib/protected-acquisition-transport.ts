/** Fixture-only acquisition transport. No default fetch, credential discovery, CLI,
 * production mode or writer controls. The core retains its KV/export algorithm.
 * This owner bounds all of its management/download exchanges together; future
 * fixed facts/control adapters must use the same owner rather than reset it.
 * A successful transport receipt is never provider, freeze or acquisition proof. */
import {createHash} from 'node:crypto';
import {closeSync,constants,fsyncSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,writeSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {PROTECTED_ACQUISITION_SOURCE,type AcquisitionFixtureRequest} from './protected-acquisition';
import {privatePath} from './protected-state';

export class ProtectedAcquisitionTransportError extends Error {
  constructor(readonly code:string,readonly ioSettled=true){super(code);this.name='ProtectedAcquisitionTransportError';}
}
const safeCodes=new Set([
  'AGGREGATE_BOUND','BODY','CANCELLED','CONCURRENT','CREDENTIAL','DESTINATION',
  'DIRECTORY_DRIFT','DOWNLOAD','DURABILITY','ENDPOINT','EXPIRY','FIXTURE_ONLY',
  'HTTP','INPUT','LIMITS','LOCAL_OR_IO','ORIGIN','OUTPUT_DRIFT','OUTPUT_HASH_MISMATCH','REQUEST',
  'REQUEST_BOUND','RESPONSE','RESPONSE_BOUND','TERMINAL','TIMEOUT',
].map(code=>'ACQUISITION_TRANSPORT_'+code));
function safeCode(error:unknown,fallback='ACQUISITION_TRANSPORT_LOCAL_OR_IO'){
  return error instanceof ProtectedAcquisitionTransportError&&safeCodes.has(error.code)?error.code:fallback;
}
const fail=(code:string):never=>{throw new ProtectedAcquisitionTransportError(code);};
function demand(value:unknown,code:string):asserts value {if(!value)fail(code);}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const flags=Object.freeze({fixtureOnly:true,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false,standaloneAcceptance:false});
const BASE='https://api.cloudflare.com';
const prefix=`/client/v4/accounts/${PROTECTED_ACQUISITION_SOURCE.accountId}`;
const KV=`${prefix}/storage/kv/namespaces/${PROTECTED_ACQUISITION_SOURCE.kvNamespaceId}`;
const EXPORT=`${prefix}/d1/database/${PROTECTED_ACQUISITION_SOURCE.d1Id}/export`;
const keys=['customer:','key:','keyhash:'];

export interface AcquisitionTransportLimits {
  maxRequests:number;
  wallMs:number;
  managementMs:number;
  downloadMs:number;
  responseBytes:number;
  downloadBytes:number;
  aggregateResponseBytes:number;
  minStartSpacingMs:number;
}
export interface SyntheticAcquisitionCredential {
  fixtureOnly:true;
  value:string;
  expiresAt:number;
}
export type AcquisitionSendInit=RequestInit&{credentials:'omit';redirect:'manual';headers:Readonly<Record<string,string>>};
export interface AcquisitionTransportOptions {
  fixtureOnly:true;
  /** New private directory outside the repository. Reuse is always refused. */
  journalDirectory:string;
  validUntil:number;
  /** Exact, separately pinned fixture origin; no wildcard or URL-derived default. */
  signedDownloadOrigin:string;
  limits:AcquisitionTransportLimits;
  syntheticCredential:(signal:AbortSignal)=>SyntheticAcquisitionCredential|Promise<SyntheticAcquisitionCredential>;
  /** Required injection. Tests supply synthetic Responses; no network default. */
  send:(url:string,init:AcquisitionSendInit)=>Promise<Response>;
  clock?:{monotonic:()=>number;wall:()=>number;sleep:(ms:number)=>Promise<void>};
}
type StreamReader=Pick<ReadableStreamDefaultReader<Uint8Array>,'read'|'cancel'|'releaseLock'>;
interface TransportScope {
  within:<V>(pending:Promise<V>)=>Promise<V>;
  check:()=>void;
  controller:AbortController;
  tracked:<V>(pending:Promise<V>)=>Promise<V>;
  reservation:number;
  reader:()=>StreamReader|undefined;
  wire:(url:string,init:AcquisitionSendInit)=>Promise<Response>;
}
export interface AcquisitionDownloadRequest {signedUrl:string;destination:string}
export interface AcquisitionDownloadReceipt {
  fixtureOnly:true;
  providerAuthenticated:false;
  globalQuiescenceEstablished:false;
  productionAcquisitionQualified:false;
  standaloneAcceptance:false;
  status:number;
  bytes:number;
  sha256:string;
  settled:true;
  readbackVerified:true;
  reservation:number;
}

function exact(value:unknown,wanted:readonly string[],code:string):asserts value is Record<string,unknown> {
  demand(value!==null&&typeof value==='object'&&!Array.isArray(value),code);
  const actual=Object.keys(value).sort();demand(JSON.stringify(actual)===JSON.stringify([...wanted].sort()),code);
}
function https(value:string,code:string){
  let url:URL;try{url=new URL(value);}catch{fail(code);}
  demand(url!.protocol==='https:'&&!url!.username&&!url!.password&&!url!.hash&&!url!.port,code);
  return url!;
}
function managementRequest(input:AcquisitionFixtureRequest,maximum:number):AcquisitionFixtureRequest {
  exact(input,['ordinal','kind','method','url','body','credentialScope','responseBytes'],'ACQUISITION_TRANSPORT_REQUEST');
  demand(Number.isSafeInteger(input.ordinal)&&input.ordinal>0&&input.credentialScope==='management'&&Number.isSafeInteger(input.responseBytes)&&input.responseBytes>0&&input.responseBytes<=maximum,'ACQUISITION_TRANSPORT_REQUEST');
  demand(typeof input.url==='string'&&input.url.length<=32768,'ACQUISITION_TRANSPORT_ENDPOINT');
  const url=https(input.url,'ACQUISITION_TRANSPORT_ENDPOINT');
  demand(url.origin===BASE&&url.toString()===input.url,'ACQUISITION_TRANSPORT_ENDPOINT');
  if(input.kind==='kv-list-a'||input.kind==='kv-list-b'){
    demand(input.method==='GET'&&input.body===null&&url.pathname===KV+'/keys','ACQUISITION_TRANSPORT_ENDPOINT');
    demand([...url.searchParams.keys()].every(key=>['limit','cursor'].includes(key))&&url.searchParams.getAll('limit').length===1&&url.searchParams.getAll('cursor').length<=1,'ACQUISITION_TRANSPORT_ENDPOINT');
    const limit=url.searchParams.get('limit')!;demand(/^\d+$/.test(limit)&&Number(limit)>=10&&Number(limit)<=100,'ACQUISITION_TRANSPORT_ENDPOINT');
    const cursor=url.searchParams.get('cursor');demand(cursor===null||cursor.length>0&&cursor.length<=4096,'ACQUISITION_TRANSPORT_ENDPOINT');
  }else if(input.kind==='kv-value-a'||input.kind==='kv-value-b'){
    demand(input.method==='GET'&&input.body===null&&!url.search&&url.pathname.startsWith(KV+'/values/'),'ACQUISITION_TRANSPORT_ENDPOINT');
    const encoded=url.pathname.slice((KV+'/values/').length);let name:string;
    try{name=decodeURIComponent(encoded);}catch{fail('ACQUISITION_TRANSPORT_ENDPOINT');}
    demand(encoded===encodeURIComponent(name!)&&Buffer.byteLength(name!,'utf8')<=512&&keys.some(key=>name!.startsWith(key)&&name!.length>key.length),'ACQUISITION_TRANSPORT_ENDPOINT');
  }else{
    demand(input.kind==='export'&&input.method==='POST'&&url.pathname===EXPORT&&!url.search&&typeof input.body==='string'&&Buffer.byteLength(input.body)<=16384,'ACQUISITION_TRANSPORT_ENDPOINT');
    let body:unknown;try{body=JSON.parse(input.body!);}catch{fail('ACQUISITION_TRANSPORT_BODY');}
    demand(body!==null&&typeof body==='object'&&!Array.isArray(body),'ACQUISITION_TRANSPORT_BODY');
    const record=body as Record<string,unknown>;
    exact(record,['output_format','dump_options',...(Object.hasOwn(record,'current_bookmark')?['current_bookmark']:[])],'ACQUISITION_TRANSPORT_BODY');
    exact(record.dump_options,['no_schema','no_data','tables'],'ACQUISITION_TRANSPORT_BODY');
    demand(record.output_format==='polling'&&record.dump_options.no_schema===false&&record.dump_options.no_data===false&&Array.isArray(record.dump_options.tables)&&record.dump_options.tables.length===0,'ACQUISITION_TRANSPORT_BODY');
    demand(!Object.hasOwn(record,'current_bookmark')||typeof record.current_bookmark==='string'&&record.current_bookmark.length>0&&record.current_bookmark.length<=4096,'ACQUISITION_TRANSPORT_BODY');
    demand(JSON.stringify(body)===input.body,'ACQUISITION_TRANSPORT_BODY');
  }
  return Object.freeze({...input});
}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeAll(fd:number,value:Uint8Array){let at=0;while(at<value.length){const n=writeSync(fd,value,at,value.length-at);demand(n>0,'ACQUISITION_TRANSPORT_DURABILITY');at+=n;}}
function exclusive(path:string,value:unknown){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeAll(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  syncDirectory(dirname(path));return sha(bytes);
}

/** Creates one finite owner. Every failure permanently ends it and leaves its
 * directory claimed. No accepted marker promises a complete source capture. */
export async function createFixtureAcquisitionTransport(options:AcquisitionTransportOptions){
 try{
  demand(options.fixtureOnly===true&&typeof options.send==='function'&&typeof options.syntheticCredential==='function','ACQUISITION_TRANSPORT_FIXTURE_ONLY');
  const cap={...options.limits},validUntil=options.validUntil,send=options.send,selectCredential=options.syntheticCredential;
  exact(cap,['maxRequests','wallMs','managementMs','downloadMs','responseBytes','downloadBytes','aggregateResponseBytes','minStartSpacingMs'],'ACQUISITION_TRANSPORT_LIMITS');
  for(const [key,value]of Object.entries(cap))demand(Number.isSafeInteger(value)&&value>=(key==='minStartSpacingMs'?0:1),'ACQUISITION_TRANSPORT_LIMITS');
  demand(cap.maxRequests<=2200&&cap.wallMs<=1_800_000&&cap.managementMs<=15_000&&cap.downloadMs<=cap.wallMs&&cap.responseBytes<=262144&&cap.downloadBytes<=2*1024**3&&cap.aggregateResponseBytes<=4*1024**3&&cap.minStartSpacingMs<=cap.wallMs,'ACQUISITION_TRANSPORT_LIMITS');
  const supplied=options.clock,clock={monotonic:supplied?.monotonic??(()=>performance.now()),wall:supplied?.wall??(()=>Date.now()),sleep:supplied?.sleep??((ms:number)=>new Promise<void>(r=>setTimeout(r,ms)))};
  const started=clock.monotonic(),startedAt=clock.wall();let lastMono=started,lastWall=startedAt,lastStart=started-cap.minStartSpacingMs;
  demand(Number.isFinite(started)&&Number.isFinite(startedAt)&&Number.isFinite(validUntil)&&validUntil>startedAt+cap.wallMs&&validUntil<=startedAt+86_400_000,'ACQUISITION_TRANSPORT_EXPIRY');
  demand(typeof options.signedDownloadOrigin==='string','ACQUISITION_TRANSPORT_ORIGIN');
  const admittedOrigin=https(options.signedDownloadOrigin,'ACQUISITION_TRANSPORT_ORIGIN');
  demand(admittedOrigin.origin===options.signedDownloadOrigin,'ACQUISITION_TRANSPORT_ORIGIN');
  const signedOrigin=admittedOrigin.origin;
  const root=resolve(options.journalDirectory);await privatePath(dirname(root),true);
  mkdirSync(root,{mode:0o700});syncDirectory(dirname(root));await privatePath(root,true);
  const identity=lstatSync(root);
  const checkedRoot=()=>{const now=lstatSync(root);demand(realpathSync(root)===root&&now.isDirectory()&&!now.isSymbolicLink()&&now.dev===identity.dev&&now.ino===identity.ino&&now.uid===process.getuid?.()&&(now.mode&0o777)===0o700,'ACQUISITION_TRANSPORT_DIRECTORY_DRIFT');};
  const persist=(path:string,value:unknown)=>{checkedRoot();return exclusive(path,value);};
  let requests=0,sent=0,receivedBytes=0,failed=false,busy=false,lease:SyntheticAcquisitionCredential|undefined;
  let active:AbortController|undefined,activePending:(()=>number)|undefined,interruptActive:((code:string)=>void)|undefined,settlementUncertain=false;
  let chain=persist(root+'/owner.intent.json',{format:1,...flags,limits:cap,startedAt,validUntil,signedDownloadOrigin:signedOrigin,automaticRetry:false,automaticResume:false});
  function check(deadline=Infinity){
    checkedRoot();const now=clock.monotonic(),wall=clock.wall();
    demand(Number.isFinite(now)&&now>=lastMono&&now-started<cap.wallMs&&now<deadline,'ACQUISITION_TRANSPORT_TIMEOUT');lastMono=now;
    demand(Number.isFinite(wall)&&wall>=lastWall&&wall<validUntil,'ACQUISITION_TRANSPORT_EXPIRY');lastWall=wall;
    demand(!failed,'ACQUISITION_TRANSPORT_TERMINAL');
  }
  function terminal(code:string,ioSettled:boolean){
    const settled=ioSettled&&!settlementUncertain&&(activePending?.()??0)===0;
    if(!settled)settlementUncertain=true;
    failed=true;lease=undefined;
    // A malformed concurrent input can fail before execute(). Wake the active
    // exchange even when its injected IO ignores the controller's abort.
    interruptActive?.('ACQUISITION_TRANSPORT_TERMINAL');active?.abort();
    try{persist(root+'/owner.failure.json',{format:1,...flags,code,requests,sent,receivedBytes,ioSettled:settled,automaticRetry:false,automaticResume:false});}catch{/* The exclusive owner directory still fences every restart. */}
    return settled;
  }
  async function execute<T>(kind:'management'|'sql-download',descriptor:unknown,external:AbortSignal|undefined,timeoutMs:number,work:(scope:TransportScope)=>Promise<{value:T;status:number;bytes:number;sha256:string}>):Promise<T>{
    if(failed)throw new ProtectedAcquisitionTransportError('ACQUISITION_TRANSPORT_TERMINAL',!settlementUncertain);
    if(busy){terminal('ACQUISITION_TRANSPORT_CONCURRENT',false);throw new ProtectedAcquisitionTransportError('ACQUISITION_TRANSPORT_CONCURRENT',false);}
    busy=true;let timer:ReturnType<typeof setTimeout>|undefined,reader:StreamReader|undefined,pending=0,finished=false,cleanupFailed=false,cancelled:Promise<void>|undefined;
    const controller=new AbortController();active=controller;
    let stopped:ProtectedAcquisitionTransportError|undefined,rejectStop!:(error:ProtectedAcquisitionTransportError)=>void;
    const stopPromise=new Promise<never>((_resolve,reject)=>{rejectStop=reject;});void stopPromise.catch(()=>{});
    let rejectDeadline!:(error:ProtectedAcquisitionTransportError)=>void;
    const deadlinePromise=new Promise<never>((_resolve,reject)=>{rejectDeadline=reject;});void deadlinePromise.catch(()=>{});
    const stop=(code:string)=>{stopped??=new ProtectedAcquisitionTransportError(code,pending===0);controller.abort();rejectStop(stopped);};
    const abort=()=>stop('ACQUISITION_TRANSPORT_CANCELLED');
    activePending=()=>pending;interruptActive=stop;
    let deadline=Infinity;
    const current=()=>{if(external?.aborted)abort();if(stopped)throw stopped;check(deadline);};
    const tracked=<V>(value:Promise<V>)=>{pending++;return value.then(result=>{pending--;return result;},error=>{pending--;throw error;});};
    const within=async<V>(value:Promise<V>):Promise<V>=>{void value.catch(()=>{});current();const result=await Promise.race([value,stopPromise]);current();return result;};
    const cancel=()=>{if(!cancelled&&reader)cancelled=tracked(reader.cancel());return cancelled;};
    const settleCancellation=async()=>{const value=cancel();if(!value)return;void value.catch(()=>{});check(deadline);await Promise.race([value,deadlinePromise]);check(deadline);};
    let outcome:{value:T;status:number;bytes:number;sha256:string}|undefined,error:unknown;
    try{
      current();deadline=Math.min(started+cap.wallMs,clock.monotonic()+timeoutMs);
      external?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{const error=new ProtectedAcquisitionTransportError('ACQUISITION_TRANSPORT_TIMEOUT',pending===0);rejectDeadline(error);stop(error.code);},Math.max(1,deadline-clock.monotonic()));
      while(clock.monotonic()-lastStart<cap.minStartSpacingMs){await within(tracked(clock.sleep(cap.minStartSpacingMs-(clock.monotonic()-lastStart))));}
      current();demand(requests<cap.maxRequests,'ACQUISITION_TRANSPORT_REQUEST_BOUND');
      const reservation=++requests,stem=root+`/exchange-${String(reservation).padStart(4,'0')}`;
      chain=persist(stem+'.intent.json',{format:1,...flags,reservation,kind,descriptor,previousSha256:chain});current();
      const wire=async(url:string,init:AcquisitionSendInit)=>{
        current();
        const response=await within(tracked(Promise.resolve().then(()=>{current();sent++;lastStart=clock.monotonic();return send(url,init);}).then(value=>{
          if(finished){try{void value.body?.cancel().catch(()=>{});}catch{};throw new ProtectedAcquisitionTransportError('ACQUISITION_TRANSPORT_TIMEOUT',false);}
          demand(value instanceof Response,'ACQUISITION_TRANSPORT_RESPONSE');
          if(value.body)reader=value.body.getReader();
          return value;
        })));
        demand(response instanceof Response,'ACQUISITION_TRANSPORT_RESPONSE');
        demand(!response.redirected&&Number.isInteger(response.status)&&response.status>=100&&response.status<=599,'ACQUISITION_TRANSPORT_HTTP');
        return response;
      };
      outcome=await work({within,check:current,controller,tracked,reservation,reader:()=>reader,wire});current();
      if(reader){await within(cancel()!);reader.releaseLock();reader=undefined;}
      current();chain=persist(stem+'.ack.json',{format:1,...flags,reservation,kind,status:outcome.status,bytes:outcome.bytes,sha256:outcome.sha256,previousSha256:chain,ioSettled:pending===0});current();
    }catch(caught){error=caught;}finally{
      finished=true;
      if(error){controller.abort();if(reader){try{await settleCancellation();}catch{cleanupFailed=true;/* Unsettled state remains terminal. */}try{reader.releaseLock();}catch{}}}
      if(timer!==undefined)clearTimeout(timer);external?.removeEventListener('abort',abort);active=undefined;activePending=undefined;interruptActive=undefined;busy=false;
    }
    if(error){const code=safeCode(error),settled=terminal(code,pending===0&&!cleanupFailed);throw new ProtectedAcquisitionTransportError(code,settled);}
    demand(outcome,'ACQUISITION_TRANSPORT_LOCAL_OR_IO');
    // Preserve bounded management HTTP observations for the existing core. Its
    // semantic parser retains the raw reply, while this owner refuses any reuse.
    if(outcome.status!==200)terminal('ACQUISITION_TRANSPORT_HTTP',true);
    return outcome.value;
  }
  function refuseInput(error:unknown):never {const code=failed?'ACQUISITION_TRANSPORT_TERMINAL':safeCode(error,'ACQUISITION_TRANSPORT_INPUT');const settled=terminal(code,true);throw new ProtectedAcquisitionTransportError(code,settled);}
  function account(bytes:number){receivedBytes+=bytes;demand(receivedBytes<=cap.aggregateResponseBytes,'ACQUISITION_TRANSPORT_AGGREGATE_BOUND');}
  async function consume(scope:TransportScope,response:Response,maximum:number,onChunk:(chunk:Uint8Array)=>void){
    const declared=response.headers.get('content-length');
    demand(declared===null||/^\d+$/.test(declared)&&Number.isSafeInteger(Number(declared))&&Number(declared)<=maximum,'ACQUISITION_TRANSPORT_RESPONSE_BOUND');
    demand(response.body,'ACQUISITION_TRANSPORT_RESPONSE');
    let size=0;const digest=createHash('sha256');
    const streamReader=scope.reader();
    demand(streamReader,'ACQUISITION_TRANSPORT_RESPONSE');
    for(;;){const next=await scope.within(scope.tracked(streamReader.read()));if(next.done)break;
      demand(next.value instanceof Uint8Array,'ACQUISITION_TRANSPORT_RESPONSE');size+=next.value.byteLength;account(next.value.byteLength);
      demand(size<=maximum,'ACQUISITION_TRANSPORT_RESPONSE_BOUND');onChunk(next.value);digest.update(next.value);scope.check();
    }
    demand(declared===null||size===Number(declared),'ACQUISITION_TRANSPORT_RESPONSE_BOUND');
    return {bytes:size,sha256:digest.digest('hex')};
  }
  return {
    fixtureOnly:true as const,
    async management(input:AcquisitionFixtureRequest,signal?:AbortSignal){
      let request:AcquisitionFixtureRequest;try{request=managementRequest(input,cap.responseBytes);}catch(error){refuseInput(error);}
      return execute('management',request!,signal,cap.managementMs,async scope=>{
        if(!lease){const selected=await scope.within(scope.tracked(Promise.resolve().then(()=>{scope.check();return selectCredential(scope.controller.signal);})));
          exact(selected,['fixtureOnly','value','expiresAt'],'ACQUISITION_TRANSPORT_CREDENTIAL');
          demand(selected.fixtureOnly===true&&typeof selected.value==='string'&&/^SYNTHETIC_[A-Za-z0-9_-]{16,512}$/.test(selected.value)&&Number.isFinite(selected.expiresAt)&&selected.expiresAt>=validUntil,'ACQUISITION_TRANSPORT_CREDENTIAL');lease=Object.freeze({...selected});}
        scope.check();demand(clock.wall()<lease.expiresAt,'ACQUISITION_TRANSPORT_CREDENTIAL');
        const response=await scope.wire(request!.url,{method:request!.method,headers:{authorization:`Bearer ${lease.value}`,...(request!.method==='POST'?{'content-type':'application/json'}:{})},body:request!.body,redirect:'manual',credentials:'omit',signal:scope.controller.signal});
        const chunks:Uint8Array[]=[];const read=await consume(scope,response,request!.responseBytes,chunk=>{chunks.push(chunk.slice());});
        const body=new Uint8Array(read.bytes);let at=0;for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}
        return {value:{status:response.status,body},status:response.status,...read};
      });
    },
    async downloadSql(input:AcquisitionDownloadRequest,signal?:AbortSignal):Promise<AcquisitionDownloadReceipt>{
      let request:AcquisitionDownloadRequest;try{
        exact(input,['signedUrl','destination'],'ACQUISITION_TRANSPORT_DOWNLOAD');demand(typeof input.signedUrl==='string'&&input.signedUrl.length<=16384&&typeof input.destination==='string','ACQUISITION_TRANSPORT_DOWNLOAD');
        const url=https(input.signedUrl,'ACQUISITION_TRANSPORT_ORIGIN');demand(url.origin===signedOrigin,'ACQUISITION_TRANSPORT_ORIGIN');
        const destination=resolve(input.destination);demand(destination===input.destination&&dirname(destination)===root&&!['owner.intent.json','owner.failure.json'].includes(destination.slice(root.length+1))&&!/^exchange-/.test(destination.slice(root.length+1)),'ACQUISITION_TRANSPORT_DESTINATION');
        request=Object.freeze({...input});
      }catch(error){refuseInput(error);}
      return execute('sql-download',request!,signal,cap.downloadMs,async scope=>{
        // Claim the private output before sending. Never truncate or remove it.
        const fd=openSync(request!.destination,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{
          syncDirectory(root);scope.check();
          const response=await scope.wire(request!.signedUrl,{method:'GET',headers:{},redirect:'manual',credentials:'omit',signal:scope.controller.signal});
          demand(response.status===200,'ACQUISITION_TRANSPORT_HTTP');
          const read=await consume(scope,response,cap.downloadBytes,chunk=>writeAll(fd,chunk));
          const checkedOutput=()=>{
            const opened=fstatSync(fd,{bigint:true}),named=lstatSync(request!.destination,{bigint:true});
            demand(opened.dev===named.dev&&opened.ino===named.ino&&named.isFile()&&!named.isSymbolicLink()&&named.nlink===1n&&named.uid===BigInt(process.getuid?.()??-1)&&(named.mode&0o777n)===0o600n&&opened.size===BigInt(read.bytes),'ACQUISITION_TRANSPORT_OUTPUT_DRIFT');
            return opened;
          };
          checkedOutput();scope.check();fsyncSync(fd);const before=checkedOutput();scope.check();
          // Check the persisted bytes through the same exclusive descriptor. A
          // consumed-stream digest alone misses same-size in-place rewrites.
          const saved=createHash('sha256'),buffer=new Uint8Array(64*1024);let position=0;
          while(position<read.bytes){
            scope.check();const amount=readSync(fd,buffer,0,Math.min(buffer.length,read.bytes-position),position);
            demand(amount>0,'ACQUISITION_TRANSPORT_OUTPUT_DRIFT');saved.update(buffer.subarray(0,amount));position+=amount;scope.check();
          }
          demand(readSync(fd,buffer,0,1,position)===0,'ACQUISITION_TRANSPORT_OUTPUT_DRIFT');scope.check();
          const after=checkedOutput();demand(before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs,'ACQUISITION_TRANSPORT_OUTPUT_DRIFT');
          demand(saved.digest('hex')===read.sha256,'ACQUISITION_TRANSPORT_OUTPUT_HASH_MISMATCH');scope.check();
          return {value:{...flags,status:response.status,...read,settled:true as const,readbackVerified:true as const,reservation:scope.reservation},status:response.status,...read};
        }finally{closeSync(fd);syncDirectory(root);scope.check();}
      });
    },
    snapshot(){return {...flags,requests,sent,receivedBytes,terminal:failed,inFlight:busy,ioSettled:!settlementUncertain&&(activePending?.()??0)===0,limits:{...cap}};},
  };
 }catch(error){throw new ProtectedAcquisitionTransportError(safeCode(error));}
}
