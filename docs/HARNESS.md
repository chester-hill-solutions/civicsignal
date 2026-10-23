# The harness

## Current v1 authority

Future harness design. v1 exposes authenticated HTTP and MCP retrieval with BYOK chat; it does not ship this harness.
[The v1 release checklist](V1-RELEASE.md) takes precedence over the historical claims below.

Why the product embeds OpenCode rather than building a chat interface.

## The short version

The product is **not** a chat about Canadian politics. It is **the civic corpus,
with an agent in front of it**. OpenCode is that agent — its agent loop is the
chat, its tool surface is the product's, and its model configuration is already
BYOK.

This is not a shortcut around building a chat interface. It is a different and
better product, and it is the same product the retrieval work already pointed at.

## The two SDKs

| | What it is |
|---|---|
| `@opencode/sdk` | **hosts OpenCode inside your application**. It assembles the server and routes API calls through its HTTP router *in memory*: no HTTP listener, no network hop between the client and the server. |
| `@opencode/client` | the network client, for talking to an `opencode serve` process. |

The embedded host is the one that matters here:

```ts
import { OpenCode } from "@opencode/sdk"

await using opencode = await OpenCode.create()
const session = await opencode.sessions.create({ location: { directory: "/workspace" } })
await opencode.sessions.prompt({ sessionID: session.id, text: "What does s. 210 say?" })
for await (const event of opencode.events.subscribe()) { /* the UI's stream */ }
```

It exposes the full generated client plus `sessions` and `events` aliases, and the
same `Promise` values, declared errors and `AsyncIterable` streams as the client.

## What it gives us

| Surface | What we would otherwise build |
|---|---|
| The chat | multi-turn conversation, streaming, tool calls, reasoning, attachments |
| The dashboard | sessions, a file tree, a terminal, a diff view, a todo list |
| BYOK | provider keys, model switching, per-provider auth, OAuth flows |
| The agent loop | the tool-use loop, permissions, context management |
| The interface | a typed client, an HTTP API, SSE events |

MIT licensed, and the seam is the SDK rather than the source.

## Plugins are the customisation surface

This is the part that makes it a *product* rather than a wrapper. A plugin gets
a context that is essentially a server client, plus transforms over every domain:

```ts
export default Plugin.define({
  id: "civicsignal",
  async setup(ctx) {
    // The corpus, wired in. Per directory, per customer.
    await ctx.mcp.transform((editor) => {
      editor.set("civicsignal", { type: "remote", url: "https://api.civicsignal/mcp" })
    })

    // Our own agent.
    await ctx.agent.transform((editor) => {
      editor.update("build", (agent) => {
        agent.description = "Answers questions about Canadian law, citing its sources."
      })
    })

    // The licence rule, enforced rather than requested.
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: LICENCE_RULE })
      delete event.tools.write
    })
  },
})
```

The domains a plugin can transform: **agents, providers, models, commands,
integrations, MCP servers, plugins, references, tools, skills, worktrees, VCS
providers, websearch providers.** And it can register **hooks** on live
operations.

### The licence rule belongs here

Today the rule — *a cite-only corpus may be quoted, never paraphrased, because a
paraphrase of Crown copyright is a derivative of it* — lives in a system prompt
in `src/chat.ts`. A system prompt is a string somebody will eventually soften.

As a `session.hook("context")` it is better in three ways: it runs on **every**
model call including tool-driven continuations, not once per request; it can
**remove tools** the agent must not have (`delete event.tools.write`); and it is
**code**, versioned, with a test.

### Commands are a product surface

`ctx.command.transform` adds commands that are first-class in the harness:

```
/changes     what changed in federal law this week
/coverage    what the corpus does not cover
/in-force    is this provision in force
```

Those are the queries a campaign, a legal clinic or a journalist actually asks,
and they are exactly what the change feed and the coverage report were built for.

### BYOK is native, and per customer

