import type { ConsultationFacts } from './consultations';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function changedPaths(previous: unknown, next: unknown, path = ''): string[] {
  if (canonical(previous) === canonical(next)) return [];
  if (previous && next && typeof previous === 'object' && typeof next === 'object' &&
    !Array.isArray(previous) && !Array.isArray(next)) {
    const left = previous as Record<string, unknown>;
    const right = next as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .flatMap((key) => changedPaths(left[key], right[key], path ? `${path}.${key}` : key));
  }
  if (path === 'statusCode') return ['status.code'];
  if (path === 'reportAvailableOnline') return ['report.available'];
  return [path];
}

/**
 * The facts the publisher controls. State and its agreement with the raw code are
 * derived from the observation instant, so a later refresh must not record them
 * as a publisher change or move the catalogue revision.
 */
export type PublishedConsultationFacts = Omit<ConsultationFacts, 'stateAtObservation' | 'statusAgreesWithDates'>;

export function publishedFacts(facts: ConsultationFacts): PublishedConsultationFacts {
  const { stateAtObservation: _state, statusAgreesWithDates: _agrees, ...published } = facts;
  return published;
}
