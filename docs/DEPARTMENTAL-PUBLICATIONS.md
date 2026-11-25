# Departmental publications — ECCC

The first departmental increment inventories Environment and Climate Change Canada's two publication series and archives the original files it can retrieve. Use the [master plan](PLAN.md#eccc-implementation-scope) for the extraction and API work order.

## Source

| Series | English index | French index |
| --- | --- | --- |
| Evaluations | `https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/evaluations.html` | `https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/evaluations.html` |
| Internal audits | `https://www.canada.ca/en/environment-climate-change/corporate/transparency/priorities-management/internal-audits.html` | `https://www.canada.ca/fr/environnement-changement-climatique/organisation/transparence/priorites-gestion/audits-internes.html` |

Each index groups works by fiscal year. A work is a title with one or more links (summary, report, plan, PDF). Editions are paired only through the publisher's explicit `hreflang` alternate; translated titles are not used to merge identities.

## Run the intake

```sh
python3 -B scripts/eccc-intake.py \
  --root data/corpus/eccc \
  --db data/corpus/eccc/catalogue.sqlite \
  --receipt dist/eccc/inventory.json \
  --workers 1
```

`--from-cache` replays the archived copies without fetching. The run is transactional and refuses an observation older than the stored cutoff. Originals are content-addressed under `data/corpus/eccc/objects`; the download cache records the published URL, final URL, media type and size.

The intake is deliberately sequential (`--workers 1`). canada.ca resets HTTP/2 streams under parallel load, and the polite crawler user agent is `civicsignal.ca research crawler (info@civicsignal.ca)`. A plain HTTP/1.1 fallback keeps a body that ends with its closing HTML tag or PDF EOF marker, and only when the final URL is a Government of Canada host. Legacy `http` catalogue links are fetched over `https` while the published URL stays the citation.

## November 25 passage verification

The second live intake reported no content changes. The serving build again produced 64,174 passages from 234 document editions. An independent offline rebuild reproduced every passage row, including its text, citation, and content and source hashes. Verification covered all 222 distinct archived originals underlying those editions. The twelve unavailable originals and 29 unresolved language pairings remain in the acquisition report. [Passage verification](evidence/2026-11-25/eccc-passage-replay.json)

## November 24 inventory

| Measure | Count |
| --- | ---: |
| Indexes captured | 4 |
| Title appearances with links | 155 |
| Unique works | 83 |
| Editions (en / fr) | 137 (67 / 70) |
| Documents | 246 |
| Stored documents and versions | 234 |
| Archived bytes | 22,218,169 |
| Duplicate index appearances | 18 |
| Pairing gaps | 29 |
| Unavailable documents | 12 |

Change detection hashes the page after removing scripts, styles and comments: canada.ca injects a fresh analytics script on every response, so raw bytes differ on every fetch. Replaying the cache produces no new change rows and no new versions.

### Reconciliation with the planning baseline

The November 23 research baseline counted 181 title paragraphs. Only 155 carry links; the other 26 are notes inside audit fiscal-year groups. The live indexes contain 318 anchors, including 36 inside those note paragraphs, so the intake inventories 282 link appearances against a baseline of 316.

### Known outcomes

- **12 Natural Resources Canada pages** answer HTTP 202 with no body to a non-browser client. They are recorded as fetch failures, not confirmed publisher gaps.
- **29 works have one edition.** Audit PDFs and partner-department reports publish no explicit language alternate; they remain single-language works rather than being merged by translated title.
- **18 duplicate appearances** repeat an entry for the same series and language; the edition is written once and the repetition is counted.

The inventory holds both editions of the three works in the [master plan's acceptance cases](PLAN.md#eccc-implementation-scope). See the [inventory receipt](evidence/2026-11-24/eccc-inventory.json).
