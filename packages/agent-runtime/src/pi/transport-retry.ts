/**
 * How hard a transient provider failure is chased before it becomes the user's.
 *
 * Behavioral, not durable: nothing derived from these numbers is written to
 * history, so retuning them changes only how long recovery takes and how many
 * attempts the exhaustion message names.
 *
 * The budget is for a machine that is ONLINE and failing — a provider that is
 * overloaded, a gateway that keeps answering 502, a connection that keeps
 * dropping. A machine that is offline spends none of it: the runtime waits for
 * the network instead (see `connectivity.ts`), for as long as that takes,
 * because a laptop closed on a train for three hours has not failed at
 * anything (VC-443). The old budget — ten attempts under an eight-second
 * ceiling, about a minute in all — assumed every outage was a blip, and the
 * owner's ledger shows 82 hours of Session time dead-ended on exactly that
 * assumption.
 */

/** The first wait. Short, because most drops are a single lost packet. */
export const TRANSPORT_RETRY_BASE_MS = 500;
/**
 * The longest single wait. A minute: long enough that a provider shedding load
 * is not hammered, short enough that one that recovered is noticed promptly.
 */
export const TRANSPORT_RETRY_CEILING_MS = 60_000;
/** So ten Sessions that lost the same socket do not reconnect in lockstep. */
export const TRANSPORT_RETRY_JITTER_MS = 100;
/**
 * The most a turn waits between attempts while online, summed, before the
 * failure is raised as an Attention. Counted in scheduled waits rather than
 * wall-clock time on purpose: a machine that sleeps in the middle of a backoff
 * has spent one wait, not the hours the lid was closed, and a request that
 * hung until the stall detector cut it is not the provider's budget to charge.
 * Under the default schedule this is twenty attempts.
 */
export const TRANSPORT_RETRY_BUDGET_MS = 15 * 60_000;
/**
 * A backstop, not the budget: a host that injects a schedule waiting nothing
 * (every deterministic test) would otherwise never exhaust a budget measured
 * in waiting. Above the twenty the default schedule reaches, so it never binds
 * in the product.
 */
export const TRANSPORT_RETRY_LIMIT = 24;
/**
 * The attempt from which the chat says it is reconnecting. The first two
 * retries cost a second and a half between them and are the blips a person
 * should never see; after that the wait is long enough to look like a hang.
 */
export const TRANSPORT_NOTICE_AFTER_ATTEMPTS = 3;

/** Exponential backoff to a ceiling, jittered so ten Sessions do not reconnect in lockstep. */
export function autoRetryDelayMs(attempt: number): number {
  const backoff = Math.min(TRANSPORT_RETRY_BASE_MS * 2 ** attempt, TRANSPORT_RETRY_CEILING_MS);
  return backoff + Math.random() * TRANSPORT_RETRY_JITTER_MS;
}

/** What one turn has already spent chasing an online failure. */
export interface TransportRetrySpent {
  attempts: number;
  waitedMs: number;
}

export type TransportRetryPlan = { kind: "back-off"; delayMs: number } | { kind: "give-up" };

/**
 * The next online retry, or none.
 *
 * `backoffMs` is the schedule's wait for this attempt; `hintMs` is how long the
 * provider asked for, when it said. The longer of the two is waited — a
 * provider that said "try again in 20s" is not asked again in 2 — and a wait
 * that would carry the turn past its budget is not started: a provider asking
 * for an hour is describing a quota in all but name, and the person should
 * hear about it now rather than after a wait that ends in the same refusal.
 */
export function planTransportRetry(
  spent: TransportRetrySpent,
  backoffMs: number,
  hintMs: number | undefined,
): TransportRetryPlan {
  if (spent.attempts >= TRANSPORT_RETRY_LIMIT) return { kind: "give-up" };
  const delayMs = hintMs === undefined ? backoffMs : Math.max(backoffMs, hintMs);
  if (spent.waitedMs + delayMs > TRANSPORT_RETRY_BUDGET_MS) return { kind: "give-up" };
  return { kind: "back-off", delayMs };
}
