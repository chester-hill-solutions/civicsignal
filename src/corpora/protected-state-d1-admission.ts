/** Fixed logical admission for the sealed format-1 pages; no transport or I/O. */
import { checkedRestorePlan, checkedTarget, hashJson, type RestorePlan, type StagingRestoreTarget } from '../../services/restore/protocol';
import { checkedProtectedManifest, checkedProtectedRow, ProtectedStateError, type ProtectedManifest, type ProtectedScalar } from './protected-state-format';
export interface ProtectedD1Admission {
  format:1; manifestSha256:string; manifestCanonicalSha256:string; pagesSha256:string; protectedChainSha256:string;
  compactPlan:RestorePlan; compactPlanSha256:string; target:StagingRestoreTarget; targetSha256:string;
  sequences:{corpus_runs:number|null;corpus_changes:number|null};
}
export interface ProtectedD1Identity { admissionSha256:string; manifestSha256:string; target:StagingRestoreTarget }
export const ZERO_PROTECTED_CHAIN='0'.repeat(64);
export function protectedD1Assert(value:unknown,code:string):asserts value {if(!value)throw new ProtectedStateError(code);}
export function sameProtectedValue(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
export function compareProtectedD1Keys(a:ProtectedScalar,b:ProtectedScalar):number {
  if(typeof a==='number'&&typeof b==='number')return a-b;
  protectedD1Assert(typeof a==='string'&&typeof b==='string','PROTECTED_KEY_TYPE');
  const left=new TextEncoder().encode(a),right=new TextEncoder().encode(b);
  for(let n=0;n<Math.min(left.length,right.length);n++)if(left[n]!==right[n])return left[n]!-right[n]!;
  return left.length-right.length;
}
export function protectedPublication(plan:RestorePlan):ProtectedScalar[]{const p=plan.publication;return ['statutes-canada',p.commit,p.date,p.asOf,p.rows,p.lastRunAt,p.parser];}
export async function checkedProtectedD1Admission(raw:unknown,manifest:ProtectedManifest,identity:ProtectedD1Identity):Promise<ProtectedD1Admission>{
  checkedProtectedManifest(manifest);
  const a=raw as ProtectedD1Admission;
  protectedD1Assert(a&&a.format===1&&[identity.admissionSha256,identity.manifestSha256,a.manifestSha256,a.manifestCanonicalSha256,a.pagesSha256,a.protectedChainSha256,a.compactPlanSha256,a.targetSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),'PROTECTED_ADMISSION_SHAPE');
  protectedD1Assert(await hashJson(a)===identity.admissionSha256&&a.manifestSha256===identity.manifestSha256&&a.pagesSha256===manifest.pagesSha256&&a.manifestCanonicalSha256===await hashJson(manifest),'PROTECTED_ADMISSION_IDENTITY');
  const target=checkedTarget(identity.target),admitted=checkedTarget(a.target),plan=checkedRestorePlan(a.compactPlan);
  protectedD1Assert(sameProtectedValue(target,admitted)&&a.targetSha256===await hashJson(target)&&a.compactPlanSha256===await hashJson(plan),'PROTECTED_TARGET_IDENTITY');
  const publication=checkedProtectedRow('corpus_state',manifest.initialPublication[0]);
  protectedD1Assert(sameProtectedValue(publication,protectedPublication(plan))&&plan.revision===manifest.revision&&plan.rowCount===manifest.corpusRows&&plan.bundleManifestSha256===manifest.cutoverManifestSha256&&manifest.tables.corpus_state.rows===1,'PROTECTED_PUBLICATION_IDENTITY');
  protectedD1Assert(a.sequences&&Object.keys(a.sequences).sort().join(',')==='corpus_changes,corpus_runs'&&Object.values(a.sequences).every(v=>v===null||Number.isSafeInteger(v)&&Number(v)>=0)&&Object.values(a.sequences).filter(v=>v!==null).length===manifest.tables.sqlite_sequence.rows,'PROTECTED_SEQUENCE_FACTS');
  return a;
}
