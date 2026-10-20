# The corpus model

What a row is, where it comes from, and why the obvious answer was wrong.

The corpus is `justicecanada/laws-lois-xml` — a git clone, published under the Open
Government Licence - Canada, no rate limits and no bot wall. It is the cleanest and
the most reproducible of the corpora, and the right first ingest.

```
bun run ingest:statutes -- --lang en --out dist   # parse the cached clone
bun run ingest:statutes -- --lang fr --out dist   # and the other official language
bun run check:corpus-invariants                    # the invariants below
```

The two languages write their own files — `dist/statutes.sql` and
`dist/statutes-fr.sql` — because they are separate rows in one table and the
English output is 281 MB. Writing the French over the English would look like
success.

## The numbers

The corpus is bilingual. Canada's statutes are enacted in both official languages
with equal legal force, and the source publishes both.

| | English | French | Total |
|---|---|---|---|
| Instruments | 5,198 | 5,206 | 10,404 |
| Provisions | 138,750 | 139,107 | **277,857** |
| In force | 108,082 | 108,481 | 216,563 |
| Repealed | 19,011 | 19,097 | 38,108 |
| Placeholder | 11,657 | 11,529 | 23,186 |
| Indexed (not a placeholder) | 127,093 | 127,578 | 254,671 |
| Text | 119.4M characters | 124.4M characters | 243.8M |

The two languages mirror each other almost exactly, and that is the check: a
French corpus with 19,097 repealed provisions against an English one with
19,011 is a corpus whose French half was parsed by the same rules. When the
French had **one**, it was not.

The number this document starts from is **277,857**, and it was **138,750** for
a while — the English half alone. It was **191,025** before that. The first
difference was a modelling error, and it is worth recording because the error
was invisible in every way that matters: the ingest reported no failures, the
row count was plausible, the tests passed, and the corpus looked fine.

## The two languages are two corpora in one table

This is the part that has consequences, so it is stated plainly.

**The two official versions of a provision are different rows with different
identifiers.** The English section 210 of the Labour Code is `acts-en-…`; the
French article 210 of the Code du travail is `acts-fr-…`. They do not share a
row id, and they do not share a LIMS id either — the two language trees number
their provisions from different id spaces, which was measured rather than
assumed.

That means a corpus holding both is not a corpus with a translation problem. It
is a corpus with an **ambiguity problem**: one provision, two rows, and no way
for the caller to say which one they meant. A search that returns both fills
half its top k with the wrong language, and an exact citation lookup that
returns both hands the caller a choice where a citation is supposed to remove
one.

So the language is a **lens the caller chooses**, exactly like the geography:
`CorpusQuery.language` filters the rows, `cite_provision` and `statute_lookup`
take it as an argument, and the chat and MCP surfaces infer it from the
question when they are not told. The inference is a heuristic — French
function words and accented characters, matched as whole words so that "la"
inside "legal" is not evidence — and it is asymmetric on purpose: English is
the default everything falls back to, and French is the language with
*distinctive* markers, so a single French instrument title among an English
question is enough to make the answer French.

That last part matters more than it looks. "What does the Code du travail say
about leave?" is a question about the French Labour Code, and answering it from
the English rows answers a different question.

### The accents come off, on both sides

The lexical path compares the query against the corpus's `search_text` with
LIKE. A French provision says `règlement` and the person typing the query
writes `reglement`, because the keyboard has no accent key or the word was
copied from an English source. Both sides are therefore folded — the corpus's
`search_text` and the query's pattern — so that a match means the same thing
on both sides. Folding one side only would make them disagree in exactly the
case the fold is for.

The vector path does not have this problem. A model reads `règlement` and
`reglement` as the same word, which is one of the things a model is for.

### A repeal marker is a repeal marker in both languages

The status of a provision is read from its text, and the marker differs by
language:

| English | French |
|---|---|
| `[Repealed, SOR/2010-20]` | `[Abrogé, DORS/2010-20]` |
| `[Repealed]` | `[Abrogée]`, `[Abrogés]` |
| `[Repeal]` | `[Abrogation]` |

Reading only the English ones does not fail loudly. It labels nineteen
thousand French repealed provisions as *placeholders*, and — because `in_force`
is derived from the same call — leaves them with `in_force = 1`, so the corpus
reports repealed law as live law and a citation to it answers with the wrong
thing.

Two details make this a trap worth recording. The first is that JavaScript does
not consider `é` a word character, so a `\b` after the French marker asks for a
boundary that is never there and every French repeal reads as a placeholder
however carefully the alternation is written. The second is that the corpus
also contains English provisions whose *text* quotes a French marker, so the
rule cannot be scoped to the file a row came from.

