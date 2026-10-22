/**
 * The retrieval evaluation set.
 *
 * Every question has one gold answer: an Act and a section, both of which are
 * verifiable against the ingested corpus. The runner checks each label resolves to
 * exactly one row before scoring anything, so a mis-specified question is reported
 * rather than quietly counted as a miss.
 *
 * The set is deliberately split in two:
 *
 * - `exact` questions name the statute or the situation in the words the statute
 *   uses. A keyword search should win these, and the baseline is expected to.
 * - `concept` questions describe a circumstance in ordinary language, with none of
 *   the statutory vocabulary. Only a semantic arm can find these.
 *
 * If the hybrid does not beat the keyword baseline on the concept half while
 * matching it on the exact half, the vector index is not worth its running cost.
 */

export type QuestionStyle = 'exact' | 'concept';

export interface EvalQuestion {
  id: string;
  question: string;
  /** The Act the answer lives in. */
  act: string;
  /** The section label within that Act. */
  section: string;
  style: QuestionStyle;
  /** A short note on what the question is testing. */
  note: string;
}

export const QUESTIONS: EvalQuestion[] = [
  // ── exact: the question uses the statute's own words ──────────────────────
  {
    id: 'exact-cea-ordinary-residence',
    question: 'Under the Canada Elections Act, what is the place of ordinary residence?',
    act: 'Canada Elections Act',
    section: '8',
    style: 'exact',
    note: 'The heading is the phrase in the question.',
  },
  {
    id: 'exact-cea-ordinary-residence-interpretation',
    question:
      'Under the Canada Elections Act, if the rules in section 8 are not enough to determine a place of ordinary residence, how is it determined?',
    act: 'Canada Elections Act',
    section: '9',
    style: 'exact',
    note: 'A cross-reference question: the answer text names section 8.',
  },
  {
    id: 'exact-cea-returning-officers',
    question: 'Under the Canada Elections Act, who appoints the returning officer for each electoral district?',
    act: 'Canada Elections Act',
    section: '24',
    style: 'exact',
    note: 'The heading is "Appointment of returning officers".',
  },
  {
    id: 'exact-cc-theft',
    question: 'In the Criminal Code, what makes an act theft?',
    act: 'Criminal Code',
    section: '322',
    style: 'exact',
    note: 'The heading is "Theft".',
  },
  {
    id: 'exact-cc-punishment-theft',
    question: 'In the Criminal Code, what is the punishment for theft?',
    act: 'Criminal Code',
    section: '334',
    style: 'exact',
    note: 'The heading is "Punishment for theft".',
  },
  {
    id: 'exact-cc-breaking-entering',
    question: 'In the Criminal Code, what is the offence of breaking and entering with intent to commit an indictable offence?',
    act: 'Criminal Code',
    section: '348',
    style: 'exact',
    note: 'The heading names the offence.',
  },
  {
    id: 'exact-cc-dwelling-house',
    question: 'In the Criminal Code, what is the offence of being unlawfully in a dwelling-house?',
    act: 'Criminal Code',
    section: '349',
    style: 'exact',
    note: 'The heading names the offence.',
  },
  {
    id: 'exact-privacy-collection',
    question: 'Under the Privacy Act, when may a government institution collect personal information?',
    act: 'Privacy Act',
    section: '4',
    style: 'exact',
    note: 'The heading is "Collection of personal information".',
  },
  {
    id: 'exact-privacy-disclosure',
    question: 'Under the Privacy Act, when may personal information under the control of a government institution be disclosed?',
    act: 'Privacy Act',
    section: '8',
    style: 'exact',
    note: 'The heading is "Disclosure of personal information".',
  },
  {
    id: 'exact-privacy-banks',
    question: 'Under the Privacy Act, what must a government institution include in personal information banks?',
    act: 'Privacy Act',
    section: '10',
    style: 'exact',
    note: 'The heading is "Personal information to be included in personal information banks".',
  },
  {
    id: 'exact-competition-prohibition-orders',
    question: 'Under the Competition Act, when may a court make a prohibition order?',
    act: 'Competition Act',
    section: '34',
    style: 'exact',
    note: 'The heading is "Prohibition orders".',
  },
  {
    id: 'exact-competition-recovery-damages',
    question: 'Under the Competition Act, how does a person who suffers loss or damage recover damages?',
    act: 'Competition Act',
    section: '36',
    style: 'exact',
    note: 'The heading is "Recovery of damages".',
  },
  {
    id: 'exact-competition-conspiracy',
    question: 'Under the Competition Act, what is the offence of conspiracies, agreements or arrangements between competitors?',
    act: 'Competition Act',
    section: '45',
    style: 'exact',
    note: 'The heading names the offence.',
  },
  {
    id: 'exact-irpa-health-grounds',
    question: 'Under the Immigration and Refugee Protection Act, on what health grounds is a foreign national inadmissible?',
    act: 'Immigration and Refugee Protection Act',
    section: '38',
    style: 'exact',
    note: 'The heading is "Health grounds".',
  },
  {
    id: 'exact-irpa-temporary-resident-permit',
    question: 'Under the Immigration and Refugee Protection Act, when may an officer issue a temporary resident permit?',
    act: 'Immigration and Refugee Protection Act',
    section: '24',
    style: 'exact',
    note: 'The heading is "Temporary resident permit".',
  },
  {
    id: 'exact-irpa-answer-truthfully',
    question: 'Under the Immigration and Refugee Protection Act, what is the obligation to answer truthfully?',
    act: 'Immigration and Refugee Protection Act',
    section: '16',
    style: 'exact',
    note: 'The heading is "Obligation — answer truthfully".',
  },
  {
    id: 'exact-clc-duty-to-bargain',
    question: 'Under the Canada Labour Code, what is the duty to bargain and not to change terms and conditions?',
    act: 'Canada Labour Code',
    section: '50',
    style: 'exact',
    note: 'The heading is the phrase in the question.',
  },
  {
    id: 'exact-clc-head-direction',
    question: 'Under the Canada Labour Code, what is a direction to terminate a contravention?',
    act: 'Canada Labour Code',
    section: '145',
    style: 'exact',
    note: 'The heading is "Direction to terminate contravention".',
  },

  // ── concept: ordinary language, none of the statutory vocabulary ─────────
  {
    id: 'concept-impaired-driving',
    question: 'I had a couple of drinks at dinner and then drove my car home. Is that an offence?',
    act: 'Criminal Code',
    section: '320.14',
    style: 'concept',
    note: 'No statutory words at all; the section is "Operation while impaired".',
  },
  {
    id: 'concept-broken-in',
    question: 'I broke into a shed behind a house intending to take a bicycle. What have I done?',
    act: 'Criminal Code',
    section: '348',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-dwelling-house',
    question: 'I was in someone else’s house without permission and they called the police. What offence am I facing?',
    act: 'Criminal Code',
    section: '349',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-stolen-property',
    question: 'I took my neighbour’s lawn mower and pretended I had bought it. What is that?',
    act: 'Criminal Code',
    section: '322',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-gov-collected-info',
    question: 'A federal department asked me for my date of birth and my old address when I applied for a service, and I never saw a form explaining why. What is the rule they should have followed?',
    act: 'Privacy Act',
    section: '4',
    style: 'concept',
    note: 'Describes collection, not "collection of personal information".',
  },
  {
    id: 'concept-gov-shared-info',
    question: 'A federal department gave my name and phone number to a private company without asking me. What was the government allowed to do?',
    act: 'Privacy Act',
    section: '8',
    style: 'concept',
    note: 'Describes disclosure, not "disclosure of personal information".',
  },
  {
    id: 'concept-gov-reused-info',
    question: 'A federal department used the address I gave for one program to mail me something about a completely different program. Is that allowed?',
    act: 'Privacy Act',
    section: '7',
    style: 'concept',
    note: 'Describes use, not "use of personal information".',
  },
  {
    id: 'concept-gov-keep-records',
    question: 'When a federal department uses my information, what record must it keep?',
    act: 'Privacy Act',
    section: '9',
    style: 'concept',
    note: 'Describes the obligation, not the heading.',
  },
  {
    id: 'concept-fix-prices',
    question: 'Two grocery stores in my town met and agreed not to undercut each other on milk. What have they done?',
    act: 'Competition Act',
    section: '45',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-court-stop-company',
    question: 'A company kept doing something that harmed other businesses, and the court ordered it to stop and to report what it had done. What powers did the court use?',
    act: 'Competition Act',
    section: '34',
    style: 'concept',
    note: 'Describes the order, not "prohibition orders".',
  },
  {
    id: 'concept-competitor-damages',
    question: 'I lost money because a business behaved unfairly and I want the court to make them pay me back. What does the Competition Act say about that?',
    act: 'Competition Act',
    section: '36',
    style: 'concept',
    note: 'Describes the remedy, not "recovery of damages".',
  },
  {
    id: 'concept-border-health',
    question: 'I was stopped at the airport because of a health condition I have. What is the rule that was applied to me?',
    act: 'Immigration and Refugee Protection Act',
    section: '38',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-immigration-lie',
    question: 'I filled in my immigration application and left out a trip abroad. What is the problem with that?',
    act: 'Immigration and Refugee Protection Act',
    section: '16',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-immigration-permit',
    question: 'I am waiting for my immigration application to be decided. What document lets me stay in Canada in the meantime?',
    act: 'Immigration and Refugee Protection Act',
    section: '24',
    style: 'concept',
    note: 'Describes the document, not "temporary resident permit".',
  },
  {
    id: 'concept-union-hours',
    question: 'My employer changed my shift and my pay without sitting down with the union first. What is the rule they broke?',
    act: 'Canada Labour Code',
    section: '50',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-labour-standards',
    question: 'A government inspector found my employer breaking a basic employment standard and told them to fix it or face consequences. What power was used?',
    act: 'Canada Labour Code',
    section: '145',
    style: 'concept',
    note: 'Describes the direction, not the heading.',
  },
  {
    id: 'concept-vote-where',
    question: 'I moved to Ottawa last year. Which riding am I entitled to vote in?',
    act: 'Canada Elections Act',
    section: '8',
    style: 'concept',
    note: 'A story, not a heading.',
  },
  {
    id: 'concept-election-officials',
    question: 'Who is responsible for deciding who runs the polls in my district?',
    act: 'Canada Elections Act',
    section: '24',
    style: 'concept',
    note: 'A story, not a heading.',
  },
];

