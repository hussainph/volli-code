/**
 * The daemon's half of an update (n3 §9.2): the running runner decides, asks
 * and drains; the applier (`apply.ts`, the update unit) stages, activates,
 * checks health and rolls back.
 *
 * Receiving production wiring (`run`, `src/commands/run.ts`): create one
 * agent per daemon with this build's version, pass {@link UpdateAgent.onTarget}
 * as `createHeadlessRunner`'s `onTarget`, `start()` it once the runner is
 * up and `stop()` it on shutdown, and merge {@link UpdateAgent.status} into
 * the status file's `update`. Its ports: `drain`/`resume` stop and restart
 * claiming (the headless runner's `drain()` and `reportState("online")`),
 * `inFlight` counts turns running here, and `report` sends one outcome to
 * Volli (`runnerUpdateReports.report`).
 *
 * One pass ({@link UpdateAgent.tick}), every {@link TICK_MS} and at each
 * heartbeat's target:
 *
 * 1. Report the applier's outcomes Volli has not heard yet, each once.
 * 2. Decide (`policy.ts`). Nothing to do: resume claiming if a drain was for
 *    an update that is no longer wanted.
 * 3. Not staged yet: write a stage request (the manifest URL is derived from
 *    the install's trusted release origin) and wait. A stage the applier
 *    refused or failed waits {@link RETRY_AFTER_MS} before the same release
 *    is tried again.
 * 4. Staged: drain (stop claiming; turns in flight finish). A target update
 *    activates after {@link IDLE_WINDOW_MS} without a turn, or gives up after
 *    {@link TARGET_DRAIN_MS} and resumes; an urgent one activates as soon as
 *    nothing runs, or after {@link URGENT_DRAIN_MS} regardless.
 * 5. Activate: write the activate request. The applier restarts this daemon
 *    on the new release; should it refuse instead, claiming resumes.
 */
import type { RunnerUpdateReport } from "@volli/shared/cloud";

import {
  outcomeReport,
  readNowRequest,
  readReported,
  readUpdaterState,
  writeReported,
  writeUpdateRequest,
} from "./files";
import type { NowRequest, UpdateOutcome, UpdaterState } from "./files";
import type { UpdateConfig } from "./config";
import { manifestUrlFor } from "./config";
import type { UpdateLayout } from "./layout";
import {
  decideUpdate,
  IDLE_WINDOW_MS,
  RETRY_AFTER_MS,
  TARGET_DRAIN_MS,
  URGENT_DRAIN_MS,
  type UpdateTarget,
} from "./policy";
import type { RunnerUpdateStatus } from "../shell/runner-status";

/** How often the agent looks again between heartbeats. */
export const TICK_MS = 15_000;
/** `update --now` expires: an old one must not make some later update urgent. */
export const NOW_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** A request the applier has not answered in this long is written again. */
export const REQUEST_STALE_MS = 30 * 60 * 1000;
/**
 * An activation settles in about five minutes (a restart, the health window,
 * perhaps a rollback). One still open after this is one the applier died in:
 * the agent wakes it to settle it.
 */
export const ACTIVATION_STALE_MS = 15 * 60 * 1000;

export interface UpdateAgentPorts {
  /** Stop claiming new work and report `draining`. */
  drain(): Promise<void>;
  /** Claim again, after a drain an update gave up on. */
  resume(): Promise<void>;
  /** Turns running on this runner now. */
  inFlight(): number;
  /**
   * Tell Volli about one outcome: `runnerUpdateReports.report` with these
   * args. Throws when it could not; it is sent again next pass.
   */
  report(report: RunnerUpdateReport): Promise<void>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
  setInterval(callback: () => void, ms: number): () => void;
}

export interface UpdateAgentOptions {
  readonly layout: UpdateLayout;
  readonly config: UpdateConfig;
  /** This build's version. */
  readonly running: string;
  /** Under systemd: something restarts the runner on its new release. */
  readonly supervised: boolean;
  readonly ports: UpdateAgentPorts;
  /** Called when {@link UpdateAgent.status} changes. */
  onStatus?(status: RunnerUpdateStatus): void;
}

