/** Explicit staging-only client. Plan mode never reads credentials or calls a network. */
import { lstat, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkedRestorePlan, checkedTarget, hashJson, type RestorePlan, type StagingRestoreTarget } from '../services/restore/protocol';
import { jsonLines, readCutoverObject, sha256File, verifyTextCutover, type CutoverTextReference, type TextCutoverManifest } from './prepare-text-cutover';
import { parseLegacyReceipt } from './lib/legacy-receipt';

interface RemoteStatus { initialized: boolean; fresh?:boolean; planHash?:string; phase?:string; counts?:{pages:number}; audit?:{complete:boolean;rowsVerified:number;bytesVerified:number} }
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
  return async (path:string,method='GET',body?:unknown,binary=false):Promise<unknown>=>{
    const headers:Record<string,string>={authorization:`Bearer ${token}`,'x-restore-stage':target.stageId,'x-restore-account':target.accountId,
      'x-restore-d1':target.d1Id,'x-restore-r2':target.r2Bucket,'x-restore-plan':planHash};
    if(body!==undefined)headers['content-type']=binary?'text/plain; charset=utf-8':'application/json';
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
export async function restoreTextStaging(options:{bundle:string;target:unknown;execute?:boolean;token?:string;checkpoint?:string;concurrency?:number;
  fetch?:typeof fetch;onProgress?:(value:unknown)=>void}) {
  const target=checkedTarget(options.target);
  const {manifest,plan,planHash}=await stagingPlan(resolve(options.bundle));
  const targetHash=await hashJson(target);
  if(!options.execute)return {execute:false,target,planHash,plan};
  if(!options.checkpoint)throw new Error('Execution requires an explicit local checkpoint path.');
  const concurrency=options.concurrency??4;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Upload concurrency must be between one and eight.');
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
  if(status.phase==='loading'){
    const pack=manifest.objectStorage==='pack'?await open(join(options.bundle,'objects.pack'),'r'):undefined;
    let position=0;let batch:CutoverTextReference[]=[];
    async function flush(){await Promise.all(batch.map(async(reference)=>{
      const bytes=await readCutoverObject(options.bundle,reference,manifest,pack);
      const result=await request(`/v1/restore/object/${reference.contentSha256}`,'PUT',bytes,true) as {verified?:boolean;sha256?:string;bytes?:number};
      if(result.verified!==true||result.sha256!==reference.contentSha256||result.bytes!==reference.bytes)throw new Error('The staging service did not verify an uploaded object.');
    }));checkpoint.uploadedObjects+=batch.length;await saveCheckpoint(options.checkpoint!,checkpoint);options.onProgress?.({uploadedObjects:checkpoint.uploadedObjects});batch=[];}
    try {for await(const row of jsonLines(join(options.bundle,'object-index.jsonl'))){position++;if(position<=checkpoint.uploadedObjects)continue;
      batch.push(row as unknown as CutoverTextReference);if(batch.length===concurrency)await flush();}if(batch.length)await flush();}
    finally {await pack?.close();}
    checkpoint.appliedPages=Number(status.counts?.pages??0);
    for await(const page of jsonLines(join(options.bundle,'fresh-pages.jsonl'))){if(Number(page['page'])<=checkpoint.appliedPages)continue;
      await request('/v1/restore/page','POST',page);checkpoint.appliedPages=Number(page['page']);await saveCheckpoint(options.checkpoint,checkpoint);
      options.onProgress?.({appliedPages:checkpoint.appliedPages});}
    status=await request('/v1/restore/status') as RemoteStatus;
  }
  while(status.phase==='loading'||status.phase==='checking'){status=await request('/v1/restore/publish','POST',{}) as RemoteStatus;options.onProgress?.(status);}
  while(status.phase==='published'){status=await request('/v1/restore/audit','POST',{pages:4}) as RemoteStatus;options.onProgress?.(status.audit);}
  if(status.phase!=='complete'||!status.audit?.complete||status.audit.rowsVerified!==plan.rowCount||status.audit.bytesVerified!==plan.textBytes)throw new Error('The staging service did not complete the full strict text audit.');
  return {execute:true,target,planHash,audit:status.audit};
}

async function main(){const args=process.argv.slice(2);const values=new Map<string,string>();let execute=false;
  for(let at=0;at<args.length;at++){const key=args[at]!;if(key==='--execute'){if(execute)throw new Error('Duplicate --execute.');execute=true;continue;}
    const value=args[++at];if(!['--bundle','--target','--checkpoint','--concurrency'].includes(key)||!value||value.startsWith('--')||values.has(key))throw new Error('Use --bundle <verified bundle> --target <isolated target.json> [--execute --checkpoint <local progress.json>] [--concurrency 1..8].');values.set(key,value);}
  if(!values.get('--bundle')||!values.get('--target'))throw new Error('Both --bundle and --target are required.');
  const targetPath=values.get('--target')!;if((await stat(targetPath)).size>16*1024)throw new Error('The staging target file is too large.');
  const result=await restoreTextStaging({bundle:values.get('--bundle')!,target:JSON.parse(await readFile(targetPath,'utf8')),execute,
    ...(execute?{token:process.env['RESTORE_TOKEN']??'',checkpoint:values.get('--checkpoint')}:{}),
    ...(values.has('--concurrency')?{concurrency:Number(values.get('--concurrency'))}:{}),onProgress:(value)=>console.error(JSON.stringify(value))});
  console.log(JSON.stringify(result,null,2));}
if(process.argv[1]&&/(?:^|[/\\])restore-text-staging\.(?:ts|mjs)$/.test(process.argv[1])&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch((error)=>{console.error(error instanceof Error?error.message:'Staging restore failed.');process.exitCode=1;});}
