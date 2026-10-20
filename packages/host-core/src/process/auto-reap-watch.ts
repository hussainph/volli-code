/**
 * The background half of the orphan process sweep (VC-341): a slow tick that
 * asks the service whether the opt-in policy has anything to do.
 *
 * The tick is deliberately dumb and slow. Every decision — is the setting on,
 * is anything old enough, is the machine actually short of memory — belongs to
 * the service and to the pure policy behind it, so this file cannot become a
 * second place where reaping is decided. When the setting is off, a tick costs
 * one `app_state` read and stops there: no process table walk, no `lsof`.
 *
 * An hour between ticks, because the condition it waits for is measured in
 * days. Nothing here reacts to memory pressure as it happens; a person who
 * needs the memory back now presses Reap, and that is the faster path anyway.
 *
 * `stop()` only disarms the timers. A tick already asking the service reads
 * the database and may record its reaps, so a host closing that database
 * stops the watch and then awaits `settled()` (VC-627).
 */

import type { OrphanProcessService } from "./orphan-processes";
import type { LogFields } from "../log/logger";
import { hostLogger } from "../log/root";

const reapLog = hostLogger("orphan-processes");

/** How long between two asks. */
export const AUTO_REAP_INTERVAL_MS = 60 * 60 * 1000;
/** How long after boot the first ask waits, so it never competes with a launch. */
export const AUTO_REAP_FIRST_DELAY_MS = 5 * 60 * 1000;

export interface AutoReapWatch {
  start(): void;
  /** Disarms the timers. A tick already running is not interrupted: see `settled`. */
  stop(): void;
  /** One ask now, awaited. The timers call this; tests drive it directly. */
  tick(): Promise<void>;
  /**
   * Resolves once no tick is in flight — including one started while this
   * waited. Never rejects and adds no delay of its own.
   */
  settled(): Promise<void>;
}

export interface AutoReapWatchOptions {
  intervalMs?: number;
  firstDelayMs?: number;
  log?: (msg: string, fields?: LogFields) => void;
}

export function createAutoReapWatch(
  service: OrphanProcessService,
  options: AutoReapWatchOptions = {},
): AutoReapWatch {
  const intervalMs = options.intervalMs ?? AUTO_REAP_INTERVAL_MS;
  const firstDelayMs = options.firstDelayMs ?? AUTO_REAP_FIRST_DELAY_MS;
  const log = options.log ?? reapLog.info;
  let interval: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  /** Ticks still running, timer-fired and direct alike. */
  const inFlight = new Set<Promise<void>>();

  const ask = async (): Promise<void> => {
    try {
      const outcome = await service.autoReap();
      // Only a reap is worth a line: "declined, the setting is off" every hour
      // is noise about a decision nobody made this hour.
      if (outcome.reaped.length > 0) {
        log("reaped orphan processes under memory pressure", { reaped: outcome.reaped.length });
      }
    } catch (error) {
      // Nobody is waiting on this: it is work no person asked for, its failure
      // has no action a toast could offer, and the panel still lists everything
      // it would have taken.
      log("automatic orphan sweep failed", { error });
    }
  };

  const tick = (): Promise<void> => {
    const run = ask();
    inFlight.add(run);
    // Observed on both paths, so tracking never adds a rejection of its own:
    // a tick that rejects still rejects to whoever called it, exactly as before.
    const forget = (): void => {
      inFlight.delete(run);
    };
    run.then(forget, forget);
    return run;
  };

  return {
    start() {
      if (interval !== null) return;
      first = setTimeout(() => void tick(), firstDelayMs);
      interval = setInterval(() => void tick(), intervalMs);
      // Neither timer may hold the app open: this is housekeeping, and an
      // Electron main process that cannot quit because of it would be a worse
      // bug than the one it cleans up after.
      first.unref?.();
      interval.unref?.();
    },
    stop() {
      if (first !== null) clearTimeout(first);
      if (interval !== null) clearInterval(interval);
      first = null;
      interval = null;
    },
    tick,
    async settled() {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },
  };
}
