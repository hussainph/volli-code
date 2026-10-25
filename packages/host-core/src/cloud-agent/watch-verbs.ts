/**
 * The frozen watch/await tool doors onto B2's durable watches, never the process-local bus.
 * Production: createCloudSessionVerbs calls this from the runtime tool handler overlay.
 */
import type { SessionEngine } from "@volli/session-engine";
import {
  DEFAULT_AUTHORITY_POLICY,
  MAX_SESSION_AWAIT_TARGETS,
  MAX_TICKET_AWAIT_TARGETS,
  parseSessionAwaitTargets,
  parseTicketAwaitTargets,
  isSessionAwaitFor,
  isTicketAwaitFor,
  sessionAwaitKindsFor,
  ticketAwaitKindsFor,
  shortSessionId,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
  type RuntimeVerbResult,
} from "@volli/shared";
import type { AgentBackend } from "./agent-backend";
import { CLOUD_VERB_BUDGET_MS } from "./board-verbs";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";
import { cloudSessionRefusal, type CloudSessionReads } from "./session-reads";

type Target = {
  kind: "session" | "ticket";
  id: string;
  label: string;
  kinds: string[];
  detached: boolean;
};
const refused = (text: string): RuntimeVerbResult => ({ text: `Volli refused: ${text}` });

