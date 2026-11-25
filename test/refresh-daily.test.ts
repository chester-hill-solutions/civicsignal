import { describe, expect, it } from 'vitest';
import { verifyDailyWorkerReport } from '../scripts/lib/refresh-daily-worker';

const selected = [
  'consultations through the Worker against the acquired catalogue serves reconciled coverage, bilingual results and revisions from the acquired observation',
  'committee calls through the Worker against the acquired corpus computes dated states and follows bilingual listings to their acquired studies',
  "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'en'",
  "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'fr'",
];

function report(statuses: string[], unrelatedSkips = 0) {
  const assertionResults = selected.map((fullName, index) => ({ fullName, status: statuses[index] }));
  for (let index = 0; index < unrelatedSkips; index++) {
    assertionResults.push({ fullName: `unrelated skipped check ${index}`, status: 'skipped' });
  }
  return JSON.stringify({ success: true, testResults: [{ assertionResults }] });
}

describe('daily Worker verification', () => {
  it('requires each of the four selected checks while ignoring unrelated conditional skips', () => {
    expect(verifyDailyWorkerReport(report(['passed', 'passed', 'passed', 'passed'], 257))).toEqual({ passedTests: 4 });
  });

  it('rejects a skipped selected check even when the Vitest process succeeds', () => {
    expect(() => verifyDailyWorkerReport(report(['passed', 'passed', 'passed', 'skipped'], 257)))
      .toThrow(/Selected Worker checks did not all pass/);
  });

  it('rejects a missing or duplicate selected assertion', () => {
    const missing = JSON.stringify({ success: true, testResults: [{ assertionResults: selected.slice(0, 3).map(fullName => ({ fullName, status: 'passed' })) }] });
    expect(() => verifyDailyWorkerReport(missing)).toThrow(/missing:/);
    const duplicated = JSON.stringify({ success: true, testResults: [{ assertionResults: [...selected, selected[0]].map(fullName => ({ fullName, status: 'passed' })) }] });
    expect(() => verifyDailyWorkerReport(duplicated)).toThrow(/duplicate selected Worker check/);
  });

  it('rejects malformed reports and failed Worker assertions', () => {
    expect(() => verifyDailyWorkerReport('{not json')).toThrow(/malformed JSON/);
    expect(() => verifyDailyWorkerReport(report(['passed', 'failed', 'passed', 'passed'])))
      .toThrow(/Selected Worker checks did not all pass/);
  });
});
