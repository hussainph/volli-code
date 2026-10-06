/**
 * hostd's host-protocol listener (VC-663): the Session router served over a
 * WebSocket, behind the `cloud` flag (`VOLLI_EXPERIMENTAL=cloud`) and a
 * `--listen` address. Flag off or no address: nothing listens.
 *
 * - **Loopback only** until VC-575 brings TLS and device keys (Q5): a literal
 *   loopback address (`127.x.y.z`, `::1`), never a name a resolver could
 *   point elsewhere. `--listen` refuses anything else, and so does hostd's
 *   composition of the accepting verifier; the listener itself refuses any
 *   non-loopback address. Each refusal stands on its own.
 * - **Tight limits** (`HOSTD_LISTENER_LIMITS`): until VC-575 brings its
 *   host-wide memory budget, this listener's own bounds are the budget.
 * - **Credentials.** hostd composes the enrolled-device verifier (VC-700,
 *   `enrolled-devices.ts`): a device whose key was enrolled over SSH signs a
 *   short-lived `vdc1` credential. With no device enrolled every handshake
 *   answers `UNAUTHORIZED` / `credential-invalid` (D5). The operator token
 *   (VC-623) is a long-lived bearer and is never accepted here. VC-575
 *   (pairing), VC-577 (the same-machine bootstrap) and a hosted control
 *   plane each plug a verifier into the same port.
 * - **What it serves.** The Session router's commands, its stream and the
 *   socket's Session reads, from the host's one handler map (VC-668) under
 *   the router's policy: the same handlers the agent socket answers through.
 *   `model-access` is not offered yet: VC-572 decides its policy for a
 *   paired device.
 * - **The Workspace** a hello names is a project on this host, at the
 *   highest epoch `workspace_epochs` records for it (0: never served under
 *   the flag). Raising it is promotion's (VC-591), never a connection's.
 */
import { getProjectById, prepared } from "@volli/host-core/db";
import { admittedHandlers, ROUTER_POLICY, type HostHandlerMap } from "@volli/host-core/handlers";
import { type HostCredentialVerifier, type HostV1Feature } from "@volli/host-protocol";
import type { SessionEngine } from "@volli/session-engine";
import { hostLogger, withTrace } from "@volli/host-core/log";
import {
  createSessionRouter,
  logRpcDiagnostics,
  RpcDiagnosticLog,
  SESSION_RESOURCE,
  type WorkspaceResource,
} from "@volli/session-rpc";
import {
  DEFAULT_LISTENER_LIMITS,
  isLoopbackHost,
  startHostProtocolListener,
  type HostProtocolListenerLimits,
  type HostProtocolListener,
  type HostProtocolListenerEvent,
  type ServedWorkspace,
} from "@volli/session-rpc/websocket";
import { parseExperimentEnvironment } from "@volli/shared";
import type Database from "better-sqlite3";

import type { HostdLogger } from "./log";

/** Where `--listen` asks the listener to bind. */
export interface HostProtocolBind {
  readonly host: string;
  readonly port: number;
}

/** The features hostd offers: everything it composes. */
export const HOSTD_FEATURES: readonly HostV1Feature[] = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "session.read",
];

const MIB = 1024 * 1024;

/**
 * hostd's listener bounds while the enrolled-device verifier is its only
 * one (VC-700): a few devices of one person, over SSH tunnels to loopback.
 * Until VC-575's host-wide budget, these are the budget. Worst case, every
 * connection full at once:
 *
 *   8 connections × (8 MiB unsent + 8 streams × 2 × 4 MiB staged replay
 *   + 1 MiB inbound frame) = 8 × 73 MiB = 584 MiB
 *
 * against the defaults' 128 × (32 + 64 × 32 + 8) MiB. An answer or event
 * past 4 MiB is refused whole (`response-too-large`; `session.history`
 * pages), and a resume past 4 MiB re-reads its snapshot instead. The
 * connection cap is **host-wide**: at most 8 active client/Workspace
 * connections per host, across every Mac (a client holds one per
 * Workspace). One Mac with a few projects open fits, with room to
 * reconnect; two Macs with four projects each fill it.
 */
export const HOSTD_LISTENER_LIMITS: HostProtocolListenerLimits = Object.freeze({
  ...DEFAULT_LISTENER_LIMITS,
  maxConnections: 8,
  handshakeBurst: 8,
  handshakesPerSecond: 4,
  maxSubscriptions: 8,
  maxFrameBytes: 4 * MIB,
  maxReplayBytes: 4 * MIB,
  // A full resume, and the next frame behind it.
  maxOutboundBytes: 8 * MIB,
  maxInboundBytes: 1 * MIB,
});

/** Only a literal loopback address: `127.x.y.z` or `::1`, never `localhost`. */
export function isLiteralLoopback(host: string): boolean {
  return host !== "localhost" && isLoopbackHost(host);
}

/** Whether the `cloud` flag is on for this host: the environment's opt-in list. */
export function cloudEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseExperimentEnvironment(env["VOLLI_EXPERIMENTAL"]).ids.includes("cloud");
}

