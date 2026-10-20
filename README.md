# CivicSignal

> Situational awareness for Canada. One call returns what is in the news about a
> topic, how coverage tone is moving, which statutes are in force, what bills are
> moving, and what Parliament has said — every item cited to its official source.

A new product, reusing the code and harvested data that already exist across the
estate: the commercial spine from `riding-and-address`, the Canadian news pipeline
from the Policorner wire, the global press pipeline from `gdelt-feed`, the statute
corpus from the sovereign-corpus project, and the electoral geography from
`riding-and-address` and `electoral-atlas`.

**This is not a portal.** Six funded Canada-specific products already own the portal
(MediaIQ, HillPulse, Hill Monitor, Gnowit, Dominion Dossier, PoliticalData). The
thing nobody owns is the *join* — statute, bill, debate and story in one answer, each
cited, scoped to a riding or a province, on a fifteen-minute refresh. So the product is
a metered API with an embeddable widget and an MCP server, and the portal is wave 6,
if it is still wanted.

## Status

Wave 0 is complete: the licence boundary, the corpus layer, the brief, the commercial
spine, the worker, the MCP surface and machine-readable discovery.

```
bun run validate      # typecheck + tests + billing invariants
bun run test          # 18 tests
bun run check:billing-invariants
bun run dev           # wrangler dev
```

## The one thing to read first

**`docs/LICENCE-REGISTER.md`.** Every corpus sits under a different reproduction
regime, and the differences are not academic. Statutes are Open Government Licence
and may be reproduced commercially. Debates are Crown copyright and may only be cited
— short excerpt, speaker, date, link — never republished. News is headline and link
only.

That boundary is not a convention. It is enforced in code:

```ts
// src/licensing.ts — an item is stripped to its policy before it can be emitted.
export function emitCorpusItem(policy: CorpusPolicy, raw: RawCorpusItem): CorpusItem
```

`src/corpora/policies.ts` declares the regime for each corpus; `test/licensing.test.ts`
fails if a cite-only corpus can emit a body, or a metadata-only corpus can emit an
excerpt.

## Surfaces

| | |
|---|---|
| `GET /api/brief?topic=housing&jurisdiction=ON` | The join: news, tone, statutes, bills, debate |
| `GET /api/statutes?topic=housing` | Statutes and regulations in force, with section text |
| `GET /api/news?topic=housing` | News items and the tone series |
| `GET /api/bills?topic=housing` | Bills and their stage |
| `GET /api/debates?topic=housing` | Cited debate passages |
| `GET /mcp` | Remote MCP server — `brief_topic`, `statute_lookup`, `debate_citations` |
| `GET /.well-known/civicsignal.json` | Capabilities, price, coverage, auth, error codes |
| `GET /llms.txt` | Agent-facing summary |

Authentication is a Server API key: `Authorization: Bearer sk_…`. Errors never count
against the allowance; failed lookups become account credit.

## Layout

```
src/
  licensing.ts          the boundary: policies, emission, truncation
  corpora/
    policies.ts         the eight corpora and their regimes
    types.ts            the adapter interface
    adapters.ts         five adapters over D1
    registry.ts         which corpora answer which section
  routes/
    brief.ts            the join
    capabilities.ts     discovery
  mcp/server.ts         three tools
  spine/                vendored from riding-and-address (see docs/PLAN.md, wave 1)
  index.ts              the worker
docs/
  PLAN.md               the plan, the waves, the economics, the kill criteria
  LICENCE-REGISTER.md   what may be reproduced, and why
```

## The plan

`docs/PLAN.md`. It starts with the twenty-hour test, because the cheapest thing to
learn is whether anyone wants this.

## Licence

The product's own licence is not set. The corpora it serves are reproduced under
their own terms, each of which is recorded in the register and enforced in code.
