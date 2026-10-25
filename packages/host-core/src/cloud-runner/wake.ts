/**
 * A runner's sleep and wake: what it tells the backend as the machine goes
 * to sleep, and the order it comes back in.
 *
 * **Sleep.** `asleep` is reported best-effort, within a short budget: the
 * process is about to freeze, and nothing waits on it. If the report never
 * lands, the backend's offline sweep marks the runner `offline` after 90 s,
 * which is the same answer, later.
 *
 * **Wake**, in order:
 * 1. replace the connection at once (a socket that slept can read as
 *    connected for a minute while it is dead);
 * 2. exchange the refresh credential for a fresh runner token (the one held
 *    has most likely expired during the sleep);
 * 3. report `online` and beat now, so viewers see the runner back within one
 *    round trip rather than at the next 30 s beat.
 *
 * What follows the reconnect — resending facts, renewing leases before
 * claiming — is `startRunnerSync`'s, on the link's own `connected`.
 *
 * {@link watchSleep} turns a {@link PowerPort} into one sleep and one wake per
 * real sleep: a wake is counted only after a `suspend`, so a screen unlock or
 * a repeated `resume` does not reconnect a runner that never slept. A Mac
 * feeds Electron's `powerMonitor`; a Linux box that never suspends feeds
 * nothing and may call {@link RunnerPowerCycle.resume} on a network change.
 */
import type { PowerEvent, PowerPort } from "../ports/power";
import type { BackendLink } from "./backend-link";
import type { RunnerPresence } from "./presence";

/** How long a sleep waits for its `asleep` report before the machine freezes anyway. */
export const RUNNER_SUSPEND_REPORT_BUDGET_MS = 2_000;

export interface RunnerPowerCycle {
  /** The machine is going to sleep: report `asleep`, giving up after the budget. Never rejects. */
  suspend(): Promise<void>;
  /** The machine is awake again: the wake sequence above. Never rejects. */
  resume(): Promise<void>;
}

export interface RunnerPowerCycleOptions {
  link: Pick<BackendLink, "reconnectNow">;
  /** The runner token source's `token`. */
  token(options: { forceRefreshToken: boolean }): Promise<string | null>;
  presence: Pick<RunnerPresence, "setState" | "beatNow">;
  suspendBudgetMs?: number;
  /** A step failed (offline after wake is normal; the link and the next beat retry). */
  onError?(error: unknown): void;
}

/** `promise`, or nothing once `ms` have passed. Never rejects. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    void promise.then(finish, finish);
  });
}

export function createRunnerPowerCycle(options: RunnerPowerCycleOptions): RunnerPowerCycle {
  const budget = options.suspendBudgetMs ?? RUNNER_SUSPEND_REPORT_BUDGET_MS;
  const report = (error: unknown) => options.onError?.(error);
  return {
    async suspend() {
      await within(options.presence.setState("asleep").catch(report), budget);
    },
    async resume() {
      options.link.reconnectNow();
      // Recorded at once; sent on the new connection, or re-published by the next beat.
      const online = options.presence.setState("online").catch(report);
      try {
        await options.token({ forceRefreshToken: true });
      } catch (error) {
        // Offline right after wake: the link asks again when it connects.
        report(error);
      }
      await online;
      await options.presence.beatNow().catch(report);
    },
  };
}

/** The events that prove the machine awake after a `suspend`. */
const WAKE_EVENTS: readonly PowerEvent[] = ["resume", "unlock-screen", "user-did-become-active"];

/** Calls `onSleep` on each `suspend` and `onWake` once on the first wake event after it. Returns the unsubscribe. */
export function watchSleep(
  power: PowerPort,
  handlers: { onSleep(): void; onWake(): void },
): () => void {
  let asleep = false;
  const sleep = () => {
    asleep = true;
    handlers.onSleep();
  };
  const wake = () => {
    if (!asleep) return;
    asleep = false;
    handlers.onWake();
  };
  power.on("suspend", sleep);
  for (const event of WAKE_EVENTS) power.on(event, wake);
  return () => {
    power.removeListener("suspend", sleep);
    for (const event of WAKE_EVENTS) power.removeListener(event, wake);
  };
}