/**
 * `--listen`'s value: `127.0.0.1:7420` or `[::1]:7420`. Not `localhost`: a
 * resolver could point it off the box. Answers why not, for a usage error,
 * or the address.
 */
export function parseListen(value: string): HostProtocolBind | string {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/u.exec(value);
  if (match === null) return `--listen takes <host>:<port>, not ${value}.`;
  const host = match[1] ?? match[2]!;
  const port = Number(match[3]);
  if (port > 65_535) return `--listen's port must be 0–65535, not ${match[3]}.`;
  if (!isLiteralLoopback(host)) {
    return `--listen binds a loopback address (127.0.0.1, [::1]) only until VC-575, not ${host}.`;
  }
  return { host, port };
}

/** The highest epoch this host records for a project, or null when it has no such project. */
export function servedWorkspace(
  db: Database.Database,
  workspaceId: string,
): ServedWorkspace | null {
  if (getProjectById(db, workspaceId) === undefined) return null;
  // An aggregate answers one row, with a null epoch when there is none.
  const { epoch } = prepared<[string], { epoch: number | null }>(
    db,
    "SELECT MAX(epoch) AS epoch FROM workspace_epochs WHERE workspace_id = ?",
  ).get(workspaceId)!;
  return { id: workspaceId, epoch: epoch ?? 0 };
}

/**
 * The Session router's resource port: a Session's Workspace is the project
 * its ledger records it in. Any other kind is no resource of this router's,
 * and answers no Workspace (refused, as an absent one is).
 */
export function sessionWorkspace(
  sessionEngine: Pick<SessionEngine, "getSession">,
): (resource: WorkspaceResource) => Promise<string | null> {
  return async ({ kind, id }) =>
    kind === SESSION_RESOURCE
      ? ((await sessionEngine.getSession({ sessionId: id }))?.session.projectId ?? null)
      : null;
}

/** What the listener needs from the composed host. */
export interface HostdProtocolPorts {
  readonly db: Database.Database;
  readonly hostId: string;
  readonly version: string;
  readonly bind: HostProtocolBind;
  /** Who may connect: the enrolled-device verifier, composed by hostd.ts. */
  readonly verifier: HostCredentialVerifier;
  /**
   * The host's one handler map (VC-668). The listener projects it through
   * the router's policy, as every router door does: no handler is reachable
   * without it, and the catalog's network re-checks run before the map.
   */
  readonly handlers: HostHandlerMap;
  readonly sessionEngine: SessionEngine;
  readonly logger: HostdLogger;
  /** Whether this host keeps a recent log for `host.logs` (VC-699) to read. */
  readonly offerLogs?: boolean;
  /** A test seam only: `HOSTD_LISTENER_LIMITS` otherwise. */
  readonly limits?: HostProtocolListenerLimits;
}

export function startHostdProtocolListener(
  ports: HostdProtocolPorts,
): Promise<HostProtocolListener> {
  const { db, sessionEngine, logger } = ports;
  // A device admitted here acts as the person: never off the box until VC-575.
  if (!isLiteralLoopback(ports.bind.host)) {
    return Promise.reject(
      new Error(
        `The enrolled-device verifier is served on a loopback address only until VC-575; refusing ${ports.bind.host}`,
      ),
    );
  }
  const diagnostics = new RpcDiagnosticLog();
  // Every call's start and outcome, inside the trace its frame carried (VC-699).
  logRpcDiagnostics(diagnostics, hostLogger("rpc"));
  const handlers = admittedHandlers(ports.handlers, ROUTER_POLICY);
  return startHostProtocolListener({
    router: createSessionRouter(),
    bind: ports.bind,
    host: { id: ports.hostId, version: ports.version },
    features: ports.offerLogs === true ? [...HOSTD_FEATURES, "host.logs"] : HOSTD_FEATURES,
    workspace: (workspaceId) => servedWorkspace(db, workspaceId),
    verifier: ports.verifier,
    limits: ports.limits ?? HOSTD_LISTENER_LIMITS,
    context: () => ({
      handlers,
      diagnostics,
      resourceWorkspace: sessionWorkspace(sessionEngine),
    }),
    log: (event) => logListenerEvent(logger, event),
    // Each request is handled inside its trace: the Client's, or one minted
    // here. Every line the host writes while serving it carries it (VC-699).
    requestScope: (request, handle) =>
      withTrace(
        request.trace,
        {
          door: "websocket",
          connection: request.connection,
          ...(request.path === null ? {} : { operation: request.path }),
        },
        handle,
      ),
  });
}

/** One line per listener event; the event never carries a credential or a payload. */
function logListenerEvent(logger: HostdLogger, event: HostProtocolListenerEvent): void {
  const { kind, ...fields } = event;
  const line = `host protocol: ${kind}`;
  if (
    kind === "slow-peer" ||
    kind === "revoked" ||
    kind === "oversized-frame" ||
    kind === "connection-refused"
  ) {
    logger.warn(line, fields);
  } else if (kind === "handshake-refused" || kind === "hello-timeout") logger.info(line, fields);
  else logger.debug(line, fields);
}
