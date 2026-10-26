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

/** Listing fields are backend projections, `listing` among them. */
export type CloudListingRow = Extract<SessionListingRow, { kind: "chat" }>;

export function cloudSessionListing(row: CloudSessionRow): CloudListingRow {
  const origin = readSessionOrigin(row.origin);
  // The backend answers the listing rule (`sessionListingActivity` over its
  // fold); this window restates none of it.
  const { activity, waitingOn, live, bornTicketless } = row.listing;
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
      bornTicketless,
      adapterId: null,
      live,
      activity,
      waitingOn,
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
