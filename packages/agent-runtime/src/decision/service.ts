/**
 * The host decision service (VC-478): the one door every caller of a decision
 * model goes through.
 *
 * A caller names its purpose, hands a state and questions, and says what it
 * does with an answer and what it does without one. The service holds the
 * request to its bounds, resolves which model the caller's scope configured,
 * waits for a slot, asks within the purpose's deadline, holds the answer to
 * the questions it answers, meters what it cost, and hands the caller either
 * its `use` or its `fallback`. Every way a decision can fail to happen —
 * unset, not opted into, needs setup, a bound broken, a slow or erroring
 * model, an answer of the wrong shape, an abort — is the fallback, so a
 * feature built on this cannot break or block because of the model.
 *
 * Pure orchestration: settings, the classifier and the usage ledger are
 * injected, which is what lets one test drive every branch against a
 * network-free fixture provider. The desktop wires the real ones (Pi's
 * classifiers, the profile's settings, the Session ledger).
 */

import {
  checkDecisionRequest,
  DECISION_MAX_CONCURRENT,
  DECISION_PURPOSE_POLICY,
  decisionMiss,
  decisionTargetFor,
  isDecisionPurpose,
  readDecisionAnswers,
  type DecisionAnswered,
  type DecisionCall,
  type DecisionMiss,
  type DecisionModelSetting,
  type DecisionPort,
  type DecisionPurpose,
  type DecisionPurposePolicy,
  type DecisionTarget,
  type SessionUsage,
} from "@volli/shared";

import {
  LOCAL_DECISION_PROVIDER_ID,
  type ClassifierCallResult,
  type DecisionClassifier,
} from "../pi/classifier";

export interface DecisionServiceOptions {
  /**
   * The setting the caller's scope uses: the project's override, else the
   * app-wide one. Read per call, so a change in Settings reaches the next
   * decision; the `classify` tool's PRESENCE is frozen at Session birth, its
   * target is not. A read that throws is treated as no decision model.
   */
  resolveSetting(scope: {
    sessionId: string | null;
    projectId: string | null;
  }): DecisionModelSetting | Promise<DecisionModelSetting>;
  classifier: DecisionClassifier;
  /**
   * Bills one decision's usage to its Session, as a `usage.recorded` fact
   * with cause `decision`. A call with no Session is not metered here — its
   * caller attributes it once there is a Session to attribute it to.
   */
  recordUsage?(fact: {
    sessionId: string;
    purpose: DecisionPurpose;
    usage: SessionUsage;
  }): void | Promise<void>;
  /** Where a background usage-recording failure goes; the decision does not wait on it. */
  onRecordFailure?(error: unknown): void;
  now?(): number;
  /** Calls in flight at once, per purpose. Defaults to {@link DECISION_MAX_CONCURRENT}. */
  maxConcurrent?: number;
  /**
   * How long past its purpose's deadline a slot is held for a classifier that
   * has not settled, before it is freed regardless. Defaults to
   * {@link SLOT_GRACE_MS}.
   */
  slotGraceMs?: number;
  /** The purpose policy; tests may override deadlines they cannot wait out. */
  policyFor?(purpose: DecisionPurpose): DecisionPurposePolicy;
}

/**
 * Admission in arrival order, never past a waiter's own deadline.
 *
 * A slot is handed straight from the call that frees it to the next waiter, so
 * a burst cannot overtake a call already queued. A waiter whose deadline or
 * abort fires first leaves the queue and is answered with its fallback.
 */
class Slots {
  #free: number;
  /** Waiters in arrival order; a Set so a waiter that leaves is removed exactly once. */
  readonly #waiting = new Set<() => void>();

  constructor(capacity: number) {
    this.#free = Math.max(1, Math.floor(capacity));
  }

  /**
   * A slot, or `false` when `signal` aborts first. The caller acquires only
   * with a live signal — it has just raced the same signal — so an
   * already-aborted one needs no branch of its own here.
   */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const admit = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = (): void => {
        this.#waiting.delete(admit);
        resolve(false);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.#waiting.add(admit);
    });
  }

  release(): void {
    const [next] = this.#waiting;
    if (next === undefined) {
      this.#free += 1;
      return;
    }
    this.#waiting.delete(next);
    next();
  }
}

/**
 * A slot stays held while its call is in flight, even once the caller has
 * given up, so a burst of abandoned calls cannot pile up on a slow server. A
 * classifier that ignores its abort signal is let go of this long after the
 * deadline, so it cannot hold a slot forever.
 */
const SLOT_GRACE_MS = 5_000;

function describeTarget(target: DecisionTarget): DecisionAnswered["model"] {
  return target.where === "local"
    ? { where: "local", providerId: LOCAL_DECISION_PROVIDER_ID, modelId: target.modelId }
    : { where: "cloud", providerId: target.providerId, modelId: target.modelId };
}

