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
  if (path.startsWith('eng/reglements/')) return { kind: 'regulations', language: 'en' };
  return { kind: 'acts', language: 'en' };
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
  const corpusId = options.corpusId ?? CORPUS_ID;
  for await (const file of options.source.instruments(options.revision, [
    ...INSTRUMENT_PATHS,
    ...FRENCH_INSTRUMENT_PATHS,
  ])) {
    options.onFile?.(file.path);
    const { kind, language } = classifyInstrument(file.path);
    // A regulation's citation is its file stem; a statute's is in the document.
    const stem = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.xml$/, '');
    const parsed = parseStatuteXml(file.content, {
      citation: kind === 'regulations' ? stem : undefined,
    });
    if (!parsed) continue;
    for (const row of buildRows(parsed, { kind, language })) {
      yield {
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
      };
    }
  }
}
