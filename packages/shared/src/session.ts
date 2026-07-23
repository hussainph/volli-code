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

/**
 * What the initial PTY launch actually started. `unknown` is reserved for
 * records created before this metadata existed: showing a generic Terminal is
 * more honest than guessing that a historical bare shell was Claude Code.
 */
export const SESSION_LAUNCH_KINDS = ["agent", "shell", "unknown"] as const;

export type SessionLaunchKind = (typeof SESSION_LAUNCH_KINDS)[number];

/** Whether `value` is durable launch-kind metadata accepted across IPC/storage boundaries. */
export function isSessionLaunchKind(value: unknown): value is SessionLaunchKind {
  return typeof value === "string" && (SESSION_LAUNCH_KINDS as readonly string[]).includes(value);
}

/**
 * Where the PTY first landed in Volli's app-owned layout. `unknown` is the
 * migration value for historical records whose renderer layout was not stored.
 */
export const SESSION_PLACEMENTS = ["tab", "split", "unknown"] as const;

export type SessionPlacement = (typeof SESSION_PLACEMENTS)[number];

/** Whether `value` is durable session-placement metadata. */
export function isSessionPlacement(value: unknown): value is SessionPlacement {
  return typeof value === "string" && (SESSION_PLACEMENTS as readonly string[]).includes(value);
}

/** A durable session record: trace + resume seed for a terminal session. */
export interface SessionRecord {
  id: string;
  projectId: string;
  /** `null` means a project-scoped scratch session — no ticket, no board involvement. */
  ticketId: string | null;
  harnessId: HarnessId;
  /** The harness's own resume/session UUID; filled in later by hooks/the volli CLI. */
  harnessSessionId: string | null;
  /** Whether this PTY launched an agent, a bare shell, or predates launch metadata. */
  launchKind: SessionLaunchKind;
  /** Whether the PTY first landed as a top-level tab, a split pane, or predates placement metadata. */
  placement: SessionPlacement;
  title: string;
  /** Absolute working directory the session's PTY was booted in. */
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; `null` while the session is live. */
  endedAt: number | null;
  /**
   * The shell's exit code, stamped by the PTY exit path alongside `endedAt`.
   * `null` while live, for boot-sweep ends (the process outcome was never
   * observed), and for rows predating the column — outcome labels never guess.
   */
  exitCode: number | null;
}

/** Stable human-facing identifier used by the CLI instead of exposing the stored UUID. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * PTY-derived activity vocabulary (ticket-detail-mvp decision #5): "working"
 * (output within ~10s) / "idle" (running, quiet) / "parked" (idle and
 * SIGSTOP'd for the warm tier, issue #51 — CONT'd back to "idle"/"working" on
 * wake) / "exited". The renderer derives working/idle from output recency
 * today; hook-driven states (e.g. waiting-for-input) reuse this vocabulary
 * later without changing it.
 */
export const SESSION_ACTIVITY_STATES = ["working", "idle", "parked", "exited"] as const;

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
  launchKind: SessionLaunchKind;
  placement: SessionPlacement;
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
    launchKind: input.launchKind,
    placement: input.placement,
    title: input.title,
    cwd: input.cwd,
    createdAt: input.now,
    endedAt: null,
    exitCode: null,
  };
}