/** The decision service, as every caller holds it. */
export function createDecisionService(options: DecisionServiceOptions): DecisionPort {
  const now = options.now ?? Date.now;
  // One queue per purpose so independent callers never share a slow queue.
  const queues = new Map<DecisionPurpose, Slots>();
  const slotsFor = (purpose: DecisionPurpose): Slots => {
    const existing = queues.get(purpose);
    if (existing !== undefined) return existing;
    const created = new Slots(options.maxConcurrent ?? DECISION_MAX_CONCURRENT);
    queues.set(purpose, created);
    return created;
  };

  const recordSafely = (work: () => void | Promise<void>): void => {
    // Metering never holds the caller: a decision already made is
    // the caller's whether or not its bill landed. A failure is reported to
    // the host, which logs it — nobody is waiting on this to toast.
    void (async () => {
      try {
        await work();
      } catch (error) {
        options.onRecordFailure?.(error);
      }
    })();
  };

  return {
    async decide<T>(call: DecisionCall<T>): Promise<T> {
      const started = now();
      const sessionId = call.sessionId ?? null;
      const miss = (value: DecisionMiss): T => call.fallback(value);

      if (!isDecisionPurpose(call.purpose)) {
        return miss(decisionMiss("invalid-request", "This caller is not a decision purpose."));
      }
      const purpose = call.purpose;
      const policy = options.policyFor?.(purpose) ?? DECISION_PURPOSE_POLICY[purpose];
      const checked = checkDecisionRequest({ state: call.state, questions: call.questions });
      if (!checked.ok) return miss(decisionMiss("invalid-request", checked.problem));
      const request = checked.value;

      // One deadline for the whole call — reading the setting, queueing and
      // asking: a caller is promised an answer or its fallback within its
      // purpose's time, whatever part of the way is slow.
      const timeoutMs = policy.timeoutMs;
      const withdraw = new AbortController();
      let timedOut = false;
      // Settles when the call is withdrawn for any reason. Created before any
      // abort can land, so it cannot miss one; a call withdrawn before it
      // starts never waits on it.
      const gaveUp = new Promise<null>((resolve) => {
        withdraw.signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        withdraw.abort(new Error("decision timed out"));
      }, timeoutMs);
      const onCallerAbort = (): void => withdraw.abort(call.signal?.reason);
      if (call.signal?.aborted === true) withdraw.abort(call.signal.reason);
      else call.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const late = (): DecisionMiss =>
        timedOut
          ? decisionMiss(
              "timeout",
              `The decision model did not answer within ${Math.round(timeoutMs / 1000)} s.`,
            )
          : decisionMiss("aborted", "The decision was withdrawn.");

      try {
        if (withdraw.signal.aborted) return miss(late());
        let setting: DecisionModelSetting | null;
        try {
          setting = await Promise.race([
            Promise.resolve().then(() =>
              options.resolveSetting({ sessionId, projectId: call.projectId ?? null }),
            ),
            gaveUp,
          ]);
        } catch {
          setting = { kind: "none" };
        }
        if (setting === null) return miss(late());
        const routed = decisionTargetFor(setting, purpose);
        if (!routed.ok) return miss(routed.miss);
        const target = routed.target;
        const slots = slotsFor(purpose);
        if (!(await slots.acquire(withdraw.signal))) return miss(late());
        // Freed when the call settles, not when the caller stops waiting: a
        // call still in flight is still load on the model. The cap frees it
        // regardless if the classifier never settles.
        let held = true;
        const release = (): void => {
          if (!held) return;
          held = false;
          clearTimeout(cap);
          slots.release();
        };
        const cap = setTimeout(release, timeoutMs + (options.slotGraceMs ?? SLOT_GRACE_MS));
        // Through `then`, so a classifier that throws instead of rejecting
        // is a provider error like any other, never a rejected `decide`.
        const asked = Promise.resolve()
          .then(() => options.classifier.classify(target, request, { signal: withdraw.signal }))
          .catch((): ClassifierCallResult => ({
            ok: false,
            usage: null,
            miss: decisionMiss("provider-error", "The decision model could not answer."),
          }));
        void asked.finally(release);
        // Billed whenever the answer lands — after a timeout or an abort
        // too: a provider that answered late still charged for it, and
        // `volli cost` must see what was spent.
        void asked.then((settled) => {
          const record = options.recordUsage;
          const usage = settled.usage;
          if (usage === null || sessionId === null || record === undefined) return;
          recordSafely(() => record({ sessionId, purpose, usage }));
        });
        // Raced against the deadline as well as signalled: a classifier
        // that ignores its signal still cannot hold the caller past it.
        const result = await Promise.race([asked, gaveUp]);
        if (result === null) return miss(late());
        if (!result.ok) return miss(result.miss);
        const answers = readDecisionAnswers(request.questions, result.answers);
        if (answers === null) {
          return miss(
            decisionMiss(
              "malformed-answer",
              "The decision model's answer did not answer every question asked.",
            ),
          );
        }
        const answered: DecisionAnswered = {
          answers,
          model: describeTarget(target),
          elapsedMs: Math.max(0, now() - started),
        };
        try {
          return call.use(answered);
        } catch {
          return miss(
            decisionMiss("malformed-answer", "The caller could not act on the decision's answer."),
          );
        }
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
