import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync as Sqlite } from 'node:sqlite';
import { chmod, lstat, link, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyProtectedState, openProtectedDatabase, prepareProtectedState, verifyProtectedState } from '../scripts/lib/protected-state';
import { protectedStateCli } from '../scripts/protected-state';
import { prepareTextCutover, jsonLines, sha256File } from '../scripts/prepare-text-cutover';
import { applyCompactRestorePage, COMPACT_CORPUS_SCHEMA, COMPACT_STATUTE_COLUMNS, INSERT_COMPACT_STATUTE_SQL, type CompactRestorePage } from '../src/corpora/compact-restore';
import { rowFingerprintWithText } from '../src/corpora/text-store';
import { RESTORE_SUPPORT_SCHEMA } from '../services/restore/protocol';
import { localD1 } from '../scripts/lib/local-d1';
const { DatabaseSync }=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof Sqlite};
const cleanup:string[]=[];
afterEach(async()=>{for(const path of cleanup.splice(0))await rm(path,{recursive:true,force:true});});
const commit='a'.repeat(40),date='2026-10-15';
const importer=resolve('scripts/lib/protected-sql-import.mjs');
async function sqlDump(source:string,destination:string,sequences=true){
  const db=openProtectedDatabase(source);let sql='PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n';
  const literal=(value:unknown)=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
  try{
    const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for(const table of tables)sql+=String(table['sql'])+';\n';
    for(const table of tables)for(const row of db.prepare(`SELECT * FROM ${String(table['name'])}`).iterate())sql+=`INSERT INTO ${String(table['name'])} VALUES(${Object.values(row).map(literal).join(',')});\n`;
    if(sequences){sql+='DELETE FROM sqlite_sequence;\n';for(const row of db.prepare('SELECT name,seq FROM sqlite_sequence').all())sql+=`INSERT INTO sqlite_sequence VALUES(${literal(row['name'])},${literal(row['seq'])});\n`;}
  }finally{db.close();}
  await writeFile(destination,sql+'COMMIT;\n',{mode:0o600});
}

