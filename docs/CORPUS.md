# The corpus model

What a row is, where it comes from, and why the obvious answer was wrong.

The corpus is `justicecanada/laws-lois-xml` — a git clone, published under the Open
Government Licence - Canada, no rate limits and no bot wall. It is the cleanest and
the most reproducible of the corpora, and the right first ingest.

```
bun run ingest:statutes -- --no-fetch     # parse the cached clone
bun run check:corpus-invariants            # the invariants below
```

## The numbers

| | |
|---|---|
| Instruments | 5,419 (971 Acts, 4,897 regulations, plus orders and proclamations) |
| Provisions | **138,750** |
| In force | 108,082 |
| Repealed | 19,010 |
| Placeholder | 11,658 — kept in the store, excluded from the index |
| Indexed (not a placeholder) | 127,092 |
| Text | 119.4M characters |

The number this document starts from is **138,750**, and it was **191,025** for a
while. The difference was a modelling error, and it is worth recording because the
error was invisible in every way that matters: the ingest reported no failures, the
row count was plausible, the tests passed, and the corpus looked fine.

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
instrument. There are 11,658 of them and every one has the same text, so embedding
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
