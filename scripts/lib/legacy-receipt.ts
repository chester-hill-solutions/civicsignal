import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from './file-integrity';

export interface LegacyReceipt {
  format: 1;
  source: { commit: string; date: string; parser: 'legacy'; indexDigest: string; rows: number; embedded: number; placeholders: number; dimensions: number };
  files: Record<string, { bytes: number; sha256: string }>;
  verification: { allRows: true; rows: number; allVectorPositions: true; finite: true; placeholderZeros: true };
}

export function parseLegacyReceipt(value: unknown, commit: string): LegacyReceipt {
  const r = value as LegacyReceipt;
  const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  if (!r || r.format !== 1 || !r.source || r.source.commit !== commit || !/^[a-f0-9]{40}$/.test(commit) ||
      r.source.parser !== 'legacy' || !/^\d{4}-\d{2}-\d{2}$/.test(r.source.date) || !/^[a-f0-9]{32}$/.test(r.source.indexDigest) ||
      !positive(r.source.rows) || !positive(r.source.embedded) || !Number.isSafeInteger(r.source.placeholders) || r.source.placeholders < 0 ||
      r.source.embedded + r.source.placeholders !== r.source.rows || r.source.dimensions !== 768 ||
      !r.verification || r.verification.allRows !== true || r.verification.rows !== r.source.rows ||
      r.verification.allVectorPositions !== true || r.verification.finite !== true || r.verification.placeholderZeros !== true ||
      !r.files || typeof r.files !== 'object' || Array.isArray(r.files)) throw new Error('A complete pinned legacy verification receipt is required.');
  for (const [name, file] of Object.entries(r.files)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) || !file || !positive(file.bytes) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid legacy artifact receipt.');
  }
  for (const name of [`${commit}.manifest.json`, `${commit}.vectors.manifest.json`, `${commit}.index.jsonl`, `${commit}.store.emb`]) {
    if (!r.files[name]) throw new Error('The legacy receipt lacks a required source artifact.');
  }
  return r;
}

export async function verifyLegacyReceipt(directory: string, receiptPath: string, commit: string) {
  if ((await stat(receiptPath)).size > 64 * 1024) throw new Error('The legacy receipt exceeds its size bound.');
  const receipt = parseLegacyReceipt(JSON.parse(await readFile(receiptPath, 'utf8')), commit);
  for (const [name, file] of Object.entries(receipt.files)) {
    const path = join(directory, name);
    if ((await stat(path)).size !== file.bytes || await sha256File(path) !== file.sha256) throw new Error(`Legacy artifact digest mismatch: ${name}.`);
  }
  return receipt;
}
