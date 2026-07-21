import { app, BrowserWindow, dialog, Notification, session, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  diffManagedContent,
  errorMessage,
  MUTATING_AGENT_COMMANDS,
  ticketBranchName,
} from "@volli/shared";
import type { VolliIpcEvent } from "@volli/shared";
import type { ManagedConflict } from "./harness-install";
import { isInternalNavigationTarget } from "./navigation";
import type { DbHandle } from "./data-ipc";
import { registerDataIpcHandlers } from "./data-ipc";
import { openVolliDb } from "./db";
import { endLiveSessions } from "./db/sessions-repo";
import { registerGhosttyConfigIpc } from "./ghostty-config";
import { registerIpcHandlers } from "./ipc";
import { registerAppMenu } from "./menu";
import { confirmDestructiveClose, registerTerminalIpcHandlers } from "./pty";
import type { PtyManager } from "./pty";
import { registerFileIpcHandlers } from "./volli-fs";
import { broadcastDataChanged } from "./broadcast";
import { startOrphanSweep } from "./orphan-sweep";
import { worktreeDeps } from "./worktree-runtime";
import { getRetentionWatcher } from "./retention-runtime";
import { createAgentCommandService } from "./agent-commands";
import { ensureVolliCliShim, volliRuntimePaths } from "./agent-runtime";
import { startAgentSocket, type AgentSocketServer } from "./agent-socket";
import {
  installDetectedHarnessSkills,
  installGlobalCliLink,
  removeGlobalCliLinkIfOurs,
  runAgentToolsConsent,
  uninstallAllHarnessSkills,
  type AgentToolsConsentStatus,
} from "./agent-tools";
import { getAllAppState, setAppState } from "./db/app-state-repo";

// Fixes dev and the packaged app to one shared Electron `userData` dir (by
// default they diverge: packaged apps use the productName, dev falls back to
// "Electron"). Must run before anything reads app.getPath — as early as
// possible, well ahead of app.whenReady. This is what lets the SQLite db
// (and, before it, the interim localStorage stores) survive across dev vs.
// packaged launches instead of silently forking data — see the "known and
// accepted limitation" doc comment atop the old (pre-SQLite)
// stores/projects.ts for the localStorage-origin version of this same split.
app.setName("Volli Code");

const isDev = !app.isPackaged;
let agentSocket: AgentSocketServer | undefined;

// Dev gets its OWN userData directory. dev and packaged otherwise share one
// (app.setName above unifies them so the SQLite db survives across launches) —
// but that shared dir means a `pnpm dev` boot's endLiveSessions sweep marks the
// PACKAGED app's still-live sessions as ended (and vice versa), two instances
// corrupting each other's session rows. Skipped when an explicit
// `--user-data-dir` was passed (e2e/tests already isolate their profile that
// way, and assert getPath("userData") equals it); VOLLI_DB_PATH still wins for
// the db path regardless.
if (isDev && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
}

// The packaged renderer entry — loaded by createWindow's loadFile below and,
// mirrored here, the sole allowed in-window file:// document in prod.
const PACKAGED_RENDERER_ENTRY = join(__dirname, "../dist/index.html");

// Navigation hardening (Electron footgun). Markdown in ticket bodies, comments,
// and agent-written artifacts now renders real <a href> links, so a click would
// otherwise navigate the whole BrowserWindow away from the app — or a
// window.open would punch out an uncontrolled child window.
//
// The only allowed in-window destinations are the dev-server origin in dev and
// the EXACT packaged index.html document in prod (compared by pathname, so any
// OTHER local file — e.g. an .html dragged onto the window — is external even
// though it's also file://). Everything else is external. See navigation.ts.
function isInternalNavigation(target: string): boolean {
  const devUrl = isDev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  if (devUrl) {
    return isInternalNavigationTarget(target, {
      devOrigin: new URL(devUrl).origin,
      packagedPathname: null,
    });
  }
  return isInternalNavigationTarget(target, {
    devOrigin: null,
    packagedPathname: pathToFileURL(PACKAGED_RENDERER_ENTRY).pathname,
  });
}

