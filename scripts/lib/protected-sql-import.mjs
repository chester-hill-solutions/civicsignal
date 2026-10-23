/** Restricted local SQL materialization. No network, extensions or external DBs. */
import { DatabaseSync, constants } from 'node:sqlite';
import { createReadStream, lstatSync, openSync, closeSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
async function* statements(file) {
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
    pending+=decoder.decode(chunk,{stream:true});yield*consume(false);
  }
  pending+=decoder.decode();yield*consume(true);
  demand(state==='normal'||state==='line','SQL_SYNTAX');
  if(leading(statement).trim()){demand(Buffer.byteLength(statement)<=limit,'SQL_STATEMENT_LIMIT');yield statement;}
}

export async function importProtectedSql(source, destination) {
  const input=resolve(source),output=resolve(destination),info=lstatSync(input),parent=lstatSync(dirname(output));
  demand(realpathSync(input)===input&&info.isFile()&&info.nlink===1&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size<=2*1024**3,'PRIVATE_SQL_INPUT');
  demand(realpathSync(dirname(output))===dirname(output)&&parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o077)===0,'PRIVATE_SQL_OUTPUT');
  for(const key of ['SQLITE_OK','SQLITE_DENY','SQLITE_CREATE_TABLE','SQLITE_CREATE_INDEX','SQLITE_READ','SQLITE_INSERT','SQLITE_UPDATE','SQLITE_DELETE','SQLITE_SELECT','SQLITE_TRANSACTION','SQLITE_FUNCTION','SQLITE_PRAGMA'])demand(typeof constants[key]==='number','SQL_AUTHORISER_UNAVAILABLE');
  process.umask(0o077);closeSync(openSync(output,'wx',0o600));
  const db=new DatabaseSync(output,{allowExtension:false,enableForeignKeyConstraints:false});
  let current='';const sequenceFacts=new Map();let count=0;
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
        if(arg1==='sqlite_master'||arg1==='sqlite_schema')return /^CREATE\s/i.test(current)?constants.SQLITE_OK:constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      }
      // Dumps insert literal VALUES. SELECT-driven inserts/CTAS can expand a
      // tiny input into unbounded data and are not an accepted dump format.
      return action===constants.SQLITE_READ?constants.SQLITE_OK:constants.SQLITE_DENY;
    });
    for await(const statement of statements(input)){
      current=leading(statement).trim();if(!current)continue;
      if(/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?)\s*;?$/i.test(current))continue;
      demand(/^(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\b|INSERT\s+INTO\b|DELETE\s+FROM\b|PRAGMA\s)/i.test(current),'SQL_OPERATION_DENIED');
      if(/^DELETE\s+FROM\s+["`\[]?sqlite_sequence\b/i.test(current))demand(/^DELETE\s+FROM\s+(?:sqlite_sequence|"sqlite_sequence"|`sqlite_sequence`|\[sqlite_sequence\])\s*;?$/i.test(current),'SQL_SEQUENCE_SYNTAX');
      else demand(!/^DELETE\s/i.test(current),'SQL_OPERATION_DENIED');
      if(/^INSERT\s+INTO\s+["`\[]?sqlite_sequence\b/i.test(current)){
        const match=/^INSERT\s+INTO\s+(?:sqlite_sequence|"sqlite_sequence"|`sqlite_sequence`|\[sqlite_sequence\])\s*(?:\(\s*name\s*,\s*seq\s*\))?\s*VALUES\s*\(\s*'([A-Za-z0-9_]+)'\s*,\s*(\d+)\s*\)\s*;?$/i.exec(current);
        demand(match&&Number.isSafeInteger(Number(match[2])),'SQL_SEQUENCE_SYNTAX');
        if(['corpus_runs','corpus_changes'].includes(match[1])){demand(!sequenceFacts.has(match[1]),'SQL_SEQUENCE_DUPLICATE');sequenceFacts.set(match[1],Number(match[2]));}
      }
      db.exec(statement);count++;
    }
    demand(sequenceFacts.has('corpus_runs')&&sequenceFacts.has('corpus_changes'),'SQL_SEQUENCE_FACTS_REQUIRED');
    db.setAuthorizer(null);
    for(const [name,seq] of sequenceFacts){const actual=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);demand(actual.length===1&&actual[0].seq===seq,'SQL_SEQUENCE_FACT_MISMATCH');}
    demand(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'SQL_IMPORT_INTEGRITY');
    db.exec('COMMIT');return {materialized:true,statements:count};
  }catch(error){
    if(error instanceof Error&&/^[A-Z_]+$/.test(error.message))throw error;
    throw Object.assign(new Error('SQL_IMPORT_REFUSED'),{sqliteCode:typeof error?.errcode==='number'?error.errcode:null,statementOrdinal:count+1});
  }finally{db.setAuthorizer?.(null);db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  try{demand(process.argv.length===4,'SQL_IMPORT_ARGUMENTS');console.log(JSON.stringify(await importProtectedSql(process.argv[2],process.argv[3])));}
  catch(error){const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SQL_IMPORT_REFUSED';console.error(JSON.stringify({failed:true,code,...(Number.isSafeInteger(error?.sqliteCode)?{sqliteCode:error.sqliteCode}:{}),...(Number.isSafeInteger(error?.statementOrdinal)?{statementOrdinal:error.statementOrdinal}:{})}));process.exitCode=1;}
}
