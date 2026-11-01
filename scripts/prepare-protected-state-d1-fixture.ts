/** Synthetic local preparation only. No network, secret reads or execution. */
import {createRequire} from 'node:module';
import {closeSync,fsyncSync,openSync,writeFileSync} from 'node:fs';
import {chmod,lstat,mkdir,readFile,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync as Sqlite} from 'node:sqlite';
import {prepareTextCutover,jsonLines,sha256File} from './prepare-text-cutover';
import {prepareProtectedState,privatePath} from './lib/protected-state';
import {prepareProtectedD1Admission} from './lib/protected-state-d1';
import {inspectProtectedD1Client} from './lib/protected-state-d1-client';
import {localD1} from './lib/local-d1';
import {COMPACT_CORPUS_SCHEMA,COMPACT_STATUTE_COLUMNS,INSERT_COMPACT_STATUTE_SQL,applyCompactRestorePage,type CompactRestorePage} from '../src/corpora/compact-restore';
import {rowFingerprintWithText} from '../src/corpora/text-store';
import {checkedTarget,RESTORE_SUPPORT_SCHEMA} from '../services/restore/protocol';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sqlite=createRequire(import.meta.url)(process.versions['bun']?'bun:sqlite':'node:sqlite') as {Database:typeof Sqlite;DatabaseSync:typeof Sqlite};
const Database=process.versions['bun']?sqlite.Database:sqlite.DatabaseSync;
const COMMIT='d'.repeat(40),PARSER='statutes-v2',DATE='2026-10-15',BASELINE='2026-10-15T00:00:00.000Z',SOURCE_TIME='2026-10-22T00:00:00.000Z';
function requireFixture(value:unknown):asserts value{if(!value)throw Error('SYNTHETIC_PROTECTED_PREPARATION_REFUSED');}
function write(path:string,value:unknown){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));}
function syncDirectory(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
async function makePrivate(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);requireFixture(!entry.isSymbolicLink());if(entry.isDirectory())await makePrivate(child);else await chmod(child,0o600);}await chmod(path,0o700);}
async function credentialMetadata(path:string){const actual=await privatePath(path),s=await lstat(actual,{bigint:true});requireFixture(actual===path&&s.size<=4096n&&(Number(s.mode)&0o777)===0o600);return {path:actual,dev:String(s.dev),ino:String(s.ino),size:Number(s.size),mtimeNs:String(s.mtimeNs),uid:Number(s.uid),mode:Number(s.mode)&0o777};}

