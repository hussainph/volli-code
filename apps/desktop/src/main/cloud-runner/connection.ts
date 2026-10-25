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
    let offStatus: (() => void) | null = null;
    return {
      get status() {
        return link.status;
      },
      get beating() {
        return presence.connected;
      },
      power,
      start() {
        offStatus = link.onStatus(() => input.onChange());
        void presence.start();
      },
      refreshCapabilities: () => void presence.refreshCapabilities(),
      async stop() {
        offStatus?.();
        await presence.stop();
        await link.close().catch(() => {});
      },
      async close() {
        offStatus?.();
        lost = true;
        // Closed first, so the presence loop's last report fails at once rather than going out.
        await link.close().catch(() => {});
        await presence.stop();
      },
    };
  };
}
