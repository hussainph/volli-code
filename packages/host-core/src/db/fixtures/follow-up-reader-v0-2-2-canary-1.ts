/** Frozen real queue codec from v0.2.2-canary.1. Do not modernize this fixture. */
import type { SessionFollowUpState } from "@volli/session-engine";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readPreviousFollowUpState(encoded: string): SessionFollowUpState {
  const value: unknown = JSON.parse(encoded);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid follow-up ledger state");
  const state = value as SessionFollowUpState;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.entries) ||
    !record(state.commands) ||
    !record(state.releases) ||
    (state.releasedBoundary !== null && typeof state.releasedBoundary !== "string") ||
    state.entries.some(
      (entry) =>
        !record(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.commandId !== "string" ||
        typeof entry.deliveryCommandId !== "string" ||
        (entry.state !== "queued" && entry.state !== "releasing") ||
        !record(entry.message) ||
        entry.message.id !== entry.id ||
        entry.message.role !== "user" ||
        !Array.isArray(entry.message.parts),
    )
  ) {
    throw new Error("Invalid or unsupported follow-up ledger state");
  }
  // Recovery settles entries by these identities; duplicates could discard another payload.
  for (const field of ["id", "commandId", "deliveryCommandId"] as const) {
    if (new Set(state.entries.map((entry) => entry[field])).size !== state.entries.length) {
      throw new Error(`Duplicate follow-up ledger ${field}`);
    }
  }
  // Release is serialized per Session: recovery resumes the one in-flight claim.
  // Two claims mean a bug wrote this row, so fail loudly instead of guessing.
  if (state.entries.filter((entry) => entry.state === "releasing").length > 1) {
    throw new Error("More than one releasing follow-up ledger entry");
  }
  return state;
}
