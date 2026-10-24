import { applyCompactRestorePage, verifyCompactRestorePage, type CompactRestorePage } from '../../src/corpora/compact-restore';
import { readVerifiedProvisionText, type ProvisionTextReference, type TextObjectReader } from '../../src/corpora/text-store';
import { RestoreInputError, type RestorePlan } from './protocol';

export const METADATA_BATCH_CAPABILITIES={version:1,maxPages:4,maxBytes:128*1024,maxReferenceBytes:16*1024*1024} as const;
export const AUDIT_CAPABILITIES={version:1,pageRows:8,maxCheckpoints:16} as const;
export interface MetadataAcknowledgement {page:number;sha256:string;fromAfter:string;through:string;rows:number;skipped:boolean}

export function metadataReferenceBytes(page:CompactRestorePage):number {
  return page.statements.filter((_statement,at)=>at%2===1).reduce((sum,statement)=>sum+Number(statement.params[5]),0);
}
export function metadataBatchBytes(pages:readonly CompactRestorePage[]):number {
  return new TextEncoder().encode(JSON.stringify({pages})).byteLength;
}

/** Validate the complete source range before a binding write. The publication
 * still independently rechecks the full ordered journal against its pinned root. */
export async function checkedMetadataBatch(value:unknown,maximumPage:number):Promise<CompactRestorePage[]> {
  const pages=(value as {pages?:unknown}|null)?.pages;
  if(!Array.isArray(pages)||pages.length<1||pages.length>METADATA_BATCH_CAPABILITIES.maxPages)throw new RestoreInputError('A metadata batch contains between one and four pages.');
  const checked=pages as CompactRestorePage[];let references=0;
  for(let at=0;at<checked.length;at++){
    const page=checked[at]!;
    try{await verifyCompactRestorePage(page);}catch{throw new RestoreInputError('Invalid checked metadata page.',422);}
    if(page.page>maximumPage||at>0&&(page.page!==checked[at-1]!.page+1||page.fromAfter!==checked[at-1]!.through))throw new RestoreInputError('Metadata batch source ranges must be contiguous and within the plan.',422);
    references+=metadataReferenceBytes(page);
  }
  if(metadataBatchBytes(checked)>METADATA_BATCH_CAPABILITIES.maxBytes)throw new RestoreInputError('The metadata batch exceeds 128 KiB.',413);
  if(references>METADATA_BATCH_CAPABILITIES.maxReferenceBytes)throw new RestoreInputError('The metadata batch references more than 16 MiB of text.',413);
  return checked;
}

export async function applyMetadataBatch(db:D1Database,bucket:TextObjectReader,plan:RestorePlan,pages:CompactRestorePage[]):Promise<MetadataAcknowledgement[]> {
  const first=pages[0]!;const last=pages.at(-1)!;
  // At most four requested rows, their predecessor and the latest checkpoint.
  const recorded=await db.prepare(`SELECT page,sha256,after_id,row_count FROM corpus_compact_pages
    WHERE (page>=? AND page<=?) OR page=(SELECT max(page) FROM corpus_compact_pages) ORDER BY page`)
    .bind(first.page-1,last.page).all<{page:number;sha256:string;after_id:string;row_count:number}>();
  const journal=new Map(recorded.results.map((row)=>[row.page,row]));
  const latest=recorded.results.at(-1);let next=latest?.page??0;let after=latest?.after_id??'';
  if(first.fromAfter!==(first.page===1?'':journal.get(first.page-1)?.after_id))throw new RestoreInputError('The metadata predecessor cursor differs.',409);
  for(const page of pages){const existing=journal.get(page.page);
    if(existing){if(existing.sha256!==page.sha256||existing.after_id!==page.through||existing.row_count!==page.rows)throw new RestoreInputError('A different metadata page occupies the checkpoint.',409);}
    else {if(page.page!==next+1||page.fromAfter!==after)throw new RestoreInputError('Metadata pages must follow the current checkpoint.',409);next=page.page;after=page.through;}}
  const references:ProvisionTextReference[]=pages.flatMap((page)=>page.statements.filter((_statement,at)=>at%2===1).map(({params})=>({
    rowId:String(params[0]),corpusId:String(params[1]),rowFingerprint:String(params[2]),contentSha256:String(params[3]),objectKey:String(params[4]),bytes:Number(params[5]),createdAt:String(params[6])})));
  let position=0;let failed=false;let failure:unknown;
  async function worker(){while(!failed&&position<references.length){const reference=references[position++]!;try{await readVerifiedProvisionText(bucket,reference);}catch(error){failed=true;failure=error;}}}
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,references.length)},()=>worker()));
  const unexpected=outcomes.find((outcome)=>outcome.status==='rejected');if(unexpected?.status==='rejected')throw unexpected.reason;
  if(failed)throw failure;
  // Keep each original page transaction separate and strictly sequential.
  const acknowledgements:MetadataAcknowledgement[]=[];
  for(const page of pages){const result=await applyCompactRestorePage(db,page,{bundleSha256:plan.pagesSha256,revision:plan.revision});
    acknowledgements.push({page:page.page,sha256:page.sha256,fromAfter:page.fromAfter,through:result.through,rows:result.rows,skipped:result.skipped});}
  return acknowledgements;
}

export function verifiedMetadataAcknowledgements(value:unknown,pages:readonly CompactRestorePage[],planHash:string):boolean {
  const response=value as {verified?:unknown;planHash?:unknown;pages?:unknown}|null;
  if(response?.verified!==true||response.planHash!==planHash||!Array.isArray(response.pages)||response.pages.length!==pages.length)return false;
  const expected=new Map(pages.map((page)=>[page.page,page]));
  for(const value of response.pages){const ack=value as Partial<MetadataAcknowledgement>|null;const page=ack?expected.get(ack.page!):undefined;
    if(!page||ack?.sha256!==page.sha256||ack.fromAfter!==page.fromAfter||ack.through!==page.through||ack.rows!==page.rows||typeof ack.skipped!=='boolean')return false;
    expected.delete(page.page);}
  return expected.size===0;
}
