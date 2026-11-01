import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRows, parseStatuteXml, type StatuteSectionRow } from '../ingest/statutes';
import type { V1Dataset } from './v1';
import { SNAPSHOT_PARSER_VERSION } from '../ingest/snapshot-format';

/** Re-read immutable upstream blobs, not a potentially modified checkout. */
export function verifyLabelSources(dataset: V1Dataset, corpusRoot: string) {
  const sources = new Map<string, { sha256: string; rows: StatuteSectionRow[] }>();
  const verified: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const question of dataset.questions.filter((q) => q.status === 'verified-source')) {
    const p = question.provenance;
    const key = `${p.revision}:${p.sourcePath}`;
    try {
      if (!/^(eng\/acts|fra\/lois)\/[a-zA-Z0-9.-]+\.xml$/.test(p.sourcePath ?? '')) throw new Error('invalid source path');
      let source = sources.get(key);
      if (!source) {
        const xml = execFileSync('git', ['-C', corpusRoot, 'show', key], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const statute = parseStatuteXml(xml);
        if (!statute) throw new Error('source did not parse as an instrument');
        source = { sha256: createHash('sha256').update(xml).digest('hex'), rows: buildRows(statute, { kind: 'acts', language: question.language }) };
        sources.set(key, source);
      }
      if (source.sha256 !== p.sourceSha256) throw new Error('source XML digest mismatch');
      const gold = source.rows.filter((row) => question.gold!.rowIds.includes(row.id));
      if (gold.length !== question.gold!.rowIds.length || gold.some((row) => row.language !== question.language || row.act !== question.gold!.act || row.section !== question.gold!.section || row.status !== 'in-force')) throw new Error('gold identifier, language, section or status mismatch');
      if (!gold.some((row) => row.text.includes(p.evidence) && createHash('sha256').update(row.text).digest('hex') === p.rowSha256)) throw new Error('parsed row evidence/digest mismatch');
      verified.push(question.id);
    } catch (error) {
      rejected.push({ id: question.id, reason: error instanceof Error ? error.message.split('\n')[0]! : 'verification failed' });
    }
  }
  return { revision: dataset.revision, parserVersion: SNAPSHOT_PARSER_VERSION, sourceBlobs: sources.size, verified, rejected };
}
