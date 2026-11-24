import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import type { HansardLanguage } from '../corpora/hansard';
import { HANSARD_FEDERAL } from '../corpora/policies';
import { normalizeForSearch } from '../text';

export const MAX_HANSARD_XML_BYTES = 8 * 1024 * 1024;

type XmlNode = { ':@'?: Record<string, string> } & Record<string, unknown>;
type XmlNodes = XmlNode[];

const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, trimValues: false,
  parseTagValue: false, parseAttributeValue: false, htmlEntities: true,
});
const dateFormat = z.iso.date();
const months = {
  en: 'january february march april may june july august september october november december'.split(' '),
  fr: 'janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre'.split(' '),
};
const sourceNumber = /^[1-9][0-9]*$/u;

function children(node: XmlNode, tag: string): XmlNodes {
  return (node[tag] as XmlNodes | undefined) ?? [];
}

function child(nodes: XmlNodes, tag: string): XmlNodes {
  return children(nodes.find((node) => Object.hasOwn(node, tag)) ?? {}, tag);
}

function attribute(node: XmlNode, name: string): string | undefined {
  return node[':@']?.[`@_${name}`];
}

function text(nodes: XmlNodes): string {
  return nodes.map((node) => Object.entries(node).map(([tag, value]) => {
    if (tag === '#text') return String(value);
    return tag !== ':@' && Array.isArray(value) ? text(value) : '';
  }).join('')).join('');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function parseHansardSittingDate(value: string, language: HansardLanguage): string {
  const folded = normalizeForSearch(value);
  const match = language === 'en'
    ? /(?:^| )([a-z]+) (\d{1,2}), (\d{4})$/u.exec(folded)
    : /(?:^| )(\d{1,2})(?:er)? ([a-z]+) (\d{4})$/u.exec(folded);
  if (!match) throw new Error('Unrecognized Hansard sitting date.');
  const [, first, second, year] = match;
  const [monthName, day] = language === 'en' ? [first!, second!] : [second!, first!];
  const month = months[language].indexOf(monthName) + 1;
  return dateFormat.parse(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`);
}

function* interventions(nodes: XmlNodes): Generator<XmlNode> {
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === 'Intervention') yield node;
      else if (Array.isArray(value)) yield* interventions(value);
    }
  }
}

/** Normalize one House-published XML edition for the existing short-excerpt importer. */
export function parseHansardXml(xml: string) {
  if (xml.length > MAX_HANSARD_XML_BYTES || new TextEncoder().encode(xml).byteLength > MAX_HANSARD_XML_BYTES) {
    throw new Error('Hansard XML exceeds the local file limit.');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Expected well-formed Hansard XML without a document type or entity declarations.');
  }
  const roots = (parser.parse(xml) as XmlNodes).filter((node) =>
    Object.keys(node).some((key) => key !== '#text' && key !== ':@' && !key.startsWith('?')));
  const [root] = roots;
  if (roots.length !== 1 || !root || !Object.hasOwn(root, 'Hansard')) throw new Error('Expected a Hansard document.');
  const publicationId = attribute(root, 'id');
  const language = attribute(root, 'xml:lang')?.toLowerCase();
  if (!publicationId || !sourceNumber.test(publicationId) || (language !== 'en' && language !== 'fr')) {
    throw new Error('Missing or invalid Hansard publication ID or edition.');
  }
  const document = children(root, 'Hansard');
  const header = child(document, 'ExtractedInformation');
  const headerField = (name: string) => {
    const matches = header.filter((node) => attribute(node, 'Name') === name);
    if (matches.length !== 1) throw new Error(`Expected one Hansard ${name} field.`);
    return normalizeWhitespace(text(children(matches[0]!, 'ExtractedItem')));
  };
  const headerNumber = (name: string) => {
    const match = /^\D*([0-9]+)\D*$/u.exec(headerField(name));
    const number = match?.[1]?.replace(/^0+/u, '');
    if (!number) throw new Error(`Unrecognized Hansard ${name} field.`);
    return number;
  };
  const parliamentSession = `${headerNumber('Parliament')}-${headerNumber('Session')}`;
  const number = headerNumber('Number');
  const date = parseHansardSittingDate(headerField('Date'), language);
  const transcript = `https://www.ourcommons.ca/DocumentViewer/${language}/${parliamentSession}/` +
    (language === 'en' ? `house/sitting-${number}/hansard` : `chambre/seance-${number}/debats`);

  const speeches: { interventionId: string; language: HansardLanguage; speaker: string; excerpt: string; citationUrl: string }[] = [];
  const seen = new Set<string>();
  for (const node of interventions(child(document, 'HansardBody'))) {
    const interventionId = attribute(node, 'id');
    if (!interventionId || !sourceNumber.test(interventionId) || seen.has(interventionId)) {
      throw new Error('Missing, invalid, or duplicate Hansard intervention ID.');
    }
    seen.add(interventionId);
    const intervention = children(node, 'Intervention');
    const paragraphs = child(intervention, 'Content').filter((part) => Object.hasOwn(part, 'ParaText'));
    const excerpt = normalizeWhitespace(paragraphs.map((part) => text(children(part, 'ParaText'))).join(' '))
      .slice(0, HANSARD_FEDERAL.excerptMaxChars).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
    if (!excerpt) continue;
    const speaker = normalizeWhitespace(text(child(child(intervention, 'PersonSpeaking'), 'Affiliation')));
    if (!speaker) throw new Error(`Missing speaker attribution for Hansard intervention ${interventionId}.`);
    speeches.push({ interventionId, language, speaker, excerpt, citationUrl: `${transcript}#Int-${interventionId}` });
  }
  if (speeches.length === 0) throw new Error('No spoken interventions found in the Hansard edition.');
  return { publicationId, edition: language, sitting: { sittingId: `${parliamentSession}-${number}`, sittingDate: date, speeches } };
}
