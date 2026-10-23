import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROTECTED_TABLE_COLUMNS, PROTECTED_TABLE_ORDER, PROTECTED_AUTH_TABLES, PROTECTED_HISTORY_TABLES,
  MAX_PROTECTED_PAGE_ROWS, MAX_PROTECTED_PAGE_BYTES, ProtectedStateError,
  checkedProtectedManifest, checkedProtectedPage, checkedProtectedRow,
  protectedPageCanonical, protectedPageDigest, protectedRowCanonical,
  type ProtectedManifest, type ProtectedPage, type ProtectedScalar, type ProtectedTable,
} from '../src/corpora/protected-state-format';
import { ProtectedStateError as OfflineError } from '../scripts/lib/protected-state';

// Digests recorded from the original format-1 Node SHA-256 writer before extraction.
const goldens: {table:ProtectedTable;row:ProtectedScalar[];sha256:string}[] = [
  {table:'workspace',row:['workspace',"L'Acte — règle\n第二行",null,0,Number.MAX_SAFE_INTEGER],sha256:'cab4da8ec8ed3c12854d6bd6ebab25761c690eace7a4b7c40709030a94bcc7ed'},
  {table:'civic_workspace_billing',row:['workspace','free',1000,0,null,0],sha256:'ee0cbd716f47621e7662f8bfa2dbcb020683c4bfa3161a88cbed34b260892357'},
  {table:'workspace_api_key',row:['key','workspace','Key','b'.repeat(64),'prefix','["civicsignal.retrieve"]','revoked',null,0,1,2],sha256:'e50f71de04ca6b4974ad8cf7e9f1b10e51ebda438e986b0207123c81948e4662'},
  {table:'corpus_runs',row:[120,'statutes-canada','a'.repeat(40),'2026-10-15','2026-10-23T00:00:00Z',0,320,0,277537,320,100,1,null,'statutes-v2'],sha256:'4ccdd35cd5f7d40230bf036a7e1bb927f0ebe8d8abf1e139b3fd43dca0ebdbaa'},
  {table:'corpus_changes',row:[1000,'statutes-canada','changed','acts-en-1','Act','T-1','1',null,'in-force','Summary','https://example.invalid','2026-10-15','2026-10-23T00:00:00Z'],sha256:'606a880e7432eecf66d7f031f0e44dc368b60ed6571a90a34dbaada50c9c6b37'},
  {table:'corpus_mutations',row:['operation','statutes-canada',null,'2026-10-23T00:00:00Z'],sha256:'3859ad2f8810d7fa87f4be5f9898cf88b774b4a0eb7838170cef314ce78354d7'},
  {table:'corpus_state',row:['statutes-canada','a'.repeat(40),'2026-10-15','2026-10-15',277857,'2026-10-23T00:00:00Z','statutes-v2'],sha256:'ddc263d41766ccb36f7cb246e4775d8e48acb443a13340ab5a804c29c8af7cd8'},
  {table:'sqlite_sequence',row:['corpus_changes',1001],sha256:'537e4f2ffb869523b30a74b596bf947dc0f3e340dbe88fea23124e2f39dd4251'},
];
const page = ():ProtectedPage => ({page:1,table:'workspace',rows:[goldens[0]!.row.slice()],sha256:goldens[0]!.sha256});
function manifest():ProtectedManifest {
  const hash='a'.repeat(64);
  return {format:1,sourceKind:'sql',sourceSha256:hash,sourceSqliteSha256:hash,legacyAuthSha256:hash,targetSha256:hash,
    cutoverManifestSha256:hash,corpusDigest:'b'.repeat(32),corpusMetadataSha256:hash,corpusRows:277857,
    revision:'a'.repeat(40)+':statutes-v2',initialPublication:[goldens.find(g=>g.table==='corpus_state')!.row.slice()],
    pages:8,pagesSha256:hash,tables:Object.fromEntries(goldens.map(g=>[g.table,{rows:1,sha256:g.sha256}])) as ProtectedManifest['tables']};
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function sealedPages():Promise<ProtectedPage[]> {
  const text=await readFile(new URL('./fixtures/protected-state-format-v1-pages.jsonl',import.meta.url),'utf8');
  expect(Buffer.byteLength(text)).toBe(1758);
  expect(hash(text)).toBe('858ff4bf1a1c47c9a83d56ee650771c54278e02a5d41a86c03412e8e915f3e05');
  return text.trimEnd().split('\n').map(line=>JSON.parse(line) as ProtectedPage);
}
describe('shared protected format-1 codec',()=>{
  it('retains the original fixed tables, row limits and error identity',()=>{
    expect(PROTECTED_TABLE_ORDER).toEqual(goldens.map(g=>g.table));
    expect(PROTECTED_AUTH_TABLES).toEqual(['workspace','civic_workspace_billing','workspace_api_key']);
    expect(PROTECTED_HISTORY_TABLES).toEqual(['corpus_runs','corpus_changes']);
    expect(MAX_PROTECTED_PAGE_ROWS).toBe(16);expect(MAX_PROTECTED_PAGE_BYTES).toBe(65536);
    expect(OfflineError).toBe(ProtectedStateError);
  });
  it.each(goldens)('preserves sealed $table canonical bytes and digest',async({table,row,sha256})=>{
    const value={page:1,table,rows:[row],sha256};
    expect(await checkedProtectedPage(value)).toBe(value);
    expect(await protectedPageDigest(value)).toBe(sha256);
    expect(hash(protectedPageCanonical(value))).toBe(sha256);
    expect(protectedRowCanonical(row)).toBe(JSON.stringify(row)+'\n');
    expect(checkedProtectedRow(table,row)).toEqual(row);
  });
  it('canonicalizes page property order and excludes its stored digest',async()=>{
    const value=page();const reordered={sha256:value.sha256,rows:value.rows,table:value.table,page:value.page};
    expect(protectedPageCanonical(reordered)).toBe(`{"page":1,"table":"workspace","rows":[["workspace","L'Acte — règle\\n第二行",null,0,9007199254740991]]}`);
    expect(await checkedProtectedPage(reordered)).toBe(reordered);
  });
  it('refuses tampering, foreign tables, row shape and unsafe scalar values',async()=>{
    const value=page();await expect(checkedProtectedPage({...value,sha256:'0'.repeat(64)})).rejects.toMatchObject({code:'PAGE_HASH_MISMATCH'});
    for(const altered of [{...value,table:'sqlite_master'},{...value,page:0},{...value,rows:[]},{...value,rows:[['workspace']]},
      {...value,rows:[['workspace',{},null,0,1]]},{...value,rows:[['workspace','name',null,0,Number.MAX_SAFE_INTEGER+1]]}])await expect(checkedProtectedPage(altered)).rejects.toBeInstanceOf(ProtectedStateError);
  });
  it('measures UTF8 byte bounds and accepts exactly16 rows',async()=>{
    const full={page:1,table:'workspace' as const,rows:Array.from({length:16},()=>goldens[0]!.row.slice()),sha256:''};full.sha256=await protectedPageDigest(full);
    await expect(checkedProtectedPage(full)).resolves.toBe(full);
    await expect(checkedProtectedPage({...full,rows:[...full.rows,goldens[0]!.row]})).rejects.toMatchObject({code:'INVALID_PAGE'});
    const wide=page();wide.rows[0]![1]='界'.repeat(22000);wide.sha256=await protectedPageDigest(wide);
    expect(JSON.stringify(wide).length).toBeLessThan(65536);expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(65536);
    await expect(checkedProtectedPage(wide)).rejects.toMatchObject({code:'INVALID_PAGE'});
  });
  it('validates the unchanged sealed v1 file, including isolated surrogate code units',async()=>{
    const values=await sealedPages();expect(values.map(p=>p.page)).toEqual([1,2,3,4,5,6,7,8]);
    expect(values.map(p=>p.table)).toEqual(PROTECTED_TABLE_ORDER);
    expect(String(values[0]!.rows[0]![1])).toContain('\ud800x\udfff');
    for(const value of values)await expect(checkedProtectedPage(value)).resolves.toBe(value);
  });
  it('accepts the original exact64KiB page and refuses one extra byte',async()=>{
    const value:ProtectedPage={page:1,table:'workspace',rows:[['workspace','x'.repeat(65395),null,0,1]],sha256:'5d41dc2c21a4286b984615de6eea82540c3d1e295654576a30c05b9136645e38'};
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(65536);
    await expect(checkedProtectedPage(value)).resolves.toBe(value);
    value.rows[0]![1]+='x';expect(Buffer.byteLength(JSON.stringify(value))).toBe(65537);
    await expect(checkedProtectedPage(value)).rejects.toMatchObject({code:'INVALID_PAGE'});
  });
  it('retains completed mutation, key capability and original sequence checks',()=>{
    expect(()=>checkedProtectedRow('corpus_mutations',['operation','statutes-canada','pending','time'])).toThrow('PENDING_OUTBOX');
    expect(()=>checkedProtectedRow('corpus_mutations',['operation','foreign',null,'time'])).toThrow('UNSUPPORTED_CORPUS_IDENTITY');
    const key=goldens.find(g=>g.table==='workspace_api_key')!.row.slice();key[5]='{}';expect(()=>checkedProtectedRow('workspace_api_key',key)).toThrow('INVALID_AUTH_ROW');
    expect(()=>checkedProtectedRow('sqlite_sequence',['other_table',1001])).toThrow('INVALID_SEQUENCE');
    expect(()=>checkedProtectedRow('sqlite_sequence',['corpus_changes',-1])).toThrow('INVALID_SEQUENCE');
  });
  it('preserves original manifest shape/order and leaves publication admission to the caller',()=>{
    const value=manifest(),bytes=JSON.stringify(value);expect(checkedProtectedManifest(value)).toBe(value);expect(JSON.stringify(value)).toBe(bytes);
    expect(()=>checkedProtectedManifest({...value,format:2})).toThrow('INVALID_MANIFEST');
    expect(()=>checkedProtectedManifest({...value,tables:Object.fromEntries(Object.entries(value.tables).reverse())})).toThrow('INVALID_MANIFEST');
    // Historical schema validation is unchanged. Binding admission must validate
    // this row, then compare its complete publication identity to the target.
    const malformed={...value,initialPublication:[['statutes-canada']]};expect(checkedProtectedManifest(malformed)).toBe(malformed);
    expect(()=>checkedProtectedRow('corpus_state',malformed.initialPublication[0])).toThrow('INVALID_PROTECTED_VALUE');
    expect(()=>checkedProtectedRow('corpus_state',[...goldens.find(g=>g.table==='corpus_state')!.row.slice(0,4),{},'time',null])).toThrow('INVALID_PROTECTED_VALUE');
  });
});

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
describe.skipIf(process.env['CIVICSIGNAL_WORKERD_TESTS']!=='1')('shared protected format in actual local workerd',()=>{
  it('imports without Node compatibility and validates the same hashes with platform WebCrypto',async()=>{
    const sealed=await sealedPages();
    const result=await build({stdin:{contents:`
      import {checkedProtectedPage,checkedProtectedManifest,checkedProtectedRow,protectedPageDigest,ProtectedStateError} from './src/corpora/protected-state-format';
      const goldens=${JSON.stringify(goldens)},manifest=${JSON.stringify(manifest())},sealed=${JSON.stringify(sealed)};
      export default {async fetch(){
        const hashes=[];for(const g of goldens){const p={page:1,table:g.table,rows:[g.row],sha256:g.sha256};await checkedProtectedPage(p);hashes.push(await protectedPageDigest(p));}
        const sealedHashes=[];for(const p of sealed){await checkedProtectedPage(p);sealedHashes.push(await protectedPageDigest(p));}
        const boundary={page:1,table:'workspace',rows:[['workspace','x'.repeat(65395),null,0,1]],sha256:'5d41dc2c21a4286b984615de6eea82540c3d1e295654576a30c05b9136645e38'};
        await checkedProtectedPage(boundary);const boundaryHash=await protectedPageDigest(boundary);
        checkedProtectedManifest(manifest);checkedProtectedRow('corpus_state',manifest.initialPublication[0]);
        const rejected=[];for(const p of [{page:1,table:'workspace',rows:[goldens[0].row],sha256:'0'.repeat(64)},
          {page:1,table:'workspace',rows:Array(17).fill(goldens[0].row),sha256:'0'.repeat(64)},
          {page:1,table:'workspace',rows:[['workspace','界'.repeat(22000),null,0,1]],sha256:'0'.repeat(64)}]){
          try{await checkedProtectedPage(p);throw Error('Invalid page accepted');}catch(e){if(!(e instanceof ProtectedStateError))throw e;rejected.push(e.code);}
        }
        return Response.json({hashes,sealedHashes,boundaryHash,rejected,publicationRows:manifest.initialPublication.length});
      }};`,loader:'ts',resolveDir:resolve('.')},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,metafile:true});
    expect(Object.keys(result.metafile!.inputs).filter(name=>name!=='<stdin>')).toEqual(['src/corpora/protected-state-format.ts']);
    const root=await mkdtemp(join(tmpdir(),'protected-format-workerd-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
    const mf=new Miniflare({telemetry:{enabled:false},unsafeDevRegistryPath:join(root,'registry'),resourcePersistencePath:join(root,'persistence'),workers:[{
      config:{name:'protected-format-local',compatibilityDate:'2026-10-22',manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:result.outputFiles[0]!.text}}}},
      dev:{outboundService:{type:'fetcher',handler:async()=>{throw Error('External networking forbidden.');}}},
    }]});cleanup.push(()=>mf.dispose());
    const response=await mf.dispatchFetch('https://local.invalid/validate');expect(response.status).toBe(200);
    expect(await response.json()).toEqual({hashes:goldens.map(g=>g.sha256),sealedHashes:sealed.map(p=>p.sha256),boundaryHash:'5d41dc2c21a4286b984615de6eea82540c3d1e295654576a30c05b9136645e38',rejected:['PAGE_HASH_MISMATCH','INVALID_PAGE','INVALID_PAGE'],publicationRows:1});
  });
});
