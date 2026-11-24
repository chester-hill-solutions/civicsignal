import { describe, expect, it } from 'vitest';
import { sha256Hex, Sha256 } from '../src/geds/hash';
import { fold, normalizeRow, parseOrganizationPath, stableId } from '../src/geds/normalize';
import { rowsFromString } from '../src/geds/csv';
import { fixtureBytes, required } from './helpers/geds';
import { decodeLatin1 } from '../src/geds/csv';

const source = {
  datasetId: '8ec4a9df-b76b-4a67-8f93-cdbc2e040098',
  sourceUrl: 'https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip',
  observedAt: '2026-01-01T00:00:00.000Z',
  sourceDate: '2026-01-01T00:00:00.000Z',
  originalFormat: 'csv' as const,
};

describe('GEDS identifiers and normalisation', () => {
  it('hashes the standard SHA-256 vectors, incrementally', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const h = new Sha256();
    h.update(new TextEncoder().encode('a'));
    h.update(new TextEncoder().encode('bc'));
    expect(h.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('folds accents for search but keeps the published value', () => {
    expect(fold('Direction générale de la gestion intégrée')).toBe(
      'direction generale de la gestion integree',
    );
    expect(fold('  Lagacé  ')).toBe('lagace');
    expect(fold('C-34')).toBe('c 34');
  });

  it('makes the same id from the same identity and different ids from different identities', () => {
    expect(stableId('org', 'A|B')).toBe(stableId('org', 'A|B'));
    expect(stableId('org', 'A|B')).not.toBe(stableId('org', 'A|C'));
    expect(stableId('org', 'A|B').startsWith('org_')).toBe(true);
  });

  it('parses the bilingual path even when a display name contains a colon', () => {
    const text = decodeLatin1(fixtureBytes('snapshot-a.csv'));
    const row = required(rowsFromString(text)[0]).row;
    row['Organization Structure (EN)'] =
      'Canada (O=GC,C=CA):Example Department (OU=EX-EX,O=GC,C=ca):Environmental Testing Laboratories: Central Division (OU=ETLCD-LAEDC,OU=EX-EX,O=GC,C=ca)';
    row['Organization Structure (FR)'] =
      'Canada (O=GC,C=CA):Ministère des exemples (OU=EX-EX,O=GC,C=ca):Laboratoires d’analyses environnementales : division centrale (OU=ETLCD-LAEDC,OU=EX-EX,O=GC,C=ca)';
    const parsed = parseOrganizationPath(row, 'snap_x', source);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.leaf.nameEn).toContain('Central Division');
    expect(parsed.leaf.nameFr).toContain('division centrale');
  });

  it('keeps same-name people apart when their published contact differs', () => {
    const text = decodeLatin1(fixtureBytes('snapshot-a.csv'));
    const rows = rowsFromString(text).map(({ row }, i) => normalizeRow(row, i + 1, 'snap_x', source));
    const smiths = rows.filter((r) => r.fullName === 'Alex Smith');
    expect(smiths).toHaveLength(2);
    expect(required(smiths[0]).personId).not.toBe(required(smiths[1]).personId);
    expect(required(smiths[0]).roleId).not.toBe(required(smiths[1]).roleId);
  });

  it('labels a blank-name listing as a general office contact', () => {
    const text = decodeLatin1(fixtureBytes('snapshot-a.csv'));
    const rows = rowsFromString(text).map(({ row }, i) => normalizeRow(row, i + 1, 'snap_x', source));
    const office = required(rows.find((r) => r.telephone === '613-555-0100'));
    expect(office.isGeneralOffice).toBe(true);
    const contact = required(office.contacts.find((c) => c.kind === 'telephone'));
    expect(contact.isGeneralOffice).toBe(true);
    expect(contact.citation.text).toContain('General office');
    expect(contact.citation.snapshotId).toBe('snap_x');
  });

  it('decodes Latin-1 accents as the publisher wrote them', () => {
    expect(decodeLatin1(new Uint8Array([0x4c, 0x61, 0x67, 0x61, 0x63, 0xe9]))).toBe('Lagacé');
  });
});
