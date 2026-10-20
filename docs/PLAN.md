# CivicSignal — plan

> Situational awareness for Canada. One call returns what is in the news about a
> topic, how coverage tone is moving, which statutes are in force, what bills are
> moving, and what Parliament has said — every item cited to its official source.

A new product, not an extension of any existing one. It reuses the code and the
harvested data that already exist: the commercial spine from `riding-and-address`, the
Canadian news pipeline from the Policorner wire, the global press pipeline from
`gdelt-feed`, the statute corpus from the sovereign-corpus project, and the electoral
geography from `riding-and-address` and `electoral-atlas`.

## The thesis

There are six funded Canada-specific products in the civic-intelligence space
(MediaIQ, HillPulse, Hill Monitor, Gnowit, Dominion Dossier, PoliticalData) and a
long tail of global media-monitoring suites. Each owns one slice:

| | legislation | news | tone | geography | API | MCP |
|---|---|---|---|---|---|---|
| PoliticalData | ✅ | | | | ✅ | ✅ |
| RidingDesk | | | | ✅ | ✅ | ✅ |
| MediaIQ | | ✅ | ✅ | pages | | |
| HillPulse | ✅ | | ✅ | | planned | |
| Hill Monitor | ✅ | | | | | |
| GDELT (raw) | | ✅ | ✅ | | | |
| CanCoder | | | | ✅ | ✅ | ✅ |

**Nobody owns the join.** That is the product. A statute, a bill, a debate passage and
a news story are four separate documents that nobody has ever put in one answer, each
cited to its source, scoped to a riding or a province, on a fifteen-minute refresh.

The shape of the business is the shape of the sibling product: a metered HTTP API with
an embedded widget and an MCP server, prepaid credits, no subscription, and a free
usage-limited tier. The difference is that the unit of value is a *resolution* — a
brief — not a row.

## What is already built

Wave 0 of this plan is complete and in the repository.

- **The licence boundary, enforced in code.** `src/licensing.ts` strips every item to
  its corpus policy before it can be emitted. `src/corpora/policies.ts` declares eight
  corpora with the regime each source actually permits. `test/licensing.test.ts`
  asserts the boundaries: a cite-only corpus cannot emit a body, a metadata-only
  corpus cannot emit an excerpt, an unknown corpus is never emitted.
- **The corpus layer.** One adapter interface (`src/corpora/types.ts`), five adapters
  over D1 (`src/corpora/adapters.ts`), one registry (`src/corpora/registry.ts`).
- **The brief.** `src/routes/brief.ts` fans out across corpora, applies each policy,
  and reports which corpora contributed under which regime — so a caller can tell "no
  results" from "not covered".
- **The commercial spine.** Vendored from `riding-and-address` into `src/spine/`
  (keys, customer, usage ledger, billing), with provenance headers on every file.
- **The worker.** `src/index.ts` — authenticate, run, bill, respond. A billable unit
  is recorded only after a successful query, and the fuse decision gates the response.
  `scripts/check-billing-invariants.mjs` enforces that as a gate.
- **The MCP surface.** Three tools — `brief_topic`, `statute_lookup`,
  `debate_citations` — all `readOnlyHint`, each returning one complete answer.
- **Discovery.** `/.well-known/civicsignal.json` (capabilities, price, coverage,
  auth, error codes) and `/llms.txt`.

`bun run validate` is green: typecheck, 18 tests, billing invariants.

## Decisions taken

**Geography is a framing choice, not a fixed dimension.** (2026-10-20, owner.) It
depends on the issue and on how the client wants to frame it. So the brief takes an
optional `scope` — topic-only, or scoped to a riding, municipality, province or
region — and every corpus is filtered by it. A topic-only brief additionally reports
*where the topic is actually live*, so the client can see the distribution before
choosing how to frame the question. Geography is never switched on or off; it is a
lens the caller picks, and the answer includes the evidence for picking it.

**Retrieval is vector-first, and there is no reranker.** (2026-10-20, measured.)
The evaluation put 36 questions over 19,021 provisions: the vector arm found 14 of
18 ordinary-language questions against 3 for the keyword baseline, MRR 0.617 against
0.310. Equal-weight fusion got 12 and MRR 0.501 — it drags the strong arm down to
meet the weak one — and a sweep over the constant and the weight found nothing that
beats pure vector. Reranking the vector candidates *lowers* MRR to 0.560; it is a
precision tool with a hard ceiling, and the vector stage already returns the answer
in the top five for every exact question. So the product searches with vectors, does
not fuse, and resolves citations structurally rather than ranking them.

**The Policorner wire stays a separate product.** (2026-10-20, owner.) The wire is
reader-facing and keeps its own brand and audience. This product consumes its output
as a data source — shared pipeline and shared tables where that is useful, but no
shared brand, no shared account, and no shared surface. The wire's source policy
governs what may be republished, and this product's licence register is downstream
of it.

