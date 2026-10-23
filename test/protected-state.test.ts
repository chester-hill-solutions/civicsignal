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
