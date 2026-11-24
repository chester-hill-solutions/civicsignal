import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ParliamentInventory } from '../../src/corpora/parliament-catalogue';

const count = z.number().int().nonnegative();
const writtenCoverage = z.object({
  session: z.string(),
  catalogue: z.object({ complete: z.literal(true), officialReported: count }),
  editions: z.array(z.object({ language: z.enum(['en', 'fr']), acquisition: z.string(), count })),
});

export function acquiredWrittenCoverage() {
  const path = process.env.CIVICSIGNAL_WRITTEN_QUESTIONS_COVERAGE ?? 'data/corpus/written-questions/coverage.json';
  const receipt = writtenCoverage.parse(JSON.parse(readFileSync(path, 'utf8')));
  return (['en', 'fr'] as const).map(language => {
    const rows = receipt.editions.filter(row => row.language === language);
    const questions = rows.reduce((sum, row) => sum + row.count, 0);
    if (questions !== receipt.catalogue.officialReported || !questions) {
      throw new Error(`Incomplete written-question inventory for ${language} in ${path}`);
    }
    const total = (state: string) => rows.filter(row => row.acquisition === state).reduce((sum, row) => sum + row.count, 0);
    return { session: receipt.session, language, questions, complete: total('complete'), pending: total('pending'), questionGaps: total('gap') };
  });
}

export function acquiredParliamentInventory(database: string, file: string) {
  const root = process.env.CIVICSIGNAL_PARLIAMENT_ARCHIVE ?? dirname(database);
  return ParliamentInventory.parse(JSON.parse(readFileSync(join(root, file), 'utf8')));
}

export function archivedSenateVote(inventory: z.output<typeof ParliamentInventory>, language: string) {
  const editions = inventory.records.filter(record => record.language === language);
  const supplemental = editions.filter(record => record.details.kind === 'senate-roll-call' && record.details.journalIssue !== undefined);
  const vote = supplemental.find(record => record.key === 'j16-3') ?? supplemental[0] ?? editions[0];
  if (vote?.details.kind !== 'senate-roll-call') throw new Error(`Missing archived Senate roll call for ${language}`);
  const { members, journalIssue, journalVoteOrdinal } = vote.details;
  const yea = members.filter(member => member.position === 'yea');
  return {
    key: vote.key, url: vote.url, supplemental: supplemental.length, yea: yea.map(member => member.name),
    details: { memberCount: members.length, ...(journalIssue && { journalIssue, journalVoteOrdinal }),
      tally: { yeas: yea.length, nays: members.filter(member => member.position === 'nay').length,
        abstentions: members.filter(member => member.position === 'abstention').length } },
  };
}
