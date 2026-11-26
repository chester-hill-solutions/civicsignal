import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { HousePacket, housePriorDigest, publishHouse, readHouseBase, type HouseBase } from '../services/house/publish';
import { testD1 } from './helpers/d1';

const ddl = ['preview/committees/migrations/0001_committee_preview.sql','services/house/migrations/0001_call_observations.sql']
  .map(path => readFileSync(path,'utf8')).join('\n');
const cutoff = '2026-11-25T08:33:25+00:00', seedTime = '2026-11-25T11:15:39Z';
const oldAt = '2026-11-25T15:00:01.000000Z', newer = '2026-11-25T16:00:01.000000Z';
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
function row(lang:'en'|'fr', at:string, studyId='100') {
  const listingUrl = 'https://www.ourcommons.ca/Committees/'+lang+'/Participate';
  const contentDigest = hash(`{"deadline": null, "instructionUrl": null, "instructions": null, "studyId": "${studyId}"}`);
  return {session:'45-1',id:'house-abc-call-'+studyId,language:lang,kind:'call',chamber:'house',committee_id:'house-abc',
    title:'Study '+lang,url:'https://www.ourcommons.ca/committees/'+lang+'/ABC/StudyActivity?studyActivityId='+studyId,
    status:'indexed',metadata:{delivery:'excerpt',termsUrl:'https://apps.ourcommons.ca/en/important-notices',
      committeeCode:'ABC',studyId,listingUrl,contentWarning:false,contentWarningText:null,listed:true,lastListedAt:at,
      observedAt:at,firstObservedAt:seedTime,revision:1,contentDigest,pendingDigest:null,contentConflict:false,
      instructionUrl:null,instructions:null,deadline:null}} as const;
}
function input(base:HouseBase,at:string, includeDrop=true):HousePacket {
  const calls: HousePacket['calls'] = [row('en',at),row('fr',at)];
  const old = base.prior.find(r => r.id === 'house-abc-call-200');
  if (includeDrop && old && JSON.parse(old.metadata_json).listed) {
    const prior = row('en',seedTime,'200');
    calls.push({...prior,metadata:{...prior.metadata,listed:false}});
  }
  const sha256=hash('body');
  const sources = calls.filter(c=>c.metadata.listed).flatMap(call=>[call.url,call.metadata.listingUrl].map(url=>({
    url,chamber:'house',language:call.language,state:'archived',checked:at,sha256,bytes:4,key:'committee/house-calls/sources/'+sha256+'.html'})));
  const scheduledTime=Date.parse(at)-1000;
  return HousePacket.parse({session:'45-1',instanceId:'house-calls-'+scheduledTime,scheduledTime,observedAt:at,calls,sources,
    priorSha256:housePriorDigest(base.prior)});
}
const open: ReturnType<typeof testD1>[]=[];
afterEach(()=>{for(const conn of open.splice(0))conn.close();});
async function setup(){
  const conn=testD1({schema:ddl});open.push(conn);
  conn.sqlite.prepare('INSERT INTO cc_snapshot VALUES(?,?)').run('45-1',cutoff);
  const insert=conn.sqlite.prepare('INSERT INTO cc_records VALUES(?,?,?,?,?,?,?,?,?,?,NULL)');
  for (const r of [row('en',seedTime),row('fr',seedTime),row('en',seedTime,'200')]) {
    insert.run(r.session,r.id,r.language,r.kind,r.chamber,r.committee_id,r.title,r.url,r.status,JSON.stringify(r.metadata));
  }
  insert.run('45-1','house-abc-study-100','en','study','house','house-abc','Participate','url','indexed','{}');
  insert.run('45-1','unrelated','en','study','house','house-abc','Participate','unrelated','indexed','{}');
  return {...conn,base:await readHouseBase(conn.db,'45-1')};
}
describe('House call observation publication',()=>{
  it('atomically publishes scoped rows and links, preserves dropped history and replays the exact receipt',async()=>{
    const {db,sqlite,base}=await setup(), packet=input(base,oldAt);
    const serial=await publishHouse(db,base,packet,hash('raw'));
    expect(serial).toMatchObject({cutoff,counts:{calls:2,added:0,unchanged:2,dropped:1},studiesNotYetInCorpus:[
      {id:'house-abc-study-100',language:'fr'}],studyTitlesRepaired:[{id:'house-abc-study-100',language:'en',title:'Study en'}]});
    expect((await readHouseBase(db,'45-1')).headInstance).toBe(packet.instanceId);
    expect(await publishHouse(db,base,packet,hash('raw'))).toEqual(serial);
    await expect(publishHouse(db,base,packet,hash('other raw'))).rejects.toThrow('Conflicting');
    const meta=JSON.parse(String(sqlite.prepare("SELECT metadata_json FROM cc_records WHERE id='house-abc-call-200'").get()?.metadata_json));
    expect(meta).toMatchObject({listed:false,observedAt:seedTime,revision:1});
    expect(sqlite.prepare("SELECT title FROM cc_records WHERE id='unrelated'").get()?.title).toBe('Participate');
    expect(sqlite.prepare("SELECT cutoff FROM cc_snapshot").get()?.cutoff).toBe(cutoff);
    expect(sqlite.prepare("SELECT count(*) n FROM cc_links WHERE relation='study-call'").get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT count(*) n FROM cc_house_guard").get()?.n).toBe(0);
    const nextBase=await readHouseBase(db,'45-1');
    expect((await publishHouse(db,nextBase,input(nextBase,newer))).counts.dropped).toBe(0);
    expect(await publishHouse(db,base,packet,hash('raw'))).toEqual(serial);
  });
  it('rejects stale or mixed pages, incomplete drops, rewritten history and unconfirmed revisions',async()=>{
    const {db,base,sqlite}=await setup();
    const missing=input(base,oldAt,false);await expect(publishHouse(db,base,missing)).rejects.toThrow('Missing dropped');
    const pending=input(base,oldAt);pending.calls[0].metadata.revision++;await expect(publishHouse(db,base,pending)).rejects.toThrow('Unconfirmed');
    const mixed=input(base,oldAt);mixed.sources[1].checked=seedTime;await expect(publishHouse(db,base,mixed)).rejects.toThrow('later complete');
    const corrupt=input(base,oldAt);corrupt.calls[2].metadata.observedAt=oldAt;await expect(publishHouse(db,base,corrupt)).rejects.toThrow('retain');
    const changed=input(base,oldAt);changed.priorSha256=hash('different');await expect(publishHouse(db,base,changed)).rejects.toThrow('different prior');
    expect(sqlite.prepare('SELECT COUNT(*) n FROM cc_house_runs').get()?.n).toBe(0);
  });
  it('rolls back mutation if the prior edition changed or its destination collides with a non-call',async()=>{
    const {db,base,sqlite}=await setup(), packet=input(base,oldAt);
    sqlite.exec("UPDATE cc_records SET title='changed by another writer' WHERE id='house-abc-call-100' AND language='en'");
    await expect(publishHouse(db,base,packet)).rejects.toThrow();
    sqlite.exec("UPDATE cc_records SET title='Study en' WHERE id='house-abc-call-100' AND language='en'");
    const newCall=row('en',oldAt,'400'); packet.calls.push({...newCall,metadata:{...newCall.metadata,firstObservedAt:oldAt}});
    packet.sources.push({...packet.sources[0],url:newCall.url});
    sqlite.exec("INSERT INTO cc_records(session,id,language,kind,chamber,title,metadata_json) VALUES('45-1','house-abc-call-400','en','study','house','Never replace','{}')");
    await expect(publishHouse(db,base,packet)).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) n FROM cc_links').get()?.n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM cc_house_runs').get()?.n).toBe(0);
  });
  it('does not publish a competing occurrence based on an earlier head',async()=>{
    const {db,base}=await setup();
    await publishHouse(db,base,input(base,oldAt));
    await expect(publishHouse(db,base,input(base,newer))).rejects.toThrow();
    const latest=await readHouseBase(db,'45-1');
    expect((await publishHouse(db,latest,input(latest,newer))).observedAt).toBe(newer);
  });
});

