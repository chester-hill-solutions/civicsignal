/** Explicit staging-only client. Plan mode never reads credentials or calls a network. */
import { lstat, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkedRestorePlan, checkedTarget, hashJson, type RestorePlan, type StagingRestoreTarget } from '../services/restore/protocol';
import { jsonLines, readCutoverObject, sha256File, verifyTextCutover, type CutoverTextReference, type TextCutoverManifest } from './prepare-text-cutover';
import { parseLegacyReceipt } from './lib/legacy-receipt';
import { encodeUploadBatch, MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_BATCH_OBJECTS, UPLOAD_BATCH_CAPABILITIES,
  uploadBatchBytes, verifiedUploadBatchAcknowledgements, type UploadBatchObject } from '../services/restore/upload-batch';
import { AUDIT_CAPABILITIES,METADATA_BATCH_CAPABILITIES,metadataBatchBytes,metadataReferenceBytes,verifiedMetadataAcknowledgements } from '../services/restore/metadata-batch';
import type { CompactRestorePage } from '../src/corpora/compact-restore';

interface RemoteStatus { initialized: boolean; fresh?:boolean; planHash?:string; phase?:string; counts?:{pages:number}; audit?:{complete:boolean;rowsVerified:number;bytesVerified:number};uploadBatch?:typeof UPLOAD_BATCH_CAPABILITIES;metadataBatch?:typeof METADATA_BATCH_CAPABILITIES;auditProtocol?:typeof AUDIT_CAPABILITIES }
interface Checkpoint { format:1; planHash:string; targetHash:string; uploadedObjects:number; appliedPages:number }

export async function stagingPlan(bundle: string) {
  const manifest = await verifyTextCutover(bundle);
  if (!manifest.publication || !manifest.freshPagesChainSha256) throw new Error('Prepare a source-verified bundle with publication metadata and page-chain identity.');
  if (manifest.revision.endsWith(':legacy')) {
    if (!manifest.sourceReceiptSha256) throw new Error('Legacy staging requires the pinned source receipt.');
    const receipt = parseLegacyReceipt(JSON.parse(await readFile(join(bundle,'source-receipt.json'),'utf8')),manifest.publication.commit);
    if (receipt.source.rows !== manifest.rowCount || receipt.source.date !== manifest.publication.date || manifest.publication.parser !== null) throw new Error('The legacy publication differs from the checked source.');
  }
  const plan = checkedRestorePlan({format:1,bundleManifestSha256:await sha256File(join(bundle,'manifest.json')),
    pagesSha256:manifest.freshPagesSha256,pagesChainSha256:manifest.freshPagesChainSha256,schemaSha256:manifest.freshSchemaSha256,
    revision:manifest.revision,rowCount:manifest.rowCount,objectCount:manifest.objectCount,textBytes:manifest.textBytes,
    objectBytes:manifest.objectsBytes,pageCount:manifest.freshPageCount,publication:manifest.publication,
    ...(manifest.sourceReceiptSha256 ? {sourceReceiptSha256:manifest.sourceReceiptSha256}: {})});
  return {manifest,plan,planHash:await hashJson(plan)};
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The staging service returned no status.');
  const chunks:Uint8Array[]=[]; let length=0;
  try { for (;;) {const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;
    if(length>64*1024){await reader.cancel();throw new Error('Staging status exceeds its size bound.');}chunks.push(chunk.value);} }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as unknown;
}

