/**
 * The billing periods.
 *
 * UTC, always. A caller's local month is not the account's billing month, and a
 * fuse that resets at midnight in Toronto resets at a different moment for
 * everyone else.
 */
/** The billing month, `YYYY-MM`, in UTC. */
export function utcMonth(nowMs = Date.now()) {
    return new Date(nowMs).toISOString().slice(0, 7);
}
/** The billing day, `YYYY-MM-DD`, in UTC. */
export function utcDay(nowMs = Date.now()) {
    return new Date(nowMs).toISOString().slice(0, 10);
}
/**
 * A day before a given day, `YYYY-MM-DD`.
 *
 * `days` is how many days back, so the daily window is a single call rather than
 * seven of them.
 */
export function dayBefore(day, days = 1) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
}
