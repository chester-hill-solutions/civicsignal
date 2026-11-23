/// <reference path="./env.d.ts" />
import {runSnapshotScheduled} from './worker';
import {assertStagingProbe,runStagingProbe,SNAPSHOT_PROBE_MARKER,SNAPSHOT_STAGE_ID,SNAPSHOT_STAGE_COMMIT,SNAPSHOT_STAGE_DATE,type StagingProbeControls} from './staging-probe-receipts';
import {SNAPSHOT_PARSER_VERSION} from '../../src/ingest/snapshot-format';
import {stagingProbeHead,type StagingProbeSourceProof} from './staging-probe-source';
export {CorpusSnapshot} from './worker';
type ProbeEnv=SnapshotEnv&StagingProbeControls;
export default {
 async fetch(request:Request,env:ProbeEnv):Promise<Response>{
  const url=new URL(request.url);if(request.method!=='GET'||url.pathname!=='/health'||url.search)return new Response('Not found',{status:404});
  let event;try{event=assertStagingProbe(env);}catch{return Response.json({error:'Snapshot staging probe configuration is invalid.'},{status:503});}
  console.log(JSON.stringify({marker:SNAPSHOT_PROBE_MARKER,phase:'health'}));return Response.json({marker:SNAPSHOT_PROBE_MARKER,stageId:SNAPSHOT_STAGE_ID,commit:SNAPSHOT_STAGE_COMMIT,date:SNAPSHOT_STAGE_DATE,parser:SNAPSHOT_PARSER_VERSION,approvedCron:event.cron,approvedTime:event.scheduledTime});
 },
 async scheduled(event:ScheduledController,env:ProbeEnv):Promise<void>{
  await runStagingProbe(env,event,async()=>{
   let source:StagingProbeSourceProof|undefined,selected=false;
   await runSnapshotScheduled(env,{requirePublished:true,head:async()=>{if(selected)throw new Error('Snapshot staging source was already selected.');selected=true;const result=await stagingProbeHead();source=result.proof;return result.revision;}});
   if(!source)throw new Error('Snapshot staging source proof is missing.');return source;
  });
 },
};
