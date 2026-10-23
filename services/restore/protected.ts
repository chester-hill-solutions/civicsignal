/** Staging-only fixed protected-copy transport. No SQL or resource overrides. */
import {applyProtectedD1Page,beginProtectedD1,checkProtectedD1CorpusPage,checkProtectedD1Text,
  finishProtectedD1,getProtectedD1Status,verifyProtectedD1Page,type ProtectedD1Identity} from '../../src/corpora/protected-state-d1';
import {ProtectedStateError,type ProtectedManifest} from '../../src/corpora/protected-state-format';
import type {ProtectedD1Admission} from '../../src/corpora/protected-state-d1-admission';
import type {CompactRestorePage} from '../../src/corpora/compact-restore';
import {digestPattern,type StagingRestoreTarget} from './protocol';

export interface ProtectedRestorePins {
  RESTORE_PROTECTED_ENABLED?:string;
  RESTORE_PROTECTED_MANIFEST_SHA256?:string;
  RESTORE_PROTECTED_ADMISSION_SHA256?:string;
}
interface Context {db:D1Database;bucket:R2Bucket;target:StagingRestoreTarget;planHash:string;pins:ProtectedRestorePins}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
class InputError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}
export const PROTECTED_BODY_TIMEOUT_MS=5_000;
export const MAX_PROTECTED_REQUEST_BYTES=64*1024+1024;

/** Byte and total-time bounds precede decoding. This module leaves the pinned
 * general HTTP parser unchanged. A failed body performs no D1/R2 mutations. */
export async function readProtectedRestoreBody(request:Request,maxBytes:number):Promise<unknown>{
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))throw new InputError('PROTECTED_HTTP_CONTENT_TYPE',415);
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))))throw new InputError('PROTECTED_HTTP_LENGTH');
  if(length!==null&&Number(length)>maxBytes)throw new InputError('PROTECTED_HTTP_BODY_BOUND',413);
  const reader=request.body?.getReader();if(!reader)throw new InputError('PROTECTED_HTTP_BODY');
  const chunks:Uint8Array[]=[];let size=0,done=false,timer:ReturnType<typeof setTimeout>|undefined;
  const expiresAt=performance.now()+PROTECTED_BODY_TIMEOUT_MS;
  const checkDeadline=()=>{if(performance.now()>=expiresAt)throw new InputError('PROTECTED_HTTP_BODY_TIMEOUT',408);};
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new InputError('PROTECTED_HTTP_BODY_TIMEOUT',408)),PROTECTED_BODY_TIMEOUT_MS);});
  try{
    // Fulfilled read promises can starve the timer, including the final EOF.
    while(true){checkDeadline();const next=await Promise.race([reader.read(),deadline]);checkDeadline();if(next.done){done=true;break;}
      size+=next.value.byteLength;if(size>maxBytes)throw new InputError('PROTECTED_HTTP_BODY_BOUND',413);chunks.push(next.value);}
  }finally{clearTimeout(timer);if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as unknown;}
  catch{throw new InputError('PROTECTED_HTTP_JSON');}
}
function bodyObject(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new InputError('PROTECTED_HTTP_FIELDS');
  return value as Record<string,unknown>;
}

/** Called only after the existing restore bearer/target/plan/session guard. */
export async function handleProtectedRestoreRequest(request:Request,context:Context):Promise<Response>{
  try{
    const {db,bucket,target,planHash,pins}=context;
    if(pins.RESTORE_PROTECTED_ENABLED!=='staging-only'||!digestPattern.test(pins.RESTORE_PROTECTED_MANIFEST_SHA256??'')||!digestPattern.test(pins.RESTORE_PROTECTED_ADMISSION_SHA256??''))throw new InputError('PROTECTED_HTTP_DISABLED',403);
    const manifestSha256=pins.RESTORE_PROTECTED_MANIFEST_SHA256!,admissionSha256=pins.RESTORE_PROTECTED_ADMISSION_SHA256!;
    if(request.headers.get('x-protected-manifest')!==manifestSha256||request.headers.get('x-protected-admission')!==admissionSha256)throw new InputError('PROTECTED_HTTP_PINS',403);
    const identity:ProtectedD1Identity={manifestSha256,admissionSha256,target},url=new URL(request.url);
    if(url.search||url.hash)throw new InputError('PROTECTED_HTTP_QUERY');
    const operation=url.pathname.slice('/v1/restore/protected/'.length);
    if(request.method==='GET'&&operation==='status'){
      if(request.body||Number(request.headers.get('content-length'))>0)throw new InputError('PROTECTED_HTTP_BODY');
      return json(await getProtectedD1Status(db,identity));
    }
    if(request.method!=='POST'||!['begin','corpus','text','page','verify','finish'].includes(operation))throw new InputError('PROTECTED_HTTP_ENDPOINT',404);
    const value=await readProtectedRestoreBody(request,['corpus','page','verify'].includes(operation)?MAX_PROTECTED_REQUEST_BYTES:operation==='begin'?16*1024:1024);
    let response:unknown;
    if(operation==='begin'){
      const body=bodyObject(value,['manifest','admission']),admission=body.admission as ProtectedD1Admission;
      if(!admission||admission.compactPlanSha256!==planHash)throw new InputError('PROTECTED_HTTP_PLAN',409);
      response=await beginProtectedD1(db,{manifest:body.manifest as ProtectedManifest,admission,identity});
    }else if(operation==='text'){
      const body=bodyObject(value,['expectedSessionVersion']);
      if(!Number.isSafeInteger(body.expectedSessionVersion)||Number(body.expectedSessionVersion)<0)throw new InputError('PROTECTED_HTTP_VERSION');
      response=await checkProtectedD1Text(db,bucket,identity,Number(body.expectedSessionVersion));
    }else if(operation==='finish'){
      bodyObject(value,[]);response=await finishProtectedD1(db,identity);
    }else{
      const body=bodyObject(value,['page']);
      response=operation==='corpus'?await checkProtectedD1CorpusPage(db,body.page as CompactRestorePage,identity):operation==='page'?await applyProtectedD1Page(db,body.page,identity):await verifyProtectedD1Page(db,body.page,identity);
    }
    return json(response);
  }catch(error){
    if(error instanceof InputError)return json({error:'protected_restore_rejected',code:error.code},error.status);
    if(error instanceof ProtectedStateError)return json({error:'protected_restore_rejected',code:error.code},409);
    // Never suggest an automatic retry: a lost response may have committed.
    return json({error:'protected_restore_failed',code:'PROTECTED_HTTP_FAILURE'},503);
  }
}
