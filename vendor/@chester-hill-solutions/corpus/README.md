# @chester-hill-solutions/corpus

Licence-aware corpora: reproduction regimes, an enforcement gate, and citation
resolution for public records.

## Why this exists

Public records are not all equally reusable. Some are open for commercial
redistribution. Some may be quoted and cited but never republished. Some may only
be referenced by title and link. A service that mixes them without knowing which
regime each sits under is a legal exposure, and the failure is silent: the
response looks correct, and it is not lawful to send.

So the regime is declared once per corpus, and enforced at emission. A corpus
declared `cite-only` cannot have its body returned no matter which route, tool or
caller asks for it, because the stripping happens in one place rather than at every
call site. A new endpoint that forgets the rule is a bug; a new endpoint that
cannot break the rule is not a bug you have to remember not to write.

## When to use it

- You serve a body of public record and need to know what you may legally return
  from it.
- You are adding a second product over the same sources and want one definition of
  each corpus's regime rather than two.
- You handle legal questions where the user gives you a citation
  ("section 210 of the Canada Labour Code") rather than a question.

## What it is not

- **Not a licence database.** It does not tell you what a licence permits. It
  records the conclusion you reached, and enforces it. Reading the source's terms
  and writing the policy is your job; the package only holds you to it.
- **Not a retrieval engine.** It has no index, no vectors and no ranking. It is the
  layer *under* retrieval: what you are allowed to return once retrieval has
  chosen something.
- **Not a storage layer.** It does not know about databases, R2 or D1. A corpus
  adapter is free to read from wherever it likes; the package only defines the
  shape of a query and of a context.
- **Not jurisdiction-specific.** The regimes are general. Whether a given source
  is open, cite-only or metadata-only is a fact about that source, and you supply
  it.

## The regimes

| Regime | What the source permits | What this package lets you emit |
|---|---|---|
| `open` | Reproduction, including commercial use | Full text, with attribution |
| `cite-only` | Personal and non-commercial reproduction with attribution | Short excerpt, plus a link to the official source |
| `metadata-only` | Reference by title, timing and link | Title, outlet, timestamp, link |

## Using it

Declare a policy per corpus, then emit through it:

```ts
import { emitCorpusItem, type CorpusPolicy } from "@chester-hill-solutions/corpus";

const HANSARD: CorpusPolicy = {
  id: "hansard-federal",
  title: "House of Commons debates",
  publisher: "House of Commons of Canada",
  licence: "Crown copyright (federal) — non-commercial reproduction with attribution",
  licenceUrl: "https://www.canada.ca/en/transparency/terms.html",
  redistribution: "cite-only",
  attribution: "Source: Debates (Hansard), House of Commons of Canada.",
  conditions: ["Quoted as excerpts with a citation to the official text."],
  excerptMaxChars: 400,
  allowFullText: false,
  requireSourceLink: true,
};

const item = emitCorpusItem(HANSARD, {
  corpusId: HANSARD.id,
  kind: "debate",
  id: "h-177",
  title: "Debate on housing",
  body: "…the full speech…",   // dropped: cite-only
  excerpt: "We must build more homes.",
  citationUrl: "https://www.ourcommons.ca/…",
  source: "House of Commons of Canada",
});

item.body;      // undefined — the body is not emitted
item.excerpt;   // "We must build more homes."
item.attribution; // the full attribution, licence and conditions
```

A `cite-only` corpus with `excerptMaxChars: 0` emits neither body nor excerpt. A
`metadata-only` corpus emits neither, even if `allowFullText` or a positive excerpt
cap contradicts that regime. Flags can further restrict a regime, never widen it.
Caps must be finite, nonnegative safe integers; invalid caps throw `RangeError`.
The regime in force is on every emitted item.

`raw.extra` is arbitrary adapter data, so it is emitted only for `open` corpora.
Both restricted regimes discard it, including nested data. A `cite-only` corpus
may retain the explicit topics, entities and sentiment fields; a `metadata-only`
corpus discards those derived fields as well. It retains reference metadata:
identifier, kind, title, official link, publisher, publication time, language and
jurisdiction, together with policy attribution.

Those named metadata fields and the policy attribution are a trusted adapter
boundary. Adapters must not hide source passages in a title, identifier, publisher
or other metadata field. Structural stripping cannot determine whether a
publisher label is really mislabeled article text.

## Citations

A legal question is often a citation, and a citation is a key rather than a
similarity — running one through a search index puts the right answer at rank
five, because a bare section number has almost no IDF across a large corpus.

```ts
import { actTitles, parseCitation, resolveCitation } from "@chester-hill-solutions/corpus";

const acts = actTitles(rows);
const match = parseCitation("What does section 210 of the Canada Labour Code say?", acts);
// match.citation.act === "Canada Labour Code", match.citation.section === "210"

const row = resolveCitation(match.citation, rows); // null if the section does not exist
```

Supported forms are `section 210 of the Canada Labour Code`,
`210 of the Canada Labour Code`, and `Canada Labour Code s. 210`, including decimal
and nested subsection labels. The instrument must be a full known title adjacent
to its provision. Case and whitespace may differ; arbitrary title suffixes,
shared words and shortened names are not inferred. A query naming different
instruments or provisions is ambiguous and returns `null`.
Pass bare-number and instrument-first citations as standalone citations. This
recognizes citation forms conservatively; it is not a general legal-language parser.

`resolveCitation` requires one exact instrument/provision row. Title case and
whitespace and spacing around subsection parentheses are normalized; spaces
inside numeric labels are never collapsed. It returns `null` for a missing or ambiguous row rather
than choosing the nearest provision, a similarly named instrument or the first
language variant. Filter rows to the intended language and corpus scope before
resolving a citation.

Earlier draft consumers that relied on implicit partial titles must now supply a
canonical title. Resolve any product-specific aliases explicitly before this
boundary. `actConfidence` is always `exact`; its historical `partial` type member
is retained for compatibility and is no longer emitted.

## Conventions

- **C1 — runtime-neutral.** This package contains no SQL, no `drizzle-orm`, no
  `postgres`, no `node:*`, no `Buffer` and no `process.env`. A corpus adapter
  holds the queries; this package holds the rules.
- **C7 — this README says what the package is not**, above, because the failure
  mode of a package like this is being used for something it cannot do.

## Licence

MIT.
