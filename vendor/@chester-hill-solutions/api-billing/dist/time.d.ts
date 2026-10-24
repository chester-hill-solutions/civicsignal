/**
 * The billing periods.
 *
 * UTC, always. A caller's local month is not the account's billing month, and a
 * fuse that resets at midnight in Toronto resets at a different moment for
 * everyone else.
 */
/** The billing month, `YYYY-MM`, in UTC. */
export declare function utcMonth(nowMs?: number): string;
/** The billing day, `YYYY-MM-DD`, in UTC. */
export declare function utcDay(nowMs?: number): string;
/**
 * A day before a given day, `YYYY-MM-DD`.
 *
 * `days` is how many days back, so the daily window is a single call rather than
 * seven of them.
 */
export declare function dayBefore(day: string, days?: number): string;
