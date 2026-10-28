/** Session verbs in a cloud launch. Local targets use the ordered ledger offline; listing always reads Convex. */
import { randomUUID, createHash } from "node:crypto";
import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionEngine,
  type SessionTranscriptArtifact,
} from "@volli/session-engine";
import {
  shortSessionId,
  SESSION_READ_VERBS,
  type AgentResponse,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
  type RuntimeVerbResult,
} from "@volli/shared";
import {
  INLINE_ARTIFACT_MAX_BYTES,
  isUuid,
  type AutomationRunQueued,
  type AutomationRunRequest,
  type TicketId,
  type CloudAutomationDefinition,
} from "@volli/shared/cloud";
import type { AgentBackend } from "./agent-backend";
import { NotYetSyncedError } from "./agent-backend";
import type { CloudVerbCall } from "./board-verbs";
import { CLOUD_VERB_BUDGET_MS } from "./board-verbs";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";
import { createCloudSessionReads, cloudSessionRefusal } from "./session-reads";
import { failure } from "../agent-dispatch/context";
import { dryRunResponse } from "../agent-dispatch/preview";
import { supervisionMarker } from "../session-runtime/supervise-session";
import { agentToolCommandId } from "../cloud-runner/derived-id";
import { resolveAutomationByName } from "../automations/by-name";
import { createCloudWatchVerb } from "./watch-verbs";

export interface CloudSessionVerbsOptions {
  backend: AgentBackend;
  engine: SessionEngine;
  projectIds(): readonly string[];
  /** A current-owner cursor not fenced by a moved claim. Never a frozen SQLite board row. */
  claimedHere(sessionId: string): boolean;
  notify(
    sessionId: string,
    args: { notifyId: string; title: string; detail: string },
  ): Promise<{ displayName: string }>;
  ticketDisplayIdOf?(ticketId: string): string | null;
  newId?(): string;
  now?(): number;
}

function responseFor(error: unknown): AgentResponse {
  if (error instanceof CloudOfflineError) {
    return failure(
      error.delivery === "not_sent" ? "OFFLINE" : "TIMEOUT",
      error.delivery === "not_sent"
        ? "This runner is offline. Remote Session commands need a connection; local Session updates are kept and sent when it is back."
        : "Volli Cloud did not confirm this command. It may have landed; inspect the Session before retrying.",
    );
  }
  if (error instanceof NotYetSyncedError) return failure("NOT_YET_SYNCED", error.message);
  if (error instanceof CloudFunctionError) return cloudSessionRefusal(error);
  return failure(
    "INVALID_REQUEST",
    error instanceof Error ? error.message : "This Session command could not be read.",
  );
}
const refused = (text: string): RuntimeVerbResult => ({ text: `Volli refused: ${text}` });
const readKeys: ReadonlySet<string> = new Set(SESSION_READ_VERBS);

