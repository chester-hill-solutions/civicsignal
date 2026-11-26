import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { CombinedServingCheck, CombinedServingInput } from '../daily-checks/worker';
import { HouseFailureReceipt } from '../house/failure';
import { z } from 'zod';
import { compareHouse, completedSource, housePublication, houseSnapshot, readJson, sourceInstance, sources,
  type Archives, type HousePublication, type HouseSnapshot, type Source } from './report';

interface Params { scheduledTime: number }
interface Env extends Archives {
  DAILY: Workflow<Params>;
  CONSULTATIONS: Workflow<Params>;
  NSERC: Workflow<Params>;
  ESDC: Workflow<Params>;
  HOUSE: Workflow<Params>;
  VERIFY: Service<CombinedServingCheck>;
  COMMITTEE_DB: D1Database;
}

type Running = { instanceId: string; state: 'pending' | 'start-failed' };
type Status = { instanceId: string; state: InstanceStatus['status'] | 'unreachable' | 'start-failed'; output?: { receiptKey: string } };
const receiptOutput = z.object({ receiptKey: z.string() });
const isTerminal = (state: Status['state']) => ['complete','errored','terminated','start-failed'].includes(state);
const waitInterval = '45 seconds';
const maxPolls = 60;

function bindings(env: Env): Record<Source, Workflow<Params>> {
  return { consultations: env.CONSULTATIONS, nserc: env.NSERC, esdc: env.ESDC, house: env.HOUSE };
}

async function create(workflow: Workflow<Params>, id: string, params: Params) {
  try {
    await workflow.create({ id, params });
  } catch (error) {
    // The create may have succeeded before the acknowledgement was lost.
    const prior = await (await workflow.get(id)).status();
    if (prior.status === 'unknown') throw error;
  }
}

async function launch(env: Env, params: Params) {
  const workers = bindings(env);
  return Promise.all(sources.map(async (source): Promise<Running> => {
    const instanceId = sourceInstance(source, params.scheduledTime);
    try {
      await create(workers[source], instanceId, params);
      return { instanceId, state: 'pending' };
    } catch {
      return { instanceId, state: 'start-failed' };
    }
  }));
}

async function inspect(env: Env, children: ReadonlyArray<Status>) {
  const workers = bindings(env);
  return Promise.all(children.map(async (child, index): Promise<Status> => {
    if (isTerminal(child.state)) return child;
    try {
      const status = await (await workers[sources[index]].get(child.instanceId)).status();
      const output = status.status === 'complete' ? receiptOutput.safeParse(status.output).data : undefined;
      return { instanceId: child.instanceId, state: status.status, ...(output ? { output } : {}) };
    } catch {
      return { instanceId: child.instanceId, state: 'unreachable' };
    }
  }));
}

const safeSourceError = { code: 'source-failed' } as const;
async function readHouseRefusal(env: Env, id: string, scheduledTime: number) {
  const key = `committee/house-calls/failures/${id}.json`;
  try {
    const { data, sha256 } = await readJson(env.ARCHIVE, key, 8192);
    const refusal = HouseFailureReceipt.parse(data);
    if (refusal.instanceId === id && refusal.scheduledTime === scheduledTime) {
      return { ...refusal, evidenceKey: key, evidenceSha256: sha256 };
    }
  } catch {
    // A source can fail before producing an attributable publisher response.
  }
  return safeSourceError;
}

async function sourceOutcome(env: Env, status: Status, source: Source, scheduledTime: number) {
  const instance = { source, instanceId: status.instanceId, workflowState: status.state };
  if (status.state === 'complete') {
    try {
      return { ...instance, status: 'published' as const,
        receipt: await completedSource(env, source, status.instanceId, scheduledTime, status.output) };
    } catch {
      return { ...instance, status: 'failed' as const, failure: { code: 'invalid-completion-receipt' } };
    }
  }
  if (!isTerminal(status.state)) {
    return { ...instance, status: 'timed-out' as const, failure: { code: 'source-wait-budget-exceeded' } };
  }
  const failure = source === 'house' && status.state === 'errored'
    ? await readHouseRefusal(env, status.instanceId, scheduledTime)
    : { code: status.state === 'start-failed' ? 'source-start-failed' : safeSourceError.code };
  return { ...instance, status: 'failed' as const, failure };
}

async function pinHouse(env: Env): Promise<{ snapshot: HouseSnapshot | null; lastGood: HousePublication | null }> {
  const snapshot = await houseSnapshot(env.COMMITTEE_DB).catch(() => null);
  const lastGood = snapshot ? await housePublication(env.ARCHIVE, snapshot).catch(() => null) : null;
  return { snapshot, lastGood };
}

