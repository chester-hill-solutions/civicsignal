# The corpus snapshot

The corpus is XML in a git repository, and that is the reason three separate
things are awkward.

- **The pipeline is slow.** A cycle has to parse XML — hundreds of megabytes
  of it — to find out which provisions changed. The XML parsing is most of the
  cycle's cost, and it is paid on every change to find out that nothing much
  changed.
- **The pipeline has a ceiling.** GitHub's compare endpoint names at most 300
  files, and the diff has to happen at *file* granularity because a file is
  what GitHub can name. A re-consolidation touches thousands of files, and
  there is no way to ingest one.
- **The corpus is only usable by people who can parse XML.** The rows exist
  in a database, in a vector index, and in a repository of XML — but there is
  no artifact a researcher can load.

A **snapshot** is the corpus as rows: one row per provision, with a
fingerprint, in a form that can be read in pieces. It fixes all three, and it
is the same artifact whether it is kept private or published.

## The format

One revision is one pair of files, named for the corpus commit they are at:

```
<commit>.rows.jsonl     the rows, one JSON object per line, sorted by id
<commit>.index.jsonl    id, fingerprint, offset and length of each row
```

The **index** is the diff. Two index files, compared, give: the ids that
changed (the fingerprints differ), the ids that went (present in the old one,
absent from the new) and the ids that came (the reverse). It is about 20 MB
for the whole corpus — small enough to read in full on every cycle, which is
what makes the diff cheap and exact rather than approximate.

The **rows** file is read only in pieces. The index carries each row's byte
offset and length, so a changed row is one HTTP range request. Nothing ever
reads the whole file.

The files are plain JSON and plain HTTP. There is no columnar format and no
compression, because both of those are answered by a question this format does
not need to answer: the index is what gets read in bulk, and the rows are
read a few at a time.

## Where it lives

**R2, privately.** One bucket, one immutable file per revision, named for the
corpus commit. It is in the same account, so there is no egress and no
third-party rate limit, and the revision is the corpus's own commit — the
pipeline's `corpus_state.commit_sha` names the file.

**Hugging Face, publicly.** The same index and rows for the current revision,
as a versioned dataset. The corpus is public law, and a row-level snapshot
with a fingerprint per row is a thing a researcher can load and a thing a
citation can point at. That is the same artifact with a licence header on it,
not a second format.

**D1 stays as the serving store.** The rows the API reads, licence-gated, with
the lexical arm's `search_text LIKE ?` over the folded column. A snapshot is
not a substitute for that: it is a key-value read with no query engine, and
the write path needs the row and its fingerprint to land in one transaction.

## What it changes in the pipeline

The cycle becomes:

1. read the corpus's head revision (one request);
2. if the store is at it, stop;
3. read the new revision's index (about 20 MB) and the old revision's index;
4. diff them — changed, gone, come;
5. fetch only the changed rows, by range request;
6. embed and write them, and remove the ones that went.

No XML parsing, no file-level diff, no 300-file ceiling, and no tarball. The
CPU cost of a cycle falls from about a hundred and sixty seconds to a few.

The removal detection gets simpler too. Today the changed file is fetched at
*both* revisions to find the provisions that went; with the index, the gone
ones are simply the ids in the old index and not in the new one, and the
store's own rows are not consulted at all.

## The invariant that matters

**The snapshot is built by the same parser as the store's rows** — the same
`rowsForFile`, one parser, one set of rules about what a row is.

If the snapshot and the store were built by different code, the diff between
two snapshots would be a diff of parsers rather than a diff of law, and every
change would look like every other change. This is the same reason the
fingerprint is computed from the row rather than from the XML: the thing being
compared has to be the thing being stored.

## What it does not change

The licence gate. The rows leave the API only through it, and the snapshot is
a copy of rows that are already public — it changes what the pipeline reads,
not what the product is allowed to say.
