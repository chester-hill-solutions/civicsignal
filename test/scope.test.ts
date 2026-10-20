import { describe, expect, it } from 'vitest';
import { parseScope, renderScope, ScopeParseError } from '../src/corpora/scope';
import { jurisdictionOf, ridingOf } from '../src/routes/brief';

describe('scope parsing', () => {
  it('parses each scope type', () => {
    expect(parseScope('topic')).toEqual({ type: 'topic' });
    expect(parseScope('riding:35047')).toEqual({ type: 'riding', code: '35047' });
    expect(parseScope('jurisdiction:on')).toEqual({ type: 'jurisdiction', code: 'ON' });
    expect(parseScope('municipality:Burlington,Ontario')).toEqual({
      type: 'municipality',
      name: 'Burlington',
      province: 'Ontario',
    });
    expect(parseScope('municipality:Burlington')).toEqual({ type: 'municipality', name: 'Burlington' });
    expect(parseScope('region:golden')).toEqual({ type: 'region', name: 'golden' });
  });

  it('treats an absent scope as absent rather than as a topic', () => {
    expect(parseScope(null)).toBeUndefined();
    expect(parseScope(undefined)).toBeUndefined();
    expect(parseScope('  ')).toBeUndefined();
  });

  it('refuses to guess: an unknown type or a missing value is an error', () => {
    expect(() => parseScope('county:123')).toThrow(ScopeParseError);
    expect(() => parseScope('riding:')).toThrow(ScopeParseError);
    expect(() => parseScope('jurisdiction')).toThrow(ScopeParseError);
  });

  it('round-trips', () => {
    for (const raw of [
      'topic',
      'riding:35047',
      'jurisdiction:ON',
      'municipality:Burlington,Ontario',
      'region:golden',
    ]) {
      expect(renderScope(parseScope(raw)!)).toBe(raw);
    }
  });
});

describe('scope filters', () => {
  it('derives a province filter from a jurisdiction or municipality scope', () => {
    expect(jurisdictionOf({ type: 'jurisdiction', code: 'ON' })).toBe('ON');
    expect(jurisdictionOf({ type: 'municipality', name: 'Burlington', province: 'Ontario' })).toBe('ONTARIO');
    expect(jurisdictionOf({ type: 'topic' })).toBeUndefined();
  });

  it('derives a riding filter only from a riding scope', () => {
    expect(ridingOf({ type: 'riding', code: '35047' })).toBe('35047');
    expect(ridingOf({ type: 'jurisdiction', code: 'ON' })).toBeUndefined();
  });

  it('does not invent a province from a riding code', () => {
    // A riding code's first two digits are the province, but the caller's own
    // jurisdiction parameter is the authority; guessing here would silently
    // mis-scope a brief.
    expect(jurisdictionOf({ type: 'riding', code: '35047' })).toBeUndefined();
  });
});
