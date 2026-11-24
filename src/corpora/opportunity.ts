import { z } from 'zod';

/**
 * Shared state for a participation opportunity.
 *
 * A funding call states its own status, so its publisher decides the word. A
 * committee call does not: the publisher lists the studies that are seeking input
 * and may publish a deadline, so the state is computed for the date the client
 * asks about. Departmental consultations will use the same helper.
 */

export const OpportunityOpenState = z.enum(['open', 'closed', 'unknown']);

export const OpportunityBasis = z.enum([
  'deadline',
  'listing-observation',
  'unobserved',
]);

export const OpportunityDeadlineSchema = z.strictObject({
  text: z.string().min(1).describe("The publisher's phrase, verbatim."),
  instant: z.iso.datetime({ offset: true }).nullable()
    .describe('A UTC instant only when the phrase states a zone, date and weekday that agree.'),
  timeZone: z.string().nullable(),
});

export type OpportunityDeadline = z.infer<typeof OpportunityDeadlineSchema>;

export interface OpportunityObservation {
  firstObservedAt: string;
  observedAt: string;
}

/**
 * The state a client should see for one opportunity on one date.
 *
 * Before the first observation the answer is unknown, not closed. A published
 * deadline settles the answer. Without one, an observation vouches for the call
 * on the day it was made: the next day, without a refresh, the answer is unknown
 * rather than an implied withdrawal or an implied open call. The response carries
 * `observedAt` so a client can judge how fresh that is.
 */
export function openStateAsOf(
  deadline: OpportunityDeadline | null,
  observed: OpportunityObservation,
  asOf: string,
): { state: z.infer<typeof OpportunityOpenState>; basis: z.infer<typeof OpportunityBasis> } {
  const at = Date.parse(asOf);
  if (at < Date.parse(observed.firstObservedAt)) return { state: 'unknown', basis: 'unobserved' };
  if (deadline?.instant) {
    return { state: at <= Date.parse(deadline.instant) ? 'open' : 'closed', basis: 'deadline' };
  }
  const observedDayEnd = Date.parse(`${observed.observedAt.slice(0, 10)}T00:00:00Z`) + 86_400_000;
  return at < observedDayEnd
    ? { state: 'open', basis: 'listing-observation' }
    : { state: 'unknown', basis: 'listing-observation' };
}