/** Sends an http(s) URL to the user's default browser; ignores anything else. */
function openExternal(target: string): void {
  if (target.startsWith("http:") || target.startsWith("https:")) {
    void shell.openExternal(target);
  }
}

function createWindow(ptyManager: PtyManager): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Usability floor: rail + max-width sidebar + a workable content column.
    minWidth: 940,
    minHeight: 600,
    show: false,
    // Slack/Cursor-style chrome: no title bar. The renderer paints a
    // full-width 40px chrome band (ChromeBar) that owns the drag region
    // (.app-region-drag in globals.css) and the traffic-light whitespace —
    // everything below that band is ordinary layout.
    titleBarStyle: "hiddenInset",
    // Centers the 12px traffic-light group inside ChromeBar's 40px band
    // ((40 - 12) / 2 = 14). Must stay in sync with ChromeBar's h-10 height
    // (chrome-bar.tsx), the same way backgroundColor below tracks --background.
    trafficLightPosition: { x: 10, y: 14 },
    // Must match --background in renderer globals.css (main cannot read
    // renderer CSS) — prevents the white flash before first paint.
    backgroundColor: "#111111",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  // Destructive-close gate, window edition (the before-quit gate in pty.ts is
  // its ⌘Q sibling): closing the window tears down every PTY it owns via their
  // webContents `destroyed` listeners, so a window with a foreground process
  // still running must confirm first. Idle shells close silently. During an
  // already-confirmed quit this never re-prompts — before-quit's killAll has
  // emptied the manager, so busySessions comes back empty.
  let closeConfirmed = false;
  mainWindow.on("close", (event) => {
    if (closeConfirmed) return;
    const busy = ptyManager.busySessions(mainWindow.webContents);
    if (busy.length === 0) return;
    event.preventDefault();
    const proceed = confirmDestructiveClose(busy, {
      message: "Close this window?",
      confirmLabel: "Close Window",
      window: mainWindow,
    });
    if (proceed) {
      closeConfirmed = true;
      mainWindow.close();
    }
  });

  // Neutralize any per-origin zoom Electron persisted before UI zoom moved to
  // CSS `zoom` in the renderer: a stale native zoom level would still scale the
  // chrome band away from the native traffic lights. Pin the page to native
  // scale and disable pinch-to-zoom (visual zoom) so only the renderer's CSS
  // zoom — applied below the chrome band — ever changes UI scale.
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomLevel(0);
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  });

  // macOS fullscreen: mousing to the top slides the menu bar plus a native
  // titlebar band OVER the content — system behavior for every hidden-titlebar
  // app; the space can't be reserved. Blank the title there so the band shows
  // only the traffic lights, and tell the renderer so it can reclaim its
  // traffic-light strip (the lights are hidden in fullscreen).
  let preFullScreenTitle = "";
  mainWindow.on("enter-full-screen", () => {
    preFullScreenTitle = mainWindow.getTitle();
    mainWindow.setTitle("");
    mainWindow.webContents.send("volli:fullscreen-changed" satisfies VolliIpcEvent, true);
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow.setTitle(preFullScreenTitle);
    mainWindow.webContents.send("volli:fullscreen-changed" satisfies VolliIpcEvent, false);
  });

  // Navigation hardening (see isInternalNavigation/openExternal above): deny
  // every new-window request, opening http(s) targets in the user's browser;
  // prevent every in-window navigation away from the app's own entry, sending
  // http(s) targets to the browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (isInternalNavigation(target)) return;
    event.preventDefault();
    openExternal(target);
  });

  // In dev, scripts/dev.mjs injects ELECTRON_RENDERER_URL and runs the Vite dev
  // server there for HMR. In production, load the built renderer from disk.
  // DevTools is not auto-opened — toggle it with ⌥⌘I when needed.
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(PACKAGED_RENDERER_ENTRY);
  }
  return mainWindow;
}

