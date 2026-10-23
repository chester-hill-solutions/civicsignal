import { afterEach, describe, expect, it } from 'vitest';
import { auditProvisionTextPage, createR2ProvisionTextStore, MAX_HYDRATED_TEXT_BYTES, MAX_PROVISION_TEXT_BYTES, parseCorpusTextMode, prepareProvisionText,
  ProvisionTextError, readVerifiedProvisionText, rowFingerprintWithText, textReferenceBindings,
  UPSERT_TEXT_REFERENCE_SQL, writeImmutableProvisionText } from '../src/corpora/text-store';
import { statutesCorpus } from '../src/corpora/adapters';
import { citeProvision } from '../src/mcp/cite';
import { testD1 } from './helpers/d1';
import type { CorpusContext } from '../src/corpora/types';
import { memoryTextBucket } from './helpers/text-bucket';

const close: (() => void)[] = [];
afterEach(() => { for (const finish of close.splice(0)) finish(); });

function createTextFixture(text = '\uFEFFLe règlement exige une décision motivée.') {
  const fixture = testD1();
  close.push(fixture.close);
  const row: Record<string, unknown> = { id: 'acts-fr-test', corpus_id: 'statutes-canada', act: 'Loi de test',
    citation: 'T-1', section: '1', status: 'in-force', schedule: null, part: null, heading: 'Décision',
    text, source_url: 'https://laws-lois.justice.gc.ca/fr/lois/T-1/section-1.html', jurisdiction: 'CA',
    in_force: 1, language: 'fr', topics: null };
  row['text_hash'] = rowFingerprintWithText(row, text);
  fixture.sqlite.prepare(`INSERT INTO statute_sections
    (id,corpus_id,act,citation,section,status,schedule,part,heading,text,source_url,jurisdiction,in_force,language,text_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...['id','corpus_id','act','citation','section','status','schedule','part','heading','text','source_url','jurisdiction','in_force','language','text_hash'].map((key) => row[key]) as (string | number | null)[]);
  const ctx: CorpusContext = { db: fixture.db, fetch, now: () => new Date(), corpusRevision: 'r1',
    vector: { async query() { return [{ id: String(row['id']), score: 0.9, metadata: {} }]; } }, embedQuery: async () => [0.1] };
  const memory = memoryTextBucket();
  async function stage() {
    const artifact = await prepareProvisionText({ rowId: String(row['id']), corpusId: 'statutes-canada',
      rowFingerprint: String(row['text_hash']), text, createdAt: '2026-10-22T00:00:00Z' });
    await writeImmutableProvisionText(memory.bucket, artifact);
    await fixture.db.prepare(UPSERT_TEXT_REFERENCE_SQL).bind(...textReferenceBindings(artifact.reference)).run();
    return artifact;
  }
  return { ...fixture, ...memory, row, text, ctx, stage };
}

describe('immutable provision text', () => {
  it('bounds the complete retained candidate set before issuing any object reads', async () => {
    const fixture = createTextFixture();
    const count = MAX_HYDRATED_TEXT_BYTES / MAX_PROVISION_TEXT_BYTES + 1;
    const rows = Array.from({ length: count }, (_, at) => ({ ...fixture.row, id: `bounded-${at}`, text: '' }));
    for (let at = 0; at < rows.length; at++) {
      const sha = at.toString(16).padStart(64, '0');
      await fixture.db.prepare(UPSERT_TEXT_REFERENCE_SQL).bind(...textReferenceBindings({ rowId: rows[at]!.id,
        corpusId: 'statutes-canada', rowFingerprint: String(fixture.row['text_hash']), contentSha256: sha,
        objectKey: `statute-text/sha256/${sha}.txt`, bytes: MAX_PROVISION_TEXT_BYTES, createdAt: '2026-10-22T00:00:00Z' })).run();
    }
    await expect(createR2ProvisionTextStore(fixture.db, fixture.bucket, 'r2').hydrate(rows)).rejects.toThrow('hydration bound');
    expect(fixture.reads()).toBe(0);
  });

  it('writes once by content digest, verifies retries, and preserves all UTF-8 bytes', async () => {
    const fixture = createTextFixture();
    const artifact = await fixture.stage();
    await writeImmutableProvisionText(fixture.bucket, artifact);
    expect(fixture.objects.size).toBe(1);
    expect(artifact.reference.objectKey).toMatch(/^statute-text\/sha256\/[a-f0-9]{64}\.txt$/);
    expect(await readVerifiedProvisionText(fixture.bucket, artifact.reference)).toBe(fixture.text);
    fixture.objects.set(artifact.reference.objectKey, new Uint8Array(new TextEncoder().encode('tampered')));
    await expect(writeImmutableProvisionText(fixture.bucket, artifact)).rejects.toBeInstanceOf(ProvisionTextError);
    expect(new TextDecoder().decode(fixture.objects.get(artifact.reference.objectKey))).toBe('tampered');
  });

  it('bounds text before writing and rejects invalid UTF-8 or missing fingerprints', async () => {
    const base = { rowId: 'row', corpusId: 'statutes-canada', rowFingerprint: 'a'.repeat(32) };
    await expect(prepareProvisionText({ ...base, text: 'a'.repeat(MAX_PROVISION_TEXT_BYTES + 1) })).rejects.toBeInstanceOf(ProvisionTextError);
    await expect(prepareProvisionText({ ...base, text: '\uD800' })).rejects.toBeInstanceOf(ProvisionTextError);
    await expect(prepareProvisionText({ ...base, text: 'a', rowFingerprint: '' })).rejects.toBeInstanceOf(ProvisionTextError);
    expect(parseCorpusTextMode(undefined)).toBe('d1');
    expect(() => parseCorpusTextMode('maybe')).toThrow(ProvisionTextError);
  });
});

describe('D1 to R2 read cutover', () => {
  it('audits every published row in resumable bounded pages and rejects a changed publication', async () => {
    const fixture = createTextFixture();
    await fixture.stage();
    fixture.sqlite.prepare(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at,parser_version)
      VALUES ('statutes-canada','revision','2026-10-22','2026-10-22',1,'2026-10-22','parser')`).run();
    const checkpoint = await auditProvisionTextPage(fixture.db, fixture.bucket, { expectedRevision: 'revision:parser', mode: 'verify', pageSize: 1 });
    expect(checkpoint).toMatchObject({ complete: true, rowsVerified: 1, after: 'acts-fr-test', mutationCount: 0 });
    expect(checkpoint.bytesVerified).toBe(new TextEncoder().encode(fixture.text).byteLength);
    fixture.sqlite.prepare('UPDATE statute_sections SET text=?').run('');
    expect(await auditProvisionTextPage(fixture.db, fixture.bucket, { expectedRevision: 'revision:parser', mode: 'r2' })).toMatchObject({ complete: true, rowsVerified: 1 });
    fixture.sqlite.prepare(`UPDATE corpus_state SET parser_version='new-parser'`).run();
    await expect(auditProvisionTextPage(fixture.db, fixture.bucket, { expectedRevision: 'revision:parser', mode: 'r2', checkpoint })).rejects.toThrow('corpus changed');
  });

  it('fails a corpus-wide parity gate for an undrained outbox or incorrect published row count', async () => {
    const fixture = createTextFixture();
    await fixture.stage();
    fixture.sqlite.prepare(`INSERT INTO corpus_state(corpus_id,commit_sha,commit_date,as_of,row_count,last_run_at)
      VALUES ('statutes-canada','revision','2026-10-22','2026-10-22',2,'2026-10-22')`).run();
    await expect(auditProvisionTextPage(fixture.db, fixture.bucket, { expectedRevision: 'revision:legacy', mode: 'verify' })).rejects.toThrow('row count');
    fixture.sqlite.prepare(`INSERT INTO corpus_mutations(id,corpus_id,payload) VALUES ('pending','statutes-canada','{}')`).run();
    await expect(auditProvisionTextPage(fixture.db, fixture.bucket, { expectedRevision: 'revision:legacy', mode: 'verify' })).rejects.toThrow('drained ingestion outbox');
  });

  it('preserves exact citation and vector retrieval after D1 text is cleared', async () => {
    const fixture = createTextFixture();
    const expectedExact = await citeProvision({ act: 'Loi de test', section: '1', language: 'fr' }, fixture.ctx);
    const expectedVector = await statutesCorpus.retrieve({ topic: 'décision', language: 'fr' }, fixture.ctx);
    await fixture.stage();
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'verify');
    expect(await citeProvision({ act: 'Loi de test', section: '1', language: 'fr' }, fixture.ctx)).toEqual(expectedExact);
    fixture.sqlite.prepare('UPDATE statute_sections SET text = ? WHERE id = ?').run('', String(fixture.row['id']));
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'r2');
    expect(await citeProvision({ act: 'Loi de test', section: '1', language: 'fr' }, fixture.ctx)).toEqual(expectedExact);
    expect(await statutesCorpus.retrieve({ topic: 'décision', language: 'fr' }, fixture.ctx)).toEqual(expectedVector);
    expect(fixture.sqlite.prepare('SELECT length(text) AS size FROM statute_sections').get()?.size).toBe(0);
  });

  it('keeps a valid D1 rollback when R2 is missing or corrupt, and fails closed after text removal', async () => {
    const fixture = createTextFixture();
    const artifact = await fixture.stage();
    fixture.objects.delete(artifact.reference.objectKey);
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'prefer-r2');
    expect((await statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx))[0]?.body).toBe(fixture.text);
    fixture.sqlite.prepare('UPDATE statute_sections SET text=?').run('Corrupt retained text with an obsolete fingerprint.');
    await expect(statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx)).rejects.toBeInstanceOf(ProvisionTextError);
    fixture.sqlite.prepare('UPDATE statute_sections SET text=?').run(fixture.text);
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'verify');
    await expect(statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx)).rejects.toBeInstanceOf(ProvisionTextError);
    fixture.sqlite.prepare('UPDATE statute_sections SET text = ?').run('');
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'prefer-r2');
    await expect(statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx)).rejects.toBeInstanceOf(ProvisionTextError);
    // Restore the complete original text using a bound parameter before d1 mode.
    fixture.sqlite.prepare('UPDATE statute_sections SET text = ? WHERE text_hash = ?').run(fixture.text, String(fixture.row['text_hash']));
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'd1');
    expect((await statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx))[0]?.body).toBe(fixture.text);
  });

  it('never serves an obsolete reference after a current-row update', async () => {
    const fixture = createTextFixture();
    await fixture.stage();
    const changed = 'A newly amended rule.';
    const newHash = rowFingerprintWithText(fixture.row, changed);
    fixture.sqlite.prepare('UPDATE statute_sections SET text = ?, text_hash = ?').run(changed, newHash);
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'prefer-r2');
    expect((await statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx))[0]?.body).toBe(changed);
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'r2');
    await expect(statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx)).rejects.toBeInstanceOf(ProvisionTextError);
  });

  it('rejects a valid content object attached to the wrong row fingerprint', async () => {
    const fixture = createTextFixture();
    const wrong = await prepareProvisionText({ rowId: String(fixture.row['id']), corpusId: 'statutes-canada',
      rowFingerprint: String(fixture.row['text_hash']), text: 'A different valid object.' });
    await writeImmutableProvisionText(fixture.bucket, wrong);
    await fixture.db.prepare(UPSERT_TEXT_REFERENCE_SQL).bind(...textReferenceBindings(wrong.reference)).run();
    fixture.ctx.provisionTexts = createR2ProvisionTextStore(fixture.db, fixture.bucket, 'r2');
    await expect(statutesCorpus.retrieve({ act: 'Loi de test', section: '1' }, fixture.ctx)).rejects.toBeInstanceOf(ProvisionTextError);
  });
});
