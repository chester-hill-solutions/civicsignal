import type { EvalQuestion, QuestionStyle } from './questions';

export type RetrievalMode = 'keyword' | 'vector' | 'hybrid';

export interface QuestionOutcome {
  id: string;
  style: QuestionStyle;
  /** The 1-based rank of the gold answer in this mode's ranking, or null if absent. */
  rank: number | null;
  /** How many gold rows exist for this question, after label validation. */
  goldCount: number;
}

export interface ModeResult {
  mode: RetrievalMode;
  total: number;
  hits: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  /** Mean reciprocal rank over all questions, treating a miss as zero. */
  mrr: number;
  byStyle: Record<QuestionStyle, { total: number; hits: number; recallAt5: number; mrr: number }>;
  outcomes: QuestionOutcome[];
}

export function scoreMode(
  mode: RetrievalMode,
  outcomes: QuestionOutcome[],
): ModeResult {
  const byStyle: ModeResult['byStyle'] = {
    exact: { total: 0, hits: 0, recallAt5: 0, mrr: 0 },
    concept: { total: 0, hits: 0, recallAt5: 0, mrr: 0 },
  };

  let hits = 0;
  let reciprocal = 0;
  let at1 = 0;
  let at5 = 0;
  let at10 = 0;

  for (const outcome of outcomes) {
    const bucket = byStyle[outcome.style];
    bucket.total++;
    if (outcome.rank !== null) {
      hits++;
      reciprocal += 1 / outcome.rank;
      if (outcome.rank <= 1) at1++;
      if (outcome.rank <= 5) at5++;
      if (outcome.rank <= 10) at10++;
      bucket.hits++;
      bucket.mrr += 1 / outcome.rank;
      if (outcome.rank <= 5) bucket.recallAt5++;
    }
  }

  const total = outcomes.length;
  for (const style of ['exact', 'concept'] as const) {
    const bucket = byStyle[style];
    bucket.recallAt5 = bucket.total ? bucket.recallAt5 / bucket.total : 0;
    bucket.mrr = bucket.total ? bucket.mrr / bucket.total : 0;
  }

  return {
    mode,
    total,
    hits,
    recallAt1: total ? at1 / total : 0,
    recallAt5: total ? at5 / total : 0,
    recallAt10: total ? at10 / total : 0,
    mrr: total ? reciprocal / total : 0,
    byStyle,
    outcomes,
  };
}

export interface LabelIssue {
  question: EvalQuestion;
  reason: string;
  matches: number;
}

/**
 * Check that every question's gold answer resolves to exactly one corpus row.
 *
 * A question whose label matches nothing would be scored as a miss for every arm,
 * which would quietly bias the comparison against whichever arm the label happened
 * to favour. A label that matches several rows is ambiguous and is reported too.
 */
export function validateLabels(
  questions: EvalQuestion[],
  rows: { act: string; section: string }[],
): { valid: Map<string, number>; issues: LabelIssue[] } {
  const byKey = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = `${row.act}::${row.section}`;
    const list = byKey.get(key);
    if (list) list.push(index);
    else byKey.set(key, [index]);
  });

  const valid = new Map<string, number>();
  const issues: LabelIssue[] = [];
  for (const question of questions) {
    const matches = byKey.get(`${question.act}::${question.section}`) ?? [];
    if (matches.length === 0) {
      issues.push({ question, reason: 'no matching row in the corpus', matches: 0 });
      continue;
    }
    if (matches.length > 1) {
      issues.push({ question, reason: 'label is ambiguous', matches: matches.length });
    }
    valid.set(question.id, matches[0]!);
  }
  return { valid, issues };
}

export function formatModeResult(result: ModeResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(6);
  const rows = [
    `  ${result.mode.padEnd(8)} hits ${String(result.hits).padStart(3)}/${result.total}` +
      `  R@1 ${pct(result.recallAt1)}  R@5 ${pct(result.recallAt5)}  R@10 ${pct(result.recallAt10)}  MRR ${result.mrr.toFixed(3)}`,
  ];
  for (const style of ['exact', 'concept'] as const) {
    const b = result.byStyle[style];
    rows.push(
      `    ${style.padEnd(8)} ${String(b.hits).padStart(3)}/${String(b.total).padEnd(3)}` +
        `  R@5 ${pct(b.recallAt5)}  MRR ${b.mrr.toFixed(3)}`,
    );
  }
  return rows.join('\n');
}
