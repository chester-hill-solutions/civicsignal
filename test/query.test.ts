import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/routes/query';

/**
 * The language lens, as a request parameter.
 *
 * The corpus holds Canada's statutes in both official languages, and the two
 * versions of a provision are **separate rows with separate identifiers**. So
 * the language is not a detail of a result: it decides which law the answer is.
 *
 * The lens has two halves, and both matter:
 *
 * - **A caller that names a language gets it.** A question in English about the
 *   French Labour Code is a question about French law.
 * - **A caller that does not gets the one their question is in.** The corpus
 *   package deliberately leaves this to the surfaces, because the corpus cannot
 *   see the question — only the surface can.
 */
describe('the language a request asks for', () => {
  const url = (query: string) => new URL(`https://example.test/api/brief?${query}`);

  it('reads the language the caller named', () => {
    expect(parseQuery(url('topic=leave&language=fr')).language).toBe('fr');
    expect(parseQuery(url('topic=congés&language=en')).language).toBe('en');
  });

  it('accepts a full language tag', () => {
    expect(parseQuery(url('topic=leave&language=fr-CA')).language).toBe('fr');
  });

  it('infers the language from an English question', () => {
    expect(parseQuery(url('topic=employment%20standards')).language).toBe('en');
  });

  it('infers the language from a French question', () => {
    expect(parseQuery(url('topic=conditions%20de%20travail')).language).toBe('fr');
  });

  it('reads the keywords too, not only the topic', () => {
    expect(parseQuery(url('keyword=r%C3%A8glement&keyword=cong%C3%A9s')).language).toBe('fr');
  });

  it('defaults to English when there is nothing to go on', () => {
    expect(parseQuery(url('')).language).toBe('en');
  });

  it('still parses the rest of the query', () => {
    const query = parseQuery(url('topic=leave&jurisdiction=ON&limit=5&since=2020-01-01'));
    expect(query.topic).toBe('leave');
    expect(query.jurisdiction).toBe('ON');
    expect(query.limit).toBe(5);
    expect(query.since).toBe('2020-01-01');
  });
  it('accepts exact citations and applies their language', () => {
    expect(parseQuery(url('act=Code+du+travail&section=210'))).toMatchObject({ act: 'Code du travail', section: '210', language: 'fr' });
  });
  it.each(['limit=NaN', 'limit=1.5', 'limit=0', 'limit=51', 'language=de', 'act=Test', 'topic=a&topic=b', 'unknown=value'])
  ('refuses malformed or ambiguous query %s', (input) => {
    expect(() => parseQuery(url(input))).toThrow();
  });
});
