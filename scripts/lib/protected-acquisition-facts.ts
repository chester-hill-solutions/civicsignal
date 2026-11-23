/** Import-only fixed source observations. No credential discovery, fetch, CLI,
 * schema migration/profile selection, freeze attestation or production claim.
 * Invoke before/after capture using the SAME finite injected transport owner. */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,writeSync,type BigIntStats} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {PROTECTED_ACQUISITION_SOURCE,type AcquisitionFixtureRequest} from './protected-acquisition';
import {privatePath} from './protected-state';
import type {createFixtureAcquisitionTransport} from './protected-acquisition-transport';

// Existing retained read-set and sequence-import contract. No caller SQL,
// parameters, table names, account, database or URL are accepted.
export const PROTECTED_ACQUISITION_FACT_QUERIES=Object.freeze({
 'd1-schema':'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name COLLATE BINARY LIMIT 65',
 'd1-sequences':"SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name COLLATE BINARY LIMIT 3",
});
type Owner=Pick<Awaited<ReturnType<typeof createFixtureAcquisitionTransport>>,'fixtureOnly'|'management'|'accept'|'snapshot'>;
type SchemaObject={type:'table'|'index'|'trigger'|'view';name:string;tbl_name:string;sql:string|null};
type SequenceFact={presence:'absent'}|{presence:'present';value:number};
type Sequences={corpus_runs:SequenceFact;corpus_changes:SequenceFact};
const names=['corpus_runs','corpus_changes'] as const;
const flags=Object.freeze({fixtureOnly:true,providerAuthenticated:false,globalQuiescenceEstablished:false,
 productionAcquisitionQualified:false,sourceSchemaClassified:false,standaloneAcceptance:false,
 acceptanceRequiresSuccessfulSettledOwner:true});
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export class ProtectedAcquisitionFactsError extends Error {
 constructor(readonly code:string,readonly ioSettled=true){super(code);this.name='ProtectedAcquisitionFactsError';}
}
function demand(value:unknown,code:string):asserts value {if(!value)throw new ProtectedAcquisitionFactsError(code);}
function object(value:unknown):Record<string,unknown>{demand(value!==null&&typeof value==='object'&&!Array.isArray(value),'ACQUISITION_FACTS_SCHEMA');return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:readonly string[]){demand(Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'ACQUISITION_FACTS_SCHEMA');}
function rows(bytes:Uint8Array):unknown[]{
 let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw new ProtectedAcquisitionFactsError('ACQUISITION_FACTS_JSON');}
 const envelope=object(parsed);demand(envelope.success===true&&Array.isArray(envelope.result)&&envelope.result.length===1&&
  (envelope.errors===undefined||Array.isArray(envelope.errors)&&envelope.errors.length===0),'ACQUISITION_FACTS_RESPONSE');
 const result=object(envelope.result[0]);demand(result.success===true&&Array.isArray(result.results)&&
  (result.error===undefined||result.error===null),'ACQUISITION_FACTS_RESPONSE');return result.results;
}
function schema(bytes:Uint8Array):SchemaObject[]{
 const result=rows(bytes);demand(result.length<=64,'ACQUISITION_FACTS_SCHEMA_BOUND');let prior:Buffer|undefined;
 return result.map(raw=>{
  const row=object(raw);exact(row,['type','name','tbl_name','sql']);
  demand(['table','index','trigger','view'].includes(String(row.type))&&typeof row.name==='string'&&row.name.length>0&&
   typeof row.tbl_name==='string'&&row.tbl_name.length>0&&(row.sql===null||typeof row.sql==='string'),'ACQUISITION_FACTS_SCHEMA');
  const identity=Buffer.from(row.type+'\u0000'+row.name,'utf8');demand(!prior||Buffer.compare(identity,prior)>0,'ACQUISITION_FACTS_SCHEMA_ORDER');prior=identity;
  return {type:row.type as SchemaObject['type'],name:row.name,tbl_name:row.tbl_name,sql:row.sql};
 });
}
function sequences(bytes:Uint8Array):Sequences {
 const result=rows(bytes);demand(result.length<=2,'ACQUISITION_FACTS_SEQUENCE_BOUND');let prior='';
 const facts:Sequences={corpus_runs:{presence:'absent'},corpus_changes:{presence:'absent'}};
 for(const raw of result){const row=object(raw);exact(row,['name','seq']);
  demand(typeof row.name==='string'&&names.includes(row.name as typeof names[number])&&row.name>prior&&
   Number.isSafeInteger(row.seq)&&Number(row.seq)>=0,'ACQUISITION_FACTS_SEQUENCE');prior=row.name;
  facts[row.name as typeof names[number]]={presence:'present',value:Number(row.seq)};
 }return facts;
}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
const fileFields=['dev','ino','size','mode','uid','nlink','mtimeNs','ctimeNs'] as const;
function sameFile(expected:BigIntStats,actual:BigIntStats){
 demand(actual.isFile()&&fileFields.every(key=>expected[key]===actual[key]),'ACQUISITION_FACTS_FILE_DRIFT');
}
interface RetainedArtifact {reference:{path:string;bytes:number;sha256:string};identity:BigIntStats}
function save(directory:string,name:string,value:Uint8Array){
 demand(value.byteLength<=512*1024,'ACQUISITION_FACTS_ARTIFACT_BOUND');
 const path=resolve(directory,name),fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 let identity:BigIntStats|undefined;
 try{
  let at=0;while(at<value.length){const n=writeSync(fd,value,at,value.length-at);demand(n>0,'ACQUISITION_FACTS_DURABILITY');at+=n;}fsyncSync(fd);
  const before=fstatSync(fd,{bigint:true}),saved=createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;
  demand(before.isFile()&&before.size===BigInt(value.byteLength)&&before.nlink===1n&&before.uid===BigInt(process.getuid?.()??-1)&&
   (before.mode&0o777n)===0o600n,'ACQUISITION_FACTS_FILE_DRIFT');
  while(position<value.byteLength){const amount=readSync(fd,buffer,0,Math.min(buffer.length,value.byteLength-position),position);
   demand(amount>0,'ACQUISITION_FACTS_FILE_DRIFT');saved.update(buffer.subarray(0,amount));position+=amount;}
  demand(readSync(fd,buffer,0,1,position)===0&&saved.digest('hex')===sha(value),'ACQUISITION_FACTS_FILE_DRIFT');
  const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
  demand(realpathSync(path)===path,'ACQUISITION_FACTS_FILE_DRIFT');sameFile(before,after);sameFile(after,named);identity=after;
 }finally{closeSync(fd);}
 syncDirectory(directory);demand(identity,'ACQUISITION_FACTS_FILE_DRIFT');
 return {reference:{path,bytes:value.length,sha256:sha(value)},identity};
}
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');

