/**
 * hostd's host-protocol listener (VC-663): the Session router served over a
 * WebSocket, behind the `cloud` flag (`VOLLI_EXPERIMENTAL=cloud`) and a
 * `--listen` address. Flag off or no address: nothing listens.
 *
 * - **Loopback only** until VC-575 brings TLS and device keys (Q5); `--listen`
 *   refuses anything else, and so does the listener.
 * - **No production credential exists yet** (D5): with no verifier composed
 *   it serves `REFUSING_CREDENTIAL_VERIFIER`, so every handshake answers
 *   `UNAUTHORIZED` / `credential-invalid`. The operator token (VC-623) is a
 *   long-lived bearer and is never accepted here. VC-575 (pairing), VC-577
 *   (the same-machine bootstrap) and a hosted control plane each plug a
 *   verifier into the one port.
 * - **What it serves.** The Session router's commands, its stream and the
 *   socket's Session reads, from the headless runtime: the same runtime,
 *   Sessions facade and verb handlers the agent socket already answers
 *   through. Model Access is not composed here, so `model-access` is not
 *   offered.
 * - **The Workspace** a hello names is a project on this host, at the
 *   highest epoch `workspace_epochs` records for it (0: never served under
 *   the flag). Raising it is promotion's (VC-591), never a connection's.
 */
import { getProjectById, prepared } from "@volli/host-core/db";
import type { AgentCommandService } from "@volli/host-core/agents";
import {
  REFUSING_CREDENTIAL_VERIFIER,
  type HostCredentialVerifier,
  type HostV1Feature,
} from "@volli/host-protocol";
import type { SessionEngine, SessionRuntime, SessionStartResult } from "@volli/session-engine";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  SESSION_RESOURCE,
  type SessionAttachInput,
  type SessionCreateInput,
  type SessionCreateResult,
  type WorkspaceResource,
} from "@volli/session-rpc";
import {
  isLoopbackHost,
  startHostProtocolListener,
  type HostProtocolListener,
  type HostProtocolListenerEvent,
  type ServedWorkspace,
} from "@volli/session-rpc/websocket";
import { parseExperimentEnvironment, roleImpliedByTicket } from "@volli/shared";
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
  "sessions.subscribe",
  "session.read",
];

/** Whether the `cloud` flag is on for this host: the environment's opt-in list. */
export function cloudEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseExperimentEnvironment(env["VOLLI_EXPERIMENTAL"]).ids.includes("cloud");
}

/**
 * `--listen`'s value: `127.0.0.1:7420`, `localhost:7420` or `[::1]:7420`.
 * Answers why not, for a usage error, or the address.
 */
export function parseListen(value: string): HostProtocolBind | string {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/u.exec(value);
  if (match === null) return `--listen takes <host>:<port>, not ${value}.`;
  const host = match[1] ?? match[2]!;
  const port = Number(match[3]);
  if (port > 65_535) return `--listen's port must be 0–65535, not ${match[3]}.`;
  if (!isLoopbackHost(host)) {
    return `--listen binds loopback only until pairing lands (VC-575), not ${host}.`;
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
  readonly verifier?: HostCredentialVerifier;
  readonly runtime: SessionRuntime;
  readonly sessionEngine: SessionEngine;
  readonly sessions: {
    create(
      input: SessionCreateInput & { role: "ticket" | "project" },
    ): Promise<SessionCreateResult>;
    attach(input: SessionAttachInput): Promise<SessionStartResult>;
  } | null;
  readonly commands: Pick<AgentCommandService, "executeInWorkspace">;
  readonly logger: HostdLogger;
}

export function startHostdProtocolListener(
  ports: HostdProtocolPorts,
): Promise<HostProtocolListener> {
  const { db, sessions, sessionEngine, logger } = ports;
  const diagnostics = new RpcDiagnosticLog();
  return startHostProtocolListener({
    router: createSessionRouter(),
    bind: ports.bind,
    host: { id: ports.hostId, version: ports.version },
    features: HOSTD_FEATURES,
    workspace: (workspaceId) => servedWorkspace(db, workspaceId),
    verifier: ports.verifier ?? REFUSING_CREDENTIAL_VERIFIER,
    context: () => ({
      runtime: ports.runtime,
      diagnostics,
      resourceWorkspace: sessionWorkspace(sessionEngine),
      readSessionVerb: (verb, workspaceId, args) =>
        ports.commands.executeInWorkspace(verb, workspaceId, args),
      ...(sessions === null
        ? {}
        : {
            // A person's create names a Ticket or none; the Role is what that
            // implies (VC-9), exactly as the desktop's door says it.
            createSession: (input: SessionCreateInput) =>
              sessions.create({ ...input, role: roleImpliedByTicket(input.ticketId) }),
            attachSession: sessions.attach.bind(sessions),
          }),
    }),
    log: (event) => logListenerEvent(logger, event),
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
