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
 * Throws rather than silently dropping fields when a caller asks for something the
 * regime forbids — that is a programming error, and it should fail loudly in tests
 * rather than quietly produce a less useful answer in production.
 */
export function emitCorpusItem(policy, raw) {
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
        topics: raw.topics,
        entities: raw.entities,
        sentiment: raw.sentiment,
        extra: raw.extra,
        redistribution: policy.redistribution,
        attribution: attributionFor(policy),
    };
    if (policy.allowFullText && raw.body !== undefined) {
        item.body = raw.body;
    }
    else if (raw.body !== undefined) {
        // The body exists upstream but this corpus does not permit it. Drop it here — the
        // excerpt path below is the sanctioned substitute — and leave the regime visible
        // in the output so consumers know what they are holding.
        delete item.body;
    }
    if (raw.excerpt !== undefined) {
        if (policy.excerptMaxChars === 0) {
            delete item.excerpt;
        }
        else {
            item.excerpt = truncate(raw.excerpt, policy.excerptMaxChars);
        }
    }
    if (policy.requireSourceLink && !raw.citationUrl) {
        throw new LicenceViolation(policy.id, "citationUrl", policy.redistribution);
    }
    return item;
}
/**
 * Emit a batch, skipping items whose policy forbids the requested field rather than
 * failing the whole response. Used for mixed-corpus responses where one corpus may
 * legitimately carry less than another.
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
