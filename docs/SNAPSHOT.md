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

One revision is a set of files, named for the corpus commit they are at:

```
<commit>.manifest.json     what it is: the count, the size, the parts
<commit>.index.jsonl       id, fingerprint, offset and length of each row
<commit>.rows.000.jsonl     the rows, one JSON object per line, sorted by id
<commit>.rows.001.jsonl     ...and so on, cut on line boundaries
```

The **index** is the diff. Two index files, compared, give: the ids that
changed (the fingerprints differ), the ids that went (present in the old one,
absent from the new) and the ids that came (the reverse). It is about 25 MB
for the whole corpus — small enough to read in full on every cycle, which is
what makes the diff cheap and exact rather than approximate.

The **rows** are read only in pieces. The index carries each row's byte
offset and length, so a changed row is one HTTP range request. Nothing ever
reads the whole file.

The files are plain JSON and plain HTTP. There is no columnar format and no
compression, because both of those are answered by a question this format does
not need to answer: the index is what gets read in bulk, and the rows are
read a few at a time.

### Why the rows are parts

Because a single object cannot be published. Neither wrangler nor the
Cloudflare API will upload more than **300 MB** in one object, and the rows are
**347 MB**. That was discovered the way these things are: the rows were
uploaded by hand, the upload could not work, and the bucket was left holding
an index with nothing behind it. Nothing said so — a missing object is not an
error until something reads it, and by then the cycle is failing in production
with a message about a provision its index names and a row that is not there.

The offsets in the index are **global** — the byte offset of a row in the
snapshot, as if it were one file — so the part size is a publishing detail and
nothing else. A reader works out which part holds a row and where it is inside
it, and never knows how the snapshot was cut up. The cuts are always on line
boundaries: a row that straddled two parts could not be read by a range
request, and a range request is the only way rows are read.

### Why there is a manifest

Because "is it all there?" has to be a question with an answer. The manifest
states the count, the total size of the rows, the part size, and every part's
size — so a snapshot whose last part never arrived is a snapshot that
**refuses to be read** rather than one that quietly reports a provision as
missing.

It is also what makes publishing safe: the parts go up first, then the index,
and the manifest **last**, because the manifest is what announces a snapshot.
An announced snapshot that is not complete is the failure the manifest exists
to prevent.

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

## Filling the gap

The pipeline's reconciliation used to compare two **revisions** — the store's
against the corpus's head — with GitHub naming the files that differed in
between. That has a ceiling: the compare endpoint names at most 300 files, so
a store that has fallen behind cannot catch up in one step, however big the
gap is.

A snapshot has no such ceiling, because the comparison is not over files. It
is over **provisions**, and both sides of it are index files:

- the store holds a fingerprint for every provision it has;
- the snapshot's index holds a fingerprint for every provision the corpus has.

So the diff is those two lists compared — `src/ingest/snapshot-diff.ts` — and
the gap is not a number of commits. It is not a number of anything. A store
that is a week behind and a store that is a year behind are the same amount of
work.

That is what makes catching up possible. The pipeline does not need the
intermediate revisions, does not need to walk the commit history, and does not
need a tarball of the whole corpus: it needs the store's fingerprints, the
head's index, and the rows of the provisions that moved.

**The store is a snapshot of its own revision.** That is the part that makes
it work — the store's fingerprints are not a cache of the diff, they are the
"before" side of it.

## What it changes in the pipeline

The cycle becomes:

1. read the corpus's head revision (one request);
2. if the store is at it, stop;
3. stream the head's index, and page the store's own fingerprints;
4. merge the two — changed, gone, come, and how many agreed;
5. fetch only the rows that moved, by range request;
6. embed and write them, and remove the ones that went.

No XML parsing, no file-level diff, no 300-file ceiling, and no tarball. The
CPU cost of a cycle falls from about a hundred and sixty seconds to a few.

The removal detection gets simpler too. Today the changed file is fetched at
*both* revisions to find the provisions that went; with the fingerprints, the
gone ones are simply the ids the store has and the snapshot does not, and the
store's own rows are read only to say what the removed provision *was*.

### Neither index is held

Both sides of the diff are in **id order** — the index is written in the order
the rows are in, and D1 pages its fingerprints `WHERE id > ? ORDER BY id` — so
the diff is a **merge of two cursors**, not a comparison of two maps. That is
not an optimisation. Measured on the real corpus:

| | |
|---|---|
| the index as a `Map` | 80.6 MB |
| the store's fingerprints as a `Map` | 32.5 MB |
| **both, before a row is read** | **137.3 MB** |
| a Worker's memory | 128 MB |

So the index is read a line at a time through a streaming decoder, the
fingerprints a thousand at a time, and what is in memory is the batch being
written.

The byte handling matters for the same reason it does in the rows: half the
corpus is French. A row is cut out of a merged range by **byte**, and a line
is split out of a stream with the decoder left in streaming mode — otherwise a
chunk boundary in the middle of an accent turns it into two replacement
characters, and an id that was never in the corpus.