/**
 * Questions the corpus **cannot** answer.
 *
 * Every question in `QUESTIONS` has a gold answer, so measuring a threshold
 * against that set prices only its cost: the questions it refuses that the
 * corpus could have answered. These are the other side, and they are what the
 * threshold is for.
 *
 * Three kinds, and the difference matters when reading the scores. Some are
 * not law at all, and the correct answer is the refusal. Some are law the
 * corpus does not hold, which is a matter for the web arm rather than for a
 * nearest-neighbour search. Some are adjacent but absent, where the nearest
 * provision is not the answer.
 */
export interface UnanswerableQuestion {
  id: string;
  question: string;
  /** What kind of unanswerable it is, for reading the scores. */
  why: string;
}

export const UNANSWERABLE_QUESTIONS: UnanswerableQuestion[] = [] = [
  { id: 'un-not-law-weather', question: 'What is the weather in Ottawa tomorrow?', why: 'not law at all' },
  { id: 'un-not-law-sports', question: 'Who won the 2026 World Cup?', why: 'not law at all' },
  { id: 'un-not-law-capital', question: 'What is the capital of Australia?', why: 'not law at all' },
  { id: 'un-not-law-recipe', question: 'How do I bake sourdough bread?', why: 'not law at all' },
  { id: 'un-prov-speeding', question: 'What is the fine for speeding in Ontario?', why: 'provincial, not federal' },
  { id: 'un-prov-tenancy', question: 'How much notice must a landlord in Quebec give to end a lease?', why: 'provincial, not federal' },
  { id: 'un-case-jordan', question: 'What did the Supreme Court of Canada decide in R v Jordan?', why: 'case law, not a statute' },
  { id: 'un-case-gladue', question: 'What did the Supreme Court hold in R v Gladue about sentencing?', why: 'case law, not a statute' },
  { id: 'un-benefit-ccb', question: 'How much is the Canada Child Benefit for a two-year-old in 2026?', why: 'a rate, not in a consolidation' },
  { id: 'un-rate-boc', question: 'What is the Bank of Canada interest rate today?', why: 'a rate, not in a consolidation' },
  { id: 'un-foreign-patent', question: 'What is the deadline to file a patent application in the United States?', why: 'foreign law' },
  { id: 'un-foreign-visa', question: 'How do I apply for a work visa for Australia?', why: 'foreign law' },
];

