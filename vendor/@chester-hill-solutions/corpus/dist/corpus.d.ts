/**
 * The corpus interface: a queryable body of public record, and how to ask it.
 *
 * A corpus is deliberately small. It declares what it is, what regime it is under,
 * whether it can answer a given question, and how to retrieve items. Everything else
 * — where the rows live, how they are joined, how they are refreshed — is an
 * implementation detail behind the interface.
 */
import type { CorpusPolicy, RawCorpusItem } from "./policy.js";
/** The subset of a SQL database that corpus adapters need. D1 satisfies it. */
export interface CorpusStatement {
    bind(...values: unknown[]): {
        all<T = unknown>(): Promise<{
            results?: T[];
        }>;
    };
}
export interface CorpusDatabase {
    prepare(sql: string): CorpusStatement;
}
/** A query, as a caller expresses it. Every corpus decides for itself whether it can answer. */
export interface CorpusQuery {
    /** Free-text topic, e.g. "housing", "pharmacare", "clean electricity". */
    topic?: string;
    /** Additional terms that must also match. */
    keywords?: string[];
    /** Two-letter or full province/territory code, e.g. "ON", "BC", "QC". */
    jurisdiction?: string;
    /** Federal or provincial riding code, where the corpus is geography-scoped. */
    riding?: string;
    /** An exact instrument title, where the corpus is instrument-scoped. */
    act?: string;
    /**
     * An exact provision label, where the corpus is provision-scoped.
     *
     * A citation is a key, not a similarity. "section 210 of the Canada Labour
     * Code" names one provision, and the query that resolves it has to be an exact
     * lookup — a text search over the same act puts the right answer at rank five,
     * because a bare section number has almost no IDF across a large corpus.
     *
     * `act` and `section` together are the citation. `section` without `act` is
     * meaningless and adapters should ignore it.
     */
    section?: string;
    /**
     * The language of the material wanted, as an ISO-639-1 code, e.g. "en", "fr".
     *
     * Language is a **lens**, exactly like `jurisdiction`: the corpus holds more
     * than one language, and the caller chooses which one it is asking about.
     *
     * It has to be a lens rather than a detail because Canada's statutes are
     * enacted in two languages with equal legal force, and the two versions are
     * **different rows with different identifiers**. So a corpus that holds both
     * and cannot be asked about one of them does not have a language problem — it
     * has an ambiguity problem: one provision, two rows, and no way for the
     * caller to say which one they meant.
     *
     * A caller that names a language gets that language. A caller that does not
     * gets the corpus's default, and the surfaces above the corpus are where the
     * choice is inferred from the question.
     */
    language?: string;
    /** ISO-8601 date, inclusive. */
    since?: string;
    /** ISO-8601 date, inclusive. */
    until?: string;
    limit?: number;
}
export interface CorpusContext {
    /** A database handle for corpus adapters. Absent in unit tests. */
    db?: CorpusDatabase;
    /** Injectable for tests. */
    fetch: typeof fetch;
    now: () => Date;
    /**
     * The similarity index, when the corpus has one.
     *
     * A corpus that is searched by meaning rather than by keyword needs somewhere
     * to look for neighbours. The index holds **no text** — only vectors and
     * metadata — so the canonical row, and the licence policy that governs it,
     * still live in the database. An index that held the text would be a second
     * copy of the corpus that bypassed the gate.
     *
     * Absent means the corpus falls back to its lexical path, which is right for
     * a small corpus and wrong for a large one.
     */
    vector?: VectorIndex;
    /**
     * Turns a question into a vector, in the index's own space.
     *
     * It is a function rather than a service so that the caller chooses: a
     * server-side model, a browser model that produces the same vectors from the
     * same file, or a test double.
     */
    embedQuery?: (text: string) => Promise<number[]>;
}
/** One neighbour from the similarity index. */
export interface VectorMatch {
    /** The id of the row this vector belongs to. */
    id: string;
    /** The similarity, higher is closer. */
    score: number;
    /** Whatever the index was told about the row when it was written. */
    metadata: Record<string, string | number>;
}
/**
 * Where the vectors live.
 *
 * The seam between the corpus and whatever stores the embeddings: a Vectorize
 * index, a Postgres table with pgvector, or a file the evaluation reads.
 */
export interface VectorIndex {
    /**
     * The nearest neighbours to a vector.
     *
     * The filter is a set of metadata equality constraints, which is how the
     * language lens reaches the index: the language is a column on the row, so
     * it is a filter on the vector, and a French question never has to compete
     * with the English rows for a place in the top k.
     */
    query(vector: number[], topK: number, filter?: Record<string, string>): Promise<VectorMatch[]>;
}
/**
 * A corpus the product can query.
 *
 * Adapters return *raw* items. Sanitisation against the corpus policy happens in
 * `emitCorpusItem`, so no adapter is trusted to enforce the licence itself.
 */
export interface Corpus {
    id: string;
    policy: CorpusPolicy;
    /** Whether this corpus can contribute to the given query at all. */
    supports(query: CorpusQuery): boolean;
    retrieve(query: CorpusQuery, ctx: CorpusContext): Promise<RawCorpusItem[]>;
}
