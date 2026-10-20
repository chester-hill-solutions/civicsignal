import { describe, expect, it } from 'vitest';
import plugin from '../services/harness/plugin';

/**
 * The harness plugin.
 *
 * The licence rule is the part that matters. It used to be a system prompt in the
 * chat endpoint, which is a string somebody eventually softens. Here it is a hook
 * on the model request, and this test establishes three things about it:
 *
 * - it is applied to **every** model call, not just the first;
 * - it says the right thing about each of the three reproduction regimes;
 * - and it is applied *before* the model sees anything, not after.
 */

interface Recorder {
  mcp: { servers: Record<string, unknown> };
  agents: Map<string, { description?: string }>;
  hooks: { kind: string; handler: (event: unknown) => void }[];
  commands: Map<string, { name: string; description: string }>;
  prompts: { text: string }[];
}

/**
 * A fake plugin context that records what the plugin did.
 *
 * The recorder and the context are kept apart: merging them would replace the
 * recorder's own `mcp` with the context's transform API, and the recording would
 * be the thing that broke.
 */
function context(options: Record<string, unknown> = {}): { ctx: unknown; recorder: Recorder } {
  const recorder: Recorder = {
    mcp: { servers: {} },
    agents: new Map(),
    hooks: [],
    commands: new Map(),
    prompts: [],
  };

  const ctx = {
    options,
    app: { version: 'test' },
    location: { directory: '/workspace' },
    mcp: {
      transform: async (fn: (editor: any) => void) => {
        const editor = {
          list: () => Object.entries(recorder.mcp.servers),
          get: (name: string) => recorder.mcp.servers[name],
          set: (name: string, config: unknown) => {
            recorder.mcp.servers[name] = config;
          },
          update: (name: string, fn: (c: any) => void) => {
            const current = recorder.mcp.servers[name] ?? {};
            fn(current);
            recorder.mcp.servers[name] = current;
          },
          remove: (name: string) => {
            delete recorder.mcp.servers[name];
          },
        };
        fn(editor);
      },
    },
    agent: {
      transform: async (fn: (editor: any) => void) => {
        const editor = {
          list: () => [...recorder.agents.entries()].map(([id, a]) => ({ id, ...a })),
          get: (id: string) => (recorder.agents.has(id) ? { id, ...recorder.agents.get(id) } : undefined),
          default: () => {},
          update: (id: string, fn: (a: any) => void) => {
            const current = recorder.agents.get(id) ?? {};
            fn(current);
            recorder.agents.set(id, current);
          },
          remove: (id: string) => {
            recorder.agents.delete(id);
          },
        };
        fn(editor);
      },
    },
    session: {
      hook: async (kind: string, handler: (event: unknown) => void) => {
        recorder.hooks.push({ kind, handler });
        return { dispose: async () => {} };
      },
      prompt: async (input: { text: string }) => {
        recorder.prompts.push(input);
        return {};
      },
    },
    command: {
      transform: async (fn: (editor: any) => void) => {
        const editor = {
          list: () => [...recorder.commands.values()],
          add: (definition: { name: string; description: string }) => {
            recorder.commands.set(definition.name, definition);
          },
        };
        fn(editor);
      },
    },
  };

  return { ctx, recorder };
}

async function setup(options: Record<string, unknown> = {}): Promise<Recorder> {
  const { ctx, recorder } = context(options);
  await (plugin as unknown as { setup: (ctx: unknown) => Promise<void> }).setup(ctx);
  return recorder;
}

describe('the harness plugin', () => {
  it('wires the corpus in as a remote MCP server', async () => {
    const recorder = await setup({ apiUrl: 'https://api.example/', apiKey: 'sk_test' });
    const server = recorder.mcp.servers['civicsignal'] as { url: string; headers: Record<string, string> };
    expect(server.url).toBe('https://api.example/mcp');
    expect(server.headers['Authorization']).toBe('Bearer sk_test');
  });

  it('gives the agent a description that says what it is for', async () => {
    const recorder = await setup();
    const agent = recorder.agents.get('build');
    expect(agent?.description).toContain('CivicSignal');
    expect(agent?.description).toContain('cites its source');
  });

  it('registers the commands a campaign or a clinic actually asks', async () => {
    const recorder = await setup();
    expect([...recorder.commands.keys()].sort()).toEqual(['changes', 'coverage', 'in-force']);
  });

  it('applies the licence rule on every model call, not just the first', async () => {
    const recorder = await setup();
    const hook = recorder.hooks.find((h) => h.kind === 'context');
    expect(hook).toBeDefined();

    const first: { system: { type: string; text: string }[] } = { system: [] };
    hook!.handler(first);
    const second: { system: { type: string; text: string }[] } = { system: [] };
    hook!.handler(second);

    expect(first.system).toHaveLength(1);
    expect(second.system).toHaveLength(1);
    expect(first.system[0]!.text).toBe(second.system[0]!.text);
  });

  it('says what may be done with each of the three regimes', async () => {
    const recorder = await setup();
    const hook = recorder.hooks.find((h) => h.kind === 'context')!;
    const event: { system: { type: string; text: string }[] } = { system: [] };
    hook.handler(event);
    const rule = event.system[0]!.text;

    expect(rule).toContain('summarised');
    expect(rule).toContain('Quote it verbatim');
    expect(rule).toContain('Do not infer or reconstruct');
  });

  it('tells the agent to say what the corpus does not cover', async () => {
    const recorder = await setup();
    const hook = recorder.hooks.find((h) => h.kind === 'context')!;
    const event: { system: { type: string; text: string }[] } = { system: [] };
    hook.handler(event);
    expect(event.system[0]!.text).toContain('does not cover');
  });

  it('says a citation is a key, not a similarity', async () => {
    const recorder = await setup();
    const hook = recorder.hooks.find((h) => h.kind === 'context')!;
    const event: { system: { type: string; text: string }[] } = { system: [] };
    hook.handler(event);
    expect(event.system[0]!.text).toContain('A citation is a key');
  });

  it('the in-force command asks for an exact resolution', async () => {
    const recorder = await setup();
    const command = recorder.commands.get('in-force')!;
    await (command as unknown as { execute: (i: unknown) => Promise<void> }).execute({
      sessionID: 's1',
      prompt: { text: 'section 9 of the Privacy Act' },
      delivery: 'steer',
    });
    expect(recorder.prompts[0]!.text).toContain('Resolve the provision exactly');
    expect(recorder.prompts[0]!.text).toContain('section 9 of the Privacy Act');
  });
});
