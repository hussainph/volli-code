import type { ChatSessionRecord } from "./session";
import { shortSessionId } from "./session";

export const SESSION_LIST_STATES = [
  "working",
  "waiting",
  "idle",
  "stopped",
  "interrupted",
  "running",
  "exited",
] as const;
export type SessionListState = (typeof SESSION_LIST_STATES)[number];

export function isSessionListState(value: unknown): value is SessionListState {
  return typeof value === "string" && (SESSION_LIST_STATES as readonly string[]).includes(value);
}

/** Active delegated children, in start order, independent of the caller's roster filters. */
export function pendingSubagentIds(
  sessionId: string,
  records: readonly Pick<
    ChatSessionRecord,
    "sessionId" | "role" | "parentSessionId" | "activity" | "createdAt"
  >[],
): string[] {
  return records
    .filter(
      (record) =>
        record.role === "subagent" &&
        record.parentSessionId === sessionId &&
        (record.activity === "working" || record.activity === "waiting"),
    )
    .toSorted((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId))
    .map((record) => shortSessionId(record.sessionId));
}
