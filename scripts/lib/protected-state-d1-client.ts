/** Bounded durable staging-copy windows, sharing one transport and receipt protocol. */
import {closeSync,constants,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {jsonLines} from '../prepare-text-cutover';
import {hashJson} from '../../services/restore/protocol';
import {privatePath} from './protected-state';
import {loadProtectedD1ClientPlan,type ProtectedD1SourceOptions} from './protected-state-d1';
export const PROTECTED_CLIENT_LIMITS={maxRequests:64,wallMs:300_000,requestMs:15_000,responseBytes:16*1024,beginBytes:16*1024,corpusBytes:64*1024+1024,stepBytes:1024} as const;
type Plan=Awaited<ReturnType<typeof loadProtectedD1ClientPlan>>;
type Step='status'|'begin'|'corpus'|'text'|'page'|'verify'|'finish';
type Progress={initialized:false}|{initialized:true;phase:'checking-corpus'|'checking-text'|'loading'|'checking-protected'|'checking-corpus-final'|'complete';version:number;compactPages:number;compactRows:number;compactChain:string;loadedPages:number;loadedChain:string;verifiedPages:number;verifiedChain:string;textRows:number;textBytes:number;textComplete:boolean;complete:boolean};
type Outcome='bounded'|'checking-text'|'complete'|'reconciled'|'unresolved'|'failed';
interface Intent {format:1;planSha256:string;window:number;attempt:number;step:Step;page:number;bodySha256:string|null;before:Progress;expectedAfter:Progress;previousSha256:string}
interface Ack {format:1;kind:'ack';intentSha256:string;progress:Progress}
interface Failure {format:1;kind:'failure';intentSha256:string;code:string}
interface RequestReceipt {intentSha256:string;terminalSha256:string;kind:'ack'|'failure'}
interface WindowResult {format:1;planSha256:string;window:number;outcome:Outcome;attempts:number;progress:Progress;previousWindowSha256:string;lastSha256:string;requests:RequestReceipt[];limits:{maxRequests:number;wallMs:number;requestMs:number};code?:string}
export class ProtectedD1ClientError extends Error {constructor(readonly code:string){super(code);this.name='ProtectedD1ClientError';}}
function demand(value:unknown,code:string):asserts value{if(!value)throw new ProtectedD1ClientError(code);}
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const ZERO='0'.repeat(64),progressKeys=['phase','version','compactPages','compactRows','compactChain','loadedPages','loadedChain','verifiedPages','verifiedChain','textRows','textBytes','textComplete','complete'];
const fixedCode=(error:unknown)=>error instanceof ProtectedD1ClientError?error.code:'PROTECTED_CLIENT_LOCAL_OR_TRANSPORT';
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{demand(value!==null&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value).sort(),[...keys].sort()),'PROTECTED_CLIENT_RECORD');}
function checkedProgress(value:unknown,full=false):Progress{
 const raw=value as Record<string,unknown>;if(raw?.['initialized']===false){exact(raw,['initialized']);return {initialized:false};}
 exact(raw,[...progressKeys,...(raw?.['initialized']===true?['initialized']:[])]);
 demand((full?['checking-corpus','checking-text','loading','checking-protected','checking-corpus-final','complete']:['checking-corpus','checking-text']).includes(String(raw['phase'])),'PROTECTED_CLIENT_UNSUPPORTED_PHASE');
 for(const key of ['version','compactPages','compactRows','loadedPages','verifiedPages','textRows','textBytes'])demand(Number.isSafeInteger(raw[key])&&Number(raw[key])>=0,'PROTECTED_CLIENT_PROGRESS');
 for(const key of ['compactChain','loadedChain','verifiedChain'])demand(typeof raw[key]==='string'&&/^[a-f0-9]{64}$/.test(raw[key]),'PROTECTED_CLIENT_PROGRESS');
 demand(typeof raw['textComplete']==='boolean'&&typeof raw['complete']==='boolean','PROTECTED_CLIENT_PROGRESS');
 return Object.fromEntries([['initialized',true],...progressKeys.map(key=>[key,raw[key]])]) as Progress;
}
function expected(plan:Plan,page:number):Progress{const prefix=plan.prefixes[page];demand(prefix&&prefix.page===page,'PROTECTED_CLIENT_PAGE');return {initialized:true,phase:page===plan.admission.compactPlan.pageCount?'checking-text':'checking-corpus',version:page,compactPages:page,compactRows:prefix.rows,compactChain:prefix.chain,loadedPages:0,loadedChain:ZERO,verifiedPages:0,verifiedChain:ZERO,textRows:0,textBytes:0,textComplete:false,complete:false};}
/** Every committed POST except begin advances exactly one version. */
function fullExpected(plan:Plan,version:number):Progress{
 const facts=plan.full;demand(facts&&Number.isSafeInteger(version)&&version>=0,'PROTECTED_CLIENT_PROGRESS');
 const c=plan.admission.compactPlan.pageCount,t=facts.textPrefixes.length-1,p=plan.manifest.pages,finish=facts.finalVersion;
 demand(Number.isSafeInteger(finish)&&version<=finish,'PROTECTED_CLIENT_PROGRESS');
 if(version<=c)return expected(plan,version);
 const base=expected(plan,c);demand(base.initialized,'PROTECTED_CLIENT_PROGRESS');
 const text=facts.textPrefixes[Math.min(version-c,t)]!,textDone=version>=c+t;
 const loaded=Math.max(0,Math.min(p,version-c-t)),verified=Math.max(0,Math.min(p,version-c-t-p));
 const final=version>=c+t+2*p,compact=final?plan.prefixes[Math.min(c,version-c-t-2*p)]!:plan.prefixes[c]!;
 const phase=version<c+t?'checking-text':version<c+t+p?'loading':version<c+t+2*p?'checking-protected':version<finish?'checking-corpus-final':'complete';
 return {...base,phase,version,compactPages:compact.page,compactRows:compact.rows,compactChain:compact.chain,loadedPages:loaded,loadedChain:facts.protectedPrefixes[loaded]!.chain,verifiedPages:verified,verifiedChain:facts.protectedPrefixes[verified]!.chain,textRows:text.rows,textBytes:text.bytes,textComplete:textDone,complete:version===finish};
}
function validateProgress(plan:Plan,value:unknown){const p=checkedProgress(value,!!plan.full);if(p.initialized)demand(same(p,plan.full?fullExpected(plan,p.version):expected(plan,p.compactPages)),'PROTECTED_CLIENT_PROGRESS');return p;}
function nextOperation(plan:Plan,before:Progress){
 if(!before.initialized)return {step:'begin' as const,page:0,bodySha256:plan.beginBodySha256,after:plan.full?fullExpected(plan,0):expected(plan,0)};
 let step:Step,page=0,bodySha256:string;
 if(before.phase==='complete'||!plan.full&&before.phase==='checking-text')return null;
 if(before.phase==='checking-corpus'||before.phase==='checking-corpus-final'&&before.compactPages<plan.admission.compactPlan.pageCount){step='corpus';page=before.compactPages+1;bodySha256=plan.prefixes[page]!.bodySha256;}
 else if(before.phase==='checking-text'){step='text';bodySha256=sha(JSON.stringify({expectedSessionVersion:before.version}));}
 else if(before.phase==='loading'){step='page';page=before.loadedPages+1;bodySha256=plan.full!.protectedPrefixes[page]!.bodySha256;}
 else if(before.phase==='checking-protected'){step='verify';page=before.verifiedPages+1;bodySha256=plan.full!.protectedPrefixes[page]!.bodySha256;}
 else {demand(before.phase==='checking-corpus-final','PROTECTED_CLIENT_PROGRESS');step='finish';bodySha256=sha('{}');}
 return {step,page,bodySha256,after:plan.full?fullExpected(plan,before.version+1):expected(plan,page)};
}
function responseProgress(plan:Plan,step:Step,value:unknown){
 if(plan.full&&step==='page'){demand(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(value as Record<string,unknown>)['skipped']===false,'PROTECTED_CLIENT_PAGE_REPLAY');const {skipped:_,...safe}=value as Record<string,unknown>;return validateProgress(plan,safe);}
 return validateProgress(plan,value);
}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function privateDirectory(path:string){const s=lstatSync(path);demand(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777)===0o700&&s.uid===process.getuid?.(),'PROTECTED_CLIENT_PRIVATE_DIRECTORY');}
function exclusive(path:string,value:unknown){const data=Buffer.from(JSON.stringify(value)+'\n'),fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{let offset=0;while(offset<data.length){const n=writeSync(fd,data,offset,data.length-offset);demand(n>0,'PROTECTED_CLIENT_SHORT_WRITE');offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));return sha(data);}
function localJson(path:string,max=64*1024){privateDirectory(dirname(path));const s=lstatSync(path);demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o777)===0o600&&s.uid===process.getuid?.()&&s.size<=max,'PROTECTED_CLIENT_PRIVATE_RECORD');const bytes=readFileSync(path);return {value:JSON.parse(bytes.toString('utf8')) as any,sha256:sha(bytes)};}
function exists(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function resultFiles(requests:RequestReceipt[]){return ['started.json','result.json','accepted.json',...requests.flatMap((r,n)=>{const stem=`request-${String(n+1).padStart(4,'0')}`;return [stem+'.intent.json',stem+'.'+r.kind+'.json'];})].sort();}
function checkedIntent(plan:Plan,value:unknown,before:Progress):Intent{
 exact(value,['format','planSha256','window','attempt','step','page','bodySha256','before','expectedAfter','previousSha256']);const r=value as unknown as Intent;
 demand(r.format===1&&r.planSha256===plan.planSha256&&same(r.before,before),'PROTECTED_CLIENT_INTENT');
 if(r.step==='status')demand(r.page===0&&r.bodySha256===null,'PROTECTED_CLIENT_INTENT');
 else {const next=nextOperation(plan,before);demand(next&&r.step===next.step&&r.page===next.page&&r.bodySha256===next.bodySha256&&same(r.expectedAfter,next.after),'PROTECTED_CLIENT_INTENT');}
 return r;
}
async function history(root:string,plan:Plan){
 const planFile=root+'/plan.json',wanted={format:1,planSha256:plan.planSha256,pins:plan.pins};
 if(!exists(root)){await privatePath(dirname(root),true);privateDirectory(dirname(root));mkdirSync(root,{mode:0o700});syncDirectory(dirname(root));exclusive(planFile,wanted);}
 await privatePath(root,true);privateDirectory(root);const saved=localJson(planFile);demand(same(saved.value,wanted),'PROTECTED_CLIENT_PLAN_DRIFT');
 const names=readdirSync(root).sort();demand(names.length<=100001&&names[0]==='plan.json'&&names.slice(1).every((name,n)=>name===`window-${String(n+1).padStart(6,'0')}`),'PROTECTED_CLIENT_HISTORY');
 let progress:Progress={initialized:false},prior=saved.sha256;
 for(const [index,name]of names.slice(1).entries()){
  const directory=root+'/'+name;privateDirectory(directory);demand(exists(directory+'/result.json'),'PROTECTED_CLIENT_CRASH_OR_COMPETING_WINDOW');
  const result=localJson(directory+'/result.json'),r=result.value as WindowResult;
  demand(r.format===1&&r.planSha256===plan.planSha256&&r.window===index+1&&r.previousWindowSha256===prior&&Array.isArray(r.requests)&&r.attempts===r.requests.length&&r.attempts<=64&&(plan.full?['bounded','complete','reconciled','unresolved','failed']:['bounded','checking-text','reconciled','unresolved','failed']).includes(r.outcome),'PROTECTED_CLIENT_HISTORY');
  demand(r.outcome!=='unresolved'&&r.outcome!=='failed','PROTECTED_CLIENT_UNRESOLVED');
  demand(same(readdirSync(directory).sort(),resultFiles(r.requests)),'PROTECTED_CLIENT_PARTIAL_RECEIPT');
  const accepted=localJson(directory+'/accepted.json');demand(accepted.value.format===1&&accepted.value.planSha256===plan.planSha256&&accepted.value.window===r.window&&accepted.value.resultSha256===result.sha256,'PROTECTED_CLIENT_HISTORY');
  const start=localJson(directory+'/started.json');demand(start.value.planSha256===plan.planSha256&&start.value.window===r.window&&start.value.previousWindowSha256===prior&&same(start.value.progress,progress),'PROTECTED_CLIENT_HISTORY');let chain=start.sha256,pending:Progress|undefined;
  for(const [n,entry]of r.requests.entries()){
   demand(entry.kind==='ack'||entry.kind==='failure','PROTECTED_CLIENT_HISTORY');
   const stem=directory+`/request-${String(n+1).padStart(4,'0')}`,i=localJson(stem+'.intent.json'),intent=checkedIntent(plan,i.value,progress);
   if(intent.step==='status')demand(same(intent.expectedAfter,pending??progress),'PROTECTED_CLIENT_HISTORY');
   demand(i.sha256===entry.intentSha256&&intent.window===r.window&&intent.attempt===n+1&&intent.previousSha256===chain,'PROTECTED_CLIENT_HISTORY');
   const terminal=localJson(stem+'.'+entry.kind+'.json');demand(terminal.sha256===entry.terminalSha256&&terminal.value.intentSha256===i.sha256&&terminal.value.kind===entry.kind,'PROTECTED_CLIENT_HISTORY');
   if(entry.kind==='failure'){demand(intent.step!=='status'&&!pending,'PROTECTED_CLIENT_UNRESOLVED');pending=intent.expectedAfter;}
   else {const observed=validateProgress(plan,terminal.value.progress);if(pending){demand(intent.step==='status'&&same(observed,pending),'PROTECTED_CLIENT_UNRESOLVED');progress=observed;pending=undefined;}else{demand(same(observed,intent.expectedAfter),'PROTECTED_CLIENT_HISTORY');progress=observed;}}
   chain=terminal.sha256;
  }
  demand(!pending&&same(progress,r.progress)&&r.lastSha256===chain,'PROTECTED_CLIENT_UNRESOLVED');
  prior=accepted.sha256;
 }
 return {progress,previousWindowSha256:prior,window:names.length};
}
export interface ProtectedD1ClientOptions extends ProtectedD1SourceOptions {admissionPath:string;admissionSha256:string;admissionFileSha256:string;journalDirectory:string;credential:()=>string|Promise<string>;fetch?:typeof fetch;maxRequests?:number;wallMs?:number;requestMs?:number}
/** A source-only inspection never selects a credential or creates a journal. */
export async function inspectProtectedD1Client(options:Omit<ProtectedD1ClientOptions,'credential'|'journalDirectory'>,full=false){try{const plan=await loadProtectedD1ClientPlan(options,full);return {format:1,execute:false,planSha256:plan.planSha256,pins:plan.pins,compactPages:plan.admission.compactPlan.pageCount,corpusRows:plan.manifest.corpusRows,...(plan.full?{fullPhases:true,textAuditSteps:plan.full.textPrefixes.length-1,protectedPages:plan.manifest.pages,minimumPostRequests:plan.full.finalVersion+1}:{}),limits:PROTECTED_CLIENT_LIMITS};}catch(error){throw new ProtectedD1ClientError(fixedCode(error));}}
async function runWindow(options:ProtectedD1ClientOptions,full=false):Promise<WindowResult>{
 const started=performance.now(),limits={maxRequests:options.maxRequests??64,wallMs:options.wallMs??300000,requestMs:options.requestMs??15000};
 for(const [key,max]of Object.entries(PROTECTED_CLIENT_LIMITS).slice(0,3))demand(Number.isSafeInteger(limits[key as keyof typeof limits])&&limits[key as keyof typeof limits]>=1&&limits[key as keyof typeof limits]<=max,'PROTECTED_CLIENT_LIMITS');
 const expires=started+limits.wallMs,within=()=>demand(performance.now()<expires,'PROTECTED_CLIENT_WALL');
 const plan=await loadProtectedD1ClientPlan(options,full);within();const root=resolve(options.journalDirectory),old=await history(root,plan);within();
 const directory=root+`/window-${String(old.window).padStart(6,'0')}`;mkdirSync(directory,{mode:0o700});syncDirectory(root);
 let progress=old.progress,chain=exclusive(directory+'/started.json',{format:1,planSha256:plan.planSha256,window:old.window,previousWindowSha256:old.previousWindowSha256,progress,limits});
 const receipts:RequestReceipt[]=[];let credential:string|undefined,poisoned=false,canReconcile=true,acceptanceFailed=false;
 function persist(path:string,value:unknown){try{return exclusive(path,value);}catch{poisoned=true;throw new ProtectedD1ClientError('PROTECTED_CLIENT_DURABILITY');}}
 async function request(step:Step,after:Progress,page=0,body?:unknown){
  within();demand(!poisoned&&canReconcile,'PROTECTED_CLIENT_UNSETTLED');demand(receipts.length<limits.maxRequests,'PROTECTED_CLIENT_REQUEST_BUDGET');const deadline=Math.min(expires,performance.now()+limits.requestMs),attempt=receipts.length+1,stem=directory+`/request-${String(attempt).padStart(4,'0')}`;
  const data=body===undefined?undefined:JSON.stringify(body);demand(data===undefined||Buffer.byteLength(data)<=(step==='begin'?PROTECTED_CLIENT_LIMITS.beginBytes:['corpus','page','verify'].includes(step)?PROTECTED_CLIENT_LIMITS.corpusBytes:PROTECTED_CLIENT_LIMITS.stepBytes),'PROTECTED_CLIENT_BODY_BOUND');
  const intent:Intent={format:1,planSha256:plan.planSha256,window:old.window,attempt,step,page,bodySha256:data===undefined?null:sha(data),before:progress,expectedAfter:after,previousSha256:chain};
  checkedIntent(plan,intent,progress);const intentSha256=persist(stem+'.intent.json',intent);const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,reader:{cancel():Promise<void>;releaseLock():void}|undefined,bodyStream:{cancel():Promise<void>}|undefined,sending=false,reading=false,terminalWritten=false,cleanup:Promise<boolean>|undefined;
  const checkDeadline=()=>demand(!controller.signal.aborted&&performance.now()<deadline,'PROTECTED_CLIENT_REQUEST_TIMEOUT');
  function cancelBody(){return cleanup??=(async()=>{try{if(reader)await reader.cancel();else if(bodyStream)await bodyStream.cancel();return !sending&&!reading;}catch{return false;}finally{if(reader)try{reader.releaseLock();}catch{}}})();}
  async function settleBody(){const work=cancelBody(),remaining=deadline-performance.now();if(remaining<=0){canReconcile=false;void work;return false;}let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
   try{const settled=await Promise.race([work,new Promise<false>(resolve=>{cleanupTimer=setTimeout(()=>resolve(false),remaining);})]);if(!settled||performance.now()>=deadline){canReconcile=false;return false;}return true;}finally{if(cleanupTimer)clearTimeout(cleanupTimer);}}
  try{
   const value=await Promise.race([(async()=>{checkDeadline();credential??=await options.credential();checkDeadline();demand(credential.length>=32&&credential.length<=512&&!/[\r\n]/.test(credential),'PROTECTED_CLIENT_CREDENTIAL');
    const target=plan.target,headers:Record<string,string>={authorization:'Bearer '+credential,'x-restore-stage':target.stageId,'x-restore-account':target.accountId,'x-restore-d1':target.d1Id,'x-restore-r2':target.r2Bucket,'x-restore-plan':plan.admission.compactPlanSha256,'x-protected-manifest':plan.identity.manifestSha256,'x-protected-admission':plan.identity.admissionSha256,'accept-encoding':'identity',...(data===undefined?{}:{'content-type':'application/json'})};
    demand(data===undefined||sha(data)===intent.bodySha256,'PROTECTED_CLIENT_SOURCE_CHANGED');checkDeadline();const url=target.adminUrl+'/v1/restore/protected/'+step;let response:Response;sending=true;try{response=await(options.fetch??fetch)(url,{method:step==='status'?'GET':'POST',headers,...(data===undefined?{}:{body:data}),redirect:'error',signal:controller.signal});}finally{sending=false;}bodyStream=response.body??undefined;
    if(controller.signal.aborted||performance.now()>=deadline){if(bodyStream)void bodyStream.cancel().catch(()=>{});throw new ProtectedD1ClientError('PROTECTED_CLIENT_REQUEST_TIMEOUT');}
    demand(response.status===200&&!response.redirected&&(!response.url||response.url===url)&&response.body,'PROTECTED_CLIENT_HTTP');
    const length=response.headers.get('content-length');demand(length===null||/^\d+$/.test(length)&&Number(length)<=PROTECTED_CLIENT_LIMITS.responseBytes,'PROTECTED_CLIENT_RESPONSE_BOUND');
    const stream=response.body.getReader();reader=stream;let size=0;const chunks:Uint8Array[]=[];for(;;){checkDeadline();reading=true;let next;try{next=await stream.read();}finally{reading=false;}checkDeadline();if(next.done)break;size+=next.value.length;demand(size<=PROTECTED_CLIENT_LIMITS.responseBytes,'PROTECTED_CLIENT_RESPONSE_BOUND');if(next.value.length)chunks.push(next.value);}
    let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(Buffer.concat(chunks)));}catch{throw new ProtectedD1ClientError('PROTECTED_CLIENT_JSON');}checkDeadline();return responseProgress(plan,step,parsed);
   })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ProtectedD1ClientError('PROTECTED_CLIENT_REQUEST_TIMEOUT'));},Math.max(1,deadline-performance.now()));})]);
   demand(await settleBody(),'PROTECTED_CLIENT_CLEANUP_UNSETTLED');checkDeadline();demand(same(value,after),'PROTECTED_CLIENT_ACK_MISMATCH');const ack:Ack={format:1,kind:'ack',intentSha256,progress:value};chain=persist(stem+'.ack.json',ack);receipts.push({intentSha256,terminalSha256:chain,kind:'ack'});terminalWritten=true;progress=value;within();checkDeadline();return value;
  }catch(error){controller.abort();if(sending||reading)canReconcile=false;if(!await settleBody())canReconcile=false;if(poisoned||terminalWritten){canReconcile=false;if(terminalWritten)acceptanceFailed=true;throw error;}const failure:Failure={format:1,kind:'failure',intentSha256,code:fixedCode(error)};chain=persist(stem+'.failure.json',failure);receipts.push({intentSha256,terminalSha256:chain,kind:'failure'});throw error;}
  finally{if(timer)clearTimeout(timer);controller.abort();void cancelBody();}
 }
 let outcome:Outcome='bounded',code:string|undefined;
 try{
  await request('status',progress);
  const streams=new Map<string,ReturnType<typeof jsonLines>>();
  try{for(;;){
   if(progress.initialized&&(full?progress.phase==='complete':progress.phase==='checking-text')){outcome=full?'complete':'checking-text';break;}
   if(receipts.length+2>limits.maxRequests||expires-performance.now()<2*limits.requestMs)break;
   const next=nextOperation(plan,progress);demand(next,'PROTECTED_CLIENT_PROGRESS');const {step,page,after}=next;let body:unknown;
   if(step==='begin')body={manifest:plan.manifest,admission:plan.admission};
   else if(step==='text'){demand(progress.initialized,'PROTECTED_CLIENT_PROGRESS');body={expectedSessionVersion:progress.version};}
   else if(step==='finish')body={};
   else {
    const final=progress.initialized&&progress.phase==='checking-corpus-final',key=step==='corpus'?(final?'final':'initial'):step;
    let pages=streams.get(key);if(!pages){pages=jsonLines(step==='corpus'?plan.compactPagesPath:plan.pagesPath);streams.set(key,pages);}
    let line;do{line=await pages.next();}while(!line.done&&Number(line.value['page'])<page);
    demand(!line.done,'PROTECTED_CLIENT_SOURCE_CHANGED');body={page:line.value};
   }
   demand(await hashJson(body)===next.bodySha256,'PROTECTED_CLIENT_SOURCE_CHANGED');
   if(expires-performance.now()<2*limits.requestMs)break;
   try{progress=await request(step,after,page,body);}catch(error){code=fixedCode(error);outcome=acceptanceFailed?'failed':'unresolved';
    // Unchanged status cannot fence a late POST. Only the exact versioned commit
    // reconciles one settled lost reply; this window then ends without another POST.
    if(!poisoned&&canReconcile&&receipts.length<limits.maxRequests&&expires-performance.now()>=limits.requestMs){try{progress=await request('status',after);outcome='reconciled';}catch{}}
    break;
   }
  }}finally{for(const pages of streams.values())await pages.return(undefined);}
 }catch(error){outcome='failed';code=fixedCode(error);}
 if(performance.now()>=expires){outcome='failed';code='PROTECTED_CLIENT_WALL';}
 const result:WindowResult={format:1,planSha256:plan.planSha256,window:old.window,outcome,attempts:receipts.length,progress,previousWindowSha256:old.previousWindowSha256,lastSha256:chain,requests:receipts,limits,...(code?{code}:{})};
 if(poisoned)throw new ProtectedD1ClientError('PROTECTED_CLIENT_DURABILITY');const resultSha256=persist(directory+'/result.json',result);credential=undefined;within();
 if(outcome!=='failed'&&outcome!=='unresolved'){
  // Normal resumption requires the result's post-fsync acceptance observation.
  // Filesystem syscalls themselves are not preemptible; an observed overrun
  // preserves a separate terminal marker and never returns normal acceptance.
  persist(directory+'/accepted.json',{format:1,planSha256:plan.planSha256,window:old.window,resultSha256,elapsedMs:performance.now()-started});
  if(performance.now()>=expires){persist(directory+'/acceptance-expired.json',{format:1,code:'PROTECTED_CLIENT_WALL'});throw new ProtectedD1ClientError('PROTECTED_CLIENT_WALL');}
 }
 return result;
}
export async function runProtectedD1InitialWindow(options:ProtectedD1ClientOptions):Promise<WindowResult>{try{return await runWindow(options);}catch(error){throw new ProtectedD1ClientError(fixedCode(error));}}

/** Explicit full-phase mode has a distinct sealed plan identity and journal. */
export async function runProtectedD1FullWindow(options:ProtectedD1ClientOptions):Promise<WindowResult>{try{return await runWindow(options,true);}catch(error){throw new ProtectedD1ClientError(fixedCode(error));}}