export function createCloudSessionVerbs(options: CloudSessionVerbsOptions) {
  const { backend, engine } = options;
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? Date.now;
  const reads = createCloudSessionReads({ backend });
  const watch = createCloudWatchVerb({ backend, engine, reads, now });
  async function localTarget(handle: string, projectId?: string): Promise<boolean> {
    const rows =
      projectId === undefined
        ? (
            await Promise.all(
              options
                .projectIds()
                .map((id) => engine.listSessions({ projectId: id, scope: "all" })),
            )
          ).flat()
        : await engine.listSessions({ projectId, scope: "all" });
    const matches = rows.filter(
      (p) =>
        (p.session.id === handle || shortSessionId(p.session.id) === handle) &&
        options.claimedHere(p.session.id),
    );
    if (matches.length > 1)
      throw new Error(`Session id ${handle} is ambiguous; nothing was touched.`);
    return matches.length === 1;
  }
  /**
   * `automation_run` in a cloud launch: the backend queues the Run
   * (`automations.run`, under this Session's Agent token) on the ticket's
   * Place when it is this Session's owner's runner, else the owner's own
   * runner, and arms this Session's watch on the Run's Session when it starts.
   * The tool's name and schema are the local one's; only where it runs moved.
   * The command id is derived from the tool call, so a replayed call answers
   * with the first call's Run.
   */
  async function runAutomation(
    session: RuntimeSessionIdentity,
    request: RuntimeVerbCall,
  ): Promise<RuntimeVerbResult> {
    const named = request.input["automation"];
    const ticketKey = request.input["ticket"];
    if (typeof named !== "string" || !named.trim())
      return refused(
        "automation must be the name of a saved Automation, for example 'Nightly sweep'.",
      );
    if (typeof ticketKey !== "string" || !ticketKey.trim())
      return refused("ticket must be a Ticket display id, for example VC-12.");
    const deadline = now() + CLOUD_VERB_BUDGET_MS;
    let submitted = false;
    try {
      const listed = (await backend.query(
        session.sessionId,
        "automations:list",
        { projectId: session.projectId },
        { deadline },
      )) as readonly Pick<CloudAutomationDefinition, "id" | "name" | "projectId">[];
      const found = resolveAutomationByName(listed, named.trim());
      if (!found.ok) return refused(found.text);
      const automation = found.automation;
      const key = ticketKey.trim();
      const ticket = isUuid(key)
        ? { ticketId: key as TicketId, projectId: session.projectId, key }
        : ((await backend.query(
            session.sessionId,
            "board:resolveTicketKey",
            { key },
            { deadline },
          )) as { ticketId: TicketId; projectId: string; key: string });
      if (ticket.projectId !== session.projectId)
        return refused(`No Ticket ${key} in this project, so nothing was started.`);
      const run: AutomationRunRequest = {
        commandId: agentToolCommandId(session.sessionId, request.toolCallId),
        automationId: automation.id,
        ticketId: ticket.ticketId,
      };
      submitted = true;
      const queued = (await backend.mutation(
        session.sessionId,
        "automations:run",
        { ...run },
        {
          deadline,
        },
      )) as AutomationRunQueued;
      return {
        text: [
          `Queued ${JSON.stringify(automation.name)} on ${ticket.key} as Session ${shortSessionId(queued.sessionId)} on ${queued.runner.name}${queued.runner.status === "online" ? "" : ` (${queued.runner.status}; it starts when that runner is back)`}.`,
          "The Run is recorded with the automation Actor, exactly as one a person starts by hand. It opens a fresh Session that runs on its own.",
          "This Session watches the Run's Session once it starts: a notice from Volli arrives here when its first turn ends, when it signals done or blocked, or if it is stopped. Keep working; do not poll.",
        ].join("\n"),
      };
    } catch (error) {
      if (
        error instanceof CloudFunctionError &&
        /could not find public function/i.test(error.message)
      )
        return refused("Volli Cloud cannot run Automations yet, so nothing was started.");
      const response = responseFor(
        error instanceof CloudOfflineError && !submitted
          ? new CloudOfflineError(error.reason, error.message, "not_sent")
          : error,
      );
      return refused(
        `Volli refused to start the Run: ${response.ok ? "Unknown result." : response.error.message}`,
      );
    }
  }
  return {
    /** Null delegates to today's local handler; no network request occurs on that path. */
    async socket(call: CloudVerbCall): Promise<AgentResponse | null> {
      const { request, sessionId } = call;
      if (!readKeys.has(request.cmd) && request.cmd !== "notify") return null;
      if (sessionId === null)
        return failure(
          "SIGN_IN_REQUIRED",
          "Volli Cloud Session verbs need an authenticated Session. A plain-terminal CLI cannot borrow your sign-in.",
        );
      try {
        if (request.cmd === "notify") {
          const message = request.args["message"];
          const title = request.args["title"] ?? "Volli Code";
          if (
            typeof message !== "string" ||
            !message.trim() ||
            typeof title !== "string" ||
            !title.trim()
          )
            return failure("INVALID_REQUEST", "notify requires a message and optional title.");
          const preview = dryRunResponse(request, {
            kind: "notification",
            id: null,
            label: `Notification for this Session's owner`,
          });
          if (preview !== null) return preview;
          const result = await options.notify(sessionId, {
            notifyId: newId(),
            title: title.trim(),
            detail: message,
          });
          return { v: 1, ok: true, data: { queued: true, queuedFor: result.displayName } };
        }
        const caller = await engine.getBaseSession({ sessionId });
        const handle = request.args["id"];
        if (
          request.cmd !== "session.list" &&
          typeof handle === "string" &&
          (await localTarget(handle, caller?.projectId))
        )
          return null;
        return await reads[
          request.cmd as "session.list" | "session.show" | "session.peek" | "session.answer"
        ](call);
      } catch (error) {
        return responseFor(error);
      }
    },
    async tool(
      session: RuntimeSessionIdentity,
      request: RuntimeVerbCall,
      signal?: AbortSignal,
    ): Promise<RuntimeVerbResult | null> {
      if (
        (request.verb === "session.start" || request.verb === "session.delegate") &&
        request.input["env"] !== undefined
      )
        return refused("Starting on another runner is not available yet. Omit env to start here.");
      if (request.verb === "automation.run") return runAutomation(session, request);
      const watchResult = await watch(session, request, signal);
      if (watchResult !== null) return watchResult;
      if (request.verb !== "session.send" && request.verb !== "session.stop") return null;
      const handle = request.input["session"];
      if (typeof handle !== "string" || !handle.trim())
        return refused("session must be a short Session id.");
      const deadline = now() + CLOUD_VERB_BUDGET_MS;
      let submitted = false;
      try {
        if (await localTarget(handle.trim(), session.projectId)) return null;
        const resolved = await reads.resolveTarget(
          session.sessionId,
          handle.trim(),
          session.projectId,
          { deadline },
        );
        if (!resolved.ok)
          return refused(
            resolved.response.ok
              ? "That Session could not be resolved."
              : resolved.response.error.message,
          );
        const target = resolved.target;
        if (target.id === session.sessionId)
          return refused("That handle is this Session. Signal done or blocked instead.");
        const caller = await engine.getBaseSession({ sessionId: session.sessionId });
        if (caller === null || caller.projectId !== session.projectId)
          return refused("The calling Session is unavailable in this project.");
        if (
          caller.role === "subagent" ||
          (caller.role === "ticket" &&
            (target.role !== "subagent" || target.parentSessionId !== session.sessionId))
        )
          return refused("A Ticket Session may steer or stop only its own subagents.");
        const operationId = `${session.sessionId}:${request.toolCallId}`;
        let intent: Record<string, unknown>;
        let artifact: string | undefined;
        if (request.verb === "session.stop") {
          const reason = request.input["reason"];
          if (reason !== undefined && typeof reason !== "string")
            return refused("reason must be text.");
          intent = {
            kind: "session.stop",
            by: { kind: "session", sessionId: session.sessionId },
            reason: reason ?? null,
          };
        } else {
          const message = request.input["message"];
          if (typeof message !== "string" || !message.trim())
            return refused("message must be non-empty text.");
          const body: SessionTranscriptArtifact = {
            version: 1,
            threadId: operationId,
            branchId: operationId,
            attemptId: operationId,
            turnId: null,
            message: {
              id: `${operationId}:message`,
              role: "user",
              parts: [
                {
                  type: "text",
                  text: `${supervisionMarker(session.sessionId)}\n\n${message.trim()}`,
                },
              ],
            },
          };
          artifact = canonicalJson(body);
          if (Buffer.byteLength(artifact) > INLINE_ARTIFACT_MAX_BYTES)
            return refused("Remote steering messages are limited to 64 KB.");
          const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
          intent = {
            kind: "message.submit",
            reference: { id: digest, digest, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE },
          };
        }
        if (signal?.aborted)
          return refused("This turn stopped waiting before the remote command was sent.");
        submitted = true;
        const result = (await backend.mutation(
          session.sessionId,
          "sessions:command",
          {
            sessionId: target.id,
            commandId: operationId,
            intent: JSON.stringify(intent),
            ...(artifact === undefined ? {} : { artifact }),
          },
          { deadline },
        )) as {
          status: string;
          receipt: { status: string; code?: string | null; detail?: string | null } | null;
          runner: { name: string } | null;
          watch?: { status: string; code?: string } | null;
        };
        const action = request.verb === "session.stop" ? "stop" : "steering";
        if (
          ["failed", "cancelled", "expired"].includes(result.status) ||
          result.receipt?.status === "rejected"
        )
          return refused(
            `The recorded ${action} for Session ${shortSessionId(target.id)} is ${result.receipt?.status === "rejected" ? "rejected" : result.status}${result.receipt?.code ? ` (${result.receipt.code})` : ""}. Inspect the Session before making a new call.`,
          );
        if (result.status === "done")
          return {
            text: `The runner completed the recorded ${action} job for Session ${shortSessionId(target.id)}. Read its history for the execution outcome; no second command was queued.`,
          };
        const watchNote =
          result.watch?.status === "not_armed"
            ? ` A watch could not be armed (${result.watch.code ?? "unavailable"}); inspect the Session manually.`
            : "";
        return {
          text: `${result.status === "leased" ? "The runner has claimed" : "Queued"} ${action} for Session ${shortSessionId(target.id)}${result.runner === null ? "" : ` on ${result.runner.name}`}. This is the inbox receipt, not confirmation that its runner executed it. Read the Session to confirm delivery.${watchNote}`,
        };
      } catch (error) {
        const response = responseFor(
          error instanceof CloudOfflineError && !submitted
            ? new CloudOfflineError(error.reason, error.message, "not_sent")
            : error,
        );
        return refused(response.ok ? "Unknown command result." : response.error.message);
      }
    },
    async resolveStartTicket(
      session: RuntimeSessionIdentity,
      key: string,
    ): Promise<{ project: { id: string }; ticket: { id: string } }> {
      if (
        session.ticketId !== null &&
        options.ticketDisplayIdOf?.(session.ticketId)?.toLowerCase() === key.toLowerCase()
      )
        return { project: { id: session.projectId }, ticket: { id: session.ticketId } };
      const found = (await backend.query(
        session.sessionId,
        "board:resolveTicketKey",
        { key },
        { deadline: now() + CLOUD_VERB_BUDGET_MS },
      )) as { ticketId: string; projectId: string };
      if (found.projectId !== session.projectId)
        throw new Error("That Ticket is not in this Session's project.");
      return { project: { id: found.projectId }, ticket: { id: found.ticketId } };
    },
  };
}
export type CloudSessionVerbs = ReturnType<typeof createCloudSessionVerbs>;