export async function captureProtectedAcquisitionFacts(options:{mode:'fixture-only';phase:'before'|'after';captureDirectory:string;owner:Owner}) {
 let directory:string|undefined,requests=0;const owner=options.owner,phase=options.phase,captureDirectory=options.captureDirectory;
 const retained=new Map<string,RetainedArtifact>();
 let identity:{dev:bigint;ino:bigint}|undefined,parentIdentity:{dev:bigint;ino:bigint}|undefined;
 function checkedDirectory(){
  demand(directory&&identity&&parentIdentity,'ACQUISITION_FACTS_DIRECTORY');
  for(const [path,expected]of [[directory,identity],[dirname(directory),parentIdentity]] as const){
   const actual=lstatSync(path,{bigint:true});demand(realpathSync(path)===path&&actual.isDirectory()&&!actual.isSymbolicLink()&&
    actual.dev===expected.dev&&actual.ino===expected.ino&&actual.uid===BigInt(process.getuid?.()??-1)&&
    (actual.mode&0o777n)===0o700n,'ACQUISITION_FACTS_DIRECTORY_DRIFT');
  }
 }
 function retain(name:string,value:Uint8Array){
  checkedDirectory();const saved=save(directory!,name,value);checkedDirectory();retained.set(saved.reference.path,saved);return saved.reference;
 }
 // Keep a semantic failure's safe code while the same owner's checkpoint
 // terminally fences all later management/download work.
 function checkpoint<T>(work:()=>T):T {let failure:unknown;try{return owner.accept(()=>{try{return work();}catch(error){failure=error;throw error;}});}catch(error){throw failure??error;}}
 function revalidateRetained(){
  demand(retained.size>=4&&retained.size<=5,'ACQUISITION_FACTS_ARTIFACT_BOUND');
  const opened:{fd:number;artifact:RetainedArtifact}[]=[];
  const checkedName=(artifact:RetainedArtifact)=>{
   checkedDirectory();const {path}=artifact.reference;
   demand(realpathSync(path)===path,'ACQUISITION_FACTS_FILE_DRIFT');sameFile(artifact.identity,lstatSync(path,{bigint:true}));
  };
  let failure:unknown;
  try{
   for(const artifact of retained.values()){
    checkpoint(()=>{});checkedName(artifact);
    // Check the original identity before opening and again on the descriptor.
    // NONBLOCK also prevents a concurrent FIFO replacement from blocking open.
    const fd=openSync(artifact.reference.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    opened.push({fd,artifact});sameFile(artifact.identity,fstatSync(fd,{bigint:true}));
   }
   // All durability operations precede the final reads. A later artifact's
   // fsync or the final directory fsync cannot invalidate an earlier hash.
   for(const {fd,artifact}of opened){checkpoint(()=>{});fsyncSync(fd);sameFile(artifact.identity,fstatSync(fd,{bigint:true}));}
   checkedDirectory();syncDirectory(directory!);syncDirectory(dirname(directory!));checkpoint(()=>{});
   const buffer=Buffer.alloc(64*1024);
   for(const {fd,artifact}of opened){
    checkpoint(()=>{});checkedName(artifact);sameFile(artifact.identity,fstatSync(fd,{bigint:true}));
    const digest=createHash('sha256');let position=0;
    demand(artifact.reference.bytes<=512*1024,'ACQUISITION_FACTS_ARTIFACT_BOUND');
    while(position<artifact.reference.bytes){
     checkpoint(()=>{});const amount=readSync(fd,buffer,0,Math.min(buffer.length,artifact.reference.bytes-position),position);
     demand(amount>0,'ACQUISITION_FACTS_FILE_DRIFT');digest.update(buffer.subarray(0,amount));position+=amount;
    }
    demand(readSync(fd,buffer,0,1,position)===0&&digest.digest('hex')===artifact.reference.sha256,'ACQUISITION_FACTS_FILE_DRIFT');
    sameFile(artifact.identity,fstatSync(fd,{bigint:true}));checkedName(artifact);checkpoint(()=>{});
   }
   // A later read may expose a concurrent edit to an earlier artifact. Keep
   // every descriptor until all hashes and original metadata have been checked.
   for(const {fd,artifact}of opened){sameFile(artifact.identity,fstatSync(fd,{bigint:true}));checkedName(artifact);}
  }catch(error){failure=error;}
  finally{for(const {fd}of opened)try{closeSync(fd);}catch(error){failure??=error;}}
  if(failure)throw failure;
  for(const artifact of retained.values())checkedName(artifact);
  checkpoint(()=>{});
 }
 try{
  demand(options.mode==='fixture-only'&&owner?.fixtureOnly===true,'ACQUISITION_FACTS_FIXTURE_ONLY');
  demand(phase==='before'||phase==='after','ACQUISITION_FACTS_PHASE');
  checkpoint(()=>{});
  const requested=resolve(captureDirectory);demand(requested===captureDirectory,'ACQUISITION_FACTS_DIRECTORY');
  await privatePath(dirname(requested),true);checkpoint(()=>{});
  checkpoint(()=>{parentIdentity=lstatSync(dirname(requested),{bigint:true});mkdirSync(requested,{mode:0o700});directory=requested;
   identity=lstatSync(requested,{bigint:true});syncDirectory(dirname(requested));
   retain('facts.intent.json',encoded({format:1,kind:'protected-source-facts-intent',...flags,source:PROTECTED_ACQUISITION_SOURCE,
    phase,queries:PROTECTED_ACQUISITION_FACT_QUERIES}));});
  await privatePath(directory!,true);checkpoint(()=>{});
  async function query(kind:keyof typeof PROTECTED_ACQUISITION_FACT_QUERIES){
   const cap=checkpoint(()=>{checkedDirectory();return owner.snapshot().limits.responseBytes;});
   const request:AcquisitionFixtureRequest=Object.freeze({ordinal:++requests,kind,method:'POST',
    url:`https://api.cloudflare.com/client/v4/accounts/${PROTECTED_ACQUISITION_SOURCE.accountId}/d1/database/${PROTECTED_ACQUISITION_SOURCE.d1Id}/query`,
    body:JSON.stringify({sql:PROTECTED_ACQUISITION_FACT_QUERIES[kind]}),credentialScope:'management',responseBytes:cap});
   const reply=await owner.management(request);
   // Preserve a bounded HTTP refusal too, even though the owner is already
   // terminal. Persistence after failure can never restore acceptance.
   const reference=retain(kind+'.raw.json',reply.body);
   checkpoint(()=>{demand(reply.status===200,'ACQUISITION_FACTS_HTTP');});
   return {reference,body:reply.body};
  }
  const observedSchema=await query('d1-schema'),inventory=checkpoint(()=>schema(observedSchema.body));
  const table=inventory.find(row=>row.name==='sqlite_sequence'&&row.type==='table');
  demand(!inventory.some(row=>row.name==='sqlite_sequence'&&row!==table),'ACQUISITION_FACTS_SCHEMA');
  let sequenceFacts:Sequences={corpus_runs:{presence:'absent'},corpus_changes:{presence:'absent'}};
  let sequenceResponse:Awaited<ReturnType<typeof query>>['reference']|null=null;
  if(table){const response=await query('d1-sequences');sequenceFacts=checkpoint(()=>sequences(response.body));sequenceResponse=response.reference;}
  const facts={schema:inventory,sequences:{tablePresence:table?'present':'absent',facts:sequenceFacts}};
  const factsSha256=sha(JSON.stringify(facts));
  const observation=checkpoint(()=>retain('source-facts.json',encoded({format:1,kind:'protected-source-facts-observation',...flags,
   source:PROTECTED_ACQUISITION_SOURCE,phase,facts,factsSha256,
   responses:{schema:observedSchema.reference,sequences:sequenceResponse},queries:PROTECTED_ACQUISITION_FACT_QUERIES})));
  const result={format:1,...flags,factsCaptureComplete:true,phase,requests,schemaObjects:inventory.length,
   sequenceTable:table?'present':'absent',factsSha256,observationSha256:observation.sha256,automaticRetry:false,automaticResume:false};
  checkpoint(()=>retain('facts.result.json',encoded(result)));checkpoint(revalidateRetained);return result;
 }catch(error){
  const code=error instanceof ProtectedAcquisitionFactsError?error.code:'ACQUISITION_FACTS_LOCAL_OR_OWNER';
  try{owner.accept(()=>{throw new ProtectedAcquisitionFactsError(code);});}catch{/* The shared owner remains terminal. */}
  let settled=false;try{settled=owner.snapshot().ioSettled;}catch{/* No settlement proof. */}
  if(directory)try{retain('facts.failure.json',encoded({format:1,...flags,code,requests,ioSettled:settled,preserveAllArtifacts:true,automaticRetry:false,automaticResume:false}));}catch{/* Exclusive directory remains consumed. */}
  throw new ProtectedAcquisitionFactsError(code,settled);
 }
}
