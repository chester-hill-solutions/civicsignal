# Following a policy file across Gazette and Hansard

Use a separate feed for each source and edition language you follow. Each feed reports records added, corrected or removed when CivicSignal imports a source edition. The first observation of an edition establishes a baseline. Existing records appear as additions, even if the source published them months earlier.

| Feed | GET path | Topic searches |
| --- | --- | --- |
| Canada Gazette | `/api/gazette/changes` | Part I and II titles and registration numbers |
| House of Commons Hansard | `/api/debates/house/changes` | Permitted excerpts from interventions |
| Senate Hansard | `/api/debates/senate/changes` | Permitted excerpts from speaking turns |

## Poll and resume

For example, follow the French Gazette Part II registration number `DORS/2026-65`. The same sequence works for either chamber by changing the path and topic and omitting `part`.

```sh
feed_url="$CIVICSIGNAL_URL/api/gazette/changes"
poll() {
  curl --fail-with-body --silent --show-error --get "$feed_url" \
    --header "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
    --data-urlencode 'language=fr' --data-urlencode 'part=II' \
    --data-urlencode 'topic=DORS/2026-65' --data-urlencode 'limit=25' "$@"
}
page=$(poll)
printf '%s' "$page" | jq '{events, scope, hasMore}'
# Save nextCursor after successfully processing the page.
cursor=$(printf '%s' "$page" | jq -er '.nextCursor')
poll --data-urlencode "cursor=$cursor"
```

Against the November 23 local baseline, this query returned one addition with record ID `gazette:pii:fr:2026-04-22:v160:n8:sor-65`, publication date `2026-04-22`, and an official citation. Resuming the same query catches later corrections to that record even if the registration number changes. [Gazette Part II record](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/sor-dors65-fra.html)

Supply `language=en` or `language=fr`. Omit `topic` to follow all records or supply a literal phrase up to 300 characters. Matching folds case and accents. Gazette accepts `part=I` or `part=II`. Omitting it requests coverage of both parts. `limit` defaults to 25 and accepts 1–100. Events arrive in ascending observation sequence. A numeric event `id` identifies one event within the journal. A `recordId` identifies the source record across changes.

Process the events, then save `nextCursor`, including on an empty page. If `hasMore` is true, continue immediately. When false, keep the cursor for the next poll. After a client failure, replay the last uncommitted page and deduplicate by event ID within that subscription and journal. Cursors are opaque and belong to one journal, source, language, topic and Gazette part selection. Page size can change between calls. Changing filters starts a new subscription. A rebuilt database requires a fresh baseline and a fresh set of processed event IDs.

## Interpreting an event

Every event includes its kind, record ID, edition ID, public label, official citation, `publicationDate` from the edition and `observedAt` in UTC. Gazette events also identify the part. For a removal, the label and citation are the last observed values. Senate citations identify transcript sections. A structural edit that renumbers a Senate speaking turn can appear as a removal and an addition under a new ID.

With a topic, an event is delivered when either version matches. For example, a `corrected` event with `"matches": {"before": true, "after": false}` means the record still exists but its revised wording no longer matches. Remove it from a list of current matches. A `removed` event means a complete reimport of the same edition omitted that record. A week manifest omitting a whole edition supplies no evidence of removal. A partial House JSON import updates only the supplied speeches.

Each page includes `scope.editions`, with the publication date and the time CivicSignal first observed the edition or last changed its stored contents. An unchanged replay adds zero events. Use the coverage and dates to tell the reader which issues or sittings were checked. For Gazette, use exact record lookup for any verified consultation, registration or effective date. A Gazette metadata change alone establishes no change to the law in force.

## Preview access and local replay

The three data routes require a workspace Bearer key with `civicsignal.retrieve`. Each successful page costs one workspace unit, including an empty poll. An invalid cursor or mismatched filters return `400 INVALID_ARGUMENT`. Missing requested coverage returns `503 RETRIEVAL_UNAVAILABLE`. Disabled previews return `501 UNSUPPORTED_COVERAGE`. The public OpenAPI 3.1 documents are at `/api/gazette/openapi.json` and `/api/debates/openapi.json`. [Runtime schemas](../src/routes/source-feed-contract.ts)

Local imports initialize the [journal tables](../preview/source-feed/migrations/0001_source_feed.sql) in the same database as their records. Replay a previously imported edition once to initialize its feed. For an isolated Worker, enable `GAZETTE_PREVIEW=on` with `GAZETTE_DB`, or `HANSARD_PREVIEW=on` with the debate records and journal in `CIVIC_DB`. These previews refresh on import. Hosted publication and an automatic refresh schedule remain open.

Try all three without provisioning a Worker. The Gazette sync reads four official April 2026 issue indexes. The two Hansard commands use synthetic fixtures.

```sh
preview_dir=$(mktemp -d)
bun scripts/gazette-local.ts sync "$preview_dir/gazette.sqlite"
bun scripts/source-changes.ts "$preview_dir/gazette.sqlite" '/api/gazette/changes?language=fr&part=II&topic=DORS%2F2026-65'
bun scripts/hansard-local.ts replay-week "$preview_dir/debates.sqlite" test/fixtures/hansard/week.json
bun scripts/hansard-local.ts replay-senate-week "$preview_dir/debates.sqlite" test/fixtures/senate-hansard/week.json
bun scripts/source-changes.ts "$preview_dir/debates.sqlite" '/api/debates/house/changes?language=en&limit=1'
bun scripts/source-changes.ts "$preview_dir/debates.sqlite" '/api/debates/senate/changes?language=fr&limit=1'
```

## Read the next bilingual brief

Use the local reader to follow one policy file in the editions stored in a preview database. Give it the English and French search terms. Save the returned JSON after you process the brief. Pass that file on the next run.

```sh
brief_dir=$(mktemp -d)
bun scripts/source-brief-local.ts "$preview_dir/gazette.sqlite" \
  --topic-en 'SOR/2026-65' --topic-fr 'DORS/2026-65' > "$brief_dir/first.json"
bun scripts/source-brief-local.ts "$preview_dir/gazette.sqlite" \
  --state "$brief_dir/first.json" > "$brief_dir/next.json"
jq '{events, coverage}' "$brief_dir/next.json"
```

On the April 2026 Gazette preview, the first brief found one addition in each Part II language edition. Its next brief had zero events across the four stored Gazette editions. House and Senate coverage showed `unknown` in both languages because that database contained no debate editions.

Each entry retains the feed event's identity, language, source record ID and official citation. A correction can cause a previously watched record to stop matching. The brief carries the correction and its before-and-after match flags. English and French editions have distinct records. A quiet result covers only the listed stored editions. Check their publication and observation dates before using a brief to describe a particular day.

The regression test changes the title of SOR/2026-65 in a disposable copy of its English and French metadata. Both revised titles lose the watched term. Each edition produces one correction with the original official citation. Repeating the poll from the same saved cursors returns the same event identities. The title edits are test inputs. [Replay test](../test/bilingual-brief.test.ts) · [English instrument](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/sor-dors65-eng.html) · [French instrument](https://gazette.gc.ca/rp-pr/p2/2026/2026-04-22/html/sor-dors65-fra.html)