type SequenceFact={presence:'absent'}|{presence:'present';value:number};
type SequenceFacts={corpus_runs:SequenceFact;corpus_changes:SequenceFact};
const originalSequenceQuery="SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name COLLATE BINARY LIMIT 3";
/** Synthetic attestations exercise local consistency, never production freeze. */
async function sequenceEvidence(root:string,sql:string,facts:SequenceFacts,overrides:{
  freeze?:Record<string,unknown>;exported?:Record<string,unknown>;before?:Record<string,unknown>;after?:Record<string,unknown>;
  rawBefore?:Record<string,unknown>;rawAfter?:Record<string,unknown>;evidence?:Record<string,unknown>;
}={}){
  const common={format:1,provenance:'synthetic',accountId:'ad5ec479b9a421faa2ed06c3d1c2b23a',databaseId:'8056b1a0-f858-4f89-a332-91f7f350eb7b'};
  const save=async(name:string,value:unknown)=>{const path=join(root,name);await writeFile(path,JSON.stringify(value)+'\n',{mode:0o600});return {path,sha256:await sha256File(path)};};
  const rows=Object.entries(facts).filter(([,fact])=>fact.presence==='present').map(([name,fact])=>({name,seq:fact.presence==='present'?fact.value:0})).sort((a,b)=>a.name.localeCompare(b.name));
  const raw={success:true,errors:[],result:[{success:true,results:rows,meta:{rows_read:rows.length}}]};
  const rawBefore=await save('sequence-before.raw.json',{...raw,...overrides.rawBefore}),rawAfter=await save('sequence-after.raw.json',{...raw,...overrides.rawAfter});
  const freeze=await save('sequence-freeze.json',{...common,kind:'protected-common-freeze',qualified:true,settled:true,...overrides.freeze});
  const rawSqlSha256=await sha256File(sql);
  const exported=await save('sequence-export.json',{...common,kind:'protected-d1-export',freezeSha256:freeze.sha256,rawSqlSha256,passed:true,settled:true,...overrides.exported});
  const observation={...common,kind:'protected-sequence-observation',query:originalSequenceQuery,freezeSha256:freeze.sha256,success:true,complete:true,facts};
  const before=await save('sequence-before.json',{...observation,response:rawBefore,...overrides.before}),after=await save('sequence-after.json',{...observation,response:rawAfter,...overrides.after});
  return save('sequence-evidence.json',{...common,kind:'protected-original-sequence-evidence',rawSqlSha256,query:originalSequenceQuery,freeze,export:exported,before,after,...overrides.evidence});
}
function importWithEvidence(source:string,destination:string,reference:{path:string;sha256:string}){
  const code="import {importProtectedSqlWithOriginalSequenceEvidence as run} from "+JSON.stringify(new URL('../scripts/lib/protected-sql-import.mjs',import.meta.url).href)+"; try {console.log(JSON.stringify({passed:true,result:await run(process.argv[1],process.argv[2],JSON.parse(process.argv[3]))}));}catch(e){console.log(JSON.stringify({passed:false,code:e.message}));}";
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,source,destination,JSON.stringify(reference)],{encoding:'utf8',timeout:180000,maxBuffer:65536})) as {passed:boolean;code?:string;result?:Record<string,unknown>};
}

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'protected-state-')));cleanup.push(root);await chmod(root,0o700);
  const source=join(root,'source.sqlite'),target=join(root,'target.sqlite'),auth=join(root,'auth.json'),bundle=join(root,'cutover'),output=join(root,'protected');
  const db=new DatabaseSync(source);
  for(const name of (await readdir(resolve('migrations'))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(resolve('migrations',name),'utf8'));
  const rows=['en','fr'].map(language=>{
    const row:Record<string,unknown>={id:`acts-${language}-1`,corpus_id:'statutes-canada',act:"L'Acte",section:'1',heading:null,
      text:language==='fr'?"Une règle avec l'apostrophe.\nDeuxième ligne.":'An original rule.',source_url:`https://laws-lois.justice.gc.ca/${language}/acts/T-1/section-1.html`,
      jurisdiction:'CA',in_force:1,topics:null,citation:'T-1',language,schedule:null,part:null,status:'in-force',last_changed:date};
    row['text_hash']=rowFingerprintWithText(row,String(row['text']));return row;
  });
  for(const row of rows)db.prepare(INSERT_COMPACT_STATUTE_SQL).run(...COMPACT_STATUTE_COLUMNS.map(c=>row[c] as string|number|null));
  db.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',commit,date,date,2,'2026-10-22T16:37:09Z',null);
  db.exec(`INSERT INTO workspace VALUES('cust_one','Private name','private-slug',100,200);
    INSERT INTO civic_workspace_billing VALUES('cust_one','metered',1200,1,'cus_private',0);
    INSERT INTO workspace_api_key VALUES('key_one','cust_one','Private key','${'b'.repeat(64)}','prefix','["scope.restricted"]','revoked','user_private',123,100,200);
    INSERT INTO workspace_api_key VALUES('key_two','cust_one','Tighten','${'c'.repeat(64)}','prefix2','[]','active',NULL,NULL,300,400);`);
  db.prepare('INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at,error) VALUES(?,?,?,?,?,?)').run(2,'statutes-canada',commit,date,date,'Private diagnostic');
  db.prepare('INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at) VALUES(?,?,?,?,?)').run(120,'statutes-canada',commit,date,date);db.exec('DELETE FROM corpus_runs WHERE id=120');
  const insertChange=db.prepare('INSERT INTO corpus_changes(id,corpus_id,change,row_id,instrument,citation,section,summary,source_url,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(let n=1;n<=19;n++)insertChange.run(n*10,'statutes-canada','removed',`removed-${n}`,'Act','T-1','1',"Résumé privé\nwith ' quote",'https://example.test',date,date);
  insertChange.run(1000,'statutes-canada','added','gone','Act','T-1','1',null,null,date,date);db.exec('DELETE FROM corpus_changes WHERE id=1000');
  db.prepare('INSERT INTO corpus_mutations VALUES(?,?,NULL,?)').run('completed-private-id','statutes-canada',date);
  const input=join(root,'rows.jsonl');await writeFile(input,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const cutover=await prepareTextCutover({input,output:bundle,revision:commit+':legacy',objectStorage:'pack'});
  const fresh=new DatabaseSync(target);fresh.exec(COMPACT_CORPUS_SCHEMA);
  for await(const page of jsonLines(join(bundle,'fresh-pages.jsonl')))await applyCompactRestorePage(localD1(fresh),page as unknown as CompactRestorePage,{bundleSha256:cutover.freshPagesSha256,revision:cutover.revision});
  fresh.exec(RESTORE_SUPPORT_SCHEMA);
  fresh.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',commit,date,date,2,'2026-10-15T00:00:00Z',null);
  db.close();fresh.close();await chmod(source,0o600);await chmod(target,0o600);
  await writeFile(auth,JSON.stringify({customers:[{id:'cust_one',plan:'metered',fuseLimit:1200,fuseSoftWarn:true,stripeCustomerId:'cus_private'}],
    keys:[{id:'key_one',kind:'server',customerId:'cust_one',secretHash:'b'.repeat(64)},
      {id:'key_two',kind:'server',customerId:'cust_one',secretHash:'c'.repeat(64),disabled:true},
      {id:'legacy_new',kind:'server',customerId:'cust_one',secretHash:'d'.repeat(64)},
      {id:'browser_private',kind:'browser',customerId:'cust_one'}]}),{mode:0o600});
  const options=async()=>({source:{kind:'sqlite' as const,path:source,sha256:await sha256File(source)},legacyAuth:{path:auth,sha256:await sha256File(auth)},
    targetSqlite:{path:target,sha256:await sha256File(target)},cutoverBundle:{path:bundle,manifestSha256:await sha256File(join(bundle,'manifest.json'))},outputDirectory:output});
  const edit=(file:string,sql:string)=>{const d=openProtectedDatabase(file,false);try{d.exec(sql);}finally{d.close();}};
  return {root,source,target,auth,bundle,output,options,edit};
}

describe('offline protected state',()=>{
  it('preserves every protected table, monotonic revocation, original IDs and deleted-ID sequence marks',async()=>{
    const f=await fixture(),before=await sha256File(f.source),prepared=await prepareProtectedState(await f.options());
    expect(prepared.rows).toMatchObject({workspace:1,workspace_api_key:3,corpus_runs:1,corpus_changes:19,corpus_mutations:1,sqlite_sequence:2});
    const options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    expect(await applyProtectedState(options)).toMatchObject({verified:true,skippedPages:0});
    expect(await verifyProtectedState(options)).toMatchObject({verified:true});
    expect(await applyProtectedState(options)).toMatchObject({appliedPages:0,skippedPages:prepared.pages});
    const db=openProtectedDatabase(f.target,false);
    try{
      expect(db.prepare('SELECT capabilities,status,created_by_user_id,last_used_at FROM workspace_api_key WHERE id=?').get('key_one')).toEqual({capabilities:'["scope.restricted"]',status:'revoked',created_by_user_id:'user_private',last_used_at:123});
      expect(db.prepare('SELECT status FROM workspace_api_key WHERE id=?').get('key_two')?.['status']).toBe('revoked');
      expect(db.prepare('SELECT enabled FROM civic_workspace_billing').get()?.['enabled']).toBe(0);
      expect(db.prepare('SELECT last_run_at FROM corpus_state').get()?.['last_run_at']).toBe('2026-10-22T16:37:09Z');
      expect(db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name").all()).toEqual([{name:'corpus_changes',seq:1000},{name:'corpus_runs',seq:120}]);
      const next=db.prepare('INSERT INTO corpus_changes(corpus_id,change,row_id,instrument,citation,section,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?)').run('statutes-canada','changed','row','Act','T-1','1',date,date);
      expect(Number(next.lastInsertRowid)).toBe(1001);
    }finally{db.close();}
    expect(await sha256File(f.source)).toBe(before);
    expect((await lstat(f.output)).mode&0o777).toBe(0o700);
    for(const name of await readdir(f.output))expect((await lstat(join(f.output,name))).mode&0o777).toBe(0o600);
    expect(JSON.stringify(prepared)).not.toContain('cust_one');
  });
  it.each(['before','after'] as const)('recovers an injected %s-commit failure without losing or duplicating a page',async phase=>{
    const f=await fixture(),prepared=await prepareProtectedState(await f.options());
    const options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    const fail=(n:number)=>{if(n===1)throw new Error('Private identity must never leak');};
    await expect(applyProtectedState({...options,...(phase==='before'?{beforeCommit:fail}:{afterCommit:fail})})).rejects.toMatchObject({code:'PROTECTED_STATE_FAILURE',message:'PROTECTED_STATE_FAILURE'});
    const db=openProtectedDatabase(f.target);try{expect(db.prepare('SELECT count(*) AS n FROM protected_state_pages').get()?.['n']).toBe(phase==='before'?0:1);}finally{db.close();}
    expect(await applyProtectedState(options)).toMatchObject({verified:true,skippedPages:phase==='before'?0:1});
  });
  it('refuses altered replay rows, unjournaled data and receipt corruption before applying another page',async()=>{
    const f=await fixture(),prepared=await prepareProtectedState(await f.options()),options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    await expect(applyProtectedState({...options,afterCommit:()=>{throw new Error('lost acknowledgement');}})).rejects.toThrow();
    f.edit(f.target,"UPDATE workspace SET name='changed private data'");
    await expect(applyProtectedState(options)).rejects.toMatchObject({code:'REPLAY_ROW_MISMATCH'});
    f.edit(f.target,"UPDATE workspace SET name='Private name'; INSERT INTO workspace VALUES('unexpected',NULL,NULL,0,0)");
    await expect(applyProtectedState(options)).rejects.toMatchObject({code:'TARGET_UNJOURNALED_ROWS'});
    f.edit(f.target,"DELETE FROM workspace WHERE id='unexpected'; UPDATE protected_state_pages SET sha256='bad'");
    await expect(applyProtectedState(options)).rejects.toMatchObject({code:'PAGE_RECEIPT_MISMATCH'});
  });
  it.each(['pending','null-mutation','fingerprint','parser','sequence','schema','unknown-table','billing','key'] as const)('refuses %s mismatch before creating output',async kind=>{
    const f=await fixture();
    if(kind==='pending')f.edit(f.source,"UPDATE corpus_mutations SET payload='private pending operation'");
    if(kind==='null-mutation')f.edit(f.source,'UPDATE corpus_mutations SET id=NULL');
    if(kind==='fingerprint')f.edit(f.target,"UPDATE statute_sections SET text_hash='00000000000000000000000000000000'");
    if(kind==='parser')f.edit(f.source,"UPDATE corpus_state SET parser_version='statutes-v2'");
    if(kind==='sequence')f.edit(f.source,"UPDATE sqlite_sequence SET seq=1 WHERE name='corpus_changes'");
    if(kind==='schema')f.edit(f.source,'ALTER TABLE workspace ADD COLUMN unknown_private TEXT');
    if(kind==='unknown-table')f.edit(f.source,'CREATE TABLE workspace_membership(id TEXT)');
    if(kind==='billing'||kind==='key'){
      const data=JSON.parse(await readFile(f.auth,'utf8'));
      if(kind==='billing')data.customers[0].fuseLimit=99;else data.keys[0].customerId='another_private_customer';
      await writeFile(f.auth,JSON.stringify(data));
    }
    await expect(prepareProtectedState(await f.options())).rejects.toThrow();
    expect(await lstat(f.output).catch(()=>null)).toBeNull();
  });
  it.each([
    {side:'source',storage:'VIRTUAL'},{side:'source',storage:'STORED'},
    {side:'target',storage:'VIRTUAL'},{side:'target',storage:'STORED'},
  ])('refuses unexpected $storage generated column in $side before producing a narrowed copy',async({side,storage})=>{
    const f=await fixture();
    if(side==='source'){
      // SQLite cannot add a STORED column to a populated table. Recreate the
      // same protected workspace, retaining every original column and value.
      f.edit(f.source,`PRAGMA foreign_keys=OFF;
        CREATE TABLE workspace_next(id TEXT PRIMARY KEY NOT NULL,name TEXT,slug TEXT,created_at INTEGER,updated_at INTEGER,
          unexpected_private TEXT GENERATED ALWAYS AS (name) ${storage});
        INSERT INTO workspace_next(id,name,slug,created_at,updated_at) SELECT id,name,slug,created_at,updated_at FROM workspace;
        DROP TABLE workspace; ALTER TABLE workspace_next RENAME TO workspace;`);
    }else{
      f.edit(f.target,`ALTER TABLE corpus_runs ADD COLUMN unexpected_private TEXT GENERATED ALWAYS AS (error) ${storage}`);
    }
    const options=await f.options();
    await expect(prepareProtectedState(options)).rejects.toMatchObject({code:'PROTECTED_SCHEMA_MISMATCH'});
    expect(await lstat(f.output).catch(()=>null)).toBeNull();
    expect(await sha256File(f.source)).toBe(options.source.sha256);
    expect(await sha256File(f.target)).toBe(options.targetSqlite.sha256);
  });
  it('rejects wrong input hashes, unsafe permissions and SQLite sidecars without exposing values',async()=>{
    const f=await fixture(),options=await f.options();
    await expect(prepareProtectedState({...options,source:{...options.source,sha256:'0'.repeat(64)}})).rejects.toMatchObject({code:'INPUT_HASH_MISMATCH'});
    await chmod(f.auth,0o644);await expect(prepareProtectedState(options)).rejects.toMatchObject({code:'PRIVATE_PERMISSIONS_REQUIRED'});await chmod(f.auth,0o600);
    await writeFile(f.source+'-wal','',{mode:0o600});await expect(prepareProtectedState(options)).rejects.toMatchObject({code:'SEALED_SQLITE_REQUIRED'});
    await rm(f.source+'-wal');await link(f.source,join(f.root,'source-link.sqlite'));
    await expect(prepareProtectedState(options)).rejects.toMatchObject({code:'PRIVATE_PERMISSIONS_REQUIRED'});
  });
  it('rejects incomplete SQL arguments and remote/unknown CLI flags without opening inputs',async()=>{
    await expect(protectedStateCli(['prepare','--source-sql','/not-opened'])).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
    await expect(protectedStateCli(['apply-remote','--bundle','/not-opened'])).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
    await expect(protectedStateCli(['verify-local','--bundle','/not-opened','--manifest-sha256','a','--target','b','--remote','true'])).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
  });
  it('migrates a recognized legacy schema without inventing CHS state or completed mutations',async()=>{
    const f=await fixture();
    f.edit(f.source,'DROP TABLE workspace_api_key; DROP TABLE civic_workspace_billing; DROP TABLE workspace; DROP TABLE corpus_mutations; ALTER TABLE corpus_state DROP COLUMN parser_version; ALTER TABLE corpus_runs DROP COLUMN parser_version;');
    const prepared=await prepareProtectedState(await f.options());expect(prepared.rows).toMatchObject({workspace_api_key:3,corpus_mutations:0});
    expect(await applyProtectedState({directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target})).toMatchObject({verified:true});
  });
  it('preserves CHS-only data and refuses existing keys with missing billing instead of enabling them from legacy input',async()=>{
    const f=await fixture();await writeFile(f.auth,JSON.stringify({customers:[],keys:[]}));
    const prepared=await prepareProtectedState(await f.options());expect(prepared.rows.workspace_api_key).toBe(2);
    f.edit(f.source,'DELETE FROM civic_workspace_billing');
    await expect(prepareProtectedState({...await f.options(),outputDirectory:join(f.root,'missing-billing')})).rejects.toMatchObject({code:'AUTH_BILLING_MISSING'});
  });
  it('rejects a changed page artifact and a changed target corpus before further writes',async()=>{
    const f=await fixture(),prepared=await prepareProtectedState(await f.options()),options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    const pagePath=join(f.output,'pages.jsonl'),original=await readFile(pagePath,'utf8'),targetBefore=await sha256File(f.target);
    await writeFile(pagePath,original+'\n');await expect(applyProtectedState(options)).rejects.toMatchObject({code:'PAGES_HASH_MISMATCH'});expect(await sha256File(f.target)).toBe(targetBefore);
    await writeFile(pagePath,original);f.edit(f.target,"UPDATE statute_sections SET text_hash='00000000000000000000000000000000'");
    await expect(applyProtectedState(options)).rejects.toMatchObject({code:'CORPUS_FINGERPRINT_MISMATCH'});
  });
  it('rejects metadata tampering that leaves the stored fingerprint unchanged, including after a partial copy',async()=>{
    const f=await fixture(),prepared=await prepareProtectedState(await f.options()),options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    await expect(applyProtectedState({...options,afterCommit:()=>{throw new Error('lost acknowledgement');}})).rejects.toThrow();
    f.edit(f.target,"UPDATE statute_sections SET act='Changed private metadata'");
    await expect(applyProtectedState(options)).rejects.toMatchObject({code:'CORPUS_FINGERPRINT_MISMATCH'});
  });
  it('imports a saved SQL dump through the Node authorizer, retaining exact sequence facts and private literals',async()=>{
    const f=await fixture(),sql=join(f.root,'source.sql');await sqlDump(f.source,sql);
    // Force comment, UTF-8, quote and semicolon boundaries across input chunks.
    await writeFile(sql,'--'+'.'.repeat(65530)+'\n'+await readFile(sql,'utf8')+"CREATE TABLE literal_fixture(x TEXT); INSERT INTO literal_fixture VALUES('règle; -- not a comment\n''quoted''');\n");
    const options=await f.options(),original=await sha256File(sql);
    const prepared=await prepareProtectedState({...options,source:{kind:'sql',path:sql,sha256:original}});
    expect(await applyProtectedState({directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target})).toMatchObject({verified:true});
    const manifest=JSON.parse(await readFile(join(f.output,'manifest.json'),'utf8'));
    expect(manifest).toMatchObject({sourceKind:'sql',sourceSha256:original});expect(await sha256File(sql)).toBe(original);
  });
  it.each([
    "ATTACH DATABASE 'private-exfiltration.sqlite' AS leak;",
    "PRAGMA writable_schema=ON;",
    "VACUUM INTO 'private-exfiltration.sqlite';",
    "CREATE TABLE x(a); INSERT INTO x VALUES(load_extension('private-library'));",
    "CREATE TABLE x(a); CREATE TRIGGER private_trigger AFTER INSERT ON x BEGIN SELECT 1; END;",
    "CREATE VIRTUAL TABLE private_virtual USING fts5(private_text);",
    "CREATE TABLE x(a); INSERT INTO x SELECT 1;",
  ])('refuses hostile SQL without printing its values: %s',async attack=>{
    const f=await fixture(),sql=join(f.root,'hostile.sql');await writeFile(sql,attack,{mode:0o600});
    let stderr='';try{execFileSync(process.execPath,[importer,sql,join(f.root,'refused.sqlite')],{stdio:['ignore','pipe','pipe'],cwd:f.root});throw new Error('Unexpected import success');}
    catch(error){if(error&&typeof error==='object'&&'stderr' in error)stderr=String(error.stderr);else throw error;}
    expect(stderr).toContain('"failed":true');expect(stderr).not.toContain('private-');expect(stderr).not.toContain('private_');
    expect(await lstat(join(f.root,'private-exfiltration.sqlite')).catch(()=>null)).toBeNull();
  });
  it('refuses SQL without explicit history sequence facts and fails closed when the authorizer is absent',async()=>{
    const f=await fixture(),sql=join(f.root,'source.sql');await sqlDump(f.source,sql,false);
    await expect(prepareProtectedState({...await f.options(),source:{kind:'sql',path:sql,sha256:await sha256File(sql)}})).rejects.toMatchObject({code:'SQL_SEQUENCE_FACTS_REQUIRED'});
    const code="import {DatabaseSync} from 'node:sqlite'; import {importProtectedSql} from "+JSON.stringify(new URL('../scripts/lib/protected-sql-import.mjs',import.meta.url).href)+"; DatabaseSync.prototype.setAuthorizer=undefined; try {await importProtectedSql(process.argv[1],process.argv[2]);}catch(e){console.log(e.message);}";
    expect(execFileSync(process.execPath,['--input-type=module','-e',code,sql,join(f.root,'unsupported.sqlite')],{encoding:'utf8'}).trim()).toBe('SQL_AUTHORISER_UNAVAILABLE');
  });
  it('requires explicit SQL sequence facts to match the final imported database, rather than an automatic later maximum',async()=>{
    const f=await fixture(),sql=join(f.root,'source.sql');await sqlDump(f.source,sql);
    await writeFile(sql,await readFile(sql,'utf8')+`INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at) VALUES(9999,'statutes-canada','${commit}','${date}','${date}');\n`);
    await expect(prepareProtectedState({...await f.options(),source:{kind:'sql',path:sql,sha256:await sha256File(sql)}})).rejects.toMatchObject({code:'SQL_SEQUENCE_FACT_MISMATCH'});
  });
  it.each(['sqlite','sql'] as const)('runs the actual Bun %s preparation/apply/verify CLI with safe receipts',async kind=>{
    const f=await fixture(),o=await f.options(),cli=resolve('scripts/protected-state.ts');
    const input=kind==='sql'?join(f.root,'source.sql'):f.source;if(kind==='sql')await sqlDump(f.source,input);
    const command=['prepare',kind==='sql'?'--source-sql':'--source-sqlite',input,'--source-sha256',await sha256File(input),'--legacy-auth',f.auth,'--auth-sha256',o.legacyAuth.sha256,'--target',f.target,'--target-sha256',o.targetSqlite.sha256,'--cutover',f.bundle,'--cutover-sha256',o.cutoverBundle.manifestSha256,'--output',f.output];
    const prepared=JSON.parse(execFileSync('bun',[cli,...command],{encoding:'utf8'}));
    const args=['--bundle',f.output,'--manifest-sha256',prepared.manifestSha256,'--target',f.target];
    expect(JSON.parse(execFileSync('bun',[cli,'apply-local',...args],{encoding:'utf8'}))).toMatchObject({verified:true});
    const proof=execFileSync('bun',[cli,'verify-local',...args],{encoding:'utf8'});expect(JSON.parse(proof)).toMatchObject({verified:true});expect(proof).not.toContain('cust_one');
  });
});

describe('offline original sequence evidence bridge',()=>{
  const savedFacts:SequenceFacts={corpus_runs:{presence:'present',value:120},corpus_changes:{presence:'present',value:1000}};
  async function smallSource(sqlText="CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);\nCREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);\n"){
    const root=await realpath(await mkdtemp(join(tmpdir(),'sequence-evidence-')));cleanup.push(root);await chmod(root,0o700);
    const sql=join(root,'original.sql'),destination=join(root,'materialized.sqlite');await writeFile(sql,sqlText,{mode:0o600});return {root,sql,destination};
  }
  function rolledBack(path:string){const db=new DatabaseSync(path,{readOnly:true});try{expect(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);}finally{db.close();}}
  it('retains saved120/1000 above surviving2/10 and feeds the unchanged SQLite copier without rewriting SQL',async()=>{
    const f=await fixture();f.edit(f.source,'DELETE FROM corpus_changes WHERE id<>10');
    const sql=join(f.root,'original.sql'),materialized=join(f.root,'materialized.sqlite');await sqlDump(f.source,sql,false);
    // Exercise the hash of actual consumed UTF-8 chunks, not a separate prehash.
    await writeFile(sql,'--'+'.'.repeat(65530)+'\n'+await readFile(sql,'utf8'));
    const original=await sha256File(sql),reference=await sequenceEvidence(f.root,sql,savedFacts),imported=importWithEvidence(sql,materialized,reference);
    expect(imported.passed).toBe(true);
    expect(imported.result).toMatchObject({materialized:true,sourceKind:'sqlite',rawSqlSha256:original,evidenceSha256:reference.sha256,provenance:'synthetic',evidenceConsistent:true,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false});
    expect(imported.result?.['sourceSqliteSha256']).toBe(await sha256File(materialized));
    const prepared=await prepareProtectedState({...await f.options(),source:{kind:'sqlite',path:materialized,sha256:String(imported.result?.['sourceSqliteSha256'])}});
    const options={directory:f.output,manifestSha256:prepared.manifestSha256,targetSqlite:f.target};
    expect(await applyProtectedState(options)).toMatchObject({verified:true});expect(await verifyProtectedState(options)).toMatchObject({verified:true});
    const target=openProtectedDatabase(f.target,false);try{
      expect(target.prepare('SELECT id FROM corpus_runs').all()).toEqual([{id:2}]);expect(target.prepare('SELECT id FROM corpus_changes').all()).toEqual([{id:10}]);
      expect(Number(target.prepare('INSERT INTO corpus_runs(corpus_id,commit_sha,commit_date,ran_at) VALUES(?,?,?,?)').run('statutes-canada',commit,date,date).lastInsertRowid)).toBe(121);
      expect(Number(target.prepare('INSERT INTO corpus_changes(corpus_id,change,row_id,instrument,citation,section,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?)').run('statutes-canada','changed','row','Act','T-1','1',date,date).lastInsertRowid)).toBe(1001);
    }finally{target.close();}
    expect(await sha256File(sql)).toBe(original);expect(JSON.stringify(imported.result)).not.toContain('cust_one');
  });
  it.each(['absent','zero'] as const)('keeps original %s sequence facts distinct for empty history',async kind=>{
    const f=await smallSource(),fact:SequenceFact=kind==='absent'?{presence:'absent'}:{presence:'present',value:0};
    const result=importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,{corpus_runs:fact,corpus_changes:fact}));expect(result.passed).toBe(true);
    const db=new DatabaseSync(f.destination);try{expect(db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()).toEqual(kind==='absent'?[]:[{name:'corpus_changes',seq:0},{name:'corpus_runs',seq:0}]);}finally{db.close();}
  });
  it.each([
    {before:{complete:false}},
    {freeze:{settled:false}},
    {exported:{passed:false}},
    {exported:{settled:false}},
    {before:{databaseId:'00000000-0000-0000-0000-000000000000'}},
    {freeze:{provenance:'captured'}},
    {evidence:{provenance:'captured'}},
    {before:{query:'SELECT max(id) FROM corpus_runs'}},
    {before:{freezeSha256:'f'.repeat(64)}},
    {evidence:{extraFact:true}},
    {before:{facts:{corpus_runs:{presence:'absent'}}}},
    {before:{facts:{...savedFacts,other_sequence:{presence:'absent'}}}},
    {before:{facts:{corpus_runs:{presence:'absent',value:0},corpus_changes:{presence:'absent'}}}},
  ])('refuses incomplete, foreign, mixed or failed attestations before output: %j',async overrides=>{
    const f=await smallSource(),result=importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts,overrides));
    expect(result.passed).toBe(false);expect(result.code).toMatch(/^[A-Z_]+$/);expect(await lstat(f.destination).catch(()=>null)).toBeNull();
  });
  it.each([
    {success:false,result:[]},
    {success:true,result:[]},
    {success:true,result:[{success:true,results:[]},{success:true,results:[]}]},
    {success:true,result:[{success:false,results:[]}]},
    {success:true,result:[{success:true,results:[{name:'corpus_runs',seq:120},{name:'corpus_runs',seq:120}]}]},
    {success:true,result:[{success:true,results:[{name:'other',seq:120}]}]},
    {success:true,result:[{success:true,results:[{name:'corpus_runs',seq:120,privateValue:'must-not-escape'}]}]},
    {success:true,result:[{success:true,results:[{name:'corpus_runs',seq:9007199254740992}]}]},
  ])('requires one complete successful raw SELECT and exact fixed rows: %j',async rawBefore=>{
    const f=await smallSource(),result=importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts,{rawBefore}));
    expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('must-not-escape');expect(await lstat(f.destination).catch(()=>null)).toBeNull();
  });
  it('rejects changed before/after facts rather than treating two independently complete observations as equal',async()=>{
    const f=await smallSource(),facts={corpus_runs:{presence:'present' as const,value:121},corpus_changes:savedFacts.corpus_changes};
    const reference=await sequenceEvidence(f.root,f.sql,savedFacts,{after:{facts},rawAfter:{success:true,result:[{success:true,results:[{name:'corpus_changes',seq:1000},{name:'corpus_runs',seq:121}]}]}});
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'SQL_SEQUENCE_OBSERVATION_CHANGED'});expect(await lstat(f.destination).catch(()=>null)).toBeNull();
  });
  it('checks raw response hashes and input aliases before creating output',async()=>{
    const f=await smallSource(),reference=await sequenceEvidence(f.root,f.sql,savedFacts);
    await writeFile(join(f.root,'sequence-before.raw.json'),'{}');
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'SQL_SEQUENCE_EVIDENCE_HASH'});expect(await lstat(f.destination).catch(()=>null)).toBeNull();
    const second=await smallSource(),ref=await sequenceEvidence(second.root,second.sql,savedFacts),value=JSON.parse(await readFile(ref.path,'utf8'));
    value.after=value.before;await writeFile(ref.path,JSON.stringify(value));ref.sha256=await sha256File(ref.path);
    expect(importWithEvidence(second.sql,second.destination,ref)).toMatchObject({passed:false,code:'SQL_SEQUENCE_INPUT_ALIAS'});expect(await lstat(second.destination).catch(()=>null)).toBeNull();
  });
  it('rejects a non-private or hardlinked evidence input without creating output',async()=>{
    const f=await smallSource(),reference=await sequenceEvidence(f.root,f.sql,savedFacts);await chmod(join(f.root,'sequence-export.json'),0o644);
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'PRIVATE_SEQUENCE_INPUT'});expect(await lstat(f.destination).catch(()=>null)).toBeNull();
    await chmod(join(f.root,'sequence-export.json'),0o600);await link(join(f.root,'sequence-export.json'),join(f.root,'export-alias.json'));
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'PRIVATE_SEQUENCE_INPUT'});
  });
  it.each([0,2])('refuses an original absence with a surviving history row id%s and rolls back every table',async id=>{
    const f=await smallSource(`CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO corpus_runs VALUES(${id});`);
    const facts:SequenceFacts={corpus_runs:{presence:'absent'},corpus_changes:{presence:'absent'}};
    expect(importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,facts))).toMatchObject({passed:false,code:'SQL_SEQUENCE_SOURCE_REQUIRED'});rolledBack(f.destination);
  });
  it('refuses a conflicting literal dump fact without replacing its lineage and rolls back all imported data',async()=>{
    const f=await smallSource("CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO corpus_runs VALUES(2);DELETE FROM sqlite_sequence;INSERT INTO sqlite_sequence VALUES('corpus_runs',3);INSERT INTO sqlite_sequence VALUES('corpus_changes',1000);");
    expect(importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts))).toMatchObject({passed:false,code:'SQL_SEQUENCE_FACT_CONFLICT'});rolledBack(f.destination);
  });
  it.each(['main.sqlite_sequence','"main"."sqlite_sequence"','[main].[sqlite_sequence]','/* private comment */ sqlite_sequence'])('refuses unrecognized explicit sequence writes through %s without overwriting their facts',async table=>{
    const f=await smallSource(`CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO ${table} VALUES('corpus_runs',3);INSERT INTO ${table} VALUES('corpus_changes',4);`);
    const result=importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts));
    expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('private comment');rolledBack(f.destination);
  });
  it('hashes the consumed SQL stream and rolls back late changes after imported DDL and rows',async()=>{
    const f=await smallSource('CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO corpus_runs VALUES(2);'),reference=await sequenceEvidence(f.root,f.sql,savedFacts);
    await writeFile(f.sql,await readFile(f.sql,'utf8')+'CREATE TABLE late_private_data(secret TEXT);INSERT INTO late_private_data VALUES(\'private-source-value\');');
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'SQL_SEQUENCE_CONSUMED_HASH'});rolledBack(f.destination);
  });
  it('rolls back a late FK failure after restoring both sequence facts',async()=>{
    const f=await smallSource('CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER REFERENCES parent(id));INSERT INTO child VALUES(99);');
    expect(importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts))).toMatchObject({passed:false,code:'SQL_IMPORT_INTEGRITY'});rolledBack(f.destination);
  });
  it('accepts matching literal facts and preserves unrelated raw rows and sequence entries',async()=>{
    const f=await smallSource("CREATE TABLE corpus_runs(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE corpus_changes(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE other(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);INSERT INTO corpus_runs VALUES(2);INSERT INTO corpus_changes VALUES(10);INSERT INTO other VALUES(7,'unmodified');DELETE FROM sqlite_sequence;INSERT INTO sqlite_sequence VALUES('corpus_runs',120);INSERT INTO sqlite_sequence VALUES('corpus_changes',1000);INSERT INTO sqlite_sequence VALUES('other',42);");
    expect(importWithEvidence(f.sql,f.destination,await sequenceEvidence(f.root,f.sql,savedFacts)).passed).toBe(true);
    const db=new DatabaseSync(f.destination,{readOnly:true});try{expect(db.prepare('SELECT * FROM other').all()).toEqual([{id:7,value:'unmodified'}]);expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='other'").get()?.['seq']).toBe(42);}finally{db.close();}
  });
  it('refuses oversized evidence by metadata before output and snapshots the caller evidence digest',async()=>{
    const f=await smallSource(),reference=await sequenceEvidence(f.root,f.sql,savedFacts);await writeFile(join(f.root,'sequence-freeze.json'),' '.repeat(16*1024+1));
    expect(importWithEvidence(f.sql,f.destination,reference)).toMatchObject({passed:false,code:'PRIVATE_SEQUENCE_INPUT'});expect(await lstat(f.destination).catch(()=>null)).toBeNull();
    const other=await smallSource(),ref=await sequenceEvidence(other.root,other.sql,savedFacts);
    const code="import {importProtectedSqlWithOriginalSequenceEvidence as run} from "+JSON.stringify(new URL('../scripts/lib/protected-sql-import.mjs',import.meta.url).href)+";const reference=JSON.parse(process.argv[3]);const pending=run(process.argv[1],process.argv[2],reference);reference.sha256='f'.repeat(64);console.log(JSON.stringify(await pending));";
    const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,other.sql,other.destination,JSON.stringify(ref)],{encoding:'utf8'}));expect(result.evidenceSha256).toBe(ref.sha256);
  });
  it.each(["ATTACH DATABASE 'must-not-create.sqlite' AS leak;","CREATE VIRTUAL TABLE private_virtual USING fts5(private_text);","CREATE TABLE x(a); INSERT INTO x SELECT 1;"])('keeps the existing authorizer restrictions in evidence mode: %s',async attack=>{
    const f=await smallSource(attack),reference=await sequenceEvidence(f.root,f.sql,savedFacts),result=importWithEvidence(f.sql,f.destination,reference);
    expect(result.passed).toBe(false);expect(JSON.stringify(result)).not.toContain('private_');expect(await lstat(join(f.root,'must-not-create.sqlite')).catch(()=>null)).toBeNull();rolledBack(f.destination);
  });
  it('leaves the strict default export and four-argument CLI refusing omitted sequence facts',async()=>{
    const f=await smallSource();
    const code="import {importProtectedSql} from "+JSON.stringify(new URL('../scripts/lib/protected-sql-import.mjs',import.meta.url).href)+"; try{await importProtectedSql(process.argv[1],process.argv[2]);}catch(e){console.log(e.message);}";
    expect(execFileSync(process.execPath,['--input-type=module','-e',code,f.sql,f.destination],{encoding:'utf8'}).trim()).toBe('SQL_SEQUENCE_FACTS_REQUIRED');
    expect(()=>execFileSync(process.execPath,[importer,f.sql,join(f.root,'cli.sqlite')],{stdio:['ignore','pipe','pipe']})).toThrow();
    expect(()=>execFileSync(process.execPath,[importer,f.sql,join(f.root,'extra.sqlite'),'--evidence'],{stdio:['ignore','pipe','pipe']})).toThrow();
  });
});
