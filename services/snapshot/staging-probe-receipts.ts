import {SNAPSHOT_PARSER_VERSION} from '../../src/ingest/snapshot-format';
import type {SnapshotControlEnv} from './revision-control';
import {SourceHeadError} from '../../src/ingest/source-head';
import type {StagingProbeSourceProof} from './staging-probe-source';
export const SNAPSHOT_STAGE_ID='civicsignal-v1-stage-snapshot-20261022';
export const SNAPSHOT_STAGE_COMMIT='0507465393c224c0491fc8c17c88340217acc656';
export const SNAPSHOT_STAGE_DATE='2026-10-15';
export const SNAPSHOT_PROBE_PREFIX='diagnostics/stage-claimed-probe-v2/';
export const SNAPSHOT_PROBE_MAX_BYTES=1024;
export const SNAPSHOT_PROBE_MARKER='snapshot-staging-probe-v2';
export interface StagingProbeControls extends SnapshotControlEnv {
 SNAPSHOT_STAGE_ID?:string;SNAPSHOT_PROBE_CRON?:string;SNAPSHOT_PROBE_TIME?:string;
}
export interface StagingProbeEvent {cron:string;scheduledTime:number}
type ReceiptPhase='entered'|'completed'|'failed';export type ProbeBucket=Pick<R2Bucket,'get'|'put'|'head'>;
function assertEvent(event:StagingProbeEvent){if(!Number.isSafeInteger(event.scheduledTime)||event.scheduledTime<0||typeof event.cron!=='string'||event.cron.length===0||event.cron.length>128||!/^[\x20-\x7e]+$/.test(event.cron))throw new Error('Snapshot staging probe event is invalid.');}
/** No arbitrary event can consume a source attempt: the reviewed deployment
 * must name one exact cron/time pair. Invalid/missing controls fail closed. */
export function assertStagingProbe(env:StagingProbeControls):StagingProbeEvent {
 if(env.SNAPSHOT_STAGE_ID!==SNAPSHOT_STAGE_ID||env.SNAPSHOT_PINNED_COMMIT!==SNAPSHOT_STAGE_COMMIT||env.SNAPSHOT_PINNED_DATE!==SNAPSHOT_STAGE_DATE||SNAPSHOT_PARSER_VERSION!=='statutes-v2'||typeof env.SNAPSHOT_PROBE_TIME!=='string'||!/^(0|[1-9]\d{0,15})$/.test(env.SNAPSHOT_PROBE_TIME)||typeof env.SNAPSHOT_PROBE_CRON!=='string')throw new Error('Snapshot staging probe configuration is invalid.');
 const event={cron:env.SNAPSHOT_PROBE_CRON,scheduledTime:Number(env.SNAPSHOT_PROBE_TIME)};try{assertEvent(event);const at=new Date(event.scheduledTime),cron=at.getUTCMinutes()+' '+at.getUTCHours()+' '+at.getUTCDate()+' '+(at.getUTCMonth()+1)+' *';if(!Number.isFinite(at.getTime())||event.scheduledTime%60000!==0||event.cron!==cron)throw new Error();}catch{throw new Error('Snapshot staging probe configuration is invalid.');}return event;
}
export async function probeEventPrefix(event:StagingProbeEvent){assertEvent(event);const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(event.cron)));return SNAPSHOT_PROBE_PREFIX+event.scheduledTime+'-'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('')+'/';}
function marker(event:StagingProbeEvent,phase:ReceiptPhase|'duplicate'){console.log(JSON.stringify({marker:SNAPSHOT_PROBE_MARKER,phase,cron:event.cron,scheduledTime:event.scheduledTime}));}
function sourceProof(value:StagingProbeSourceProof):StagingProbeSourceProof {
 if(value.status!==200||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>1048576||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('Snapshot staging source proof is invalid.');
 const rateLimits:StagingProbeSourceProof['rateLimits']={};for(const k of ['limit','remaining','used','reset','retryAfterSeconds'] as const){const n=value.rateLimits[k];if(n!==undefined){if(!Number.isSafeInteger(n)||n<0||k==='retryAfterSeconds'&&n>86400)throw new Error('Snapshot staging source proof is invalid.');rateLimits[k]=n;}}
 return {status:200,bytes:value.bytes,sha256:value.sha256,rateLimits};
}
async function writeReceipt(bucket:ProbeBucket,prefix:string,event:StagingProbeEvent,phase:ReceiptPhase,extra?:{source:StagingProbeSourceProof}|{sourceFailure:{code:string;status?:number;rateLimits?:Readonly<StagingProbeSourceProof['rateLimits']>}}){
 const bytes=new TextEncoder().encode(JSON.stringify({format:2,marker:SNAPSHOT_PROBE_MARKER,stageId:SNAPSHOT_STAGE_ID,commit:SNAPSHOT_STAGE_COMMIT,date:SNAPSHOT_STAGE_DATE,parser:SNAPSHOT_PARSER_VERSION,cron:event.cron,scheduledTime:event.scheduledTime,phase,claimedDelegateLimit:1,...extra,meaning:phase==='completed'?'scheduled discovery returned for an existing publication; no Workflow create or publication is proved':'scheduled handler observation'})+'\n');
 if(bytes.byteLength>SNAPSHOT_PROBE_MAX_BYTES)throw new Error('Snapshot staging probe receipt exceeds its bound.');
 const key=prefix+phase+'.json';const created=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
 const stored=await bucket.get(key);if(!stored||stored.size!==bytes.byteLength||stored.size>SNAPSHOT_PROBE_MAX_BYTES)throw new Error('Snapshot staging probe receipt could not be verified.');const actual=new Uint8Array(await stored.arrayBuffer());if(actual.length!==bytes.length||actual.some((b,i)=>b!==bytes[i]))throw new Error('Snapshot staging probe immutable receipt conflicts.');
 if(created)marker(event,phase);return created!==null&&typeof created==='object';
}
/** entered.json is the persistent conditional claim. Only its acknowledged
 * creator with exact readback may delegate. Lost ACK or any partial failure
 * consumes the event; duplicates never retry source or heal completion. */
export async function runStagingProbe(env:StagingProbeControls&{CORPUS:ProbeBucket},event:StagingProbeEvent,delegate:()=>Promise<StagingProbeSourceProof>):Promise<void>{
 const expected=assertStagingProbe(env);assertEvent(event);if(event.cron!==expected.cron||event.scheduledTime!==expected.scheduledTime)throw new Error('Snapshot staging probe event differs from its approved identity.');
 const prefix=await probeEventPrefix(event);let failure='Snapshot staging probe entry receipt failed.';
 try{
  // A persisted failure also fences a prior entry-write refusal/lost ACK.
  if(await env.CORPUS.head(prefix+'failed.json')){marker(event,'duplicate');return;}
  if(!await writeReceipt(env.CORPUS,prefix,event,'entered')){marker(event,'duplicate');return;}
  failure='Snapshot staging scheduled handler failed.';const source=sourceProof(await delegate());failure='Snapshot staging probe completion receipt failed.';await writeReceipt(env.CORPUS,prefix,event,'completed',{source});
 }catch(error){
  const sourceFailure=error instanceof SourceHeadError?{sourceFailure:{code:error.code,...(error.status===undefined?{}:{status:error.status}),...(Object.keys(error.rateLimits).length?{rateLimits:error.rateLimits}:{})}}:undefined;
  try{await writeReceipt(env.CORPUS,prefix,event,'failed',sourceFailure);}catch{}
  throw new Error(failure);
 }
}
