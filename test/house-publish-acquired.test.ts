import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { HousePacket, publishHouse, readHouseBase } from '../services/house/publish';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SqliteDatabase };
const reference = process.env.CIVICSIGNAL_HOUSE_PUBLISH_REFERENCE;
it.skipIf(!reference || process.env.CIVICSIGNAL_WORKERD_TESTS !== '1')(
  'matches every affected serving field and link against the independent Python House operator replay', async () => {
    if (!reference) throw new Error('Missing archived House observation and local Python operator replay.');
    const packet = HousePacket.parse(JSON.parse(await readFile(join(reference,'packet.json'),'utf8')));
    const { sha256 } = JSON.parse(await readFile(join(reference,'ref.json'),'utf8'));
    const receipt = JSON.parse(await readFile(join(reference,'receipt.json'),'utf8'));
    const source = new DatabaseSync('data/corpus/committees/committee.sqlite',{readOnly:true});
    const python = new DatabaseSync(join(reference,'calls.db'),{readOnly:true});
    const directory = await mkdtemp(join(tmpdir(),'house-observation-d1-')), name = 'house-observation-local';
    const mf = new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:join(directory,'registry'),
      resourcePersistencePath:join(directory,'state'),workers:[{config:{name,compatibilityDate:'2026-10-22',
        env:{DB:{type:'d1',id:name,dev:{remote:false}}},manifest:{mainModule:'worker.js',modules:{
          'worker.js':{type:'esm',contents:'export default {fetch(){return new Response("local")}};'}}}}}]});
    try {
      const db = await mf.getD1Database('DB',name);
      for (const path of ['preview/committees/migrations/0001_committee_preview.sql','services/house/migrations/0001_call_observations.sql']) {
        const sql = (await readFile(path,'utf8')).replace(/^--.*$/gm,'');
        await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
      }
      const cutoff = source.prepare("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").get()?.cutoff;
      await db.prepare('INSERT INTO cc_snapshot VALUES(?,?)').bind('45-1',cutoff).run();
      // Replay the write scope against the untouched sealed base. The expected rows
      // and links are the independent operator's post-publication SQLite output.
      const expectedRecords = python.prepare('SELECT * FROM cc_records ORDER BY id,language').all();
      const expectedLinks = python.prepare('SELECT * FROM cc_links ORDER BY language,parent_id,child_id,relation').all();
      const original = source.prepare('SELECT * FROM cc_records WHERE session=? AND id=? AND language=?');
      const existing = expectedRecords.map(r=>original.get(r.session,r.id,r.language)).filter(r=>r!==undefined);
      await db.batch(existing.map(r=>db.prepare('INSERT INTO cc_records VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(...Object.values(r))));
      const allLinks = source.prepare('SELECT * FROM cc_links WHERE session=? AND language=? AND parent_id=? AND child_id=? AND relation=?');
      const baseLinks = expectedLinks.map(link=>allLinks.get(...Object.values(link))).filter(r=>r!==undefined);
      if (baseLinks.length) await db.batch(baseLinks.map(row=>db.prepare('INSERT INTO cc_links VALUES(?,?,?,?,?)').bind(...Object.values(row))));
      const base = await readHouseBase(db,'45-1');
      const result = await publishHouse(db,base,packet,sha256);
      for (const [key,value] of Object.entries(result.counts)) expect(value).toBe(receipt.counts[key]);
      expect(result.studyTitlesRepaired).toEqual(receipt.studyTitlesRepaired);
      expect(result.studiesNotYetInCorpus).toEqual(receipt.studiesNotYetInCorpus);
      expect((await db.prepare('SELECT * FROM cc_records ORDER BY id,language').all()).results).toEqual(expectedRecords);
      expect((await db.prepare('SELECT * FROM cc_links ORDER BY language,parent_id,child_id,relation').all()).results).toEqual(expectedLinks);
      expect(await publishHouse(db,base,packet,sha256)).toEqual(result);
    } finally {
      source.close(); python.close(); await mf.dispose(); await rm(directory,{recursive:true,force:true});
    }
  },60000);
