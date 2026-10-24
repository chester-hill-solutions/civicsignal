import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_CONTRACT_VERSION, JEV_ENDPOINT, JEV_MODEL, rankWithJev, type Candidate } from '../src/jev';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const candidates: Candidate[] = [
  { id: 'synthetic-a', title: 'Synthetic Act, section 1', text: 'synthetic provision' },
  { id: 'synthetic-b', title: 'Synthetic Act, section 2', text: 'another synthetic provision' },
];

function completeAnswers(): Record<string, { type: 'noul'; noul: number }> {
  return {
    c0: { type: 'noul', noul: 0.9 },
    c1: { type: 'noul', noul: 0.1 },
    needs_federal_statute: { type: 'noul', noul: 0.93 },
    needs_provincial: { type: 'noul', noul: 0 },
    needs_court_decision: { type: 'noul', noul: 0 },
    needs_foreign_law: { type: 'noul', noul: 0 },
    is_not_law: { type: 'noul', noul: 0 },
    asks_published_figure: { type: 'noul', noul: 0 },
    any_relevant: { type: 'noul', noul: 0.95 },
  };
}

function sender(body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

describe('Jev response failure boundary', () => {
  it('returns the defined null fallback for a JSON null HTTP 200 body', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('null', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));

    await expect(rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send,
    })).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves a complete valid response, including actual zero scores', async () => {
    const send = sender({ model: 'jev-1.13', answers: completeAnswers() });
    const result = await rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send,
    });

    expect(result).toEqual({
      relevance: [0.9, 0.1], anyRelevant: 0.95,
      flags: {
        needs_federal_statute: 0.93, needs_provincial: 0,
        needs_court_decision: 0, needs_foreign_law: 0,
        is_not_law: 0, asks_published_figure: 0,
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'numeric-string candidate score', name: 'c0', value: '0.9' },
    { label: 'above-one relevance probability', name: 'any_relevant', value: 1.01 },
    { label: 'negative authority probability', name: 'needs_provincial', value: -0.01 },
    { label: 'boolean authority probability', name: 'needs_provincial', value: true },
    { label: 'null candidate probability', name: 'c0', value: null },
  ])('uses the fallback for a $label', async ({ name, value }) => {
    const answers: Record<string, unknown> = completeAnswers();
    answers[name] = { type: 'noul', noul: value };
    const send = sender({ answers });

    await expect(rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send,
    })).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(completeAnswers()))('does not fabricate zero for unanswered %s', async name => {
    const answers = completeAnswers();
    delete answers[name];
    const send = sender({ answers });

    await expect(rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send,
    })).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([{}, [], null, true, 'answers', 1])('does not fabricate a result from an invalid answers container %#', async (answers) => {
    const send = sender({ answers });
    await expect(rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send,
    })).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([[], true, 'body', 1])('uses the fallback for a non-object response body %#', async value => {
    const send = sender(value);
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'missing discriminator', value: { noul: 0.9 } },
    { label: 'wrong discriminator', value: { type: 'boolean', noul: 0.9 } },
    { label: 'missing probability', value: { type: 'noul' } },
    { label: 'null answer', value: null },
    { label: 'array answer', value: [] },
  ])('refuses a $label', async ({ value }) => {
    const answers: Record<string, unknown> = completeAnswers(); answers.c0 = value;
    const send = sender({ answers });
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['NaN', '1e400', '-1e400'])('refuses non-finite JSON probability %s', async number => {
    const body = JSON.stringify({ answers: completeAnswers() }).replace('"noul":0.9', `"noul":${number}`);
    const send = vi.fn<typeof fetch>(async () => new Response(body));
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('accepts the actual probability boundary %s', async value => {
    const answers = completeAnswers();
    for (const answer of Object.values(answers)) answer.noul = value;
    const result = await rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', send: sender({ answers, model: 'resolved-alias', usage: { ignored: true } }),
    });
    expect(result?.relevance).toEqual([value, value]);
    expect(result?.anyRelevant).toBe(value);
    expect(Object.values(result!.flags)).toEqual(Array(6).fill(value));
  });

  it('uses one fixed-policy POST while preserving endpoint and model overrides', async () => {
    const send = sender({ answers: completeAnswers() });
    await rankWithJev('synthetic question', candidates, {
      key: 'synthetic-unused-key', endpoint: 'https://synthetic.invalid/jev', model: 'synthetic-model', send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://synthetic.invalid/jev');
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-unused-key');
    expect(JSON.parse(String(init?.body)).model).toBe('synthetic-model');
    expect(JEV_ENDPOINT).toBe('https://opencode.ai/inference/systemone/v1/systemone');
    expect(JEV_MODEL).toBe('jev-1.13'); expect(JEV_CONTRACT_VERSION).toBe('jev-noul-complete-15s-v1');
  });

  it.each([302, 401, 429, 503])('returns null after one HTTP%s without retries', async status => {
    const send = vi.fn<typeof fetch>(async () => new Response('synthetic-private-error', { status }));
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-1MiB UTF-8 request before sending', async () => {
    const send = vi.fn<typeof fetch>(), failure=vi.fn();
    expect(await rankWithJev('é'.repeat(512 * 1024), candidates, { key: 'synthetic-unused-key', send, onFailure:failure })).toBeNull();
    expect(send).not.toHaveBeenCalled();expect(failure).toHaveBeenCalledWith({phase:'request-serialization'});
  });

  it.each(['declared', 'actual'])('caps %s response bytes at 256KiB', async kind => {
    let cancelled = 0;const failure=vi.fn();
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { if (kind === 'actual') c.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled++; },
    }), { headers: kind === 'declared' ? { 'content-length': String(256 * 1024 + 1) } : {} }));
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send,onFailure:failure })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toBe(1);expect(failure).toHaveBeenCalledWith({phase:'response-body',upstreamStatus:200});
  });

  it('bounds an ignored-abort fetch at the original 15s deadline', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0);
    const send = vi.fn<typeof fetch>(() => new Promise<Response>(() => {})); let settled = false;const failure=vi.fn();
    const pending = rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send,onFailure:failure }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(14_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBeNull();
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);expect(failure).toHaveBeenCalledWith({phase:'timeout'});
  });

  it('bounds a stalled response read within the same 15s deadline', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0); let cancelled = 0;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered(); }, cancel() { cancelled++; },
    }, { highWaterMark: 0 })));
    const pending = rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send });
    await ready; await vi.advanceTimersByTimeAsync(15_000); expect(await pending).toBeNull();
    expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toBe(1);
  });

  it('refuses immediately fulfilled chunks crossing the monotonic deadline', async () => {
    let clock = 0, cancelled = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { clock += 5_001; c.enqueue(new Uint8Array()); }, cancel() { cancelled++; },
    }, { highWaterMark: 0 })));
    expect(await rankWithJev('synthetic question', candidates, { key: 'synthetic-unused-key', send })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toBe(1);
  });
});

