import { checkConsultations, checkFinanceBrief, checkFundingProgram, Inputs } from './acceptance';
import { checkAccess } from './access';
import { checkHousePacket, type HouseServingEnv, type HouseServingInput } from './house-calls';
import { observeProduct, ProductCheckFailure, type ProductClient, type ProductEnv, type Trace, type UsageMode } from './product';

export interface CombinedServingInput {
  consultations?: string;
  nserc?: string;
  esdc?: string;
  house?: HouseServingInput;
}

export interface CombinedEnv extends ProductEnv, HouseServingEnv {
  CONSULTATION_ARCHIVE: R2Bucket;
}

type Status = 'passed' | 'failed' | 'skipped';
interface CaseResult {
  name: string;
  status: Status;
  correlationIds: string[];
  usage: { before: number | null; after: number | null; retrievals: number };
  error?: string;
}
type Check = (client: ProductClient) => Promise<unknown>;

function caseResult(name: string, status: Status, mode: UsageMode, trace: Trace, error?: string): CaseResult {
  return { name, status, correlationIds: trace.requests.map(r => r.correlationId),
    usage: { before: trace.before, after: trace.after,
      retrievals: mode === 'free' ? 0 : trace.requests.filter(r => r.status >= 200 && r.status < 300).length },
    ...(error ? { error } : {}) };
}

async function runCase(env: CombinedEnv, name: string, mode: UsageMode, check?: Check) {
  const empty = { requests: [], before: null, after: null };
  if (!check) return caseResult(name, 'skipped', mode, empty);
  try {
    const trace = await observeProduct(env, mode, check);
    return caseResult(name, 'passed', mode, trace);
  } catch (error) {
    if (!(error instanceof ProductCheckFailure)) return caseResult(name, 'failed', mode, empty, 'Product verification unavailable.');
    const messages = { meter: 'Unable to read workspace usage.', usage: 'Workspace usage did not match the verified requests.',
      product: 'Serving data or its retained reference failed verification.' };
    return caseResult(name, 'failed', mode, error.trace, messages[error.stage]);
  }
}

export async function verifyCombined(env: CombinedEnv, input: CombinedServingInput) {
  // Each case takes its own before/after reading of the same workspace meter.
  const cases: CaseResult[] = [];
  const { consultations, house } = input;
  cases.push(await runCase(env, 'consultations', 'metered', consultations === undefined ? undefined :
    client => checkConsultations(client.read, env.CONSULTATION_ARCHIVE, Inputs.shape.consultations.parse(consultations))));
  cases.push(await runCase(env, 'house', 'metered', house === undefined ? undefined :
    client => checkHousePacket(client.read, env, house)));
  cases.push(await runCase(env, 'access', 'free', async client => {
    const cutoff = await env.COMMITTEE_DB.prepare("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").first<string>('cutoff');
    if (!cutoff) throw new Error('Missing committee snapshot cutoff.');
    await checkAccess(client, cutoff);
  }));
  for (const language of ['en', 'fr'] as const) {
    cases.push(await runCase(env, 'finance-' + language, 'metered', client => checkFinanceBrief(client.read, language)));
    for (const source of ['nserc', 'esdc'] as const) {
      const instance = input[source];
      cases.push(await runCase(env, source + '-' + language, 'metered', instance === undefined ? undefined :
        client => checkFundingProgram(client.read, env.ARCHIVE, source, instance, language)));
    }
  }
  const total = (status: Status) => cases.filter(c => c.status === status).length;
  return { passed: total('passed'), failed: total('failed'), skipped: total('skipped'), cases };
}
