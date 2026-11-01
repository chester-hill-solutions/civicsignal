import { RestoreInputError } from './protocol';

export const MAX_UPLOAD_BATCH_OBJECTS = 16;
export const MAX_UPLOAD_BATCH_BYTES = 2 * 1024 * 1024;
export const UPLOAD_BATCH_PARALLELISM = 4;
export const UPLOAD_BATCH_CAPABILITIES = {version:1,maxObjects:MAX_UPLOAD_BATCH_OBJECTS,maxBytes:MAX_UPLOAD_BATCH_BYTES} as const;
const HEADER_BYTES = 8;
const DESCRIPTOR_BYTES = 40;
const magic = [0x43,0x53,0x54,0x42]; // CSTB, version, count, two reserved zero bytes.

export interface UploadBatchObject {
  /** Position in the pinned source object index, NOT the journal's arrival ordinal. */
  sourceOrdinal: number;
  sha256: string;
  bytes: Uint8Array<ArrayBuffer>;
}
export interface UploadBatchAcknowledgement {sourceOrdinal:number;sha256:string;bytes:number;verified:true}

export function uploadBatchBytes(count:number,payloadBytes:number) {return HEADER_BYTES+DESCRIPTOR_BYTES*count+payloadBytes;}

function checkedRange(objects:readonly UploadBatchObject[],maximumOrdinal:number) {
  if(!Number.isSafeInteger(maximumOrdinal)||maximumOrdinal<1||maximumOrdinal>0xffffffff||objects.length<1||objects.length>MAX_UPLOAD_BATCH_OBJECTS)throw new RestoreInputError('Invalid upload batch object count or source range.');
  const first=objects[0]!.sourceOrdinal;
  const seen=new Set<string>();let payload=0;
  for(let at=0;at<objects.length;at++){
    const item=objects[at]!;
    if(!Number.isSafeInteger(item.sourceOrdinal)||item.sourceOrdinal<1||item.sourceOrdinal>maximumOrdinal||item.sourceOrdinal!==first+at||
      !/^[a-f0-9]{64}$/.test(item.sha256)||seen.has(item.sha256)||item.bytes.byteLength<1)throw new RestoreInputError('Invalid or duplicate upload batch source descriptor.');
    seen.add(item.sha256);payload+=item.bytes.byteLength;
  }
  if(uploadBatchBytes(objects.length,payload)>MAX_UPLOAD_BATCH_BYTES)throw new RestoreInputError('The complete upload batch exceeds 2 MiB.',413);
}

export function encodeUploadBatch(objects:readonly UploadBatchObject[],maximumOrdinal:number):Uint8Array<ArrayBuffer> {
  checkedRange(objects,maximumOrdinal);
  const bytes=new Uint8Array(uploadBatchBytes(objects.length,objects.reduce((sum,item)=>sum+item.bytes.byteLength,0)));
  bytes.set(magic);bytes[4]=1;bytes[5]=objects.length;
  const view=new DataView(bytes.buffer);let payloadAt=HEADER_BYTES+objects.length*DESCRIPTOR_BYTES;
  for(let at=0;at<objects.length;at++){
    const item=objects[at]!;const start=HEADER_BYTES+at*DESCRIPTOR_BYTES;
    for(let part=0;part<32;part++)bytes[start+part]=Number.parseInt(item.sha256.slice(part*2,part*2+2),16);
    view.setUint32(start+32,item.bytes.byteLength);view.setUint32(start+36,item.sourceOrdinal);
    bytes.set(item.bytes,payloadAt);payloadAt+=item.bytes.byteLength;
  }
  return bytes;
}

/** Returned byte slices share one bounded frame. No base64 or per-object copy. */
export function decodeUploadBatch(bytes:Uint8Array<ArrayBuffer>,maximumOrdinal:number):UploadBatchObject[] {
  if(bytes.byteLength>MAX_UPLOAD_BATCH_BYTES)throw new RestoreInputError('The complete upload batch exceeds 2 MiB.',413);
  if(bytes.byteLength<HEADER_BYTES||magic.some((value,at)=>bytes[at]!==value)||bytes[4]!==1||bytes[6]!==0||bytes[7]!==0)throw new RestoreInputError('Invalid upload batch framing.');
  const count=bytes[5]!;
  if(count<1||count>MAX_UPLOAD_BATCH_OBJECTS||bytes.byteLength<HEADER_BYTES+count*DESCRIPTOR_BYTES)throw new RestoreInputError('Invalid upload batch object count.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let payloadAt=HEADER_BYTES+count*DESCRIPTOR_BYTES;
  const objects:UploadBatchObject[]=[];
  for(let at=0;at<count;at++){
    const start=HEADER_BYTES+at*DESCRIPTOR_BYTES;const length=view.getUint32(start+32);
    if(!length||payloadAt+length>bytes.byteLength)throw new RestoreInputError('Invalid upload batch object length.');
    const sha256=Array.from(bytes.subarray(start,start+32),(value)=>value.toString(16).padStart(2,'0')).join('');
    objects.push({sourceOrdinal:view.getUint32(start+36),sha256,bytes:bytes.subarray(payloadAt,payloadAt+length)});payloadAt+=length;
  }
  if(payloadAt!==bytes.byteLength)throw new RestoreInputError('Unexpected trailing upload batch bytes.');
  checkedRange(objects,maximumOrdinal);return objects;
}

/** Replies can arrive in any order but must acknowledge the complete exact set. */
export function verifiedUploadBatchAcknowledgements(value:unknown,objects:readonly UploadBatchObject[]):boolean {
  const response=value as {verified?:unknown;objects?:unknown};
  if(response?.verified!==true||!Array.isArray(response.objects)||response.objects.length!==objects.length)return false;
  const expected=new Map(objects.map((item)=>[item.sourceOrdinal,item]));
  for(const raw of response.objects){
    const ack=raw as Partial<UploadBatchAcknowledgement>|null;
    const item=ack?expected.get(ack.sourceOrdinal!):undefined;
    if(!item||ack?.verified!==true||ack.sha256!==item.sha256||ack.bytes!==item.bytes.byteLength)return false;
    expected.delete(item.sourceOrdinal);
  }
  return expected.size===0;
}
