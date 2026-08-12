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
  type RuntimeAskChoice,
  type RuntimeAskRequest,
  type RuntimeAskTrip,
} from "@volli/shared";
import type { AuthorityVerdict } from "../authority/gate";

/** Ask a person and block until they answer, exactly as the Session spec supplies it. */
type AskPort = (request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>;

/** What the runtime must do with one call, once any escalation has settled. */
export type AuthorityDisposition =
  | { outcome: "allow" }
  | {
      outcome: "deny";
      /**
       * The refusing rule's own words, for Pi to hand the model in place of a
       * result.
       *
       * Pi hands them over unchanged everywhere except the one path that sets
       * {@link interrupt}: it re-reads its own cancellation before it reads the
       * block, so a call refused by a `stop` answer reaches the model as
       * "Operation aborted" and this text is dropped. Pi offers no hook that
       * reorders those two reads, and the turn is ending regardless — the model
       * is told the run stopped rather than why, which is the honest reading of
       * what actually happened to it.
       */
      reason: string;
      cause: AuthorityDenialCause;
      /**
       * Whether this refusal is a fact about the Session or only something that
       * happened to one call.
       *
       * Almost always true — a refusal nobody was asked about is the ordinary
       * case and belongs in history, and so is one a person was asked about and
       * upheld. It is false in exactly one situation: a question was put and a
       * cancellation arrived before any answer did. Pi discards this block on
       * that path and substitutes its own "Operation aborted", so no refusal
       * took effect and nobody decided anything; a denial written down on
       * nobody's behalf would be a claim about a person that is not true.
       *
       * A host that *rejects* is the opposite case and records like any other
       * refusal. Nothing was cancelled, Pi applies the block, the call really is
       * refused and the model really is told why — a Session whose host can
       * never answer would otherwise accrue denials that never reach history and
       * a threshold that never arrives.
       */
      record: boolean;
      /** Set only by an explicit `stop`, and never without {@link record}. */
      interrupt: boolean;
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

/** One call offered for judgement, named well enough to put a question about it. */
export interface AuthorityCall {
  verdict: AuthorityVerdict;
  tool: string;
  /** The runtime's own id for this call, so a question can be shown against it. */
  toolCallId: string;
  turnId: string | null;
  /**
   * Pi's cancellation for the run this call belongs to, handed to
   * `beforeToolCall` as its second argument.
   */
  signal?: AbortSignal;
}

const ALLOW: AuthorityDisposition = { outcome: "allow" };

/** How one question ended, which is three outcomes and not two. */
type AskResult =
  | { kind: "answered"; choice: RuntimeAskChoice }
  /** A signal fired first: nobody was asked, so nothing was decided. */
  | { kind: "abandoned" }
  /** The host could not obtain an answer: the refusal stands, and is recorded. */
  | { kind: "unavailable" };

const ABANDONED: AskResult = { kind: "abandoned" };
const UNAVAILABLE: AskResult = { kind: "unavailable" };

/**
 * A threshold as a whole number of denials, or infinity for one that names no
 * interval at all.
 *
 * A fallback reaches here as two bare numbers off a durable Snapshot, so nothing
 * in the type stops a zero, a negative or a `NaN`. Zero and below would read as
 * "ask on every refusal", which is precisely the outcome an interval exists to
 * avoid — a threshold meant to interrupt rarely becomes the thing people click
 * through without reading. `NaN` compares false against everything and would
 * disable escalation while still looking configured.
 *
 * Infinity says the same thing a broken value would end up saying — never — but
 * says it in a number the arithmetic below stays coherent under, and it is the
 * behaviour that shipped before this port existed rather than a new one invented
 * on the strength of a bad config. Silence is also the conservative direction
 * here: the refusal already happened either way, and what a threshold decides is
 * only whether to interrupt someone about it.
 */
function denialThreshold(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

/** A count of denials already accrued, as a whole number no smaller than zero. */
function denialCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The escalation state for one runtime attachment. */
export class AuthorityEscalation {
  readonly #consecutiveThreshold: number;
  readonly #sessionInterval: number;
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
   * What this number actually guarantees is narrower than it looks, and the
   * bookkeeping below is shaped by the gap. The seed is
   * `SessionProjection.authorityDenials`, which counts `authority.denied` events
   * and nothing else, and the *next* attachment seeds from that same projection
   * again. But this counter advances when `resolve` decides a refusal should be
   * recorded — before `runtime.ts` commits anything, through a call that
   * swallows observer failures and whose sink can be discarded when the
   * attachment is released. So it counts refusals this attachment *told the
   * runtime to record*, not refusals that durably landed.
   *
   * The two can therefore disagree, and they disagree in one direction: the
   * projection can only be *lower* than this count, never higher. A denial that
   * never reached history means the next attach seeds low and its threshold
   * arrives later — the drift is toward silence, toward one question missed,
   * never toward a question invented on evidence that does not exist. Advancing
   * only in the branches that ask for a record is what keeps the drift to that
   * one direction: an overridden call — which ran — and an abandoned question —
   * which decided nothing — advance nothing.
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
    this.#consecutiveThreshold = denialThreshold(input.fallback.consecutiveDenials);
    this.#sessionInterval = denialThreshold(input.fallback.sessionDenials);
    this.#ask = input.ask;
    this.#signal = input.signal;
    this.#sessionDenials = denialCount(input.priorDenials);
    this.#sessionTrip = this.#sessionInterval;
  }

  /** Decide one call, parking on a person when the counters say it is time. */
  async resolve(call: AuthorityCall): Promise<AuthorityDisposition> {
    const verdict = call.verdict;
    if (verdict.outcome === "allow") {
      this.#consecutiveDenials = 0;
      return ALLOW;
    }
    const refused = {
      outcome: "deny",
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
      nextConsecutive >= this.#consecutiveThreshold
        ? "consecutive"
        : nextSession >= this.#sessionTrip
          ? "session"
          : null;

    const ask = this.#ask;
    if (ask === undefined || trip === null) {
      this.#consecutiveDenials = nextConsecutive;
      this.#sessionDenials = nextSession;
      return { ...refused, record: true, interrupt: false };
    }

    // Read once and used twice — to describe the question and to bound what its
    // answer is allowed to do. A host answering `allow` to a rule that is not
    // overridable is not obeyed: those rules are grantable and must not be
    // granted, nothing below stops them, and this is the layer that enforces the
    // distinction rather than the layer that trusts its caller.
    const overridable = isOverridableAuthorityRule(verdict.cause);
    const answer = await this.#askUntilAnsweredOrAbandoned(
      ask,
      {
        cause: verdict.cause,
        tool: call.tool,
        toolCallId: call.toolCallId,
        turnId: call.turnId,
        reason: verdict.reason,
        trip,
        overridable,
      },
      call.signal,
    );

    // However it ended, this run of refusals is over: a person who answered has
    // dealt with it, and a cancellation ended the turn the run belonged to.
    // Putting the same question up on the very next refusal would be the loop a
    // dismissed dialog spins in either way, so the consecutive half stands down
    // here whatever came back.
    this.#consecutiveDenials = 0;
    if (answer.kind === "abandoned") {
      // The Session half does not stand down, because nobody stood anything
      // down: no question was ever seen, so re-basing the target would buy an
      // interval of silence on the strength of an event that did not happen.
      return { ...refused, record: false, interrupt: false };
    }

    const choice = answer.kind === "answered" ? answer.choice : "refuse";
    const granted = choice === "allow" && overridable;
    if (!granted) this.#sessionDenials = nextSession;
    // Recomputed after the increment, so the next question lands an interval
    // past wherever the count actually got to.
    this.#sessionTrip = this.#sessionDenials + this.#sessionInterval;
    if (granted) return ALLOW;
    return { ...refused, record: true, interrupt: choice === "stop" };
  }

  /**
   * Put the question and wait, unless something has already stopped waiting.
   *
   * Two signals, not one. Pi hands `beforeToolCall` the cancellation belonging to
   * the run it is preparing a call for; the attachment has its own, which reaches
   * Pi's through `agent.abort()`. Racing only the second would be racing on
   * somebody else's implementation continuing to chain the two, so both are
   * raced — and both feed the {@link AbortController} whose signal the host is
   * handed, which is that host's only notice that the question it is showing has
   * been abandoned and must be withdrawn. `AbortSignal.any` composes the same
   * signal in one line, but it would need a listener of its own on top of the two
   * registered here and would leave a dependency on the attachment signal for the
   * life of every question ever asked against it; one listener per signal,
   * removed in a `finally`, leaves the attachment holding nothing.
   *
   * Parking indefinitely is deliberate and costs nothing. Pi awaits this callback
   * with no timeout of its own, and re-reads its signal the moment the await
   * returns — so an answer that arrives after the run was cancelled loses to
   * "Operation aborted", which is the honest thing for the model to be told.
   */
  async #askUntilAnsweredOrAbandoned(
    ask: AskPort,
    request: RuntimeAskRequest,
    callSignal: AbortSignal | undefined,
  ): Promise<AskResult> {
    const signals = [this.#signal, callSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.some((signal) => signal.aborted)) return ABANDONED;
    const abandoned = Promise.withResolvers<AskResult>();
    const withdrawn = new AbortController();
    const abandon = (): void => {
      withdrawn.abort();
      abandoned.resolve(ABANDONED);
    };
    for (const signal of signals) signal.addEventListener("abort", abandon, { once: true });
    try {
      // The call itself is inside the async arrow, not merely the promise it
      // returns. A host that is not `async`, one that throws a `TypeError`
      // before returning anything, or one that returns something that is not a
      // promise would otherwise throw straight past a `.catch` that has not been
      // attached yet — out through `resolve`, before the counter resets below
      // it, leaving the consecutive count one short of its threshold so that
      // every later refusal asks again and throws again, forever. A host that
      // cannot produce an answer is a host that cannot produce an answer,
      // however it fails to.
      const answered = (async () => ask(request, withdrawn.signal))().then(
        (choice): AskResult => ({ kind: "answered", choice }),
        (): AskResult => UNAVAILABLE,
      );
      return await Promise.race([answered, abandoned.promise]);
    } finally {
      // One attachment signal outlives every question asked against it, so a
      // listener left behind by the answer that won the race is not tidiness —
      // it is one leak per escalation for the life of the Session.
      for (const signal of signals) signal.removeEventListener("abort", abandon);
    }
  }
}
