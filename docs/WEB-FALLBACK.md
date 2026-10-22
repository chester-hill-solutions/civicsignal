# The web fallback

When the corpus has nothing, the product looks further afield, and when that
comes up empty it says so.

```
corpus (the semantic arm)  →  web (authoritative sources)  →  "I don't have information on that"
```

This is the shape of the answer, not just of the retrieval. The middle step
is a set of **named sources**, each of which is authoritative for something,
and the last step is a refusal that is true.

## The corpus is already the authoritative source

Before anything else: the corpus **is** the Justice Laws Website.
`justicecanada/laws-lois-xml` is the Department of Justice's own repository,
publishing the consolidated Acts and regulations as XML, and the site's own
[data dictionary](https://laws-lois.justice.gc.ca/eng/XML/index.html)
documents the schema the pipeline parses. The site's words are that it is
"the online source of the consolidated Acts and regulations of Canada" and that
"both language versions being equally authoritative".

So the web arm is **not** for federal statutes. The corpus holds them, it
holds them from the publisher, and it holds them in the machine-readable form
the publisher publishes. Searching the web for them would be searching the
thing we already have, less well.

The web arm is for what the corpus does not hold:

| source | what it is | authority | the licence position |
|---|---|---|---|
| **decisions.scc-csc.ca** | Supreme Court of Canada judgments | the Court's own site | Crown copyright; the Court's own publication |
| **decisions.fct-cf.gc.ca** | Federal Court, Federal Court of Appeal, Tax Court, and the tribunals | each court's own site | Crown copyright |
| **canada.ca — Canada Gazette** | Part I the enacted texts, Part II the notices and regulations | the official gazette | Crown copyright; the gazette *is* the authoritative publication of what was enacted |
| **parl.ca — Hansard** | the debates of the House and the Senate | the official record of Parliament | Crown copyright; authoritative for what was said, not for what the law is |
| **each provincial legislature's own site** | provincial statutes, regulations and gazettes | e-laws, legisquebec, bclaws, ontario.ca and their equivalents | Crown copyright; the province's own publication |
| **laws-lois.justice.gc.ca** | the consolidations, and their **previous versions** | the Department of Justice | Crown copyright — **and the corpus already is this** |

Two things about that list are worth stating plainly.

**The consolidations carry a "current to" date, and it moves.** The corpus's
`asOf` should come from that date and not from when we ingested — a
consolidation that was current to the 15th is current to the 15th forever,
even as the corpus moves on.

**CanLII is not in that list.** It has the material — tens of thousands of
SCC and Federal Court decisions, and every statute — but it *republishes* the
consolidations, having "put them together based on materials available on the
Justice Laws Web Site", and its own content is copyrighted to CanLII with its
own terms. Treat it as a discovery index and a citation target — a place to
find a document, and a place to point a reader — rather than a source to copy
from, and read its terms before automating anything against it.

## What "authoritative" has to mean operationally

A word like that does not survive contact with a crawler. The test has to be
mechanical, and it is a property of the *source*, not of the document it
returned:

1. **The domain is the publisher's.** `laws-lois.justice.gc.ca` and
   `canada.ca` are the Government of Canada; `decisions.scc-csc.ca` is the
   Supreme Court; `parl.ca` is Parliament. A document served from a
   *republisher* is not authoritative however authoritative the page looks.
2. **The document identifies itself** — a citation, a date, an instrument
   number — and the identification is checkable against the corpus where the
   corpus covers it.
3. **The publisher says what it is.** The Department of Justice publishes an
   "Official Status of the Consolidation" note explaining the status of the
   consolidations, their reproductions, and their interpretation and
   application. That note is the authority for the authority, and it is the
   thing to read before deciding what the product may claim about a document
   it fetched.

A search result that fails any of these is not a fallback. It is a link.

## The extraction contract

The corpus is XML. A decision is HTML, and a gazette notice is HTML, and the
difference between them is where the honesty lives. What the web arm produces
is not text — it is an **excerpt with a provenance**:

- the **url** it came from, and the **retrieved-at** date;
- the **publisher** — the domain, and the human name of the body ✓;
- the **document's own citation and date** ✓ (a case name and its date, an
  instrument's number and its registration date, a gazette issue and its
  part) ✓;
- the **passage**, verbatim ✓ — never paraphrased, never summarised into the
  product's voice ✗;
- the **extent of the passage** ✓ — a section, a paragraph, a page ✓.

And the passage is what the licence gate sees. The gate is the reason the
corpus is safe to serve, and it has to be the reason the web arm is safe to
serve: every fetched document becomes a corpus with its own policy, and the
policy is applied before anything is returned. A source without a policy
returns nothing — not "everything, probably fine".

## The search is the open question

Something has to find the candidate documents. The corpus's semantic arm
cannot, because it only knows what is already indexed — and the decisions and
the gazette are published continuously, so a pre-built corpus would be stale
by definition.

This is the one place the product leaves its own platform, and it should be
chosen with that in mind: an API with a published, stable, priced interface
beats a scraper of a search engine's results page, which is both brittle and
a licence question in itself. A second question rides along with it: whether
the web arm indexes what it finds, or fetches and cites it on demand. The
first makes it a corpus and gives it a snapshot; the second is simpler and
slower and cites pages that may have changed since.

## The last fallback

"I don't have information on that" is a *product behaviour*, and it has to be
true rather than cautious. It is true when the corpus found nothing, the web
sources were searched, and nothing authoritative came back — which is
different from "the retrieval was not confident" and different again from
"there is an error". The refusal must distinguish them, because a product that
says "I don't have information on that" when it means "something broke" is
worse than a product that says nothing.

And it must be **safe to say**. The failure mode of a legal product that
answers when it should not is a citation to the wrong provision, or to a
repealed one, or to a page that has since changed. So the refusal is not a
fallback for uncertainty — it is the *correct answer* when the corpus and the
authoritative web have both come up empty, and the product should be willing
to give it.
