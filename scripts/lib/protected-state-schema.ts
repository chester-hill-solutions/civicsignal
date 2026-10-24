/** Local declared-schema admission. No source rows, credentials or network. */
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {normalizeProtectedSchemaSql as normalized} from '../../src/corpora/protected-state-d1-schema';
import {isFreshRestoreSchema} from '../../services/restore/fresh-schema';
import {ProtectedStateError} from '../../src/corpora/protected-state-format';
import migrationAssets from './protected-state-schema-assets.json';

export const PROTECTED_SOURCE_SCHEMA_CONTRACT='protected-source-schema-v1';
const profiles=['migrations-through-0003','migrations-through-0004','migrations-through-0005','migrations-through-0006','migrations-through-0007','migrations-through-0008'] as const;
// Reference DDL stays in its authoritative files. The fixed pins also protect
// bundled local clients, whose executable lives outside the source directory.
const migrations=Object.entries(migrationAssets);
const maximumObjects=64,maximumBytes=256*1024;
type Facts=Record<string,unknown>[];
interface SchemaObject {
 type:string;name:string;tbl_name:string;sql:string|null;
 columns?:Facts;foreignKeys?:Facts;indexes?:{name:string;unique:number;origin:string;partial:number;columns:Facts}[];
}
export interface ProtectedSourceSchemaInventory {objects:SchemaObject[]}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function demand(value:unknown):asserts value{if(!value)throw new ProtectedStateError('PROTECTED_SCHEMA_MISMATCH');}

function inventory(db:DatabaseSync):ProtectedSourceSchemaInventory{
 const rows=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 65').all();
 demand(rows.length<=maximumObjects);
 const objects:SchemaObject[]=rows.map(row=>{
  demand(typeof row['type']==='string'&&typeof row['name']==='string'&&typeof row['tbl_name']==='string'&&
   (row['sql']===null||typeof row['sql']==='string'));
  const item:SchemaObject={type:row['type'],name:row['name'],tbl_name:row['tbl_name'],sql:row['sql']};
  if(item.type==='table'){
   item.columns=db.prepare('SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid LIMIT 65').all(item.name);
   item.foreignKeys=db.prepare('SELECT id,seq,"table","from","to",on_update,on_delete,match FROM pragma_foreign_key_list(?) ORDER BY id,seq LIMIT 65').all(item.name);
   const indexes=db.prepare('SELECT name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY name LIMIT 65').all(item.name);
   demand(item.columns.length<=64&&item.foreignKeys.length<=64&&indexes.length<=64&&item.columns.every(c=>c['hidden']===0));
   item.indexes=indexes.map(index=>{
    demand(typeof index['name']==='string'&&typeof index['unique']==='number'&&typeof index['origin']==='string'&&typeof index['partial']==='number');
    const columns=db.prepare('SELECT seqno,cid,name,"desc",coll,"key" FROM pragma_index_xinfo(?) ORDER BY seqno LIMIT 65').all(index['name']);
    demand(columns.length<=64);
    return {name:index['name'],unique:index['unique'],origin:index['origin'],partial:index['partial'],columns};
   });
  }
  return item;
 });
 const result={objects};demand(Buffer.byteLength(JSON.stringify(result))<=maximumBytes);return result;
}

function comparable(value:ProtectedSourceSchemaInventory){
 demand(Object.keys(value).length===1&&Array.isArray(value.objects)&&value.objects.length<=maximumObjects&&Buffer.byteLength(JSON.stringify(value))<=maximumBytes);
 return JSON.stringify(value.objects.filter(object=>{
  if(!object.name.startsWith('_cf_'))return true;
  demand(isFreshRestoreSchema([object]));return false;
 }).map(object=>({...object,sql:object.sql===null?null:normalized(object.sql),columns:object.columns?.map(column=>({...column,
  type:normalized(String(column['type'])),dflt_value:column['dflt_value']===null?null:normalized(String(column['dflt_value']))}))})));
}

/** Reference databases contain only public, checked migration DDL. The caller
 * owns its Node/Bun SQLite constructor and closes this empty reference handle. */
function profile(value:ProtectedSourceSchemaInventory,reference:DatabaseSync,migrationDirectory:string){
 const actual=comparable(value);
 for(const [index,[name,digest]]of migrations.entries()){
  const path=resolve(migrationDirectory,name),info=lstatSync(path);
  demand(info.isFile()&&!info.isSymbolicLink()&&realpathSync(path)===path&&info.size<=64*1024);
  const ddl=readFileSync(path);demand(ddl.byteLength<=64*1024&&sha(ddl.toString('utf8'))===digest);
  reference.exec(ddl.toString('utf8'));
  if(index>=2&&actual===comparable(inventory(reference)))return profiles[index-2]!;
 }
 throw new ProtectedStateError('PROTECTED_SCHEMA_MISMATCH');
}
export function admitProtectedSourceSchema(db:DatabaseSync,reference:DatabaseSync,migrationDirectory:string){
 const captured=inventory(db),accepted=profile(captured,reference,migrationDirectory);
 return {contract:PROTECTED_SOURCE_SCHEMA_CONTRACT,profile:accepted,inventorySha256:sha(JSON.stringify(captured)),inventory:captured};
}

/** A receipt links local schema admission to sealed inputs and the format-1
 * manifest. It cannot authenticate those inputs or establish a common freeze. */
export function checkProtectedSourceSchemaEvidence(value:unknown,reference:DatabaseSync,expected:{sourceKind:string;sourceSha256:string;sourceSqliteSha256:string;manifestSha256:string},migrationDirectory:string){
 demand(value!==null&&typeof value==='object'&&!Array.isArray(value));
 const receipt=value as Record<string,unknown>;
 const keys=['format','kind','contract','profile','inventorySha256','inventory',...Object.keys(expected),
  'providerAuthenticated','globalQuiescenceEstablished','productionAcquisitionQualified'];
 demand(Object.keys(receipt).length===keys.length&&keys.every(key=>Object.hasOwn(receipt,key))&&
  receipt['format']===1&&receipt['kind']==='protected-source-schema'&&receipt['contract']===PROTECTED_SOURCE_SCHEMA_CONTRACT&&
  Object.entries(expected).every(([name,wanted])=>receipt[name]===wanted)&&receipt['providerAuthenticated']===false&&
  receipt['globalQuiescenceEstablished']===false&&receipt['productionAcquisitionQualified']===false);
 const captured=receipt['inventory'] as ProtectedSourceSchemaInventory;
 demand(captured!==null&&typeof captured==='object'&&sha(JSON.stringify(captured))===receipt['inventorySha256']);
 const accepted=profile(captured,reference,migrationDirectory);demand(accepted===receipt['profile']);
 return {contract:PROTECTED_SOURCE_SCHEMA_CONTRACT,profile:accepted,inventorySha256:String(receipt['inventorySha256'])};
}