function transport(target:StagingRestoreTarget,planHash:string,token:string,send:typeof fetch) {
  if(token.length<32||token.length>512)throw new Error('Supply RESTORE_TOKEN through the execution environment.');
  return async (path:string,method='GET',body?:unknown,binary=false,contentType?:string):Promise<unknown>=>{
    const headers:Record<string,string>={authorization:`Bearer ${token}`,'x-restore-stage':target.stageId,'x-restore-account':target.accountId,
      'x-restore-d1':target.d1Id,'x-restore-r2':target.r2Bucket,'x-restore-plan':planHash};
    if(body!==undefined)headers['content-type']=contentType??(binary?'text/plain; charset=utf-8':'application/json');
    for(let attempt=0;attempt<4;attempt++){
      let response:Response;
      try {response=await send(new URL(path,target.adminUrl),{method,headers,
        ...(body!==undefined?{body:binary?body as Uint8Array<ArrayBuffer>:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60_000),redirect:'error'});}
      catch {if(attempt===3)throw new Error('The staging service could not be reached; its committed checkpoint is safe to retry.');
        await new Promise((r)=>setTimeout(r,250*2**attempt));continue;}
      if(response.status>=500||response.status===429){await response.body?.cancel();if(attempt<3){await new Promise((r)=>setTimeout(r,250*2**attempt));continue;}}
      if(!response.ok){await response.body?.cancel();throw new Error(`The staging service rejected the step (HTTP ${response.status}); no checkpoint was advanced by this client.`);}
      return boundedJson(response);
    }
    throw new Error('The staging step exhausted its retry bound.');
  };
}

async function saveCheckpoint(path:string,value:Checkpoint) {
  await mkdir(dirname(resolve(path)),{recursive:true});const temporary=`${path}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);
}

/** The caller must explicitly authorize execute and supply an isolated target.
 * fetch injection makes the entire driver testable through local workerd. */
export async function restoreTextStaging(options:{bundle:string;target:unknown;execute?:boolean;token?:string;checkpoint?:string;concurrency?:number;uploadBatchSize?:number;metadataBatchPages?:number;auditCheckpoints?:number;
  fetch?:typeof fetch;onProgress?:(value:unknown)=>void}) {
  const target=checkedTarget(options.target);
  const {manifest,plan,planHash}=await stagingPlan(resolve(options.bundle));
  const targetHash=await hashJson(target);
  if(!options.execute)return {execute:false,target,planHash,plan};
  if(!options.checkpoint)throw new Error('Execution requires an explicit local checkpoint path.');
  const concurrency=options.concurrency??4;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Upload concurrency must be between one and eight.');
  const uploadBatchSize=options.uploadBatchSize??1;
  if(!Number.isSafeInteger(uploadBatchSize)||uploadBatchSize<1||uploadBatchSize>MAX_UPLOAD_BATCH_OBJECTS)throw new Error('Upload batch size must be between one and sixteen.');
  if(uploadBatchSize>1&&concurrency>4)throw new Error('Batched uploads allow at most four concurrent network requests.');
  const metadataBatchPages=options.metadataBatchPages??1;const auditCheckpoints=options.auditCheckpoints??4;
  if(!Number.isSafeInteger(metadataBatchPages)||metadataBatchPages<1||metadataBatchPages>METADATA_BATCH_CAPABILITIES.maxPages)throw new Error('Metadata batch size must be between one and four pages.');
  if(!Number.isSafeInteger(auditCheckpoints)||auditCheckpoints<1||auditCheckpoints>AUDIT_CAPABILITIES.maxCheckpoints)throw new Error('Audit requests contain between one and sixteen checkpoints.');
  const request=transport(target,planHash,options.token??'',options.fetch??fetch);
  let checkpoint:Checkpoint={format:1,planHash,targetHash,uploadedObjects:0,appliedPages:0};
  const exists=await lstat(options.checkpoint).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
  if(exists){if(!exists.isFile()||exists.size>4096)throw new Error('Invalid staging checkpoint.');
    checkpoint=JSON.parse(await readFile(options.checkpoint,'utf8')) as Checkpoint;
    if(checkpoint.format!==1||checkpoint.planHash!==planHash||checkpoint.targetHash!==targetHash||
      !Number.isSafeInteger(checkpoint.uploadedObjects)||checkpoint.uploadedObjects<0||checkpoint.uploadedObjects>manifest.objectCount||
      !Number.isSafeInteger(checkpoint.appliedPages)||checkpoint.appliedPages<0||checkpoint.appliedPages>manifest.freshPageCount)throw new Error('The checkpoint belongs to a different target or bundle.');}
  let status=await request('/v1/restore/status') as RemoteStatus;
  if(!status.initialized){if(!status.fresh)throw new Error('The staging database is populated; no initialization was attempted.');status=await request('/v1/restore/init','POST',plan) as RemoteStatus;}
  if(status.planHash!==planHash)throw new Error('The staging service returned a different plan identity.');
  if(metadataBatchPages>1&&status.phase==='loading'&&(status.metadataBatch?.version!==1||status.metadataBatch.maxPages!==4||
    status.metadataBatch.maxBytes!==METADATA_BATCH_CAPABILITIES.maxBytes||status.metadataBatch.maxReferenceBytes!==METADATA_BATCH_CAPABILITIES.maxReferenceBytes))throw new Error('The staging service does not advertise the bounded metadata-batch protocol.');
  if(auditCheckpoints>4&&status.phase!=='complete'&&(status.auditProtocol?.version!==1||status.auditProtocol.pageRows!==8||status.auditProtocol.maxCheckpoints!==16))throw new Error('The staging service does not advertise the extended bounded audit protocol.');
  if(status.phase==='loading'){
    if(uploadBatchSize>1&&(status.uploadBatch?.version!==UPLOAD_BATCH_CAPABILITIES.version||
      status.uploadBatch.maxObjects!==MAX_UPLOAD_BATCH_OBJECTS||status.uploadBatch.maxBytes!==MAX_UPLOAD_BATCH_BYTES))throw new Error('The staging service does not advertise the bounded upload-batch protocol.');
    const pack=manifest.objectStorage==='pack'?await open(join(options.bundle,'objects.pack'),'r'):undefined;
    let position=0;let batch:CutoverTextReference[]=[];
    async function flush(){await Promise.all(batch.map(async(reference)=>{
      const bytes=await readCutoverObject(options.bundle,reference,manifest,pack);
      const result=await request(`/v1/restore/object/${reference.contentSha256}`,'PUT',bytes,true) as {verified?:boolean;sha256?:string;bytes?:number};
      if(result.verified!==true||result.sha256!==reference.contentSha256||result.bytes!==reference.bytes)throw new Error('The staging service did not verify an uploaded object.');
    }));checkpoint.uploadedObjects+=batch.length;await saveCheckpoint(options.checkpoint!,checkpoint);options.onProgress?.({uploadedObjects:checkpoint.uploadedObjects});batch=[];}
    try {
      if(uploadBatchSize===1){for await(const row of jsonLines(join(options.bundle,'object-index.jsonl'))){position++;if(position<=checkpoint.uploadedObjects)continue;
        batch.push(row as unknown as CutoverTextReference);if(batch.length===concurrency)await flush();}if(batch.length)await flush();}
      else {
        type SourceObject={reference:CutoverTextReference;sourceOrdinal:number};
        type Frame={objects:SourceObject[];single:boolean};
        let pending:SourceObject[]=[];let payloadBytes=0;let wave:Frame[]=[];
        async function sendFrame(frame:Frame){
          const objects:UploadBatchObject[]=[];
          for(const item of frame.objects)objects.push({sourceOrdinal:item.sourceOrdinal,sha256:item.reference.contentSha256,
            bytes:await readCutoverObject(options.bundle,item.reference,manifest,pack)});
          if(frame.single){const item=objects[0]!;const response=await request(`/v1/restore/object/${item.sha256}`,'PUT',item.bytes,true) as {verified?:boolean;sha256?:string;bytes?:number};
            if(response.verified!==true||response.sha256!==item.sha256||response.bytes!==item.bytes.byteLength)throw new Error('The staging service did not verify an uploaded object.');}
          else {const response=await request('/v1/restore/objects','POST',encodeUploadBatch(objects,manifest.objectCount),true,'application/octet-stream');
            if(!verifiedUploadBatchAcknowledgements(response,objects))throw new Error('The staging service did not acknowledge the exact complete upload source range.');}
        }
        async function flushWave(){
          if(!wave.length)return;
          const results=await Promise.allSettled(wave.map(sendFrame));
          const failed=results.find((result)=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
          checkpoint.uploadedObjects+=wave.reduce((sum,frame)=>sum+frame.objects.length,0);
          await saveCheckpoint(options.checkpoint!,checkpoint);options.onProgress?.({uploadedObjects:checkpoint.uploadedObjects});wave=[];
        }
        async function queueFrame(single=false){if(!pending.length)return;wave.push({objects:pending,single});pending=[];payloadBytes=0;if(wave.length===concurrency)await flushWave();}
        for await(const row of jsonLines(join(options.bundle,'object-index.jsonl'))){position++;if(position<=checkpoint.uploadedObjects)continue;
          const reference=row as unknown as CutoverTextReference;
          if(uploadBatchBytes(1,reference.bytes)>MAX_UPLOAD_BATCH_BYTES){await queueFrame();pending=[{reference,sourceOrdinal:position}];await queueFrame(true);continue;}
          if(pending.length&&(pending.length===uploadBatchSize||uploadBatchBytes(pending.length+1,payloadBytes+reference.bytes)>MAX_UPLOAD_BATCH_BYTES))await queueFrame();
          pending.push({reference,sourceOrdinal:position});payloadBytes+=reference.bytes;
        }
        await queueFrame();await flushWave();
      }
    }
    finally {await pack?.close();}
    const remotePages=Number(status.counts?.pages??0);
    if(!Number.isSafeInteger(remotePages)||remotePages<0||remotePages>plan.pageCount)throw new Error('The staging service returned an invalid metadata checkpoint.');
    if(metadataBatchPages===1)checkpoint.appliedPages=remotePages;
    else if(!status.counts||remotePages<checkpoint.appliedPages)throw new Error('The staging metadata journal is behind the durable local checkpoint.');
    // Opt-in batches replay from the durable cursor. A remote prefix without an
    // exact acknowledgement never advances this client's source checkpoint.
    async function recordPage(through:number){checkpoint.appliedPages=through;await saveCheckpoint(options.checkpoint!,checkpoint);options.onProgress?.({appliedPages:checkpoint.appliedPages});}
    async function singlePage(page:CompactRestorePage){const response=await request('/v1/restore/page','POST',page) as {through?:unknown;rows?:unknown;skipped?:unknown};
      if(response.through!==page.through||response.rows!==page.rows||typeof response.skipped!=='boolean')throw new Error('The staging service did not acknowledge the exact metadata page.');await recordPage(page.page);}
    let pendingPages:CompactRestorePage[]=[];
    async function flushPages(){if(!pendingPages.length)return;const response=await request('/v1/restore/pages','POST',{pages:pendingPages});
      if(!verifiedMetadataAcknowledgements(response,pendingPages,planHash))throw new Error('The staging service did not acknowledge the exact complete metadata range.');
      await recordPage(pendingPages.at(-1)!.page);pendingPages=[];}
    for await(const value of jsonLines(join(options.bundle,'fresh-pages.jsonl'))){const page=value as unknown as CompactRestorePage;if(page.page<=checkpoint.appliedPages)continue;
      if(metadataBatchPages===1){await singlePage(page);continue;}
      if(metadataReferenceBytes(page)>METADATA_BATCH_CAPABILITIES.maxReferenceBytes||metadataBatchBytes([page])>METADATA_BATCH_CAPABILITIES.maxBytes){await flushPages();await singlePage(page);continue;}
      const candidate=[...pendingPages,page];
      if(pendingPages.length&&(pendingPages.length===metadataBatchPages||metadataBatchBytes(candidate)>METADATA_BATCH_CAPABILITIES.maxBytes||
        candidate.reduce((sum,item)=>sum+metadataReferenceBytes(item),0)>METADATA_BATCH_CAPABILITIES.maxReferenceBytes))await flushPages();
      pendingPages.push(page);
    }
    await flushPages();
    status=await request('/v1/restore/status') as RemoteStatus;
  }
  while(status.phase==='loading'||status.phase==='checking'){status=await request('/v1/restore/publish','POST',{}) as RemoteStatus;options.onProgress?.(status);}
  while(status.phase==='published'){status=await request('/v1/restore/audit','POST',{pages:auditCheckpoints}) as RemoteStatus;options.onProgress?.(status.audit);}
  if(status.phase!=='complete'||!status.audit?.complete||status.audit.rowsVerified!==plan.rowCount||status.audit.bytesVerified!==plan.textBytes)throw new Error('The staging service did not complete the full strict text audit.');
  return {execute:true,target,planHash,audit:status.audit};
}

async function main(){const args=process.argv.slice(2);const values=new Map<string,string>();let execute=false;
  for(let at=0;at<args.length;at++){const key=args[at]!;if(key==='--execute'){if(execute)throw new Error('Duplicate --execute.');execute=true;continue;}
    const value=args[++at];if(!['--bundle','--target','--checkpoint','--concurrency','--upload-batch-size','--metadata-batch-pages','--audit-checkpoints'].includes(key)||!value||value.startsWith('--')||values.has(key))throw new Error('Use --bundle <verified bundle> --target <isolated target.json> [--execute --checkpoint <local progress.json>] [--concurrency 1..8] [--upload-batch-size 1..16] [--metadata-batch-pages 1..4] [--audit-checkpoints 1..16].');values.set(key,value);}
  if(!values.get('--bundle')||!values.get('--target'))throw new Error('Both --bundle and --target are required.');
  const targetPath=values.get('--target')!;if((await stat(targetPath)).size>16*1024)throw new Error('The staging target file is too large.');
  const result=await restoreTextStaging({bundle:values.get('--bundle')!,target:JSON.parse(await readFile(targetPath,'utf8')),execute,
    ...(execute?{token:process.env['RESTORE_TOKEN']??'',checkpoint:values.get('--checkpoint')}:{}),
    ...(values.has('--concurrency')?{concurrency:Number(values.get('--concurrency'))}:{}),
    ...(values.has('--upload-batch-size')?{uploadBatchSize:Number(values.get('--upload-batch-size'))}:{}),
    ...(values.has('--metadata-batch-pages')?{metadataBatchPages:Number(values.get('--metadata-batch-pages'))}:{}),
    ...(values.has('--audit-checkpoints')?{auditCheckpoints:Number(values.get('--audit-checkpoints'))}:{}),onProgress:(value)=>console.error(JSON.stringify(value))});
  console.log(JSON.stringify(result,null,2));}
if(process.argv[1]&&/(?:^|[/\\])restore-text-staging\.(?:ts|mjs)$/.test(process.argv[1])&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch((error)=>{console.error(error instanceof Error?error.message:'Staging restore failed.');process.exitCode=1;});}