export function createCloudWatchVerb(options: {
  backend: AgentBackend;
  engine: SessionEngine;
  reads: CloudSessionReads;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (
    session: RuntimeSessionIdentity,
    request: RuntimeVerbCall,
    signal?: AbortSignal,
  ): Promise<RuntimeVerbResult | null> => {
    if (
      request.verb !== "watch" &&
      request.verb !== "session.await" &&
      request.verb !== "ticket.await"
    )
      return null;
    const legacy = request.verb !== "watch";
    const action = request.input["action"] ?? "watch";
    if (action !== "watch" && action !== "unwatch")
      return refused("action must be watch or unwatch.");
    for (const key of ["sessions", "tickets"] as const) {
      const raw = request.input[key];
      if (raw !== undefined && raw !== null && typeof raw !== "string")
        return refused(`${key} must be ids separated by spaces or commas.`);
    }
    const handles =
      request.verb === "ticket.await"
        ? []
        : parseSessionAwaitTargets(String(request.input["sessions"] ?? ""));
    const tickets =
      request.verb === "session.await"
        ? []
        : parseTicketAwaitTargets(String(request.input["tickets"] ?? ""));
    if (handles.length + tickets.length === 0)
      return refused("Name at least one Session or Ticket to watch.");
    if (handles.length > MAX_SESSION_AWAIT_TARGETS || tickets.length > MAX_TICKET_AWAIT_TARGETS)
      return refused("Too many watch targets in one call.");
    const forValue = request.input["for"] ?? "any";
    if (request.verb === "session.await" && !isSessionAwaitFor(forValue))
      return refused("for must be turn, verdict, stopped or any.");
    if (request.verb === "ticket.await" && !isTicketAwaitFor(forValue))
      return refused("for must be a supported Ticket watch kind or any.");
    const policy = DEFAULT_AUTHORITY_POLICY.actors.session;
    const sessionKinds =
      request.verb === "session.await" && isSessionAwaitFor(forValue)
        ? sessionAwaitKindsFor(forValue).filter((kind) => policy.awaitableSessions.includes(kind))
        : policy.awaitableSessions;
    const ticketKinds =
      request.verb === "ticket.await" && isTicketAwaitFor(forValue)
        ? ticketAwaitKindsFor(forValue).filter((kind) => policy.awaitable.includes(kind))
        : policy.awaitable;
    const targets: Target[] = [];
    let applied = 0;
    const deadline = now() + CLOUD_VERB_BUDGET_MS;
    try {
      const caller = await options.engine.getBaseSession({ sessionId: session.sessionId });
      if (caller === null || caller.projectId !== session.projectId || caller.role === "subagent")
        return refused("This Session cannot watch work in this project.");
      // Resolve the complete request before arming anything. The backend repeats
      // visibility checks; this runner enforces the tool's durable Role barrier.
      for (const handle of handles) {
        const resolved = await options.reads.resolveTarget(
          session.sessionId,
          handle,
          session.projectId,
          { deadline },
        );
        if (!resolved.ok)
          return refused(
            resolved.response.ok ? "Session target unavailable." : resolved.response.error.message,
          );
        const target = resolved.target;
        if (target.id === caller.id) return refused("A Session cannot watch itself.");
        if (
          caller.role !== "project" &&
          (target.role !== "subagent" || target.parentSessionId !== caller.id)
        )
          return refused("A Ticket Session may watch only its own subagents.");
        if (action === "watch" && (target.status !== "open" || target.stopped !== null))
          return refused("Stopped or archived Sessions have nothing left to watch.");
        targets.push({
          kind: "session",
          id: target.id,
          label: shortSessionId(target.id),
          kinds: [...sessionKinds],
          detached: !target.live,
        });
      }
      for (const key of tickets) {
        const target = (await options.backend.query(
          session.sessionId,
          "board:resolveTicketKey",
          { key },
          { deadline },
        )) as { ticketId: string; projectId: string; key: string };
        if (target.projectId !== caller.projectId)
          return refused("Watch targets must belong to this Session's project.");
        targets.push({
          kind: "ticket",
          id: target.ticketId,
          label: target.key,
          kinds: [...ticketKinds],
          detached: false,
        });
      }
      signal?.throwIfAborted();
      if (action === "unwatch") {
        const result = (await options.backend.mutation(
          session.sessionId,
          "watches:unwatch",
          {
            watcherSessionId: session.sessionId,
            targets: targets.map(({ kind, id }) => ({ kind, id })),
          },
          { deadline },
        )) as { ended: number };
        return {
          text: `Stopped watching ${result.ended} targets in Volli Cloud.`,
          details: {
            action,
            sessions: targets.filter((t) => t.kind === "session").map((t) => t.label),
            tickets: targets.filter((t) => t.kind === "ticket").map((t) => t.label),
            ended: result.ended,
            stopped: [],
            detached: [],
          },
        };
      }
      for (const target of targets) {
        // DURABLE operation id: a replay of this tool call cannot re-arm a
        // delivered or unwatched target through B2's seven-day arm receipt.
        const commandId = `${session.sessionId}:${request.toolCallId}:watch:${target.kind}:${target.id}`;
        await options.backend.mutation(
          session.sessionId,
          "watches:watch",
          {
            watcherSessionId: session.sessionId,
            target: { kind: target.kind, id: target.id },
            commandId,
            kinds: target.kinds,
          },
          { deadline },
        );
        applied += 1;
      }
      return {
        text: `${legacy ? "This retired await now returns immediately and arms notices instead; timeoutSeconds and cursor are ignored. " : ""}Watching ${targets.map((t) => t.label).join(", ")} in Volli Cloud. A notice will arrive when a watched fact is accepted; it waits for this runner while offline. ${targets.some((target) => target.detached) ? "Some targets have no reported live executor; nothing can report until new facts arrive. " : ""}This call did not wait.`,
        details: {
          action,
          sessions: targets.filter((t) => t.kind === "session").map((t) => t.label),
          tickets: targets.filter((t) => t.kind === "ticket").map((t) => t.label),
          ended: 0,
          stopped: [],
          detached: targets.filter((target) => target.detached).map((target) => target.label),
        },
      };
    } catch (error) {
      const prefix = applied > 0 ? `${applied} targets were armed before this failure. ` : "";
      if (error instanceof CloudOfflineError)
        return refused(
          `${prefix}Watches need a connection to Volli Cloud.${error.delivery === "unknown" ? " The last arm may have landed; a new watch call deliberately re-arms its target." : ""}`,
        );
      if (error instanceof CloudFunctionError) {
        const response = cloudSessionRefusal(error);
        return refused(
          `${prefix}${response.ok ? "Watch command refused." : response.error.message}`,
        );
      }
      return refused(
        `${prefix}${error instanceof Error ? error.message : "The watch command could not be completed."}`,
      );
    }
  };
}
