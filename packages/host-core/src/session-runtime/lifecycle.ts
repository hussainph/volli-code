/**
 * Session boot/drain ownership (VC-622). Construction is synchronous; the quit
 * hold is installed before recovery can yield. Consumers receive services only
 * from ready(), after stale attachments → delegations → durable shell notices.
 * The attachment assembly supplied to this owner already holds every executor
 * port, including the browser backend. Recovery uses the same host engine.
 */
import { randomUUID } from "node:crypto";
import type { HostedSessionRuntime } from "@volli/session-engine";
import { errorMessage, type SessionProjection } from "@volli/shared";
import type { HostCore, HostCorePorts } from "../index";
import { listProjects } from "../db/projects-repo";
import { listScheduledResumeSessionIds } from "../db/scheduled-resume-repo";
import {
  createScheduledResumeHost,
  createSessionWatchdog,
  createSuspendClock,
} from "../session-control";
import type { AgentObservability } from "../observability/settings";
import { relayShellNotices } from "../shell/shell-notices";
import type { BackgroundShellNotice } from "../shell/background-shell-host";
import { closeStaleAttachments } from "./boot-recovery";
import { createHostNoticeDelivery } from "./durable-host-notice-delivery";
import { catchUpSessionResumptions } from "./session-resumptions";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { Delegations } from "./delegate-session";

const recoveredServices = Symbol("recovered Session services");
/** Only the lifecycle can issue this proof that boot recovery has finished. */
export interface RecoveredSessionServices<Services> {
  readonly [recoveredServices]: true;
  readonly services: Services;
}

export interface SessionRuntimeLifecycle<Services> {
  /** No raw services on this owner: ledger consumers must await recovery. */
  ready(): Promise<RecoveredSessionServices<Services>>;
  close(): Promise<void>;
  observeScheduledResume(projection: SessionProjection): void;
  relayShellNotice(notice: BackgroundShellNotice): void;
}