### The gap can be larger than one invocation

A store a year behind is two hundred thousand provisions to fetch, embed and
write, and one cycle cannot do that — the encoder alone would take hours. So a
cycle writes a bounded number and stops.

Nothing has to be remembered for the next one to continue, and that is the
part worth stating: **the fingerprints are the progress**. A provision that
has been written no longer differs from the snapshot, so the next diff does
not mention it. A cycle that dies half way leaves the store consistent and
simply resumes.

The state — the revision the store is at — is advanced only when the diff has
been exhausted. Until then the store is at *no* revision: it is part of the
way from one to another, which is exactly what its fingerprints say. A cycle
that claimed a revision it had not reached would make the next one skip the
rest of the gap.

## Checking a snapshot

A snapshot is only worth what its checks are, because a wrong offset is a
wrong provision rather than an error. Three of them, and all three are
independent:

```
bun scripts/check-snapshot.ts --manifest dist/snapshot/<sha>.manifest.json
bun scripts/check-snapshot.ts --offsets  --manifest dist/snapshot/<sha>.manifest.json
bun scripts/check-snapshot.ts --vs-store --index    dist/snapshot/<sha>.index.jsonl
```

`--manifest` is "is it all there": the parts add up to the size the manifest
claims, the count matches the index, every offset is inside the rows, and the
index is the entries and nothing else. `--offsets` reads every entry's bytes
out of the part that holds it and checks that the row it gets back is the row
the index named — 277,857 of them, across six parts. `--vs-store` compares the
index's fingerprints against the store's, row for row, because if those differ
then the diff is comparing two different corpora and nothing downstream means
anything.

And a fourth, which checks the thing the first three cannot:

```
bun scripts/check-cycles.ts --from <parent> --to <head>
```

Both reconciliations — the file cycle and the snapshot cycle — run against the
same real corpus change, and what they did is compared: the counts, the ids
written, each written row's fingerprint, **the rows' dates**, the documents
handed to the encoder, the removals, and the state left behind. The date is
compared separately because it is deliberately not part of a fingerprint, so a
snapshot built with the wrong date passes every other check and still puts the
wrong date on every row it writes. It did: the builder used the first ten
characters of the commit sha.

## The invariant that matters

**The snapshot is built by the same parser as the store's rows** — the same
`rowsForFile`, one parser, one set of rules about what a row is.

If the snapshot and the store were built by different code, the diff between
two snapshots would be a diff of parsers rather than a diff of law, and every
change would look like every other change. This is the same reason the
fingerprint is computed from the row rather than from the XML: the thing being
compared has to be the thing being stored.

## The builder, as a Cloudflare job

A snapshot has to exist for the head revision, and the corpus moves every three
to eight days — so building one is a job, not an afternoon. It is a Workflow:
a minutes-long job that must survive being interrupted, and whose progress is
a cursor rather than a place.

It was a local script for one reason, and the reason was **not** memory or CPU.
Both of those are answerable, and the ingest cycle already answers them: the
corpus tarball is streamed over HTTPS, one file is parsed at a time, and the
parts are written to R2 as they fill.

**The obstacle was the sort.** A snapshot's rows are in id order, because the
diff is a merge of two sorted streams — the index against the store's own
fingerprints, which D1 pages `ORDER BY id`. The corpus arrives in *file* order,
and the two are not the same: a file holds many provisions and their ids are
not in the file's order, nor is a file's id range a thing anyone can name in
advance. So the builder held all 277,857 rows in memory and sorted them, which
needs 360 MB and is exactly what a Worker cannot do.

The answer is that **only the index needs to be sorted, not the rows.**

- the reader already finds a row by its **byte offset**, so it does not care
  what order the rows are in — `mergeRanges` sorts the ranges it is given, and
  a range is a range;
- so the rows are written in **file order**, appended to parts as each file is
  parsed, which needs no memory at all;
- and the **index** is sorted, which is 26 MB of lines and not 347 MB of rows.

26 MB is still more than a Worker wants to sort at once — held as strings with
their overhead it is around fifty — so the index is sorted in **partitions**:
the corpus's four trees are named in the file path (`eng/acts`,
`eng/regulations`, `fra/lois`, `fra/reglements`), the ids carry that tree as
their prefix (`acts-en-100`, `regulations-fr-dors-2002-423-34-2-24`), and the
prefixes sort in the same order the trees do. So each tree's index lines sort
independently — a few megabytes at a time — and concatenating them in tree
order gives the global id order.

That is the whole design of the Workflow: **one step per group of corpus
files** (parse, append rows to a part, emit index lines), one step per tree to
sort and write its slice of the index, and a final step for the manifest. Each
step is bounded, retried by the runtime, and can be resumed from the step
before it — which is the property the local script has by accident, because it
runs to completion or not at all.

## What it does not change

The licence gate. The rows leave the API only through it, and the snapshot is
a copy of rows that are already public — it changes what the pipeline reads,
not what the product is allowed to say.
