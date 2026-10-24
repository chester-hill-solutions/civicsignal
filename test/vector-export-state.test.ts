import { describe, expect, it } from 'vitest';
import { assertCorpusVectorExportCurrent } from '../services/pipeline/vector-export';
import { testD1 } from './helpers/d1';
import { SNAPSHOT_PARSER_VERSION } from '../src/ingest/snapshot-format';

it('uses deterministic SQL mutation identities to require visible fingerprints only on current mutated vectors', async () => {
  const h = testD1({ schema: `CREATE TABLE corpus_state(corpus_id TEXT,commit_sha TEXT,parser_version TEXT,row_count INTEGER);
    CREATE TABLE statute_sections(id TEXT,corpus_id TEXT,text_hash TEXT);
    CREATE TABLE corpus_mutations(id TEXT,corpus_id TEXT,payload TEXT);` });
  try {
    const body = { commit: 'a'.repeat(40), parser: SNAPSHOT_PARSER_VERSION, indexDigest: 'b'.repeat(32), part: 0 };
    h.sqlite.prepare('INSERT INTO corpus_state VALUES(?,?,?,2)').run('statutes-canada', body.commit, body.parser);
    for (const id of ['acts-en-1', 'acts-en-2']) h.sqlite.prepare('INSERT INTO statute_sections VALUES(?,?,?)').run(id, 'statutes-canada', `hash-${id}`);
    const entries = ['acts-en-1', 'acts-en-2'].map((id, at) => ({ id, fp: `hash-${id}`, off: at, len: 1 }));
    const mutation = JSON.stringify(['statutes-canada', body.commit, entries[0]!.id, entries[0]!.fp]);
    h.sqlite.prepare('INSERT INTO corpus_mutations VALUES(?,?,NULL)').run(mutation, 'statutes-canada');
    expect(await assertCorpusVectorExportCurrent(h.db, 'statutes-canada', body, entries, 2)).toEqual(new Set(['acts-en-1']));
    h.sqlite.prepare('UPDATE corpus_mutations SET payload=?').run('{"upsert":{}}');
    await expect(assertCorpusVectorExportCurrent(h.db, 'statutes-canada', body, entries, 2)).rejects.toThrow('empty vector outbox');
    h.sqlite.exec('UPDATE corpus_mutations SET payload=NULL');
    h.sqlite.prepare('UPDATE statute_sections SET text_hash=? WHERE id=?').run('different', entries[1]!.id);
    await expect(assertCorpusVectorExportCurrent(h.db, 'statutes-canada', body, entries, 2)).rejects.toThrow('fingerprints');
    await expect(assertCorpusVectorExportCurrent(h.db, 'statutes-canada', { ...body, commit: 'c'.repeat(40) }, [], 2)).rejects.toThrow('revision/parser');
  } finally { h.close(); }
});
