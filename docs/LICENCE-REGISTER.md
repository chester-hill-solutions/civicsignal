# Licence register

Every corpus this product touches, the reproduction regime its source actually
permits, and what that means for what leaves the building.

**This document and `src/corpora/policies.ts` are the same fact in two forms.** The
TypeScript is the enforcement point — `src/licensing.ts` strips an item to its policy
before it can be emitted, so a route cannot leak a corpus it has no right to
redistribute. If you change one, change the other. The test suite in
`test/licensing.test.ts` asserts the boundaries hold.

## The short version

| Corpus | Regime | Commercial? | What we may emit |
|---|---|---|---|
| Federal statutes and regulations | Open Government Licence – Canada | **Yes** | Full section text, with attribution |
| Ontario statutes and regulations | Crown copyright — reproduction permitted | **Yes** | Full section text, with attribution |
| Federal and provincial election results | Open Government Licence – Canada | **Yes** | Full data |
| House of Commons debates (Hansard) | Crown copyright | **No** | Short excerpt + speaker + date + link |
| Senate debates (Hansard) | Senate reproduction terms | **No** | Short excerpt + speaker + date + section link |
| Provincial legislative debates | Crown copyright | **No** | Short excerpt + speaker + date + link |
| Canada Gazette | Crown copyright, mixed provenance | **No** | Metadata only |
| Bill status and identifiers | Crown copyright | Metadata only (facts are not copyrightable) | Identifiers, sponsor, stage, dates, link |
| News headlines and metadata | Per-publisher terms | Metadata only | Headline, outlet, timestamp, link |
| GDELT global press monitor | GDELT terms, attribution required | Metadata only | Headline, timestamp, link, tone |

## The two that decide the product

### Statutes — clean, and the reason the product is sellable

The **Reproduction of Federal Law Order** (SI/97-5, P.C. 1996-1995, 19 December 1996)
is an Order in Council under s.12 of the Copyright Act that grants blanket permission
to reproduce primary legal information:

> Anyone may, without charge or request for permission, reproduce enactments and
> consolidations of enactments of the Government of Canada, and decisions and reasons
> for decisions of federally-constituted courts and administrative tribunals, provided
> due diligence is exercised in ensuring the accuracy of the materials reproduced and
> the reproduction is not represented as an official version.

There is no fee and no permission requirement, and the Order is not limited to
non-commercial use. Two conditions attach: exercise due diligence on accuracy, and do
not represent the reproduction as an official version. Both are enforced by the
`attribution` string on the corpus policy.

Ontario's position is equivalent: the Government of Ontario permits any person to
reproduce the text and images of statutes, regulations and judicial decisions without
seeking permission and without charge, provided the copy is accurate, is not
represented as an official version, acknowledges Crown copyright, and carries the
notice that it is an *"unofficial version of Government of Ontario legal materials."*
Yukon and Nunavut grant comparable permission. Other provinces set their own policies
and must be checked individually before their material is added.

**Known ambiguity, recorded honestly:** the Order permits *reproduction*. Whether it
extends to the separate copyright right to *communicate to the public* — and whether it
extends to Canadian law accessed from outside Canada — is not settled. The Order also
does not cover provinces or municipalities. We therefore attribute, we link to the
official source for every item, and we do not present any output as the official text.

### Debates — the boundary that shapes the design

Use the House Speaker's permission for federal Hansard. It permits accurate
non-commercial reproduction presented as unofficial. The general permission
excludes commercial use. The Office of the Speaker accepts written applications
for authorization. The House publishes XML as open data, subject to the source's
reuse terms. [House terms](https://www.ourcommons.ca/en/important-notices) ·
[House open data](https://www.ourcommons.ca/en/open-data)

The Senate publishes separate terms permitting accurate, unofficial reproduction and
excluding use for financial gain. The local Senate adapter applies its own `cite-only`
policy and links to the official transcript section. Commercial use remains a D-08
decision. [Senate terms](https://sencanada.ca/en/intellectual-property/)

Ontario is explicit: the Speaker's permission covers using excerpts "without charge"
for uses that are "reasonable, fair and non-commercial, and must credit the Assembly."
**Non-commercial only.**

CivicSignal's debates policy is `cite-only`. It retains the speaker, sitting date,
and official citation. Where excerpt use is permitted, the adapter can return
up to 400 characters of attributed text. The cap is CivicSignal's product limit.
Commercial plans for indexing and excerpt delivery need a documented basis for
the intended use. Confirm that basis before publishing a commercial Hansard feature.

The local importer stores short excerpts. The shared corpus policy excludes full
speech bodies from cite-only responses.

## News

RSS and page-watch feeds are governed by each publisher's terms, and they vary. The
news corpus is `metadata-only`: headline, outlet, timestamp, link, and whatever
classification we derived. Article text is never fetched, stored, or returned.

The wire already has a source policy (`feeds/sources.yaml` in the news pipeline), and
it is the right place to record which feeds permit what. A feed that forbids
aggregation is removed from the feed list, not filtered at emission time.

GDELT is a special case: it never provides article text at all — only headlines and
metadata — so there is nothing to republish. Its terms require attribution, which the
`gdelt` corpus policy carries.

## The Gazette

Canada Gazette notices are Crown copyright, but a Gazette notice can include material
submitted by private parties (public notices, applications), for which Crown copyright
is not assured. The Gazette is therefore `metadata-only` until the provenance of each
notice type is settled, and the ingest job must record which part of the Gazette a
notice came from.

The Gazette preview stores edition metadata, record titles, official links and
explicitly sourced dates. The API applies the `canada-gazette` metadata-only
policy. Hosted source use and refresh frequency remain open under D-08.

## What is deliberately excluded

- **Press journalism** (CBC and others). Excluded by policy in the corpus audit, and
  excluded here. The product is built on official public records, not on other
  people's reporting.
- **The Dictionary of Canadian Biography** — the terms of that work are non-commercial.
- **The Lahman baseball dataset** — research and non-commercial use only.
- **Ontario poll division boundaries** — the Elections Ontario poll-division shapefile
  product is under a *Limited Use* licence that forbids using it to derive another
  data product for distribution or commercial sale. Election *riding* boundaries are
  Open Use and fine. This is why the Ontario products in this repo carry riding-level
  geography, not poll-level.
- **Individual-level political data** — voter files, donor enrichment, scraped contact
  lists. These are not a corpus of this product under any circumstances.

## Rules for adding a corpus

1. Read the source's terms. Do not paraphrase them from a blog post.
2. Record the finding in this document, with a URL and the date it was read.
3. Declare the policy in `src/corpora/policies.ts` with the regime the terms actually
   permit — `open`, `cite-only` or `metadata-only`.
4. Add a test in `test/licensing.test.ts` that fails if the item can emit more than
   its regime allows.
5. If the terms are ambiguous, choose the more restrictive regime until they are not.