```ts
await ctx.integration.connect.key({ integrationID: "anthropic", key: customerKey })
await ctx.credential.activate({ credentialID })
```

The customer's key goes into **their** location's credential store and is
activated for their sessions. It never touches a CivicSignal proxy, which is
strictly better than the BYOK proxy the API has today — and it removes the
question of whether we should be holding other people's model keys at all.

## Multi-tenancy

A location is a directory, and a session carries one. The embedded host takes
`location: { directory }` on every session, and the plugin context is scoped to
`ctx.location.directory`.

So the model is **one host, one directory per customer**:

- the customer signs in to CivicSignal;
- their provider key is connected and activated for their directory;
- the corpus MCP server is wired into their directory by the plugin, carrying
  their CivicSignal key;
- their sessions, and only theirs, live in their directory.

`ctx.mcp.transform`, `ctx.agent.transform` and `ctx.session.hook` are all
directory-scoped, so the CivicSignal configuration is applied per customer
without any of it being global.

## Where it runs

The embedded host needs a real process — it spawns shell tools, it needs a
filesystem, it needs memory. So it runs on **Railway**, in the same plane as the
corpus: the encoder, the store, the pipeline, and the harness. The Cloudflare
Worker stays the public edge — API, MCP, chat fallback, billing — and proxies to
it.

There is a Durable Objects guide for the SDK, but a Durable Object cannot spawn
processes, so the full harness does not fit there. The Worker stays the edge.

## The cost, stated plainly

This is the one thing that changes the economics, and it should not be glossed.

Today the product's marginal cost is retrieval: a rounding error per query on
Cloudflare, and a server that scales to zero. A hosted harness is **a running
process with memory**, and it scales with the number of customers, not with the
number of queries. A customer who never asks a question still costs a process.

That is a different business from the one the plan describes, and the pricing has
to change with it: the free allowance becomes "one harness, a few thousand
retrievals a month" rather than "a thousand calls".

The alternative — **no hosted harness at all** — stays on the table: the MCP
server works with OpenCode, Claude Code, Cursor, and anything else that speaks
MCP, running on the user's own machine with the user's own keys. That is free to
us, and in a thin market it might be the bigger market: the people who already
run an agent harness are exactly the people who would want the corpus.

So the product has two shapes, and both should exist:

| | What it is | What it costs us | Who it is for |
|---|---|---|---|
| **The corpus** | an MCP server and a REST API | a rounding error per query | anyone with an agent |
| **The harness** | a hosted OpenCode, pre-wired | a process per customer | anyone who does not want to install anything |

The harness is the funnel and the corpus is the business.

## What this does not change

- The retrieval architecture. Vector-first, no reranker, citations resolved
  structurally. That was decided by measurement, not by the harness.
- The encoder. EmbeddingGemma 2, self-hosted, on Railway.
- The corpus model. Federal statutes and regulations, in force and repealed, with
  the citation that resolves.
- The licence regime. Three regimes, enforced at emission, and now enforced
  again in the harness as a hook rather than a prompt.
- BYOK. Still the customer's key and the customer's provider — now held by the
  harness rather than by our proxy.

## What it costs in effort

| | |
|---|---|
| The harness | a Railway service running the embedded OpenCode, the CivicSignal plugin, a thin branded shell over the UI |
| The plugin | the agent, the MCP wiring, the licence hook, the commands, the tool namespace |
| The MCP server | more tools, each carrying its licence rule in its description |
| The API | the BYOK chat endpoint becomes a fallback for callers who want an API rather than a harness |

## The thing to be careful about

If the harness is OpenCode's, the product can look like an OpenCode reseller. The
differentiation has to be in the data and in the pre-wiring: an agent that already
knows the corpus, cites its sources, says when the law does not cover the
question, and knows what changed last week.

That is a real moat and it is the one the corpus work has been building all along.
The harness is the frame around it, not a substitute for it.
