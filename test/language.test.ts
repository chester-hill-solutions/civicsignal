import { describe, expect, it } from 'vitest';
import { detectLanguage, languageFor } from '../src/language';
import { likePatterns } from '../src/corpora/types';
import { normalizeForSearch } from '../src/text';

/**
 * Which language the caller is asking in.
 *
 * The corpus holds Canada's statutes in both official languages, and the two
 * versions of a provision are different rows with different identifiers. So
 * this decision chooses which rows are the answer, and getting it wrong hands
 * back the wrong law — in a way that looks like a good answer.
 *
 * The cases below are the ones that decide it.
 */

describe('the language of a question', () => {
  it('reads an English question as English', () => {
    expect(detectLanguage('What does section 210 of the Canada Labour Code say?')).toBe('en');
  });

  it('reads a French question as French', () => {
    expect(detectLanguage("Que dit l'article 210 du Code du travail?")).toBe('fr');
  });

  /**
   * An accented character is decisive: no English sentence has one, and a
   * French question about an English-language act still has French in it.
   */
  it('an accented character settles it', () => {
    expect(detectLanguage('Le Code du travail et la protection des travailleurs')).toBe('fr');
    expect(detectLanguage('règlement')).toBe('fr');
  });

  /**
   * The failure this guards against. "la" is inside "legal", "of" is inside
   * "offence", and a substring match makes every question about law look
   * French — or English, depending on which way the heuristic leans.
   */
  it('does not count a marker inside a longer word', () => {
    expect(detectLanguage('What legal obligations does the landlord have?')).toBe('en');
    expect(detectLanguage('The offence of driving without a licence')).toBe('en');
  });

  it('reads a French instrument title as French', () => {
    expect(detectLanguage('Code du travail')).toBe('fr');
    expect(detectLanguage('Loi sur la protection des renseignements personnels')).toBe('fr');
  });

  it('reads an English instrument title as English', () => {
    expect(detectLanguage('Canada Labour Code')).toBe('en');
    expect(detectLanguage('Privacy Act')).toBe('en');
  });

  /**
   * A person typing on a keyboard without the accent keys still writes French.
   * The markers are matched with the accents folded off, so the words still
   * count.
   */
  it('reads French written without accents as French', () => {
    expect(detectLanguage('reglement sur la protection des renseignements')).toBe('fr');
    expect(detectLanguage('Le code du travail')).toBe('fr');
  });

  it('defaults to English when there is nothing to go on', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   ')).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
    expect(detectLanguage(null)).toBe('en');
  });

  it('defaults to English on a tie', () => {
    // "section" and "code" are in both lists. English is the corpus's default,
    // so a tie keeps it.
    expect(detectLanguage('section 12 code')).toBe('en');
  });
});

describe('the language to search in', () => {
  it('an explicit request wins over what the text suggests', () => {
    expect(languageFor('fr', 'What does section 210 say?')).toBe('fr');
    expect(languageFor('en', "Que dit l'article 210?")).toBe('en');
  });

  it('accepts a full language tag', () => {
    expect(languageFor('fr-CA', 'What does section 210 say?')).toBe('fr');
    expect(languageFor('en-CA', "Que dit l'article 210?")).toBe('en');
  });

  it('falls back to the text when the request is not a language', () => {
    expect(languageFor(undefined, "Que dit l'article 210?")).toBe('fr');
    expect(languageFor('', 'What does section 210 say?')).toBe('en');
  });

  it('looks at every piece of text it is given', () => {
    // The instrument title is the strongest signal, and it is often the only
    // French thing in the question.
    expect(languageFor(undefined, 'Code du travail', 'what does it say')).toBe('fr');
  });

  it('uses the first text with a language in it', () => {
    expect(languageFor(undefined, undefined, "Que dit l'article 210?")).toBe('fr');
  });
});

/**
 * The accents, folded.
 *
 * The lexical path compares the query against the corpus's `search_text` with
 * LIKE. Both sides are folded, so "reglement" finds "règlement" — which is
 * what happens when the person typing the query has a keyboard without the
 * accent key, or copies the word from an English source.
 *
 * The vector path does not have this problem: a model reads both as the same
 * word. This is the lexical path's, and the lexical path is the fallback.
 */
describe('the text, folded for search', () => {
  it('removes the accents', () => {
    expect(normalizeForSearch('Règlement')).toBe('reglement');
    expect(normalizeForSearch('règlement')).toBe('reglement');
    expect(normalizeForSearch('Loi sur la sécurité')).toBe('loi sur la securite');
  });

  it('expands the ligature', () => {
    expect(normalizeForSearch('œuvre')).toBe('oeuvre');
    expect(normalizeForSearch('Œuvre')).toBe('oeuvre');
  });

  it('leaves the letters that have no unaccented form alone', () => {
    // Mangling these would be worse than not folding them.
    expect(normalizeForSearch('straße')).toBe('straße');
  });

  it('folds the query the same way as the corpus', () => {
    // The corpus stores "règlement" folded to "reglement", so the pattern the
    // query produces has to be folded too. Folding one side only would make
    // the two disagree in exactly the case the fold is for.
    const patterns = likePatterns({ topic: 'Règlement' });
    expect(patterns).toEqual(['%reglement%']);
  });
});
