# The harness

Why the product embeds OpenCode rather than building a chat interface.

## The short version

The product is **not** a chat about Canadian politics. It is **the civic corpus,
with an agent in front of it**. OpenCode is that agent — its web UI is the
dashboard, its loop is the chat, its MCP client is already pointed at our MCP
server, and its model configuration is already BYOK.

That is not a shortcut around building a chat interface. It is a different and
better product, and it is the same product the retrieval work already pointed at.

## What OpenCode already gives us

| Surface | What we would otherwise build |
|---|---|
| The chat | multi-turn conversation, streaming, tool calls, reasoning, attachments |
| The dashboard | a session list, a file tree, a terminal, a diff view, a todo list |
| BYOK | provider keys, model switching, per-provider auth, OAuth flows |
| The agent loop | the tool-use loop, permissions, context management |
| The interface | an SDK, an HTTP API, SSE events, a remote TUI |

It is MIT licensed, and the seam is the SDK rather than the source:
`@opencode-ai/sdk` talks to `opencode serve` over HTTP.

The evidence that it is the right shape is that **OpenCode's own model is
BYOK**. Our requirement was "the caller supplies their own generation key". That
is not a feature we would build — it is how OpenCode already works, and the key
never has to touch our servers at all, which is strictly better than the BYOK
proxy the API has today.

## The licence rule moves into the tool contract

This is the part that improves the product rather than merely saving work.

The rule today — *a cite-only corpus may be quoted, never paraphrased, because a
paraphrase of Crown copyright is a derivative of it* — lives in a system prompt
in `src/chat.ts`. A system prompt is a string somebody will eventually soften.

In the harness it becomes **the MCP tool's description and its output schema**:
the tool says what it returns and under what terms, and the agent reads it as
part of the interface it was given. The rule becomes a property of the contract
rather than of a prompt.

Which means the MCP server stops being a secondary surface and becomes **the
primary one**. It has to be good:

- search the corpus, with the licence regime of each corpus in the tool description
- resolve a citation structurally, and say whether the provision is in force
- the change feed: what changed in federal law, and when
- coverage: what the corpus does *not* cover, so the agent can say so rather than
  guess

## Multi-tenancy

`PUT /auth/{id}` in the SDK takes a `directory` query parameter, and an OpenCode
server is directory-scoped — a directory is a project, with its own sessions,
config and credentials.

So the natural model is **one server, one directory per customer**:

- the customer signs in to CivicSignal;
- their provider key is stored by CivicSignal, encrypted, and written into their
  directory with `auth.set`;
- their CivicSignal key is wired into their directory's MCP config with
  `mcp.add`, pointing at `https://api.civicsignal/mcp`;
- their sessions, and only theirs, live in their directory.

`config.update` and `mcp.add` are both in the SDK, so all of this is scriptable
without touching OpenCode's source.

## The cost, stated plainly

This is the one thing that changes the economics, and it should not be glossed.

Today the product's marginal cost is retrieval: a rounding error per query on
Cloudflare, and a server that scales to zero. A hosted harness is **a running
process with memory**, and it scales with the number of customers, not with the
number of queries. A customer who never asks a question still costs a process.

That is a different business from the one the plan describes, and the pricing
has to change with it: the free allowance becomes "one harness, a few thousand
retrievals a month" rather than "a thousand calls".

The alternative — **no hosted harness at all** — is worth keeping on the table:
the MCP server works with OpenCode, Claude Code, Cursor, and anything else that
speaks MCP, running on the user's own machine, with the user's own keys. That is
free to us, and in a thin market it might be the bigger market: the people who
already run an agent harness are exactly the people who would want the corpus.

So the product has two shapes, and they should both exist:

| | What it is | What it costs us | Who it is for |
|---|---|---|---|
| **The corpus** | an MCP server and a REST API | a rounding error per query | anyone with an agent |
| **The harness** | a hosted OpenCode, pre-wired | a process per customer | anyone who does not want to install anything |

The harness is the funnel and the corpus is the business.

## What this does not change

- The retrieval architecture. Vector-first, no reranker, citations resolved
  structurally. That was decided by measurement, not by the harness.
- The encoder. EmbeddingGemma 2, self-hosted, on Railway.
- The corpus model. Federal statutes and regulations, in force and repealed,
  with the citation that resolves.
- The licence regime. Three regimes, enforced at emission, now expressed in the
  tool contract rather than in a prompt.
- BYOK. Still the customer's key and the customer's provider. Just held by the
  harness instead of by our proxy.

## What it costs in effort

| | |
|---|---|
| The harness | a container running `opencode serve`, the SDK wiring the directories, a thin branded shell over the web UI |
| The MCP server | more tools, and each one carrying its licence rule in its description |
| The API | the BYOK chat endpoint becomes a fallback for callers who want an API rather than a harness; it can call the MCP tools internally rather than reimplementing them |
| The dashboard | mostly OpenCode's; the CivicSignal layer is corpus coverage, the change feed, and billing |

## The thing to be careful about

If the harness is OpenCode's UI, the product can look like an OpenCode reseller.
The differentiation has to be in the data and in the pre-wiring: an agent that
already knows the corpus, cites its sources, says when the law does not cover
the question, and knows what changed last week.

That is a real moat and it is the one the corpus work has been building all
along. The harness is the frame around it, not a substitute for it.
