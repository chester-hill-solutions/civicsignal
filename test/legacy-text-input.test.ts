import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSnapshotTextCutover, jsonLines } from '../scripts/prepare-text-cutover';
import { fingerprint } from '../src/ingest/reconcile';
import { IndexDigester } from '../src/ingest/snapshot-format';

describe('explicit checked legacy text input',()=>{
  it('preserves old labels and fingerprints, pins all artifacts and refuses receipt tampering or v2 relabelling',async()=>{
    const root=await mkdtemp(join(tmpdir(),'civicsignal-legacy-text-'));const commit='a'.repeat(40);
    try{
      const rows=(['en','fr'] as const).map((language)=>({id:`acts-${language}-old`,corpusId:'statutes-canada',instrument:'Canada Health Act',citation:'C-6',
        section:'8',status:'in-force' as const,schedule:null,part:null,heading:null,text:language==='en'?'Old enacting text.':'Ancien texte introductif.',
        source_url:`https://laws-lois.justice.gc.ca/${language}/acts/C-6/FullText.html`,in_force:1,language,embedText:'',lastChanged:'2026-10-15'}));
      let offset=0;const digester=new IndexDigester();const entries=rows.map((row)=>{const line=JSON.stringify(row)+'\n';const e={id:row.id,fp:fingerprint(row),off:offset,len:Buffer.byteLength(line)};
        offset+=e.len;digester.add(e);return e;});
      const index=entries.map((e)=>JSON.stringify(e)).join('\n')+'\n';const text=rows.map((row)=>JSON.stringify(row)+'\n').join('');
      const rowKey=`${commit}.rows.000.jsonl`;const store=Buffer.alloc(16+2*768*4);store.writeUInt32LE(0x43535356,0);store.writeUInt32LE(2,4);store.writeUInt32LE(768,8);
      for(let at=0;at<768;at++)store.writeFloatLE(1,16+at*4);
      const source:Record<string,string|Buffer>={
        [`${commit}.manifest.json`]:JSON.stringify({format:1,commit,date:'2026-10-15',rows:{count:2,bytes:offset,partBytes:2048,parts:[{key:rowKey,bytes:offset}]},
          index:{key:`${commit}.index.jsonl`,bytes:Buffer.byteLength(index),entries:2}}),
        [`${commit}.vectors.manifest.json`]:JSON.stringify({format:1,commit,dims:768,count:2,bytes:6144,parts:[{key:`${commit}.vectors.000.f32`,from:0,count:2,bytes:6144}]}),
        [`${commit}.index.jsonl`]:index,[rowKey]:text,[`${commit}.store.emb`]:store,
      };
      for(const [name,bytes] of Object.entries(source))await writeFile(join(root,name),bytes);
      const receipt={format:1,source:{commit,date:'2026-10-15',parser:'legacy',indexDigest:digester.digest(),rows:2,embedded:1,placeholders:1,dimensions:768},
        files:Object.fromEntries(Object.entries(source).map(([name,bytes])=>[name,{bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')}])),
        verification:{allRows:true,rows:2,allVectorPositions:true,finite:true,placeholderZeros:true}};
      const receiptPath=join(root,'receipt.json');await writeFile(receiptPath,JSON.stringify(receipt));
      await expect(prepareSnapshotTextCutover({snapshot:root,output:join(root,'missing'),revision:`${commit}:legacy`})).rejects.toThrow('explicit checked');
      const output=join(root,'bundle');const manifest=await prepareSnapshotTextCutover({snapshot:root,output,revision:`${commit}:legacy`,receipt:receiptPath});
      expect(manifest.publication).toMatchObject({commit,parser:null,date:'2026-10-15',rows:2});
      const restored=[];for await(const row of jsonLines(join(output,'backup.jsonl')))restored.push(row);
      expect(restored.map((row)=>[row['id'],row['section'],row['text_hash']])).toEqual(rows.map((row)=>[row.id,'8',fingerprint(row)]));
      expect(await readFile(join(root,`${commit}.store.emb`))).toEqual(store);
      await expect(prepareSnapshotTextCutover({snapshot:root,output:join(root,'relabel'),revision:`${commit}:statutes-v2`,receipt:receiptPath})).rejects.toThrow('cannot relabel');
      const changed=Buffer.from(store);changed[16]=changed[16]!^1;await writeFile(join(root,`${commit}.store.emb`),changed);
      await expect(prepareSnapshotTextCutover({snapshot:root,output:join(root,'changed'),revision:`${commit}:legacy`,receipt:receiptPath})).rejects.toThrow('artifact digest mismatch');
      await writeFile(join(root,`${commit}.store.emb`),store);await writeFile(receiptPath,JSON.stringify({...receipt,verification:{...receipt.verification,allVectorPositions:false}}));
      await expect(prepareSnapshotTextCutover({snapshot:root,output:join(root,'unchecked'),revision:`${commit}:legacy`,receipt:receiptPath})).rejects.toThrow('complete pinned legacy');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
