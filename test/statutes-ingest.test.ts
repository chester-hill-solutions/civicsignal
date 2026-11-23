import { describe, expect, it, vi } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { buildRows, parseStatuteXml, statusOf as statusOfText, toInsertStatements } from '../src/ingest/statutes';

/** A trimmed excerpt of the real shape in `justicecanada/laws-lois-xml`. */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<Statute lims:pit-date="2026-06-14" in-force="yes" xml:lang="en" xmlns:lims="http://justice.gc.ca/lims">
  <Identification>
    <LongTitle>An Act to extend the present laws of Canada</LongTitle>
    <ShortTitle>Access to Information Act</ShortTitle>
    <RunningHead>Access to Information</RunningHead>
    <Chapter><ConsolidatedNumber official="yes">A-1</ConsolidatedNumber></Chapter>
  </Identification>
  <Body>
    <Heading level="1"><TitleText>Short Title</TitleText></Heading>
    <Section lims:id="177">
      <MarginalNote>Short title</MarginalNote>
      <Label>1</Label>
      <Text>This Act may be cited as the <XRefExternal reference-type="act" link="A-1">Access to Information Act</XRefExternal>.</Text>
      <HistoricalNote><HistoricalNoteSubItem>1980-81-82-83, c. 111, Sch. I</HistoricalNoteSubItem></HistoricalNote>
    </Section>
    <Heading level="1"><TitleText>Purpose of Act</TitleText></Heading>
    <Section lims:id="182">
      <MarginalNote>Purpose of Act</MarginalNote>
      <Label>2</Label>
      <Subsection lims:id="183">
        <Label>(1)</Label>
        <Text>The purpose of this Act is to enhance the accountability and transparency of federal institutions.</Text>
      </Subsection>
      <Subsection lims:id="184">
        <Label>(2)</Label>
        <Text>A second subsection of the same section.</Text>
      </Subsection>
    </Section>
    <Section lims:id="190">
      <MarginalNote>Empty section</MarginalNote>
      <Label>3</Label>
    </Section>
  </Body>
</Statute>`;

/**
 * A regulation with a schedule, in the shape the corpus really has.
 *
 * The schedule's items are `<Provision>` elements labelled "(a)" and "(b)", and a
 * regulation can have hundreds of them. They are list items, not sections, and
 * treating them as sections is what put four hundred rows with the same label and
 * the same id into the corpus.
 */
const REGULATION_WITH_SCHEDULE = `<?xml version="1.0" encoding="utf-8"?>
<Regulation lims:pit-date="2026-06-14" in-force="yes" xmlns:lims="http://justice.gc.ca/lims">
  <Identification>
    <LongTitle>Contraventions Regulations</LongTitle>
    <ShortTitle>Contraventions Regulations</ShortTitle>
  </Identification>
  <Body>
    <Section lims:id="981789">
      <Label>1</Label>
      <Text>An offence under a provision of an enactment set out in column I of the Schedules is designated as a contravention.</Text>
    </Section>
    <Schedule lims:id="981800">
      <ScheduleFormHeading lims:id="981801">
        <Label>SCHEDULE I</Label>
        <TitleText>Canada Marine Act</TitleText>
      </ScheduleFormHeading>
      <Provision lims:id="981810"><Label>(a)</Label><Text>Enter, leave or proceed within a port without a permit.</Text></Provision>
      <Provision lims:id="981811"><Label>(b)</Label><Text>Fail to follow the practices established by a port authority.</Text></Provision>
    </Schedule>
    <Schedule lims:id="981900">
      <ScheduleFormHeading lims:id="981901">
        <Label>SCHEDULE II</Label>
        <TitleText>Canada Shipping Act</TitleText>
      </ScheduleFormHeading>
      <Provision lims:id="981910"><Label>(a)</Label><Text>Proceed within a port without maintaining radio contact.</Text></Provision>
    </Schedule>
  </Body>
