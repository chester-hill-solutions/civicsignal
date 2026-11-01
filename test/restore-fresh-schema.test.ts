import { describe, expect, it } from 'vitest';
import { isFreshRestoreDatabase, isFreshRestoreSchema, type RestoreSchemaEntry } from '../services/restore/fresh-schema';
import { testD1 } from './helpers/d1';

const hosted: RestoreSchemaEntry = {name:'_cf_KV',type:'table',sql:'CREATE TABLE _cf_KV (\n key TEXT PRIMARY KEY,\n value BLOB\n) WITHOUT ROWID'};
const local: RestoreSchemaEntry = {name:'_cf_METADATA',type:'table',sql:'CREATE TABLE _cf_METADATA (\n key INTEGER PRIMARY KEY,\n value BLOB\n)'};

describe('fresh restore schema identity',()=>{
  it('accepts only observed hosted/local bookkeeping shapes and SQLite internals',()=>{
    expect(isFreshRestoreSchema([])).toBe(true);
    expect(isFreshRestoreSchema([hosted])).toBe(true);
    expect(isFreshRestoreSchema([local])).toBe(true);
    expect(isFreshRestoreSchema([hosted,local,{name:'sqlite_autoindex__cf_KV_1',type:'index',sql:null}])).toBe(true);
    expect(isFreshRestoreSchema([{...hosted,sql:'create table _cf_KV(key text primary key,value blob) without rowid'}])).toBe(true);
  });

  it('reads the actual hosted schema fixture through the shared SQL guard and preserves its data',async()=>{
    // D1's public API correctly forbids constructing its reserved _cf_KV table.
    // Execute the independently observed hosted DDL in SQLite for this fixture.
    const fixture=testD1({schema:hosted.sql!+';'+local.sql!+';'});
    try {
      fixture.sqlite.prepare('INSERT INTO _cf_KV VALUES(?,?)').run('system-entry','preserved');
      expect(await isFreshRestoreDatabase(fixture.db)).toBe(true);
      expect(fixture.sqlite.prepare('SELECT value FROM _cf_KV WHERE key=?').get('system-entry')).toEqual({value:'preserved'});
      fixture.sqlite.exec('CREATE TABLE _cf_unknown(id INTEGER)');
      expect(await isFreshRestoreDatabase(fixture.db)).toBe(false);
    } finally {fixture.close();}
  });

  it.each([
    {name:'workspace',type:'table',sql:'CREATE TABLE workspace(id TEXT PRIMARY KEY)'},
    {name:'_cf_unknown',type:'table',sql:'CREATE TABLE _cf_unknown(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID'},
    {name:'sqliteXhidden',type:'table',sql:'CREATE TABLE sqliteXhidden(id INTEGER)'},
    {...hosted,type:'view'},
    {...hosted,sql:'CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB)'},
    {...hosted,sql:'CREATE TABLE _cf_KV(key INTEGER PRIMARY KEY,value BLOB) WITHOUT ROWID'},
    {...hosted,sql:'CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB,secret TEXT) WITHOUT ROWID'},
    {...hosted,sql:'CREATE TABLE _cf_KV(keytext PRIMARY KEY,value BLOB) WITHOUT ROWID'},
    {...local,sql:'CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value TEXT)'},
    {...local,sql:null},
    {name:'constructor',type:'table',sql:'CREATE TABLE constructor(key INTEGER PRIMARY KEY,value BLOB)'},
  ])('rejects application, unknown or misshapen objects: $name / $sql',(entry)=>{
    expect(isFreshRestoreSchema([entry])).toBe(false);
  });
});
