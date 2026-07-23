// The terminal IPC surface (extracted from the former monolithic pty.ts per
// issue #99): the native destructive-close confirm gate, the renderer request
// guards, and `registerTerminalIpcHandlers` — the wiring that turns a
// PtyManager into the live `volli:terminal-*` channels plus the before-quit
// kill gate. Every guard and comment here moved verbatim from the manager.

import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { isHarnessId } from "@volli/shared";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  HarnessId,
  TerminalBusyResult,
  TerminalIoResult,
  VolliIpcChannel,
} from "@volli/shared";
import { attachmentsRoot } from "../attachment-store";
import type { DbHandle } from "../data-ipc";
import type { AgentRuntimeEnvironment } from "./manager";
import { PtyManager } from "./manager";

/**
 * Native modal confirm for a destructive close over `busy` sessions; resolves
 * true when the user chose to proceed. Native (not the renderer AlertDialog)
 * because its callers — before-quit and the window `close` event — run while
 * the renderer may already be tearing down, and both need a synchronous
 * verdict to preventDefault against.
 *
 * `VOLLI_SKIP_CLOSE_CONFIRM=1` answers "proceed" without showing the dialog —
 * the automation seam for the e2e smokes, whose sessions deliberately run
 * foreground work and which have no way to answer a native modal (a mid-run
 * failure would otherwise hang teardown forever).
 */
export function confirmDestructiveClose(
  busy: Array<{ process: string }>,
  options: { message: string; confirmLabel: string; window?: BrowserWindow },
): boolean {
  if (process.env["VOLLI_SKIP_CLOSE_CONFIRM"] === "1") return true;
  const processes = Array.from(new Set(busy.map((entry) => entry.process))).join(", ");
  const dialogOptions = {
    type: "warning" as const,
    buttons: [options.confirmLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: options.message,
    detail:
      busy.length === 1
        ? `A terminal is still running “${processes}”. Closing will end it.`
        : `${busy.length} terminals are still running (${processes}). Closing will end them.`,
  };
  const choice =
    options.window === undefined
      ? dialog.showMessageBoxSync(dialogOptions)
      : dialog.showMessageBoxSync(options.window, dialogOptions);
  return choice === 0;
}

// ---- IPC wiring ------------------------------------------------------------

/**
 * `undefined` (no auto-launch) or a well-formed `{ harnessId, prompt }` — a
 * kickoff present with the wrong types is REJECTED (so the request fails
 * loudly), never silently dropped.
 */
function isOptionalKickoff(
  value: unknown,
): value is { harnessId: HarnessId; prompt: string } | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isHarnessId(candidate["harnessId"]) && typeof candidate["prompt"] === "string";
}

/**
 * `undefined` (no resume) or a `{ sessionId: string }` object. A malformed
 * resume shape rejects the whole ticket. The kickoff/resume mutual exclusion is
 * a semantic rule enforced in {@link PtyManager.resolveScope} (with a clear
 * message), not a shape rule — both fields being well-formed is valid here.
 */
function isOptionalResume(value: unknown): value is { sessionId: string } | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["sessionId"] === "string";
}

/**
 * `undefined` (scratch session) or a `{ ticketId: string; kickoff?; resume? }`
 * object (ticket session). A malformed kickoff or resume shape rejects the whole
 * ticket.
 */
function isOptionalTicket(value: unknown): value is CreateTerminalSessionRequest["ticket"] {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    isOptionalKickoff(candidate["kickoff"]) &&
    isOptionalResume(candidate["resume"])
  );
}

function isCreateRequest(value: unknown): value is CreateTerminalSessionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["workspaceId"] === "string" &&
    typeof candidate["cwd"] === "string" &&
    typeof candidate["cols"] === "number" &&
    typeof candidate["rows"] === "number" &&
    isOptionalTicket(candidate["ticket"])
  );
}

/**
 * Registers the terminal IPC handlers and returns the backing manager so the
 * app lifecycle can kill every PTY on quit. Every handler validates its args
 * at runtime — renderer-supplied types are never trusted — and returns a
 * typed result rather than throwing across the IPC boundary.
 */
