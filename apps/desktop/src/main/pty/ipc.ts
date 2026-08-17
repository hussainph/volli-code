// The terminal IPC surface (extracted from the former monolithic pty.ts per
// issue #99): the native destructive-close confirm gate, the renderer request
// guards, and `registerTerminalIpcHandlers` — the wiring that turns a
// PtyManager into the live `volli:terminal-*` channels plus the before-quit
// kill gate. Every guard and comment here moved verbatim from the manager.

import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { SessionEngine } from "@volli/session-engine";
import { isFirstClassHarnessId, parseHarnessId } from "@volli/shared";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  HarnessId,
  TerminalBusyResult,
  TerminalIoResult,
} from "@volli/shared";
import type { VolliIpcChannel } from "../../ipc/contract";
import { blobsRoot } from "../blob-store";
import type { DbHandle } from "../data-ipc";
import { quitAlreadyRefused, refuseQuit, updateInstallQuitInFlight } from "../quit-gate";
import { createDesktopSessionEngine } from "../session-control";
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
 * Whether this host would actually launch `value` as a harness — the trust
 * gate, not a vocabulary one.
 *
 * A kickoff names a harness whose command line Volli is about to execute, so
 * "is this a legal slug" is nowhere near enough: an id parses long before
 * anyone has confirmed the bytes behind it. The id is parsed and then looked up
 * in what THIS launch resolved, which is the only place the answer exists —
 * main reads the manifests, hashes them, and reconciles them against the
 * recorded verdicts, and no other process can.
 *
 * Built-ins short-circuit ahead of that lookup, unchanged from when they were
 * the whole rule. Their bindings are Volli's own code and need no verdict, and
 * the resolved set is empty until the wrappers are generated — gating them on
 * it would refuse a claude-code kickoff issued during boot.
 *
 * Membership means confirmed and resolvable, not necessarily wrapped: a harness
 * whose wrapper was refused (its name would shadow a system tool) still
 * launches, at the Declared tier, exactly as an unwrapped built-in does.
 */
type HarnessLaunchGuard = (value: unknown) => value is HarnessId;

function launchableHarnessGuard(runtime: AgentRuntimeEnvironment | null): HarnessLaunchGuard {
  return (value): value is HarnessId => {
    if (typeof value !== "string") return false;
    const harnessId = parseHarnessId(value);
    if (harnessId === null) return false;
    if (isFirstClassHarnessId(harnessId)) return true;
    return (runtime?.adapters ?? []).some((adapter) => adapter.id === harnessId);
  };
}

/**
 * `undefined` (no auto-launch) or a well-formed `{ harnessId, prompt }` — a
 * kickoff present with the wrong types is REJECTED (so the request fails
 * loudly), never silently dropped.
 */
function isOptionalKickoff(
  value: unknown,
  launchable: HarnessLaunchGuard,
): value is { harnessId: HarnessId; prompt: string } | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return launchable(candidate["harnessId"]) && typeof candidate["prompt"] === "string";
}

/**
 * `undefined` (no resume) or a `{ sessionId: string }` object. A malformed
 * resume shape rejects the whole ticket. The kickoff/resume mutual exclusion is
 * a semantic rule enforced in {@link resolveScope} (with a clear message), not a
 * shape rule — both fields being well-formed is valid here.
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
function isOptionalTicket(
  value: unknown,
  launchable: HarnessLaunchGuard,
): value is CreateTerminalSessionRequest["ticket"] {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    isOptionalKickoff(candidate["kickoff"], launchable) &&
    isOptionalResume(candidate["resume"])
  );
}

function isCreateRequest(
  value: unknown,
  launchable: HarnessLaunchGuard,
): value is CreateTerminalSessionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["workspaceId"] === "string" &&
    typeof candidate["cwd"] === "string" &&
    typeof candidate["cols"] === "number" &&
    typeof candidate["rows"] === "number" &&
    isOptionalTicket(candidate["ticket"], launchable)
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
  sessionEngine: SessionEngine | null = handle.ok ? createDesktopSessionEngine(handle.db) : null,
): PtyManager {
  // Same resolution as worktree-runtime.ts's `worktreeDeps`: one production
  // seam, `app.getPath("userData")`-derived.
  const blobsRootPath = blobsRoot(app.getPath("userData"));
  // Every session persists a durable record, so the manager needs the db. When
  // it failed to open, `create` reports the open error (write/kill/etc. operate
  // on the — necessarily empty — live map and stay harmless no-ops).
  const manager = handle.ok
    ? new PtyManager(
        handle.db,
        "",
        undefined,
        undefined,
        agentRuntime,
        blobsRootPath,
        sessionEngine,
      )
    : new PtyManager(null, handle.error, undefined, undefined, agentRuntime, blobsRootPath);

  // Closed over the live runtime object rather than a snapshot of it: the
  // trusted set lands there only once the wrappers are generated, which is
  // after this registration runs.
  const launchable = launchableHarnessGuard(agentRuntime);

  ipcMain.handle(
    "volli:terminal-create" satisfies VolliIpcChannel,
    (event, request: unknown): Promise<CreateTerminalSessionResult> => {
      if (!isCreateRequest(request, launchable)) {
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
    // The unsaved-editor gate ahead of this one already got a Cancel. Don't
    // stack a second modal on an answer the user has given, and don't killAll
    // over a quit that is not happening.
    if (quitAlreadyRefused(event)) return;
    // An accepted update install (VC-59) already carried this exact warning —
    // busy terminals, counted and named — in its own dialog, so asking again
    // here would be the double prompt that dialog exists to prevent. Standing
    // down means skipping the CONFIRM only: killAll below still runs, or
    // Squirrel would relaunch the new build over orphaned shells.
    const busy = updateInstallQuitInFlight() ? [] : manager.busySessions();
    if (
      busy.length > 0 &&
      !confirmDestructiveClose(busy, { message: "Quit Volli?", confirmLabel: "Quit" })
    ) {
      // `refuseQuit`, not a bare preventDefault: Electron runs every remaining
      // before-quit listener anyway, and the native-Session shutdown behind this
      // one ends in app.exit(0). Cancel used to delay the quit by one teardown
      // and then kill the process regardless.
      refuseQuit(event);
      return;
    }
    manager.killAll();
  });

  // Start the recurring warm-park sweep here (not in the constructor) so tests
  // that construct a PtyManager directly never leak an interval.
  manager.startParkSweep();

  return manager;
}