## The platform

**One host: Railway.** (2026-10-20, owner.) A Bun service, one Postgres, the
encoder, the pipeline and the harness, all on one private network — one bill, one
deploy, one failure domain.

The split between Cloudflare and Railway was inherited rather than chosen: the
spine came from `riding-and-address`, a Workers product, and the corpus could not
live in a Worker. What the code actually depends on is one KV namespace, one
Durable Object and `waitUntil`. Everything else is web-standard and native in Bun,
and the licence gate has no runtime imports at all.

The scale-to-zero argument for keeping the API on Workers is real but small: the
floor is Postgres, the API and the encoder, and the corpus plane pays that floor
either way. The decisive argument is the harness — it spawns processes, a Durable
Object cannot host it, and so the harness and the corpus are on the critical path
together.

The spine is shared with `riding-and-address`, so this is an extraction, not a
fork: a runtime-neutral core with a Cloudflare adapter and a Postgres adapter, which
is the shape the house conventions already call for.

`docs/PLATFORM.md` has the shape, the extraction, the order and the risk.

## Shared code

The licence regimes, the corpus interface and citation resolution are not this
product's — they are `@chester-hill-solutions/corpus`, upstreamed to the CHS
monorepo so every product serving public records declares its corpora the same way and
enforces the same rules. The enforcement lives in one place, so a new endpoint cannot
forget the rule.

What stays here is what is specific to this product: which corpora exist, their
fields, their queries, and the policy for each — because whether a given source is
open, cite-only or metadata-only is a fact about that source, and the package only
holds you to the conclusion you reached.

The retrieval machinery (BM25, the vector store, rank fusion) is the other candidate
for upstreaming, and it is deliberately **not** extracted yet: it has one consumer
and its API will move as the evaluation teaches us things. It goes upstream when the
evaluation settles and a second consumer appears.

## The waves

Each wave ends with something observable. The order is chosen so that the cheapest
test of demand happens before the most expensive work.

### Wave 1 — the 20-hour test (do this first)

**Nothing else starts until this does.** The research on this product is unusually
clear that the cheap kill is the expensive lesson: pull the source data, build three
endpoints, publish a free tier, list the MCP server, then wait sixty days.

**The statute half is done.** `scripts/ingest-statutes.ts` clones
`justicecanada/laws-lois-xml` (a git clone — no rate limits, no bot wall), parses it
into section rows and writes both a `.sql` file for D1 and a `.jsonl` snapshot.

| | |
|---|---|
| Documents parsed | 5,868 (971 Acts, 4,897 regulations) |
| Provisions with text | **138,750** (sections, order provisions, preamble clauses, and schedule chunks) |
| Of those, in force | 108,082 |
| Of those, repealed | 19,010 |
| Of those, a consolidation placeholder | 11,658 — kept in the store, excluded from the index |
| Distinct instruments | 5,003 |
| Languages | English (French is a `--lang fr` run) |
| Licence | Open Government Licence – Canada |

Two things the parser had to get right, both of which are silent failures otherwise:

- **Mixed content.** A provision that reads "cited as the
  `<XRefExternal>Act</XRefExternal>`." loses the cross-reference if you read the text
  from a parsed XML tree — the parser merges the child into the parent's text node. The
  text is therefore taken from the raw XML block, and every cross-reference survives.
- **Two instrument shapes.** An Act or regulation is a list of `<Section>` elements;
  an order is a list of `<Provision>` elements with lettered labels, a `<LongTitle>`
  instead of a `<ShortTitle>`, and no per-section page on the site. Lettered
  provisions cite the instrument's index page; numeric ones cite their own page.

**Do not fetch `laws-lois.justice.gc.ca` to verify citations.** The site serves 404s
to an IP that has been making sustained requests — the same failure the Statistics
Canada hosts exhibit. Every citation URL is *derived* from the corpus, never checked
by fetching it. The URL scheme was confirmed once, from the site's own regulation
index, and that is enough.

Still to do in this wave:

1. Ingest a slice of the news corpus into `news_items` from the existing wire.
2. Seed `hansard_speeches` with a few thousand passages *with excerpts only*.
3. `GET /api/brief?topic=housing` working end to end against D1.
4. Publish the free tier, list the MCP server in the official registry, Anthropic's
   directory, and Apify's pay-per-result store.

**The citation resolver is already written** (`src/citations.ts`). Running the keyword
baseline against the real corpus showed that "section 210 of the Canada Labour Code"
put the right answer at rank five, because a bare section number has almost no IDF
across 191,000 sections. A citation is a key, not a similarity, so it needs a
structural path ahead of both search arms. The parser reads "section X of the Y Act",
"s. X of the Y Act", "Y Act s. X" and bracketed subsections; the resolver returns
nothing rather than a near miss, because a citation naming a section the instrument
does not have is wrong, and the nearest section would be worse than no answer.

