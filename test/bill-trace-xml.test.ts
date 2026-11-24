import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('projects official XML fields and refuses a duplicate voter even when the totals still agree', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bill-xml-'));
  const bill = join(temp, 'bill.xml'), votes = join(temp, 'vote.xml'), out = join(temp, 'source');
  const time = '2023-05-30T15:25:26';
  const person = (id: number) => `<VoteParticipant><ParliamentNumber>44</ParliamentNumber><SessionNumber>1</SessionNumber>
    <DecisionDivisionNumber>338</DecisionDivisionNumber><DecisionResultName>Agreed To</DecisionResultName>
    <DecisionEventDateTime>${time}</DecisionEventDateTime><PersonId>${id}</PersonId><IsVoteYea>true</IsVoteYea></VoteParticipant>`;
  const run = () => execFileSync('python3', ['scripts/verify-bill-trace.py', bill, votes, '--project', out], { stdio: 'pipe' });
  try {
    writeFileSync(bill, `<Bills><Bill><Id>11558854</Id><NumberCode>S-5</NumberCode><ParliamentNumber>44</ParliamentNumber>
      <SessionNumber>1</SessionNumber><PassedHouseThirdReadingDateTime>${time}</PassedHouseThirdReadingDateTime>
      <Publications><PublicationId>11558861</PublicationId><PublicationTypeId>80701</PublicationTypeId>
      <PublicationTypeNameEn>First Reading</PublicationTypeNameEn><PublicationTypeNameFr>Première lecture</PublicationTypeNameFr></Publications>
      <BillStages><SenateBillStages><BillStageId>60030</BillStageId><ChamberOrganizationId>2</ChamberOrganizationId>
      <SignificantEvents><EventTypeId>60123</EventTypeId><EventNameEn>Referral to committee</EventNameEn>
      <EventNameFr>Renvoi en comité</EventNameFr><EventDateTime>2022-04-07T16:18:00</EventDateTime></SignificantEvents></SenateBillStages>
      <InterChamberMessages><MeetingNumber>133</MeetingNumber><Date>2023-06-13T17:30:00</Date><ChamberOrganizationId>2</ChamberOrganizationId>
      <EventNameEn>Concurrence</EventNameEn><EventNameFr>Adoption</EventNameFr></InterChamberMessages></BillStages>
      <HouseVoteDetails><DivisionNumber>338</DivisionNumber><DivisionSubjectEn>S-5 third reading</DivisionSubjectEn>
      <DivisionSubjectFr>S-5 troisième lecture</DivisionSubjectFr><DecisionResultNameEn>Agreed To</DecisionResultNameEn>
      <DivisionVotesYeas>2</DivisionVotesYeas><DivisionVotesNays>0</DivisionVotesNays><DivisionVotePaired>0</DivisionVotePaired></HouseVoteDetails>
      </Bill></Bills>`);
    writeFileSync(votes, '<ArrayOfVoteParticipant>' + person(1) + person(1) + '</ArrayOfVoteParticipant>');
    expect(run).toThrow('Duplicate or missing participant ID');
    writeFileSync(votes, '<ArrayOfVoteParticipant>' + person(1) + person(2) + '</ArrayOfVoteParticipant>');
    run();
    expect(JSON.parse(readFileSync(join(out, 'legisinfo.json'), 'utf8'))).toMatchObject({
      stages: [{ BillStageId: '60030', EventTypeId: '60123', EventDateTime: '2022-04-07T16:18:00' }],
      publications: [{ PublicationId: '11558861' }],
    });
    expect(JSON.parse(readFileSync(join(out, 'vote.json'), 'utf8'))).toMatchObject({ counts: { yeas: 2, paired: 0, nays: 0 } });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
