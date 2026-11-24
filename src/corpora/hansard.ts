import { HANSARD_FEDERAL, HANSARD_SENATE } from './policies';

const SOURCE_ID = '[a-zA-Z0-9][a-zA-Z0-9._-]*';
export const hansardSourceIdPattern = new RegExp(`^${SOURCE_ID}$`, 'u');
export type HansardLanguage = 'en' | 'fr';
export type HansardChamber = 'house' | 'senate';

function speechIdPrefix(chamber: HansardChamber) {
  return chamber === 'house' ? 'hansard' : 'senate-hansard';
}

export function hansardSpeechIdPattern(chamber?: HansardChamber): RegExp {
  const prefix = chamber ? speechIdPrefix(chamber) : 'hansard|senate-hansard';
  return new RegExp(`^(${prefix}):(en|fr):(${SOURCE_ID}):(${SOURCE_ID})$`, 'u');
}

const speechIdPattern = hansardSpeechIdPattern();

export function hansardPolicy(chamber: HansardChamber) {
  return chamber === 'house' ? HANSARD_FEDERAL : HANSARD_SENATE;
}
export function hansardLanguagePrefix(language: HansardLanguage, chamber: HansardChamber = 'house'): string {
  return `${speechIdPrefix(chamber)}:${language}:`;
}

export function hansardSpeechId(language: HansardLanguage, sittingId: string, interventionId: string, chamber?: HansardChamber): string {
  return `${hansardLanguagePrefix(language, chamber)}${sittingId}:${interventionId}`;
}

export function hansardSpeechIdentity(id: string) {
  const match = speechIdPattern.exec(id);
  if (!match) return undefined;
  const [, prefix, language, sittingId, interventionId] = match;
  return { chamber: prefix === 'hansard' ? 'house' as const : 'senate' as const,
    language: language === 'en' ? 'en' as const : 'fr' as const, sittingId, interventionId };
}

export function hansardCitation(citation: string, chamber: HansardChamber): URL | undefined {
  if (citation !== citation.trim()) return undefined;
  try {
    const url = new URL(citation);
    if (url.username || url.password) return undefined;
    const origins = chamber === 'house'
      ? ['https://www.ourcommons.ca', 'https://ourcommons.ca']
      : ['https://sencanada.ca'];
    if (origins.includes(url.origin)) return url;
  } catch {
    return undefined;
  }
}