export async function prepareProtectedD1Fixture(options:{outputDirectory:string;targetFile:string;credentialFile:string}){
 const output=resolve(options.outputDirectory);requireFixture(output===options.outputDirectory);await privatePath(dirname(output),true);
 const targetPath=await privatePath(options.targetFile),targetMetadata=await lstat(targetPath,{bigint:true});requireFixture(targetMetadata.size<=16384n);
 const credential=await credentialMetadata(options.credentialFile);
 // Both inputs are metadata-checked before reading either payload. In
 // particular, a combined target/credential file is never a target read.
 requireFixture(targetPath!==credential.path&&(String(targetMetadata.dev)!==credential.dev||String(targetMetadata.ino)!==credential.ino));
 for(const inputPath of[targetPath,credential.path])requireFixture(inputPath!==output&&!inputPath.startsWith(output+'/'));
 const targetRaw=await readFile(targetPath);requireFixture(targetRaw.length<=16384);
 const target=checkedTarget(JSON.parse(targetRaw.toString('utf8')) as unknown);
 // The populated original staging resources are never this fixture's target.
 requireFixture(target.d1Id!=='e0fa8e43-82f9-4864-b237-6e82d77a860c'&&target.r2Bucket!=='civicsignal-v1-stage-corpus-20261022'&&target.stageId!=='stage-20261022');
 await mkdir(output,{mode:0o700});syncDirectory(dirname(output));
 const source=join(output,'synthetic-source.sqlite'),initial=join(output,'compact.sqlite'),input=join(output,'rows.jsonl'),auth=join(output,'empty-legacy-auth.json'),cutoverBundle=join(output,'cutover'),directory=join(output,'protected');
 const rows=Array.from({length:18},(_,at)=>{const row={id:`acts-en-synthetic-${String(at+1).padStart(3,'0')}`,corpus_id:'statutes-canada',act:'Synthetic Fixture Act',section:String(at+1),heading:null,text:`Synthetic rule ${at+1}: Français 👩🏽‍⚖️.`,source_url:`https://example.invalid/synthetic/${at+1}`,jurisdiction:'CA',in_force:1,topics:null,citation:'SYNTHETIC-1',language:'en',schedule:null,part:null,status:'in-force',last_changed:DATE};return {...row,text_hash:rowFingerprintWithText(row,row.text)};});
 const db=new Database(source);
 try{
  for(const name of(await readdir(join(ROOT,'migrations'))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(join(ROOT,'migrations',name),'utf8'));
  for(const row of rows)db.prepare(INSERT_COMPACT_STATUTE_SQL).run(...COMPACT_STATUTE_COLUMNS.map(k=>row[k]));
  db.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',COMMIT,DATE,DATE,18,SOURCE_TIME,PARSER);
  db.prepare('INSERT INTO workspace VALUES(?,?,?,?,?)').run('synthetic-workspace','Synthetic — Français 👩🏽‍⚖️','synthetic-only',1,2);
  db.prepare('INSERT INTO civic_workspace_billing VALUES(?,?,?,?,?,?)').run('synthetic-workspace','free',1200,0,null,1);
  for(const [status,hash]of [['active','b'],['revoked','c']] as const)db.prepare('INSERT INTO workspace_api_key VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`synthetic-${status}`,'synthetic-workspace',`Synthetic ${status}` ,hash.repeat(64),`synthetic-${status}`,'["civicsignal.retrieve"]',status,null,null,1,2);
  const run=db.prepare('INSERT INTO corpus_runs(id,corpus_id,commit_sha,commit_date,ran_at,parser_version) VALUES(?,?,?,?,?,?)');for(const id of[2,120])run.run(id,'statutes-canada',COMMIT,DATE,SOURCE_TIME,PARSER);db.exec('DELETE FROM corpus_runs WHERE id=120');
  const change=db.prepare('INSERT INTO corpus_changes(id,corpus_id,change,row_id,instrument,citation,section,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)');for(const id of[10,1000])change.run(id,'statutes-canada','removed',`synthetic-removed-${id}`,'Synthetic Fixture Act','SYNTHETIC-1','0',DATE,SOURCE_TIME);db.exec('DELETE FROM corpus_changes WHERE id=1000');
  db.prepare('INSERT INTO corpus_mutations VALUES(?,?,NULL,?)').run('synthetic-completed','statutes-canada',SOURCE_TIME);
 }finally{db.close();}await chmod(source,0o600);
 const fd=openSync(input,'wx',0o600);try{writeFileSync(fd,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');fsyncSync(fd);}finally{closeSync(fd);}write(auth,{customers:[],keys:[]});
 const cutover=await prepareTextCutover({input,output:cutoverBundle,revision:COMMIT+':'+PARSER,createdAt:BASELINE,objectStorage:'pack',publication:{commit:COMMIT,parser:PARSER,date:DATE,asOf:DATE,lastRunAt:BASELINE,rows:18}});await makePrivate(cutoverBundle);
 const compact=new Database(initial);
 try{compact.exec(COMPACT_CORPUS_SCHEMA);for await(const raw of jsonLines(join(cutoverBundle,'fresh-pages.jsonl')))await applyCompactRestorePage(localD1(compact),raw as unknown as CompactRestorePage,{bundleSha256:cutover.freshPagesSha256,revision:cutover.revision});compact.exec(RESTORE_SUPPORT_SCHEMA);compact.prepare('INSERT INTO corpus_state VALUES(?,?,?,?,?,?,?)').run('statutes-canada',COMMIT,DATE,DATE,18,BASELINE,PARSER);}finally{compact.close();}await chmod(initial,0o600);
 const prepared=await prepareProtectedState({source:{kind:'sqlite',path:source,sha256:await sha256File(source)},legacyAuth:{path:auth,sha256:await sha256File(auth)},targetSqlite:{path:initial,sha256:await sha256File(initial)},cutoverBundle:{path:cutoverBundle,manifestSha256:await sha256File(join(cutoverBundle,'manifest.json'))},outputDirectory:directory});
 const canonicalTarget=join(output,'target.json');write(canonicalTarget,target);const admissionPath=join(output,'admission.json');
 const admission=await prepareProtectedD1Admission({directory,manifestSha256:prepared.manifestSha256,cutoverBundle,target,outputPath:admissionPath});
 const client={directory,manifestSha256:prepared.manifestSha256,cutoverBundle,target,admissionPath,admissionSha256:admission.admissionSha256,admissionFileSha256:admission.fileSha256};
 const inspection=await inspectProtectedD1Client(client,true);requireFixture(inspection.compactPages===2&&inspection.textAuditSteps===3&&inspection.protectedPages===8&&inspection.minimumPostRequests===25);
 const host=new URL(target.adminUrl).hostname,remote=host.endsWith('.workers.dev'),restoreConfigPath=join(output,'restore-config.prepared-unapproved.json');
 write(restoreConfigPath,{$schema:join(ROOT,'node_modules/wrangler/config-schema.json'),name:remote?host.split('.')[0]:'civicsignal-v1-stage-restore-synthetic',main:join(ROOT,'services/restore/worker.ts'),account_id:target.accountId,compatibility_date:'2026-10-22',compatibility_flags:['nodejs_compat'],observability:{enabled:true},workers_dev:remote,routes:[],vars:{RESTORE_ENABLED:'staging-only',RESTORE_STAGE_ID:target.stageId,RESTORE_ACCOUNT_ID:target.accountId,RESTORE_D1_ID:target.d1Id,RESTORE_R2_NAME:target.r2Bucket,RESTORE_PROTECTED_ENABLED:'staging-only',RESTORE_PROTECTED_MANIFEST_SHA256:prepared.manifestSha256,RESTORE_PROTECTED_ADMISSION_SHA256:admission.admissionSha256},d1_databases:[{binding:'RESTORE_DB',database_id:target.d1Id}],r2_buckets:[{binding:'RESTORE_TEXTS',bucket_name:target.r2Bucket}]});
 const ownedInputsPath=join(output,'owned-inputs.json');write(ownedInputsPath,{format:1,mode:'full',window:1,directory,manifestSha256:prepared.manifestSha256,admissionPath,admissionSha256:admission.admissionSha256,admissionFileSha256:admission.fileSha256,cutoverBundle,targetFile:canonicalTarget,journalDirectory:join(output,'journal'),credentialFile:options.credentialFile,maxRequests:64,wallMs:300000,requestMs:15000});
 requireFixture((await readFile(targetPath)).equals(targetRaw)&&JSON.stringify(await credentialMetadata(options.credentialFile))===JSON.stringify(credential));
 const proof={format:1,kind:'synthetic-protected-d1-fixture',synthetic:true,preparedOnly:true,executionApproved:false,hostedCopyExecuted:false,productionIdentityMigrationProved:false,commonProductionFreezeProved:false,credentialBytesRead:0,networkRequests:0,target,credentialMetadata:credential,source:{commit:COMMIT,parser:PARSER,sourceSqliteSha256:await sha256File(source),sourceSqlitePath:source,sequenceFacts:{corpus_runs:120,corpus_changes:1000},survivingMaximumIds:{corpus_runs:2,corpus_changes:10}},expected:{corpusRows:18,compactPages:2,textSteps:3,protectedPages:8,successfulPostRequests:25,successfulFullWindowRequests:26,activeKeys:1,revokedKeys:1,protectedTables:8},inspection,restoreConfig:{path:restoreConfigPath,sha256:await sha256File(restoreConfigPath)},ownedInputs:{path:ownedInputsPath,sha256:await sha256File(ownedInputsPath)},gates:{newIsolatedTargetMustBeIndependentlyVerified:true,unservedTargetRequired:true,compactRestoreMustCompleteFirst:true,separateRootDeploymentAndWindowReviewsRequired:true,automaticExecution:false,automaticNextWindow:false},limits:{maxRequests:64,wallMs:300000,requestMs:15000}};
 write(join(output,'preparation.json'),proof);return proof;
}

export async function protectedD1FixtureMain(argv:string[]){const flags=new Map<string,string>();for(let n=0;n<argv.length;n+=2){const name=argv[n]!,value=argv[n+1];requireFixture(['--output','--target','--credential-file'].includes(name)&&value&&!value.startsWith('--')&&!flags.has(name));flags.set(name,value);}requireFixture(flags.size===3);return prepareProtectedD1Fixture({outputDirectory:flags.get('--output')!,targetFile:flags.get('--target')!,credentialFile:flags.get('--credential-file')!});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))protectedD1FixtureMain(process.argv.slice(2)).then(v=>console.log(JSON.stringify({preparedOnly:true,executionApproved:false,synthetic:true,successfulFullWindowRequests:v.expected.successfulFullWindowRequests,credentialBytesRead:0,networkRequests:0}))).catch(()=>{console.error(JSON.stringify({error:'synthetic_protected_preparation_refused',executionApproved:false}));process.exitCode=1;});
