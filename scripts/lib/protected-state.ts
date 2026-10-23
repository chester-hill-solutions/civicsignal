/** Offline protected-state copy. This module has no network or credential path. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { prepareAuthMigration } from '../../src/auth-migration';
import { COMPACT_STATUTE_COLUMNS } from '../../src/corpora/compact-restore';
import { IndexDigester } from '../../src/ingest/snapshot-format';
import { jsonLines, sha256File, verifyTextCutover } from '../prepare-text-cutover';

import {
  PROTECTED_TABLE_COLUMNS as tables, PROTECTED_TABLE_ORDER as order,
  PROTECTED_AUTH_TABLES as authTables, PROTECTED_HISTORY_TABLES as history,
  PROTECTED_CORPUS_ID as corpus, MAX_PROTECTED_PAGE_BYTES as maxPageBytes,
  MAX_PROTECTED_PAGE_ROWS as maxRows, PROTECTED_DIGEST_PATTERN as digestPattern,
  ProtectedStateError, protectedRowValues as rowValues, protectedRowCanonical as canonical,
  protectedPageCanonical, checkedProtectedManifest as checkedManifest, checkedProtectedPage as checkedPage,
  type ProtectedScalar as Scalar, type ProtectedTable as Table,
  type ProtectedTableDigest as TableDigest, type ProtectedPage, type ProtectedManifest,
} from '../../src/corpora/protected-state-format';
export {ProtectedStateError, type ProtectedPage, type ProtectedManifest} from '../../src/corpora/protected-state-format';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function assert(value: unknown, code: string): asserts value { if (!value) throw new ProtectedStateError(code); }
function safeError(error: unknown): never { throw error instanceof ProtectedStateError ? error : new ProtectedStateError('PROTECTED_STATE_FAILURE'); }

// Same Node/Bun boundary used by verify-text-restore; both implement this API.
const sqlite = createRequire(import.meta.url)(process.versions['bun'] ? 'bun:sqlite' : 'node:sqlite') as {
  Database: typeof DatabaseSync; DatabaseSync: typeof DatabaseSync;
};
const Database = process.versions['bun'] ? sqlite.Database : sqlite.DatabaseSync;
export function openProtectedDatabase(path: string, readOnly = true): DatabaseSync {
  const options:{readOnly?:boolean;readonly?:boolean;readwrite?:boolean;create?:boolean;allowExtension?:boolean} = process.versions['bun']
    ? {readonly:readOnly,readwrite:!readOnly,create:false} : {readOnly,allowExtension:false};
  return new Database(path, options);
}

/** Protected inputs and outputs must not be published with repository artifacts. */
export async function privatePath(path: string, directory = false): Promise<string> {
  const absolute = resolve(path), actual = await realpath(absolute);
  const info = await lstat(absolute), parent = await lstat(dirname(absolute));
  const repository = resolve(import.meta.dirname, '../..');
  const rel = relative(repository, absolute);
  assert(actual === absolute && (rel.startsWith('..' + '/') || isAbsolute(rel)), 'PRIVATE_PATH_REQUIRED');
  assert(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
    (info.mode & 0o077) === 0 && info.uid === process.getuid?.() && parent.isDirectory() &&
    (directory || (parent.mode & 0o077) === 0 && parent.uid === process.getuid?.()), 'PRIVATE_PERMISSIONS_REQUIRED');
  return absolute;
}
async function sealedDatabase(path: string, expected?: string) {
  const absolute = await privatePath(path);
  if (expected) assert(digestPattern.test(expected) && await sha256File(absolute) === expected, 'INPUT_HASH_MISMATCH');
  for (const suffix of ['-wal','-shm','-journal']) {
    const companion = await lstat(absolute + suffix).catch(() => null);
    assert(!companion, 'SEALED_SQLITE_REQUIRED');
  }
  return absolute;
}
function exists(db: DatabaseSync, name: string) { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function columns(db: DatabaseSync, table: Table) {
  // table_info omits generated/hidden columns and could certify a narrowed
  // copy of an unknown protected schema. Include every column and fail closed.
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all();
  assert(rows.every(row => row['hidden'] === 0), 'PROTECTED_SCHEMA_MISMATCH');
  return rows.map(row => String(row['name']));
}
function checkSchema(db: DatabaseSync, table: Table, legacy = false) {
  if (!exists(db, table)) { assert(legacy && (authTables.includes(table) || table === 'corpus_mutations'), 'MISSING_PROTECTED_TABLE'); return false; }
  const actual = columns(db, table), wanted: readonly string[] = tables[table];
  assert(actual.length === wanted.length && wanted.every(name => actual.includes(name)) ||
    legacy && (table === 'corpus_state' || table === 'corpus_runs') && actual.length === wanted.length - 1 &&
    wanted.filter(name => name !== 'parser_version').every(name => actual.includes(name)), 'PROTECTED_SCHEMA_MISMATCH');
  return true;
}
function tableRows(db: DatabaseSync, table: Table, legacy = false): Iterable<Record<string, unknown>> {
  if (!checkSchema(db, table, legacy)) return [];
  const actual = columns(db, table);
  const projection = tables[table].map(name => actual.includes(name) ? name : `NULL AS ${name}`).join(',');
  return db.prepare(`SELECT ${projection} FROM ${table}${table === 'sqlite_sequence' ? " WHERE name IN ('corpus_runs','corpus_changes')" : ''} ORDER BY ${tables[table][0]} COLLATE BINARY`).iterate();
}
function count(db: DatabaseSync, table: Table | 'protected_state_pages') { return exists(db, table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']) : 0; }
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE'); try { const value = action(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function insert(db: DatabaseSync, table: Table, values: readonly Scalar[]) {
  db.prepare(`INSERT INTO ${table}(${tables[table].join(',')}) VALUES(${values.map(() => '?').join(',')})`).run(...values);
}
function hashRows(db: DatabaseSync, table: Table) {
  const hash = createHash('sha256'); let rows = 0;
  for (const row of tableRows(db, table)) { hash.update(canonical(rowValues(table, row))); rows++; }
  return { rows, sha256: hash.digest('hex') };
}
function healthy(db: DatabaseSync) {
  assert(db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] === 'ok', 'SQLITE_INTEGRITY');
  assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'SQLITE_FOREIGN_KEYS');
}
function knownProtectedSchema(db:DatabaseSync){
  const allowed=new Set<string>([...order,'corpus_compact_restore','corpus_compact_pages']);
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()){
    const name=String(row['name']);
    if(/^(?:workspace|civic_workspace_|corpus_)/.test(name)||['user','session','account','verification','organization','member','invitation'].includes(name))assert(allowed.has(name),'UNSUPPORTED_PROTECTED_TABLE');
  }
}
function emptyProtectedTarget(db: DatabaseSync) {
  assert(!exists(db, 'protected_state_restore') && !exists(db, 'protected_state_pages'), 'TARGET_ALREADY_PREPARED');
  assert(authTables.filter(t => exists(db, t)).length % 3 === 0, 'PARTIAL_AUTH_SCHEMA');
  for(const table of authTables)if(exists(db,table))checkSchema(db,table);
  for (const table of order.filter(t => t !== 'corpus_state' && t !== 'sqlite_sequence')) assert(count(db, table) === 0, 'TARGET_PROTECTED_DATA_PRESENT');
  for(const row of db.prepare("SELECT seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes')").all())assert(row['seq']===0,'TARGET_PROTECTED_DATA_PRESENT');
}