export function createSessionRuntimeLifecycle<Services>(options: {
  host: HostCore;
  ports: Pick<HostCorePorts, "power" | "attention" | "events" | "log">;
  runtime: HostedSessionRuntime | null;
  rpc: { close(): Promise<void> } | null;
  observability: AgentObservability | null;
  delegation: TicketSessionDelegationStore | null;
  delegationsFor(): Delegations | null;
  /** Captured, never called until recovery finishes. */
  services(): Services;
  /** Synchronous host lifecycle hook; desktop installs its accepted-quit hold. */
  installQuitHold(close: () => Promise<void>): void;
  stopProducers(): void;
}): SessionRuntimeLifecycle<Services> {
  const { host, ports, runtime, rpc, observability, delegation } = options;
  const { database, sessionEngine, hostNoticeOutbox, sessionWakeBus } = host;
  const notices =
    runtime === null || hostNoticeOutbox === null
      ? null
      : createHostNoticeDelivery({
          runtime,
          outbox: hostNoticeOutbox,
          ...(sessionWakeBus === null
            ? {}
            : {
                subscribeEvents: (listener) =>
                  sessionWakeBus.subscribe(({ event }) => listener(event)),
              }),
          report: (message) => ports.log.error(`[volli] ${message}`),
        });
  const relay =
    runtime === null || notices === null
      ? null
      : relayShellNotices({
          runtime,
          delivery: notices,
          report: (message) => ports.log.error(`[volli] ${message}`),
        });
  const suspendClock =
    runtime !== null && sessionEngine !== null ? createSuspendClock(ports.power) : null;
  const watchdog =
    runtime !== null && sessionEngine !== null && suspendClock !== null
      ? createSessionWatchdog({
          listBindings: () => runtime.openNativeBindings(),
          suspendedMsWithin: suspendClock.suspendedMsWithin,
          projection: async (sessionId) => (await runtime.projection({ sessionId })).projection,
          submit: (request) => sessionEngine.submit(request),
          notify: (request) => ports.attention.deliver(request),
        })
      : null;
  watchdog?.start();
  const resume =
    runtime !== null && sessionEngine !== null && database.ok
      ? createScheduledResumeHost({
          candidates: async () => listScheduledResumeSessionIds(database.db),
          projection: async (sessionId) => (await runtime.projection({ sessionId })).projection,
          ticketSessions: ({ projectId, ticketId }) =>
            sessionEngine.listSessions({ projectId, scope: "ticket", ticketId }),
          command: (request) => runtime.command(request),
          notify: (request) => ports.attention.deliver(request),
        })
      : null;
  const wake = () => {
    if (!closing) void resume?.pass();
  };
  let boot: Promise<RecoveredSessionServices<Services>> | undefined;
  let drain: Promise<void> | undefined;
  let closing = false;

  function close(): Promise<void> {
    if (drain !== undefined) return drain;
    closing = true;
    options.stopProducers();
    suspendClock?.close();
    ports.power.removeListener("resume", wake);
    // Preserve VC-618's stop → RPC/runtime → MCP backstop → export flush.
    // Its caller still owns the unchanged aggregate shutdown deadline.
    const shutdown = host.maintenance.shutdownNativeSessions({
      sessionWatchdog: watchdog,
      scheduledResumeHost: resume,
      shellHostNotices: notices,
      sessionRpc: rpc,
      sessionRuntime: runtime,
      agentObservability: observability,
    });
    // A host may close the database only after both drain and an in-flight boot
    // sweep finish. Closing the runtime also unblocks its reconciliation path.
    drain = Promise.all([shutdown, boot?.catch(() => undefined)]).then(() => undefined);
    return drain;
  }
  options.installQuitHold(close);

  async function recover(): Promise<RecoveredSessionServices<Services>> {
    if (database.ok && sessionEngine !== null) {
      try {
        await closeStaleAttachments({
          engine: sessionEngine,
          reconcile: (input) =>
            runtime === null
              ? Promise.reject(
                  new Error("The Session runtime is unavailable during boot recovery."),
                )
              : runtime.reconcile(input),
          projectIds: listProjects(database.db).map((project) => project.id),
          newId: randomUUID,
          now: Date.now,
          onError: (attachmentId, error) =>
            ports.log.error(
              `[volli] failed to recover attachment ${attachmentId}:`,
              errorMessage(error),
            ),
        });
      } catch (error) {
        ports.log.error("[volli] failed to recover stale attachments:", errorMessage(error));
      }
      if (delegation !== null && !closing) {
        try {
          // Construct even with nothing unanswered: this arms resumed-child notices.
          const delegateHost = options.delegationsFor();
          const unanswered = delegation.listUnansweredSubagents();
          if (unanswered.length > 0) {
            const recovered = await delegateHost?.recover(unanswered);
            if (recovered !== undefined) {
              console.log(
                `[volli] recovered ${unanswered.length} delegation(s): ${recovered.answered} answered, ${recovered.reported} reported, ${recovered.skipped} skipped`,
              );
            }
          }
        } catch (error) {
          ports.log.error("[volli] failed to recover delegations:", errorMessage(error));
        }
      }
    }
    if (closing) throw new Error("The Session runtime closed during recovery.");
    try {
      await notices?.recover();
    } catch (error) {
      ports.log.error("[volli] failed to recover host notices:", errorMessage(error));
    }
    if (closing) throw new Error("The Session runtime closed during recovery.");
    if (database.ok && sessionEngine !== null) {
      setImmediate(() => {
        if (closing) return;
        void catchUpSessionResumptions(database.db, sessionEngine, {
          publish: (change) => ports.events.publish("data-changed", change),
          report: (error) =>
            ports.log.error("[volli] failed to catch up Session resumptions:", errorMessage(error)),
        });
      });
    }
    if (resume !== null) {
      // A due retry can take minutes; only recovery, not that turn, gates ready.
      void resume.start();
      ports.power.on("resume", wake);
    }
    return { [recoveredServices]: true, services: options.services() };
  }
  return {
    ready: () => {
      if (closing) return Promise.reject(new Error("The Session runtime is closing."));
      boot ??= recover();
      return boot;
    },
    close,
    observeScheduledResume: (projection) => {
      if (!closing) resume?.observe(projection);
    },
    relayShellNotice: (notice) => {
      if (!closing) void relay?.(notice);
    },
  };
}
