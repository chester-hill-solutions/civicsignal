import {describe,expect,it} from 'vitest';
import {checkedMetadataBatch,metadataBatchBytes,verifiedMetadataAcknowledgements} from '../services/restore/metadata-batch';
import {compactPageDigest,INSERT_COMPACT_STATUTE_SQL,type CompactRestorePage} from '../src/corpora/compact-restore';
import {provisionTextKey,UPSERT_TEXT_REFERENCE_SQL} from '../src/corpora/text-store';

async function pages(count=4,rows=1,bytes=12,heading=''){
  const output:CompactRestorePage[]=[];let previous='';
  for(let page=1;page<=count;page++){const fromAfter=previous;const statements=[];
    for(let at=0;at<rows;at++){const id=`acts-en-${String((page-1)*rows+at).padStart(4,'0')}`;const sha='b'.repeat(64);
      statements.push({query:INSERT_COMPACT_STATUTE_SQL,params:[id,'statutes-canada','Test Act','1',heading,'','https://example.test/provision','CA',1,null,'T-1','en',null,null,'in-force','a'.repeat(32),'2026-10-15']},
        {query:UPSERT_TEXT_REFERENCE_SQL,params:[id,'statutes-canada','a'.repeat(32),sha,provisionTextKey(sha),bytes,'2026-10-22']});previous=id;}
    const value={page,fromAfter,through:previous,rows,statements};output.push({...value,sha256:await compactPageDigest(value)});
  }return output;
}

describe('bounded metadata source ranges',()=>{
  it('validates the exact contiguous source range and complete acknowledgement set',async()=>{
    const source=await pages();expect(await checkedMetadataBatch({pages:source},4)).toEqual(source);
    const acks=source.map((page)=>({page:page.page,sha256:page.sha256,fromAfter:page.fromAfter,through:page.through,rows:page.rows,skipped:false}));
    const plan='c'.repeat(64);expect(verifiedMetadataAcknowledgements({verified:true,planHash:plan,pages:[...acks].reverse()},source,plan)).toBe(true);
    for(const response of [{verified:true,planHash:'d'.repeat(64),pages:acks},{verified:true,planHash:plan,pages:acks.slice(1)},
      {verified:true,planHash:plan,pages:[acks[0],acks[0],acks[2],acks[3]]},
      {verified:true,planHash:plan,pages:[...acks.slice(0,3),{...acks[3],through:'other'}]},
      {verified:true,planHash:plan,pages:[...acks.slice(0,3),{...acks[3],sha256:'e'.repeat(64)}]}])
      expect(verifiedMetadataAcknowledgements(response,source,plan)).toBe(false);
  });

  it('rejects changed final hashes, reordered ranges and validly hashed cursor gaps',async()=>{
    const source=await pages();const changed=structuredClone(source);changed[3]!.sha256='f'.repeat(64);
    await expect(checkedMetadataBatch({pages:changed},4)).rejects.toMatchObject({status:422});
    await expect(checkedMetadataBatch({pages:[source[1],source[0]]},4)).rejects.toMatchObject({status:422});
    const gap=structuredClone(source);gap[1]!.fromAfter='wrong';const {sha256:_,...body}=gap[1]!;gap[1]!.sha256=await compactPageDigest(body);
    await expect(checkedMetadataBatch({pages:gap},4)).rejects.toMatchObject({status:422});
    await expect(checkedMetadataBatch({pages:source},3)).rejects.toMatchObject({status:422});
  });

  it('bounds page count, complete JSON bytes and summed reference bytes independently',async()=>{
    await expect(checkedMetadataBatch({pages:[]},4)).rejects.toMatchObject({status:400});
    await expect(checkedMetadataBatch({pages:await pages(5)},5)).rejects.toMatchObject({status:400});
    const large=await pages(1,1,12,'H'.repeat(128*1024));expect(metadataBatchBytes(large)).toBeGreaterThan(128*1024);
    await expect(checkedMetadataBatch({pages:large},1)).rejects.toMatchObject({status:413});
    await expect(checkedMetadataBatch({pages:await pages(4,4,2*1024*1024)},4)).rejects.toMatchObject({status:413});
  });
});
