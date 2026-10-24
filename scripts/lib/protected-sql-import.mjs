/** Restricted local SQL materialization. No network, extensions or external DBs. */
import { DatabaseSync, constants } from 'node:sqlite';
import { createReadStream, lstatSync, openSync, closeSync, realpathSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedPragmas = new Set(['foreign_keys','defer_foreign_keys']);
const limit = 8 * 1024 * 1024;
function demand(ok, code) { if (!ok) throw new Error(code); }
function leading(sql) {
  for (;;) {
    sql=sql.trimStart();
    if(sql.startsWith('--')) { const end=sql.indexOf('\n');if(end<0)return '';sql=sql.slice(end+1); }
    else if(sql.startsWith('/*')) {const end=sql.indexOf('*/');demand(end>=0,'SQL_SYNTAX');sql=sql.slice(end+2);}
    else return sql;
  }
}
async function* statements(file, consumed) {
  const decoder=new TextDecoder('utf8',{fatal:true});let pending='',statement='',state='normal';
  function* consume(final) {
    let i=0;
    while(i<pending.length){
      const ch=pending[i],next=pending[i+1];
      if(!final&&i===pending.length-1&&"-/'\"`*]".includes(ch))break;
      statement+=ch;i++;demand(statement.length<=limit,'SQL_STATEMENT_LIMIT');
      if(state==='normal'){
        if(ch==="'")state='single';else if(ch==='"')state='double';else if(ch==='`')state='backtick';else if(ch==='[')state='bracket';
        else if(ch==='-'&&next==='-'){statement+=next;i++;state='line';}
        else if(ch==='/'&&next==='*'){statement+=next;i++;state='block';}
        else if(ch===';'){demand(Buffer.byteLength(statement)<=limit,'SQL_STATEMENT_LIMIT');yield statement;statement='';}
      }else if(state==='line'){if(ch==='\n')state='normal';}
      else if(state==='block'){if(ch==='*'&&next==='/'){statement+=next;i++;state='normal';}}
      else {
        const quote={single:"'",double:'"',backtick:'`',bracket:']'}[state];
        if(ch===quote){if(next===quote){statement+=next;i++;}else state='normal';}
      }
    }
    pending=pending.slice(i);
  }
  for await(const chunk of createReadStream(file,{highWaterMark:64*1024})){
    consumed?.(chunk);
    pending+=decoder.decode(chunk,{stream:true});yield*consume(false);
  }
  pending+=decoder.decode();yield*consume(true);
  demand(state==='normal'||state==='line','SQL_SYNTAX');
  if(leading(statement).trim()){demand(Buffer.byteLength(statement)<=limit,'SQL_STATEMENT_LIMIT');yield statement;}
}

const accountId='ad5ec479b9a421faa2ed06c3d1c2b23a',databaseId='8056b1a0-f858-4f89-a332-91f7f350eb7b';
const sequenceNames=['corpus_runs','corpus_changes'];
const sequenceQuery="SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name COLLATE BINARY LIMIT 3";
const digest=/^[a-f0-9]{64}$/,repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function exact(value,keys,code='SQL_SEQUENCE_EVIDENCE'){
  demand(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),code);
}
function privateEvidencePath(path,maximum,directory=false){
  demand(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path,'PRIVATE_SEQUENCE_INPUT');
  const info=lstatSync(path),parent=directory?info:lstatSync(dirname(path)),rel=relative(repository,path);
  demand((rel.startsWith('../')||isAbsolute(rel))&&realpathSync(path)===path&&realpathSync(dirname(path))===dirname(path)&&
    info.uid===process.getuid()&&(info.mode&0o077)===0&&(directory?info.isDirectory():info.isFile()&&info.nlink===1&&info.size<=maximum)&&
    parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o077)===0,'PRIVATE_SEQUENCE_INPUT');
  return info;
}
function evidenceReader(source,destination){
  const seen=new Set();
  function admit(path,maximum){
    const info=privateEvidencePath(path,maximum),identity=info.dev+':'+info.ino;
    demand(path!==destination&&!seen.has(identity),'SQL_SEQUENCE_INPUT_ALIAS');seen.add(identity);return info;
  }
  const sourceInfo=admit(source,2*1024**3);
  privateEvidencePath(dirname(destination),0,true);
  demand(!lstatSync(destination,{throwIfNoEntry:false}),'PRIVATE_SEQUENCE_OUTPUT');
  function read(ref){
    exact(ref,['path','sha256']);demand(digest.test(ref.sha256),'SQL_SEQUENCE_EVIDENCE_HASH');
    const before=admit(ref.path,16*1024),fd=openSync(ref.path,'r'),buffer=Buffer.alloc(16*1024+1);let length=0;
    try{
      const opened=fstatSync(fd);demand(opened.dev===before.dev&&opened.ino===before.ino&&opened.size<=16*1024,'SQL_SEQUENCE_EVIDENCE_HASH');
      while(length<buffer.length){const read=readSync(fd,buffer,length,buffer.length-length,null);if(!read)break;length+=read;}
    }finally{closeSync(fd);}
    const bytes=buffer.subarray(0,length),after=privateEvidencePath(ref.path,16*1024);
    demand(bytes.length<=16*1024&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&sha(bytes)===ref.sha256,'SQL_SEQUENCE_EVIDENCE_HASH');
    return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  }
  return {read,sourceInfo};
}
function sameSource(value,kind,provenance){
  demand(value.format===1&&value.kind===kind&&value.provenance===provenance&&value.accountId===accountId&&value.databaseId===databaseId,'SQL_SEQUENCE_EVIDENCE_SOURCE');
}
function checkedFacts(facts){
  exact(facts,sequenceNames);
  for(const name of sequenceNames){
    const fact=facts[name];
    if(fact?.presence==='absent')exact(fact,['presence']);
    else {exact(fact,['presence','value']);demand(fact.presence==='present'&&Number.isSafeInteger(fact.value)&&fact.value>=0,'SQL_SEQUENCE_EVIDENCE_FACT');}
  }
  return sequenceNames.map(name=>facts[name].presence==='absent'?null:facts[name].value);
}
function checkedObservation(value,provenance,freezeSha256,read){
  exact(value,['format','kind','provenance','accountId','databaseId','query','freezeSha256','success','complete','facts','response']);
  sameSource(value,'protected-sequence-observation',provenance);
  demand(value.query===sequenceQuery&&value.freezeSha256===freezeSha256&&value.success===true&&value.complete===true,'SQL_SEQUENCE_OBSERVATION');
  const facts=checkedFacts(value.facts),raw=read(value.response);
  demand(raw&&raw.success===true&&Array.isArray(raw.result)&&raw.result.length===1&&
    (raw.errors===undefined||Array.isArray(raw.errors)&&raw.errors.length===0),'SQL_SEQUENCE_RAW_RESPONSE');
  const result=raw.result[0];
  demand(result&&result.success===true&&Array.isArray(result.results)&&result.results.length<=2&&
    (result.error===undefined||result.error===null),'SQL_SEQUENCE_RAW_RESPONSE');
  const derived=[null,null];let prior='';
  for(const row of result.results){
    exact(row,['name','seq'],'SQL_SEQUENCE_RAW_RESPONSE');const index=sequenceNames.indexOf(row.name);
    demand(index>=0&&row.name>prior&&Number.isSafeInteger(row.seq)&&row.seq>=0,'SQL_SEQUENCE_RAW_RESPONSE');
    prior=row.name;derived[index]=row.seq;
  }
  demand(JSON.stringify(facts)===JSON.stringify(derived),'SQL_SEQUENCE_OBSERVATION_FACTS');
  return facts;
}
function checkedSequenceEvidence(source,destination,reference){
  const {read,sourceInfo}=evidenceReader(source,destination),evidence=read(reference);
  exact(evidence,['format','kind','provenance','accountId','databaseId','rawSqlSha256','query','freeze','export','before','after']);
  demand(['synthetic','captured'].includes(evidence.provenance)&&digest.test(evidence.rawSqlSha256)&&evidence.query===sequenceQuery,'SQL_SEQUENCE_EVIDENCE');
  sameSource(evidence,'protected-original-sequence-evidence',evidence.provenance);
  const freeze=read(evidence.freeze);
  exact(freeze,['format','kind','provenance','accountId','databaseId','qualified','settled']);
  sameSource(freeze,'protected-common-freeze',evidence.provenance);
  demand(freeze.qualified===true&&freeze.settled===true,'SQL_SEQUENCE_FREEZE_ATTESTATION');
  const exported=read(evidence.export);
  exact(exported,['format','kind','provenance','accountId','databaseId','freezeSha256','rawSqlSha256','passed','settled']);
  sameSource(exported,'protected-d1-export',evidence.provenance);
  demand(exported.passed===true&&exported.settled===true&&exported.freezeSha256===evidence.freeze.sha256&&exported.rawSqlSha256===evidence.rawSqlSha256,'SQL_SEQUENCE_EXPORT_ATTESTATION');
  const before=read(evidence.before),after=read(evidence.after);
  const facts=checkedObservation(before,evidence.provenance,evidence.freeze.sha256,read);
  demand(JSON.stringify(facts)===JSON.stringify(checkedObservation(after,evidence.provenance,evidence.freeze.sha256,read)),'SQL_SEQUENCE_OBSERVATION_CHANGED');
  return {facts,sourceInfo,evidence,evidenceSha256:reference.sha256,proofs:{freezeSha256:evidence.freeze.sha256,exportSha256:evidence.export.sha256,
    beforeSha256:evidence.before.sha256,afterSha256:evidence.after.sha256,beforeResponseSha256:before.response.sha256,afterResponseSha256:after.response.sha256}};
}
function restoreOriginalSequences(db,literalFacts,bridge){
  for(const [index,name] of sequenceNames.entries()){
    const value=bridge.facts[index];
    demand(!literalFacts.has(name)||literalFacts.get(name)===value,'SQL_SEQUENCE_FACT_CONFLICT');
    const maximum=db.prepare(`SELECT coalesce(max(id),0) AS n FROM ${name}`).get().n;
    demand(Number.isSafeInteger(maximum)&&maximum>=0&&(value===null?!db.prepare(`SELECT id FROM ${name} LIMIT 1`).get():value>=maximum),'SQL_SEQUENCE_SOURCE_REQUIRED');
    const existing=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);
    demand(existing.length<=1,'SQL_SEQUENCE_FACT_MISMATCH');
    if(value===null)db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(name);
    else if(existing.length)db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(value,name);
    else db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(name,value);
    const actual=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);
    demand(value===null?actual.length===0:actual.length===1&&actual[0].seq===value,'SQL_SEQUENCE_FACT_MISMATCH');
  }
}
async function materializeProtectedSql(source, destination, bridge=null) {
  const input=resolve(source),output=resolve(destination),info=lstatSync(input),parent=lstatSync(dirname(output));
  demand(realpathSync(input)===input&&info.isFile()&&info.nlink===1&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size<=2*1024**3,'PRIVATE_SQL_INPUT');
  demand(realpathSync(dirname(output))===dirname(output)&&parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o077)===0,'PRIVATE_SQL_OUTPUT');
  if(bridge)demand(info.dev===bridge.sourceInfo.dev&&info.ino===bridge.sourceInfo.ino&&info.size===bridge.sourceInfo.size,'SQL_SEQUENCE_INPUT_CHANGED');
  for(const key of ['SQLITE_OK','SQLITE_DENY','SQLITE_CREATE_TABLE','SQLITE_CREATE_INDEX','SQLITE_READ','SQLITE_INSERT','SQLITE_UPDATE','SQLITE_DELETE','SQLITE_SELECT','SQLITE_TRANSACTION','SQLITE_FUNCTION','SQLITE_PRAGMA'])demand(typeof constants[key]==='number','SQL_AUTHORISER_UNAVAILABLE');
  process.umask(0o077);closeSync(openSync(output,'wx',0o600));
  const db=new DatabaseSync(output,{allowExtension:false,enableForeignKeyConstraints:false});
  let current='',recognizedSequenceWrite=false;const sequenceFacts=new Map();let count=0,consumedBytes=0;const consumed=bridge?createHash('sha256'):null;
  const consume=consumed?chunk=>{consumedBytes+=chunk.length;demand(consumedBytes<=bridge.sourceInfo.size,'SQL_SEQUENCE_CONSUMED_HASH');consumed.update(chunk);}:undefined;
  try{
    demand(typeof db.setAuthorizer==='function','SQL_AUTHORISER_UNAVAILABLE');
    db.exec('BEGIN IMMEDIATE');
    db.setAuthorizer((action,arg1,arg2,dbName)=>{
      if(dbName!==null&&dbName!=='main')return constants.SQLITE_DENY;
      if(action===constants.SQLITE_PRAGMA)return allowedPragmas.has(String(arg1).toLowerCase())&&['0','1','ON','OFF','TRUE','FALSE'].includes(String(arg2).toUpperCase())?constants.SQLITE_OK:constants.SQLITE_DENY;
      if(action===constants.SQLITE_FUNCTION)return ['unixepoch','length'].includes(String(arg2).toLowerCase())?constants.SQLITE_OK:constants.SQLITE_DENY;
      if(action===constants.SQLITE_TRANSACTION)return constants.SQLITE_DENY;
      if(action===constants.SQLITE_CREATE_TABLE||action===constants.SQLITE_CREATE_INDEX)return /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\b/i.test(current)?constants.SQLITE_OK:constants.SQLITE_DENY;
      if([constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action)){
        // Qualified/comment-separated spellings must not bypass the literal
        // fact parser and then be silently overwritten by the bridge.
        if(bridge&&arg1==='sqlite_sequence'&&!recognizedSequenceWrite)return constants.SQLITE_DENY;
        if(arg1==='sqlite_master'||arg1==='sqlite_schema')return /^CREATE\s/i.test(current)?constants.SQLITE_OK:constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      }
      // Dumps insert literal VALUES. SELECT-driven inserts/CTAS can expand a
      // tiny input into unbounded data and are not an accepted dump format.
      return action===constants.SQLITE_READ?constants.SQLITE_OK:constants.SQLITE_DENY;
    });
    for await(const statement of statements(input,consume)){
      current=leading(statement).trim();recognizedSequenceWrite=false;if(!current)continue;
      if(/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?)\s*;?$/i.test(current))continue;
      demand(/^(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\b|INSERT\s+INTO\b|DELETE\s+FROM\b|PRAGMA\s)/i.test(current),'SQL_OPERATION_DENIED');
      if(/^DELETE\s+FROM\s+["`\[]?sqlite_sequence\b/i.test(current)){demand(/^DELETE\s+FROM\s+(?:sqlite_sequence|"sqlite_sequence"|`sqlite_sequence`|\[sqlite_sequence\])\s*;?$/i.test(current),'SQL_SEQUENCE_SYNTAX');recognizedSequenceWrite=true;}
      else demand(!/^DELETE\s/i.test(current),'SQL_OPERATION_DENIED');
      if(/^INSERT\s+INTO\s+["`\[]?sqlite_sequence\b/i.test(current)){
        const match=/^INSERT\s+INTO\s+(?:sqlite_sequence|"sqlite_sequence"|`sqlite_sequence`|\[sqlite_sequence\])\s*(?:\(\s*name\s*,\s*seq\s*\))?\s*VALUES\s*\(\s*'([A-Za-z0-9_]+)'\s*,\s*(\d+)\s*\)\s*;?$/i.exec(current);
        demand(match&&Number.isSafeInteger(Number(match[2])),'SQL_SEQUENCE_SYNTAX');
        recognizedSequenceWrite=true;
        if(['corpus_runs','corpus_changes'].includes(match[1])){demand(!sequenceFacts.has(match[1]),'SQL_SEQUENCE_DUPLICATE');sequenceFacts.set(match[1],Number(match[2]));}
      }
      db.exec(statement);count++;
    }
    if(bridge){
      const after=privateEvidencePath(input,2*1024**3);
      demand(after.dev===bridge.sourceInfo.dev&&after.ino===bridge.sourceInfo.ino&&after.size===bridge.sourceInfo.size&&consumedBytes===bridge.sourceInfo.size&&consumed.digest('hex')===bridge.evidence.rawSqlSha256,'SQL_SEQUENCE_CONSUMED_HASH');
    }else demand(sequenceFacts.has('corpus_runs')&&sequenceFacts.has('corpus_changes'),'SQL_SEQUENCE_FACTS_REQUIRED');
    db.setAuthorizer(null);
    if(bridge)restoreOriginalSequences(db,sequenceFacts,bridge);
    else for(const [name,seq] of sequenceFacts){const actual=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);demand(actual.length===1&&actual[0].seq===seq,'SQL_SEQUENCE_FACT_MISMATCH');}
    demand(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'SQL_IMPORT_INTEGRITY');
    db.exec('COMMIT');return {materialized:true,statements:count};
  }catch(error){
    if(error instanceof Error&&/^[A-Z_]+$/.test(error.message))throw error;
    throw Object.assign(new Error('SQL_IMPORT_REFUSED'),{sqliteCode:typeof error?.errcode==='number'?error.errcode:null,statementOrdinal:count+1});
  }finally{db.setAuthorizer?.(null);db.close();}
}
export async function importProtectedSql(source,destination){return materializeProtectedSql(source,destination);}
/** Explicit offline bridge only. qualified/settled are upstream private
 * attestations, checked for consistency; they establish neither provider
 * authenticity nor the missing production maintenance/acquisition procedure.
 * No SQL is appended/rewritten. Every pre-COMMIT refusal rolls back DDL/data;
 * post-COMMIT close/hash I/O failure refuses acceptance and retains the file.
 * The format-1 evidence pins freeze/export/before/after envelopes; each
 * observation pins an original raw D1 response. All seven JSON inputs are
 * bounded to 16 KiB and require separate canonical private files outside this
 * repository. The exact two facts are present(value) or absent, never inferred
 * from missing/failed query captures. This library adds no execution deadline;
 * callers retain responsibility for an owned finite local process.
 * @param {string} source Unchanged original SQL path.
 * @param {string} destination New private SQLite path.
 * @param {{path:string,sha256:string}} reference Pinned evidence JSON. */
