/**
 * Writing a snapshot out, as the parts a manifest describes.
 *
 * The builder and the repackager both need to do this, and they must do it
 * **the same way** — a snapshot's parts are what its manifest claims they
 * are, and two writers that cut differently would produce snapshots that only
 * one of them could read.
 *
 * So the cutting lives in `cutRows` (in the reader's own module, where the
 * format is defined) and this only does the writing: each part is written as
 * it fills, so a three-hundred-and-sixty-megabyte rows file costs one part in
 * memory rather than all of it.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cutRows,
  DEFAULT_PART_BYTES,
  indexKey,
  manifestKey,
  partKey,
  SNAPSHOT_FORMAT,
  type SnapshotManifest,
  type SnapshotPart,
} from '../../src/ingest/snapshot-format';

/** What a written snapshot's rows came to. */
export interface WrittenRows {
  parts: SnapshotPart[];
  count: number;
  bytes: number;
}

/**
 * Write the rows as parts.
 *
 * Returns the parts as the manifest needs them: their keys and their sizes.
 * The keys are derived from the commit and the part's number, so they are
 * reproducible — the same rows always land in the same objects.
 */
export function writeParts(options: {
  out: string;
  commit: string;
  lines: Iterable<string>;
  partBytes?: number;
}): WrittenRows {
  mkdirSync(options.out, { recursive: true });
  const parts: SnapshotPart[] = [];
  let count = 0;
  let bytes = 0;

  for (const part of cutRows(options.lines, options.partBytes ?? DEFAULT_PART_BYTES)) {
    const key = partKey(options.commit, parts.length);
    const path = join(options.out, key);
    writeFileSync(path, part.lines.join(''));
    // The size on disk, not the size the lines add up to: they are the same
    // thing until they are not, and the manifest is checked against the disk.
    parts.push({ key, bytes: statSync(path).size });
    count += part.lines.length;
    bytes += part.bytes;
  }

  if (bytes !== parts.reduce((sum, part) => sum + part.bytes, 0)) {
    throw new Error('the parts do not add up to the rows — this is a bug in the writer');
  }
  return { parts, count, bytes };
}

/** Write the manifest, and return its path. */
export function writeManifest(
  out: string,
  manifest: Omit<SnapshotManifest, 'format'> & { format?: number },
): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, manifestKey(manifest.commit));
  writeFileSync(path, `${JSON.stringify({ format: SNAPSHOT_FORMAT, ...manifest }, null, 2)}\n`);
  return path;
}

/** The manifest of a snapshot whose index has already been written. */
export function manifestFor(options: {
  out: string;
  commit: string;
  date: string;
  rows: WrittenRows;
  partBytes: number;
}): SnapshotManifest {
  const indexPath = join(options.out, indexKey(options.commit));
  return {
    format: SNAPSHOT_FORMAT,
    commit: options.commit,
    date: options.date,
    rows: {
      count: options.rows.count,
      bytes: options.rows.bytes,
      partBytes: options.partBytes,
      parts: options.rows.parts,
    },
    index: {
      key: indexKey(options.commit),
      bytes: statSync(indexPath).size,
      entries: options.rows.count,
    },
  };
}