function mergeAuth(source: DatabaseSync, desired: DatabaseSync, auth: unknown) {
  desired.exec(readFileSync(new URL('../../migrations/0005_workspace_auth.sql', import.meta.url), 'utf8'));
  const presence = authTables.filter(table => exists(source, table));
  assert(presence.length === 0 || presence.length === 3, 'PARTIAL_AUTH_SCHEMA');
  if(presence.length)assert(Number(source.prepare('SELECT count(*) AS n FROM workspace_api_key k LEFT JOIN civic_workspace_billing b ON b.workspace_id=k.workspace_id WHERE b.workspace_id IS NULL').get()?.['n'])===0,'AUTH_BILLING_MISSING');
  for (const table of authTables) for (const row of tableRows(source, table, true)) insert(desired, table, rowValues(table, row));
  const migration = prepareAuthMigration(auth);
  // Existing CHS identities are authoritative. Conflicting legacy billing or
  // key identity is not an invitation to overwrite it.
  for (const statement of migration.statements) {
    const p = statement.params;
    if (statement.sql.startsWith('INSERT INTO civic_workspace_billing')) {
      const existing = desired.prepare('SELECT plan,fuse_limit,fuse_soft_warn,stripe_customer_id FROM civic_workspace_billing WHERE workspace_id=?').get(p[0]!);
      if (existing) assert(equal([existing['plan'],existing['fuse_limit'],existing['fuse_soft_warn'],existing['stripe_customer_id']], p.slice(1)), 'AUTH_BILLING_CONFLICT');
    }
    if (statement.sql.startsWith('INSERT INTO workspace_api_key')) {
      const collisions = desired.prepare('SELECT id,workspace_id,key_hash FROM workspace_api_key WHERE id=? OR key_hash=?').all(p[0]!,p[3]!);
      assert(collisions.every(row => row['id'] === p[0] && row['workspace_id'] === p[1] && row['key_hash'] === p[3]), 'AUTH_KEY_CONFLICT');
    }
  }
  for (const statement of migration.statements) desired.prepare(statement.sql).run(...statement.params);
  healthy(desired);
}