</Regulation>`;

describe('statute XML parsing', () => {
  it('limits DOM parsing to instrument metadata while preserving a large mixed-content body', () => {
    const text = 'An obligation with a cross-reference. '.repeat(30_000);
    const xml = FIXTURE.replace('This Act may be cited as the <XRefExternal reference-type="act" link="A-1">Access to Information Act</XRefExternal>.', text);
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    try {
      const parsed = parseStatuteXml(xml)!;
      expect(parsed.shortTitle).toBe('Access to Information Act');
      expect(parsed.units[0]?.text).toBe(text.trim());
      expect(parse).toHaveBeenCalledTimes(1);
      expect(String(parse.mock.calls[0]?.[0]).length).toBeLessThan(2_000);
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    { language: 'en' as const, title: 'Canada Health Act', enactsId: '151434', sectionId: '151510', enacts: 'NOW, THEREFORE, Her Majesty enacts as follows:', heading: 'Public administration' },
    { language: 'fr' as const, title: 'Loi canadienne sur la santé', enactsId: '147824', sectionId: '147900', enacts: 'Sa Majesté édicte :', heading: 'Gestion publique' },
  ])('keeps an unnumbered enacting clause separate from section8 in $language', ({ language, title, enactsId, sectionId, enacts, heading }) => {
    // Reduced from pinned C-6.xml: seven preamble clauses precede an unlabelled
    // Enacts/Provision. Its global ordinal used to become a second section8.
    const xml = `<Statute in-force="yes" xmlns:lims="http://justice.gc.ca/lims"><Identification>
      <ShortTitle>${title}</ShortTitle><Chapter><ConsolidatedNumber>C-6</ConsolidatedNumber></Chapter>
      </Identification><Introduction><Preamble>${Array.from({ length: 7 }, (_, at) => `<Provision><Text>Whereas ${at}.</Text></Provision>`).join('')}</Preamble>
      <Enacts><Provision lims:id="${enactsId}"><Text>${enacts}</Text></Provision></Enacts></Introduction>
      <Body><Section lims:id="${sectionId}"><MarginalNote>${heading}</MarginalNote><Label>8</Label><Text>The actual administration requirement.</Text></Section></Body></Statute>`;
    const rows = buildRows(parseStatuteXml(xml)!, { kind: 'acts', language });
    expect(rows.filter((row) => row.section === '8').map((row) => row.id)).toEqual([`acts-${language}-${sectionId}`]);
    const introductory = rows.find((row) => row.id === `acts-${language}-${enactsId}`)!;
    expect(introductory.section).toBe('Enacting clause 1');
    expect(introductory.text).toBe(enacts);
    expect(introductory.source_url).toContain(`/FullText.html#h-${enactsId}`);
  });

  it('reads the short title and the consolidated number', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.shortTitle).toBe('Access to Information Act');
    expect(parsed.citation).toBe('A-1');
    expect(parsed.inForce).toBe(true);
  });

  it('reads each section with its label, heading and text', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.units).toHaveLength(2); // the third section has no text
    expect(parsed.units[0]).toMatchObject({
      label: '1',
      marginalNote: 'Short title',
      text: 'This Act may be cited as the Access to Information Act.',
      kind: 'section',
    });
  });

  it('concatenates subsections under their own labels', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const section2 = parsed.units[1]!;
    expect(section2.label).toBe('2');
    expect(section2.text).toContain('(1) The purpose of this Act');
    expect(section2.text).toContain('(2) A second subsection');
  });

  it('excludes historical notes — they are editorial history, not the law', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.units[0]!.text).not.toContain('1980-81');
  });

  it('returns null for something that is not a statute document', () => {
    expect(parseStatuteXml('<not-a-statute/>')).toBeNull();
    expect(parseStatuteXml('not xml at all')).toBeNull();
  });
});