**Kill criterion:** if nobody calls it in sixty days, the gap was a data gap, not a
demand gap. Stop.

### Wave 2 — the ingest pipeline

Everything above is manual. This is where the product becomes real.

- `scripts/ingest-statutes.ts` — statutes and regulations → `statute_sections`.
  Section-level, bilingual, with `in_force` flags.
- `scripts/ingest-hansard.ts` — the existing XML archive → `hansard_speeches`.
  **Extracts an excerpt and a citation, never the full speech.** The full text stays
  in the research corpus.
- `scripts/ingest-news.ts` — reads the wire's output → `news_items`.
- `scripts/ingest-gdelt.ts` — polls GDELT on a fifteen-minute schedule → `gdelt_events`,
  with the tone metric.
- `scripts/ingest-bills.ts` — bill status and identifiers → `bills`. Status is a fact;
  bill text is not republished.
- A scheduled Worker handler drives the recurring ingests; a Queue absorbs backfill.

### Wave 3 — geography

- Join the corpora to riding and province. The machinery exists: `electoral-atlas` has
  validated areal-weighted joins, `riding-and-address` has the boundary registry.
- `GET /api/brief?riding=35047` scopes the news and debate to that riding.
- **Licence check first.** The Ontario poll-division shapefiles are Limited Use and
  cannot be used to derive a commercial data product. Riding boundaries are Open Use
  and are fine. Do not reach for poll-level geometry in Ontario.

### Wave 4 — the second layer

This is where the money is, and the research is unambiguous: **the free API is the
lead magnet; the revenue is one layer above it.** A data API with no second layer is
giving away its only asset.

Candidates, in order of fit:

1. **A briefing product.** A daily or on-demand brief for a defined policy area —
   the thing a government-affairs team, a think tank, or a campaign actually pays for.
   The API is the same infrastructure underneath.
2. **An embeddable widget.** A one-line `<script>` that renders "what is happening on
   this topic in your riding" for a campaign site, a newsroom, or a ministry. The
   cheapest distribution in the market is a widget a customer pastes into fifty sites.
3. **A bulk snapshot licence.** A per-election or per-quarter snapshot of everything,
   for organisations that would rather run their own analysis.

### Wave 5 — the MCP and agent surface

Already built; this wave is distribution.

- Submit the connector to Anthropic's directory (remote HTTPS, OAuth 2.0, a test
  account, `readOnlyHint` and `destructiveHint` on every tool).
- Publish to the official MCP Registry, and to the discovery directories.
- Publish an Apify Actor with pay-per-result pricing. Pay-per-result is the most
  reliable agent-adjacent revenue channel — the buyer is a developer with a card, and
  the unit is a result rather than a subscription.
- Keep the tool surface at three. Cloudflare's own MCP server uses search-and-execute
  Code Mode because 2,594 native tools cost ~1.17M tokens against ~1,000 for two.

### Wave 6 — the portal, if it is still wanted

Only after waves 1–5 have a customer. The portal is the crowded part of the market;
the API is the open part. If the portal is built, it is the lead magnet for the API,
not a competitor to it.

## The economics, stated plainly

- Marginal cost per request on Cloudflare Workers is about **$0.0004**. At a $0.005
  unit price that is roughly 92% gross margin. Infrastructure is not the constraint.
- Stripe Canada charges 2.9% **plus CA$0.30** per card transaction, so a $0.01 call
  cannot be sold one card charge at a time. Prepaid credits or Stripe Billing
  pay-as-you-go (0.7% of volume) only. The spine already does prepaid credits.
- A single-purpose Canadian civic API realistically caps at **$2k–15k MRR** unless
  there is a second layer. That is the number to plan against.
- The free tier must be **usage-limited, not time-limited**. A developer who searches
  two hundred times should not hit a wall.

## Open questions

1. ~~Is the geography a first-class dimension or a filter?~~ **Decided.** Geography is
   a framing choice the caller makes; see *Decisions taken*.
2. **Which is the first province beyond federal?** Ontario is the obvious one — the
   corpus, the wire and the geography all exist — but provincial legislative terms
   vary and each needs its own licence check.
3. ~~Does the news wire stay a separate product?~~ **Decided.** It stays separate; see
   *Decisions taken*.
4. **What is the name?** The working name in this repository is provisional.
5. **What is the second layer?** The candidates are listed in wave 4. The choice
   depends on the answer to the twenty-hour test: who calls, and what they call for.

## What would change the plan

- A licence question that turns out to be narrower than the register assumes — in
  particular, whether the Reproduction of Federal Law Order extends to the right to
  communicate to the public. That would let statutes be served with less ceremony.
- A competitor moving into the join. HillPulse has an API planned; PoliticalData has
  the statute graph and an agent surface. The join is open today, not open forever.
- Sixty days of no calls on the free tier. Then stop.
