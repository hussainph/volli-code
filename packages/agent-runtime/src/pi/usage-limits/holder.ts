/**
 * What is currently known about every account's usage, in one place.
 *
 * Two writers, one reader. The turn stream folds partial header updates in
 * through {@link UsageLimitsHolder.apply}; the Model Access probe settles a
 * full read through {@link UsageLimitsHolder.settle}; `inspectPiModelAccess`
 * reads the result onto each provider row. The fold rules themselves are
 * `@volli/shared`'s — this class only decides when to call them.
 *
 * IT IS READ, NOT PUSHED. Nothing subscribes here and nothing may: Model
 * Access reaches a client through one door, the `modelAccess.inspect` query,
 * and a second door pushing the same fact would be a new domain surface
 * without the command/event/projection shape `docs/BOUNDARIES.md` rule 5
 * requires of one. So a window a turn's headers reported appears the next
 * time the page is opened or Refreshed, not while a person watches it. That
 * is the whole of the contract; the alternative is a Ticket, not a callback.
 *
 * The holder is deliberately in-memory and not durable. A quota is a live
 * measurement of someone else's system, not a Session fact, and the ledger is
 * for facts. Losing it on relaunch costs one probe.
 */

import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  type UsageLimits,
  type UsageLimitsUpdate,
} from "@volli/shared";

import type { UsageProbeOutcome } from "./probe";

export class UsageLimitsHolder {
  readonly #byProvider = new Map<string, UsageLimits>();

  /** What is published for one provider, or nothing. */
  get(providerId: string): UsageLimits | undefined {
    return this.#byProvider.get(providerId);
  }

  /**
   * Folds one turn's partial report in.
   *
   * An update for a provider nothing has been published for creates the entry
   * — a turn's headers are a perfectly good first sighting — unless the update
   * is empty, in which case there is still nothing to publish.
   */
  apply(providerId: string, update: UsageLimitsUpdate): void {
    const current = this.#byProvider.get(providerId);
    const next = applyUsageLimitsUpdate(current, update);
    if (next !== current) this.#publish(providerId, next);
  }

  /**
   * Folds a probe's outcome in and answers with what is now published.
   *
   * A `verdict` is resolved against what was held — a failed read keeps the
   * last good one. `held` means the schedule declined to ask, so the answer is
   * whatever is there. `cleared` means the provider has nothing to show any
   * more (no credential, or not a provider with a read), and drops it: a
   * person who signed out should not keep seeing yesterday's bars.
   */
  settle(providerId: string, outcome: UsageProbeOutcome): UsageLimits | undefined {
    const current = this.#byProvider.get(providerId);
    switch (outcome.kind) {
      case "held":
        return current;
      case "cleared":
        if (current !== undefined) this.#publish(providerId, undefined);
        return undefined;
      case "verdict": {
        const next = resolveUsageLimitsAfterProbe(current, outcome.limits);
        if (next !== current) this.#publish(providerId, next);
        return next;
      }
    }
  }

  #publish(providerId: string, next: UsageLimits | undefined): void {
    if (next === undefined) this.#byProvider.delete(providerId);
    else this.#byProvider.set(providerId, next);
  }
}
