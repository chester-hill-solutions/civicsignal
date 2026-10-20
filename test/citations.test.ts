import { describe, expect, it } from 'vitest';
import { actTitles, parseCitation, resolveCitation } from '@chester-hill-solutions/corpus';

const ACTS = ['Canada Labour Code', 'Criminal Code', 'Privacy Act', 'Competition Act'];

describe('citation parsing', () => {
  it('reads a citation in the "section X of the Y Act" form', () => {
    const match = parseCitation('What does section 210 of the Canada Labour Code say?', ACTS)!;
    expect(match.citation.act).toBe('Canada Labour Code');
    expect(match.citation.section).toBe('210');
    expect(match.actConfidence).toBe('exact');
  });

  it('reads the "s. X" abbreviation', () => {
    const match = parseCitation('s. 320.14 of the Criminal Code', ACTS)!;
    expect(match.citation.act).toBe('Criminal Code');
    expect(match.citation.section).toBe('320.14');
  });

  it('reads a citation that puts the Act first', () => {
    const match = parseCitation('Canada Labour Code s. 50', ACTS)!;
    expect(match.citation.act).toBe('Canada Labour Code');
    expect(match.citation.section).toBe('50');
  });

  it('reads a bracketed subsection', () => {
    const match = parseCitation('section 49(2) of the Privacy Act', ACTS)!;
    expect(match.citation.section).toBe('49(2)');
  });

  it('returns nothing when there is no section', () => {
    expect(parseCitation('the Canada Labour Code is interesting', ACTS)).toBeNull();
  });

  it('returns nothing when there is no Act', () => {
    expect(parseCitation('section 210 of some other statute', ACTS)).toBeNull();
  });

  it('falls back to a partial Act match and marks it as such', () => {
    const match = parseCitation('what does section 8 of the Labour Code say', ACTS)!;
    expect(match.citation.act).toBe('Canada Labour Code');
    expect(match.actConfidence).toBe('partial');
  });

  it('prefers the longest Act title when several appear', () => {
    const match = parseCitation('section 2 of the Canada Labour Code and the Criminal Code', [
      'Criminal Code',
      'Canada Labour Code',
    ])!;
    expect(match.citation.act).toBe('Canada Labour Code');
  });
});

describe('citation resolution', () => {
  const rows = [
    { id: 'acts-en-rsc-210-1', act: 'Canada Labour Code', section: '210' },
    { id: 'acts-en-rsc-246-1', act: 'Canada Labour Code', section: '246' },
    { id: 'acts-en-c-46-320-14', act: 'Criminal Code', section: '320.14' },
  ];

  it('resolves an exact citation', () => {
    const match = parseCitation('section 210 of the Canada Labour Code', ACTS)!;
    const row = resolveCitation(match.citation, rows);
    expect(row?.id).toBe('acts-en-rsc-210-1');
  });

  it('resolves a decimal section', () => {
    const match = parseCitation('s. 320.14 of the Criminal Code', ACTS)!;
    expect(resolveCitation(match.citation, rows)?.id).toBe('acts-en-c-46-320-14');
  });

  it('returns nothing rather than a near miss', () => {
    const match = parseCitation('section 999 of the Canada Labour Code', ACTS)!;
    expect(resolveCitation(match.citation, rows)).toBeNull();
  });

  it('tolerates a title that is a prefix of the corpus title', () => {
    const match = parseCitation('section 210 of the Canada Labour', ACTS)!;
    expect(match.citation.act).toBe('Canada Labour Code');
  });
});

describe('act titles', () => {
  it('returns unique titles longest first', () => {
    const titles = actTitles([
      { act: 'Criminal Code' },
      { act: 'Canada Labour Code' },
      { act: 'Criminal Code' },
    ]);
    expect(titles).toEqual(['Canada Labour Code', 'Criminal Code']);
  });
});
