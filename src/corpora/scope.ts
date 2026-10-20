import type { Scope } from './types';

/**
 * Parsing and rendering a geography scope.
 *
 * The scope is the caller's framing of the question, and it is a single opaque
 * value in the query string so that it can be passed around, logged and cached
 * without being interpreted by a client:
 *
 *   ?scope=topic
 *   ?scope=riding:35047
 *   ?scope=jurisdiction:ON
 *   ?scope=municipality:Burlington,Ontario
 *   ?scope=region:goldenhorseshoe
 *
 * An unparseable scope is an error, not a silent fallback to "topic" — a caller who
 * asked for a riding and got a country-wide answer would not know they were wrong.
 */

export class ScopeParseError extends Error {
  constructor(readonly input: string) {
    super(`Unparseable scope "${input}". Expected one of: topic, riding:<code>, jurisdiction:<code>, municipality:<name>[,<province>], region:<name>.`);
    this.name = 'ScopeParseError';
  }
}

const TYPES = ['topic', 'riding', 'municipality', 'jurisdiction', 'region'] as const;
type ScopeType = (typeof TYPES)[number];

export function parseScope(input: string | null | undefined): Scope | undefined {
  if (input === null || input === undefined) return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  const colon = trimmed.indexOf(':');
  const type = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  const value = colon === -1 ? '' : trimmed.slice(colon + 1).trim();

  if (!TYPES.includes(type as ScopeType)) throw new ScopeParseError(input);

  switch (type as ScopeType) {
    case 'topic':
      return { type: 'topic' };
    case 'riding':
      if (!value) throw new ScopeParseError(input);
      return { type: 'riding', code: value.toUpperCase() };
    case 'jurisdiction':
      if (!value) throw new ScopeParseError(input);
      return { type: 'jurisdiction', code: value.toUpperCase() };
    case 'municipality': {
      if (!value) throw new ScopeParseError(input);
      const [name, province] = value.split(',').map((p) => p.trim());
      if (!name) throw new ScopeParseError(input);
      return province
        ? { type: 'municipality', name, province }
        : { type: 'municipality', name };
    }
    case 'region':
      if (!value) throw new ScopeParseError(input);
      return { type: 'region', name: value };
    default:
      throw new ScopeParseError(input);
  }
}

/** Render a scope back to its query-string form. */
export function renderScope(scope: Scope): string {
  switch (scope.type) {
    case 'topic':
      return 'topic';
    case 'riding':
      return `riding:${scope.code}`;
    case 'jurisdiction':
      return `jurisdiction:${scope.code}`;
    case 'municipality':
      return scope.province
        ? `municipality:${scope.name},${scope.province}`
        : `municipality:${scope.name}`;
    case 'region':
      return `region:${scope.name}`;
  }
}
