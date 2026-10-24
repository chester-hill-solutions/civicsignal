import {afterEach,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createRequire} from 'node:module';
import {existsSync,realpathSync} from 'node:fs';
import {chmod,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {DatabaseSync as Sqlite} from 'node:sqlite';
import {prepareProtectedD1Fixture,protectedD1FixtureMain} from '../scripts/prepare-protected-state-d1-fixture';
import {runProtectedD1FullWindow} from '../scripts/lib/protected-state-d1-client';
import {restoreTextStaging} from '../scripts/restore-text-staging';
import {PROTECTED_TABLE_COLUMNS,PROTECTED_TABLE_ORDER} from '../src/corpora/protected-state-format';

const reads=vi.hoisted(()=>({paths:[] as string[]}));
vi.mock('node:fs/promises',async original=>{const actual=await original<typeof import('node:fs/promises')>();return {...actual,readFile:(...args:Parameters<typeof actual.readFile>)=>{reads.paths.push(String(args[0]));return actual.readFile(...args);}};});
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as {DatabaseSync:typeof Sqlite};
const run=promisify(execFile),ROOT=resolve('.'),TOKEN='SYNTHETIC-LOCAL-RESTORE-ONLY-'.repeat(3);
const cleanup:(()=>Promise<unknown>|void)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();reads.paths=[];});
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'protected-synthetic-prep-')));await chmod(root,0o700);cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const target={format:1,stageOnly:true,stageId:'stage-synthetic-copy',accountId:'a'.repeat(32),d1Id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',r2Bucket:'synthetic-protected-stage-copy',adminUrl:'https://civicsignal-v1-stage-restore-synthetic.example.workers.dev'};
 const targetFile=join(root,'returned-target.json'),credentialFile=join(root,'credential.json'),outputDirectory=join(root,'fixture');
 await writeFile(targetFile,JSON.stringify(target),{mode:0o600});
 // Deliberately not JSON: preparation must inspect metadata, never this payload.
 await writeFile(credentialFile,'SYNTHETIC INVALID CREDENTIAL PAYLOAD',{mode:0o600});
 return {root,target,targetFile,credentialFile,outputDirectory,options:{outputDirectory,targetFile,credentialFile}};
}
async function recursiveFiles(path:string):Promise<string[]>{const paths:string[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);expect((await stat(p)).mode&0o777).toBe(entry.isDirectory()?0o700:0o600);paths.push(...entry.isDirectory()?await recursiveFiles(p):[p]);}return paths;}