describe('schedules', () => {
  const parsed = parseStatuteXml(REGULATION_WITH_SCHEDULE, { citation: 'SOR-96-313' })!;

  it('does not mistake a schedule item for a section', () => {
    const sections = parsed.units.filter((u) => u.kind === 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe('1');
    // The item labels "(a)" and "(b)" must not appear as sections.
    expect(parsed.units.filter((u) => u.label === '(a)')).toHaveLength(0);
  });

  it('keeps a schedule as one unit, labelled by the schedule', () => {
    const schedules = parsed.units.filter((u) => u.kind === 'schedule');
    expect(schedules).toHaveLength(2);
    expect(schedules[0]!.label).toBe('SCHEDULE I');
    expect(schedules[1]!.label).toBe('SCHEDULE II');
  });

  it('keeps the schedule items whole, with their labels', () => {
    const schedule = parsed.units.find((u) => u.label === 'SCHEDULE I')!;
    expect(schedule.items).toHaveLength(2);
    expect(schedule.items![0]!.text).toBe('(a) Enter, leave or proceed within a port without a permit.');
  });

  it('does not fold a schedule item into the section that precedes it', () => {
    const section = parsed.units.find((u) => u.kind === 'section')!;
    expect(section.text).not.toContain('port');
  });
});

describe('statute rows', () => {
  it('builds a citable URL for each section', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows[0]?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/acts/A-1/section-1.html',
    );
    expect(rows[1]?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/acts/A-1/section-2.html',
    );
  });

  it('builds a regulation URL under the regulations path', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    expect(rows[0]?.source_url).toContain('/en/regulations/A-1/');
  });

  it('cites a lettered provision to the full text, not a section that does not exist', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    parsed.units.push({
      label: 'a',
      marginalNote: null,
      text: 'An ordered provision.',
      kind: 'provision',
      anchor: null,
    });
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    expect(rows.at(-1)?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/regulations/A-1/FullText.html',
    );
  });

  it('cites a decimal section to its own page', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    parsed.units.push({
      label: '15.1',
      marginalNote: null,
      text: 'A decimal section.',
      kind: 'section',
      anchor: null,
    });
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows.at(-1)?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/acts/A-1/section-15.1.html',
    );
  });

  it('anchors a schedule into the instrument it belongs to', () => {
    const parsed = parseStatuteXml(REGULATION_WITH_SCHEDULE, { citation: 'SOR-96-313' })!;
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    const schedule = rows.find((r) => r.schedule === 'SCHEDULE I')!;
    expect(schedule.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/regulations/SOR-96-313/FullText.html#h-981800',
    );
    expect(schedule.part).toBe(1);
    expect(schedule.section).toBe('SCHEDULE I');
  });

  it('chunks a long schedule so that no chunk is too large to embed', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      label: `(${i})`,
      text: `(${i}) ${'x'.repeat(100)}`,
    }));
    const parsed = parseStatuteXml(FIXTURE)!;
    parsed.units.push({
      label: 'SCHEDULE I',
      marginalNote: null,
      text: items.map((i) => i.text).join('\n'),
      kind: 'schedule',
      items,
      anchor: '1',
    });
    const rows = buildRows(parsed, { kind: 'acts', language: 'en', scheduleChunkChars: 8000 });
    const chunks = rows.filter((r) => r.schedule === 'SCHEDULE I');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(8000 + 200);
    }
    // Every item is still present, in order, across the chunks.
    const rejoined = chunks.map((c) => c.text).join('\n');
    expect(rejoined).toContain('(0)');
    expect(rejoined).toContain('(399)');
  });

  it('uses the French path segments', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const acts = buildRows(parsed, { kind: 'acts', language: 'fr' });
    expect(acts[0]?.source_url).toContain('/fr/lois/');
    const regs = buildRows(parsed, { kind: 'regulations', language: 'fr' });
    expect(regs[0]?.source_url).toContain('/fr/reglements/');
  });

  /**
   * There is no folded token bag any more, and this is the test that used to
   * assert one.
   *
   * `search_text` existed for the lexical `LIKE ?` path, which ran only when
   * the vector arm returned nothing — something a vector search cannot do —
   * and which measured worth one question in thirty-six. The fields it was
   * built from are the fields a caller can see, and those are what matter: the
   * act, the heading and the text all reach the row.
   */
  it('keeps the act name, the heading and the text on the row', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows[0]?.act.toLowerCase()).toContain('access to information act');
    expect(rows[0]?.heading?.toLowerCase()).toContain('short title');
    expect(rows[0]?.text.toLowerCase()).toContain('may be cited as');
  });

  it('gives each row a stable id', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    // The LIMS id is the corpus's own identifier for a provision, and it is unique
    // across all of them; the readable instrument-and-label form is not.
    expect(rows[0]?.id).toBe('acts-en-177');
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  /**
   * The id is the row's identity in the store, the vector index and the citation
   * lookup. Two rows sharing one id means the vector index points at a row the
   * store replaced — a match that resolves to the wrong provision, silently.
   */
  it('gives every row a unique id, including a schedule with many items', () => {
    const parsed = parseStatuteXml(REGULATION_WITH_SCHEDULE, { citation: 'SOR-96-313' })!;
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the instrument citation, which is what identifies it', () => {
    const parsed = parseStatuteXml(REGULATION_WITH_SCHEDULE, { citation: 'SOR-96-313' })!;
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    expect(rows.every((r) => r.citation === 'SOR-96-313')).toBe(true);
  });

  it('emits SQL that escapes quotes', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    const sql = toInsertStatements(rows).join('\n');
    expect(sql).toContain('INSERT OR REPLACE INTO statute_sections');
  });

  it('escapes an apostrophe in the provision text', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    rows[0]!.text = "The Minister's powers";
    const sql = toInsertStatements(rows).join('\n');
    expect(sql).toContain("Minister''s");
    expect(sql).not.toContain("Minister's");
  });

  it('writes every column the table has', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    const sql = toInsertStatements(rows).join('\n');
    for (const column of [
      'id',
      'corpus_id',
      'act',
      'citation',
      'section',
      'schedule',
      'part',
      'heading',
      'text',
      'source_url',
      'jurisdiction',
      'in_force',
      'language',
      'topics',
    ]) {
      expect(sql).toContain(column);
    }
    // `search_text` is no longer one of the table's columns — the migration
    // drops it — so writing it would be the load path failing on an insert.
    expect(sql).not.toContain('search_text');
  });
});

