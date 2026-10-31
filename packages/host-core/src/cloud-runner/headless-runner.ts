/**
 * A linked, outbound-only runner's lifecycle. The process stays up when it
 * is unlinked or revoked; linking again is an explicit CLI operation, never
 * a background registration. One instance owns one rotating token source.
 *
 * Receiving production wiring: the headless composition (VC-1042) supplies
 * the platform/model-login readers, builds cloud-store sync over `connection`,
 * and suspends claims when `snapshot().canClaim` is false. The link also fences
 * claim calls itself: a reconnect must heartbeat successfully before work starts.
 */
import {
  type RunnerCapabilityReport,
  type RunnerHeartbeatReply,
  type RunnerId,
  type RunnerLoad,
  type RunnerReportedState,
} from "@volli/shared/cloud";

import type { CloudRunnerSyncConnection } from "../cloud-store";
import { createBackendLink, type BackendLink } from "./backend-link";
import { convexBackendConnection, type ConvexClientModule } from "./convex-connection";
import { createMutationGate } from "./flow";
import type { RunnerLinkStore } from "./link";
import { createRunnerLinkClient, type RunnerFetch } from "./link-client";
import {
  createRunnerPresence,
  isRevokedError,
  RUNNER_PRESENCE_FUNCTIONS,
  runnerPresenceBackend,
  type RunnerPresence,
} from "./presence";
import { createRunnerTokenSource, type RunnerLinkLoss } from "./token-source";

export type HeadlessRunnerTarget = Pick<
  RunnerHeartbeatReply,
  "targetVersion" | "minVersion" | "autoUpdate"
>;

export interface HeadlessRunnerPlatform {
  readCapabilities(): RunnerCapabilityReport | Promise<RunnerCapabilityReport>;
  readLoad(): RunnerLoad | Promise<RunnerLoad>;
  /** True only while supervised by systemd, not merely installed in system mode. */
  service?: boolean;
  onCapabilitiesChange?(listener: () => void): () => void;
}

export interface HeadlessRunnerSnapshot {
  state: "unlinked" | "connecting" | "online" | "offline" | "revoked" | "stopped";
  runnerId: RunnerId | null;
  name: string | null;
  /** False until a successful heartbeat, while draining/updating, or below the version floor. */
  canClaim: boolean;
}

export interface HeadlessRunnerConnection {
  link: BackendLink;
  presence: RunnerPresence;
  runnerId: RunnerId;
  bootId: string;
  runnerToken(): Promise<string | null>;
}

export interface HeadlessRunnerOptions {
  linkStore: RunnerLinkStore;
  convex: ConvexClientModule & { url: string; siteUrl: string; fetch?: RunnerFetch };
  platform: HeadlessRunnerPlatform;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
  onTarget?(target: HeadlessRunnerTarget): void | Promise<void>;
  onChange?(snapshot: HeadlessRunnerSnapshot): void;
  /** The same sync hook as desktop's runnerConnector, over the one authenticated link. */
  sync?(connection: HeadlessRunnerConnection): CloudRunnerSyncConnection;
  onLost?(reason: RunnerLinkLoss): void;
  bootId?: string;
  random?(): number;
  /** Bounds presence calls on a half-open socket; inbox/accept calls retain the link's retry semantics. */
  callTimeoutMs?: number;
}

export interface HeadlessRunner {
  snapshot(): HeadlessRunnerSnapshot;
  readonly connection: HeadlessRunnerConnection | null;
  /** Loads the sealed link, exchanges a token, publishes capabilities and starts presence. */
  start(): Promise<void>;
  /** Available before start, for composition to read the runner token's owner claim. */
  token(): Promise<string | null>;
  refreshCapabilities(): Promise<void>;
  reportState(state: RunnerReportedState, reason?: string | null): Promise<void>;
  drain(): Promise<void>;
  /** Best-effort stopped report, bounded by callTimeoutMs, then close. Safe more than once. */
  stop(): Promise<void>;
}

