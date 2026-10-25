/**
 * The runner's liveness: a heartbeat every 30 s, its capabilities on connect
 * and on change, and the states it reports about itself.
 *
 * Live state needs no buffer: what was not delivered is simply published
 * again. So after any failure, the next successful heartbeat re-publishes
 * the capability report and the current state (the backend writes either
 * only on change). A runner the backend refuses as `revoked` stops beating
 * and says so once through `onRevoked`; every other failure is retried at the
 * next beat, because offline is not a fault — Sessions keep running and the
 * backend shows the runner `offline` after 90 s.
 *
 * {@link RunnerPresenceBackend} is the three runner mutations. The backend
 * link provides it over its Convex client (`runnerPresenceBackend`).
 */
import {
  RUNNER_HEARTBEAT_INTERVAL_MS,
  type RunnerCapabilityReport,
  type RunnerHeartbeatReply,
  type RunnerLoad,
  type RunnerReportedState,
} from "@volli/shared/cloud";

export interface RunnerPresenceBackend {
  heartbeat(args: { bootId: string; load: RunnerLoad }): Promise<RunnerHeartbeatReply>;
  reportState(args: { state: RunnerReportedState; reason: string | null }): Promise<unknown>;
  reportCapabilities(args: { report: RunnerCapabilityReport }): Promise<unknown>;
}

/** One call into the backend by function name (`"runners:heartbeat"`), as the backend link makes it. */
export type RunnerMutationCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** The runner mutations of `convex/functions/runners.ts`, by name. */
export const RUNNER_PRESENCE_FUNCTIONS = {
  heartbeat: "runners:heartbeat",
  reportState: "runners:reportState",
  reportCapabilities: "runners:reportCapabilities",
} as const;

export function runnerPresenceBackend(call: RunnerMutationCaller): RunnerPresenceBackend {
  return {
    heartbeat: async (args) =>
      (await call(RUNNER_PRESENCE_FUNCTIONS.heartbeat, args)) as RunnerHeartbeatReply,
    reportState: (args) => call(RUNNER_PRESENCE_FUNCTIONS.reportState, args),
    reportCapabilities: (args) => call(RUNNER_PRESENCE_FUNCTIONS.reportCapabilities, args),
  };
}

/** Whether a backend failure says this runner was removed or cut off. */
export function isRevokedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: unknown }).data;
  const code =
    typeof data === "object" && data !== null
      ? (data as { code?: unknown }).code
      : (error as { code?: unknown }).code;
  return code === "revoked";
}

export interface RunnerPresenceTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RunnerPresenceOptions {
  backend: RunnerPresenceBackend;
  /** New on every process start, so the backend can tell a restart from a long beat gap. */
  bootId: string;
  readLoad(): Promise<RunnerLoad> | RunnerLoad;
  readCapabilities(): Promise<RunnerCapabilityReport> | RunnerCapabilityReport;
  intervalMs?: number;
  timers?: RunnerPresenceTimers;
  /** Every heartbeat reply: the update target and the server's clock arrive here. */
  onReply?(reply: RunnerHeartbeatReply): void;
  onRevoked?(): void;
  /** A beat failed for a reason worth a log line (never a fault on its own). */
  onError?(error: unknown): void;
  /** How long `stop()` waits for a beat in flight and the `stopped` report (default 5 s). */
  stopTimeoutMs?: number;
}

/** A WebSocket client queues mutations through an outage, so a stop must not wait on them for ever. */
export const RUNNER_PRESENCE_STOP_TIMEOUT_MS = 5_000;

/** `promise`, or nothing once `ms` have passed. Never rejects. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
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

export interface RunnerPresence {
  /** Publishes capabilities and state, beats once, then every interval. */
  start(): Promise<void>;
  /** Reports a state now (or on reconnect, if the backend cannot be reached). */
  setState(state: RunnerReportedState, reason?: string | null): Promise<void>;
  /** Re-reads the capability report and sends it if it changed. */
  refreshCapabilities(): Promise<void>;
  /** A clean stop: no more beats, and `stopped` so the owner does not see `offline` 90 s later. */
  stop(): Promise<void>;
  readonly connected: boolean;
  readonly revoked: boolean;
}

const DEFAULT_TIMERS: RunnerPresenceTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createRunnerPresence(options: RunnerPresenceOptions): RunnerPresence {
  const timers = options.timers ?? DEFAULT_TIMERS;
  let state: { state: RunnerReportedState; reason: string | null } = {
    state: "online",
    reason: null,
  };
  let interval: unknown = null;
  let connected = false;
  let revoked = false;
  let stopped = false;
  /** The last report the backend accepted, so an unchanged one is not resent. */
  let publishedReport: string | null = null;
  let beating: Promise<void> | null = null;

  function fail(error: unknown) {
    connected = false;
    if (isRevokedError(error)) {
      if (!revoked) {
        revoked = true;
        halt();
        options.onRevoked?.();
      }
      return;
    }
    options.onError?.(error);
  }

  function halt() {
    if (interval !== null) timers.clearInterval(interval);
    interval = null;
  }

  async function publishCapabilities(force: boolean) {
    const report = await options.readCapabilities();
    const key = JSON.stringify(report);
    if (!force && key === publishedReport) return;
    await options.backend.reportCapabilities({ report });
    publishedReport = key;
  }

  async function beatOnce() {
    try {
      if (!connected) {
        // (Re)connect: live state is re-published, never buffered.
        await publishCapabilities(true);
        await options.backend.reportState(state);
      }
      const reply = await options.backend.heartbeat({
        bootId: options.bootId,
        load: await options.readLoad(),
      });
      connected = true;
      options.onReply?.(reply);
    } catch (error) {
      fail(error);
    }
  }

  function beat(): Promise<void> {
    if (revoked || stopped) return Promise.resolve();
    // One beat at a time: a slow backend never stacks them.
    beating ??= beatOnce().finally(() => {
      beating = null;
    });
    return beating;
  }

  return {
    get connected() {
      return connected;
    },
    get revoked() {
      return revoked;
    },
    async start() {
      stopped = false;
      if (interval === null && !revoked) {
        interval = timers.setInterval(
          () => void beat(),
          options.intervalMs ?? RUNNER_HEARTBEAT_INTERVAL_MS,
        );
      }
      await beat();
    },
    async setState(next, reason = null) {
      state = { state: next, reason };
      if (!connected || revoked) return;
      try {
        await options.backend.reportState(state);
      } catch (error) {
        fail(error);
      }
    },
    async refreshCapabilities() {
      if (!connected || revoked) return;
      try {
        await publishCapabilities(false);
      } catch (error) {
        fail(error);
      }
    },
    async stop() {
      stopped = true;
      halt();
      const deadline = options.stopTimeoutMs ?? RUNNER_PRESENCE_STOP_TIMEOUT_MS;
      if (beating !== null) await settledWithin(beating, deadline);
      if (connected && !revoked) {
        await settledWithin(
          options.backend.reportState({ state: "stopped", reason: null }).catch(fail),
          deadline,
        );
      }
      connected = false;
    },
  };
}
