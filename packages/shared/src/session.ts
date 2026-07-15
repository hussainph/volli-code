/**
 * A durable session record (`sessions` table, migration 003): the trace and
 * resume seed for a terminal session, distinct from its live in-memory PTY
 * state (`TerminalEngine`/renderer `stores/sessions.ts`). `ticketId: null`
 * means a project-scoped scratch session (CONTEXT.md's "Scratch session") —
 * main checkout, no worktree, no board involvement, still recorded here.
 * `harnessSessionId` is reserved for the harness's own resume UUID
 * (claude/codex `--resume` seed) — filled in later by hooks/the volli CLI,
 * starts `null`.
 */

import type { HarnessId } from "./ticket";

/** A durable session record: trace + resume seed for a terminal session. */
export interface SessionRecord {
  id: string;
  projectId: string;
  /** `null` means a project-scoped scratch session — no ticket, no board involvement. */
  ticketId: string | null;
  harnessId: HarnessId;
  /** The harness's own resume/session UUID; filled in later by hooks/the volli CLI. */
  harnessSessionId: string | null;
  title: string;
  /** Absolute working directory the session's PTY was booted in. */
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; `null` while the session is live. */
  endedAt: number | null;
}

/**
 * PTY-derived activity vocabulary (ticket-detail-mvp decision #5): "working"
 * (output within ~10s) / "idle" (running, quiet) / "exited". The renderer
 * derives working/idle from output recency today; hook-driven states (e.g.
 * waiting-for-input) reuse this vocabulary later without changing it.
 */
export const SESSION_ACTIVITY_STATES = ["working", "idle", "exited"] as const;

export type SessionActivityState = (typeof SESSION_ACTIVITY_STATES)[number];

/** Whether `value` is one of the {@link SESSION_ACTIVITY_STATES} — IPC-boundary vocabulary guard. */
export function isSessionActivityState(value: unknown): value is SessionActivityState {
  return (
    typeof value === "string" && (SESSION_ACTIVITY_STATES as readonly string[]).includes(value)
  );
}

export interface CreateSessionInput {
  /** Opaque UUID supplied by the caller — kept out of this function so it stays pure/deterministic. */
  id: string;
  projectId: string;
  /** Defaults to `null` (project-scoped scratch session). */
  ticketId?: string | null;
  harnessId: HarnessId;
  title: string;
  /** Absolute working directory the session's PTY was booted in. */
  cwd: string;
  /** Epoch milliseconds, stamped onto `createdAt`. */
  now: number;
}

/** Creates a {@link SessionRecord}. Pure and deterministic — the caller supplies `id` and `now`. */
export function createSessionRecord(input: CreateSessionInput): SessionRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    ticketId: input.ticketId ?? null,
    harnessId: input.harnessId,
    harnessSessionId: null,
    title: input.title,
    cwd: input.cwd,
    createdAt: input.now,
    endedAt: null,
  };
}
