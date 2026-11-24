import { z } from 'zod';
import { normalizeForSearch } from '../text';

export type SearchLanguage = 'en' | 'fr';
export const LEXICAL_PREFIX = 'hybrid-lexical-v1';
export const SEARCH_DEPTH = 20;

const languages = z.enum(['en', 'fr']);
const instruments = z.array(z.object({ title: z.string(), citation: z.string(), language: languages,
  offset: z.number().int().nonnegative(), length: z.number().int().positive().max(2 * 1024 * 1024) }));
const catalogSchema = z.object({ revision: z.string(), instruments: instruments.max(6000),
  labourParts: z.record(z.string(), z.string()) });
const documents = z.array(z.object({ id: z.string(), heading: z.string(), lead: z.string() })).max(5000);
type Instrument = z.infer<typeof instruments>[number];

function words(value: string): string[] {
  return normalizeForSearch(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function titlePhrase(value: string): string {
  return ` ${words(value).join(' ')} `;
}

const STOP = {
  en: new Set('a an the about after again all am and any are as at be been before both but by can could did do does each for from gave give had has have how i in into is it its may me might must or of on only our out over s shall should so some than that their them then there these they this those to too under up us was were what when where which who why will with would you your'.split(' ')),
  fr: new Set('a ai an au aux avec avoir c ce ces cet cette d dans de des doit du elle elles en est et eux il ils j l la le les leur leurs lui mais me moi mon ne nos notre nous on ou par pas plus pour qu que quel quelle quelles quels s sa selon ses si son sont sur t ta te tes toi ton tu un une vous vos votre y'.split(' ')),
};
const SUFFIXES = {
  en: ['ments', 'ment', 'ations', 'ation', 'ingly', 'edly', 'ing', 'ed', 'es', 's', 'e'],
  fr: ['issements', 'issement', 'ations', 'ation', 'ements', 'ement', 'euses', 'euse', 'iques', 'ique', 'ees', 'ee', 'ait', 'ent', 'er', 'es', 'e', 's', 'x'],
};

function terms(value: string, language: SearchLanguage): string[] {
  return words(value).filter((word) => word.length > 1 && !STOP[language].has(word)).map((word) => {
    if (language === 'en' && word.length >= 6 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    const suffix = SUFFIXES[language].find((ending) => word.length - ending.length >= 4 && word.endsWith(ending));
    return suffix ? word.slice(0, -suffix.length) : word;
  });
}

function queryTerms(question: string, title: string, language: SearchLanguage): string[] {
  return [...new Set(terms(titlePhrase(question.split('?', 1)[0]!).replace(titlePhrase(title), ' '), language))].slice(0, 20);
}

export async function readLexicalCatalog(bucket: R2Bucket, revision: string) {
  if (!/^[a-f0-9]{40}:[a-z0-9-]+$/u.test(revision)) throw new Error('Hybrid search requires a verified corpus revision.');
  const prefix = `${LEXICAL_PREFIX}/${revision.replace(':', '/')}`;
  const object = await bucket.get(`${prefix}/catalog.json`);
  if (!object || object.size > 2 * 1024 * 1024) throw new Error('The scoped search catalog is unavailable.');
  const catalog = catalogSchema.parse(await object.json());
  if (catalog.revision !== revision) throw new Error('The scoped search catalog revision differs.');
  return { ...catalog, dataKey: `${prefix}/provisions.jsonl` };
}

export function resolveInstruments(inventory: Instrument[], language: SearchLanguage, question: string, inferred?: string) {
  const query = titlePhrase(question);
  const available = inventory.filter((item) => item.language === language);
  const hits = available.filter((item) => query.includes(titlePhrase(item.title)) && words(item.title).length >= 2);
  const named = hits.filter((item) => !hits.some((other) => other.title !== item.title &&
    titlePhrase(other.title).includes(titlePhrase(item.title))));
  const proposed = inferred ? available.filter((item) => titlePhrase(item.title) === titlePhrase(inferred)) : [];
  return { named: named.length === 1 ? named[0] : undefined,
    scope: named.length === 1 ? named[0] : named.length === 0 && proposed.length === 1 ? proposed[0] : undefined };
}

export function fuseRankings(...lists: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const ids of lists) ids.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (21 + index)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export async function searchScoped(bucket: R2Bucket, dataKey: string, instrument: Instrument, question: string, phrase?: string) {
  const object = await bucket.get(dataKey, { range: { offset: instrument.offset, length: instrument.length } });
  const range = object?.range;
  if (!object || !range || !('offset' in range) || range.offset !== instrument.offset ||
      !('length' in range) || range.length !== instrument.length) {
    throw new Error('The scoped search index range is unavailable.');
  }
  const payload = await object.arrayBuffer();
  if (payload.byteLength !== instrument.length) throw new Error('The scoped search index range is incomplete.');
  const language = instrument.language;
  const entries = documents.parse(JSON.parse(new TextDecoder().decode(payload)));
  if (!entries.length) return { ids: [], heading: undefined };
  const docs = entries.map(({ id, lead, heading }) => ({ id, heading: terms(heading, language), lead: terms(lead, language) }));
  const total = docs.length;
  const avgLength = Math.max(1, docs.reduce((sum, row) => sum + row.lead.length + row.heading.length, 0) / total);
  const search = (keys: string[]) => {
    const counts = docs.map((row) => keys.map((key) => row.heading.filter((word) => word === key).length * 2
      + row.lead.filter((word) => word === key).length));
    const weights = keys.map((_, index) => {
      const frequency = counts.filter((row) => row[index]! > 0).length;
      return Math.max(1e-6, Math.log((total - frequency + 0.5) / (frequency + 0.5)));
    });
    return docs.map((row, at) => ({ id: row.id, score: counts[at]!.reduce((score, count, index) => score +
      weights[index]! * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * (row.lead.length + row.heading.length) / avgLength)), 0) }))
      .filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, SEARCH_DEPTH).map((row) => row.id);
  };
  const literal = queryTerms(question, instrument.title, language);
  const short = phrase ? queryTerms(phrase, instrument.title, language) : [];
  const useShort = short.length > 0 && (short.length !== literal.length || short.some((term) => !literal.includes(term)));
  const primary = search(literal);
  if (!useShort) return { ids: primary, heading: undefined };
  const ids = fuseRankings(primary, search(short));
  const headings = short.length >= 2 ? docs.filter((row) => row.heading.join(' ') === short.join(' ')) : [];
  const heading = headings.length === 1 && ids.includes(headings[0]!.id) ? headings[0]!.id : undefined;
  return { ids: (heading ? [heading, ...ids.filter((id) => id !== heading)] : ids).slice(0, SEARCH_DEPTH), heading };
}
