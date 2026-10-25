/**
 * One linked runner's live connection on this Mac, composed from N1/S2's
 * runner parts in `@volli/host-core/cloud-runner`: the token source over the
 * sealed link, the backend link (its Convex adapter handed in by the
 * composition root, so nothing here imports the Convex client), the shared
 * mutation gate, the presence loop and the sleep/wake cycle.
 *
 * ONE token source per link per machine: two processes exchanging the same
 * credential look exactly like a stolen copy and the backend cuts the runner
 * off. The app's single-instance lock is what keeps it one; dev, packaged and
 * `volli-drive` builds have separate profiles, so each is its own runner.
 */
import {
  createBackendLink,
  createMutationGate,
  createRunnerLinkClient,
  createRunnerPowerCycle,
  createRunnerPresence,
  createRunnerTokenSource,
  runnerPresenceBackend,
  type ConnectBackend,
  type BackendLink,
  type RunnerPresence,
  type CloudRunnerSyncConnection,
  type LinkStatus,
  type RunnerLinkLoss,
  type RunnerLinkStore,
  type RunnerPowerCycle,
} from "@volli/host-core/cloud-runner";
import type { RunnerCapabilityReport, RunnerLoad } from "@volli/shared/cloud";

/** What the Mac runner drives of one link's connection. */
export interface RunnerConnection {
  readonly status: LinkStatus;
  /** Whether the last beat reached the backend. */
  readonly beating: boolean;
  readonly waitingFacts?: number;
  /** Connects, publishes capabilities and state, and starts beating. */
  start(): void;
  readonly power: RunnerPowerCycle;
  /** Re-reads the capability report and sends it if it changed. */
  refreshCapabilities(): void;
  /** A clean stop: `stopped` reported (bounded), then the connection closed. */
  stop(): Promise<void>;
  /** Closes without reporting anything: the link is gone. */
  close(): Promise<void>;
}

export interface ConnectRunnerInput {
  readonly store: RunnerLinkStore;
  readonly runnerId?: string;
  /** The link ended: removed, cut off, or its credential is gone. Called at most once. */
  onLost(reason: RunnerLinkLoss): void;
  /** The link's status or the beat's outcome changed. */
  onChange(): void;
}

export type ConnectRunner = (input: ConnectRunnerInput) => RunnerConnection;

export interface RunnerConnectionDeps {
  /** The deployment's HTTP actions origin (`/runner/token`). */
  readonly siteUrl: string;
  /** The Convex client connection for the deployment (`convexBackendConnection(url, convex)`). */
  readonly connect: ConnectBackend;
  /** New on every process start. */
  readonly bootId: string;
  /** Shares this connection's link and presence with the selected cloud product store. */
  sync?(parts: {
    link: BackendLink;
    presence: RunnerPresence;
    bootId: string;
    runnerId: string;
    runnerToken(): Promise<string | null>;
  }): CloudRunnerSyncConnection;
  readLoad(): RunnerLoad | Promise<RunnerLoad>;
  readCapabilities(): RunnerCapabilityReport | Promise<RunnerCapabilityReport>;
  readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
}

export function runnerConnector(deps: RunnerConnectionDeps): ConnectRunner {
  const client = createRunnerLinkClient({ siteUrl: deps.siteUrl });
  return (input) => {
    let lost = false;
    const lose = (reason: RunnerLinkLoss) => {
      if (lost) return;
      lost = true;
      input.onLost(reason);
    };
    const tokens = createRunnerTokenSource({ client, store: input.store, onLinkLost: lose });
    const link = createBackendLink({
      connect: deps.connect,
      token: (options) => tokens.token(options),
      gate: createMutationGate(),
    });
    const presence = createRunnerPresence({
      backend: runnerPresenceBackend(link.call),
      bootId: deps.bootId,
      readLoad: deps.readLoad,
      readCapabilities: deps.readCapabilities,
      onReply: () => input.onChange(),
      onRevoked: () => lose("revoked"),
      onError: (error) => {
        input.onChange();
        deps.log.warn("runner heartbeat failed", { error });
      },
    });
    const power = createRunnerPowerCycle({
      link,
      token: (options) => tokens.token(options),
      presence,
      onError: (error) => deps.log.warn("runner wake step failed", { error }),
    });
    const sync =
      deps.sync === undefined
        ? null
        : deps.sync({
            link,
            presence,
            bootId: deps.bootId,
            runnerToken: () => tokens.token({ forceRefreshToken: false }),
            runnerId:
              input.runnerId ??
              (() => {
                throw new Error("A cloud runner needs its registered identity.");
              })(),
          });
    let offStatus: (() => void) | null = null;
    return {
      get status() {
        return link.status;
      },
      get beating() {
        return presence.connected;
      },
      get waitingFacts() {
        return sync?.waiting() ?? 0;
      },
      power: {
        async suspend() {
          sync?.suspend?.();
          await power.suspend();
        },
        async resume() {
          await power.resume();
          await sync?.resume?.();
        },
      },
      start() {
        offStatus = link.onStatus(() => input.onChange());
        if (sync === null) void presence.start();
        else sync.start();
      },
      refreshCapabilities: () => void presence.refreshCapabilities(),
      async stop() {
        offStatus?.();
        if (sync !== null) return sync.stop();
        await presence.stop();
        await link.close().catch(() => {});
      },
      async close() {
        offStatus?.();
        lost = true;
        if (sync !== null) return sync.close();
        // Closed first, so the presence loop's last report fails at once rather than going out.
        await link.close().catch(() => {});
        await presence.stop();
      },
    };
  };
}