export function registerTerminalIpcHandlers(
  handle: DbHandle,
  agentRuntime: AgentRuntimeEnvironment | null = null,
): PtyManager {
  // Same resolution as worktree-runtime.ts's `worktreeDeps`: one production
  // seam, `app.getPath("userData")`-derived.
  const attachmentsRootPath = attachmentsRoot(app.getPath("userData"));
  // Every session persists a durable record, so the manager needs the db. When
  // it failed to open, `create` reports the open error (write/kill/etc. operate
  // on the — necessarily empty — live map and stay harmless no-ops).
  const manager = handle.ok
    ? new PtyManager(handle.db, "", undefined, undefined, agentRuntime, attachmentsRootPath)
    : new PtyManager(null, handle.error, undefined, undefined, agentRuntime, attachmentsRootPath);

  ipcMain.handle(
    "volli:terminal-create" satisfies VolliIpcChannel,
    (event, request: unknown): Promise<CreateTerminalSessionResult> => {
      if (!isCreateRequest(request)) {
        return Promise.resolve({ ok: false, error: "Invalid terminal request" });
      }
      return manager.create(event.sender, request);
    },
  );

  ipcMain.handle(
    "volli:terminal-write" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, data: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof data !== "string") {
        return { ok: false, error: "Invalid terminal write" };
      }
      return manager.write(sessionId, data);
    },
  );

  ipcMain.handle(
    "volli:terminal-resize" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, cols: unknown, rows: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof cols !== "number" || typeof rows !== "number") {
        return { ok: false, error: "Invalid terminal resize" };
      }
      return manager.resize(sessionId, cols, rows);
    },
  );

  ipcMain.handle(
    "volli:terminal-kill" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal kill" };
      }
      return manager.kill(sessionId);
    },
  );

  ipcMain.handle(
    "volli:terminal-park" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): Promise<TerminalIoResult> => {
      if (typeof sessionId !== "string") {
        return Promise.resolve({ ok: false, error: "Invalid terminal park" });
      }
      // A user-initiated park bypasses the visible/keep-awake auto-park guards.
      return manager.park(sessionId, { manual: true });
    },
  );

  ipcMain.handle(
    "volli:terminal-wake" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal wake" };
      }
      return manager.wake(sessionId);
    },
  );

  ipcMain.handle(
    "volli:terminal-keep-awake" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, keepAwake: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof keepAwake !== "boolean") {
        return { ok: false, error: "Invalid terminal keep-awake" };
      }
      return manager.setKeepAwake(sessionId, keepAwake);
    },
  );

  // Fire-and-forget (ipcRenderer.send) — pane visibility flips on every nav and
  // needs no reply; the sender check mirrors the ack channel's window-scoping.
  ipcMain.on(
    "volli:terminal-set-visible" satisfies VolliIpcChannel,
    (event, ...args: unknown[]): void => {
      const [sessionId, visible] = args;
      if (typeof sessionId !== "string" || typeof visible !== "boolean") return;
      manager.setVisible(event.sender, sessionId, visible);
    },
  );

  ipcMain.handle(
    "volli:terminal-busy" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalBusyResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal busy query" };
      }
      return manager.busy(sessionId);
    },
  );

  // Fire-and-forget (ipcRenderer.send) — an ack has no result to return, and
  // round-tripping one invoke per data event would defeat the flow control.
  ipcMain.on("volli:terminal-ack" satisfies VolliIpcChannel, (event, ...args: unknown[]): void => {
    const [sessionId, chars] = args;
    if (typeof sessionId !== "string") return;
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
    manager.ack(event.sender, sessionId, chars);
  });

  // Kill every PTY on quit so no orphaned shells outlive the app — but a
  // foreground process still running somewhere (a coding agent, a build) must
  // never die to a reflexive ⌘Q: confirm first. Idle shells never block quit.
  // The dialog is synchronous, so the verdict lands inside the event: quit is
  // prevented only on Cancel, and a confirm falls through to killAll with the
  // original quit still in flight. (Never preventDefault-then-app.quit():
  // Electron swallows a quit re-issued from inside before-quit, leaving a
  // confirmed quit doing nothing.)
  app.on("before-quit", (event) => {
    const busy = manager.busySessions();
    if (
      busy.length > 0 &&
      !confirmDestructiveClose(busy, { message: "Quit Volli?", confirmLabel: "Quit" })
    ) {
      event.preventDefault();
      return;
    }
    manager.killAll();
  });

  // Start the recurring warm-park sweep here (not in the constructor) so tests
  // that construct a PtyManager directly never leak an interval.
  manager.startParkSweep();

  return manager;
}