export async function prepareProtectedState(options: {
  source: { kind: 'sqlite' | 'sql'; path: string; sha256: string }; legacyAuth: { path: string; sha256: string };
  targetSqlite: { path: string; sha256: string }; cutoverBundle: { path: string; manifestSha256: string }; outputDirectory: string;
}) {
  let source: DatabaseSync | undefined, target: DatabaseSync | undefined, desired: DatabaseSync | undefined;
  let phase='INPUT';
  try {
    const originalSource=await privatePath(options.source.path);
    assert(digestPattern.test(options.source.sha256)&&await sha256File(originalSource)===options.source.sha256,'INPUT_HASH_MISMATCH');
    let sourcePath=originalSource,sourceSqliteSha256=options.source.sha256;
    if(options.source.kind==='sql'){
      const scratch=await mkdtemp(resolve(dirname(originalSource),'.protected-sql-'));
      sourcePath=resolve(scratch,'materialized.sqlite');
      try{
        execFileSync(process.versions['bun']?'node':process.execPath,[new URL('./protected-sql-import.mjs',import.meta.url).pathname,originalSource,sourcePath],{timeout:180000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
      }catch(error){
        let code='SQL_IMPORT_REFUSED';
        if(error&&typeof error==='object'&&'stderr' in error){try{const parsed:unknown=JSON.parse(String(error.stderr));if(parsed&&typeof parsed==='object'&&'code' in parsed&&typeof parsed.code==='string'&&/^[A-Z_]+$/.test(parsed.code))code=parsed.code;}catch{/* No raw child exception or SQL reaches public errors. */}}
        throw new ProtectedStateError(code);
      }
      sourceSqliteSha256=await sha256File(sourcePath);
    }
    await sealedDatabase(sourcePath,sourceSqliteSha256);
    const targetPath = await sealedDatabase(options.targetSqlite.path, options.targetSqlite.sha256);
    assert(sourcePath !== targetPath, 'SOURCE_TARGET_SAME');
    const authPath = await privatePath(options.legacyAuth.path);
    assert(digestPattern.test(options.legacyAuth.sha256) && await sha256File(authPath) === options.legacyAuth.sha256, 'INPUT_HASH_MISMATCH');
    assert((await lstat(authPath)).size <= 64 * 1024 * 1024, 'AUTH_EXPORT_SIZE');
    const bundlePath = resolve(options.cutoverBundle.path);
    assert(await sha256File(resolve(bundlePath,'manifest.json')) === options.cutoverBundle.manifestSha256, 'INPUT_HASH_MISMATCH');
    const cutover = await verifyTextCutover(bundlePath);
    phase='OPEN';source = openProtectedDatabase(sourcePath); target = openProtectedDatabase(targetPath); desired = new Database(':memory:');
    phase='SCHEMA';
    healthy(source); healthy(target); knownProtectedSchema(source);knownProtectedSchema(target);emptyProtectedTarget(target);
    for (const table of order.filter(t => !authTables.includes(t))) checkSchema(target,table);
    const sourceState = [...tableRows(source,'corpus_state',true)].map(row => rowValues('corpus_state',row));
    const targetState = [...tableRows(target,'corpus_state',true)].map(row => rowValues('corpus_state',row));
    assert(sourceState.length === 1 && targetState.length === 1, 'CORPUS_PUBLICATION_REQUIRED');
    const state = sourceState[0]!;
    assert(cutover.revision === `${state[1]}:${state[6] ?? 'legacy'}` && state[4] === cutover.rowCount &&
      equal([state[0],state[1],state[2],state[4],state[6]],[targetState[0]![0],targetState[0]![1],targetState[0]![2],targetState[0]![4],targetState[0]![6]]), 'CORPUS_PUBLICATION_MISMATCH');
    phase='CORPUS';const projection = COMPACT_STATUTE_COLUMNS.join(',');
    const from = source.prepare(`SELECT ${projection} FROM statute_sections ORDER BY id COLLATE BINARY`).iterate();
    const to = target.prepare(`SELECT ${projection} FROM statute_sections ORDER BY id COLLATE BINARY`).iterate();
    const digest = new IndexDigester(),metadataHash=createHash('sha256'); let rows = 0;
    for await (const backup of jsonLines(resolve(bundlePath,'backup.jsonl'))) {
      const a = from.next(), b = to.next(); assert(!a.done && !b.done, 'CORPUS_ROWS_MISMATCH');
      assert(COMPACT_STATUTE_COLUMNS.filter(c => c !== 'text').every(c => equal(a.value[c],backup[c]) && equal(b.value[c],backup[c])) &&
        b.value['text'] === '' && (a.value['text'] === '' || a.value['text'] === backup['text']), 'CORPUS_FINGERPRINT_MISMATCH');
      metadataHash.update(JSON.stringify(COMPACT_STATUTE_COLUMNS.filter(c=>c!=='text').map(c=>b.value[c]))+'\n');
      digest.add({id:String(backup['id']),fp:String(backup['text_hash'])}); rows++;
    }
    assert(from.next().done && to.next().done && rows === cutover.rowCount, 'CORPUS_ROWS_MISMATCH');
    const corpusDigest = digest.digest();
    phase='AUTH';transaction(desired, () => mergeAuth(source!,desired!,JSON.parse(readFileSync(authPath,'utf8'))));
    // Validate all source rows, including completed operation identities, before
    // creating any output. Absent legacy parser/mutation schema is explicit.
    for (const table of order.filter(t => !authTables.includes(t) && t !== 'sqlite_sequence')) for (const row of tableRows(source,table,true)) rowValues(table,row);
    for (const name of history) {
      const seq = source.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);
      const maximum = Number(source.prepare(`SELECT coalesce(max(id),0) AS n FROM ${name}`).get()?.['n']);
      assert(seq.length <= 1 && (seq.length === 1 ? Number.isSafeInteger(seq[0]!['seq']) && Number(seq[0]!['seq']) >= maximum : maximum === 0), 'SOURCE_SEQUENCE_REQUIRED');
    }
    phase='PLAN';const output = resolve(options.outputDirectory);
    await privatePath(dirname(output),true);
    await mkdir(output,{mode:0o700});
    const fd = openSync(resolve(output,'pages.jsonl'),'wx',0o600); let pageNo = 0;
    const stats = {} as Record<Table,TableDigest>;
    try {
      for (const table of order) {
        const db = authTables.includes(table) ? desired : source;
        const hash = createHash('sha256'); let count = 0; let pending: Scalar[][] = [];
        const flush = () => {
          if (!pending.length) return;
          const body = {page:++pageNo,table,rows:pending};
          writeFileSync(fd,JSON.stringify({...body,sha256:sha(protectedPageCanonical(body))})+'\n'); pending=[];
        };
        for (const row of tableRows(db,table,true)) {
          const values = rowValues(table,row); hash.update(canonical(values)); count++;
          if (pending.length === maxRows || Buffer.byteLength(JSON.stringify({page:pageNo+1,table,rows:[...pending,values],sha256:'0'.repeat(64)})) > maxPageBytes) flush();
          assert(Buffer.byteLength(JSON.stringify(values)) < maxPageBytes - 256,'PROTECTED_ROW_SIZE'); pending.push(values);
        }
        flush(); stats[table]={rows:count,sha256:hash.digest('hex')};
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const manifest: ProtectedManifest = {format:1,sourceKind:options.source.kind,sourceSha256:options.source.sha256,sourceSqliteSha256,legacyAuthSha256:options.legacyAuth.sha256,targetSha256:options.targetSqlite.sha256,
      cutoverManifestSha256:options.cutoverBundle.manifestSha256,corpusDigest,corpusMetadataSha256:metadataHash.digest('hex'),corpusRows:rows,revision:cutover.revision,initialPublication:targetState,
      pages:pageNo,pagesSha256:await sha256File(resolve(output,'pages.jsonl')),tables:stats};
    assert(await sha256File(sourcePath) === sourceSqliteSha256 && await sha256File(originalSource)===options.source.sha256 && await sha256File(targetPath) === options.targetSqlite.sha256 &&
      await sha256File(authPath) === options.legacyAuth.sha256,'INPUT_CHANGED');
    const manifestText = JSON.stringify(manifest,null,2)+'\n';
    const manifestFd=openSync(resolve(output,'manifest.json'),'wx',0o600);
    try{writeFileSync(manifestFd,manifestText);fsyncSync(manifestFd);}finally{closeSync(manifestFd);}
    for(const path of [output,dirname(output)]){const dir=openSync(path,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
    return {manifestSha256:sha(manifestText),pages:pageNo,rows:Object.fromEntries(order.map(t=>[t,stats[t].rows]))};
  } catch(error) { if(error instanceof ProtectedStateError)throw error;throw new ProtectedStateError('PROTECTED_STATE_FAILURE_'+phase); }
  finally {source?.close();target?.close();desired?.close();}
}

const journalSchema = `CREATE TABLE protected_state_restore(id INTEGER PRIMARY KEY CHECK(id=1),manifest_sha256 TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE protected_state_pages(page INTEGER PRIMARY KEY,sha256 TEXT NOT NULL);`;
async function loadPlan(directory: string, expected: string) {
  const root = await privatePath(directory,true), manifestPath = await privatePath(resolve(root,'manifest.json'));
  assert(digestPattern.test(expected) && await sha256File(manifestPath) === expected,'MANIFEST_HASH_MISMATCH');
  const manifest = checkedManifest(JSON.parse(await readFile(manifestPath,'utf8')));
  const pagesPath = await privatePath(resolve(root,'pages.jsonl'));
  assert(await sha256File(pagesPath) === manifest.pagesSha256,'PAGES_HASH_MISMATCH');
  let n=0; const hashes = Object.fromEntries(order.map(t=>[t,createHash('sha256')])) as Record<Table,ReturnType<typeof createHash>>;
  const counts = Object.fromEntries(order.map(t=>[t,0])) as Record<Table,number>; let lastTable=-1;
  for await (const value of jsonLines(pagesPath)) {
    const p=await checkedPage(value); assert(p.page===++n && order.indexOf(p.table)>=lastTable,'PAGE_ORDER');lastTable=order.indexOf(p.table);
    for(const row of p.rows){hashes[p.table].update(canonical(row));counts[p.table]++;}
  }
  assert(n===manifest.pages&&order.every(t=>counts[t]===manifest.tables[t].rows&&hashes[t].digest('hex')===manifest.tables[t].sha256),'PLAN_TABLE_DIGEST');
  return {manifest,pagesPath};
}
/** Reuse full private-file, page and table-digest checks for D1 admission sidecars. */
export {loadPlan as loadProtectedStatePlan};
function corpusIdentity(db: DatabaseSync) {
  const digest=new IndexDigester(),metadata=createHash('sha256');let rows=0;
  for(const row of db.prepare(`SELECT ${COMPACT_STATUTE_COLUMNS.join(',')} FROM statute_sections ORDER BY id COLLATE BINARY`).iterate()){
    assert(typeof row['id']==='string'&&typeof row['text_hash']==='string'&&/^[a-f0-9]{32}$/.test(row['text_hash'])&&row['text']==='','CORPUS_FINGERPRINT_MISMATCH');
    metadata.update(JSON.stringify(COMPACT_STATUTE_COLUMNS.filter(c=>c!=='text').map(c=>row[c]))+'\n');
    digest.add({id:row['id'],fp:row['text_hash']});rows++;
  }
  return {rows,digest:digest.digest(),metadataSha256:metadata.digest('hex')};
}
function verifyRows(db: DatabaseSync, page: ProtectedPage) {
  const key=tables[page.table][0];
  for(const row of page.rows){
    const current=db.prepare(`SELECT ${tables[page.table].join(',')} FROM ${page.table} WHERE ${key}=?`).all(row[0]!);
    assert(current.length===1&&equal(rowValues(page.table,current[0]!),row),'REPLAY_ROW_MISMATCH');
  }
}
function verifyFinal(db: DatabaseSync, m: ProtectedManifest) {
  const identity=corpusIdentity(db);assert(identity.rows===m.corpusRows&&identity.digest===m.corpusDigest&&identity.metadataSha256===m.corpusMetadataSha256,'CORPUS_FINGERPRINT_MISMATCH');
  for(const table of order)assert(equal(hashRows(db,table),m.tables[table]),'TARGET_TABLE_DIGEST');
  healthy(db);
}
async function verifyCheckpoint(db:DatabaseSync,pagesPath:string,m:ProtectedManifest){
  const counts=Object.fromEntries(order.map(t=>[t,0])) as Record<Table,number>;
  let gap=false,recorded=0,stateCopied=false,sequenceCopied=false;
  const sequences=new Map<string,number>();
  for await(const value of jsonLines(pagesPath)){
    const page=await checkedPage(value),receipt=db.prepare('SELECT sha256 FROM protected_state_pages WHERE page=?').get(page.page);
    if(page.table==='sqlite_sequence')for(const row of page.rows)sequences.set(String(row[0]),Number(row[1]));
    if(!receipt){gap=true;continue;}
    assert(!gap&&receipt['sha256']===page.sha256,'PAGE_RECEIPT_MISMATCH');verifyRows(db,page);recorded++;
    counts[page.table]+=page.rows.length;if(page.table==='corpus_state')stateCopied=true;if(page.table==='sqlite_sequence')sequenceCopied=true;
  }
  assert(count(db,'protected_state_pages')===recorded,'PAGE_RECEIPT_MISMATCH');
  for(const table of order.filter(t=>t!=='sqlite_sequence'))assert(count(db,table)===counts[table]+(table==='corpus_state'&&!stateCopied?m.initialPublication.length:0),'TARGET_UNJOURNALED_ROWS');
  if(!stateCopied)assert(equal([...tableRows(db,'corpus_state')].map(row=>rowValues('corpus_state',row)),m.initialPublication),'TARGET_PUBLICATION_CHANGED');
  for(const name of history){
    const actual=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(name);
    assert(actual.length<=1,'INVALID_SEQUENCE');
    const maximum=Number(db.prepare(`SELECT coalesce(max(id),0) AS n FROM ${name}`).get()?.['n']);
    const expected=sequenceCopied?sequences.get(name)??0:maximum;
    assert((actual.length?Number(actual[0]!['seq']):0)===expected,'SEQUENCE_WOULD_REGRESS');
  }
}
export async function applyProtectedState(options:{directory:string;manifestSha256:string;targetSqlite:string;
  /** Fault/progress hooks stay local; the CLI exposes neither. */ beforeCommit?:(page:number)=>void; afterCommit?:(page:number)=>void}) {
  let db:DatabaseSync|undefined;
  try{
    const {manifest:m,pagesPath}=await loadPlan(options.directory,options.manifestSha256);
    const target=await sealedDatabase(options.targetSqlite);const initialSha=await sha256File(target);
    db=openProtectedDatabase(target,false);
    const identity=corpusIdentity(db);assert(identity.rows===m.corpusRows&&identity.digest===m.corpusDigest&&identity.metadataSha256===m.corpusMetadataSha256,'CORPUS_FINGERPRINT_MISMATCH');
    if(!exists(db,'protected_state_restore')){
      assert(initialSha===m.targetSha256,'TARGET_PREIMAGE_MISMATCH');emptyProtectedTarget(db);
      assert(equal([...tableRows(db,'corpus_state',true)].map(row=>rowValues('corpus_state',row)),m.initialPublication),'TARGET_PUBLICATION_CHANGED');
      transaction(db,()=>{
        if(!exists(db!,'workspace'))db!.exec(readFileSync(new URL('../../migrations/0005_workspace_auth.sql',import.meta.url),'utf8'));
        for(const table of order)checkSchema(db!,table);
        db!.exec(journalSchema);db!.prepare('INSERT INTO protected_state_restore VALUES(1,?,0)').run(options.manifestSha256);
      });
    }
    const marker=db.prepare('SELECT manifest_sha256,complete FROM protected_state_restore WHERE id=1').get();
    assert(marker?.['manifest_sha256']===options.manifestSha256&&[0,1].includes(Number(marker['complete'])),'TARGET_PLAN_MISMATCH');
    await verifyCheckpoint(db,pagesPath,m);
    let applied=0,skipped=0;
    for await(const value of jsonLines(pagesPath)){
      const page=await checkedPage(value);
      transaction(db,()=>{
        const recorded=db!.prepare('SELECT sha256 FROM protected_state_pages WHERE page=?').get(page.page);
        if(recorded){assert(recorded['sha256']===page.sha256,'PAGE_RECEIPT_MISMATCH');verifyRows(db!,page);skipped++;return;}
        assert(Number(db!.prepare('SELECT coalesce(max(page),0) AS n FROM protected_state_pages').get()?.['n'])===page.page-1,'PAGE_ORDER');
        if(page.table==='corpus_state'){
          assert(equal([...tableRows(db!,'corpus_state')].map(row=>rowValues('corpus_state',row)),m.initialPublication),'TARGET_PUBLICATION_CHANGED');
          db!.prepare('DELETE FROM corpus_state WHERE corpus_id=?').run(corpus);
        }
        for(const row of page.rows){
          if(page.table==='sqlite_sequence'){
            const current=db!.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').all(row[0]!);
            assert(current.length<=1&&(!current.length||Number(current[0]!['seq'])<=Number(row[1])),'SEQUENCE_WOULD_REGRESS');
            if(current.length)db!.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row[1]!,row[0]!);else insert(db!,page.table,row);
          }else insert(db!,page.table,row);
        }
        verifyRows(db!,page);db!.prepare('INSERT INTO protected_state_pages VALUES(?,?)').run(page.page,page.sha256);
        options.beforeCommit?.(page.page);applied++;
      });
      options.afterCommit?.(page.page);
    }
    transaction(db,()=>{assert(count(db!,'protected_state_pages')===m.pages,'PAGE_COUNT');verifyFinal(db!,m);db!.exec('UPDATE protected_state_restore SET complete=1 WHERE id=1');});
    return {manifestSha256:options.manifestSha256,verified:true,appliedPages:applied,skippedPages:skipped,tableRows:Object.fromEntries(order.map(t=>[t,m.tables[t].rows]))};
  }catch(error){safeError(error);}finally{db?.close();}
}
export async function verifyProtectedState(options:{directory:string;manifestSha256:string;targetSqlite:string}) {
  let db:DatabaseSync|undefined;
  try{
    const {manifest:m,pagesPath}=await loadPlan(options.directory,options.manifestSha256);
    db=openProtectedDatabase(await sealedDatabase(options.targetSqlite));
    const marker=db.prepare('SELECT manifest_sha256,complete FROM protected_state_restore WHERE id=1').get();
    assert(marker?.['manifest_sha256']===options.manifestSha256&&marker['complete']===1,'RESTORE_NOT_COMPLETE');
    assert(Number(db.prepare('SELECT count(*) AS n FROM protected_state_pages').get()?.['n'])===m.pages,'PAGE_COUNT');await verifyCheckpoint(db,pagesPath,m);verifyFinal(db,m);
    return {verified:true,manifestSha256:options.manifestSha256,pages:m.pages,tableRows:Object.fromEntries(order.map(t=>[t,m.tables[t].rows]))};
  }catch(error){safeError(error);}finally{db?.close();}
}