export const HEADLESS_RUNNER_RETRY = { baseMs: 1_000, maxMs: 60_000 } as const;

function unauthorized(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const fields = error as { status?: unknown; code?: unknown };
  return fields.status === 401 || isRevokedError(error) || fields.code === "invalid_credential";
}

export function createHeadlessRunner(options: HeadlessRunnerOptions): HeadlessRunner {
  const bootId = options.bootId ?? crypto.randomUUID();
  const random = options.random ?? Math.random;
  const timeoutMs = options.callTimeoutMs ?? 5_000;
  let snapshot: HeadlessRunnerSnapshot = {
    state: "unlinked",
    runnerId: null,
    name: null,
    canClaim: false,
  };
  let connection: HeadlessRunnerConnection | null = null;
  let started = false;
  let starting: Promise<void> | null = null;
  let opening: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let ended = false;
  let closing = Promise.resolve();
  let offStatus: (() => void) | null = null;
  let offCapabilities: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let reportedState: RunnerReportedState = "online";
  let sync: CloudRunnerSyncConnection | null = null;
  let capabilityTail = Promise.resolve();
  let capabilityPublishTail = Promise.resolve();
  let publishedCapabilities: string | null = null;
  let republishOnBeat = false;
  let reportedReason: string | null = null;

  function publish(state: HeadlessRunnerSnapshot["state"], canClaim = false) {
    const next = { ...snapshot, state, canClaim };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    if (!canClaim) sync?.suspend?.();
    else
      void sync?.resume?.().catch(() => options.log.warn("Headless runner claim recovery failed."));
    try {
      options.onChange?.({ ...snapshot });
    } catch {
      options.log.warn("Headless runner state callback failed.");
    }
  }

  function cancelRetry() {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  }

  function revoke(reason: RunnerLinkLoss = "revoked") {
    if (ended) return;
    ended = true;
    cancelRetry();
    offStatus?.();
    offCapabilities?.();
    publish(reason === "unlinked" ? "unlinked" : "revoked");
    const live = connection;
    if (live !== null) {
      // Close first: no stopped report, nor queued claims, may leave a revoked link.
      closing = live.link
        .close()
        .catch(() => {})
        .then(async () => {
          try {
            await sync?.close();
          } finally {
            await live.presence.stop();
          }
        })
        .catch(() => options.log.warn("Headless runner revoked-connection cleanup failed."));
    }
    try {
      options.onLost?.(reason);
    } catch {
      options.log.warn("Headless runner link-loss callback failed.");
    }
    options.log.warn("Headless runner authorization ended; link again to resume.");
  }

  function schedule(run: () => Promise<void>) {
    if (ended || retry !== null) return;
    const ceiling = Math.min(
      HEADLESS_RUNNER_RETRY.maxMs,
      HEADLESS_RUNNER_RETRY.baseMs * 2 ** Math.min(attempt++, 16),
    );
    const delay = Math.max(
      HEADLESS_RUNNER_RETRY.baseMs,
      Math.round(ceiling / 2 + (random() * ceiling) / 2),
    );
    retry = setTimeout(() => {
      retry = null;
      void run().catch(unavailable);
    }, delay);
    retry.unref?.();
  }

  function unavailable(error: unknown) {
    if (ended) return;
    if (unauthorized(error)) return revoke();
    if (!started) return;
    republishOnBeat = true;
    publishedCapabilities = null;
    publish("offline");
    options.log.warn("Headless runner could not reach the backend; reconnecting.");
    // Transport outages belong to BackendLink. This timer covers initial
    // HTTP exchange failures and a socket that reads up but cannot heartbeat.
    if (connection !== null && connection.link.status.state !== "connected") return;
    schedule(async () => {
      if (connection === null) await open();
      else {
        connection.link.reconnectNow();
        await connection.presence.beatNow();
      }
    });
  }

  const tokens = createRunnerTokenSource({
    client: createRunnerLinkClient({
      siteUrl: options.convex.siteUrl,
      fetch: options.convex.fetch,
    }),
    store: options.linkStore,
    onLinkLost: revoke,
  });

  async function token(request: { forceRefreshToken: boolean }) {
    if (ended) return null;
    try {
      return await tokens.token(request);
    } catch (error) {
      unavailable(error);
      throw error;
    }
  }

  async function readCapabilities(): Promise<RunnerCapabilityReport> {
    const report = await options.platform.readCapabilities();
    return {
      ...report,
      capabilities: {
        ...report.capabilities,
        power:
          report.platform.os === "linux"
            ? { source: "ac", alwaysOn: options.platform.service === true }
            : (report.capabilities.power ?? { source: "unknown", alwaysOn: false }),
        tools: report.capabilities.tools.toSorted(),
      },
      localCredentials: report.localCredentials.toSorted(
        (a, b) =>
          a.providerId.localeCompare(b.providerId) ||
          a.kind.localeCompare(b.kind) ||
          (a.expiresAt ?? 0) - (b.expiresAt ?? 0),
      ),
    };
  }

  function open(): Promise<void> {
    opening ??= openOnce().finally(() => {
      opening = null;
    });
    return opening;
  }

  async function openOnce() {
    if (ended) return;
    const identity = await options.linkStore.load();
    if (ended) return;
    if (identity === null) {
      publish("unlinked");
      return;
    }
    snapshot = { ...snapshot, runnerId: identity.runnerId, name: identity.name };
    publish("connecting");
    // Persist the successor before constructing an authenticated WebSocket.
    if ((await token({ forceRefreshToken: false })) === null || ended) return;
    const raw = createBackendLink({
      connect: (fetchToken) => {
        const client = convexBackendConnection(options.convex.url, options.convex)(fetchToken);
        const mutate = client.mutation.bind(client);
        client.mutation = async (name, args) => {
          // Checked at gate admission, not only when the caller queued it.
          if (name === "runnerJobs:claim" && !snapshot.canClaim) return [];
          return mutate(name, args);
        };
        return client;
      },
      token,
      gate: createMutationGate(),
      random,
      reconnect: HEADLESS_RUNNER_RETRY,
    });
    const guardedMutate: BackendLink["mutate"] = async (name, args, callOptions) => {
      if (name === "runnerJobs:claim" && !snapshot.canClaim) return [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const mutation = raw.mutate(name, args, callOptions);
        if (!(Object.values(RUNNER_PRESENCE_FUNCTIONS) as string[]).includes(name))
          return await mutation;
        return await Promise.race([
          mutation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Runner backend call timed out.")),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        if (unauthorized(error)) revoke();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    let linkClosing: Promise<void> | null = null;
    const link: BackendLink = {
      ...raw,
      get status() {
        return raw.status;
      },
      mutate: guardedMutate,
      call: (name, args) => guardedMutate(name, args, { priority: "control" }),
      close: () => (linkClosing ??= raw.close()),
      async query(name, args) {
        try {
          return await raw.query!(name, args);
        } catch (error) {
          if (unauthorized(error)) revoke();
          throw error;
        }
      },
    };
    const backend = runnerPresenceBackend(link.call);
    const publishCapabilities = (args: { report: RunnerCapabilityReport }) => {
      const next = capabilityPublishTail.then(async () => {
        const key = JSON.stringify(args.report);
        if (key === publishedCapabilities) return;
        await backend.reportCapabilities(args);
        publishedCapabilities = key;
      });
      capabilityPublishTail = next.catch(() => {});
      return next;
    };
    let publishedState: string | null = null;
    const publishState: typeof backend.reportState = async (args) => {
      await backend.reportState(args);
      publishedState = JSON.stringify(args);
      republishOnBeat = false;
    };
    const presence = createRunnerPresence({
      backend: {
        reportCapabilities: publishCapabilities,
        reportState: publishState,
        async heartbeat(args) {
          // A short socket outage may not have failed a presence call. Republish
          // anyway; the outer cache also dedupes a concurrent credential refresh.
          if (republishOnBeat) {
            await publishCapabilities({ report: await readCapabilities() });
            await publishState({ state: reportedState, reason: reportedReason });
          }
          const reply = await backend.heartbeat(args);
          const desiredState = { state: reportedState, reason: reportedReason };
          // setState() during the first beat only updates presence's local state.
          // Finish publishing that latest intent before acknowledging online.
          if (!ended && publishedState !== JSON.stringify(desiredState))
            await publishState(desiredState);
          return reply;
        },
      },
      bootId,
      readLoad: options.platform.readLoad,
      readCapabilities,
      stopTimeoutMs: timeoutMs,
      onReply(reply) {
        if (ended) return;
        if (reply.status === "revoked") return revoke();
        attempt = 0;
        cancelRetry();
        publish("online", reply.status === "online" && reportedState === "online");
        try {
          void Promise.resolve(
            options.onTarget?.({
              targetVersion: reply.targetVersion,
              minVersion: reply.minVersion,
              autoUpdate: reply.autoUpdate,
            }),
          ).catch(() => options.log.warn("Headless runner update-target callback failed."));
        } catch {
          options.log.warn("Headless runner update-target callback failed.");
        }
      },
      onRevoked: revoke,
      onError: unavailable,
    });
    // Sync also calls start(); this identity owns exactly one initial beat.
    const startPresence = presence.start.bind(presence);
    let presenceStarting: Promise<void> | null = null;
    presence.start = () => (presenceStarting ??= startPresence());
    const stopPresence = presence.stop.bind(presence);
    let presenceStopping: Promise<void> | null = null;
    presence.stop = () => (presenceStopping ??= stopPresence());
    connection = {
      link,
      presence,
      runnerId: identity.runnerId,
      bootId,
      runnerToken: () => token({ forceRefreshToken: false }),
    };
    sync = options.sync?.(connection) ?? null;
    offStatus = raw.onStatus((status) => {
      if (status.state !== "connected") {
        cancelRetry();
        republishOnBeat = true;
        publishedCapabilities = null;
        publish("offline");
      } else void presence.beatNow();
    });
    offCapabilities =
      options.platform.onCapabilitiesChange?.(() => {
        void refreshCapabilities();
      }) ?? null;
    if (ended) {
      offStatus();
      offCapabilities?.();
      await sync?.close();
      return;
    }
    await presence.setState(reportedState, reportedReason);
    await presence.start();
    if (!ended) {
      sync?.start();
      if (!snapshot.canClaim) sync?.suspend?.();
    }
  }

  async function reportState(state: RunnerReportedState, reason: string | null = null) {
    if (ended) return;
    reportedState = state;
    reportedReason = reason;
    if (state !== "online") publish(snapshot.state);
    await connection?.presence.setState(state, reason);
    if (state === "online" && !ended) await connection?.presence.beatNow();
  }

  function refreshCapabilities() {
    const next = capabilityTail.then(async () => {
      if (!ended) await connection?.presence.refreshCapabilities();
    });
    capabilityTail = next;
    return next;
  }

  return {
    snapshot: () => ({ ...snapshot }),
    get connection() {
      return connection;
    },
    start() {
      started = true;
      starting ??= open().catch(unavailable);
      return starting;
    },
    token: () => token({ forceRefreshToken: false }),
    refreshCapabilities,
    reportState,
    drain: () => reportState("draining"),
    stop() {
      stopping ??= (async () => {
        if (ended) {
          await closing;
          return;
        }
        ended = true;
        cancelRetry();
        offStatus?.();
        offCapabilities?.();
        publish("stopped");
        if (connection !== null) {
          // Sync may not have started yet, or its own shutdown may fail.
          // The lifecycle still owns and must close these two resources.
          try {
            await sync?.stop();
          } finally {
            try {
              await connection.presence.stop();
            } finally {
              await connection.link.close();
            }
          }
        }
      })();
      return stopping;
    },
  };
}
