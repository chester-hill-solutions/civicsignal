/**
 * The corpus's rows, as a stream.
 *
 * The instruments are parsed into rows the same way wherever they are parsed —
 * on the Railway runner and in the Worker — so the parsing lives here rather
 * than in either caller. What a caller does with the rows is its own business:
 * the runner collects them into an array, the Worker takes them as they come.
 *
 * The sharing matters for more than tidiness. The corpus is bilingual, and an
 * ingest that reads only one of its two trees is not a corpus, it is half of
 * one — which is exactly how the pipeline came to hold 138,750 provisions and
 * call the corpus current. The paths are decided here, once, and both callers
 * get both trees.
 */
import type { PipelineRow } from './pipeline';
import { FRENCH_INSTRUMENT_PATHS, INSTRUMENT_PATHS, type CorpusSource } from './source';
import { buildRows, parseStatuteXml, type ProvisionStatus } from './statutes';

/** The corpus this pipeline holds. */
export const CORPUS_ID = 'statutes-canada';

/**
 * The kind and language of an instrument, from where it sits in the corpus.
 *
 * The corpus's own layout is the only record of this: `fra/lois/` holds the
 * French statutes and `eng/reglements/` the English regulations, and nothing
 * in the document says which it is.
 */
export function classifyInstrument(path: string): {
  kind: 'acts' | 'regulations';
  language: 'en' | 'fr';
} {
  if (path.startsWith('fra/lois/')) return { kind: 'acts', language: 'fr' };
  if (path.startsWith('fra/reglements/')) return { kind: 'regulations', language: 'fr' };
  if (path.startsWith('eng/regulations/')) return { kind: 'regulations', language: 'en' };
  return { kind: 'acts', language: 'en' };
}

/**
 * The rows of one instrument file.
 *
 * The same parsing for every file, wherever the file came from: the tarball
 * of a full revision, or a single file fetched at a revision. That is what
 * makes the two comparable — the incremental cycle compares a file's rows now
 * with the same file's rows before, and a difference in the *parser* would
 * look like a change in the law.
 */
export function rowsForFile(options: {
  /** The path within the corpus, e.g. `eng/acts/C-34.xml`. */
  path: string;
  /** The file's content. */
  content: string;
  /** The date of the revision, which is what a changed row is stamped with. */
  date: string;
  corpusId?: string;
}): PipelineRow[] {
  const corpusId = options.corpusId ?? CORPUS_ID;
  const { kind, language } = classifyInstrument(options.path);
  // A regulation's citation is its file stem; a statute's is in the document.
  const stem = options.path.slice(options.path.lastIndexOf('/') + 1).replace(/\.xml$/, '');
  const parsed = parseStatuteXml(options.content, {
    citation: kind === 'regulations' ? stem : undefined,
  });
  if (!parsed) return [];
  return buildRows(parsed, { kind, language }).map((row) => ({
    id: row.id,
    corpusId,
    instrument: row.act,
    citation: row.citation,
    section: row.section,
    schedule: row.schedule,
    part: row.part,
    status: row.status as ProvisionStatus,
    heading: row.heading,
    text: row.text,
    source_url: row.source_url,
    in_force: row.in_force,
    language: row.language,
    embedText: '',
    lastChanged: options.date,
  }));
}

/**
 * The corpus's rows, one instrument at a time.
 *
 * The generator holds one instrument's rows at a time, which is what makes it
 * usable in a Worker: the corpus is 277,857 provisions and several hundred
 * megabytes of text, and the whole of it never needs to be in memory at once.
 */
export async function* instrumentRows(options: {
  source: CorpusSource;
  revision: string;
  /** The date of the revision, which is what a changed row is stamped with. */
  date: string;
  corpusId?: string;
  /** Called for each instrument file, before its rows are yielded. */
  onFile?: (path: string) => void;
}): AsyncGenerator<PipelineRow> {
  for await (const file of options.source.instruments(options.revision, [
    ...INSTRUMENT_PATHS,
    ...FRENCH_INSTRUMENT_PATHS,
  ])) {
    options.onFile?.(file.path);
    yield* rowsForFile({
      path: file.path,
      content: file.content,
      date: options.date,
      corpusId: options.corpusId,
    });
  }
}
