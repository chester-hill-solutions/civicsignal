import { z } from 'zod';
import { dailyStepNames } from './refresh-reports';

type DailyStepName = typeof dailyStepNames[number];
const assertionsByStep: Record<DailyStepName, string[]> = {
  consultations: ['consultations through the Worker against the acquired catalogue serves reconciled coverage, bilingual results and revisions from the acquired observation'],
  'committee-calls': ['committee calls through the Worker against the acquired corpus computes dated states and follows bilingual listings to their acquired studies'],
  funding: [
    "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'en'",
    "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'fr'",
  ],
};

export function dailyWorkerTestFilter(steps: readonly DailyStepName[]): string {
  return steps.flatMap(step => assertionsByStep[step])
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
}

const vitestReport = z.object({
  success: z.boolean(),
  testResults: z.array(z.object({
    assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
  })),
});

export function verifyDailyWorkerReport(stdout: string, steps: readonly DailyStepName[] = dailyStepNames): {
  passedTests: number;
  passedAssertions: string[];
} {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error('Vitest returned malformed JSON');
  }
  const parsed = vitestReport.safeParse(report);
  if (!parsed.success) throw new Error('Vitest JSON report is missing valid assertion results');

  const expected = new Set(steps.flatMap(step => assertionsByStep[step]));
  const selected = new Map<string, string>();
  for (const suite of parsed.data.testResults) {
    for (const { fullName, status } of suite.assertionResults) {
      if (!expected.has(fullName)) continue;
      if (selected.has(fullName)) throw new Error(`Vitest reported duplicate selected Worker check: ${fullName}`);
      selected.set(fullName, status);
    }
  }
  const missing = [...expected].filter(name => !selected.has(name));
  if (missing.length) throw new Error(`Expected ${expected.size} selected Worker checks; missing: ${missing.join('; ')}`);
  const unsuccessful = [...expected].filter(name => selected.get(name) !== 'passed');
  if (!parsed.data.success || unsuccessful.length) {
    throw new Error(`Selected Worker checks did not all pass: ${unsuccessful.map(name => `${name} (${selected.get(name)})`).join('; ') || 'Vitest reported failure'}`);
  }
  return { passedTests: selected.size, passedAssertions: [...selected.keys()] };
}
