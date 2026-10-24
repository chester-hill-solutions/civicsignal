/** One fixed staging metadata attempt. No credential path, retries or source files. */
import {requestSourceHead,parseSourceHeadRateLimits,SourceHeadError,SOURCE_HEAD_MAX_BYTES,SOURCE_HEAD_TIMEOUT_MS,
  type SourceHeadSend,type SourceHeadRateLimits} from '../../src/ingest/source-head';
import type {CorpusRevision} from '../../src/ingest/source';
const API='https://api.github.com/repos/justicecanada/laws-lois-xml';
const URL=API+'/commits?sha=main&per_page=1';
export interface StagingProbeSourceProof { status:200;bytes:number;sha256:string;rateLimits:SourceHeadRateLimits }
/** The existing parser receives a native bounded Response. Absolute checks on
 * the original stream and after parsing close timer starvation without changing
 * the shared source helper, which is pinned by other prepared releases. */
export async function stagingProbeHead(options:{send?:SourceHeadSend;now?:()=>number;timeoutMs?:number}={}):Promise<{revision:CorpusRevision;proof:StagingProbeSourceProof}>{
 const now=options.now??(()=>performance.now()),started=now(),ms=options.timeoutMs??SOURCE_HEAD_TIMEOUT_MS;
 if(!Number.isFinite(started)||!Number.isFinite(ms)||ms<=0||ms>SOURCE_HEAD_TIMEOUT_MS)throw new SourceHeadError('timeout');
 const deadline=started+ms,controller=new AbortController();let response:Response|undefined,reader:{read():Promise<{done:boolean;value?:Uint8Array}>;cancel():Promise<void>;releaseLock():void}|undefined,sending=false,reading=false,sent=false,raw:Uint8Array<ArrayBuffer>|undefined;
 let cleanup:Promise<boolean>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const check=()=>{const at=now();if(!Number.isFinite(at)||at<started||at>=deadline||controller.signal.aborted)throw new SourceHeadError('timeout');};
 const cancel=()=>cleanup??=(async()=>{try{if(reader)await reader.cancel();else if(response?.body)await response.body.cancel();return !sending&&!reading;}catch{return false;}finally{try{reader?.releaseLock();}catch{}}})();
 const settled=async()=>{const pending=cancel(),remaining=deadline-now();if(remaining<=0){void pending;return false;}let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([pending,new Promise<false>(r=>{timer=setTimeout(()=>r(false),remaining);})]);}finally{if(timer)clearTimeout(timer);}};
 const send:SourceHeadSend=async(url)=>{
  check();if(sent||url!==URL)throw new SourceHeadError('transport');sent=true;sending=true;
  try{response=await(options.send??fetch)(URL,{method:'GET',headers:{accept:'application/vnd.github+json','user-agent':'civicsignal-staging-snapshot-probe'},redirect:'manual',signal:controller.signal});}finally{sending=false;}
  // Capture/dispose a late fulfilled fetch even if timeout cleanup ran before
  // there was a response. No second request can ever be selected.
  if(controller.signal.aborted||now()>=deadline){if(response.body)void response.body.cancel().catch(()=>{});check();}check();
  if(response.redirected||response.url&&response.url!==URL)throw new SourceHeadError('redirect-refused',response.status,parseSourceHeadRateLimits(response.headers));
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>SOURCE_HEAD_MAX_BYTES))throw new SourceHeadError('response-too-large');
  const chunks:Uint8Array[]=[];let size=0;
  if(response.body){reader=response.body.getReader();for(;;){check();reading=true;let next;try{next=await reader.read();}finally{reading=false;}check();if(next.done)break;if(!(next.value instanceof Uint8Array))throw new SourceHeadError('invalid-response');size+=next.value.byteLength;if(size>SOURCE_HEAD_MAX_BYTES)throw new SourceHeadError('response-too-large');if(next.value.byteLength)chunks.push(next.value);}}
  raw=new Uint8Array(size);let at=0;for(const c of chunks){raw.set(c,at);at+=c.byteLength;}check();
  const headers=new Headers(response.headers);headers.set('content-length',String(size));return new Response(raw,{status:response.status,headers});
 };
 try{
  const work=async()=>{check();const revision=await requestSourceHead(API,'main',{},send);check();if(!response||response.status!==200||!raw)throw new SourceHeadError('invalid-response');const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',raw));check();const proof:StagingProbeSourceProof={status:200,bytes:raw.length,sha256:Array.from(digest,b=>b.toString(16).padStart(2,'0')).join(''),rateLimits:parseSourceHeadRateLimits(response.headers)};return {revision,proof};};
  const value=await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void cancel();reject(new SourceHeadError('timeout'));},Math.max(0,deadline-now()));})]);
  if(!await settled())throw new SourceHeadError('timeout');check();return value;
 }catch(e){throw e instanceof SourceHeadError?e:new SourceHeadError(controller.signal.aborted?'timeout':'transport');}
 finally{if(timer)clearTimeout(timer);controller.abort();void cancel();}
}
