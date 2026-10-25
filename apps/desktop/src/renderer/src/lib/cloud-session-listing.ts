/** The cloud listing's wire-to-UI projection. No local executor/PTY is inferred. */
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  readSessionOrigin,
  parseSessionModel,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionUsageSummary,
} from "@volli/shared";
import type { FunctionReturnType } from "convex/server";
import type { CloudApi } from "./cloud-client";

export type CloudSessionRow = FunctionReturnType<CloudApi["sessions"]["list"]>["page"][number];

/** Listing fields are backend projections; `needsUser` is its attention badge. */
export type CloudListingRow = Extract<SessionListingRow, { kind: "chat" }>;

export function cloudSessionListing(row: CloudSessionRow): CloudListingRow {
  const origin = readSessionOrigin(row.origin);
  const activity: ChatSessionRecord["activity"] =
    row.stopped !== null
      ? "stopped"
      : row.needsUser
        ? "waiting"
        : row.turnActive
          ? "working"
          : row.lastTurnOutcome === "interrupted"
            ? "interrupted"
            : "idle";
  return {
    kind: "chat",
    record: {
      sessionId: row.id,
      projectId: row.projectId,
      ticketId: row.ticketId,
      title: row.title ?? "Chat",
      role: row.role,
      parentSessionId: row.parentSessionId,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      bornTicketless: row.role === "project",
      adapterId: null,
      // The backend knows the runner's turn, not this window's process bindings.
      live: row.turnActive && row.stopped === null,
      activity,
      waitingOn: activity === "waiting" ? "question" : null,
      outcome: row.lastTurnOutcome as ChatSessionRecord["outcome"],
      model: parseSessionModel(row.model),
    },
    // Pre-summary rows stay honestly unmeasured until the next listing update.
    usage:
      (row.usageTotals as { summary?: SessionUsageSummary }).summary ?? EMPTY_SESSION_USAGE_SUMMARY,
    provenance:
      origin?.kind === "automation"
        ? {
            kind: "automation",
            automationRunId: origin.automationRunId,
            automationName: origin.automationName,
          }
        : origin?.kind === "session"
          ? { kind: "session", parentSessionId: origin.sessionId, parentTitle: null }
          : { kind: "user" },
  };
}
