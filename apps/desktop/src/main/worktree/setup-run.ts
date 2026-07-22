/**
 * The sentinel-gated setup-command state machine (worktree-support §6). The
 * setup command runs in the session's live terminal AFTER the PTY spawns — never
 * as the pane's primary process (cmux #5032) — so `ensure` (ensure.ts) ends at
 * `ready` with the identity and deliberately does NOT run setup. Historically
 * pty.ts owned the whole machine inline: arming the watch, writing the sentinel
 * line, scanning output tails, driving `setting-up → ready | failed`, and
 * emitting the `worktree_failed(setup)` event itself. That is worktree-module
 * concern leaking into the god-file; this seam pulls it back behind a narrow
 * handle so pty.ts only feeds output chunks and notifies session exit.
 *
 * The pure sentinel helpers (buildSetupSentinelLine / parseSetupSentinel) still
 * live in setup.ts; this file is their stateful driver — it holds the growing
 * output tail, owns the phase transitions, and records the failure event with
 * the documented BEST-EFFORT semantics (the ticket can be deleted mid-setup, so
 * a throwing insert is caught, logged, and never escapes the pty hot path).
 */
import type Database from "better-sqlite3";
import { errorMessage, trimWorktreeFailureStderr, type WorktreePhase } from "@volli/shared";

import { recordTicketEvent } from "../db/events-repo";
import { setPhase } from "./phase";
import { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

/**
 * The cap on the retained setup-output tail. Installs are slow and chatty; only
 * the trailing window can contain the sentinel (which prints last), and it is
 * also the best failure context to record — so we keep the tail bounded rather
 * than the whole transcript.
 */
const SETUP_TAIL_MAX_CHARS = 16_000;

/** The deps a setup run needs: the db (for the failure event) and the phase broadcast. */
export interface SetupRunDeps {
  db: Database.Database;
  /** The phase-broadcast seam (wired to IPC by worktreeDeps); undefined in some tests. */
  onPhase?: (ticketId: string, phase: WorktreePhase) => void;
  /** Clock for the failure event; defaults to `Date.now`. */
  now?: () => number;
}

/** The immutable inputs of one setup run. */
export interface SetupRunParams {
  ticketId: string;
  /** The project's setup command (already trimmed and known non-empty by the caller). */
  setupCommand: string;
  /** The resolved shell the PTY spawned with — the sentinel wrapper is shell-aware (fish ≠ POSIX). */
  shellPath: string;
  /** The harness/resume line to type once setup succeeds, or `null` (bare shell). */
  launchCommand: string | null;
}

/**
 * The directive a fed chunk yields. `pending`: no sentinel yet, keep feeding.
 * `ready`: setup exited 0 (phase already advanced to `ready` inside) — pty
 * writes `launchCommand` if non-null. `failed`: setup exited non-zero (phase
 * `failed` + event already recorded inside) — pty writes nothing.
 */
export type SetupFeedResult =
  | { status: "pending" }
  | { status: "ready"; launchCommand: string | null }
  | { status: "failed" };

/**
 * The narrow handle pty.ts drives. Created armed (phase already `setting-up`);
 * the caller writes {@link commandLine} to the terminal, then feeds every output
 * chunk and notifies exit. Terminal states are latched — once `ready`/`failed`,
 * further feeds/exits are no-ops.
 */
export interface SetupRun {
  /** The sentinel-wrapped setup line to type (no trailing CR — the caller adds it). */
  readonly commandLine: string;
  /** Accumulates `chunk` into the tail and reports whether the sentinel resolved the run. */
  feed(chunk: string): SetupFeedResult;
  /**
   * Notify the session's shell exited while the run was still pending: the
   * sentinel never printed, so record a setup failure rather than leaving the
   * ticket stuck `setting-up` forever. A no-op once the run already settled.
   */
  handleExit(exitCode: number): void;
}

/**
 * Arms a setup run: transitions the ticket to `setting-up` and returns the
 * handle. The caller writes {@link SetupRun.commandLine} to the PTY, then drives
 * the handle through {@link SetupRun.feed} / {@link SetupRun.handleExit}.
 */
export function createSetupRun(deps: SetupRunDeps, params: SetupRunParams): SetupRun {
  const now = deps.now ?? Date.now;
  let tail = "";
  let settled = false;

  setPhase(params.ticketId, "setting-up", deps.onPhase);

  /**
   * Drives the phase to `failed` and best-effort records a `worktree_failed`
   * (setup) event with `stderr` as failure context. Best-effort because the
   * ticket can be deleted while its setup command runs, and a throwing insert
   * must never escape into the pty hot path.
   */
  function recordFailure(stderr: string): void {
    setPhase(params.ticketId, "failed", deps.onPhase);
    try {
      recordTicketEvent(
        deps.db,
        params.ticketId,
        { kind: "worktree_failed", stage: "setup", stderr: trimWorktreeFailureStderr(stderr) },
        now(),
      );
    } catch (error) {
      console.error(`[volli] failed to record setup failure: ${errorMessage(error)}`);
    }
  }

  return {
    commandLine: buildSetupSentinelLine(params.setupCommand, params.shellPath),
    feed(chunk: string): SetupFeedResult {
      if (settled) return { status: "pending" };
      tail = (tail + chunk).slice(-SETUP_TAIL_MAX_CHARS);
      const exitCode = parseSetupSentinel(tail);
      if (exitCode === null) return { status: "pending" };
      settled = true;
      if (exitCode === 0) {
        setPhase(params.ticketId, "ready", deps.onPhase);
        return { status: "ready", launchCommand: params.launchCommand };
      }
      recordFailure(tail);
      return { status: "failed" };
    },
    handleExit(exitCode: number): void {
      if (settled) return;
      settled = true;
      recordFailure(`${tail}\n[shell exited (${exitCode}) before the setup sentinel]`);
    },
  };
}
