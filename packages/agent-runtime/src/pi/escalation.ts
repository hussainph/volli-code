/**
 * When a Session's own policy stops deserving to be enforced in silence.
 *
 * One refusal is not worth interrupting anyone over: the model is told no, tries
 * something else, and the work continues. A run of them is a different fact —
 * the policy is standing between the agent and the thing a person asked for, and
 * only that person can say whether that is the right outcome. Counting is what
 * tells those two apart, and {@link AuthorityFallback} is where the two shapes
 * of "enough" are named.
 *
 * It lives beside the Pi runtime rather than inside it because it is a state
 * machine over three numbers and one race, and neither needs a Pi loop to be
 * exercised. Nothing here records anything, blocks anything, or ends anything:
 * it answers what should happen to one call, and `runtime.ts` carries the answer
 * out.
 */

import {
  isOverridableAuthorityRule,
  type AuthorityDenialCause,
  type AuthorityFallback,
  type RuntimeAskOutcome,
  type RuntimeAskRequest,
  type RuntimeAskTrip,
} from "@volli/shared";
import type { AuthorityVerdict } from "../authority/gate";

/** Ask a person and block until they answer, exactly as the Session spec supplies it. */
type AskPort = (request: RuntimeAskRequest) => Promise<RuntimeAskOutcome>;

/** What the runtime must do with one call, once any escalation has settled. */
export type AuthorityDisposition =
  | { outcome: "proceed" }
  | {
      outcome: "refuse";
      /** The refusing rule's own words, which Pi hands to the model unchanged. */
      reason: string;
      cause: AuthorityDenialCause;
      /**
       * Whether this refusal is a fact about the Session or only something that
       * happened to one call.
       *
       * Almost always true — a refusal nobody was asked about is the ordinary
       * case and belongs in history. It is false in exactly one situation: a
       * question was put and nothing came back, because the run was cancelled or
       * the host gave up waiting. Nobody decided anything there, and a denial
       * written down on nobody's behalf would be a claim about a person that is
       * not true.
       */
      record: boolean;
      /** Set only by an explicit `stop`, and never without {@link record}. */
      endTurn: boolean;
    };

export interface AuthorityEscalationInput {
  fallback: AuthorityFallback;
  /** Refusals this Session accrued before this attachment existed. */
  priorDenials?: number;
  /**
   * Absent when there is no host to ask, which is a working configuration and
   * not a degraded one: every refusal then stays silent, thresholds and all.
   */
  ask?: AskPort;
  /** The attachment's own cancellation, distinct from any one call's. */
  signal?: AbortSignal;
}

/** The escalation state for one runtime attachment. */
export class AuthorityEscalation {
  readonly #fallback: AuthorityFallback;
  readonly #ask: AskPort | undefined;
  readonly #signal: AbortSignal | undefined;

  /**
   * Refusals since the last call that ran. Runtime-only, and necessarily so: an
   * allowed call leaves no trace in durable history, so nothing outside a live
   * attachment can tell a run of three refusals from three spread over a day.
   */
  #consecutiveDenials = 0;

  /**
   * Refusals across the whole Session, seeded from what history already holds.
   *
   * This is the delicate one, and it is the reason the bookkeeping below looks
   * the way it does. The seed is `SessionProjection.authorityDenials`, which
   * counts `authority.denied` events and nothing else, and the *next* attachment
   * will seed from that same count again. So this number must equal, at every
   * moment, what it started with plus the denials this attachment actually
   * emitted. A counter that advanced without a denial reaching the observer
   * would come back as a higher seed on the next attach and quietly move the
   * threshold for a Session nobody changed. Hence: the increment happens only in
   * the branches that tell the runtime to record, and an overridden call — which
   * ran — and a dismissed question — which decided nothing — advance nothing.
   */
  #sessionDenials: number;

  /**
   * The Session total at which the next question is due.
   *
   * A moving target rather than a comparison against the fallback, because the
   * fallback names an interval and not a line. Once a person has answered at
   * twenty the next question belongs at forty; a fixed comparison would ask
   * again on the twenty-first call, and on every call after that, which is how a
   * threshold meant to interrupt rarely turns into the thing people click
   * through without reading.
   *
   * It starts at the interval itself even when the seed is already past it, so a
   * Session reattaching at twenty-five is asked on its next refusal rather than
   * at forty. That is a re-base and not a mistake: the seed is a count of
   * denials, never a record of whether anyone was asked about them, so a
   * Session that accrued twenty-five with no host to ask is indistinguishable
   * here from one that answered at twenty and carried on. Asking the earlier of
   * the two readings is the safe direction — the cost is one extra question, and
   * the alternative is silence for the next fifteen refusals in the case where
   * nobody has been asked anything yet.
   */
  #sessionTrip: number;

