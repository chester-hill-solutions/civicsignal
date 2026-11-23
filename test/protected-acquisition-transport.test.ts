import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,fstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureProtectedAcquisitionFixture,PROTECTED_ACQUISITION_SOURCE,type AcquisitionFixtureRequest} from '../scripts/lib/protected-acquisition';
import {createFixtureAcquisitionTransport,ProtectedAcquisitionTransportError,type AcquisitionTransportOptions,type AcquisitionTransportLimits,type AcquisitionSendInit} from '../scripts/lib/protected-acquisition-transport';

const hooks=vi.hoisted(()=>({afterFsync:undefined as ((fd:number)=>void)|undefined,afterRead:undefined as ((fd:number,bytes:number,position:number)=>void)|undefined,write:undefined as ((fd:number,value:Uint8Array,offset:number,length:number)=>number)|undefined}));
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return {...fs,
 fsyncSync:(fd:number)=>{fs.fsyncSync(fd);hooks.afterFsync?.(fd);},
 writeSync:(fd:number,value:Uint8Array,offset:number,length:number)=>hooks.write?hooks.write(fd,value,offset,length):fs.writeSync(fd,value,offset,length),
 readSync:(fd:number,value:Uint8Array,offset:number,length:number,position:number)=>{const bytes=fs.readSync(fd,value,offset,length,position);hooks.afterRead?.(fd,bytes,position);return bytes;},
};});
const roots:string[]=[];
const token='SYNTHETIC_MANAGEMENT_CREDENTIAL_0123456789';
const origin='https://fixture-export.invalid';
const signed=origin+'/private.sql?signature=PRIVATE_QUERY';
const source=PROTECTED_ACQUISITION_SOURCE;
const base=`https://api.cloudflare.com/client/v4/accounts/${source.accountId}`;
const kv=`${base}/storage/kv/namespaces/${source.kvNamespaceId}`;
const exported=`${base}/d1/database/${source.d1Id}/export`;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const list=(ordinal=1):AcquisitionFixtureRequest=>({ordinal,kind:'kv-list-a',method:'GET',url:kv+'/keys?limit=100',body:null,credentialScope:'management',responseBytes:262144});
const exportRequest=():AcquisitionFixtureRequest=>({ordinal:1,kind:'export',method:'POST',url:exported,body:JSON.stringify({output_format:'polling',dump_options:{no_schema:false,no_data:false,tables:[]}}),credentialScope:'management',responseBytes:262144});
function fixture(overrides?:{limits?:Partial<AcquisitionTransportLimits>;send?:AcquisitionTransportOptions['send'];credential?:AcquisitionTransportOptions['syntheticCredential']}){
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'civic-acquisition-transport-')));chmodSync(parent,0o700);roots.push(parent);
 const directory=join(parent,'owner'),calls:{url:string;init:AcquisitionSendInit}[]=[];let selected=0,mono=0,wall=Date.UTC(2026,9,31);
 const options:AcquisitionTransportOptions={fixtureOnly:true,journalDirectory:directory,validUntil:wall+60_000,signedDownloadOrigin:origin,
  limits:{maxRequests:30,wallMs:10_000,managementMs:1000,downloadMs:2000,responseBytes:262144,downloadBytes:1024,aggregateResponseBytes:4096,minStartSpacingMs:0,...overrides?.limits},
  clock:{monotonic:()=>mono,wall:()=>wall,sleep:async ms=>{mono+=ms;}},
  syntheticCredential:signal=>{selected++;expect(signal.aborted).toBe(false);expect(readdirSync(directory).some(name=>name.endsWith('.intent.json')&&name.startsWith('exchange-'))).toBe(true);return overrides?.credential?overrides.credential(signal):{fixtureOnly:true,value:token,expiresAt:wall+60_000};},
  send:async(url,init)=>{calls.push({url,init});return overrides?.send?overrides.send(url,init):new Response(url.startsWith(origin)?'CREATE TABLE example(id INTEGER);':'{"success":true,"result":[],"result_info":{"cursor":""}}');},
 };
 return {options,parent,directory,calls,selected:()=>selected,setMono:(n:number)=>{mono=n;},getMono:()=>mono,setWall:(n:number)=>{wall=n;},getWall:()=>wall};
}
function output(f:ReturnType<typeof fixture>){return {signedUrl:signed,destination:join(f.directory,'source.private.sql')};}
function ownerFiles(f:ReturnType<typeof fixture>){return readdirSync(f.directory).filter(name=>name.endsWith('.json')).map(name=>readFileSync(join(f.directory,name),'utf8')).join('\n');}
afterEach(()=>{hooks.afterFsync=undefined;hooks.afterRead=undefined;hooks.write=undefined;vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe('fixture acquisition transport and private token-free download',()=>{
 it('shares durable reservations and one synthetic lease across management and SQL streams',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);
  const first=await owner.management(list());expect(JSON.parse(Buffer.from(first.body).toString()).success).toBe(true);
  const downloaded=await owner.downloadSql(output(f));await owner.management(list(2));
  expect(downloaded).toMatchObject({fixtureOnly:true,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false,standaloneAcceptance:false,status:200,settled:true,readbackVerified:true,reservation:2});
  expect(downloaded.sha256).toBe(hash(readFileSync(output(f).destination)));expect(downloaded.bytes).toBe(statSync(output(f).destination).size);
  expect(owner.snapshot()).toMatchObject({requests:3,sent:3,terminal:false,inFlight:false});expect(f.selected()).toBe(1);
  for(const call of f.calls){expect(call.init.redirect).toBe('manual');expect(call.init.credentials).toBe('omit');expect(call.init.signal?.aborted).toBe(false);}
  expect(new Headers(f.calls[0].init.headers).get('authorization')).toBe('Bearer '+token);
  expect(Object.fromEntries(new Headers(f.calls[1].init.headers))).toEqual({});expect(f.calls[1].init.method).toBe('GET');
  expect(ownerFiles(f)).not.toContain(token);expect(statSync(output(f).destination).mode&0o777).toBe(0o600);expect(statSync(f.directory).mode&0o777).toBe(0o700);
  for(const name of readdirSync(f.directory))expect(statSync(join(f.directory,name)).mode&0o777).toBe(0o600);
  await expect(createFixtureAcquisitionTransport(f.options)).rejects.toThrow();expect(f.selected()).toBe(1);
 });
 it('needs no credential for a signed download and never invokes ambient fetch',async()=>{
  const ambient=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('ambient fetch must not run'));
  const f=fixture({credential:()=>{throw Error('must not select');}}),owner=await createFixtureAcquisitionTransport(f.options);
  await owner.downloadSql(output(f));expect(f.selected()).toBe(0);expect(ambient).not.toHaveBeenCalled();
 });
 it.each([
  {url:'https://evil.invalid'+new URL(list().url).pathname+'?limit=100'},
  {url:list().url.replace(source.accountId,'a'.repeat(32))},
  {url:list().url.replace(source.kvNamespaceId,'b'.repeat(32))},
  {url:kv+'/keys?limit=100&cursor=x&cursor=y'},
  {url:kv+'/keys?limit=100&unknown=x'},
  {url:kv+'/keys?limit=1000'},
  {method:'POST'},
  {body:'SELECT private_data'},
  {kind:'unknown'},
  {credentialScope:'download'},
  {responseBytes:262145},
 ])('refuses malformed management descriptor before a lease or send: %j',async change=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.management({...list(),...change} as AcquisitionFixtureRequest)).rejects.toHaveProperty('code');
  expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);expect(owner.snapshot().terminal).toBe(true);
  await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL'});
 });
 it.each([
  {body:'{"sql":"DELETE FROM private"}'},
  {body:'{"output_format":"polling","dump_options":{"no_schema":false,"no_data":false,"tables":["workspace"]}}'},
  {body:'{"output_format":"polling","dump_options":{"no_schema":false,"no_data":false,"tables":[]},"current_bookmark":""}'},
  {body:'{"output_format":"polling","output_format":"polling","dump_options":{"no_schema":false,"no_data":false,"tables":[]}}'},
  {url:exported+'/query'},
  {method:'GET'},
 ])('admits only the existing fixed export body before credential selection: %j',async change=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);await expect(owner.management({...exportRequest(),...change} as AcquisitionFixtureRequest)).rejects.toHaveProperty('code');expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);
 });
 it('passes the exact opaque export continuation without starting another job',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),request={...exportRequest(),body:JSON.stringify({...JSON.parse(exportRequest().body!),current_bookmark:'opaque/private+bookmark'})};
  await owner.management(request);expect(f.calls).toHaveLength(1);expect(f.calls[0].init.body).toBe(request.body);expect(new Headers(f.calls[0].init.headers).get('content-type')).toBe('application/json');
 });
 it.each(['http://fixture-export.invalid/a','https://other.invalid/a','https://user:pass@fixture-export.invalid/a',signed+'#fragment','https://fixture-export.invalid:8443/a'])('rejects an unapproved signed URL before send: %s',async signedUrl=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);await expect(owner.downloadSql({...output(f),signedUrl})).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_ORIGIN'});expect(f.calls).toHaveLength(0);expect(f.selected()).toBe(0);
 });
 it('refuses destination aliases and preserves an existing file without sending',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);writeFileSync(output(f).destination,'preserve',{mode:0o600});await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(readFileSync(output(f).destination,'utf8')).toBe('preserve');expect(f.calls).toHaveLength(0);
 });
 it('refuses a symlink output without following or truncating it',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),other=join(f.parent,'other');writeFileSync(other,'preserve',{mode:0o600});symlinkSync(other,output(f).destination);await expect(owner.downloadSql(output(f))).rejects.toHaveProperty('code');expect(readFileSync(other,'utf8')).toBe('preserve');expect(f.calls).toHaveLength(0);
 });
 it.each([302,307,401,503])('retains a bounded management HTTP %s observation and terminally fences reuse',async status=>{
  const f=fixture({send:async()=>new Response('PRIVATE UPSTREAM FAILURE',{status,headers:{location:'https://sink.invalid'}})}),owner=await createFixtureAcquisitionTransport(f.options);
  const reply=await owner.management(list());expect(reply.status).toBe(status);expect(Buffer.from(reply.body).toString()).toBe('PRIVATE UPSTREAM FAILURE');expect(owner.snapshot().terminal).toBe(true);expect(f.calls).toHaveLength(1);
  await expect(owner.management(list(2))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL'});expect(f.calls).toHaveLength(1);expect(ownerFiles(f)).not.toContain('PRIVATE UPSTREAM FAILURE');
 });
 it.each([302,307,401,503])('refuses download HTTP %s with no retry or credential forwarding',async status=>{
  const f=fixture({send:async()=>new Response('private',{status,headers:{location:'https://sink.invalid'}})}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_HTTP'});expect(f.calls).toHaveLength(1);expect(f.selected()).toBe(0);expect(statSync(output(f).destination).size).toBe(0);
 });
 it.each(['declared','streamed','short'] as const)('rejects %s SQL length failures and preserves partial bytes',async kind=>{
  const f=fixture({limits:{downloadBytes:4},send:async()=>kind==='declared'?new Response('abcd',{headers:{'content-length':'5'}}):kind==='short'?new Response('abc',{headers:{'content-length':'4'}}):new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('abc'));c.enqueue(Buffer.from('de'));c.close();}}))}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_RESPONSE_BOUND'});expect(existsSync(output(f).destination)).toBe(true);expect(f.calls).toHaveLength(1);expect(owner.snapshot().terminal).toBe(true);
 });
 it('enforces management reply and combined aggregate byte limits',async()=>{
  const f=fixture({limits:{aggregateResponseBytes:60}}),owner=await createFixtureAcquisitionTransport(f.options);await owner.management(list());await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_AGGREGATE_BOUND'});expect(owner.snapshot().requests).toBe(2);
  const g=fixture({limits:{responseBytes:2},send:async()=>new Response('abc')}),other=await createFixtureAcquisitionTransport(g.options);await expect(other.management({...list(),responseBytes:2})).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_RESPONSE_BOUND'});
 });
 it('counts management and download against the same durable request ceiling',async()=>{
  const f=fixture({limits:{maxRequests:2}}),owner=await createFixtureAcquisitionTransport(f.options);await owner.management(list());await owner.downloadSql(output(f));await expect(owner.management(list(2))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_REQUEST_BOUND'});expect(f.calls).toHaveLength(2);expect(f.selected()).toBe(1);expect(owner.snapshot()).toMatchObject({requests:2,sent:2,terminal:true});
 });
 it('refuses an already-aborted request without selecting credentials or sending',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),controller=new AbortController();controller.abort();await expect(owner.management(list(),controller.signal)).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_CANCELLED'});expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);
 });
 it('bounds ignored-abort send IO and refuses every later call',async()=>{
  vi.useFakeTimers();const f=fixture({send:async()=>new Promise(()=>{})}),owner=await createFixtureAcquisitionTransport(f.options);
  const pending=owner.management(list()).catch(error=>error);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({code:'ACQUISITION_TRANSPORT_TIMEOUT',ioSettled:false});expect(f.calls[0].init.signal?.aborted).toBe(true);await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL'});expect(f.calls).toHaveLength(1);
 });
 it('settles an external body cancellation before returning its terminal error',async()=>{
  const controller=new AbortController();let cancelled=false;
  const f=fixture({send:async()=>new Response(new ReadableStream({pull(){controller.abort();},cancel(){cancelled=true;}}))}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.downloadSql(output(f),controller.signal)).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_CANCELLED',ioSettled:true});expect(cancelled).toBe(true);expect(f.calls).toHaveLength(1);
 });
 it('marks body cancellation that never settles as uncertain',async()=>{
  vi.useFakeTimers();const f=fixture({send:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}))}),owner=await createFixtureAcquisitionTransport(f.options);
  const pending=owner.downloadSql(output(f)).catch(error=>error);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(2000);expect(await pending).toMatchObject({code:'ACQUISITION_TRANSPORT_TIMEOUT',ioSettled:false});
 });
 it('checks synchronous clock overrun before accepting a response',async()=>{
  const f=fixture({send:async()=>{f.setMono(1001);return new Response('private');}}),owner=await createFixtureAcquisitionTransport(f.options);await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TIMEOUT'});expect(f.calls).toHaveLength(1);
 });
 it('rejects credential, policy and wall expiry and never refreshes a lease',async()=>{
  const f=fixture({credential:()=>({fixtureOnly:true,value:token,expiresAt:1})}),owner=await createFixtureAcquisitionTransport(f.options);await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_CREDENTIAL'});expect(f.selected()).toBe(1);expect(f.calls).toHaveLength(0);
  const g=fixture(),other=await createFixtureAcquisitionTransport(g.options);g.setWall(g.options.validUntil);await expect(other.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_EXPIRY'});expect(g.selected()).toBe(0);
 });
 it('reserves before credential selection, and refuses a failed reservation fsync before IO',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=join(f.directory,'exchange-0001.intent.json');
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)throw Error('PRIVATE fsync');};
  await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);expect(existsSync(path)).toBe(true);expect(existsSync(join(f.directory,'owner.failure.json'))).toBe(true);
 });
 it('fences a file fsync failure after all downloaded bytes exist',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)throw Error('PRIVATE final download fsync');};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(statSync(path).size).toBeGreaterThan(0);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);expect(owner.snapshot().terminal).toBe(true);
 });
 it('fences a directory fsync failure after SQL bytes settle',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;
  hooks.afterFsync=fd=>{if(existsSync(path)&&statSync(path).size>0&&fstatSync(fd).ino===statSync(f.directory).ino)throw Error('PRIVATE parent fsync');};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(statSync(path).size).toBeGreaterThan(0);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);
 });
 it('makes an ack persistence failure override retained ack bytes and blocks reuse',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=join(f.directory,'exchange-0001.ack.json');
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)throw Error('PRIVATE after ack');};
  await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(existsSync(path)).toBe(true);expect(existsSync(join(f.directory,'owner.failure.json'))).toBe(true);await expect(owner.management(list(2))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL'});
 });
 it('refuses synchronous expiry after an ack was persisted',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=join(f.directory,'exchange-0001.ack.json');
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)f.setMono(1001);};
  await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TIMEOUT'});expect(existsSync(path)).toBe(true);expect(owner.snapshot().terminal).toBe(true);
 });
 it('refuses concurrent exchanges and never creates a second wire operation',async()=>{
  let finish!:(response:Response)=>void;
  const f=fixture({send:async()=>new Promise(resolve=>{finish=resolve;})}),owner=await createFixtureAcquisitionTransport(f.options);
  const first=owner.management(list()).catch(error=>error);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await expect(owner.management(list(2))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_CONCURRENT'});finish(new Response('private'));expect(await first).toHaveProperty('code');expect(f.calls).toHaveLength(1);
 });
 it('refuses non-fixture configuration, unsafe origins and raised ceilings before creating an owner',async()=>{
  for(const change of [{fixtureOnly:false},{signedDownloadOrigin:'http://fixture.invalid'},{limits:{...fixture().options.limits,maxRequests:2201}},{limits:{...fixture().options.limits,responseBytes:262145}}]){
   const f=fixture();await expect(createFixtureAcquisitionTransport({...f.options,...change} as AcquisitionTransportOptions)).rejects.toHaveProperty('code');expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);expect(existsSync(f.directory)).toBe(false);
  }
 });
 it('requires a synthetic lease and snapshots its admitted expiry and limits',async()=>{
  const f=fixture({credential:()=>({fixtureOnly:true,value:'not-a-synthetic-token',expiresAt:f.getWall()+60000})}),owner=await createFixtureAcquisitionTransport(f.options);await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_CREDENTIAL'});expect(f.calls).toHaveLength(0);
  const g=fixture(),other=await createFixtureAcquisitionTransport(g.options);g.options.validUntil+=100000;g.options.limits.maxRequests=100;g.setWall(g.getWall()+60000);await expect(other.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_EXPIRY'});expect(other.snapshot().limits.maxRequests).toBe(30);
 });
 it.each(['null-body','bad-length','wrong-chunk','redirected'] as const)('rejects malformed %s responses safely',async kind=>{
  const f=fixture({send:async()=>{
   if(kind==='null-body')return new Response(null);
   if(kind==='bad-length')return new Response('x',{headers:{'content-length':'private-invalid'}});
   if(kind==='wrong-chunk')return new Response(new ReadableStream({start(c){c.enqueue('private text' as unknown as Uint8Array);c.close();}}));
   const response=new Response('private');Object.defineProperty(response,'redirected',{value:true});return response;
  }}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.management(list())).rejects.toHaveProperty('code');expect(f.calls).toHaveLength(1);expect(ownerFiles(f)).not.toContain('private text');expect(ownerFiles(f)).not.toContain('private-invalid');expect(owner.snapshot().terminal).toBe(true);
 });
 it('reports rejected body cleanup as unsettled without retrying cancellation',async()=>{
  let cancellations=0;const f=fixture({limits:{downloadBytes:1},send:async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('too large'));},cancel(){cancellations++;throw Error('PRIVATE cancellation failure');}}))}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_RESPONSE_BOUND',ioSettled:false});expect(cancellations).toBe(1);expect(f.calls).toHaveLength(1);
 });
 it('cancels a late ignored-abort response without adding an acknowledgement',async()=>{
  vi.useFakeTimers();let finish!:(response:Response)=>void,cancelled=false;
  const f=fixture({send:async()=>new Promise(resolve=>{finish=resolve;})}),owner=await createFixtureAcquisitionTransport(f.options),pending=owner.management(list()).catch(error=>error);
  await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(1000);expect(await pending).toMatchObject({ioSettled:false});
  finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));await vi.waitFor(()=>expect(cancelled).toBe(true));expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);expect(f.calls).toHaveLength(1);
 });
 it('checks the output inode and size after fsync before reporting its hash',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;let changed=false;
  hooks.afterFsync=fd=>{if(!changed&&existsSync(path)&&fstatSync(fd).ino===statSync(path).ino){changed=true;writeFileSync(path,'changed size',{mode:0o600});}};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_OUTPUT_DRIFT'});expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);
 });
 it('rejects a journal permission change before selecting a lease or dispatching',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options);chmodSync(f.directory,0o755);await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_DIRECTORY_DRIFT'});expect(f.selected()).toBe(0);expect(f.calls).toHaveLength(0);
 });
 it('applies one spacing clock across management and download starts',async()=>{
  const starts:number[]=[],f=fixture({limits:{minStartSpacingMs:20},send:async()=>{starts.push(f.getMono());return new Response('x');}}),owner=await createFixtureAcquisitionTransport(f.options);
  await owner.management(list());await owner.downloadSql(output(f));await owner.management(list(2));expect(starts).toEqual([0,20,40]);
 });
 it.each([Error('PRIVATE provider key and signed URL'),new ProtectedAcquisitionTransportError('PRIVATE provider key and signed URL')])('keeps arbitrary injected failure details out of errors and receipts',async error=>{
  const f=fixture({send:async()=>{throw error;}}),owner=await createFixtureAcquisitionTransport(f.options);
  await expect(owner.management(list())).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO',message:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(ownerFiles(f)).not.toContain('PRIVATE provider key');
 });
 it('returns a safe code rather than a private path when owner creation is refused',async()=>{
  const f=fixture();await createFixtureAcquisitionTransport(f.options);const error=await createFixtureAcquisitionTransport(f.options).catch(error=>error);expect(error).toMatchObject({code:'ACQUISITION_TRANSPORT_LOCAL_OR_IO'});expect(error.message).not.toContain(f.directory);
 });
 it.each(['management','download'] as const)('keeps an invalid concurrent %s call from certifying unsettled IO',async kind=>{
  vi.useFakeTimers();const f=fixture({send:async()=>new Promise(()=>{})}),owner=await createFixtureAcquisitionTransport(f.options);
  let firstError:unknown;const first=owner.management(list()).catch(error=>{firstError=error;});
  await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
  const second=await(kind==='management'?owner.management({...list(2),method:'POST'}):owner.downloadSql({...output(f),signedUrl:'https://other.invalid/private'})).catch(error=>error);
  expect(second.ioSettled).toBe(false);expect(JSON.parse(readFileSync(join(f.directory,'owner.failure.json'),'utf8')).ioSettled).toBe(false);
  await vi.waitFor(()=>expect(firstError).toBeInstanceOf(Error),{timeout:100,interval:1});await first;
  expect(firstError).toMatchObject({ioSettled:false});expect(f.calls).toHaveLength(1);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);
  await expect(owner.management(list(3))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL',ioSettled:false});
 });
 it.each(['management','download'] as const)('preserves latched uncertainty when an abort-aware send drains after invalid concurrent %s input',async kind=>{
  const f=fixture({send:async(_url,init)=>new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(Error('PRIVATE aborted transport')),{once:true});})}),owner=await createFixtureAcquisitionTransport(f.options);
  const first=owner.management(list()).catch(error=>error);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
  const second=await(kind==='management'?owner.management({...list(2),method:'POST'}):owner.downloadSql({...output(f),signedUrl:'https://other.invalid/private'})).catch(error=>error);
  expect(second).toMatchObject({ioSettled:false});expect(await first).toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL',ioSettled:false});
  expect(owner.snapshot()).toMatchObject({terminal:true,inFlight:false,ioSettled:false});expect(JSON.parse(readFileSync(join(f.directory,'owner.failure.json'),'utf8')).ioSettled).toBe(false);
  await expect(owner.management(list(3))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TERMINAL',ioSettled:false});expect(f.calls).toHaveLength(1);expect(ownerFiles(f)).not.toContain('PRIVATE aborted transport');
 });
 it('rejects a same-size SQL rewrite after fsync before certifying the saved digest',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;let changed=false;
  hooks.afterFsync=fd=>{if(!changed&&existsSync(path)&&fstatSync(fd).ino===statSync(path).ino){changed=true;writeFileSync(path,Buffer.alloc(statSync(path).size,120),{mode:0o600});}};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_OUTPUT_HASH_MISMATCH'});expect(changed).toBe(true);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);expect(owner.snapshot().terminal).toBe(true);expect(readFileSync(path).every(byte=>byte===120)).toBe(true);
 });
 it('bounds persisted-file readback by the original download deadline',async()=>{
  const f=fixture(),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;let readback=false;
  hooks.afterRead=(fd,bytes)=>{if(bytes>0&&existsSync(path)&&fstatSync(fd).ino===statSync(path).ino){readback=true;f.setMono(2001);}};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_TIMEOUT'});expect(readback).toBe(true);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);expect(statSync(path).size).toBeGreaterThan(0);
 });
 it('detects changes during bounded readback and reads only the owned file descriptor',async()=>{
  const payload='a'.repeat(100000),f=fixture({limits:{downloadBytes:120000,aggregateResponseBytes:130000},send:async()=>new Response(payload)}),owner=await createFixtureAcquisitionTransport(f.options),path=output(f).destination;
  let ownedFd:number|undefined,reads=0,changed=false;
  hooks.afterFsync=fd=>{if(existsSync(path)&&fstatSync(fd).ino===statSync(path).ino)ownedFd=fd;};
  hooks.afterRead=(fd,bytes)=>{if(bytes>0){reads++;expect(fd).toBe(ownedFd);expect(bytes).toBeLessThanOrEqual(65536);if(!changed){changed=true;writeFileSync(path,'b'.repeat(payload.length),{mode:0o600});}}};
  await expect(owner.downloadSql(output(f))).rejects.toMatchObject({code:'ACQUISITION_TRANSPORT_OUTPUT_DRIFT'});expect(reads).toBe(2);expect(existsSync(join(f.directory,'exchange-0001.ack.json'))).toBe(false);expect(owner.snapshot().terminal).toBe(true);
 });
 it('remains compatible with the existing complete KV A/export/KV B fixture algorithm',async()=>{
  let polls=0;const f=fixture({send:async(url)=>url.includes('/export')?Response.json({success:true,result:++polls===1?{at_bookmark:'stable-private'}:{status:'complete',result:{signed_url:signed}}}):Response.json({success:true,result:[],result_info:{cursor:''}})}),owner=await createFixtureAcquisitionTransport(f.options);
  const result=await captureProtectedAcquisitionFixture({mode:'fixture-only',source,captureDirectory:join(f.parent,'core'),validUntil:f.options.validUntil,limits:{maxRequests:6,wallMs:10000,requestMs:1000,kvNames:10,kvPages:1,exportPolls:2},clock:f.options.clock,io:{fixtureOnly:true,exchange:owner.management}});
  expect(result).toMatchObject({fixtureCaptureComplete:true,requests:4,downloadPending:true,providerAuthenticated:false,globalQuiescenceEstablished:false,productionAcquisitionQualified:false});await owner.downloadSql(output(f));expect(owner.snapshot().requests).toBe(5);expect(f.selected()).toBe(1);
 });
 it('preserves the core HTTP failure status and raw capture without a new export',async()=>{
  const f=fixture({send:async()=>new Response('PRIVATE refusal',{status:503})}),owner=await createFixtureAcquisitionTransport(f.options),directory=join(f.parent,'core');
  await expect(captureProtectedAcquisitionFixture({mode:'fixture-only',source,captureDirectory:directory,validUntil:f.options.validUntil,limits:{maxRequests:6,wallMs:10000,requestMs:1000,kvNames:10,kvPages:1,exportPolls:2},clock:f.options.clock,io:{fixtureOnly:true,exchange:owner.management}})).rejects.toMatchObject({code:'ACQUISITION_HTTP'});
  expect(readFileSync(join(directory,'request-0001.raw'),'utf8')).toBe('PRIVATE refusal');expect(JSON.parse(readFileSync(join(directory,'request-0001.ack.json'),'utf8')).status).toBe(503);expect(f.calls).toHaveLength(1);expect(owner.snapshot().terminal).toBe(true);
 });
});
