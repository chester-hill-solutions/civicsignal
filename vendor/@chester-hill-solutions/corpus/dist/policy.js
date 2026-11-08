/**
 * Licence regimes for corpora, and the gate that enforces them.
 *
 * Public records are not all equally reusable. Some are open for commercial
 * redistribution; some may be quoted and cited but not republished; some may only
 * be referenced by title and link. A corpus that serves one of these without
 * knowing which regime it is under is a legal exposure, and the failure is silent:
 * the response looks correct, and it is not lawful to send it.
 *
 * So the regime is declared once, per corpus, and enforced at emission. A corpus
 * declared `cite-only` cannot have its body returned no matter which route, tool or
 * caller asks for it, because the stripping happens here rather than at each call
 * site.
 */
export class LicenceViolation extends Error {
    corpusId;
    field;
    redistribution;
    constructor(corpusId, field, redistribution) {
        super(`Corpus "${corpusId}" may not emit "${field}" under its ${redistribution} terms.`);
        this.corpusId = corpusId;
        this.field = field;
        this.redistribution = redistribution;
        this.name = "LicenceViolation";
    }
}
/**
 * Apply a corpus policy to a raw item, producing what may legally be returned.
 *
 * The declared regime is an upper bound; flags may restrict it further, never widen
 * it. Invalid policy caps and missing required source links fail closed.
 */
export function emitCorpusItem(policy, raw) {
    if (!Number.isSafeInteger(policy.excerptMaxChars) || policy.excerptMaxChars < 0) {
        throw new RangeError("excerptMaxChars must be a finite, nonnegative safe integer.");
    }
    if (raw.corpusId !== policy.id) {
        throw new Error(`Corpus mismatch: policy "${policy.id}" cannot emit an item from "${raw.corpusId}".`);
    }
    const item = {
        corpusId: raw.corpusId,
        kind: raw.kind,
        id: raw.id,
        title: raw.title,
        citationUrl: raw.citationUrl,
        publishedAt: raw.publishedAt,
        source: raw.source,
        language: raw.language,
        jurisdiction: raw.jurisdiction,
        topics: policy.redistribution === "metadata-only" ? undefined : raw.topics,
        entities: policy.redistribution === "metadata-only" ? undefined : raw.entities,
        sentiment: policy.redistribution === "metadata-only" ? undefined : raw.sentiment,
        extra: policy.redistribution === "open" ? raw.extra : undefined,
        redistribution: policy.redistribution,
        attribution: attributionFor(policy),
    };
    if (policy.redistribution === "open" && policy.allowFullText && raw.body !== undefined) {
        item.body = raw.body;
    }
    if ((policy.redistribution === "open" || policy.redistribution === "cite-only") &&
        policy.excerptMaxChars > 0 &&
        raw.excerpt !== undefined) {
        item.excerpt = truncate(raw.excerpt, policy.excerptMaxChars);
    }
    if (policy.requireSourceLink && !raw.citationUrl) {
        throw new LicenceViolation(policy.id, "citationUrl", policy.redistribution);
    }
    return item;
}
/**
 * Emit a mixed-corpus batch through the same gate. Unknown corpora are skipped;
 * invalid known policies or missing required source links still fail the batch.
 */
export function emitCorpusItems(policies, raws) {
    const out = [];
    for (const raw of raws) {
        const policy = policies.get(raw.corpusId);
        if (!policy)
            continue; // unknown corpus: never emit it
        out.push(emitCorpusItem(policy, raw));
    }
    return out;
}
export function truncate(value, maxChars) {
    if (maxChars <= 0)
        return "";
    if (value.length <= maxChars)
        return value;
    return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
/** The attribution block that must accompany any response drawing on this corpus. */
export function attributionFor(policy) {
    return `${policy.attribution} — ${policy.licence}. ${policy.conditions.join(" ")}`.trim();
}