  constructor(input: AuthorityEscalationInput) {
    this.#fallback = input.fallback;
    this.#ask = input.ask;
    this.#signal = input.signal;
    this.#sessionDenials = input.priorDenials ?? 0;
    this.#sessionTrip = input.fallback.sessionDenials;
  }

  /**
   * Decide one call, parking on a person when the counters say it is time.
   *
   * @param callSignal Pi's cancellation for the run this call belongs to, handed
   * to `beforeToolCall` as its second argument.
   */
  async resolve(
    verdict: AuthorityVerdict,
    tool: string,
    callSignal?: AbortSignal,
  ): Promise<AuthorityDisposition> {
    if (verdict.outcome === "allow") {
      this.#consecutiveDenials = 0;
      return { outcome: "proceed" };
    }
    const refused = {
      outcome: "refuse",
      reason: verdict.reason,
      cause: verdict.cause,
    } as const;

    const nextConsecutive = this.#consecutiveDenials + 1;
    const nextSession = this.#sessionDenials + 1;
    // Both halves are tested against what this refusal *would* make the counters,
    // not what they are, so a threshold of one escalates on the first refusal
    // rather than the second. Consecutive wins ties because it is the more
    // specific complaint: it names one line of work rather than the Session.
    const trip: RuntimeAskTrip | null =
      nextConsecutive >= this.#fallback.consecutiveDenials
        ? "consecutive"
        : nextSession >= this.#sessionTrip
          ? "session"
          : null;

    const ask = this.#ask;
    if (ask === undefined || trip === null) {
      this.#consecutiveDenials = nextConsecutive;
      this.#sessionDenials = nextSession;
      return { ...refused, record: true, endTurn: false };
    }

    const answer = await this.#askUntilAnsweredOrCancelled(
      ask,
      {
        cause: verdict.cause,
        tool,
        reason: verdict.reason,
        trip,
        overridable: isOverridableAuthorityRule(verdict.cause),
      },
      callSignal,
    );

    // However it ended, the question was put, and putting it again on the very
    // next refusal would be asking the same question of someone who has just
    // dealt with it — which is exactly the loop a dismissed dialog would spin
    // in. Both halves therefore stand down here, and the Session target is
    // recomputed after the increment so it lands an interval past wherever the
    // count actually got to.
    this.#consecutiveDenials = 0;
    if (answer === "refuse" || answer === "stop") this.#sessionDenials = nextSession;
    this.#sessionTrip = this.#sessionDenials + this.#fallback.sessionDenials;

    switch (answer) {
      case "allow":
        return { outcome: "proceed" };
      case "refuse":
        return { ...refused, record: true, endTurn: false };
      case "stop":
        return { ...refused, record: true, endTurn: true };
      case null:
        return { ...refused, record: false, endTurn: false };
    }
  }

  /**
   * Put the question and wait, unless something has already stopped waiting.
   *
   * Two signals, not one. Pi hands `beforeToolCall` the cancellation belonging to
   * the run it is preparing a call for; the attachment has its own, which reaches
   * Pi's through `agent.abort()`. Racing only the second would be racing on
   * somebody else's implementation continuing to chain the two, so both are
   * raced. A rejected ask means the same thing as either of them: nobody
   * decided, which is `null` and not a refusal.
   *
   * Parking indefinitely is deliberate and costs nothing. Pi awaits this callback
   * with no timeout of its own, and re-reads its signal the moment the await
   * returns — so an answer that arrives after the run was cancelled loses to
   * "Operation aborted", which is the honest thing for the model to be told.
   */
  async #askUntilAnsweredOrCancelled(
    ask: AskPort,
    request: RuntimeAskRequest,
    callSignal: AbortSignal | undefined,
  ): Promise<RuntimeAskOutcome | null> {
    const signals = [this.#signal, callSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.some((signal) => signal.aborted)) return null;
    const cancelled = Promise.withResolvers<null>();
    const abandon = (): void => cancelled.resolve(null);
    for (const signal of signals) signal.addEventListener("abort", abandon, { once: true });
    try {
      return await Promise.race([ask(request).catch(() => null), cancelled.promise]);
    } finally {
      // One attachment signal outlives every question asked against it, so a
      // listener left behind by the answer that won the race is not tidiness —
      // it is one leak per escalation for the life of the Session.
      for (const signal of signals) signal.removeEventListener("abort", abandon);
    }
  }
}