## What a row is

The corpus uses four kinds of block, and they are not the same thing.

| Block | What it is | Is it a row? |
|---|---|---|
| `Body/Section` | a numbered section — "section 210 of the Canada Labour Code" | yes, a **section** |
| `Order/Provision` | a provision of an order; an order has no numbered sections | yes, a **provision** |
| `Introduction/Preamble/Provision` | a "whereas" clause of an Act | yes, labelled `Preamble 1` |
| `Schedule/…/Provision` | a list item in a schedule | no — it belongs to the **schedule** |
| `Schedule/BillPiece/RelatedOrNotInForce/Section` | the *amending bill's* own section | no — **not law at all** |

### Schedule items are not sections

This was the error. A schedule's entries are `<Provision>` elements, and the parser
was emitting every one of them as a section. A regulation can have hundreds of
entries labelled "(a)", so one instrument produced **416 rows labelled "(a)"**, all
with the same id, all citable to the same URL, none of them a section.

Schedules are now indexed as the schedule — one unit, chunked so that no chunk is too
large to embed — with the chunk's number in `part` and the schedule's label in
`schedule`.

### A bill's own sections are not the Act's sections

`Schedule/BillPiece/RelatedOrNotInForce/Section` records the sections of the bill
that amended the instrument, so the site can say which provisions are not in force.
Indexing them put a hundred copies of the *bill's* section 2 into the Act's section 2.
They are excluded.

### A placeholder is not a provision

`[Amendment]` means the provision exists but its text lives in an amending
instrument. There are 23,186 of them — 11,657 in English and 11,529 in French — and
every one in a language has the same text, so embedding
them puts eleven thousand identical vectors into the index and crowds everything
else out.

They stay in the store — a citation to section 17 has to resolve to something — and
they stay out of the index. The `status` column carries the distinction:

- `in-force` — the law
- `repealed` — it was law and is not any more
- `placeholder` — a gap in the consolidation

A repealed provision is worth keeping and worth finding. The useful answer to "what
does section 9 say" is sometimes "it was repealed in 2010", and a corpus that cannot
say so has thrown the answer away. The citation path looks for repealed provisions
too, and reports the status rather than returning nothing.

## Identity

A row's id is the **LIMS id** — the corpus's own identifier for a provision.

It is unique across all 1,128,174 provisions in the corpus, and it survives
re-consolidation: when an Act is re-enacted the provision keeps its id and its text
changes. That is exactly the property an index wants, because it makes "what did
this section say before the last amendment" a question the id can answer.

The readable form — instrument and label — is *not* unique, and the corpus is full
of proof:

- an amending regulation can have seventeen provisions all labelled "169.1", each
  amending a different instrument;
- two schedules in one instrument can both be "SCHEDULE II";
- 416 different instruments are called "Contraventions Regulations".

The **citation** column carries the instrument's own citation ("A-1", "C-34",
"SOR-96-313"), which is what identifies a document. The display title does not.

## Structure from the tree, text from the raw XML

Two passes, because the corpus needs both and neither parser does both well.

**The tree decides what a unit is.** The corpus is machine-generated and deeply
regular, and its structure is the whole meaning of it. The parser scans the raw XML
for every element's span and ancestry, and decides from that.

**The raw XML decides what the text is.** A provision that reads "cited as the
`<XRefExternal>`Act`</XRefExternal>`." is mixed content, and a DOM parser merges the
child into its parent's text node and silently drops the cross-reference. So the
text is sliced out of the source between two offsets, and only the *structure* is
taken from the tree.

The one subtlety: **a path says what an element's ancestors are, not which of them
it is inside.** Two sections both have the path `Body/Section`, so a lookup by path
alone finds the first section's label for both. Every structural lookup therefore
checks containment as well as ancestry.

## The invariants

`bun run check:corpus-invariants` establishes:

1. **the schema and the insert agree** — the ingest writes sixteen columns and the
   table has sixteen. This one had been wrong since the first ingest: `citation` and
   `language` were written but never declared, so `dist/statutes.sql` could not be
   loaded against the migrated database.
2. **every row id is distinct** — the store's primary key, the vector index's key and
   the citation lookup's key. A collision means one row silently replaces another.
3. **every row has a status** — so "repealed" and "placeholder" cannot be lost.
4. **the index manifest names rows the corpus has**, and holds no placeholder.

Each was verified by planting the violation and watching the check fail.
