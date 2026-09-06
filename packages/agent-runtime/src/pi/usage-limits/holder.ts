/**
 * What is currently known about every account's usage, in one place.
 *
 * Two writers, one reader. The turn stream folds partial header updates in
 * through {@link UsageLimitsHolder.apply}; the Model Access probe settles a
 * full read through {@link UsageLimitsHolder.settle}; `inspectPiModelAccess`
 * reads the result onto each provider row. The fold rules themselves are
 * `@volli/shared`'s — this class only decides when to call them and whether
 * anything changed.
 *
 * Change is identity. Both folds return the very object they were given when
 * nothing moved, so a listener is told only when a snapshot it might be
 * showing is now wrong, and a confirming header mid-turn costs nobody a
 * re-render.
 */

import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  type UsageLimits,
  type UsageLimitsUpdate,
} from "@volli/shared";

import type { UsageProbeOutcome } from "./probe";

/** Told when a provider's published usage changed. Never awaited; a throw is swallowed. */
export type UsageLimitsListener = (providerId: string, limits: UsageLimits | undefined) => void;

export class UsageLimitsHolder {
  readonly #byProvider = new Map<string, UsageLimits>();
  readonly #listeners = new Set<UsageLimitsListener>();

  /** What is published for one provider, or nothing. */
  get(providerId: string): UsageLimits | undefined {
    return this.#byProvider.get(providerId);
  }

  /**
   * Folds one turn's partial report in. Returns whether anything changed.
   *
   * An update for a provider nothing has been published for creates the entry
   * — a turn's headers are a perfectly good first sighting — unless the update
   * is empty, in which case there is still nothing to publish.
   */
  apply(providerId: string, update: UsageLimitsUpdate): boolean {
    const current = this.#byProvider.get(providerId);
    const next = applyUsageLimitsUpdate(current, update);
    if (next === current) return false;
    return this.#publish(providerId, next);
  }

  /**
   * Folds a probe's outcome in and answers with what is now published.
   *
   * A `read` is resolved against what was held — a failed one keeps the last
   * good read. `held` means the schedule declined to ask, so the answer is
   * whatever is there. `none` means the provider has nothing to show any more
   * (no credential, or not a provider with a read), and clears it: a person
   * who signed out should not keep seeing yesterday's bars.
   */
  settle(providerId: string, outcome: UsageProbeOutcome): UsageLimits | undefined {
    const current = this.#byProvider.get(providerId);
    switch (outcome.kind) {
      case "held":
        return current;
      case "none":
        if (current !== undefined) this.#publish(providerId, undefined);
        return undefined;
      case "read": {
        const next = resolveUsageLimitsAfterProbe(current, outcome.limits);
        if (next !== current) this.#publish(providerId, next);
        return next;
      }
    }
  }

  /** Subscribes to changes; returns the unsubscribe. */
  subscribe(listener: UsageLimitsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(providerId: string, next: UsageLimits | undefined): boolean {
    if (next === undefined) this.#byProvider.delete(providerId);
    else this.#byProvider.set(providerId, next);
    for (const listener of this.#listeners) {
      try {
        listener(providerId, next);
      } catch {
        // A listener that throws loses its notice, not the fold.
      }
    }
    return true;
  }
}
