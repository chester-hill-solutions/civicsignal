/** Offline sidecar preparation. Original format-1 files are never rewritten. */
import {openSync,closeSync,fsyncSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {loadProtectedStatePlan,privatePath} from './protected-state';
import {jsonLines,sha256File} from '../prepare-text-cutover';
import {stagingPlan} from '../restore-text-staging';
import {checkedTarget,hashJson,nextPageChain} from '../../services/restore/protocol';
import {checkedProtectedPage,checkedProtectedRow,PROTECTED_TABLE_ORDER,type ProtectedScalar} from '../../src/corpora/protected-state-format';
import {checkedProtectedD1Admission,compareProtectedD1Keys,protectedD1Assert as demand,ZERO_PROTECTED_CHAIN,type ProtectedD1Admission} from '../../src/corpora/protected-state-d1-admission';
export async function prepareProtectedD1Admission(options:{directory:string;manifestSha256:string;cutoverBundle:string;target:unknown;outputPath:string}){
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
 const output=resolve(options.outputPath);await privatePath(dirname(output),true);
 const fd=openSync(output,'wx',0o600);try{writeFileSync(fd,JSON.stringify(admission)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(dirname(output),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
 return {admissionSha256,fileSha256:await sha256File(output),pages:manifest.pages,protectedChainSha256:chain};
}
