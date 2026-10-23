/** Fixed-table local D1 adapter. No HTTP handler, caller SQL, credentials or target creation. */
import {checkedTarget,hashJson,nextPageChain} from '../../services/restore/protocol';
import {COMPACT_STATUTE_COLUMNS,verifyCompactRestorePage,type CompactRestorePage} from './compact-restore';
import {auditProvisionTextPage,type TextObjectReader,type TextParityCheckpoint} from './text-store';
import {PROTECTED_TABLE_COLUMNS as columns,PROTECTED_TABLE_ORDER as tables,PROTECTED_HISTORY_TABLES as history,
  checkedProtectedPage,checkedProtectedRow,protectedRowValues,ProtectedStateError,
  type ProtectedManifest,type ProtectedPage,type ProtectedScalar,type ProtectedTable} from './protected-state-format';
import {checkedProtectedD1Admission,compareProtectedD1Keys,protectedD1Assert as demand,sameProtectedValue as same,ZERO_PROTECTED_CHAIN,
  type ProtectedD1Admission,type ProtectedD1Identity} from './protected-state-d1-admission';
import {checkProtectedD1Schema,PROTECTED_D1_AUTH_SCHEMA,PROTECTED_D1_JOURNAL_SCHEMA,fixedSchemaStatements} from './protected-state-d1-schema';
export type {ProtectedD1Admission,ProtectedD1Identity} from './protected-state-d1-admission';
type Phase='checking-corpus'|'checking-text'|'loading'|'checking-protected'|'checking-corpus-final'|'complete';
type Counts=Record<ProtectedTable,number>;
type Sequences={corpus_runs:number|null;corpus_changes:number|null};
interface Cursor {page:number;table:number;key:ProtectedScalar;chain:string;counts:Counts}
interface CompactCursor {page:number;after:string;rows:number;chain:string}
interface State {phase:Phase;compact:CompactCursor;audit:TextParityCheckpoint|null;load:Cursor;verify:Cursor;publication:ProtectedScalar[];sequences:Sequences}
interface Session {admission_sha256:string;manifest_sha256:string;target_sha256:string;manifest_json:string;admission_json:string;state_json:string;version:number}
interface Loaded {session:Session;manifest:ProtectedManifest;admission:ProtectedD1Admission;state:State;identity:ProtectedD1Identity}
const zeros=()=>Object.fromEntries(tables.map(t=>[t,0])) as Counts;
const cursor=():Cursor=>({page:0,table:-1,key:null,chain:ZERO_PROTECTED_CHAIN,counts:zeros()});
const compact=():CompactCursor=>({page:0,after:'',rows:0,chain:ZERO_PROTECTED_CHAIN});
// Deliberately omit cursor keys, publication values and all protected rows.
const result=(s:State,version:number)=>({phase:s.phase,version,compactPages:s.compact.page,compactRows:s.compact.rows,compactChain:s.compact.chain,
 loadedPages:s.load.page,loadedChain:s.load.chain,verifiedPages:s.verify.page,verifiedChain:s.verify.chain,
 textRows:s.audit?.rowsVerified??0,textBytes:s.audit?.bytesVerified??0,textComplete:s.audit?.complete??false,complete:s.phase==='complete'});
