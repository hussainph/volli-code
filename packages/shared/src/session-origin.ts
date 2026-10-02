import type { TicketEventActor } from "./ticket-events";

/** Trusted door that requested work, not the executor that reported it.
 * Stored at event.provenance.source.detail.sessionOrigin, outside command
 * intent: attribution cannot change retry identity. Absence is unknown.
 */
export type SessionOrigin =
  | { kind: "user" }
  | { kind: "session"; sessionId: string }
  | { kind: "automation"; automationRunId: string; automationName: string | null }
  | {
      kind: "volli";
      reason:
        | "watch-notice"
        | "subagent-notice"
        | "relaunch-recovery"
        | "scheduled-resume"
        | "supervision"
        | "browser-notice"
        | "shell-notice"
        | "worktree-notice"
        | "auto-title";
    };

/** Convert a trusted door's Actor; legacy automation lacks Run attribution. */
export function sessionOriginFromActor(
  actor: TicketEventActor | undefined,
): SessionOrigin | undefined {
  if (actor === undefined || actor.kind === "user") return { kind: "user" };
  if (actor.kind === "session") return { kind: "session", sessionId: actor.sessionId };
  return undefined;
}

const HOST_REASONS = [
  "watch-notice",
  "subagent-notice",
  "relaunch-recovery",
  "scheduled-resume",
  "supervision",
  "browser-notice",
  "shell-notice",
  "worktree-notice",
  "auto-title",
] as const;

/** Reads stored JSON without treating an absent/invalid origin as a person. */
export function readSessionOrigin(value: unknown): SessionOrigin | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  switch (row.kind) {
    case "user":
      return { kind: "user" };
    case "session":
      return typeof row.sessionId === "string"
        ? { kind: "session", sessionId: row.sessionId }
        : null;
    case "automation":
      return typeof row.automationRunId === "string" &&
        (typeof row.automationName === "string" || row.automationName === null)
        ? {
            kind: "automation",
            automationRunId: row.automationRunId,
            automationName: row.automationName,
          }
        : null;
    case "volli":
      return (HOST_REASONS as readonly unknown[]).includes(row.reason)
        ? {
            kind: "volli",
            reason: row.reason as Extract<SessionOrigin, { kind: "volli" }>["reason"],
          }
        : null;
    default:
      return null;
  }
}

/** One line for CLI and agent text; ids use the eight-character convention. */
export function formatSessionOrigin(origin: SessionOrigin | null): string {
  if (origin === null) return "an unknown origin";
  switch (origin.kind) {
    case "user":
      return "the user";
    case "session":
      return `Session ${origin.sessionId.slice(0, 8)}`;
    case "automation":
      return `Automation${origin.automationName === null ? "" : ` ${JSON.stringify(origin.automationName)}`} (run ${origin.automationRunId.slice(0, 8)})`;
    case "volli":
      return `Volli (${origin.reason})`;
  }
}
