/** Offline sidecar preparation. Original format-1 files are never rewritten. */
import {openSync,closeSync,fsyncSync,writeFileSync} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadProtectedStatePlan,privatePath} from './protected-state';
import {jsonLines,sha256File} from '../prepare-text-cutover';
import {stagingPlan} from '../restore-text-staging';
import {checkedTarget,hashJson,nextPageChain} from '../../services/restore/protocol';
import {verifyCompactRestorePage,type CompactRestorePage} from '../../src/corpora/compact-restore';
import {checkedProtectedPage,checkedProtectedRow,PROTECTED_TABLE_ORDER,type ProtectedScalar} from '../../src/corpora/protected-state-format';
import {checkedProtectedD1Admission,compareProtectedD1Keys,protectedD1Assert as demand,ZERO_PROTECTED_CHAIN,type ProtectedD1Admission} from '../../src/corpora/protected-state-d1-admission';
export interface ProtectedD1SourceOptions {directory:string;manifestSha256:string;cutoverBundle:string;target:unknown}
async function validatedSources(options:ProtectedD1SourceOptions){
 demand((await stat(await privatePath(resolve(options.directory,'manifest.json')))).size<=16*1024,'PROTECTED_D1_MANIFEST_BOUND');
 const {manifest,pagesPath}=await loadProtectedStatePlan(options.directory,options.manifestSha256),{plan,planHash}=await stagingPlan(options.cutoverBundle),target=checkedTarget(options.target);
 checkedProtectedRow('corpus_state',manifest.initialPublication[0]);
 let chain=ZERO_PROTECTED_CHAIN,last=-1,key:ProtectedScalar=null;
 const sequences:ProtectedD1Admission['sequences']={corpus_runs:null,corpus_changes:null};
 for await(const raw of jsonLines(pagesPath)){
  const page=await checkedProtectedPage(raw),index=PROTECTED_TABLE_ORDER.indexOf(page.table);if(index!==last)key=null;
  for(const row of page.rows){demand(key===null||compareProtectedD1Keys(row[0]!,key)>0,'PROTECTED_D1_KEY_ORDER');key=row[0]!;
   if(page.table==='sqlite_sequence'){const name=row[0] as keyof typeof sequences;demand(sequences[name]===null,'PROTECTED_SEQUENCE_FACTS');sequences[name]=Number(row[1]);}}
  last=index;chain=await nextPageChain(chain,page.sha256);
 }
 for(const name of ['corpus_runs','corpus_changes'] as const)demand(sequences[name]!==null||manifest.tables[name].rows===0,'PROTECTED_SEQUENCE_FACTS');
 const admission:ProtectedD1Admission={format:1,manifestSha256:options.manifestSha256,manifestCanonicalSha256:await hashJson(manifest),pagesSha256:manifest.pagesSha256,protectedChainSha256:chain,compactPlan:plan,compactPlanSha256:planHash,target,targetSha256:await hashJson(target),sequences};
 const admissionSha256=await hashJson(admission);await checkedProtectedD1Admission(admission,manifest,{admissionSha256,manifestSha256:options.manifestSha256,target});
 demand(await sha256File(pagesPath)===manifest.pagesSha256&&await sha256File(resolve(options.directory,'manifest.json'))===options.manifestSha256,'INPUT_CHANGED');
 return {manifest,pagesPath,admission,admissionSha256,target};
}
export async function prepareProtectedD1Admission(options:ProtectedD1SourceOptions&{outputPath:string}){
 const {admission,admissionSha256,manifest}=await validatedSources(options);
 const output=resolve(options.outputPath);await privatePath(dirname(output),true);
 const fd=openSync(output,'wx',0o600);try{writeFileSync(fd,JSON.stringify(admission)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(dirname(output),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
 return {admissionSha256,fileSha256:await sha256File(output),pages:manifest.pages,protectedChainSha256:admission.protectedChainSha256};
}
/** Read-only source sealing before credentials. Full mode also derives the
 * exact text-byte and protected-page prefixes used by every later phase. */
export async function loadProtectedD1ClientPlan(options:ProtectedD1SourceOptions&{admissionPath:string;admissionSha256:string;admissionFileSha256:string},full=false){
 const source=await validatedSources(options),path=await privatePath(options.admissionPath);
 demand((await stat(path)).size<=16*1024&&await sha256File(path)===options.admissionFileSha256,'PROTECTED_D1_ADMISSION_FILE');
 const admission=JSON.parse(await readFile(path,'utf8')) as ProtectedD1Admission;
 demand(await hashJson(admission)===options.admissionSha256&&source.admissionSha256===options.admissionSha256,'PROTECTED_D1_ADMISSION_IDENTITY');
 const identity={manifestSha256:options.manifestSha256,admissionSha256:options.admissionSha256,target:source.target};
 await checkedProtectedD1Admission(admission,source.manifest,identity);
 const compactPagesPath=resolve(options.cutoverBundle,'fresh-pages.jsonl');
 const prefixes=[{page:0,rows:0,chain:ZERO_PROTECTED_CHAIN,bodySha256:''}],textPrefixes=[{rows:0,bytes:0}];let textRows=0,textBytes=0;
 for await(const raw of jsonLines(compactPagesPath)){
  demand(Buffer.byteLength(JSON.stringify(raw))<=64*1024,'PROTECTED_D1_COMPACT_BOUNDS');
  if(full){
   const page=raw as unknown as CompactRestorePage;await verifyCompactRestorePage(page);
   for(let at=0;at<page.rows;at++){
    textRows++;textBytes+=Number(page.statements[at*2+1]!.params[5]);demand(Number.isSafeInteger(textBytes),'PROTECTED_D1_TEXT_BYTES');
    if(textRows%8===0)textPrefixes.push({rows:textRows,bytes:textBytes});
   }
  }
  const prior=prefixes.at(-1)!;prefixes.push({page:Number(raw['page']),rows:prior.rows+Number(raw['rows']),chain:await nextPageChain(prior.chain,String(raw['sha256'])),bodySha256:await hashJson({page:raw})});
 }
 demand(await sha256File(path)===options.admissionFileSha256&&await sha256File(compactPagesPath)===admission.compactPlan.pagesSha256&&await sha256File(resolve(options.cutoverBundle,'manifest.json'))===admission.compactPlan.bundleManifestSha256&&prefixes.length===admission.compactPlan.pageCount+1&&prefixes.at(-1)?.chain===admission.compactPlan.pagesChainSha256,'INPUT_CHANGED');
 if(full&&textRows%8!==0)textPrefixes.push({rows:textRows,bytes:textBytes});
 const protectedPrefixes=[{page:0,rows:0,chain:ZERO_PROTECTED_CHAIN,bodySha256:'',counts:Object.fromEntries(PROTECTED_TABLE_ORDER.map(table=>[table,0]))}];
 if(full){
  for await(const raw of jsonLines(source.pagesPath)){
   const page=await checkedProtectedPage(raw),prior=protectedPrefixes.at(-1)!;
   protectedPrefixes.push({page:page.page,rows:prior.rows+page.rows.length,chain:await nextPageChain(prior.chain,page.sha256),bodySha256:await hashJson({page:raw}),counts:{...prior.counts,[page.table]:prior.counts[page.table]!+page.rows.length}});
  }
  demand(textRows===source.manifest.corpusRows&&textBytes===admission.compactPlan.textBytes&&textPrefixes.length===Math.ceil(textRows/8)+1&&protectedPrefixes.length===source.manifest.pages+1&&protectedPrefixes.at(-1)?.chain===admission.protectedChainSha256&&PROTECTED_TABLE_ORDER.every(table=>protectedPrefixes.at(-1)!.counts[table]===source.manifest.tables[table].rows),'PROTECTED_D1_FULL_PREFIX');
  demand(await sha256File(source.pagesPath)===source.manifest.pagesSha256&&await sha256File(compactPagesPath)===admission.compactPlan.pagesSha256&&await sha256File(path)===options.admissionFileSha256&&await sha256File(resolve(options.directory,'manifest.json'))===options.manifestSha256&&await sha256File(resolve(options.cutoverBundle,'manifest.json'))===admission.compactPlan.bundleManifestSha256,'INPUT_CHANGED');
 }
 const finalVersion=2*admission.compactPlan.pageCount+textPrefixes.length-1+2*source.manifest.pages+1;
 if(full)demand(Number.isSafeInteger(finalVersion)&&Number.isSafeInteger(finalVersion+1),'PROTECTED_D1_FULL_PREFIX');
 const pins={format:1,slice:full?'full-copy-v1':'initial-admission-v1',manifestSha256:identity.manifestSha256,admissionSha256:identity.admissionSha256,admissionFileSha256:options.admissionFileSha256,targetSha256:admission.targetSha256,compactPlanSha256:admission.compactPlanSha256,protectedPagesSha256:source.manifest.pagesSha256,compactPagesSha256:admission.compactPlan.pagesSha256};
 const beginBody=JSON.stringify({manifest:source.manifest,admission});demand(Buffer.byteLength(beginBody)<=16*1024,'PROTECTED_D1_BEGIN_BOUND');
 return {...source,admission,identity,compactPagesPath,prefixes,pins,full:full?{textPrefixes,protectedPrefixes,finalVersion}:undefined,beginBodySha256:await hashJson({manifest:source.manifest,admission}),planSha256:await hashJson(pins)};
}