describe('safe Jev failure diagnostics', () => {
  it.each([
    {label:'transport',makeSend:()=>vi.fn<typeof fetch>().mockRejectedValue(new Error('private-key-and-cause')),expected:{phase:'transport'}},
    {label:'HTTP',makeSend:()=>vi.fn<typeof fetch>().mockResolvedValue(new Response('private-provider-body',{status:429})),expected:{phase:'upstream-http',upstreamStatus:429}},
    {label:'JSON',makeSend:()=>vi.fn<typeof fetch>().mockResolvedValue(new Response('{private-invalid-json')),expected:{phase:'response-parse',upstreamStatus:200}},
    {label:'response envelope',makeSend:()=>sender(null),expected:{phase:'response-validation',upstreamStatus:200,schemaReason:'response-shape'}},
    {label:'answers envelope',makeSend:()=>sender({answers:[]}),expected:{phase:'response-validation',upstreamStatus:200,schemaReason:'answers-shape'}},
  ])('emits only fixed metadata for $label failure',async({makeSend,expected})=>{
    const failure=vi.fn(),send=makeSend();
    expect(await rankWithJev('private-query',candidates,{key:'private-key',send,onFailure:failure})).toBeNull();
    expect(failure).toHaveBeenCalledTimes(1);expect(failure).toHaveBeenCalledWith(expected);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure.mock.calls)).not.toMatch(/private|cause|message/);
  });
  it('counts missing and rejected requested answers without retaining names or values',async()=>{
    const answers:Record<string,unknown>=completeAnswers();delete answers.c1;delete answers.any_relevant;
    answers.c0={type:'noul',noul:'private-bad-value'};answers.needs_provincial={type:'boolean',noul:0};
    answers.unrequested_private_name='private-extra-value';const failure=vi.fn();
    expect(await rankWithJev('private-query',candidates,{key:'private-key',send:sender({answers}),onFailure:failure})).toBeNull();
    expect(failure).toHaveBeenCalledTimes(1);expect(failure).toHaveBeenCalledWith({phase:'response-validation',upstreamStatus:200,schemaReason:'requested-answers',rejectedCount:2,missingCount:2});
    expect(JSON.stringify(failure.mock.calls)).not.toMatch(/private|c0|c1|provincial|any_relevant/);
  });
  it('keeps observer exceptions isolated from the same null fallback',async()=>{
    const send=sender(null),failure=vi.fn(()=>{throw new Error('private-observer');});
    expect(await rankWithJev('private-query',candidates,{key:'private-key',send,onFailure:failure})).toBeNull();
    expect(failure).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);
  });
  it('isolates rejected and stalled async observers without extending fallback',async()=>{
    const rejected=vi.fn(async()=>{throw new Error('private-async-observer');});
    expect(await rankWithJev('private-query',candidates,{key:'private-key',send:sender(null),onFailure:rejected})).toBeNull();
    await new Promise(resolve=>setImmediate(resolve));expect(rejected).toHaveBeenCalledTimes(1);
    const stalled=vi.fn(()=>new Promise<void>(()=>{}));
    expect(await rankWithJev('private-query',candidates,{key:'private-key',send:sender(null),onFailure:stalled})).toBeNull();
    expect(stalled).toHaveBeenCalledTimes(1);
  });
  it('snapshots observer selection before the exchange',async()=>{
    let finish!:(value:Response)=>void;const send=vi.fn<typeof fetch>(()=>new Promise(resolve=>{finish=resolve;})),first=vi.fn(),later=vi.fn();
    const options={key:'private-key',send,onFailure:first};const pending=rankWithJev('private-query',candidates,options);options.onFailure=later;
    finish(Response.json(null));expect(await pending).toBeNull();expect(first).toHaveBeenCalledTimes(1);expect(later).not.toHaveBeenCalled();
  });
  it('keeps an observer accessor failure optional',async()=>{
    const options={key:'private-key',send:sender(null),get onFailure():undefined{throw new Error('private-observer-accessor');}};
    expect(await rankWithJev('private-query',candidates,options)).toBeNull();
  });
  it('does not emit a failure for valid complete zeros or an empty candidate list',async()=>{
    const answers=completeAnswers();for(const answer of Object.values(answers))answer.noul=0;
    const failure=vi.fn(),send=sender({answers});
    expect((await rankWithJev('private-query',candidates,{key:'private-key',send,onFailure:failure}))?.relevance).toEqual([0,0]);
    expect(await rankWithJev('private-query',[],{key:'private-key',send,onFailure:failure})).toBeNull();
    expect(failure).not.toHaveBeenCalled();expect(send).toHaveBeenCalledTimes(1);
  });
  it('bounds diagnostic counts for larger direct caller inputs without changing fallback',async()=>{
    const many=Array.from({length:300},()=>candidates[0]!),failure=vi.fn();
    expect(await rankWithJev('private-query',many,{key:'private-key',send:sender({answers:{}}),onFailure:failure})).toBeNull();
    expect(failure).toHaveBeenCalledTimes(1);expect(failure).toHaveBeenCalledWith({phase:'response-validation',upstreamStatus:200,schemaReason:'requested-answers',rejectedCount:0,missingCount:257});
  });
});