export async function importProtectedSqlWithOriginalSequenceEvidence(source,destination,reference){
  try{
    const input=resolve(source),output=resolve(destination),bridge=checkedSequenceEvidence(input,output,reference);
    const result=await materializeProtectedSql(input,output,bridge),hash=createHash('sha256');
    for await(const chunk of createReadStream(output,{highWaterMark:64*1024}))hash.update(chunk);
    return {...result,sourceKind:'sqlite',sourceSqliteSha256:hash.digest('hex'),rawSqlSha256:bridge.evidence.rawSqlSha256,
      evidenceSha256:bridge.evidenceSha256,provenance:bridge.evidence.provenance,...bridge.proofs,evidenceConsistent:true,
      providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false};
  }catch(error){
    if(error instanceof Error&&/^[A-Z_]+$/.test(error.message))throw error;
    throw new Error('SQL_SEQUENCE_EVIDENCE_REFUSED');
  }
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  try{demand(process.argv.length===4,'SQL_IMPORT_ARGUMENTS');console.log(JSON.stringify(await importProtectedSql(process.argv[2],process.argv[3])));}
  catch(error){const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SQL_IMPORT_REFUSED';console.error(JSON.stringify({failed:true,code,...(Number.isSafeInteger(error?.sqliteCode)?{sqliteCode:error.sqliteCode}:{}),...(Number.isSafeInteger(error?.statementOrdinal)?{statementOrdinal:error.statementOrdinal}:{})}));process.exitCode=1;}
}
