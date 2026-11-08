# CHS runtime refresh

The committed corpus and api-billing runtimes come from CHS commit
`3dba6c56bc50cb89bca0346e211329c1fb7e1885`. Their package versions remain
0.1.0; this receipt distinguishes the reviewed implementation from older vendor
snapshots bearing the same version. `vendor/chs-provenance.json` records every
runtime file and its SHA-256. `bun run check:vendor` verifies that receipt.

A clean checkout now includes api-billing's exported Postgres and Durable Object
modules. Previously only its manifest was tracked, so the default branch failed
typechecking without an uncommitted local build.

The monthly usage adapter delegates to the shared bounded, validated transport.
Peeks use GET `/consume`; the shared object has no `/peek` endpoint. Hard quotas
still fail closed and unlimited/soft usage stays available on storage failure.
Billing still happens after successful product work. Prices, allowances, customer
identity and the existing configured/default Stripe meter event name are retained.
Stripe transport now uses the shared bounded best-effort implementation.

Citation parsing requires the full instrument title and one unambiguous citation.
Shortened titles and lists of instruments fall through to ordinary retrieval;
they are not labelled exact citations. Product corpus, licensing and retrieval
policies are unchanged.

To refresh from a reviewed checkout, build/install CHS prerequisites there, then:

```sh
CHS_REPO=/path/to/chester-hill-solutions \
CHS_SOURCE_REF=3dba6c56bc50cb89bca0346e211329c1fb7e1885 \
bun scripts/vendor-corpus.ts corpus api-billing
bun install --force
bun run validate
```

The source must be clean at the explicit full commit. Both builds complete before
runtime copies are replaced. The command updates the receipt and copies runtime
files only; it does not copy development scripts or unresolved workspace links.
Commit the runtime files, receipt and any lock changes together.

Validation includes the full unit suite, typechecking, existing billing/corpus
and infrastructure invariants, and a disposable workerd fixture exercising the
actual host adapter with the shared Durable Object. The fixture verifies that
peeks do not increment, hard refusals do not count, and customer counters remain
separate. Miniflare is declared at the exact version already locked by Wrangler;
external package resolutions are unchanged. No live providers, ingestion,
production data migrations or deployments are part of this refresh.