it.skipIf(process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')('publishes and replays in native workerd D1 without advancing the sealed corpus cutoff',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'house-call-d1-')), name='private-house-local';
  const mf=new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:join(directory,'registry'),
    resourcePersistencePath:join(directory,'state'),workers:[{config:{name,compatibilityDate:'2026-10-22',
      env:{DB:{type:'d1',id:name,dev:{remote:false}}},manifest:{mainModule:'worker.js',modules:{
        'worker.js':{type:'esm',contents:'export default {fetch(){return new Response("local")}};'}}}}}]});
  try {
    const db=await mf.getD1Database('DB',name);
    await db.batch(ddl.replace(/^--.*$/gm,'').split(';').map(q=>q.trim()).filter(Boolean).map(q=>db.prepare(q)));
    const local=await setup();
    const seed=local.sqlite.prepare('SELECT * FROM cc_records').all();
    await db.batch([db.prepare('INSERT INTO cc_snapshot VALUES(?,?)').bind('45-1',cutoff),
      ...seed.map(row=>db.prepare('INSERT INTO cc_records VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(row)))]);
    const base=await readHouseBase(db,'45-1'), packet=input(base,oldAt);
    const result=await publishHouse(db,base,packet);
    expect(result.counts).toMatchObject({calls:2,dropped:1});
    expect(await publishHouse(db,base,packet)).toEqual(result);
    await expect(publishHouse(db,base,input(base,newer))).rejects.toThrow();
    expect(await db.prepare('SELECT cutoff FROM cc_snapshot').first('cutoff')).toBe(cutoff);
    expect(await db.prepare('SELECT COUNT(*) n FROM cc_house_runs').first('n')).toBe(1);
  } finally { await mf.dispose(); await rm(directory,{recursive:true,force:true}); }
},30000);