export interface UpdateAgent {
  /** `createHeadlessRunner`'s `onTarget`: the heartbeat's target and floor. */
  onTarget(target: UpdateTarget): Promise<void>;
  /** One pass; passes never overlap. */
  tick(): Promise<void>;
  status(): RunnerUpdateStatus;
  start(): void;
  stop(): void;
}

interface Pending {
  readonly version: string;
  readonly urgent: boolean;
  readonly requestId: string;
  readonly phase: "staging" | "draining" | "activating";
  readonly since: number;
  /** When the drain began; meaningful once `phase` is past staging. */
  readonly drainingSince: number;
  readonly idleSince: number | null;
}

/** The newest recorded failure of `version`, if any. */
function lastFailure(state: UpdaterState, version: string): UpdateOutcome | undefined {
  return state.outcomes.findLast(
    (outcome) => outcome.kind === "update_failed" && outcome.version === version,
  );
}

export function createUpdateAgent(options: UpdateAgentOptions): UpdateAgent {
  const { layout, ports } = options;
  let target: UpdateTarget | null = null;
  let pending: Pending | null = null;
  let drained = false;
  let settleAskedAt = 0;
  const retryAfter = new Map<string, number>();
  let status: RunnerUpdateStatus = {
    targetVersion: null,
    minVersion: null,
    phase: "idle",
    detail: null,
  };
  let running: Promise<void> | null = null;
  let again = false;
  let offTimer: (() => void) | null = null;

  const setStatus = (phase: RunnerUpdateStatus["phase"], detail: string | null): void => {
    const next: RunnerUpdateStatus = {
      targetVersion: target?.targetVersion ?? null,
      minVersion: target?.minVersion ?? null,
      phase,
      detail,
    };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    options.onStatus?.(status);
  };

  async function reportOutcomes(state: UpdaterState): Promise<void> {
    const reported = readReported(layout.reportedFile);
    const fresh = state.outcomes.filter((outcome) => !reported.has(outcome.id));
    for (const outcome of fresh) {
      try {
        await ports.report(outcomeReport(outcome));
      } catch (error) {
        ports.log("update outcome not reported yet", { error: (error as Error).message });
        break;
      }
      reported.add(outcome.id);
      writeReported(layout.reportedFile, reported);
    }
  }

  async function resumeIfDrained(): Promise<void> {
    if (!drained) return;
    // Cleared only once claiming resumed: a failed resume is tried again next pass.
    await ports.resume();
    drained = false;
  }

  /** The request this pass wrote was answered with a failure: try that release later. */
  async function giveUp(version: string, detail: string): Promise<void> {
    retryAfter.set(version, ports.now() + RETRY_AFTER_MS);
    pending = null;
    await resumeIfDrained();
    setStatus("failed", detail);
  }

  function liveNowRequest(): NowRequest | null {
    let request: NowRequest | null;
    try {
      request = readNowRequest(layout.nowFile);
    } catch (error) {
      ports.log("ignoring the update-now request", { error: (error as Error).message });
      return null;
    }
    if (request === null) return null;
    const at = Date.parse(request.at);
    return Number.isFinite(at) && ports.now() - at < NOW_REQUEST_TTL_MS ? request : null;
  }

  async function pass(): Promise<void> {
    let state: UpdaterState;
    try {
      state = readUpdaterState(layout.stateFile);
    } catch (error) {
      ports.log("the updater state is unreadable", { error: (error as Error).message });
      setStatus("failed", "updater state unreadable");
      return;
    }
    await reportOutcomes(state);
    if (state.activating !== null) {
      // The applier is restarting this runner onto a release, or settling one.
      setStatus("activating", state.activating.version);
      const since = Math.max(Date.parse(state.activating.at) || 0, settleAskedAt);
      if (ports.now() - since >= ACTIVATION_STALE_MS) {
        ports.log("waking the updater to settle an activation", {
          version: state.activating.version,
        });
        writeUpdateRequest(layout.requestFile, {
          phase: "settle",
          version: state.activating.version,
          urgent: true,
        });
        settleAskedAt = ports.now();
      }
      return;
    }
    const decision = decideUpdate({
      running: options.running,
      target,
      now: liveNowRequest(),
      supervised: options.supervised,
      bad: state.bad,
    });
    if (decision.kind === "none") {
      pending = null;
      await resumeIfDrained();
      setStatus("idle", decision.why);
      return;
    }
    const { version } = decision;
    const now = ports.now();
    if (pending !== null && pending.version !== version) {
      pending = null;
      await resumeIfDrained();
    }
    if (pending === null) {
      // A failure the applier recorded holds for this process and the next.
      const failure = lastFailure(state, version);
      const recorded = failure === undefined ? 0 : Date.parse(failure.at) + RETRY_AFTER_MS;
      if (now < Math.max(retryAfter.get(version) ?? 0, recorded || 0)) {
        if (status.phase !== "failed") {
          setStatus("failed", `${version} failed here recently; trying again later`);
        }
        return;
      }
      retryAfter.delete(version);
    }
    const answered = pending !== null && state.handled.includes(pending.requestId);

    if (state.staged?.version !== version) {
      if (pending?.phase === "staging" && answered) {
        const failure = lastFailure(state, version);
        return giveUp(version, `staging ${version} failed: ${failure?.reason ?? "unknown"}`);
      }
      if (pending?.phase === "staging" && now - pending.since < REQUEST_STALE_MS) return;
      const request = writeUpdateRequest(layout.requestFile, {
        phase: "stage",
        version,
        manifestUrl: manifestUrlFor(options.config.releaseOrigin, version),
        urgent: decision.urgent,
      });
      pending = {
        version,
        urgent: decision.urgent,
        requestId: request.id,
        phase: "staging",
        since: now,
        drainingSince: now,
        idleSince: null,
      };
      ports.log("update requested", { version, reason: decision.reason });
      setStatus("staging", `${decision.reason}: ${version}`);
      return;
    }

    if (pending?.phase === "activating") {
      if (!answered && now - pending.since < REQUEST_STALE_MS) return;
      const failure = lastFailure(state, version);
      return giveUp(version, `activating ${version} failed: ${failure?.reason ?? "no answer"}`);
    }
    if (pending === null || pending.phase === "staging") {
      await ports.drain();
      drained = true;
      pending = {
        version,
        urgent: decision.urgent,
        requestId: "",
        phase: "draining",
        since: now,
        drainingSince: now,
        idleSince: null,
      };
      setStatus("staged", `${version} staged; waiting for turns to finish`);
    }
    const busy = ports.inFlight() > 0;
    const idleSince = busy ? null : (pending.idleSince ?? now);
    const drainingFor = now - pending.drainingSince;
    pending = { ...pending, urgent: decision.urgent, idleSince };
    const idleLongEnough = idleSince !== null && now - idleSince >= IDLE_WINDOW_MS;
    const ready = decision.urgent ? !busy || drainingFor >= URGENT_DRAIN_MS : idleLongEnough;
    if (!ready) {
      if (!decision.urgent && drainingFor >= TARGET_DRAIN_MS) {
        ports.log("no idle moment to update in; trying later", { version });
        return giveUp(version, `no idle moment for ${version}; trying again later`);
      }
      return;
    }
    const request = writeUpdateRequest(layout.requestFile, {
      phase: "activate",
      version,
      urgent: decision.urgent,
    });
    pending = { ...pending, phase: "activating", requestId: request.id, since: now };
    ports.log("update activating", { version });
    setStatus("activating", version);
  }

  async function tick(): Promise<void> {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (error) {
          ports.log("update pass failed", { error: (error as Error).message });
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    onTarget(next) {
      target = next;
      return tick();
    },
    tick,
    status: () => status,
    start() {
      offTimer ??= ports.setInterval(() => void tick(), TICK_MS);
      void tick();
    },
    stop() {
      offTimer?.();
      offTimer = null;
    },
  };
}
