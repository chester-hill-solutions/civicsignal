import { expect, it } from 'vitest';
import { csvRows } from '../src/geds/csv';

it('keeps escaped quotes, Latin-1, quoted newlines and CRLF across byte boundaries', async () => {
  const csv = 'Name,Title\r\n"André ""A""","Line 1\r\nLine 2"\r\n';
  async function* bytes() { for (const char of csv) yield Uint8Array.of(char.charCodeAt(0)); }
  const rows = [];
  for await (const row of csvRows(bytes())) rows.push(row);
  expect(rows).toEqual([['Name', 'Title'], ['André "A"', 'Line 1\r\nLine 2']]);
});

it('keeps an unescaped publisher quote inside a quoted field instead of splitting the row', async () => {
  // The October 25, 2026 export contains records like this one, where the
  // organization name and structure repeat a quote that the publisher did not
  // double. A strict reader ends the field early and turns the structure's
  // commas into extra columns.
  const csv = 'Name,Structure\r\n"Guo","Canada (O=GC,C=CA):SERVICES D"IDENTITÉ NUMÉrique (ou=POR-EQU,ou=POR-SER,c=ca)"\r\n';
  async function* bytes() { for (const char of csv) yield Uint8Array.of(char.charCodeAt(0)); }
  const rows = [];
  for await (const row of csvRows(bytes())) rows.push(row);
  expect(rows).toEqual([
    ['Name', 'Structure'],
    ['Guo', 'Canada (O=GC,C=CA):SERVICES D"IDENTITÉ NUMÉrique (ou=POR-EQU,ou=POR-SER,c=ca)'],
  ]);
});

it('verifies the declared CSV size and CRC before the ZIP stream completes', async () => {
  const { openFirstZipEntry } = await import('../src/geds/zip');
  const { crc32 } = await import('node:zlib');
  const csv = new TextEncoder().encode('a,b');
  const zip = new Uint8Array(30 + csv.length);
  const header = new DataView(zip.buffer);
  header.setUint32(0, 0x04034b50, true);
  header.setUint32(14, crc32(csv), true);
  header.setUint32(18, csv.length, true);
  header.setUint32(22, csv.length, true);
  zip.set(csv, 30);
  const read = () => new Response(openFirstZipEntry(zip)).text();
  expect(await read()).toBe('a,b');
  zip[31] = 42;
  await expect(read()).rejects.toThrow(/CRC mismatch/);
  header.setUint32(22, 8, true);
  await expect(read()).rejects.toThrow(/size or CRC mismatch/);
});
