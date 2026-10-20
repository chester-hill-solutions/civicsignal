import type { CorpusPolicy } from "@chester-hill-solutions/corpus";

/**
 * The corpus policies for this product.
 *
 * This is the single most consequential file in the repo. Every corpus is declared
 * here with the reproduction regime its source actually permits, and the boundaries
 * are enforced by `src/licensing.ts` at emission time — not by convention.
 *
 * The written analysis, with citations to the source terms, is in
 * `docs/LICENCE-REGISTER.md`. If you change a policy here, change it there too.
 */

export const STATUTES_CANADA: CorpusPolicy = {
  id: 'statutes-canada',
  title: 'Federal statutes and regulations',
  publisher: 'Government of Canada (Justice Laws Website)',
  licence: 'Open Government Licence - Canada',
  licenceUrl: 'https://open.canada.ca/en/open-government-licence-canada',
  redistribution: 'open',
  attribution:
    'Source: Justice Laws Website, Government of Canada. Reproduced under the Open Government Licence - Canada.',
  conditions: [
    'This is not an official version of the law.',
    'Exercise due diligence in ensuring the accuracy of the materials reproduced.',
  ],
  excerptMaxChars: 4000,
  allowFullText: true,
  requireSourceLink: true,
};

export const STATUTES_ONTARIO: CorpusPolicy = {
  id: 'statutes-ontario',
  title: 'Ontario statutes and regulations',
  publisher: 'Government of Ontario (e-Laws)',
  licence: 'Crown copyright — reproduction permitted',
  licenceUrl: 'https://www.ontario.ca/laws',
  redistribution: 'open',
  attribution:
    'Source: e-Laws, Government of Ontario. Unofficial version of Government of Ontario legal materials.',
  conditions: [
    'This is not an official version of the law.',
    'Acknowledge Crown copyright and the source.',
  ],
  excerptMaxChars: 4000,
  allowFullText: true,
  requireSourceLink: true,
};

export const HANSARD_FEDERAL: CorpusPolicy = {
  id: 'hansard-federal',
  title: 'House of Commons debates (Hansard), 2006–present',
  publisher: 'House of Commons of Canada',
  licence: 'Crown copyright (federal) — non-commercial reproduction with attribution',
  licenceUrl: 'https://www.canada.ca/en/transparency/terms.html',
  redistribution: 'cite-only',
  attribution:
    'Source: Debates (Hansard), House of Commons of Canada. © His Majesty the King in Right of Canada. Crown copyright.',
  conditions: [
    'Quoted as excerpts with a citation to the official text; the corpus is not republished.',
    'Excerpts are short and attributed; each links to the official Hansard record.',
  ],
  excerptMaxChars: 400,
  allowFullText: false,
  requireSourceLink: true,
};

export const HANSARD_PROVINCIAL: CorpusPolicy = {
  id: 'hansard-provincial',
  title: 'Provincial legislative debates',
  publisher: 'Various provincial legislatures',
  licence: 'Crown copyright (provincial) — non-commercial',
  licenceUrl: 'https://www.canada.ca/en/transparency/terms.html',
  redistribution: 'cite-only',
  attribution:
    'Source: Legislative debates of the originating legislature. Crown copyright; reproduced as cited excerpts.',
  conditions: [
    'Quoted as excerpts with a citation to the official text; the corpus is not republished.',
    'Credit the originating legislative assembly.',
  ],
  excerptMaxChars: 400,
  allowFullText: false,
  requireSourceLink: true,
};

export const NEWS_CANADA: CorpusPolicy = {
  id: 'news-canada',
  title: 'Canadian political news (RSS and watched sources)',
  publisher: 'Various Canadian publishers',
  licence: 'Per-source publisher terms',
  licenceUrl: 'https://www.policorner.wire/',
  redistribution: 'metadata-only',
  attribution: 'Source: the originating publisher, via the CivicSignal wire. Headlines link out.',
  conditions: [
    'Headline, outlet, timestamp and link only — article text is not redistributed.',
    'Each item links to the publisher.',
  ],
  excerptMaxChars: 0,
  allowFullText: false,
  requireSourceLink: true,
};

export const GDELT: CorpusPolicy = {
  id: 'gdelt',
  title: 'GDELT Project global press monitor',
  publisher: 'The GDELT Project',
  licence: 'GDELT Project terms — attribution required',
  licenceUrl: 'https://www.gdeltproject.org/about.html',
  redistribution: 'metadata-only',
  attribution: 'Powered by the GDELT Project. Headlines and metadata only; no article text.',
  conditions: [
    'Article text is never provided by GDELT and is never reproduced here.',
  ],
  excerptMaxChars: 0,
  allowFullText: false,
  requireSourceLink: true,
};

export const BILLS_CANADA: CorpusPolicy = {
  id: 'bills-canada',
  title: 'Federal bills and their status',
  publisher: 'Parliament of Canada',
  licence: 'Crown copyright (federal)',
  licenceUrl: 'https://www.canada.ca/en/transparency/terms.html',
  redistribution: 'metadata-only',
  attribution:
    'Source: Parliament of Canada. Bill status and identifiers are facts; bill text is not reproduced.',
  conditions: [
    'Bill status, sponsor, identifiers and dates are reported.',
    'Bill text links to the official record and is not republished.',
  ],
  excerptMaxChars: 0,
  allowFullText: false,
  requireSourceLink: true,
};

export const ELECTION_RESULTS: CorpusPolicy = {
  id: 'election-results',
  title: 'Federal and provincial election results by riding and polling division',
  publisher: 'Elections Canada; provincial election authorities',
  licence: 'Open Government Licence - Canada',
  licenceUrl: 'https://open.canada.ca/en/open-government-licence-canada',
  redistribution: 'open',
  attribution: 'Source: Elections Canada and provincial election authorities. OGL Canada.',
  conditions: [],
  excerptMaxChars: 2000,
  allowFullText: true,
  requireSourceLink: true,
};

export const CORPUS_POLICIES: CorpusPolicy[] = [
  STATUTES_CANADA,
  STATUTES_ONTARIO,
  HANSARD_FEDERAL,
  HANSARD_PROVINCIAL,
  NEWS_CANADA,
  GDELT,
  BILLS_CANADA,
  ELECTION_RESULTS,
];

export const POLICIES_BY_ID: Map<string, CorpusPolicy> = new Map(
  CORPUS_POLICIES.map((p) => [p.id, p]),
);

export function policyFor(corpusId: string): CorpusPolicy | undefined {
  return POLICIES_BY_ID.get(corpusId);
}
