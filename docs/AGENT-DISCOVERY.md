# Discover a CivicSignal deployment

Give an agent the API base URL. It can read `/.well-known/civicsignal.json` for the machine-readable contract or `/llms.txt` for the same sources and research questions in plain text. Both are anonymous GETs and consume zero workspace units. The API landing page links to both. The dedicated homepage forwards these two paths to the public API.

## Which sources can I query?

Read `sources[]`. Each entry names a source, gives an example question and reports the result of checking this deployment's configuration and serving data. Preview collections link to their public OpenAPI descriptions. A specification can describe operations available on other deployments.

| Status | What the agent can do |
| --- | --- |
| `available` | Choose a published `editions[]` entry with the required language and scope. Send its example GET request to this API origin using the workspace key. |
| `disabled` | Skip this source on this deployment. |
| `empty` | The source check completed and found zero qualifying editions. Treat the source as a coverage gap. |
| `unavailable` | A required binding or readable publication is missing, or a publication is in progress. Recheck discovery later. |

An edition carries a scope such as a parliamentary session, Gazette part or catalogue. Its dates describe different events.

| Field | Meaning |
| --- | --- |
| `observedAt` | Latest recorded source observation or intake run for the scope. Individual records can have older observations. |
| `coverageThrough` | Cutoff recorded by the serving snapshot or historical study. |
| `publishedAt` | When the local edition was imported or materialized. |
| `latestRecordDate` | Newest dated record in the edition, such as a Hansard sitting or the date a written question was asked. |
| `revision` | Stored revision for the edition, when available. |

A missing date means the deployment lacks that timestamp. Use the source coverage operation linked from its OpenAPI document to inspect unresolved editions, missing attachments or metadata-only records. Each search requires `Authorization: Bearer <workspace API key>` with `civicsignal.retrieve`. The legacy `coverage` field describes the statute service. `mcp.tools` describes statute tools. Other sources are accessed through HTTP.

## Jon’s apprenticeship question

“Who is asking for more apprenticeship training places, and which federal programs could fund that capacity?”

Select the entry with `id=apprenticeship` and the desired language under `researchQuestions`. The entry lists executable steps and any missing sources. Its status is `available` when both required source editions can be queried, `partial` when just one can be queried and `unavailable` when neither can. A successful search may return zero matches. Use the source citations from the results to support the answer.

```sh
curl -fsS "$CIVICSIGNAL_URL/.well-known/civicsignal.json" |
  jq '.researchQuestions[] | select(.id == "apprenticeship" and .language == "en")'
```

Against the acquired 45-1 committee and funding catalogues, the first search finds Polytechnics Canada’s submission to the House Finance Committee. The testimony search returns named speakers and citations from the House Human Resources Committee. Read each passage before attributing a position. The ESDC search finds the Union Training and Innovation Program infrastructure expansion call. Open the returned program ID with the same language to check eligibility, funding limits and closing date. An award or a change in waitlist length requires separate evidence. [Funding terms and bilingual acceptance case](FUNDING-PROGRAMS-API.md#verify-the-policy-questions)

The acceptance test sends anonymous discovery requests to the Worker, executes the advertised steps with an authenticated workspace key in both languages and checks the brief, testimony, official links and program terms. To run it against acquired data, set `CIVICSIGNAL_FUNDING_SQLITE` and `CIVICSIGNAL_COMMITTEES_D1` to the serving SQLite files and run `bun run test test/endpoints.test.ts`. The default suite also exercises an installation with French-only ESDC coverage, an unreadable committee corpus and disabled sources.
