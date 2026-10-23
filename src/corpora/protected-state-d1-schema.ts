/** Exact fixed schema assets; no caller SQL or database target override. */
import {COMPACT_CORPUS_SCHEMA} from './compact-restore';
import {RESTORE_SUPPORT_SCHEMA} from '../../services/restore/protocol';
import {isFreshRestoreSchema} from '../../services/restore/fresh-schema';
import {PROTECTED_TABLE_COLUMNS,PROTECTED_AUTH_TABLES} from './protected-state-format';
import {protectedD1Assert} from './protected-state-d1-admission';
// Kept byte-identical to migrations/0005_workspace_auth.sql by a focused test.
export const PROTECTED_D1_AUTH_SCHEMA = "-- Preserve customer IDs as workspace IDs. The usage object remains customer:<id>.\nCREATE TABLE IF NOT EXISTS workspace (\n  id TEXT PRIMARY KEY NOT NULL,\n  name TEXT,\n  slug TEXT,\n  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),\n  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)\n);\n\n-- This shape matches CHS auth-d1 WORKSPACE_API_KEY_DDL.\nCREATE TABLE IF NOT EXISTS workspace_api_key (\n  id TEXT PRIMARY KEY NOT NULL,\n  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,\n  name TEXT NOT NULL,\n  key_hash TEXT NOT NULL UNIQUE,\n  display_prefix TEXT NOT NULL,\n  capabilities TEXT NOT NULL DEFAULT '[]',\n  status TEXT NOT NULL DEFAULT 'active',\n  created_by_user_id TEXT,\n  last_used_at INTEGER,\n  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),\n  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)\n);\nCREATE INDEX IF NOT EXISTS workspace_api_key_workspace_idx\n  ON workspace_api_key(workspace_id) WHERE status = 'active';\n\nCREATE TABLE IF NOT EXISTS civic_workspace_billing (\n  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,\n  plan TEXT NOT NULL CHECK(plan IN ('free', 'metered', 'enterprise')),\n  fuse_limit INTEGER NOT NULL DEFAULT 0 CHECK(fuse_limit >= 0),\n  fuse_soft_warn INTEGER NOT NULL DEFAULT 0 CHECK(fuse_soft_warn IN (0, 1)),\n  stripe_customer_id TEXT,\n  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))\n);\n";
export const PROTECTED_D1_JOURNAL_SCHEMA = `CREATE TABLE protected_state_restore(id INTEGER PRIMARY KEY CHECK(id=1),manifest_sha256 TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE protected_state_pages(page INTEGER PRIMARY KEY,sha256 TEXT NOT NULL);
CREATE TABLE protected_state_d1_session(id INTEGER PRIMARY KEY CHECK(id=1),admission_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL,manifest_json TEXT NOT NULL,admission_json TEXT NOT NULL,state_json TEXT NOT NULL,version INTEGER NOT NULL);`;
export function fixedSchemaStatements(schema:string){return schema.split(';').map(sql=>sql.trim()).filter(Boolean);}
/** Whitespace/comments outside literals do not alter a schema; literal values do. */
function normalized(sql:string){let out='',quote='';for(let n=0;n<sql.length;n++){const c=sql[n]!,next=sql[n+1];if(quote){out+=c;if(c===quote){if(next===quote){out+=next;n++;}else quote='';}continue;}if(c==="'"||c==='"'||c==='`'){quote=c;out+=c;continue;}if(c==='-'&&next==='-'){while(n<sql.length&&sql[n]!=='\n')n++;continue;}if(c==='/'&&next==='*'){n+=2;while(n<sql.length&&!(sql[n]==='*'&&sql[n+1]==='/'))n++;n++;continue;}if(!/\s/.test(c)&&c!==';')out+=c.toLowerCase();}return out.replace(/^createtableifnotexists/,'createtable').replace(/^createindexifnotexists/,'createindex');}
function schemas(){const map=new Map<string,string>();for(const sql of fixedSchemaStatements(COMPACT_CORPUS_SCHEMA+RESTORE_SUPPORT_SCHEMA+PROTECTED_D1_AUTH_SCHEMA+PROTECTED_D1_JOURNAL_SCHEMA)){const name=/CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/i.exec(sql.replace(/--[^\n]*/g,''))?.[1];protectedD1Assert(name,'PROTECTED_FIXED_SCHEMA');map.set(name,normalized(sql));}return map;}
export async function checkProtectedD1Schema(db:D1Database,initialized:boolean){
 const expected=schemas(),rows=(await db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 64").all<{name:string;type:string;sql:string|null}>()).results;
 protectedD1Assert(rows.length<64,'PROTECTED_D1_SCHEMA_BOUND');
 let auth=0;const seen=new Set<string>();
 for(const row of rows){
  if(row.name.startsWith('_cf_')){protectedD1Assert(isFreshRestoreSchema([row]),'PROTECTED_D1_BOOKKEEPING');continue;}
  protectedD1Assert((row.type==='table'||row.type==='index')&&row.sql&&expected.get(row.name)===normalized(row.sql),'PROTECTED_D1_SCHEMA_OBJECT');seen.add(row.name);
  if((PROTECTED_AUTH_TABLES as readonly string[]).includes(row.name))auth++;
  if(row.type==='table'){const columns=(await db.prepare(`PRAGMA table_xinfo(${row.name})`).all<{name:string;hidden:number}>()).results;protectedD1Assert(columns.every(c=>c.hidden===0),'PROTECTED_D1_SCHEMA_COLUMNS');
   if(row.name in PROTECTED_TABLE_COLUMNS)protectedD1Assert(JSON.stringify(columns.map(c=>c.name))===JSON.stringify(PROTECTED_TABLE_COLUMNS[row.name as keyof typeof PROTECTED_TABLE_COLUMNS]),'PROTECTED_D1_SCHEMA_COLUMNS');}
 }
 protectedD1Assert(auth===0||auth===3,'PROTECTED_D1_PARTIAL_AUTH');
 for(const name of expected.keys())if(!name.startsWith('protected_state_')&&!PROTECTED_AUTH_TABLES.some(t=>t===name)&&name!=='workspace_api_key_workspace_idx')protectedD1Assert(seen.has(name),'PROTECTED_D1_SCHEMA');
 if(auth===3)protectedD1Assert(seen.has('workspace_api_key_workspace_idx'),'PROTECTED_D1_SCHEMA');
 if(initialized)for(const name of ['protected_state_restore','protected_state_pages','protected_state_d1_session'])protectedD1Assert(seen.has(name),'PROTECTED_D1_SCHEMA');
 else for(const name of ['protected_state_restore','protected_state_pages','protected_state_d1_session'])protectedD1Assert(!seen.has(name),'PROTECTED_D1_ORPHAN_JOURNAL');
 return {authPresent:auth===3};
}