/**
 * The status of a provision, in both official languages.
 *
 * Canada's statutes are enacted in two languages with equal legal force, and
 * the corpus holds both. A rule that only reads the English markers does not
 * fail loudly on the French corpus — it labels nineteen thousand repealed
 * provisions as placeholders, and because `in_force` is derived from the same
 * call, leaves them looking like live law.
 *
 * These are the markers as they actually appear in the corpus.
 */
describe('the status of a provision', () => {
  const statusOf = (text: string) => statusOfText(text);

  it('reads an English repeal as repealed', () => {
    expect(statusOf('[Repealed, SOR/2010-20]')).toBe('repealed');
    expect(statusOf('[Repealed]')).toBe('repealed');
    expect(statusOf('[Repealed before coming into force]')).toBe('repealed');
    expect(statusOf('[Repeal]')).toBe('repealed');
  });

  it('reads a French repeal as repealed', () => {
    expect(statusOf('[Abrogé, 2001, ch. 26, art. 332]')).toBe('repealed');
    expect(statusOf('[Abrogé, DORS/2010-20]')).toBe('repealed');
    expect(statusOf('[Abrogé avant d’entrer en vigueur]')).toBe('repealed');
    expect(statusOf("[Abrogé avant d'entrer en vigueur]")).toBe('repealed');
    // The feminine and the plural forms, which the corpus actually uses.
    expect(statusOf('[Abrogée]')).toBe('repealed');
    expect(statusOf('[Abrogés]')).toBe('repealed');
    expect(statusOf('[Abrogation]')).toBe('repealed');
  });

  it('reads an editorial marker as a placeholder', () => {
    expect(statusOf('[Modification]')).toBe('placeholder');
    expect(statusOf('[Modifications]')).toBe('placeholder');
    expect(statusOf('[Amendment]')).toBe('placeholder');
    expect(statusOf('[Disposition transitoire]')).toBe('placeholder');
    expect(statusOf('[Réservé]')).toBe('placeholder');
    expect(statusOf('[L.S.]')).toBe('placeholder');
  });

  it('reads real text as in force', () => {
    expect(statusOf('(1) Every employee is entitled to leave.')).toBe('in-force');
    expect(statusOf('Attendu que le Code du travailuxe')).toBe('in-force');
  });
});