app.whenReady().then(async () => {
  if (isDev) {
    // Dev smoke-check that vp pack bundled the workspace TS source (@volli/shared)
    // into main.cjs via deps.alwaysBundle rather than leaving an unresolved
    // runtime require(). Gated to dev so it never prints on a production boot.
    console.log("[volli] shared wiring OK:", ticketBranchName("VC-0", "monorepo migration"));
  }

  // Dock icon for unpackaged boots. A packaged .app gets its icon from the
  // bundle's icon.icns (build/icon.icns, baked from build/icon-source.svg; the
  // Icon Composer master lives in the local design workspace outside the
  // repo); `pnpm dev` would otherwise show Electron's stock icon.
  if (isDev && process.platform === "darwin") {
    const dockIcon = join(app.getAppPath(), "build", "dock-icon.png");
    if (existsSync(dockIcon)) {
      app.dock?.setIcon(dockIcon);
    }
  }

  // Renderer permission policy. Electron's default with NO handler installed
  // is grant-everything; this allowlist keeps exactly what the app uses:
  //  - local-fonts: restty resolves the ghostty-config font families against
  //    installed fonts via the Local Font Access API (issue #18).
  //  - clipboard-read / clipboard-sanitized-write: terminal copy/paste and
  //    OSC 52 (status quo under the old default-grant; a ghostty-style
  //    clipboard-read=ask policy needs a restty seam that 0.2.0 lacks).
  //  - fullscreen: standard window affordance.
  const allowedPermissions = new Set([
    "local-fonts",
    "clipboard-read",
    "clipboard-sanitized-write",
    "fullscreen",
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowedPermissions.has(permission),
  );

  registerIpcHandlers();
  // Ghostty config read + live-reload watch, feeding restty's appearance.
  registerGhosttyConfigIpc();

  // Open (creating + migrating if needed) the SQLite db before the window
  // exists, so the renderer's boot-time volli:data-bootstrap call always has
  // somewhere to land. VOLLI_DB_PATH overrides the path in dev/tests/e2e;
  // otherwise it's <userData>/volli.db, made possible sharing one userData
  // dir across dev/packaged by the app.setName call above. Failure here must
  // never crash main or leave invoke() hanging: register every data IPC
  // channel with a typed { ok: false, error } response instead, so the
  // renderer can surface the failure like any other failed mutation.
  const dbPath =
    (isDev ? process.env["VOLLI_DB_PATH"] : undefined) ?? join(app.getPath("userData"), "volli.db");
  let dbHandle: DbHandle;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    dbHandle = { ok: true, db: openVolliDb(dbPath) };
  } catch (error) {
    dbHandle = { ok: false, error: errorMessage(error) };
    console.error("[volli] failed to open database:", dbHandle.error);
  }
  // Boot recovery: no PTY survives a relaunch, so close out any session row
  // still marked live before the renderer lists them — the table must never
  // accumulate phantom "live" sessions.
  if (dbHandle.ok) {
    try {
      endLiveSessions(dbHandle.db, Date.now());
    } catch (error) {
      console.error("[volli] failed to sweep stale sessions:", errorMessage(error));
    }
  }
  // Assigned once registerTerminalIpcHandlers runs below; the worktree
  // remove/orphan-delete guards read it lazily (only at invoke time, long after
  // boot) to refuse touching a directory a live session still runs in.
  let ptyManagerRef: PtyManager | undefined;
  // Standard macOS menu, but with the View-menu zoom roles replaced by
  // renderer-driven CSS zoom (see menu.ts for the rationale). Registered here
  // (rather than up with the other pre-window setup) because File > Export
  // Database needs `dbHandle`, which doesn't exist yet at that point.
  registerDataIpcHandlers(dbHandle, {
    liveSessionCwds: () => ptyManagerRef?.liveSessionCwds() ?? [],
    // Backward-move interrupt (issue #78): a user move that leaves the active
    // columns Esc's the ticket's live agent sessions. Lazy through the ref —
    // this runs before the PtyManager is built below, but only ever fires at
    // invoke time, long after boot.
    interruptTicketSessions: (ticketId) => ptyManagerRef?.interruptTicketSessions(ticketId) ?? [],
  });
  // Global-artifacts + @file fs plumbing (file index/read/write, artifact
  // create, reveal, per-tab watch); same degraded-DB stance as
  // registerDataIpcHandlers.
  registerFileIpcHandlers(dbHandle);
  // Boots the PTY multiplexer (persists a durable record per session) and its
  // before-quit teardown (kills all PTYs, gated on busy sessions); needs the
  // db, so it registers here. The returned manager feeds each window's own
  // destructive-close gate.
  const runtimePaths = volliRuntimePaths({
    userDataPath: app.getPath("userData"),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  // Create the window first so first paint isn't blocked on shim generation or
  // the socket bind; both start right after, still awaited inside whenReady with
  // the same failure semantics (logged, non-fatal). registerTerminalIpcHandlers
  // needs only runtimePaths (a pure join), so it can precede the window it feeds.
  const ptyManager = registerTerminalIpcHandlers(dbHandle, runtimePaths);
  ptyManagerRef = ptyManager;
  const mainWindow = createWindow(ptyManager);

  // Startup orphan sweep (worktree-support §7): prunes stale git metadata and
  // removes clean orphaned worktree dirs (branches retained); dirty orphans are
  // left for Settings → Worktrees. DESTRUCTIVE, so it runs exactly ONCE per
  // launch — cached in orphan-sweep.ts and read back (never re-swept) by the
  // volli:worktree-orphans handler. Deferred to did-finish-load so it never
  // competes with first paint; a sweep failure is logged, not thrown.
  if (dbHandle.ok) {
    const db = dbHandle.db;
    mainWindow.webContents.once("did-finish-load", () => {
      startOrphanSweep(worktreeDeps(db))
        .then((report) => {
          console.log(
            `[worktree] sweep: pruned=${report.pruned.length} removedClean=${report.removedClean.length} dirty=${report.dirty.length}`,
          );
        })
        .catch((error) => {
          console.error("[worktree] sweep failed:", errorMessage(error));
        });
    });

    // Retention merge-watch (CONCEPT #16, issue #76): the background 60s poll of
    // each worktree ticket's PR, plus an on-focus trigger for immediacy. Started
    // after first paint so it never competes with boot; a background read
    // failure is silent (a read is not a mutation). Main-process focus detection
    // is the established pattern (park/quit gates live here, not the renderer).
    const retention = getRetentionWatcher(db);
    mainWindow.webContents.once("did-finish-load", () => retention.start());
    app.on("browser-window-focus", () => retention.triggerNow());
  }

  let shimPath = join(runtimePaths.binDir, "volli");
  try {
    shimPath = await ensureVolliCliShim({
      binDir: runtimePaths.binDir,
      electronPath: process.execPath,
      bundlePath: runtimePaths.cliBundlePath,
      socketPath: runtimePaths.socketPath,
      appEntry: app.isPackaged ? null : join(app.getAppPath(), "dist-electron/main.cjs"),
    });
  } catch (error) {
    console.error("[volli] failed to generate CLI shim:", errorMessage(error));
  }

  const agentToolsConsentKey = "volli:agent-tools-consent";

  // The skill installer targets the real OS home via app.getPath("home"), which
  // on macOS ignores $HOME — so a
  // headless installer-idempotency e2e cannot redirect it into a throwaway
  // profile. VOLLI_AGENT_HOME overrides the install/refresh/uninstall home for
  // exactly that. Unset in production, so the real home is used unchanged.
  const agentToolsHome =
    (isDev ? process.env["VOLLI_AGENT_HOME"] : undefined) ?? app.getPath("home");

  // Renders hand-edited managed files that were preserved (never overwritten)
  // as path + a readable unified diff in the dialog detail. Shared by install,
  // the on-update refresh, and uninstall.
  const showSkillConflictWarning = async (conflicts: readonly ManagedConflict[]): Promise<void> => {
    const detail = conflicts
      .map(
        (conflict) =>
          `${conflict.path}\n${diffManagedContent(conflict.currentContent, conflict.desiredContent)}`,
      )
      .join("\n\n");
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Some Volli skill files were edited and were left untouched.",
      detail,
    });
  };

  const installAgentTools = async (): Promise<void> => {
    // Each step names itself in any thrown error so the failure dialog says what
    // broke (skill files vs. the /usr/local/bin symlink) rather than a bare
    // osascript/fs message. A throw leaves consent un-persisted on purpose, so a
    // transient failure re-offers next boot instead of latching a broken state.
    let result;
    try {
      result = await installDetectedHarnessSkills({
        home: agentToolsHome,
        pathValue: process.env["PATH"] ?? "",
      });
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Installation Failed",
        `Installing the agent skill pack failed: ${errorMessage(error)}`,
      );
      throw error;
    }
    // The /usr/local/bin symlink needs an administrator (osascript) prompt that
    // no headless e2e can answer,
    // so when a test pre-answers consent via VOLLI_AGENT_CONSENT_CHOICE the link
    // step is skipped. Unset in production, so the admin prompt runs unchanged.
    if (!isDev || process.env["VOLLI_AGENT_CONSENT_CHOICE"] === undefined) {
      try {
        await installGlobalCliLink(shimPath);
      } catch (error) {
        dialog.showErrorBox(
          "Agent Tools Installation Failed",
          `Linking the volli CLI into /usr/local/bin failed: ${errorMessage(error)}`,
        );
        throw error;
      }
    }
    if (result.conflicts.length > 0) {
      await showSkillConflictWarning(result.conflicts);
    }
  };

  // Menu action: confirm, remove every harness's managed files (hand-edited
  // ones survive via the uninstall hash guard), drop the /usr/local/bin link
  // only if it still points at our shim, then reset consent to null so the
  // first-launch offer returns. Every failure surfaces its own dialog.
  const uninstallAgentTools = async (): Promise<void> => {
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Remove the Volli CLI and agent skills?",
      detail:
        "This removes the bundled skill pack and the /usr/local/bin/volli link. Files you edited yourself are left in place.",
      buttons: ["Remove", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirm.response !== 0) return;

    let removal;
    try {
      removal = await uninstallAllHarnessSkills({ home: agentToolsHome });
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Removal Failed",
        `Removing the agent skill pack failed: ${errorMessage(error)}`,
      );
      return;
    }
    try {
      await removeGlobalCliLinkIfOurs(shimPath);
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Removal Failed",
        `Removing the /usr/local/bin/volli link failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (dbHandle.ok) {
      try {
        setAppState(dbHandle.db, agentToolsConsentKey, JSON.stringify(null), Date.now());
      } catch (error) {
        dialog.showErrorBox("Agent Tools Removal Failed", errorMessage(error));
        return;
      }
    }
    const preservedNote =
      removal.preserved.length > 0
        ? `\n\nLeft in place because you edited them:\n${removal.preserved.join("\n")}`
        : "";
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      message: "Volli CLI and agent skills removed.",
      detail: `Removed ${removal.removed.length} managed item(s).${preservedNote}`,
    });
  };

  registerAppMenu(dbHandle, { installAgentTools, uninstallAgentTools });

  try {
    const execute = dbHandle.ok
      ? createAgentCommandService({
          db: dbHandle.db,
          appVersion: app.getVersion(),
          observeSession: (sessionId, lines) => ptyManager.peek(sessionId, lines),
          notify: (title, message) => new Notification({ title, body: message }).show(),
          // Backward-move interrupt (issue #78): a socket `ticket.move` that
          // leaves the active columns Esc's the ticket's live agent sessions.
          interruptTicketSessions: (ticketId) => ptyManager.interruptTicketSessions(ticketId),
        }).execute
      : async () =>
          ({
            v: 1,
            ok: false,
            error: { code: "DB_UNAVAILABLE", message: dbHandle.error },
          }) as const;
    agentSocket = await startAgentSocket({
      socketPath: runtimePaths.socketPath,
      execute: async (request) => {
        const response = await execute(request);
        if (response.ok && MUTATING_AGENT_COMMANDS.includes(request.cmd)) {
          broadcastDataChanged();
        }
        return response;
      },
    });
  } catch (error) {
    console.error("[volli] failed to start agent socket:", errorMessage(error));
  }

  if (dbHandle.ok) {
    const consentKey = agentToolsConsentKey;
    const stored = getAllAppState(dbHandle.db)[consentKey];
    const current: AgentToolsConsentStatus | null =
      stored === '"installed"' ? "installed" : stored === '"deferred"' ? "deferred" : null;
    if (current === "installed") {
      // Re-run the hash-guarded, idempotent skill installer on app updates so
      // managed files track the shipped version —
      // byte-identical files skip, user-edited ones conflict and are preserved.
      // The one-time /usr/local/bin symlink is deliberately NOT re-run here: the
      // shim it points at is already regenerated every boot, and re-linking would
      // resurface an admin prompt. Fully non-blocking and swallowed (logged) so a
      // failed refresh never blocks boot or spams dialogs; only a genuine
      // conflict warns.
      void installDetectedHarnessSkills({
        home: agentToolsHome,
        pathValue: process.env["PATH"] ?? "",
      })
        .then(async (result) => {
          if (result.conflicts.length > 0) await showSkillConflictWarning(result.conflicts);
        })
        .catch((error: unknown) => {
          console.error("[volli] agent skill refresh failed:", errorMessage(error));
        });
    }
    try {
      await runAgentToolsConsent({
        current,
        prompt: async () => {
          // A headless e2e cannot click a native dialog, and this prompt fires
          // during boot before a
          // Playwright client can patch dialog.showMessageBox, so
          // VOLLI_AGENT_CONSENT_CHOICE pre-answers it. Honored only when set to
          // "install"/"defer"; unset in production, so the dialog shows as before.
          const preAnswer = isDev ? process.env["VOLLI_AGENT_CONSENT_CHOICE"] : undefined;
          if (preAnswer === "install" || preAnswer === "defer") return preAnswer;
          const choice = await dialog.showMessageBox(mainWindow, {
            type: "question",
            message: "Install the Volli CLI and agent skills?",
            detail:
              "Volli will expose its CLI in /usr/local/bin and install the bundled skill only for detected agent harnesses. You can do this later from the File menu.",
            buttons: ["Install", "Not Now"],
            defaultId: 0,
            cancelId: 1,
          });
          return choice.response === 0 ? "install" : "defer";
        },
        install: installAgentTools,
        persist: async (status) => {
          setAppState(dbHandle.db, consentKey, JSON.stringify(status), Date.now());
        },
      });
    } catch {
      // installAgentTools already surfaced the actionable failure.
    }
  }

  app.on("activate", () => {
    // On macOS it's common to re-create a window when the dock icon is
    // clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(ptyManager);
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS it's common for applications to stay active until the user
  // quits explicitly with Cmd + Q.
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void agentSocket?.close().catch((error: unknown) => {
    console.error("[volli] failed to close agent socket:", errorMessage(error));
  });
  agentSocket = undefined;
});
