# Offline protected-state copy

`scripts/protected-state.ts` prepares and tests a protected-state copy from a
sealed saved SQLite database plus the saved legacy-auth export. It has no cloud,
credential, acquisition or production-apply mode. SQLite is read directly; saved
SQL uses a separate restricted Node importer. The importer feature-detects the
SQLite authorizer and refuses older runtimes rather than running unrestricted SQL.

The fixed table/column order, scalar validation and format-1 page codec now live
in `src/corpora/protected-state-format.ts`. The offline copier imports that same
codec. Original canonical page bytes and hashes are unchanged. The module uses
platform Web Crypto and runs in a Worker without Node compatibility. This is a
shared format boundary; it does not add a hosted restore route or remote apply.
The [validation receipt](evidence/2026-10-22/protected-state-format-validation.json)
records the golden hashes, byte boundaries and local runtime checks.

The separate [D1 binding helper](PROTECTED-D1-BINDING.md) applies this sealed
format to a staging-only D1 binding after checking the actual compact metadata,
text references and a fresh complete R2 audit. Its synthetic workerd fixtures
also cover atomic page replay, publication guards and original sequence facts.
Its authenticated staging-only HTTP adapter remains disabled in the checked-in
config and is exercised only with synthetic local bindings. Initial-admission
client windows are locally verified; its later phases and owned operator,
consistent production acquisition and actual hosted copy proof remain separate
gates. The limitations below describe the offline SQLite copier.

Keep the source/auth/target files and output outside the repository. Use private
0700 directories and 0600 files, owned by the operator, with no symlinks or SQLite
WAL/SHM/journal companions. Output directories must be new. The cutover bundle is
the existing verified corpus bundle; its manifest SHA-256 must be supplied.

```sh
bun scripts/protected-state.ts prepare --source-sqlite /private/source.sqlite --source-sha256 SOURCE_SHA256 --legacy-auth /private/legacy-auth.json --auth-sha256 AUTH_SHA256 --target /private/compact.sqlite --target-sha256 TARGET_SHA256 --cutover /private/cutover --cutover-sha256 CUTOVER_MANIFEST_SHA256 --output /private/protected-copy
bun scripts/protected-state.ts apply-local --bundle /private/protected-copy --manifest-sha256 PREPARED_MANIFEST_SHA256 --target /private/compact.sqlite
bun scripts/protected-state.ts verify-local --bundle /private/protected-copy --manifest-sha256 PREPARED_MANIFEST_SHA256 --target /private/compact.sqlite
```

For a saved SQL dump, replace `--source-sqlite` with `--source-sql`; pin the SQL
file's hash. Node must be available and expose `DatabaseSync.setAuthorizer`
(Node 24.10 or newer; the local fixture run uses Node 25.9).
The importer permits ordinary table/index definitions and literal inserts, safe
foreign-key pragmas, transaction wrappers and canonical sqlite_sequence statements.
Only the `length` and `unixepoch` builtins used by the current schema are allowed.
It denies attachments, extensions, virtual tables, triggers, external-file and
unsafe schema operations. Input is at most 2 GiB, each statement at most 8 MiB,
and the child process has a 180-second deadline. UTF-8 and quoted/comment boundaries
are streamed. Both history sequences require explicit literal facts in the dump;
an export that omits them is refused. Do not synthesize them from MAX(id).
The private scratch database is retained beside the input, including on refusal;
the original SQL hash and materialized SQLite hash are recorded separately.

The source remains read-only. Preparation verifies the complete ID/fingerprint
sequence, non-text corpus metadata, publication/source/parser and the checked
cutover bundle. A legacy source cannot be copied into a v2 target. Pending vector
outbox payloads, conflicting identities/billing, unknown protected schemas and
populated target protected tables stop preparation. A matching source-derived
baseline publication may have its timestamps replaced by the authoritative saved
publication; a different corpus tuple is refused.
Protected schema checks inspect all columns with `table_xinfo` and reject
generated, hidden or additional columns before producing a copy plan.

The target corpus check covers row IDs, fingerprints and non-text metadata. This
helper does not verify the target's `statute_text_refs` or compact-text markers,
and it does not restore text references or text objects. Verify those separately
with the compact-restore/text-cutover tools before treating the target as ready to
serve. Checking the supplied cutover bundle does not establish that the target's
text references match it.

The plan covers every column of workspace, workspace_api_key,
civic_workspace_billing, corpus_state, corpus_runs, corpus_changes and completed
corpus_mutations. Explicit run/change IDs and sqlite_sequence high-water marks are
preserved, including IDs deleted before backup. Known legacy schemas may omit the
three workspace tables, mutation table and parser columns. Existing CHS key
capabilities/metadata and billing enabled state survive. Existing revocation is
never reversed; a disabled legacy key can tighten a matching CHS key to revoked.
Browser keys are not converted into retrieval credentials. No raw key is generated.

Private JSONL pages contain fixed-table bound data, at most 16 rows and 64 KiB.
Each page and its receipt commit atomically. The same manifest can resume after a
partial copy or lost acknowledgement; replay checks actual stored rows as well as
receipt hashes. Conflicts never become overwrite instructions. The final check
compares complete table digests/counts, exact sequences, corpus identity and foreign
keys before marking complete. Do not serve or otherwise mutate a partially restored
target. A completed target must not be changed and then replayed from an older plan.

All detailed artifacts stay private. Standard output and errors contain only safe
codes, hashes and counts; they contain no key/customer identities, SQL values or
provider credentials. Keep the original input and failed/partial plan for review.
Do not delete its journals to retry with different data.

This does **not** prove that the saved D1 and KV exports share a consistent freeze,
that writers/alarms were stopped, or that an acquired SQLite file contains the
original history high-water marks. In particular, importing a SQL dump that omits
sqlite_sequence cannot recover deleted-ID history from MAX(id). Acquisition must
preserve those values and retain its own provenance. The helper validates the
sealed SQLite input it is given; it cannot authenticate how that input was acquired.

It also does not inspect or migrate usage Durable Objects, their namespace IDs,
counters or operation receipts; those must remain in place. Actual production
bindings, Vectorize values, R2 objects, key behavior, writer quiescence, deployment
and rollback require separate protected evidence and approval. Local fixture tests
and a successful offline copy do not close those hosted release gates.
