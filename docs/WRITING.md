# Writing rules

This repository uses ASD-STE100, Simplified Technical English. The standard is
for technical documents. It limits the words and the grammar. A reader can then
understand a sentence one time.

The rules below are the parts we use. The full standard has more rules.

## The rules

1. Write short sentences. A sentence in a procedure has a maximum of 20 words.
   A sentence in a description has a maximum of 25 words.
2. Use the active voice. Do not use the passive voice.
   - No: "The row is written by the store."
   - Yes: "The store writes the row."
3. Use the simple present, the simple past, or the simple future. Do not use the
   present perfect.
   - No: "We have written the manifest."
   - Yes: "We wrote the manifest."
4. Put one instruction in each sentence.
   - No: "Open the file and read the index and then compare the rows."
   - Yes: "Open the file. Read the index. Compare the rows."
5. Do not use an "-ing" verb as a verb.
   - No: "When reading the snapshot, we found the error."
   - Yes: "When we read the snapshot, we found the error."
6. Use one word for one thing. Do not use two words for the same thing.
7. Use "must" for a requirement. Use "can" for a possibility.
8. Write a maximum of six sentences in one paragraph. Write about one topic in
   one paragraph.

## The words for our objects

Each object in this system has one word. Use only that word.

| Object | The word | Do not use |
| --- | --- | --- |
| One piece of law with an id | **provision** | section, item, entry, record |
| The stored form of one provision | **row** | record, line, item |
| The published files for one revision | **snapshot** | dump, export, bundle |
| One file of rows, when the rows are too large for one object | **part** | chunk, shard, piece |
| The file that lists the parts and their sizes | **manifest** | header, catalogue, descriptor |
| The file that maps an id to a fingerprint and a byte offset | **index** | catalogue, directory |
| The hash of a provision that shows a change | **fingerprint** | hash, checksum, digest |
| The database that the product reads | **store** | database, corpus |
| One run of the pipeline | **cycle** | run, job, pass |
| The first search, which uses the vectors | **search** | retrieval, lookup |
| The second search, which orders the candidates | **rerank** | reorder, rescore |
| The limit on the score | **floor** | threshold, cutoff |
| The answer "I do not have information on that" | **refuse** | decline, reject |
| To send a question to another source | **route** | forward, dispatch |

## The words we do not use

| Do not use | Use |
| --- | --- |
| ensure | make sure |
| utilize | use |
| prior to | before |
| subsequent to | after |
| in order to | to |
| approximately | about |
| additional | more |
| sufficient | enough |
| attempt | try |
| commence | start |
| terminate | stop |
| demonstrate | show |
| provide | give |
| obtain, receive | get |
| verify, validate | check |
| in the event that | if |
| at this time | now |
| a number of | some |
| it is necessary to | you must |
| the reason is that | because |

## How to check

Two rules are easy to check with a machine: the sentence length, and the passive
voice. Run a check before you commit a document.

The other rules need a reader. Read the sentences aloud. If a sentence is long,
make two sentences.

## The work that remains

Most documents in this repository do not obey these rules. They use long
sentences, the passive voice, and words from the "do not use" column. Correct
them one document at a time, when you change that document for another reason.
Do not correct a document only for the style.