type Outcome = Awaited<ReturnType<typeof sourceOutcome>>;
function verificationInputs(outcomes: Outcome[], fallback: HousePublication | null): CombinedServingInput {
  const [consultations, nserc, esdc, house] = outcomes;
  const input: CombinedServingInput = {};
  if (consultations.status === 'published') input.consultations = consultations.instanceId;
  if (nserc.status === 'published') input.nserc = nserc.instanceId;
  if (esdc.status === 'published') input.esdc = esdc.instanceId;
  const receipt = house.status === 'published' ? house.receipt : fallback;
  if (receipt?.cutoff && receipt.packetRef) {
    input.house = { observedAt: receipt.observedAt, cutoff: receipt.cutoff, packetRef: receipt.packetRef };
  }
  return input;
}

const verificationStep = { retries: { limit: 0, delay: '1 second' as const }, timeout: '5 minutes' as const };
const publishedReport = z.object({ instanceId: z.string(), scheduledTime: z.number(), status: z.enum(['complete','degraded','failed']) });

export class DailyRefresh extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { instanceId } = event;
    const { scheduledTime } = event.payload;
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || scheduledTime >= 4102444800000 ||
        instanceId !== `daily-refresh-${scheduledTime}`) throw new Error('Invalid combined daily occurrence.');
    const key = `daily/runs/${instanceId}.json`;
    const completed = await step.do('look for a finalized daily report', async () => {
      const prior = await this.env.ARCHIVE.get(key);
      if (!prior) return null;
      const report = publishedReport.parse(await prior.json());
      if (report.instanceId !== instanceId || report.scheduledTime !== scheduledTime) throw new Error('Daily report identity mismatch.');
      return { receiptKey: key, status: report.status };
    });
    if (completed) return completed;

    const before = await step.do('pin the last House publication', () => pinHouse(this.env));
    const started = await step.do('start all four source Workflows', () => launch(this.env, { scheduledTime }));
    let states: Status[] = started.map(child => ({
      instanceId: child.instanceId, state: child.state === 'pending' ? 'unknown' : 'start-failed',
    }));
    for (let poll = 0; poll < maxPolls; poll++) {
      const previous = states;
      states = await step.do('read source status ' + (poll + 1), () => inspect(this.env, previous));
      if (states.every(child => isTerminal(child.state)) || poll === maxPolls - 1) break;
      await step.sleep('wait for source Workflows ' + (poll + 1), waitInterval);
    }
    const outcomes = await step.do('read the dated source receipts', () =>
      Promise.all(states.map((child, index) => sourceOutcome(this.env, child, sources[index], scheduledTime))));
    const house = outcomes[3];
    const preservation = house.status === 'published' ? null : await step.do('compare House publication after failure', async () =>
      {
      const after = await pinHouse(this.env);
      return compareHouse(before.snapshot, after.snapshot, before.lastGood, after.lastGood);
    });
    const inputs = verificationInputs(outcomes, preservation?.lastGood ?? null);
    let verification: Awaited<ReturnType<CombinedServingCheck['verify']>> | null = null;
    try {
      verification = await step.do('verify the authenticated API with available publications', verificationStep, async () => {
        const result = await this.env.VERIFY.verify(inputs);
        return JSON.parse(JSON.stringify(result)) as Awaited<ReturnType<CombinedServingCheck['verify']>>;
      });
    } catch {
      // Preserve the source outcomes even when the verification service itself cannot return a report.
    }
    const status = !verification || verification.failed || !verification.passed ||
      (preservation !== null && !preservation.lastGood) ? 'failed'
      : outcomes.every(source => source.status === 'published') && !verification.skipped ? 'complete' : 'degraded';
    return step.do('retain combined daily run report', async () => {
      const body = JSON.stringify({
        instanceId, scheduledTime, scheduledAt: new Date(scheduledTime).toISOString(), status,
        sources: outcomes, housePreservation: preservation,
        verification: verification ?? { error: { code: 'verification-service-failed' } },
        houseVerificationBasis: inputs.house ? (house.status === 'published' ? 'current' : 'last-good') : null,
      });
      const written = await this.env.ARCHIVE.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
      if (!written && await (await this.env.ARCHIVE.get(key))?.text() !== body) throw new Error('Conflicting combined daily run report.');
      console.log(JSON.stringify({ event: 'combined-daily-refresh-finished', instanceId, status, receiptKey: key }));
      return { receiptKey: key, status };
    });
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    await create(env.DAILY, `daily-refresh-${event.scheduledTime}`, { scheduledTime: event.scheduledTime });
  },
};
