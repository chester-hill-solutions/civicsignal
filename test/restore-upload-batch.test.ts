import { describe,expect,it } from 'vitest';
import { decodeUploadBatch,encodeUploadBatch,MAX_UPLOAD_BATCH_BYTES,uploadBatchBytes,verifiedUploadBatchAcknowledgements,
  type UploadBatchObject } from '../services/restore/upload-batch';

const objects:UploadBatchObject[]=[{sourceOrdinal:1237,sha256:'a'.repeat(64),bytes:new Uint8Array(new TextEncoder().encode('English provision'))},
  {sourceOrdinal:1238,sha256:'b'.repeat(64),bytes:new Uint8Array(new TextEncoder().encode('Disposition française'))}];
const mutate=(change:(bytes:Uint8Array<ArrayBuffer>,view:DataView)=>void)=>{const bytes=encodeUploadBatch(objects,2000);change(bytes,new DataView(bytes.buffer));return bytes;};

describe('bounded binary restore transport',()=>{
  it('preserves source positions independently from journal arrival ordinals and shares one bounded frame',()=>{
    const encoded=encodeUploadBatch(objects,2000);const decoded=decodeUploadBatch(encoded,2000);
    expect(decoded.map(({sourceOrdinal,sha256,bytes})=>({sourceOrdinal,sha256,text:new TextDecoder().decode(bytes)})))
      .toEqual(objects.map(({sourceOrdinal,sha256,bytes})=>({sourceOrdinal,sha256,text:new TextDecoder().decode(bytes)})));
    expect(decoded.every((item)=>item.bytes.buffer===encoded.buffer)).toBe(true);
    expect(encoded.byteLength).toBe(uploadBatchBytes(2,objects.reduce((sum,item)=>sum+item.bytes.length,0)));
  });

  it.each([
    ['wrong magic',(b:Uint8Array)=>{b[0]=0;}],['unknown version',(b:Uint8Array)=>{b[4]=2;}],
    ['reserved bits',(b:Uint8Array)=>{b[7]=1;}],['zero count',(b:Uint8Array)=>{b[5]=0;}],
    ['count above sixteen',(b:Uint8Array)=>{b[5]=17;}],
    ['zero source ordinal',(_b:Uint8Array,v:DataView)=>{v.setUint32(8+36,0);}],
    ['noncontiguous range',(_b:Uint8Array,v:DataView)=>{v.setUint32(8+40+36,1239);}],
    ['duplicate source ordinal',(_b:Uint8Array,v:DataView)=>{v.setUint32(8+40+36,1237);}],
    ['duplicate digest',(b:Uint8Array)=>{b.set(b.subarray(8,40),48);}],
    ['empty object',(_b:Uint8Array,v:DataView)=>{v.setUint32(8+32,0);}],
    ['oversized declared payload',(_b:Uint8Array,v:DataView)=>{v.setUint32(8+32,0xffffffff);}],
  ] as const)('rejects %s before an upload can start',(_name,change)=>{
    expect(()=>decodeUploadBatch(mutate(change),2000)).toThrow();
  });

  it('rejects out-of-plan ranges, truncated frames, trailing data and aggregate excess',()=>{
    const frame=encodeUploadBatch(objects,2000);
    expect(()=>decodeUploadBatch(frame,1237)).toThrow();
    expect(()=>decodeUploadBatch(frame.slice(0,-1),2000)).toThrow();
    const trailing=new Uint8Array(frame.length+1);trailing.set(frame);
    expect(()=>decodeUploadBatch(trailing,2000)).toThrow();
    expect(()=>decodeUploadBatch(new Uint8Array(MAX_UPLOAD_BATCH_BYTES+1),2000)).toThrow();
    expect(()=>encodeUploadBatch([{...objects[0]!,bytes:new Uint8Array(MAX_UPLOAD_BATCH_BYTES)}],2000)).toThrow();
  });

  it('requires the exact complete acknowledgement set, allowing response order to vary',()=>{
    const acks=objects.map((item)=>({sourceOrdinal:item.sourceOrdinal,sha256:item.sha256,bytes:item.bytes.length,verified:true}));
    expect(verifiedUploadBatchAcknowledgements({verified:true,objects:[...acks].reverse()},objects)).toBe(true);
    for(const response of [{verified:true,objects:acks.slice(1)}, {verified:true,objects:[acks[0],acks[0]]},
      {verified:true,objects:[acks[0],{...acks[1],sourceOrdinal:999}]}, {verified:true,objects:[acks[0],{...acks[1],sha256:'c'.repeat(64)}]},
      {verified:true,objects:[acks[0],{...acks[1],bytes:0}]}, {verified:true,objects:[acks[0],{...acks[1],verified:false}]}])
      expect(verifiedUploadBatchAcknowledgements(response,objects)).toBe(false);
  });
});
