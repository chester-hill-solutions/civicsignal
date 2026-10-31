# Protected production acquisition review

The [master plan](PLAN.md#mp-04-qualify-consistent-production-acquisition) owns scope and work order.
This review records acquisition constraints and local evidence.

## Plan validation summary

**Adjust.** The proposed read-only D1/KV acquisition can reuse the existing protected copier and auth collector. Production metadata observed on 2026-10-24 requires a different maintenance procedure from staging: the deployed pipeline has no coordinator binding. No production freeze, data acquisition, migration or binding switch has been performed or approved by this review. No formal ADR was found; the release, protected-copy and rollback documents supply the governing constraints.

## What the plan already covers well

The plan preserves the full original SQL and raw KV captures, distinguishes normalized auth data from raw backups, preserves the original usage namespace, and keeps the existing restore adapter restricted to staging. It correctly requires original sequence highwaters, explicit absence, an empty outbox and a compatible corpus publication before preparing a migration. Its separate common freeze addresses the lack of a transaction spanning D1 and KV.

## Offline capture core — 2026-10-24

The [fixture-only capture core](../scripts/lib/protected-acquisition.ts) now
implements one bounded protocol: complete KV view A, one continued D1 export
job, then complete KV view B. It compares inventory metadata and raw value
bytes, retains private responses and observed HTTP status, and reuses the
existing legacy auth collector and normalizer. **49 focused acquisition cases**
and the two existing auth-collector cases pass; independent review is clear.
The [tests](../test/protected-acquisition.test.ts) include repeated cursors,
same-count value drift, changed export bookmarks, expiry, failed persistence,
uncertain IO, HTTP/schema failures and failure after a result was written.

Each exchange has a durable exclusive intent before dispatch, bounded raw capture
and a transport observation before semantic acceptance. A failed or uncertain
capture cannot restart in its retained directory. All outputs are private; any
failure overrides a retained result, which is explicitly not standalone acceptance.
An injected adapter must settle response and transport cleanup before fulfilling;
an adapter that ignores abort leaves settlement to its owning caller/process.

The partial collector ceiling is **2,080 exchanges**, calculated as two views of
at most 10 listing pages and 1,000 values, plus 60 export polls. It also checks a
30-minute wall bound, 15-second exchange deadlines and one exchange in flight.
These are fixture protocol bounds, not evidence that the complete acquisition
fits the earlier 2,200-call proposal. Facts, identity/control observations and
SQL download still need a reviewed total budget. Unknown KV name prefixes are
retained in their raw listing and refused; this is not a complete namespace
backup if unclassified names exist.

The current [primary export contract](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
uses an absent status plus a bookmark for progress; explicit terminal statuses
are `complete` and `error`. The response bookmark is stable during one export,
and its exact value supplies the next request's `current_bookmark`. The core
refuses a changed bookmark. The provider also states that export can temporarily
make D1 unavailable, so a future live export belongs inside the separately
reviewed maintenance procedure.

**There is no credential selector, live transport/CLI, SQL download, facts
capture or writer control in this increment.** A signed export descriptor is
retained privately and never fetched. Signed-origin admission and token-free
download remain pending. `providerAuthenticated`, `globalQuiescenceEstablished`
and `productionAcquisitionQualified` remain false; matching captures do not prove
that production writers were frozen.

## Injected transport boundary — 2026-10-31

The [fixture transport](../scripts/lib/protected-acquisition-transport.ts) now admits fixed management requests and a separately pinned signed-download origin.
It requires injected IO and synthetic credentials; it has no live CLI or default network sender.
It checks request bounds before credential selection and journals each owned operation privately before dispatch.
Management and download requests share byte, request, and deadline limits.
The download sends no management token, refuses redirects, and writes an exclusive private SQL file.
Before acknowledgement, it checks the same file descriptor, filesystem identity, saved bytes, and digest.

Review found two defects: concurrent malformed input could overstate settlement, and same-size file replacement could evade the original download checks.
Both repairs pass independent review and regression checks.
The focused pair passes **124 tests**: 75 transport cases and 49 unchanged capture-core cases.
Bun and tooling compiler checks pass; full integrated qualification remains open.
The [local receipt](evidence/2026-10-31/acquisition-transport-local-validation.json) pins this source and its limits.

No actual credential owner, provider authentication, source-facts capture, production maintenance, or acquisition qualifies from these fixtures.
The complete acquisition budget and live operator remain open.
`providerAuthenticated`, `globalQuiescenceEstablished`, and `productionAcquisitionQualified` remain false.

## Gaps, conflicts, or redundancies to fix

1. **Production maintenance is unresolved.** Eight read-only management requests observed API version `4c06fcd8-db2e-47b9-92ad-fc214522e73e` and pipeline version `7394930d-13a2-4aad-9b20-0de60b8ccf8c`. The API has `API_KEYS` and `CIVIC_DB`, with no `AUTH_DB` or `CORPORA`; the pipeline has no Durable Object/coordinator binding. These are binding observations, not proof of the deployed auth schema or data authority. Do not substitute the staging coordinator or treat Cron removal as a complete writer freeze. Define maintenance for the actual deployed versions and every auth, billing and ingestion writer before implementing a live acquisition operator.
2. **Keep the exact export continuation mapping.** The inspected Wrangler 4.151.3 `pollExport` sends request `current_bookmark` and feeds response `at_bookmark` into the next request. The fixture core now implements that mapping and enforces the primary contract's stable bookmark. The initial export is a new export, not selection of an arbitrary historical bookmark. Preserve the full response chain, including uncertain starts, without automatically restarting it.
3. **Local source schema admission is implemented; production classification remains open.** `scripts/lib/protected-state-schema.ts` compares the complete retained schema inventory against the checked public migration prefixes through 0003–0008. It checks normalized SQL tokens and SQLite column, index and FK facts, including declared PK, UNIQUE, CHECK, defaults, collations, AUTOINCREMENT, partial indexes and unsupported objects. Unknown or mixed profiles fail before copy-plan output. This closes the former column-only admission gap locally; no actual production schema has been acquired or classified. The strict destination checker remains a separate contract. An empty `foreign_key_check` alone cannot establish that foreign keys were declared.
4. **Keep sequence evidence and authenticity separate.** A local bridge can check a fixed query, exact before/after presence and values, raw response hashes, unchanged SQL and matching freeze/export attestations. Those relationships do not authenticate the provider or establish global quiescence. Do not fabricate a captured-production envelope. Preserve absent versus explicit zero, reject contradictory literal SQL facts, and hash the consumed SQL before committing the derived database.
5. **Use a finite credential owner.** `scripts/lib/cloudflare-auth.ts:28–37` selects a token but does not validate file identity or expiry. Its `fetchWithAuth` path at `:82–118` retries and can refresh via a production query at `:45–49`. A future acquisition must select credentials after its durable intent, use fixed metadata/expiry checks and a minimal environment, and avoid that retry/refresh path. Never forward the credential to the signed export-download origin.
6. **The proposed ceiling is not a demonstrated capacity.** Two maximum KV views permit 2,020 calls; 74 fixed facts calls, 60 export calls and one download consume 2,155 of the proposed 2,200. Enumerate and bound every additional identity/control observation. Review actual inventory, current primary pagination/export/consistency documentation and signed-origin rules before selecting an executable budget. Matching KV views remain point-in-time evidence under an operational freeze, not proof of global convergence.

## Existing code/product references to reuse or extend

- `src/auth-export.ts:1–51`: implement a `LegacyAuthReader` over sealed paginated captures around `collectLegacyAuth`; pagination belongs in acquisition. Preserve authoritative hash-index checks and monotonic revocation.
- `src/auth-migration.ts:24–71`: reuse `normalizeAuthExport` and `prepareAuthMigration`. Keep the full raw capture separately because normalization strips unknown fields.
- `scripts/lib/protected-sql-import.mjs`: the separate explicit evidence function now extends the restricted streaming importer using the same parser, authorizer and transaction. The original two-argument importer and CLI remain strict. Its [94-test local validation](evidence/2026-10-23/protected-original-sequence-bridge-root-validation.json) establishes no production acquisition.
- `scripts/lib/protected-state.ts:54–61,116–140`: reuse sealed-file checks and auth merging. A distinct authoritative auth database would require a reviewed second-source extension; it must not be silently collapsed into the corpus source.
- `scripts/lib/protected-state-d1.ts:15` and `services/restore/protocol.ts:19`: retain the existing admission and staging-only target check. A production target adapter is a later, separate change.
- `docs/PROTECTED-D1-BINDING.md`: retain the existing local synthetic fixture and hosted-copy gates. The 18-row fixture does not qualify production acquisition or a full hosted copy.

## API impact and validation notes

**HTTP, MCP and the format-1 protected manifest remain unchanged.** The local sequence bridge produces a private SQLite source plus a separate provenance receipt. New copy plans also have a mandatory private `source-schema.json`, linking the source inventory/profile to the original input, materialized SQLite and manifest hashes. Executable local plan loads require that evidence; the owned D1 client also binds its exact bytes into the reviewed plan and rechecks them before credential selection. Historical plans without this sidecar remain historical evidence and cannot be executed by the new client. These local receipts report `providerAuthenticated`, `globalQuiescenceEstablished` and `productionAcquisitionQualified` as false. The hosted row protocol cannot independently prove the original source schema. No endpoint, arbitrary SQL route, production target override or automatic acquisition mode is introduced. Production `AUTH_DB` authority and the original usage namespace remain release and rollback requirements.

## Final adjusted plan, summarized

1. **Locally complete:** the narrow offline sequence bridge and fault tests retain unchanged raw inputs and the original strict import path. Preserve its validation and separately qualify upstream acquisition evidence.
2. Classify the actual production schema against the locally implemented source admission profiles and define maintenance for the observed production versions; inventory every relevant writer and auth authority.
3. Confirm current primary provider contracts and actual inventory. Select an enumerated finite acquisition budget and signed-download rules.
4. Extend the locally tested fixture capture core into one fixed-resource acquisition client using the existing auth collector, protected file tools and owned-process pattern. Add the separately reviewed signed download, SQL facts, credential/transport owner and complete budget. Keep common-freeze establishment separate; no live entry exists yet.
5. Prepare the complete concrete production maintenance/acquisition packet for its separate approval. Acquire only after that decision, preserving all failures and original artifacts.
6. Qualify corpus/parser/text/vector compatibility and execute the isolated hosted synthetic/full-copy checks. Review a production target adapter and final switch/rollback only after those results exist.

## Handover items for engineering, enumerated

1. **SQL importer and tests:** prove deleted highwaters 120/1000 above surviving IDs 2/10, absent versus zero, failed/foreign/partial evidence, conflicting qualified sequence writes, pre-commit rollback and strict default behavior. Treat post-commit close/hash failure as refused acceptance with a retained file, not retroactive rollback.
2. **Production source classification:** acquire and compare the actual retained schema with the accepted public migration profiles. Missing declarations, indexes, extra triggers/views, mixed profiles and absent or altered sidecars are covered locally. Any unrecognized deployed schema needs its own reviewed profile; do not weaken admission to make an acquisition pass.
3. **Maintenance packet:** name actual versions, bindings, writer controls, credential lifetime and observed freeze interval. Verify that authentication cannot mutate covered timestamps during acquisition; preserve the original usage object identities. No staging control may stand in for production.
4. **Acquisition reader:** test complete pagination, repeated cursors, changed same-count values, expiry, exact export continuation, lost acknowledgements, bounded download, token/origin separation and terminal persistence failures. Emit safe public counts/digests and private raw captures.
5. **Release evidence:** keep local materialization, authenticated acquisition, hosted protected copy and production binding switch as separately evidenced gates. Update `docs/V1-RELEASE.md` only from actual completed results.