async function safe<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){throw error instanceof ProtectedStateError?error:new ProtectedStateError('PROTECTED_D1_FAILURE');}}
async function session(db:D1Database){const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='protected_state_d1_session'").first();return exists?db.prepare('SELECT * FROM protected_state_d1_session WHERE id=1').first<Session>():null;}
async function load(db:D1Database,identity:ProtectedD1Identity):Promise<Loaded>{
 identity=structuredClone(identity);
 identity.target=checkedTarget(identity.target);
 const record=await session(db);demand(record,'PROTECTED_D1_NOT_STARTED');
 demand(record.admission_sha256===identity.admissionSha256&&record.manifest_sha256===identity.manifestSha256&&record.target_sha256===await hashJson(identity.target)&&Number.isSafeInteger(record.version)&&record.version>=0,'PROTECTED_D1_IDENTITY');
 const manifest=JSON.parse(record.manifest_json) as ProtectedManifest,admission=await checkedProtectedD1Admission(JSON.parse(record.admission_json),manifest,identity),state=JSON.parse(record.state_json) as State;
 demand(['checking-corpus','checking-text','loading','checking-protected','checking-corpus-final','complete'].includes(state.phase)&&state.load.page>=0&&state.load.page<=manifest.pages&&state.verify.page>=0&&state.verify.page<=manifest.pages,'PROTECTED_D1_STATE');
 return {session:record,manifest,admission,state,identity};
}
function expectedCounts(s:State):Counts {const c={...s.load.counts};if(c.corpus_state===0)c.corpus_state=1;c.sqlite_sequence=Object.values(s.sequences).filter(v=>v!==null).length;return c;}
const publicationSelect=`SELECT ${columns.corpus_state.join(',')} FROM corpus_state ORDER BY corpus_id LIMIT 2`;
async function currentPublication(db:D1Database){const r=(await db.prepare(publicationSelect).all<Record<string,unknown>>()).results;demand(r.length===1,'PROTECTED_D1_PUBLICATION');return protectedRowValues('corpus_state',r[0]!);}
async function currentCounts(db:D1Database){const sql=tables.map(t=>`(SELECT count(*) FROM ${t}${t==='sqlite_sequence'?" WHERE name IN ('corpus_runs','corpus_changes')":''}) AS ${t}`).join(',');const row=await db.prepare(`SELECT ${sql}`).first<Counts>();demand(row,'PROTECTED_D1_COUNTS');return row;}
async function sequences(db:D1Database):Promise<Sequences>{const rows=(await db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('corpus_runs','corpus_changes') ORDER BY name").all<{name:typeof history[number];seq:number}>()).results;demand(rows.length<=2&&new Set(rows.map(r=>r.name)).size===rows.length&&rows.every(r=>Number.isSafeInteger(r.seq)&&r.seq>=0),'PROTECTED_D1_SEQUENCE');return {corpus_runs:rows.find(r=>r.name==='corpus_runs')?.seq??null,corpus_changes:rows.find(r=>r.name==='corpus_changes')?.seq??null};}
function stageProof(l:Loaded):ProtectedScalar[]{const a=l.admission,p=a.compactPlan,t=l.identity.target;return [a.compactPlanSha256,JSON.stringify(p),t.stageId,t.accountId,t.d1Id,t.r2Bucket,'complete',p.pageCount,p.pagesChainSha256];}
const stageColumns=['plan_sha256','plan_json','stage_id','account_id','d1_id','r2_name','phase','page_check_after','page_check_chain'];
async function compactMarker(db:D1Database,l:Loaded){
 const p=l.admission.compactPlan,marker=await db.prepare('SELECT bundle_sha256,revision FROM corpus_compact_restore WHERE id=1').first<{bundle_sha256:string;revision:string}>();demand(marker?.bundle_sha256===p.pagesSha256&&marker.revision===p.revision,'PROTECTED_D1_COMPACT_MARKER');
 const stage=await db.prepare(`SELECT ${stageColumns.join(',')} FROM stage_restore_session WHERE id=1`).first<Record<string,unknown>>();demand(stage&&same(stageColumns.map(k=>stage[k]),stageProof(l)),'PROTECTED_D1_STAGE_PROOF');
}
async function preimage(db:D1Database,l:Loaded){
 demand(same(await currentCounts(db),expectedCounts(l.state))&&same(await currentPublication(db),l.state.publication)&&same(await sequences(db),l.state.sequences),'PROTECTED_D1_PREIMAGE');await compactMarker(db,l);
 const marker=await db.prepare('SELECT manifest_sha256,complete FROM protected_state_restore WHERE id=1').first<{manifest_sha256:string;complete:number}>();
 demand(marker?.manifest_sha256===l.identity.manifestSha256&&marker.complete===(l.state.phase==='complete'?1:0),'PROTECTED_D1_MARKER');
 demand((await db.prepare('SELECT count(*) AS n FROM protected_state_pages').first<{n:number}>())?.n===l.state.load.page,'PROTECTED_D1_RECEIPTS');
}
/** A false OR NULL predicate deliberately violates the original receipt constraint. */
function guard(db:D1Database,l:Loaded,s:State,version:number,complete=0):D1PreparedStatement {
 const predicates=['(SELECT admission_sha256 FROM protected_state_d1_session WHERE id=1)=?','(SELECT version FROM protected_state_d1_session WHERE id=1)=?','(SELECT state_json FROM protected_state_d1_session WHERE id=1)=?',
 '(SELECT manifest_sha256 FROM protected_state_restore WHERE id=1)=?','(SELECT complete FROM protected_state_restore WHERE id=1)=?','(SELECT count(*) FROM protected_state_pages)=?',
 '(SELECT bundle_sha256 FROM corpus_compact_restore WHERE id=1)=?','(SELECT revision FROM corpus_compact_restore WHERE id=1)=?'];
 const values:ProtectedScalar[]=[l.identity.admissionSha256,version,JSON.stringify(s),l.identity.manifestSha256,complete,s.load.page,l.admission.compactPlan.pagesSha256,l.admission.compactPlan.revision];
 for(const [n,name]of stageColumns.entries()){predicates.push(`(SELECT ${name} FROM stage_restore_session WHERE id=1) IS ?`);values.push(stageProof(l)[n]!);}
 predicates.push('(SELECT manifest_sha256 FROM protected_state_d1_session WHERE id=1)=?','(SELECT target_sha256 FROM protected_state_d1_session WHERE id=1)=?');values.push(l.identity.manifestSha256,l.admission.targetSha256);
 for(const [n,name]of columns.corpus_state.entries()){predicates.push(`(SELECT ${name} FROM corpus_state WHERE corpus_id='statutes-canada') IS ?`);values.push(s.publication[n]!);}
 predicates.push('(SELECT count(*) FROM corpus_state)=1');
 for(const t of tables){predicates.push(`(SELECT count(*) FROM ${t}${t==='sqlite_sequence'?" WHERE name IN ('corpus_runs','corpus_changes')":''})=?`);values.push(expectedCounts(s)[t]);}
 for(const name of history){predicates.push(`(SELECT count(*) FROM sqlite_sequence WHERE name='${name}')=?`,`(SELECT seq FROM sqlite_sequence WHERE name='${name}') IS ?`);values.push(s.sequences[name]===null?0:1,s.sequences[name]);}
 return db.prepare(`INSERT INTO protected_state_pages(page,sha256) SELECT 0,NULL WHERE COALESCE((${predicates.join(' AND ')}),0)<>1`).bind(...values);
}
async function advance(db:D1Database,l:Loaded,next:State,statements:D1PreparedStatement[]=[],finish=false){
 const update=db.prepare('UPDATE protected_state_d1_session SET state_json=?,version=version+1 WHERE id=1 AND version=? AND state_json=?').bind(JSON.stringify(next),l.session.version,l.session.state_json);
 await db.batch([guard(db,l,l.state,l.session.version),...statements,update,...(finish?[db.prepare('UPDATE protected_state_restore SET complete=1 WHERE id=1 AND complete=0')]:[]),guard(db,l,next,l.session.version+1,finish?1:0)]);
 return result(next,l.session.version+1);
}
/** Read-only reconciliation. No raw row IDs, key cursors or protected values. */
export async function getProtectedD1Status(db:D1Database,identity:ProtectedD1Identity){return safe(async()=>{
 if(!await session(db))return {initialized:false as const};
 const l=await load(db,identity);await preimage(db,l);return {initialized:true as const,...result(l.state,l.session.version)};
 });}
export async function beginProtectedD1(db:D1Database,options:{manifest:ProtectedManifest;admission:ProtectedD1Admission;identity:ProtectedD1Identity}){return safe(async()=>{
 options=structuredClone(options);
 const {manifest,identity}=options,admission=await checkedProtectedD1Admission(options.admission,manifest,identity),old=await session(db);
 if(old){await checkProtectedD1Schema(db,true);const l=await load(db,identity);await preimage(db,l);return result(l.state,l.session.version);}
 const schema=await checkProtectedD1Schema(db,false),publication=await currentPublication(db),seq=await sequences(db);
 demand(same(publication,manifest.initialPublication[0])&&same(seq,{corpus_runs:null,corpus_changes:null}),'PROTECTED_D1_INITIAL_PUBLICATION');
 const counts=await currentCounts(db).catch(()=>null);
 // Missing auth tables are allowed, but every existing protected table is empty.
 const nonAuth=tables.filter(t=>!['workspace','civic_workspace_billing','workspace_api_key','corpus_state','sqlite_sequence'].includes(t));
 for(const table of nonAuth)demand((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{n:number}>())?.n===0,'PROTECTED_D1_POPULATED');
 if(schema.authPresent)demand(counts&&tables.filter(t=>t!=='corpus_state'&&t!=='sqlite_sequence').every(t=>counts[t]===0),'PROTECTED_D1_POPULATED');
 const state:State={phase:'checking-corpus',compact:compact(),audit:null,load:cursor(),verify:cursor(),publication,sequences:seq};
 const setup=[...(!schema.authPresent?fixedSchemaStatements(PROTECTED_D1_AUTH_SCHEMA):[]),...fixedSchemaStatements(PROTECTED_D1_JOURNAL_SCHEMA)].map(sql=>db.prepare(sql));
 setup.push(db.prepare('INSERT INTO protected_state_restore(id,manifest_sha256,complete) VALUES(1,?,0)').bind(identity.manifestSha256),db.prepare('INSERT INTO protected_state_d1_session VALUES(1,?,?,?,?,?,?,0)').bind(identity.admissionSha256,identity.manifestSha256,admission.targetSha256,JSON.stringify(manifest),JSON.stringify(admission),JSON.stringify(state)));
 const l:Loaded={session:{admission_sha256:identity.admissionSha256,manifest_sha256:identity.manifestSha256,target_sha256:admission.targetSha256,manifest_json:JSON.stringify(manifest),admission_json:JSON.stringify(admission),state_json:JSON.stringify(state),version:0},manifest,admission,state,identity};
 setup.push(guard(db,l,state,0));await db.batch(setup);await compactMarker(db,l);return result(state,0);
 });}
const refColumns=['row_id','corpus_id','row_fingerprint','content_sha256','object_key','bytes','created_at'] as const;
export async function checkProtectedD1CorpusPage(db:D1Database,page:CompactRestorePage,identity:ProtectedD1Identity){return safe(async()=>{
 demand(new TextEncoder().encode(JSON.stringify(page)).byteLength<=64*1024,'PROTECTED_D1_COMPACT_BOUNDS');
 page=structuredClone(page);
 const l=await load(db,identity);demand(['checking-corpus','checking-corpus-final'].includes(l.state.phase),'PROTECTED_D1_PHASE');await preimage(db,l);await verifyCompactRestorePage(page);
 const p=l.admission.compactPlan,c=l.state.compact;demand(page.page===c.page+1&&page.page<=p.pageCount&&page.fromAfter===c.after,'PROTECTED_D1_COMPACT_ORDER');
 const actual=(await db.prepare(`SELECT ${COMPACT_STATUTE_COLUMNS.join(',')} FROM statute_sections WHERE id>? ORDER BY id LIMIT ?`).bind(c.after,page.rows+1).all<Record<string,unknown>>()).results;
 demand(actual.length>=page.rows&&(page.page!==p.pageCount||actual.length===page.rows),'PROTECTED_D1_COMPACT_ROWS');
 for(let at=0;at<page.rows;at++){
  const metadata=page.statements[at*2]!.params,reference=page.statements[at*2+1]!.params,row=actual[at]!;
  demand(same(COMPACT_STATUTE_COLUMNS.map(k=>row[k]),metadata),'PROTECTED_D1_CORPUS_ROW');
  const ref=await db.prepare(`SELECT ${refColumns.join(',')} FROM statute_text_refs WHERE row_id=?`).bind(metadata[0]).first<Record<string,unknown>>();demand(ref&&same(refColumns.map(k=>ref[k]),reference),'PROTECTED_D1_TEXT_REFERENCE');
 }
 const recorded=await db.prepare('SELECT sha256,after_id,row_count FROM corpus_compact_pages WHERE page=?').bind(page.page).first<{sha256:string;after_id:string;row_count:number}>();
 demand(recorded?.sha256===page.sha256&&recorded.after_id===page.through&&recorded.row_count===page.rows,'PROTECTED_D1_COMPACT_RECEIPT');
 const next=structuredClone(l.state);next.compact={page:page.page,after:page.through,rows:c.rows+page.rows,chain:await nextPageChain(c.chain,page.sha256)};
 if(page.page===p.pageCount){const counts=await db.prepare('SELECT (SELECT count(*) FROM statute_sections) AS rows,(SELECT count(*) FROM statute_text_refs) AS refs,(SELECT count(*) FROM corpus_compact_pages) AS pages').first<{rows:number;refs:number;pages:number}>();
  demand(next.compact.rows===p.rowCount&&next.compact.chain===p.pagesChainSha256&&counts?.rows===p.rowCount&&counts.refs===p.rowCount&&counts.pages===p.pageCount,'PROTECTED_D1_COMPACT_COMPLETE');
  if(l.state.phase==='checking-corpus')next.phase='checking-text';else next.phase='checking-corpus-final';
 }
 return advance(db,l,next);
 });}
export async function checkProtectedD1Text(db:D1Database,bucket:TextObjectReader,identity:ProtectedD1Identity,expectedSessionVersion:number){return safe(async()=>{
 const l=await load(db,identity);
 // Check before any R2 read. The existing in-batch version/state CAS also fences
 // a concurrent step after these reads; a stale acknowledgement cannot advance.
 demand(Number.isSafeInteger(expectedSessionVersion)&&expectedSessionVersion>=0&&expectedSessionVersion===l.session.version,'PROTECTED_D1_VERSION');
 demand(l.state.phase==='checking-text'&&l.state.audit?.complete!==true,'PROTECTED_D1_PHASE');await preimage(db,l);
 const checkpoint=await auditProvisionTextPage(db,bucket,{expectedRevision:l.admission.compactPlan.revision,mode:'r2',pageSize:8,...(l.state.audit?{checkpoint:l.state.audit}:{})});
 const next=structuredClone(l.state);next.audit=checkpoint;
 if(checkpoint.complete){demand(checkpoint.rowsVerified===l.manifest.corpusRows&&checkpoint.bytesVerified===l.admission.compactPlan.textBytes,'PROTECTED_D1_TEXT_COMPLETE');next.phase='loading';}
 return advance(db,l,next);
 });}
function nextCursor(current:Cursor,page:ProtectedPage):Cursor {const index=tables.indexOf(page.table);demand(page.page===current.page+1&&index>=current.table,'PROTECTED_D1_PAGE_ORDER');let previous=index===current.table?current.key:null;
 for(const row of page.rows){const key=row[0]!;demand(previous===null||compareProtectedD1Keys(key,previous)>0,'PROTECTED_D1_KEY_ORDER');previous=key;}
 return {...current,page:page.page,table:index,key:previous,counts:{...current.counts,[page.table]:current.counts[page.table]+page.rows.length}};
}
async function verifyPageRows(db:D1Database,page:ProtectedPage){for(const row of page.rows){const found=(await db.prepare(`SELECT ${columns[page.table].join(',')} FROM ${page.table} WHERE ${columns[page.table][0]}=?`).bind(row[0]).all<Record<string,unknown>>()).results;demand(found.length===1&&same(protectedRowValues(page.table,found[0]!),row),'PROTECTED_D1_REPLAY_ROW');}}
async function receipt(db:D1Database,page:ProtectedPage){const row=await db.prepare('SELECT sha256 FROM protected_state_pages WHERE page=?').bind(page.page).first<{sha256:string}>();demand(row?.sha256===page.sha256,'PROTECTED_D1_PAGE_RECEIPT');}
async function boundedPage(raw:unknown){demand(new TextEncoder().encode(JSON.stringify(raw)).byteLength<=64*1024,'PROTECTED_D1_PAGE_BOUNDS');return checkedProtectedPage(structuredClone(raw));}
function allExpected(cursor:Cursor,m:ProtectedManifest){return tables.every(t=>cursor.counts[t]===m.tables[t].rows);}
export async function applyProtectedD1Page(db:D1Database,raw:unknown,identity:ProtectedD1Identity){return safe(async()=>{
 const page=await boundedPage(raw),l=await load(db,identity);await preimage(db,l);
 if(page.page<=l.state.load.page){await receipt(db,page);await verifyPageRows(db,page);return {...result(l.state,l.session.version),skipped:true};}
 demand(l.state.phase==='loading','PROTECTED_D1_PHASE');const next=structuredClone(l.state);next.load=nextCursor(l.state.load,page);next.load.chain=await nextPageChain(l.state.load.chain,page.sha256);
 demand(next.load.counts[page.table]<=l.manifest.tables[page.table].rows,'PROTECTED_D1_TABLE_COUNT');const statements:D1PreparedStatement[]=[];
 if(page.table==='corpus_state'){demand(page.rows.length===1&&l.state.load.counts.corpus_state===0,'PROTECTED_D1_PUBLICATION_PAGE');statements.push(db.prepare("DELETE FROM corpus_state WHERE corpus_id='statutes-canada'"));next.publication=checkedProtectedRow('corpus_state',page.rows[0]);}
 for(const row of page.rows){if(page.table==='sqlite_sequence'){
  const name=row[0] as typeof history[number],saved=Number(row[1]);demand(l.admission.sequences[name]===saved&&(next.sequences[name]===null||Number(next.sequences[name])<=saved),'PROTECTED_D1_SEQUENCE');
  statements.push(db.prepare(next.sequences[name]===null?'INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)':'UPDATE sqlite_sequence SET seq=? WHERE name=?').bind(...(next.sequences[name]===null?[name,saved]:[saved,name])));next.sequences[name]=saved;
 }else{statements.push(db.prepare(`INSERT INTO ${page.table}(${columns[page.table].join(',')}) VALUES(${columns[page.table].map(()=>'?').join(',')})`).bind(...row));if((history as readonly string[]).includes(page.table)){const name=page.table as typeof history[number];next.sequences[name]=Math.max(next.sequences[name]??0,Number(row[0]));}}
 }
 if(page.page===l.manifest.pages){demand(next.load.chain===l.admission.protectedChainSha256&&allExpected(next.load,l.manifest)&&same(next.sequences,l.admission.sequences),'PROTECTED_D1_LOAD_COMPLETE');next.phase='checking-protected';}
 statements.push(db.prepare('INSERT INTO protected_state_pages(page,sha256) VALUES(?,?)').bind(page.page,page.sha256));
 return {...await advance(db,l,next,statements),skipped:false};
 });}
export async function verifyProtectedD1Page(db:D1Database,raw:unknown,identity:ProtectedD1Identity){return safe(async()=>{
 const page=await boundedPage(raw),l=await load(db,identity);await preimage(db,l);await receipt(db,page);await verifyPageRows(db,page);
 if(page.page<=l.state.verify.page)return {...result(l.state,l.session.version),skipped:true};demand(l.state.phase==='checking-protected','PROTECTED_D1_PHASE');
 const next=structuredClone(l.state);next.verify=nextCursor(l.state.verify,page);next.verify.chain=await nextPageChain(l.state.verify.chain,page.sha256);
 if(page.page===l.manifest.pages){demand(next.verify.chain===l.admission.protectedChainSha256&&allExpected(next.verify,l.manifest),'PROTECTED_D1_VERIFY_COMPLETE');next.phase='checking-corpus-final';next.compact=compact();}
 return advance(db,l,next);
 });}
export async function finishProtectedD1(db:D1Database,identity:ProtectedD1Identity){return safe(async()=>{
 const l=await load(db,identity);await preimage(db,l);if(l.state.phase==='complete')return result(l.state,l.session.version);
 const p=l.admission.compactPlan;demand(l.state.phase==='checking-corpus-final'&&l.state.compact.page===p.pageCount&&l.state.compact.chain===p.pagesChainSha256&&l.state.compact.rows===p.rowCount&&l.state.audit?.complete===true&&l.state.load.chain===l.admission.protectedChainSha256&&l.state.verify.chain===l.admission.protectedChainSha256&&allExpected(l.state.load,l.manifest)&&allExpected(l.state.verify,l.manifest)&&same(l.state.sequences,l.admission.sequences),'PROTECTED_D1_NOT_COMPLETE');
 await checkProtectedD1Schema(db,true);demand((await db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').all()).results.length===0,'PROTECTED_D1_FOREIGN_KEYS');
 const pending=await db.prepare('SELECT count(*) AS n FROM corpus_mutations WHERE payload IS NOT NULL OR completed_at IS NULL').first<{n:number}>();demand(pending?.n===0,'PROTECTED_D1_PENDING');
 const next=structuredClone(l.state);next.phase='complete';return advance(db,l,next,[],true);
 });}
