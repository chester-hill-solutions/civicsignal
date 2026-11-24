# Follow Bill S-5 through Parliament

The bilingual backend preview follows S-5 in the 44th Parliament, first session, using LEGISinfo bill ID `11558854`. It connects the published versions and parliamentary stages to a selection of committee meetings, witnesses, minutes, amendments, reports, and the House third-reading division. The same record and relationship IDs work in English and French. [English bill history](https://www.parl.ca/legisinfo/en/bill/44-1/s-5) · [French bill history](https://www.parl.ca/legisinfo/fr/projet-de-loi/44-1/s-5)

| Milestone | What the sources establish |
| --- | --- |
| Senate, February–June 2022 | First reading was February 9. The Senate committee reported amendments on June 20, including Senator Kutcher’s clause 21 change concerning toxicity, persistence and bioaccumulation. The amended bill passed the Senate on June 22. [Third committee report](https://sencanada.ca/en/committees/ENEV/Report/103542/44-1) |
| Commons committee, November 2022–March 2023 | The environment committee heard witnesses, including Lisa Gue. Its March 9 clause-by-clause meeting adopted NDP-8 on clause 3. Report 7, presented March 22, records the change concerning environmental justice, non-regression and intergenerational equity. [Meeting 38 evidence](https://www.ourcommons.ca/DocumentViewer/en/44-1/ENVI/meeting-38/evidence) · [Meeting 52 evidence](https://www.ourcommons.ca/DocumentViewer/en/44-1/ENVI/meeting-52/evidence) · [Report 7](https://www.ourcommons.ca/DocumentViewer/en/44-1/ENVI/report-7/) |
| House passage, May 30, 2023 | Vote 338 carried third reading with 208 yeas, 116 nays and zero paired. The division and the House Journals identify the same decision. [Division 338](https://www.ourcommons.ca/Members/en/votes/44/1/338) · [House Journals, sitting 202](https://www.ourcommons.ca/DocumentViewer/en/44-1/house/sitting-202/journals) |
| Concurrence and Royal Assent, June 13, 2023 | The Senate agreed to the Commons amendments. The bill received Royal Assent that day as S.C. 2023, c. 12. These are distinct events. [Senate Journals, sitting 133](https://sencanada.ca/en/content/sen/chamber/441/journals/133jr_2023-06-13-e) · [Assented text](https://www.parl.ca/DocumentViewer/en/44-1/bill/S-5/royal-assent) |

LEGISinfo lists three publications. The brief links first reading (`11558861`), the Senate-passed text (`11903126`) and Royal Assent (`12541741`). The Commons amendments are cited to the committee report. The packet covers selected amendments and witnesses. Consult each chamber's official study for the full proceedings.

## Replay and read locally

Run from the repository root. The saved packet contains parliamentary metadata and citations and can be replayed offline.

```sh
mkdir -p data/corpus
bill_db=data/corpus/bill-trace-preview.sqlite
bun scripts/bill-trace.ts replay "$bill_db"
bun scripts/bill-trace.ts brief "$bill_db" en | jq '.records[] | select(.kind == "vote")'
bun scripts/bill-trace.ts brief "$bill_db" fr | jq '.records[] | select(.kind == "amendment")'
bun scripts/bill-trace.ts replay "$bill_db"
```

The checked-in pilot produced 35 additions on its first replay, comprising 15 LEGISinfo records, nine Commons committee records, eight Senate committee records, one division and two Journals. Replaying the same packet reports zero events, including when input rows or links were reordered. A changed record retains its ID and produces one correction. Import commits all five source groups and their event journal in one SQLite transaction. Replay validates record identities, link targets, and the House vote against the Journal when both sources are available. [Source packet](../preview/bills/44-1-s-5) · [Storage migration](../preview/bills/migrations/0001_bill_trace.sql)

The optional final argument to `replay` selects a packet directory. A missing source file appears in the receipt's `missing` list. The brief omits that source's records and marks links to them with `available: false`. Restoring identical input restores coverage without generating additions. A malformed packet fails the import and preserves the previous committed brief.

## Verify the structured sources

To check a replay against the original official exports, download the bill XML and the House division XML. This command checks publication IDs, parliamentary stage events and dates, counts each voter once, and compares the result with LEGISinfo and the brief.

```sh
check_dir=$(mktemp -d)
curl -fsSL https://www.parl.ca/legisinfo/en/bill/44-1/s-5/xml -o "$check_dir/bill.xml"
curl -fsSL https://www.ourcommons.ca/Members/en/votes/44/1/338/xml -o "$check_dir/vote.xml"
bun scripts/bill-trace.ts brief "$bill_db" en > "$check_dir/brief.json"
python3 scripts/verify-bill-trace.py "$check_dir/bill.xml" "$check_dir/vote.xml" --verify "$check_dir/brief.json"
```

Use `--project "$check_dir/projected"` in place of `--verify` to regenerate the compact LEGISinfo and vote inputs in a new directory. Each input includes its upstream URL and the SHA-256 digest of the downloaded XML. Committee and Journal inputs contain selected, separately checked metadata.

## HTTP contract

`GET /api/bills/44/1/S-5/brief?language=fr` returns the French edition. Supply exactly one `language` argument, either `en` or `fr`. For a local or isolated Worker, enable `BILL_PREVIEW=on` and bind the replayed database as `BILL_DB`. The public OpenAPI 3.1 document is at `GET /api/bills/openapi.json`. [Runtime contract](../src/corpora/bill-trace.ts)

```sh
curl --fail-with-body --get "$CIVICSIGNAL_URL/api/bills/44/1/S-5/brief" \
  --header "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
  --data-urlencode 'language=fr'
```

The response includes the bill identity, localized title and citation, attribution, per-source coverage counts, and records. Each record has a stable local `id`, an official `sourceId`, a `kind`, chamber, localized label and citation, and directed links to other record IDs. The dates describe the recorded parliamentary actions. Stage records retain the source event type and, when published, the LEGISinfo stage ID and local timestamp. Committee studies carry the official organization ID, acronym and localized name. Vote totals, amendment clauses and dispositions, and selected witness names are structured fields. `complete` describes availability of the five packet sources within this pilot.

A workspace key needs `civicsignal.retrieve`. A successful brief consumes one unit, including a partial brief. Invalid language returns 400. A disabled preview or an unsupported bill returns 501. An uninitialized database or a replay with every source missing returns 503. Hosted source use and refresh remain open under D-08.

## Committee study action

The committee study preview follows the House environment committee's freshwater study in the 45th Parliament, first session. ENVI carried evidence forward from the 44th Parliament. This study has its own identifier, `13298665`. [Official study](https://www.ourcommons.ca/committees/en/ENVI/StudyActivity?studyActivityId=13298665) · [Étude en français](https://www.noscommunes.ca/Committees/fr/ENVI/StudyActivity?studyActivityId=13298665)

Use `GET /api/committees/house/ENVI/studies/freshwater/brief` with `language=en` or `language=fr`. Supply `asOf` to replay the selected parliamentary events through that date. It defaults to the packet's last covered date, September 25, 2026. A later date returns `400 INVALID_ARGUMENT`. Enable `BILL_PREVIEW=on` to serve the fixed packet. The route uses the same workspace key and one-unit retrieval charge as the S-5 brief. The public OpenAPI contract is at `/api/committees/openapi.json`.

```sh
curl --fail-with-body --get "$CIVICSIGNAL_URL/api/committees/house/ENVI/studies/freshwater/brief" \
  --header "Authorization: Bearer $CIVICSIGNAL_API_KEY" \
  --data-urlencode 'language=fr' --data-urlencode 'asOf=2026-09-24'
```

| As of | What a staffer can establish |
| --- | --- |
| April 30, 2026 | The meeting notice listed the draft report. The minutes confirm that ENVI considered it. [Notice](https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-36/notice) · [Minutes](https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-36/minutes) |
| May 5 | ENVI adopted the report and requested a response within 120 calendar days. Presentation to the House starts the clock. [Adoption minutes](https://www.ourcommons.ca/DocumentViewer/en/45-1/ENVI/meeting-37/minutes) · [Standing Order 109](https://www.ourcommons.ca/procedure/standing-orders/chap13-e.html#109) |
| May 28 through September 24 | The House received Report 5 on May 28. The response was due September 25. [Presentation and request](https://www.ourcommons.ca/DocumentViewer/en/45-1/house/sitting-124/hansard) |
| September 25 | The government tabled its response on the due date. [Government response](https://www.ourcommons.ca/content/Committee/451/ENVI/GovResponse/RP14237518/451_ENVI_Rpt5_GR_PDF/451_ENVI_Rpt5_GR-e.pdf) · [ENVI publication dates](https://www.ourcommons.ca/committees/en/ENVI/Work) |

The dates describe parliamentary events. This retrospective view uses selected published records and does not measure when CivicSignal first observed each publication. [Source packet](../preview/committees/envi-freshwater.json)