describe('synthetic protected-copy preparation',()=>{
 it('uses real preparation functions, exact explicit target and no credential/network reads',async()=>{
  const f=await fixture(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Network forbidden'));
  const proof=await prepareProtectedD1Fixture(f.options);expect(proof).toMatchObject({synthetic:true,preparedOnly:true,executionApproved:false,hostedCopyExecuted:false,productionIdentityMigrationProved:false,commonProductionFreezeProved:false,credentialBytesRead:0,networkRequests:0,expected:{corpusRows:18,compactPages:2,textSteps:3,protectedPages:8,successfulPostRequests:25,successfulFullWindowRequests:26,activeKeys:1,revokedKeys:1,protectedTables:8}});
  expect(reads.paths).not.toContain(f.credentialFile);expect(network).not.toHaveBeenCalled();expect(proof.target).toEqual(f.target);
  const config=JSON.parse(await readFile(proof.restoreConfig.path,'utf8'));expect(config).toMatchObject({name:'civicsignal-v1-stage-restore-synthetic',account_id:f.target.accountId,routes:[],d1_databases:[{binding:'RESTORE_DB',database_id:f.target.d1Id}],r2_buckets:[{binding:'RESTORE_TEXTS',bucket_name:f.target.r2Bucket}],vars:{RESTORE_ENABLED:'staging-only',RESTORE_PROTECTED_ENABLED:'staging-only',RESTORE_D1_ID:f.target.d1Id,RESTORE_R2_NAME:f.target.r2Bucket,RESTORE_PROTECTED_MANIFEST_SHA256:proof.inspection.pins.manifestSha256,RESTORE_PROTECTED_ADMISSION_SHA256:proof.inspection.pins.admissionSha256}});expect(config.vars).not.toHaveProperty('RESTORE_TOKEN');expect(config).not.toHaveProperty('durable_objects');
  const files=await recursiveFiles(f.outputDirectory);expect(files.every(p=>!p.endsWith('reviewed.json')&&!p.endsWith('started.json'))).toBe(true);expect(existsSync(join(f.outputDirectory,'journal'))).toBe(false);expect(existsSync(join(f.outputDirectory,'journal.owned'))).toBe(false);
 });
 it('seals all8 nonempty tables, Unicode, active/revoked keys and actual deleted-ID highwaters',async()=>{
  const f=await fixture(),proof=await prepareProtectedD1Fixture(f.options),db=new DatabaseSync(proof.source.sourceSqlitePath,{readOnly:true});
  try{for(const table of PROTECTED_TABLE_ORDER)expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBeGreaterThan(0);expect(db.prepare('SELECT name FROM workspace').get()!.name).toContain('Français 👩🏽‍⚖️');expect(db.prepare('SELECT status FROM workspace_api_key ORDER BY status').all()).toEqual([{status:'active'},{status:'revoked'}]);expect(db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name").all()).toEqual([{name:'corpus_changes',seq:1000},{name:'corpus_runs',seq:120}]);expect(db.prepare('SELECT max(id) AS n FROM corpus_runs').get()!.n).toBe(2);expect(db.prepare('SELECT max(id) AS n FROM corpus_changes').get()!.n).toBe(10);}finally{db.close();}
  const admission=JSON.parse(await readFile(join(f.outputDirectory,'admission.json'),'utf8'));expect(admission.sequences).toEqual({corpus_runs:120,corpus_changes:1000});expect(admission.compactPlan.revision).toBe('d'.repeat(40)+':statutes-v2');expect(admission.compactPlan).not.toHaveProperty('sourceReceiptSha256');
 });
 it.each([
  {label:'production D1',patch:{d1Id:'8056b1a0-f858-4f89-a332-91f7f350eb7b'}},
  {label:'production R2',patch:{r2Bucket:'civicsignal-corpus'}},
  {label:'original stage D1',patch:{d1Id:'e0fa8e43-82f9-4864-b237-6e82d77a860c'}},
  {label:'original stage R2',patch:{r2Bucket:'civicsignal-v1-stage-corpus-20261022'}}
 ])('refuses $label before creating fixture output',async({patch})=>{
  const f=await fixture();await writeFile(f.targetFile,JSON.stringify({...f.target,...patch}));await expect(prepareProtectedD1Fixture(f.options)).rejects.toBeDefined();expect(existsSync(f.outputDirectory)).toBe(false);
 });
 it('refuses weak credential metadata without reading its bytes or creating output',async()=>{
  const f=await fixture();await chmod(f.credentialFile,0o644);await expect(prepareProtectedD1Fixture(f.options)).rejects.toBeDefined();expect(reads.paths).not.toContain(f.credentialFile);expect(existsSync(f.outputDirectory)).toBe(false);
 });
 it('refuses combined target/credential alias before any payload read',async()=>{
  const f=await fixture();await writeFile(f.targetFile,JSON.stringify({...f.target,RESTORE_TOKEN:'SYNTHETIC-COMBINED-FILE-VALUE'}));
  await expect(prepareProtectedD1Fixture({...f.options,credentialFile:f.targetFile})).rejects.toBeDefined();expect(reads.paths).toEqual([]);expect(existsSync(f.outputDirectory)).toBe(false);
 });
 it('refuses input/output aliases before reading either input payload',async()=>{
  const f=await fixture();
  for(const outputDirectory of[f.targetFile,f.credentialFile,f.root])await expect(prepareProtectedD1Fixture({...f.options,outputDirectory})).rejects.toBeDefined();
  expect(reads.paths).toEqual([]);expect(existsSync(f.outputDirectory)).toBe(false);
 });
 it('preserves a prepared fixture on rerun and rejects extra/duplicate CLI flags',async()=>{
  const f=await fixture();await prepareProtectedD1Fixture(f.options);const original=await readFile(join(f.outputDirectory,'preparation.json'));await expect(prepareProtectedD1Fixture(f.options)).rejects.toBeDefined();expect(await readFile(join(f.outputDirectory,'preparation.json'))).toEqual(original);
  for(const args of [['--output',f.outputDirectory,'--output',f.outputDirectory],['--execute','true'],['--output',f.outputDirectory,'--target',f.targetFile,'--credential-file',f.credentialFile,'--unknown','x']])await expect(protectedD1FixtureMain(args)).rejects.toBeDefined();
 });
 it('feeds the unchanged fixed builder a prepared-unapproved one-window template',async()=>{
  const f=await fixture(),proof=await prepareProtectedD1Fixture(f.options),bun=realpathSync((process.env.PATH??'').split(':').map(p=>join(p,'bun')).find(p=>existsSync(p))!);
  const built=await run(process.execPath,[join(ROOT,'scripts/build-protected-state-d1-owned.mjs'),'--inputs',proof.ownedInputs.path,'--bun',bun],{env:{PATH:'/usr/bin:/bin'},timeout:30000,maxBuffer:1048576});expect(JSON.parse(built.stdout)).toMatchObject({preparedOnly:true,executionApproved:false,credentialBytesRead:0});const registry=join(f.outputDirectory,'journal.owned'),review=JSON.parse(await readFile(join(registry,'window-000001.review-template.json'),'utf8'));
  expect(review).toMatchObject({authority:'prepared-unapproved',executeOneWindow:false,validUntil:null,mode:'full',window:1,target:f.target,automaticNextWindow:false,allowanceExtension:false,limits:{maxRequests:64,wallMs:300000,requestMs:15000}});expect(await readdir(registry)).not.toContain('window-000001');expect(existsSync(join(f.outputDirectory,'journal'))).toBe(false);
 },30000);
});

describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('synthetic fixture through actual local D1/R2',()=>{
 it('completes the unchanged full client in exactly26 requests and matches every protected value',async()=>{
  const f=await fixture(),proof=await prepareProtectedD1Fixture(f.options),inputs=JSON.parse(await readFile(proof.ownedInputs.path,'utf8'));
  const worker=await build({stdin:{loader:'ts',resolveDir:ROOT,contents:"import {handleRestoreRequest} from './services/restore/worker';export default {fetch:handleRestoreRequest};"},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'}),config=JSON.parse(await readFile(proof.restoreConfig.path,'utf8'));
  const mf=new Miniflare({
   telemetry:{enabled:false},unsafeDevRegistryPath:join(f.root,'registry'),resourcePersistencePath:join(f.root,'persistence'),
   workers:[{
    config:{name:'synthetic-protected-copy-local',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],env:{
     RESTORE_DB:{type:'d1',id:f.target.d1Id,dev:{remote:false}},RESTORE_TEXTS:{type:'r2',name:f.target.r2Bucket,dev:{remote:false}},
     ...Object.fromEntries(Object.entries({...config.vars,RESTORE_TOKEN:TOKEN}).map(([key,value])=>[key,{type:'text' as const,value}]))},
     manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:worker.outputFiles[0]!.text}}}},
    dev:{outboundService:{type:'fetcher',handler:async()=>{throw Error('External networking forbidden.');}}}
   }]
  });cleanup.push(()=>mf.dispose());
  const requests:string[]=[];const send:typeof fetch=async(url,init)=>{const req=new Request(url,init),body=req.method==='GET'?undefined:new Uint8Array(await req.arrayBuffer());if(req.url.includes('/protected/'))requests.push(req.method+' '+new URL(req.url).pathname);const response=await mf.dispatchFetch(req.url,{method:req.method,headers:[...req.headers],...(body?{body}:{})});return new Response(await response.arrayBuffer(),{status:response.status,headers:[...response.headers]});};
  await restoreTextStaging({bundle:inputs.cutoverBundle,target:f.target,execute:true,token:TOKEN,checkpoint:join(f.root,'compact-restore.json'),fetch:send});
  const result=await runProtectedD1FullWindow({directory:inputs.directory,manifestSha256:inputs.manifestSha256,cutoverBundle:inputs.cutoverBundle,target:f.target,admissionPath:inputs.admissionPath,admissionSha256:inputs.admissionSha256,admissionFileSha256:inputs.admissionFileSha256,journalDirectory:inputs.journalDirectory,credential:()=>TOKEN,fetch:send});
  expect(result).toMatchObject({window:1,outcome:'complete',attempts:26,progress:{phase:'complete',complete:true,textRows:18,textComplete:true,loadedPages:8,verifiedPages:8,compactPages:2,compactRows:18}});expect(requests).toHaveLength(26);expect(requests.filter(r=>r.startsWith('POST'))).toHaveLength(25);expect(requests.filter(r=>r.startsWith('POST /v1/restore/protected/text'))).toHaveLength(3);
  const db=await mf.getD1Database('RESTORE_DB'),source=new DatabaseSync(proof.source.sourceSqlitePath,{readOnly:true});try{for(const table of PROTECTED_TABLE_ORDER){const columns=PROTECTED_TABLE_COLUMNS[table],where=table==='sqlite_sequence'?" WHERE name IN ('corpus_runs','corpus_changes')":'',sql=`SELECT ${columns.join(',')} FROM ${table}${where} ORDER BY ${columns[0]}`;expect((await db.prepare(sql).all()).results).toEqual(source.prepare(sql).all());}}finally{source.close();}
  const owned=await readdir(inputs.journalDirectory);expect(owned.sort()).toEqual(['plan.json','window-000001']);expect(existsSync(join(inputs.journalDirectory,'window-000001','accepted.json'))).toBe(true);
 },60000);
});
