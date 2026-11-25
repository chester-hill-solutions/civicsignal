const DAILY_WORKER_ASSERTIONS = [
  'consultations through the Worker against the acquired catalogue serves reconciled coverage, bilingual results and revisions from the acquired observation',
  'committee calls through the Worker against the acquired corpus computes dated states and follows bilingual listings to their acquired studies',
  "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'en'",
  "Polytechnics Canada funding recommendations against the acquired catalogues follows both recommendations to the brief and related published terms in 'fr'",
] as const;

export function verifyDailyWorkerReport(stdout: string): { passedTests: number } {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error('Vitest returned malformed JSON');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)
      || typeof (report as { success?: unknown }).success !== 'boolean'
      || !Array.isArray((report as { testResults?: unknown }).testResults)) {
    throw new Error('Vitest JSON report is missing success or test results');
  }
  const selected = new Map<string, string>();
  for (const file of (report as { testResults: unknown[] }).testResults) {
    if (!file || typeof file !== 'object' || !Array.isArray((file as { assertionResults?: unknown }).assertionResults)) continue;
    for (const assertion of (file as { assertionResults: unknown[] }).assertionResults) {
      if (!assertion || typeof assertion !== 'object') continue;
      const row = assertion as { fullName?: unknown; status?: unknown };
      if (typeof row.fullName === 'string' && DAILY_WORKER_ASSERTIONS.includes(row.fullName as typeof DAILY_WORKER_ASSERTIONS[number])) {
        if (selected.has(row.fullName)) throw new Error(`Vitest reported duplicate selected Worker check: ${row.fullName}`);
        selected.set(row.fullName, typeof row.status === 'string' ? row.status : 'malformed');
      }
    }
  }
  const missing = DAILY_WORKER_ASSERTIONS.filter(name => !selected.has(name));
  if (missing.length) throw new Error(`Expected four selected Worker checks; missing: ${missing.join('; ')}`);
  const unsuccessful = DAILY_WORKER_ASSERTIONS.filter(name => selected.get(name) !== 'passed');
  if ((report as { success: boolean }).success !== true || unsuccessful.length) {
    throw new Error(`Selected Worker checks did not all pass: ${unsuccessful.map(name => `${name} (${selected.get(name)})`).join('; ') || 'Vitest reported failure'}`);
  }
  return { passedTests: DAILY_WORKER_ASSERTIONS.length };
}
