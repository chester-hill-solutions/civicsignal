import { describe, expect, it } from 'vitest';
import { buildRows, parseStatuteXml, toInsertStatements } from '../src/ingest/statutes';

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

describe('statute XML parsing', () => {
  it('reads the short title and the consolidated number', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.shortTitle).toBe('Access to Information Act');
    expect(parsed.citation).toBe('A-1');
    expect(parsed.inForce).toBe(true);
  });

  it('reads each section with its label, heading and text', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.sections).toHaveLength(2); // the third section has no text
    expect(parsed.sections[0]).toEqual({
      label: '1',
      marginalNote: 'Short title',
      text: 'This Act may be cited as the Access to Information Act.',
    });
  });

  it('concatenates subsections under their own labels', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const section2 = parsed.sections[1]!;
    expect(section2.label).toBe('2');
    expect(section2.text).toContain('(1) The purpose of this Act');
    expect(section2.text).toContain('(2) A second subsection');
  });

  it('excludes historical notes — they are editorial history, not the law', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    expect(parsed.sections[0]!.text).not.toContain('1980-81');
  });

  it('returns null for something that is not a statute document', () => {
    expect(parseStatuteXml('<not-a-statute/>')).toBeNull();
    expect(parseStatuteXml('not xml at all')).toBeNull();
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

  it('cites a lettered provision to the instrument page, not a section that does not exist', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    parsed.sections.push({ label: 'a', marginalNote: null, text: 'An ordered provision.' });
    const rows = buildRows(parsed, { kind: 'regulations', language: 'en' });
    expect(rows.at(-1)?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/regulations/A-1/index.html',
    );
  });

  it('cites a decimal section to its own page', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    parsed.sections.push({ label: '15.1', marginalNote: null, text: 'A decimal section.' });
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows.at(-1)?.source_url).toBe(
      'https://laws-lois.justice.gc.ca/en/acts/A-1/section-15.1.html',
    );
  });

  it('uses the French path segments', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const acts = buildRows(parsed, { kind: 'acts', language: 'fr' });
    expect(acts[0]?.source_url).toContain('/fr/lois/');
    const regs = buildRows(parsed, { kind: 'regulations', language: 'fr' });
    expect(regs[0]?.source_url).toContain('/fr/reglements/');
  });

  it('indexes the act name, heading and text together', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows[0]?.search_text).toContain('access to information act');
    expect(rows[0]?.search_text).toContain('short title');
    expect(rows[0]?.search_text).toContain('may be cited as');
  });

  it('gives each row a stable id', () => {
    const parsed = parseStatuteXml(FIXTURE)!;
    const rows = buildRows(parsed, { kind: 'acts', language: 'en' });
    expect(rows[0]?.id).toBe('acts-en-a-1-1');
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
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
});
