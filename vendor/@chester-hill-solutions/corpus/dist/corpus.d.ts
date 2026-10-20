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
