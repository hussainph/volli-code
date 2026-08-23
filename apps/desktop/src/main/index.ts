import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BLOB_URL_SCHEME,
  diffManagedContent,
  displayTicketId,
  errorMessage,
  getHarnessAdapter,
  harnessAdapters,
  globalSkillsDir,
  projectSkillsDir,
  draftAttachmentHashes,
  resolveDefaultModel,
  resolveShell,
  skillPromptResource,
  skillsIndexResource,
  ticketBranchName,
  NEW_TICKET_DRAFT_APP_STATE_KEY,
  VOLLI_USER_ZDOTDIR_ENV,
  workspaceInstallCommand,
} from "@volli/shared";
import type { PromptResource, SessionEnvRepair, SessionEvent, SessionInput } from "@volli/shared";
import type { HarnessAdapter, HarnessId, ResolvedAppearance } from "@volli/shared";
import type { FirstPaintHint, VolliIpcChannel, VolliIpcEvent } from "../ipc/contract";
import type { HarnessUninstallResult, ManagedConflict } from "./harness-install";
import {
  abandonAcceptedUpdateInstall,
  beginAcceptedUpdateInstall,
  clearUnsavedDocumentsOnWindowClosed,
  planUnsavedQuit,
  quitAlreadyRefused,
  quitConfirmDetail,
  recordUnsavedDocuments,
  registerAcceptedQuitCoordinator,
  refuseQuit,
  unsavedDocumentNames,
  updateInstallQuitInFlight,
} from "./quit-gate";
import { isInternalNavigationTarget } from "./navigation";
import type { BusyWorktreeSite, DbHandle } from "./data-ipc";
import { registerDataIpcHandlers } from "./data-ipc";
import { openVolliDb } from "./db";
import { getProjectById, listProjects } from "./db/projects-repo";
import { getTicket, getTicketBrief } from "./db/tickets-repo";
import { listMaterializableLinks } from "./db/blobs-repo";
import { recordTicketEvent } from "./db/events-repo";
import { createDesktopSessionEngine, watchSessionActivity } from "./session-control";
import { createDesktopSessionRuntime, createFileTranscriptArtifactStore } from "./session-runtime";
import { closeStaleAttachments } from "./session-runtime/boot-recovery";
import { sessionRootThreadId } from "@volli/session-engine";
import { describeDbOpenFailure } from "./db-open-failure";
import { registerModelAccessIpcHandlers } from "./model-access/ipc";
import { ModelAccessSignInService } from "./model-access/sign-in-service";
import { registerWebAccessIpcHandlers } from "./web/ipc";
import {
  BRAVE_SEARCH_KEY_SECRET,
  EXA_SEARCH_KEY_SECRET,
  WebCredentialStore,
} from "./web/credential";
import { WebAccessSettings } from "./web/settings";
import { webPortsFor } from "./web/ports";
import { createPiRuntimeHost } from "./session-runtime/pi-adapter";
import { createAutoTitler } from "./session-runtime/auto-title";
import {
  createSessions,
  StructuredSessionsError,
  type SessionSkillPorts,
} from "./session-runtime/sessions";
import { loadSkills } from "./skills";
import {
  assertCompactionLimitsUsable,
  assertDefaultModelAvailable,
  readCompactionPolicy,
  readHiddenModels,
  readModelAccessDefaults,
  writeCompactionPolicy,
  writeHiddenModels,
  writeModelAccessDefault,
} from "./session-runtime/model-access-preferences";
import {
  registerDegradedSessionRpcIpcHandlers,
  registerSessionRpcIpcHandlers,
} from "./session-rpc-ipc";
import { piExecutionEnv, piOwnedModelAccess, piSignIn } from "@volli/agent-runtime";
import { listRegisteredHarnesses } from "./db/harness-registry-repo";
import { registerGhosttyConfigIpc } from "./ghostty-config";
import { registerIpcHandlers } from "./ipc";
import { registerAppMenu } from "./menu";
import { confirmDestructiveClose, registerTerminalIpcHandlers } from "./pty";
import type { AgentRuntimeEnvironment, PtyManager } from "./pty";
import { registerThemeIpcHandlers } from "./theme-ipc";
import { defaultFsDeps } from "./fs-deps";
import { getFirstPaintHint, getGlobalAppearance, getGlobalCanvas } from "./db/theme-repo";
import { firstPaintArguments, resolveFirstPaint } from "./window-theme";
import { registerFileIpcHandlers } from "./volli-fs";
import {
  broadcastDataChanged,
  broadcastHarnessEvent,
  broadcastSessionActivity,
  broadcastSessionHarness,
  broadcastSessionRetitled,
  broadcastSessionsInterrupted,
  broadcastSessionStarted,
  broadcastSystemAppearance,
  broadcastUpdateState,
} from "./broadcast";
import { startOrphanSweep } from "./orphan-sweep";
import { registerUpdateIpcHandlers } from "./update-ipc";
import {
  agentTurnOpenWithin,
  countOpenAgentTurns,
  releaseAgentSites as releaseWorktreeAgentSites,
} from "./worktree";
import type { AgentSiteReleaseReport } from "./worktree";
import { worktreeDeps } from "./worktree-runtime";
import { getRetentionWatcher } from "./retention-runtime";
import {
  composeProjectBrief,
  composeTicketBrief,
  createAgentCommandService,
} from "./agent-commands";
import { acquireVolliAppProfile, ensureVolliCliShim, volliRuntimePaths } from "./agent-runtime";
import {
  decideRegisteredHarnesses,
  scanHarnessManifests,
  trustedHarnessAdapters,
} from "./harness-registry";
import { registerHarnessIpcHandlers } from "./harness-ipc";
import { ensureHarnessRuntime, harnessLaunchArgv } from "./harness-runtime";
import type { RefusedWrapper } from "./harness-runtime";
import { ensureShellInit } from "./shell-init";
import {
  createAgentSocketLifecycle,
  registerAgentSocketWillQuit,
  startAgentSocket,
} from "./agent-socket";
import { createLoginPathBootstrap } from "./login-path-adoption";
import {
  ADOPTION_PROBE,
  loginShellPath,
  probeLoginShellPath,
  resetLoginShellPathCache,
} from "./login-shell-path";
import { buildSessionEnvReport } from "./session-env";
import { systemPathIssues as readSystemPathIssues } from "./system-path-diagnostics";
import {
  cleanupLegacyGlobalCliLink,
  detectHarnesses,
  ensureUserBinOnPath,
  ensureUserCliLink,
  installHarnessSkills,
  removeUserBinPathBlock,
  removeUserCliLinkIfOurs,
  resolveOnPath,
  uninstallAllHarnessSkills,
  userCliLinkPath,
} from "./agent-tools";
import { registerCliIpcHandlers } from "./cli-ipc";
import { probeCliDoctor } from "./cli-doctor";
import { readCliStatus } from "./cli-status";
import { getAllAppState, setAppState } from "./db/app-state-repo";
import { readAllowPrerelease, startAutoUpdate } from "./auto-update";
import {
  PACKAGED_RENDERER_ENTRY_URL,
  PACKAGED_RENDERER_HOST,
  PACKAGED_RENDERER_PROTOCOL,
  PACKAGED_RENDERER_SCHEME,
  resolvePackagedRendererAsset,
} from "./app-protocol";
import { collectUnlinkedBlobs } from "./blob-collect";
import { prepareTurnAttachments } from "./turn-attachments";
import { blobProtocolResponse } from "./blob-protocol";
import { blobsRoot } from "./blob-store";
import { getBlob } from "./db/blobs-repo";

// Monaco's language services require web workers, which Chromium does not
// permit from file://. Register one standard, secure, fetch-capable app scheme
// before Electron becomes ready; deliberately omit bypassCSP.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PACKAGED_RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  // Attachment bytes (VC-50). Registered beside the renderer scheme and under
  // the same rules — `standard` so Chromium parses `volli-blob://<hash>` as an
  // origin rather than an opaque blob of text, `secure` so an <img> on the
  // renderer's secure origin is not treated as mixed content, and no bypassCSP:
  // the scheme is named explicitly in the renderer's img-src instead, so its
  // reach stays visible in the policy rather than hidden in a privilege.
  {
    scheme: BLOB_URL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

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
const agentSocket = createAgentSocketLifecycle({
  start: startAgentSocket,
  reportFailure: (error) => {
    console.error("[volli] failed to close agent socket:", errorMessage(error));
  },
});
const shutdownAgentSocket = agentSocket.shutdown;

// Dev gets its OWN userData directory. dev and packaged otherwise share one
// (app.setName above unifies them so the SQLite db survives across launches) —
// but that shared dir means a `pnpm dev` boot's stale-attachment recovery closes
// the PACKAGED app's terminal attachments (and vice versa), two instances
// corrupting each other's terminal projection. Skipped when an explicit
// `--user-data-dir` was passed (e2e/tests already isolate their profile that
// way, and assert getPath("userData") equals it); VOLLI_DB_PATH still wins for
// the db path regardless.
if (isDev && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
}
const ownsAppProfile = acquireVolliAppProfile(app);
if (ownsAppProfile) {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// The app-owned directory exposed by volli-app://bundle/. The protocol resolver
// below is exact-host and containment checked: it cannot serve project files or
// anything else from the local filesystem.
const PACKAGED_RENDERER_ROOT = join(__dirname, "../dist");

// Navigation hardening (Electron footgun). Markdown in ticket bodies, comments,
// and agent-written artifacts now renders real <a href> links, so a click would
// otherwise navigate the whole BrowserWindow away from the app — or a
// window.open would punch out an uncontrolled child window.
//
// The only allowed in-window destinations are the dev-server origin in dev and
// the exact packaged app scheme+host in production. Everything else is
// external. See navigation.ts.
function isInternalNavigation(target: string): boolean {
  const devUrl = isDev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  if (devUrl) {
    return isInternalNavigationTarget(target, {
      kind: "dev",
      origin: new URL(devUrl).origin,
    });
  }
  return isInternalNavigationTarget(target, {
    kind: "packaged",
    scheme: PACKAGED_RENDERER_PROTOCOL,
    host: PACKAGED_RENDERER_HOST,
    pathname: "/index.html",
  });
}

/**
 * The recorded brief's text. `getOrRecordSessionInput` is keyed by the input's
 * kind, so a `runtime-brief` request can only ever answer with a
 * `runtime-brief` record — any other kind here is ledger corruption, and the
 * throw fails this attach loudly instead of briefing the Session on nothing.
 */
function briefText(input: SessionInput): string {
  if (input.kind !== "runtime-brief") {
    throw new Error(`Recorded runtime brief has kind ${input.kind}`);
  }
  return input.text;
}

/**
 * The attach-time prompt resources this Session durably recorded, or none.
 * One record per Session at most — `getOrRecordSessionInput` is kind-keyed —
 * so the first hit is the whole answer.
 */
function recordedPromptResources(events: readonly SessionEvent[]): readonly PromptResource[] {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "prompt-resources"
    ) {
      return event.payload.input.resources;
    }
  }
  return [];
}

/** Sends an http(s) URL to the user's default browser; ignores anything else. */
function openExternal(target: string): void {
  if (target.startsWith("http:") || target.startsWith("https:")) {
    void shell.openExternal(target);
  }
}

/**
 * The native "this will destroy unsaved work" confirm, shared by ⌘Q and window
 * close. Native and synchronous for the same reason the terminal one is: both
 * callers need their verdict inside the event they are about to preventDefault.
 * Returns true when the user chose to go ahead and lose the drafts.
 */
function confirmDiscardUnsaved(
  names: readonly string[],
  verb: "Quit" | "Close",
  window?: BrowserWindow,
): boolean {
  const options = {
    type: "warning" as const,
    buttons: [`Discard and ${verb}`, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: verb === "Quit" ? "Quit Volli?" : "Close this window?",
    detail: quitConfirmDetail(names),
  };
  const choice =
    window === undefined
      ? dialog.showMessageBoxSync(options)
      : dialog.showMessageBoxSync(window, options);
  return choice === 0;
}

function createWindow(ptyManager: PtyManager, firstPaint: FirstPaintHint): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Usability floor: rail + max-width sidebar + a workable content column.
    minWidth: 940,
    minHeight: 600,
    show: false,
    // Slack/Cursor-style chrome: no title bar. The renderer paints a
    // full-width 36px chrome band (ChromeBar) that owns the drag region
    // (.app-region-drag in globals.css) and the traffic-light whitespace —
    // everything below that band is ordinary layout.
    titleBarStyle: "hiddenInset",
    // Centers the 12px traffic-light group inside ChromeBar's 36px band
    // ((36 - 12) / 2 = 12). Must stay in sync with ChromeBar's h-9 height
    // (chrome-bar.tsx), the same way backgroundColor below tracks the canvas.
    trafficLightPosition: { x: 10, y: 12 },
    // The canvas's own base fill (window-theme.ts runs the same pure pipeline
    // the renderer does, preferring the background the renderer last actually
    // painted) — prevents the white flash before first paint, and keeps the
    // window edge from flashing the OLD palette during a resize after a canvas
    // change.
    backgroundColor: firstPaint.background,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // Two facts the renderer needs before it can run a line of its own: the
      // resolved light/dark mode, so the preload can stamp the mode class BEFORE
      // the first frame (an `invoke()` round trip resolves a frame too late,
      // which is the flash this whole path exists to prevent), and what the
      // system is asking for, which is what an `auto` appearance resolves
      // against and which the renderer cannot read for itself — its own
      // `prefers-color-scheme` query answers from the `color-scheme` this app
      // stamped. `nativeTheme` is read here, at construction, for the same
      // reason `currentFirstPaint` reads it: `activate` can build a window long
      // after boot.
      additionalArguments: firstPaintArguments(firstPaint, nativeTheme.shouldUseDarkColors),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ already defaults this on; explicit so it can't silently
      // regress. Safe: the preload only imports `electron` (contextBridge,
      // ipcRenderer) plus type-only @volli/shared imports — no Node builtins.
      sandbox: true,
    },
  });
  clearUnsavedDocumentsOnWindowClosed(mainWindow);

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
    // An accepted update install (VC-59): its dialog already named the unsaved
    // drafts and busy terminals this close destroys, and Electron's native
    // quitAndInstall closes every window BEFORE before-quit fires — a confirm
    // here would be the second prompt the one-dialog decision forbids, and a
    // Cancel would leave Squirrel already instructed to relaunch over a still-
    // running app.
    if (updateInstallQuitInFlight()) return;
    // Unsaved editor drafts are asked about FIRST and separately from the busy
    // terminals: closing the window destroys the renderer holding those drafts
    // exactly as finally as quitting does, and unlike a killed shell there is
    // nothing left afterwards to recover them from.
    // Same plan as the quit gate, skip-confirm seam included: the smokes close
    // windows with editors deliberately left dirty, and a native modal here
    // would hang their teardown exactly as one on the quit path would.
    const unsaved = unsavedDocumentNames();
    const unsavedStep = planUnsavedQuit({
      names: unsaved,
      skipConfirm: process.env["VOLLI_SKIP_CLOSE_CONFIRM"] === "1",
    });
    const busy = ptyManager.busySessions(mainWindow.webContents);
    if (unsavedStep === "quit" && busy.length === 0) return;

    // Something is at stake, so hold the close while the questions are asked;
    // a confirmed close is re-issued below rather than resumed.
    event.preventDefault();
    if (unsavedStep === "confirm" && !confirmDiscardUnsaved(unsaved, "Close", mainWindow)) return;
    if (
      busy.length > 0 &&
      !confirmDestructiveClose(busy, {
        message: "Close this window?",
        confirmLabel: "Close Window",
        window: mainWindow,
      })
    ) {
      return;
    }
    closeConfirmed = true;
    mainWindow.close();
  });

  // Neutralize any per-origin zoom Electron persisted before UI zoom moved to
  // CSS `zoom` in the renderer: a stale native zoom level would still scale the
  // chrome band away from the native traffic lights. Pin the page to native
  // scale and disable pinch-to-zoom (visual zoom) so only the renderer's CSS
  // zoom — applied below the chrome band — ever changes UI scale.
  // A load that completes while the window is tearing down (close/quit during
  // boot) still emits `did-finish-load`; touching the destroyed window then is
  // an uncaught main-process exception and a modal error dialog.
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow.isDestroyed()) return;
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
    if (mainWindow.isDestroyed()) return;
    preFullScreenTitle = mainWindow.getTitle();
    mainWindow.setTitle("");
    mainWindow.webContents.send("volli:fullscreen-changed" satisfies VolliIpcEvent, true);
  });
  mainWindow.on("leave-full-screen", () => {
    if (mainWindow.isDestroyed()) return;
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
  // server there for HMR. Otherwise load the built renderer through the secure,
  // app-owned origin (including local packaged-runtime smoke launches).
  // DevTools is not auto-opened — toggle it with ⌥⌘I when needed.
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadURL(PACKAGED_RENDERER_ENTRY_URL);
  }
  return mainWindow;
}

app.whenReady().then(async () => {
  if (!ownsAppProfile) return;
  // Started here, awaited nowhere near here: a Finder/Dock launch hands main
  // launchd's bare PATH, and the only fix is asking the user's own login
  // shell what it would have exported. That costs a shell spawn (~4s worst
  // case) — started now so it runs alongside the db open, migrations and IPC
  // registration below rather than in front of them. Its result is observed
  // only after the first window loads, or by a Pi execution environment that
  // genuinely needs it first.
  const loginShellPathAttempt = probeLoginShellPath(ADOPTION_PROBE);
  protocol.handle(PACKAGED_RENDERER_SCHEME, (request) => {
    const assetPath = resolvePackagedRendererAsset(request.url, PACKAGED_RENDERER_ROOT);
    if (assetPath === null) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  });

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
  // The ONE filesystem seam the config surfaces share (fs-deps.ts) — ghostty
  // resolution and the terminal-overlay writer both pull their slice from this
  // single value, so there is no second `readFile` or second `userData` root to
  // keep in agreement. Built here because this is the one place that may
  // resolve `app.getPath("userData")`, the same injection stance as the db path
  // and the attachment store below.
  const fsDeps = defaultFsDeps(app.getPath("userData"));

  // Open (creating + migrating if needed) the SQLite db before the window
  // exists, so the renderer's boot-time volli:data-bootstrap call always has
  // somewhere to land. VOLLI_DB_PATH overrides the path in dev/tests/e2e;
  // otherwise it's <userData>/volli.db — and dev's userData is its own `-dev`
  // directory (see the app.setPath above), so dev and packaged open DIFFERENT
  // files by default. Failure here must never crash main or leave invoke()
  // hanging: register every data IPC channel with a typed { ok: false, error }
  // response instead, so the renderer can surface the failure like any other
  // failed mutation.
  //
  // Resolve the override ONCE and derive both the path and the logged source
  // from it: deriving the label separately would disagree with `??` on an
  // empty `VOLLI_DB_PATH=` (not nullish, so it wins and yields an empty path)
  // and blame userData for a failure the override caused.
  const dbOverride = isDev ? process.env["VOLLI_DB_PATH"] : undefined;
  const dbPath = dbOverride ?? join(app.getPath("userData"), "volli.db");
  // Log the resolved db up front: a `pnpm dev` boot lands on the empty
  // `Volli Code-dev/volli.db` while your real data sits in the packaged app's
  // `Volli Code/volli.db`. Without this line an empty dev UI is
  // indistinguishable from a broken data pointer — surface which db is live.
  const dbSource = dbOverride === undefined ? "userData" : "VOLLI_DB_PATH";
  console.info(`[volli] db: mode=${isDev ? "dev" : "packaged"} source=${dbSource} path=${dbPath}`);
  let dbHandle: DbHandle;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    dbHandle = { ok: true, db: openVolliDb(dbPath) };
  } catch (error) {
    // The recorded reason is what every degraded handler answers with, so it
    // is classified here, once: a native-ABI failure names the Node
    // incompatibility and the fix instead of a bare NODE_MODULE_VERSION
    // number (VC-76).
    dbHandle = { ok: false, error: describeDbOpenFailure(error) };
    console.error("[volli] failed to open database:", dbHandle.error);
  }
  // The one Session Engine in the process, wrapped once so every durable write
  // anywhere downstream — the runtime's turns, the agent socket's commands, the
  // IPC handlers' retitles — re-publishes the affected Session's listing row to
  // every window. Wrapping HERE is what makes that claim true: this is the only
  // construction site, so there is no unwatched engine for a caller to hold.
  // See `session-control/activity-watch.ts`.
  const sessionActivityWatch =
    dbHandle.ok === true
      ? watchSessionActivity(createDesktopSessionEngine(dbHandle.db), {
          publish: broadcastSessionActivity,
        })
      : null;
  const sessionEngine = sessionActivityWatch?.engine ?? null;
  // Attachment bytes reach the renderer here (VC-50). Registered after the db
  // opens because the media type is a `blobs` column, and read through the
  // handle at request time rather than captured: a degraded db still serves
  // bytes, just as `application/octet-stream`.
  protocol.handle(BLOB_URL_SCHEME, (request) =>
    blobProtocolResponse(
      {
        blobsRoot: blobsRoot(app.getPath("userData")),
        lookupMime: (hash) => (dbHandle.ok ? getBlob(dbHandle.db, hash)?.mime : undefined),
      },
      request.url,
    ),
  );
  // Pure path joins off userData — safe to resolve well ahead of the window
  // it eventually feeds (registerTerminalIpcHandlers, further below). Moved
  // up from there so the CLI's bin dir is already known here, for the
  // execution environment factory below.
  const runtimePaths = volliRuntimePaths({
    userDataPath: app.getPath("userData"),
    appPath: app.getAppPath(),
    mainProcessDir: __dirname,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  // The shell probe began at the top of whenReady, but observing its result is
  // deferred until after the first window loads (or until a Pi execution env
  // genuinely needs it first). Both paths share this one memoized apply.
  const loginPathBootstrap = createLoginPathBootstrap({
    binDir: runtimePaths.binDir,
    readCurrentPath: () => process.env.PATH,
    writePath: (path) => {
      process.env.PATH = path;
    },
    resolveLoginPath: () => loginShellPathAttempt,
    // The second pass's shell (VC-94's A3), and deliberately the SAME one
    // detection asks: `loginShellPath()` caches the interactive answer for the
    // launch, so by the time the first window has loaded this is normally a
    // cache read rather than a spawn. Called only when `applyInteractive` runs.
    resolveInteractiveLoginPath: () => loginShellPath(),
    log: (line) => console.info(line),
  });
  /**
   * The same Session-environment measurement for agents, Settings, and project
   * onboarding. `null` means the caller has no project root — it must not turn
   * main's own cwd into a pretend workspace dependency answer.
   */
  const readSessionEnvironment = async (cwd: string | null) => {
    const outcome = await loginPathBootstrap.apply();
    const interactiveProvenance = loginPathBootstrap.interactiveProvenance();
    const report = await buildSessionEnvReport({
      // Read after apply: the bootstrap is the one writer that puts binDir
      // first even when the login shell could not be reached.
      path: process.env.PATH ?? "",
      provenance: outcome.kind,
      interactiveProvenance,
      // A host-wide read has no project dependency fact to infer from main's
      // own cwd, so the report leaves that one field unmeasured.
      cwd: cwd ?? undefined,
    });
    // `SessionEnvReport` also serves a standalone CLI fallback, where those
    // fields can be unknown. Main just ran both passes, so Settings can retain
    // their concrete facts instead of widening them to that fallback shape.
    return { ...report, provenance: outcome.kind, interactiveProvenance };
  };
  // The Pi-backed Agent Runtime is the structured product's one target
  // executor, for Ticket Sessions and ticketless project chats alike. Model
  // access and selection come from this Pi host.
  // Pi's providers and the credential store behind them, built once here so
  // signing in and running a Session share one collection. Two would be two
  // write chains over one `auth.json` — safe, since the store's lock is
  // cross-process and already survives the `pi` CLI writing alongside us, but
  // it would also mean a credential written by the login flow sat behind a
  // catalog the runtime had no reason to re-read.
  const piModelAccess = dbHandle.ok ? piOwnedModelAccess() : null;
  // Web Access: the BYO search provider, and the one credential Volli stores
  // itself. `safeStorage` is passed as the cipher rather than imported inside
  // the owner, which is what keeps that owner (and everything it decides about
  // refusing to store a key in the clear) testable outside Electron.
  const webAccess = dbHandle.ok
    ? new WebAccessSettings({
        db: dbHandle.db,
        credentials: {
          brave: new WebCredentialStore({
            db: dbHandle.db,
            cipher: safeStorage,
            secretName: BRAVE_SEARCH_KEY_SECRET,
          }),
          exa: new WebCredentialStore({
            db: dbHandle.db,
            cipher: safeStorage,
            secretName: EXA_SEARCH_KEY_SECRET,
          }),
        },
      })
    : null;
  const piRuntimeHost =
    dbHandle.ok && piModelAccess !== null
      ? createPiRuntimeHost({
          sessionDataDir: join(app.getPath("userData"), "pi-sessions"),
          models: piModelAccess.models,
          credentials: piModelAccess.credentials,
          // A turn's attachments (VC-50): materialize them into the Session's
          // tree so the agent can open any of them by path, and read images
          // back as base64 so the model can actually see them. Injected here
          // because the adapter deliberately knows nothing about the database
          // or the Blob store.
          prepareTurnAttachments: (message, owner) =>
            prepareTurnAttachments(dbHandle.db, blobsRoot(app.getPath("userData")), message, owner),
          // Read per compaction rather than captured here, for the same reason:
          // a Session outlives the Settings change that retunes it, and the
          // next compaction should run under the policy configured now.
          compactionPolicy: () => readCompactionPolicy(dbHandle.db),
          // Makes `volli` and every detected toolchain resolve inside a
          // structured Session's shell tool whether or not the background
          // install's `~/.local/bin/volli` link is reachable yet — the same
          // recovery a spawned PTY gets from `agentSessionEnv`/
          // `ticketSessionEnv` prepending this same directory
          // (`harness-runtime.ts`).
          executionEnvFactory: async (workspacePath, identity) => {
            await loginPathBootstrap.apply();
            // The Session's own name rides beside the PATH recovery:
            // `VOLLI_SESSION`/`VOLLI_TICKET` in a structured Session's shell,
            // exactly as `agentSessionEnv` exports them into a spawned PTY —
            // what lets `volli session done`/`blocked` resolve their context
            // and makes socket writes attribute to the Session (VC-51). The
            // display id is looked up per attachment, so a Ticket renamed by a
            // prefix change is right on the next attach.
            const ticket =
              identity.ticketId === null ? null : getTicket(dbHandle.db, identity.ticketId);
            const ticketProject = ticket ? getProjectById(dbHandle.db, ticket.projectId) : null;
            return piExecutionEnv(workspacePath, {
              pathPrefixes: [runtimePaths.binDir],
              identity: {
                sessionId: identity.sessionId,
                ticketDisplayId:
                  ticket && ticketProject
                    ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
                    : null,
              },
            });
          },
          // What this profile's Web Access setting amounts to, read once per
          // attachment. A profile that configured nothing answers `{}`, and a
          // Session given `{}` is offered no `web_fetch` and no `web_search` at
          // all — absent rather than present and refusing. This is the only
          // call path in the app that reads the stored key, and it hands it
          // straight to the provider constructor.
          resolveWebPorts: webAccess === null ? undefined : () => webPortsFor(webAccess.resolve()),
          // The runtime needs the Role a Session runs under and the Ticket it
          // implies, which a directory cannot say. The generated Brief is
          // recorded once before the first runtime construction; every later
          // attach reuses those exact bytes.
          resolveRuntimeContext: async (sessionId) => {
            if (sessionEngine === null) return null;
            const projection = await sessionEngine.getSession({ sessionId });
            const attaching = projection?.session;
            if (!attaching || projection.modelSelection === null) return null;
            const project = getProjectById(dbHandle.db, attaching.projectId);
            if (!project) return null;
            const provenance = {
              source: { kind: "system", id: "pi-runtime", detail: null },
              venue: { id: "local", kind: "local" },
            } as const;
            const shared = {
              projectId: project.id,
              rootThreadId: sessionRootThreadId(sessionId),
              model: projection.modelSelection,
              // The skills this Session was started with, as recorded ahead of
              // its first attachment (`SessionSkillPorts`). Read from the
              // durable record on EVERY attach — never from disk — so a
              // restart-recovery re-attach composes the same system prompt the
              // first attach did, whatever `.agents/skills/` says today.
              promptResources: recordedPromptResources(
                await sessionEngine.listEvents({ sessionId }),
              ),
            };
            // A ticketless Session is a Role, not a Ticket lookup that failed:
            // it briefs on the project root it already runs in.
            if (attaching.ticketId === null) {
              const brief = await sessionEngine.getOrRecordSessionInput({
                sessionId,
                input: { kind: "runtime-brief", text: composeProjectBrief({ project }) },
                provenance,
              });
              return {
                ...shared,
                role: "project",
                ticketId: null,
                brief: briefText(brief),
                location: "main-checkout",
              };
            }
            const ticket = getTicket(dbHandle.db, attaching.ticketId);
            if (!ticket || ticket.projectId !== project.id) return null;
            const brief = await sessionEngine.getOrRecordSessionInput({
              sessionId,
              input: {
                kind: "runtime-brief",
                text: composeTicketBrief({
                  project,
                  ticket,
                  attachments: listMaterializableLinks(dbHandle.db, null, ticket.id),
                }),
              },
              provenance,
            });
            return {
              ...shared,
              role: "ticket",
              ticketId: ticket.id,
              brief: briefText(brief),
              // The same predicate `location.ts` binds the directory on: a Ticket
              // that never took a worktree runs in the project's Main checkout.
              location: ticket.usesWorktree ? "worktree" : "main-checkout",
            };
          },
        })
      : null;
  // One store for the launch: the runtime writes and replays through it, and
  // `session peek` reads a chat Session's transcript tail through it straight
  // off the ledger, without a runtime in the middle (VC-79).
  const transcriptDirectory = join(app.getPath("userData"), "session-transcripts");
  const transcriptArtifacts = createFileTranscriptArtifactStore(transcriptDirectory);
  const sessionRuntime =
    dbHandle.ok && sessionEngine !== null && piRuntimeHost !== null
      ? createDesktopSessionRuntime({
          db: dbHandle.db,
          transcriptDirectory,
          executor: piRuntimeHost.adapter,
          sessionEngine,
          artifacts: transcriptArtifacts,
        })
      : null;
  const sessionDb = dbHandle.ok ? dbHandle.db : null;
  /**
   * How a Session start turns skills into its durable prompt resources
   * (`SessionSkillPorts`): resolve reads BOTH skill tiers — `.agents/skills/`
   * off the project's main checkout, and the personal `~/.agents/skills/`,
   * project winning a shared slug — and refuses the start when a named skill
   * is in neither;
   * index answers the metadata disclosure best-effort and only under the
   * project's own consent (`skillsAutoDisclosure`, migration 020) — consent
   * withheld, no project, no readable directory, no skills are all simply no
   * index, because a disclosure nicety must never brick a chat; record writes
   * everything resolved
   * as the Session's own input event, ahead of the first attachment, which is
   * the record `resolveRuntimeContext` composes the system prompt from ever
   * after.
   */
  const sessionSkills: SessionSkillPorts | null =
    sessionEngine !== null && sessionDb !== null
      ? {
          resolve: async (projectId, names) => {
            const project = getProjectById(sessionDb, projectId);
            if (!project) {
              throw new StructuredSessionsError(
                "SKILL_NOT_FOUND",
                "The project for this Session was not found.",
              );
            }
            const read = await loadSkills({
              projectSkillsDir: projectSkillsDir(project.path),
              globalSkillsDir: globalSkillsDir(fsDeps.homeDir),
            });
            if (!read.ok) {
              throw new StructuredSessionsError(
                "SKILL_NOT_FOUND",
                `The project's skills could not be read: ${read.error}`,
              );
            }
            // Order and dedup follow the request, not the directory: the
            // record should say what was asked for, once each.
            return [...new Set(names)].map((name) => {
              const skill = read.skills.find((candidate) => candidate.name === name);
              if (!skill) {
                throw new StructuredSessionsError(
                  "SKILL_NOT_FOUND",
                  `The skill "${name}" was not found in this project.`,
                );
              }
              return skillPromptResource(skill);
            });
          },
          index: async (projectId, injectedNames) => {
            const project = getProjectById(sessionDb, projectId);
            if (!project) return null;
            // Both tiers, always. Metadata disclosure is the Agent Skills
            // ladder's first rung -- the spec loads every skill's name and
            // description at startup -- so Volli absorbs the toolkit the user
            // installed rather than holding an opinion about it. A skill opts
            // ITSELF out through its frontmatter (`skillsIndexResource`); no
            // Volli-side switch decides for the user.
            const read = await loadSkills({
              projectSkillsDir: projectSkillsDir(project.path),
              globalSkillsDir: globalSkillsDir(fsDeps.homeDir),
            });
            if (!read.ok) return null;
            return skillsIndexResource(read.skills, injectedNames);
          },
          record: async (sessionId, resources) => {
            await sessionEngine.getOrRecordSessionInput({
              sessionId,
              input: { kind: "prompt-resources", resources },
              provenance: {
                source: { kind: "system", id: "pi-runtime", detail: null },
                venue: { id: "local", kind: "local" },
              },
            });
          },
        }
      : null;
  const sessions =
    sessionRuntime !== null &&
    piRuntimeHost !== null &&
    sessionDb !== null &&
    sessionSkills !== null
      ? createSessions({
          runtime: sessionRuntime,
          // Role in, purpose out (VC-53): a Ticket Session resolves the
          // execution default, a project chat the orchestration one, and each
          // inherits the project default when it holds no explicit choice of
          // its own — stated by `resolveDefaultModel`, never substituted.
          readDefaultModel: (role) =>
            resolveDefaultModel(
              readModelAccessDefaults(sessionDb),
              role === "ticket" ? "ticket" : "global",
            ),
          ticketBelongsToProject: (projectId, ticketId) =>
            getTicket(sessionDb, ticketId)?.projectId === projectId,
          readModelSelection: async (sessionId) =>
            (await sessionRuntime.projection({ sessionId })).projection.modelSelection,
          skills: sessionSkills,
          // Consulted only when a start carries an invocation-time model
          // override (the CLI's --model/--reasoning); the saved default was
          // validated when it was chosen.
          inspectModelAccess: () => piRuntimeHost.inspectModelAccess({}),
          // One creation path, one event (VC-13 decision 3): the renderer's
          // optimistic-open `create` (VC-16) and the agent socket's `start`
          // both mint through the same path, each carrying the actor its own
          // door derived.
          recordSessionStarted: ({ ticketId, sessionId, actor }) => {
            recordTicketEvent(
              sessionDb,
              ticketId,
              { kind: "session_started", sessionId },
              Date.now(),
              actor,
            );
          },
        })
      : null;
  const sessionRpc =
    sessionRuntime === null
      ? null
      : registerSessionRpcIpcHandlers({
          runtime: sessionRuntime,
          inspectModelAccess: piRuntimeHost?.inspectModelAccess,
          readModelAccessDefaults:
            sessionDb !== null ? () => readModelAccessDefaults(sessionDb) : undefined,
          writeModelAccessDefault:
            sessionDb !== null && piRuntimeHost !== null
              ? async (purpose, selection) => {
                  // Clearing an explicit choice needs no availability check —
                  // it resolves to the global default, which had one when saved.
                  if (selection !== null) {
                    const access = await piRuntimeHost.inspectModelAccess({});
                    assertDefaultModelAvailable(access, selection);
                  }
                  return writeModelAccessDefault(sessionDb, purpose, selection, Date.now());
                }
              : undefined,
          readHiddenModels: sessionDb !== null ? () => readHiddenModels(sessionDb) : undefined,
          writeHiddenModels:
            sessionDb !== null
              ? (hidden) => {
                  writeHiddenModels(sessionDb, hidden, Date.now());
                }
              : undefined,
          readCompactionPolicy:
            sessionDb !== null ? () => readCompactionPolicy(sessionDb) : undefined,
          writeCompactionPolicy:
            sessionDb !== null && piRuntimeHost !== null
              ? async (policy) => {
                  // Refused against the catalog before it is stored, like a
                  // default model is: a reserve the model's own window cannot
                  // hold would compact after every reply, and the only place
                  // that is legible is the control that set it.
                  if (policy.modelLimits.length > 0) {
                    const access = await piRuntimeHost.inspectModelAccess({});
                    assertCompactionLimitsUsable(access, policy.modelLimits);
                  }
                  return writeCompactionPolicy(sessionDb, policy, Date.now());
                }
              : undefined,
          createSession: sessions?.create,
          attachSession: sessions?.attach,
        });
  /**
   * Model-call titling (VC-81): the one main-side hook both doors feed.
   *
   * The ladder itself is stated once in `@volli/shared`
   * (`resolveAutoTitleModel`); this only supplies the three rungs it reads
   * and the doors that run it. Absent with any of its three dependencies
   * (the same rule as `sessions` above), which reads as pure heuristic
   * titling: the shipped fallback.
   */
  const autoTitler =
    sessionEngine !== null && sessionDb !== null && piRuntimeHost !== null
      ? createAutoTitler({
          readSession: async (sessionId) => {
            const projection = await sessionEngine.getSession({ sessionId });
            if (projection === null) return null;
            return {
              title: projection.session.title,
              ticketId: projection.session.ticketId,
              model: projection.modelSelection,
            };
          },
          // Read per refinement, not captured: a Session outlives the Settings
          // change that retunes it, and the next title should run under the
          // policy configured now. One read serves all three rungs.
          readModelDefaults: () => readModelAccessDefaults(sessionDb),
          // What the Session is work ON. The CLI door's stock kickoff names no
          // work at all, so without this a Ticket Session's title could only
          // ever be the heuristic's "Work on VC-81".
          readTicket: (ticketId) => getTicketBrief(sessionDb, ticketId) ?? null,
          inspectModelAccess: ({ signal }) => piRuntimeHost.inspectModelAccess({ signal }),
          completeUtility: (input) => piRuntimeHost.completeUtility(input),
          retitle: async (sessionId, title) => {
            const submitted = await sessionEngine.submit({
              commandId: randomUUID(),
              sessionId,
              intent: { kind: "session.retitle", title },
              provenance: {
                source: { kind: "system", id: "auto-title", detail: null },
                venue: { id: "local", kind: "local" },
              },
            });
            if (submitted.receipt?.status !== "completed") {
              throw new Error("Session retitle was not completed");
            }
            // Tell the windows. `session.retitle` reaches the ledger without
            // the runtime publish, and no renderer moved a label on the way
            // in (the CLI door has no window at all), so this is the only
            // thing that makes the model's title appear before an unrelated
            // refresh happens to re-read the projection.
            broadcastSessionRetitled(sessionId, title);
          },
        })
      : null;
  // No runtime, no bridge — but the channels are still claimed, answering
  // every request with the reason the runtime is down (in practice: the
  // database open recorded above, Node-ABI classification included). Left
  // unregistered, the renderer's Model Access page would toast Electron's
  // nameless "No handler registered" instead of the actual problem (VC-76).
  if (sessionRuntime === null) {
    registerDegradedSessionRpcIpcHandlers(
      dbHandle.ok
        ? "The agent runtime is unavailable."
        : `The local database failed to open: ${dbHandle.error}`,
    );
  }
  // Signing in is a Model Access task, not a Session one, so it gets its own
  // surface rather than a Session RPC namespace — see the contract in
  // `@volli/shared`'s VolliModelAccessIpcContract for why a channel that can
  // carry an API key stays off the instrumented, log-tapped one.
  registerModelAccessIpcHandlers(
    piModelAccess === null
      ? null
      : new ModelAccessSignInService({ pi: piSignIn(piModelAccess.models) }),
    // When the runtime is down because the database never opened, the sign-in
    // surface must answer with the recorded (already-classified) reason — a
    // Node-ABI failure names the incompatibility, not a generic "unavailable"
    // (VC-76).
    dbHandle.ok
      ? undefined
      : `Sign-in is unavailable — the local database failed to open: ${dbHandle.error}`,
  );
  // The Web Access surface, on its own door beside sign-in and for the same
  // reason: one of its arguments is an API key.
  registerWebAccessIpcHandlers(
    webAccess,
    dbHandle.ok
      ? undefined
      : `Web access settings are unavailable — the local database failed to open: ${dbHandle.error}`,
  );
  // From this point onward the native Session control plane exists. Install
  // its quit hold before the first later startup await so a Dock/OS quit cannot
  // reach the socket-only will-quit fallback and strand these resources. The
  // coordinator waits until the current before-quit dispatch finishes before
  // reading refusals, so the destructive-work gates registered below still win.
  registerAcceptedQuitCoordinator({
    lifecycle: app,
    shutdownNativeSessions: async () => {
      const results = await Promise.allSettled([sessionRpc?.close(), sessionRuntime?.close()]);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[volli] failed to close native Session RPC:", errorMessage(result.reason));
        }
      }
    },
    shutdownAgentSocket,
    reportFailure: (error) => {
      console.error("[volli] failed to coordinate app shutdown:", errorMessage(error));
    },
  });
  // Boot recovery: no PTY and no OpenCode binding survives a relaunch. The
  // durable Session itself intentionally remains open; only the binding ends.
  if (dbHandle.ok && sessionEngine !== null) {
    try {
      await closeStaleAttachments({
        engine: sessionEngine,
        projectIds: listProjects(dbHandle.db).map((project) => project.id),
        newId: randomUUID,
        now: Date.now,
        onError: (attachmentId, error) => {
          console.error(
            `[volli] failed to recover attachment ${attachmentId}:`,
            errorMessage(error),
          );
        },
      });
    } catch (error) {
      console.error("[volli] failed to recover stale attachments:", errorMessage(error));
    }
  }
  // Reclaim attachment bytes nothing points at any more (VC-50) — a detached
  // file, or an abandoned new-Ticket composer draft, which attaches eagerly and
  // so leaves an unlinked Blob whenever a draft is thrown away. Housekeeping, so
  // it runs at boot rather than on the user's turn, and a failure is logged
  // rather than raised: garbage left behind is a disk cost, never a broken app.
  //
  // EXCEPT what a still-stored new-Ticket draft names (VC-137): the draft
  // persists its attachment strip like it persists the words, so those Blobs
  // are a persisted attachment waiting for their Ticket, not garbage. Reading
  // the raw app_state row here — the renderer owns that envelope's shape, and
  // `draftAttachmentHashes` reads it defensively enough that a malformed row
  // can at worst leak bytes until the draft is fixed or cleared.
  if (dbHandle.ok) {
    try {
      const retained = new Set(
        draftAttachmentHashes(getAllAppState(dbHandle.db)[NEW_TICKET_DRAFT_APP_STATE_KEY]),
      );
      const { collected } = collectUnlinkedBlobs(
        dbHandle.db,
        blobsRoot(app.getPath("userData")),
        retained,
      );
      if (collected.length > 0) {
        console.info(`[volli] collected ${collected.length} unreferenced attachment(s)`);
      }
    } catch (error) {
      console.error("[volli] failed to collect unreferenced attachments:", errorMessage(error));
    }
  }
  // Read fresh per call rather than once at boot: `activate` can re-create the
  // window, and the user can flip the mode, long after this point.
  const currentFirstPaint = (): FirstPaintHint => {
    const systemPrefersDark = nativeTheme.shouldUseDarkColors;
    const blank = { hint: null, canvas: null, appearance: null, systemPrefersDark };
    if (!dbHandle.ok) return resolveFirstPaint(blank);
    try {
      return resolveFirstPaint({
        hint: getFirstPaintHint(dbHandle.db),
        canvas: getGlobalCanvas(dbHandle.db),
        appearance: getGlobalAppearance(dbHandle.db),
        systemPrefersDark,
      });
    } catch (error) {
      // Never fatal: a window with a slightly-wrong edge color beats no window.
      console.warn("[volli] failed to read the stored canvas:", errorMessage(error));
      return resolveFirstPaint(blank);
    }
  };
  // The one answer to "what mode is the app in?" that main has, shared by the
  // window edge and by every ghostty chain read — a `theme = light:X,dark:Y`
  // pair resolves to a different half in each.
  const currentAppearance = (): ResolvedAppearance => currentFirstPaint().appearance;
  // Ghostty config read + live-reload watch, feeding restty's appearance. The
  // `userData` root is where Volli's own ghostty OVERLAY files live (decision
  // #67). Registered after the db opens because the chain read needs the
  // resolved mode, which lives in `app_state`.
  registerGhosttyConfigIpc(fsDeps, currentAppearance);
  // Assigned once registerTerminalIpcHandlers runs below; the worktree
  // remove/orphan-delete guards read it lazily (only at invoke time, long after
  // boot) to refuse touching a directory a live session still runs in.
  let ptyManagerRef: PtyManager | undefined;
  // The ONE interrupt entry both choke points (renderer `volli:ticket-move`
  // IPC, socket `ticket.move`) inject: Escs the ticket's live agent sessions
  // and, when any were actually interrupted, announces it to every window
  // (issue #78 — automation de-escalates, but never silently). Lazy through
  // the ref: registration below runs before the PtyManager is built, but the
  // seam only ever fires at invoke time, long after boot.
  const interruptTicketSessionsAnnounced = async (ticketId: string): Promise<string[]> => {
    let sessionIds: string[] = [];
    try {
      sessionIds = (await ptyManagerRef?.interruptTicketSessions(ticketId)) ?? [];
    } catch (error) {
      console.error(`[volli] failed to interrupt ticket ${ticketId}:`, errorMessage(error));
    }
    if (sessionIds.length > 0) broadcastSessionsInterrupted(ticketId, sessionIds);
    return sessionIds;
  };
  /**
   * Where work is genuinely in flight in `target` right now, for the
   * destructive worktree guards. The two surfaces answer differently ON PURPOSE.
   *
   * A live PTY holds its cwd whatever it is doing: a shell whose directory was
   * deleted underneath it is broken whether or not anything was running in it.
   * Every live cwd is reported, unfiltered, and the guard does the containment.
   *
   * An agent binding does not. It opens on attach and is dropped only by an
   * explicit release, by the executor closing itself, or by app shutdown, so it
   * survives an idle chat and outlives the tab that opened it — reading its mere
   * existence as "busy" is what made a ticket with one empty chat in it
   * permanently unarchivable, with nothing the user could close to clear it. So
   * a binding counts only while its Session has a turn open, which is the same
   * `turnActive` the Session listing reads to call a chat "working"
   * (session-control/chat-attachment.ts). A turn that is open but blocked on a
   * question still counts: the loop is suspended inside it and resumes writing
   * into that directory the moment it is answered.
   *
   * That read is scoped to `target` before any projection is loaded, which is
   * why the parameter exists (worktree/agent-sites.ts): asking it of every open
   * binding costs one durable projection each, and past the runtime's own cache
   * limit one gate check evicts and replays the ledger of the Session the live
   * chat is reading.
   *
   * A Session whose history cannot be read leaves its binding OUT — the
   * fail-open stance the renderer's busy probe already takes (though not the
   * same KIND of thing: `remove-project-dialog.tsx` only decorates a dialog with
   * a warning and never blocks, so it is a precedent for the stance, not for the
   * gate). The reason is the one that matters: a ticket nothing can ever archive
   * is the worse failure.
   *
   * Be precise about what that costs, because it is not uniform across the
   * paths. A NON-FORCED remove re-checks cleanliness right before deleting, so
   * an unreadable Session cannot lose uncommitted work there. The other two
   * destroy paths do not re-check, and both are explicitly confirmed: `force:
   * true` means the user read a dialog naming the dirtiness and said yes, and
   * Settings → Worktrees → delete is the same act on an orphan — that list holds
   * ONLY dirty orphans (the sweep already removed the clean ones), each row
   * printing its own dirtiness reason behind a confirm, so a cleanliness gate
   * there would refuse every row and leave no way to clear one. So the residual
   * exposure is: history unreadable AND a turn open AND the user confirming a
   * destructive action against a directory already described to them as dirty.
   *
   * The gate is also not the last line. Whatever it lets through, the destroy
   * then RELEASES every binding rooted at the path before deleting it, so a turn
   * that started inside the gap between this read and the delete is stopped and
   * recorded rather than having its directory pulled out from under it.
   */
  const busyWorktreeSites = async (target: string): Promise<readonly BusyWorktreeSite[]> => {
    const sites: BusyWorktreeSite[] = (ptyManagerRef?.liveSessionCwds() ?? []).map((directory) => ({
      directory,
      surface: "terminal",
    }));
    if (sessionRuntime === null) return sites;
    const turnOpen = await agentTurnOpenWithin(sessionRuntime, target, (sessionId, error) => {
      console.warn(`[volli] could not read Session ${sessionId}:`, errorMessage(error));
    });
    return turnOpen ? [...sites, { directory: target, surface: "agent" }] : sites;
  };
  /**
   * Ends every structured binding rooted at a directory that is about to stop
   * existing (`worktree/agent-sites.ts` carries the reasoning).
   *
   * Best-effort by design: a binding that refuses to close must not make the
   * worktree unremovable, which is the failure the busy gate above was rewritten
   * to end. What survives is logged here rather than swallowed, and the Session
   * it belongs to is the one surface that can still say so — its next dispatch
   * fails against the missing path and reports it in the chat.
   */
  const releaseAgentSites = async (directory: string): Promise<AgentSiteReleaseReport> => {
    if (sessionRuntime === null) return { released: [], stillOpen: [] };
    const report = await releaseWorktreeAgentSites(sessionRuntime, directory, {
      newCommandId: randomUUID,
      onError: (sessionId, error) => {
        console.error(
          `[volli] could not release Session ${sessionId} from ${directory}:`,
          errorMessage(error),
        );
      },
    });
    for (const sessionId of report.stillOpen) {
      console.error(
        `[volli] Session ${sessionId} is still bound to ${directory}, which is being deleted`,
      );
    }
    return report;
  };
  // Standard macOS menu, but with the View-menu zoom roles replaced by
  // renderer-driven CSS zoom (see menu.ts for the rationale). Registered here
  // (rather than up with the other pre-window setup) because File > Export
  // Database needs `dbHandle`, which doesn't exist yet at that point.
  registerDataIpcHandlers(dbHandle, {
    sessionEngine: sessionEngine ?? undefined,
    busyWorktreeSites,
    releaseAgentSites,
    // Backward-move interrupt (issue #78): a user move that leaves the active
    // columns Esc's the ticket's live agent sessions, announced via toast.
    interruptTicketSessions: interruptTicketSessionsAnnounced,
    // Where attachment bytes live (VC-50) — the same root the volli-blob:
    // protocol serves from and materialization copies out of.
    blobsRoot: blobsRoot(app.getPath("userData")),
    // The renderer door of auto-titling (VC-81); absent with the runtime.
    autoTitle: autoTitler === null ? undefined : (input) => void autoTitler.refine(input),
  });
  // Global-artifacts + @file fs plumbing (file index/read/write, artifact
  // create, reveal, per-tab watch) plus the composer `/` picker's prompt
  // templates; same degraded-DB stance as registerDataIpcHandlers.
  registerFileIpcHandlers(dbHandle, {
    globalCommandsDir: join(fsDeps.userDataDir, "commands"),
    globalSkillsDir: globalSkillsDir(fsDeps.homeDir),
  });
  // Theming: resolved state, global theme, per-project override, and the
  // ghostty overlay write path. Same degraded-DB stance as the two above; the
  // `userData` root is where Volli's overlay files live (never the user's own
  // ghostty config — decision #67).
  //
  // The window background follows the global theme: every window repaints its
  // edge the moment the theme is persisted, so a resize right after a theme
  // change can't reveal the previous palette.
  registerThemeIpcHandlers(
    dbHandle,
    { fs: fsDeps, now: Date.now, appearance: currentAppearance },
    {
      // The renderer has already run the whole pipeline, so main takes the color
      // it actually painted rather than re-deriving one and hoping the two
      // agree. No try/catch — there is nothing here to fail.
      onFirstPaintChanged: (paint) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.setBackgroundColor(paint.background);
        }
      },
    },
  );
  // The OTHER half of `auto`: the system flipping while the app is running.
  // Only main can see it — the renderer's `prefers-color-scheme` query resolves
  // against the `color-scheme` this app stamps, so it reports the mode already
  // painted and never changes on its own. Every window hears about the flip and
  // re-resolves; a scope on an explicit light or dark ignores it, which is a
  // question only the renderer can answer for the scope it is showing.
  // `currentAppearance` above needs no such wiring: it reads `nativeTheme`
  // fresh on every call already.
  nativeTheme.on("updated", () => {
    broadcastSystemAppearance(nativeTheme.shouldUseDarkColors);
  });
  // Boots the PTY multiplexer (persists a durable record per session) and its
  // before-quit teardown (kills all PTYs, gated on busy sessions); needs the
  // db, so it registers here. The returned manager feeds each window's own
  // destructive-close gate.
  // Create the window first so first paint isn't blocked on shim generation or
  // the socket bind; both start right after, still awaited inside whenReady with
  // the same failure semantics (logged, non-fatal). registerTerminalIpcHandlers
  // needs only runtimePaths (a pure join), so it can precede the window it feeds.
  // Mutable on purpose: `harnessEnv`, `wrapperPaths` and `adapters` are filled in once the
  // wrappers have been generated (below, after the shim they call back through
  // exists), and the manager reads this object per spawn rather than copying
  // it. A session created in the window before then simply launches unwrapped —
  // which is the Known tier, already a state the session header can state.
  const agentRuntime: AgentRuntimeEnvironment = {
    socketPath: runtimePaths.socketPath,
    binDir: runtimePaths.binDir,
  };
  /** Wrappers refused this launch because the name would shadow a system tool. */
  let harnessRuntimeRefused: RefusedWrapper[] = [];

  /**
   * Every harness this host should be treated as having, and how sure we are of
   * it: the built-ins the user's login shell can actually resolve, plus the
   * manifests the user has registered and confirmed the bytes of.
   *
   * One answer, computed per pass and shared by everything that acts on "which
   * harnesses exist" — the wrappers and the skill pack. Two independent
   * derivations would eventually disagree, and the disagreement would look like
   * a harness with a wrapper but no skill, or the reverse.
   *
   * `registered` comes back separately because removal spans more than
   * existence does: uninstall has to name every harness that could have left
   * files behind, not only the ones present now.
   */
  const resolveHostAdapters = async (): Promise<{
    adapters: HarnessAdapter[];
    registered: readonly HarnessAdapter[];
    census: "complete" | "partial";
  }> => {
    // The user's login-shell PATH, not main's: a Dock launch inherits launchd's
    // four directories, where no harness has ever been installed. `null` means
    // the shell could not be asked, which is why it reaches the census below
    // rather than being flattened into an empty list.
    const detected = await detectHarnesses();
    // A registered manifest joins this set exactly as a built-in does — and only
    // once someone confirmed the bytes it is made of, which is why every
    // manifest is re-read and re-hashed here rather than trusted because it was
    // trusted last launch.
    const registered = dbHandle.ok
      ? trustedHarnessAdapters(
          decideRegisteredHarnesses(
            dbHandle.db,
            (await scanHarnessManifests(harnessesDir)).manifests,
          ),
        )
      : [];
    return {
      adapters: [
        ...(detected ?? [])
          .map((id) => getHarnessAdapter(id))
          .filter((adapter) => adapter !== undefined),
        ...registered,
      ],
      registered,
      // Both halves have to have run before an absent harness means an absent
      // harness: detection answers for the built-ins, the db for the registered
      // manifests.
      census: detected !== null && dbHandle.ok ? "complete" : "partial",
    };
  };

  /**
   * Regenerates every generated thing the harness runtime owns: the wrappers,
   * their per-harness config files, and the shell integration. Runs at boot and
   * again behind `volli doctor --fix` — idempotent by construction, which is
   * what lets `--fix` be offered without a confirmation.
   */
  const regenerateHarnessRuntime = async (): Promise<void> => {
    const host = await resolveHostAdapters();
    const runtime = await ensureHarnessRuntime({
      binDir: runtimePaths.binDir,
      harnessRoot: runtimePaths.harnessRoot,
      socketPath: runtimePaths.socketPath,
      shimPath,
      adapters: host.adapters,
      adapterCensus: host.census,
      // The same walk the wrapper does at run time, so a manifest whose command
      // would shadow a system tool is refused a wrapper rather than silently
      // put in front of it.
      resolveCommand: async (command) => {
        const pathValue = await loginShellPath();
        return pathValue === null ? null : resolveOnPath(pathValue, command, runtimePaths.binDir);
      },
    });
    agentRuntime.harnessEnv = runtime.env;
    // Where each wrapper landed, so a launch line names it by absolute path
    // instead of trusting a PATH the session's login shell rebuilds.
    agentRuntime.wrapperPaths = runtime.wrapperPaths;
    // And what each of those wrappers is fronting, off this same pass: a launch
    // line needs the harness's own prompt flag and resume argv, and a registered
    // manifest's are knowable nowhere but here.
    agentRuntime.adapters = host.adapters;
    harnessRuntimeRefused = runtime.refused;
    // And the other half: the startup chain that puts binDir back in front
    // after the user's own shell startup, so a harness the user types by hand
    // reaches the wrapper too.
    agentRuntime.shellEnv = await ensureShellInit({
      zdotDir: runtimePaths.zdotDir,
      binDir: runtimePaths.binDir,
      shellPath: resolveShell(process.env).file,
      // Both, because a Volli launched from a shell Volli already wrapped
      // inherits its OWN ZDOTDIR — `pnpm dev` in a Volli terminal, a relaunch —
      // and the user's real one survives only in VOLLI_USER_ZDOTDIR.
      inheritedZdotDir: process.env["ZDOTDIR"],
      inheritedUserZdotDir: process.env[VOLLI_USER_ZDOTDIR_ENV],
    });
  };

  ipcMain.on(
    "volli:unsaved-documents" satisfies VolliIpcChannel,
    (_event, ...args: unknown[]): void => {
      recordUnsavedDocuments(args[0]);
    },
  );
  // Asked ahead of the terminal gate: a discarded draft is the only thing on
  // the quit path that cannot be recovered afterwards. The accepted-quit
  // coordinator registered above only holds the event synchronously; it defers
  // teardown until this gate and the terminal gate have recorded their verdict.
  app.on("before-quit", (event) => {
    if (quitAlreadyRefused(event)) return;
    // An accepted update install already carried the unsaved-drafts warning in
    // its own dialog (VC-59's one-prompt decision) — asking again here would
    // stack a second modal on an answer the user has given.
    if (updateInstallQuitInFlight()) return;
    const names = unsavedDocumentNames();
    const step = planUnsavedQuit({
      names,
      skipConfirm: process.env["VOLLI_SKIP_CLOSE_CONFIRM"] === "1",
    });
    if (step === "confirm" && !confirmDiscardUnsaved(names, "Quit")) refuseQuit(event);
  });

  const ptyManager = registerTerminalIpcHandlers(dbHandle, agentRuntime, sessionEngine);
  ptyManagerRef = ptyManager;
  const mainWindow = createWindow(ptyManager, currentFirstPaint());
  mainWindow.webContents.once("did-finish-load", () => {
    // The probe converts shell failure to a kept outcome. Keep an explicit
    // rejection handler here too so an unexpected mutation/logging failure
    // can never become an unhandled rejection from this fire-and-forget path.
    void loginPathBootstrap.apply().catch((error) => {
      console.error("[volli] failed to apply login PATH:", errorMessage(error));
    });
    // The second, INTERACTIVE pass (VC-94's A3), which is what recovers the
    // directories a user's `.zshrc` exports — nvm, bun, rbenv, pyenv, mise.
    // Here rather than on the boot path because an rc file may prompt, and a
    // prompt before the first window is a hang nobody can answer; here rather
    // than awaited because nothing may wait on it. If it wedges for its whole
    // timeout, the app is exactly as usable as it was before this existed.
    void loginPathBootstrap.applyInteractive().catch((error) => {
      console.error("[volli] failed to apply interactive login PATH:", errorMessage(error));
    });
  });

  // Startup orphan sweep (worktree-support §7): prunes stale git metadata and
  // removes clean orphaned worktree dirs that THIS database owns and that
  // nothing has touched for the retention window (branches retained — VC-113
  // scoped both the ownership and the timing); dirty orphans are
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
            `[worktree] sweep: pruned=${report.pruned.length} removedClean=${report.removedClean.length} keptRecent=${report.keptRecent.length} dirty=${report.dirty.length}`,
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
    // The reclaim seams (VC-113) are handed over here because this is the only
    // scope that can answer them — the same two the destructive IPC guards use,
    // so an automatic removal refuses everything a manual one would.
    const retention = getRetentionWatcher(db, { busyWorktreeSites, releaseAgentSites });
    mainWindow.webContents.once("did-finish-load", () => retention.start());
    app.on("browser-window-focus", () => retention.triggerNow());
  }

  // Auto-update (VC-24): packaged builds poll GitHub Releases ~30s after
  // boot and every ~4h after, download in the background, and install on
  // quit (Squirrel.Mac applies the staged update at the next launch) — one
  // native notification per downloaded version, failures only ever log.
  // Wired OUTSIDE the dbHandle.ok block: a broken db must not also strand
  // the install on a stale build (an update may well be what fixes it), so
  // that case just falls back to the default prerelease policy (off).
  const autoUpdate = startAutoUpdate({
    isPackaged: app.isPackaged,
    updater: autoUpdater,
    allowPrerelease: dbHandle.ok ? readAllowPrerelease(dbHandle.db) : false,
    currentVersion: app.getVersion(),
    notify: (title, body) => new Notification({ title, body }).show(),
    log: (line) => console.info(line),
    onStateChange: broadcastUpdateState,
    // The double-notify guard: with a window open the sidebar badge/dialog
    // owns the "downloaded" announcement; the native notification only speaks
    // when no window is left to show it (macOS keeps the app alive).
    hasUpdateSurface: () =>
      BrowserWindow.getAllWindows().some((window) => !window.webContents.isDestroyed()),
  });
  // The sidebar's door onto that updater (VC-59) — same guarded invoke
  // surface as everything else, and like startAutoUpdate itself deliberately
  // OUTSIDE dbHandle.ok: the update UI must survive exactly the broken-db
  // case the updater was built to survive. The live-work readers answer from
  // what exists this launch — no session runtime truthfully means no open
  // agent turns.
  registerUpdateIpcHandlers({
    update: autoUpdate,
    busyCommands: () => ptyManager.busySessions().map((busy) => busy.process),
    openAgentTurns: () =>
      sessionRuntime === null
        ? Promise.resolve(0)
        : countOpenAgentTurns(sessionRuntime, (sessionId, error) => {
            console.warn(`[volli] could not read Session ${sessionId}:`, errorMessage(error));
          }),
    unsavedDrafts: unsavedDocumentNames,
    beginInstall: beginAcceptedUpdateInstall,
    abandonInstall: abandonAcceptedUpdateInstall,
  });

  let shimPath = join(runtimePaths.binDir, "volli");

  // The File → Remove tombstone (VC-52). Install is background and has no
  // opt-out, so an EXPLICIT removal must leave something behind that the next
  // boot honors — otherwise File → Remove would be silently undone at relaunch.
  // Cleared by File → Install. The old consent key (`volli:agent-tools-consent`)
  // is deliberately ignored: "deferred" was a first-boot dialog answer that
  // latched forever, which is the failure this ticket removes.
  const agentToolsRemovedKey = "volli:agent-tools-removed";
  const agentToolsRemoved = (): boolean =>
    dbHandle.ok && getAllAppState(dbHandle.db)[agentToolsRemovedKey] === "true";

  // The skill installer targets the real OS home via app.getPath("home"), which
  // on macOS ignores $HOME — so a
  // headless installer-idempotency e2e cannot redirect it into a throwaway
  // profile. VOLLI_AGENT_HOME overrides the install/refresh/uninstall home for
  // exactly that. Unset in production, so the real home is used unchanged.
  const agentToolsHome =
    (isDev ? process.env["VOLLI_AGENT_HOME"] : undefined) ?? app.getPath("home");
  // The one other shim this install may claim a link from: the packaged app
  // repoints a dev profile's link (the dev shim dies with its checkout), never
  // the reverse — a dev boot must not steal the install the user actually uses.
  const managedSiblingShims: readonly string[] = isDev
    ? []
    : [join(dirname(app.getPath("userData")), `${app.getName()}-dev`, "bin", "volli")];

  const harnessesDir = join(agentToolsHome, ".agents", "harnesses");

  // The confirmation a registered manifest is inert without (harness-events
  // §Trust). Registered HERE, before the socket and shim work below, because
  // everything after this point is awaited: a channel that only exists once
  // that settles is a channel the renderer can `invoke()` into a hang.
  //
  // Both seams read their inputs at CALL time, not now. `shimPath` is still the
  // default above and is reassigned once the shim is generated, and the login
  // PATH is resolved on first use (and cached for the launch) rather than
  // costing a shell startup during boot.
  registerHarnessIpcHandlers(dbHandle, {
    harnessesDir,
    // The same walk the generated wrapper does at run time, Volli's own bin dir
    // skipped — the confirmation must name the harness, never our wrapper.
    resolveBinary: async (command) => {
      const pathValue = await loginShellPath();
      return pathValue === null ? null : resolveOnPath(pathValue, command, runtimePaths.binDir);
    },
    launchArgv: (adapter) =>
      harnessLaunchArgv(adapter, {
        harnessRoot: runtimePaths.harnessRoot,
        socketPath: runtimePaths.socketPath,
        shimPath,
      }),
    // A recorded verdict is inert on its own: until the wrappers, configs and
    // shell chain are rebuilt from it, the harness the user just approved
    // launches unconfigured and reports nothing.
    regenerateRuntime: regenerateHarnessRuntime,
    // What the last regeneration actually resolved, read at CALL time for the
    // same reason the manager's `adapterFor` is: this is filled in once the
    // wrappers exist, and it is what the launch door checks a kickoff against.
    // Answering the renderer off a fresh disk scan instead would let the picker
    // offer a harness the launch would then refuse.
    launchableHarnesses: () => agentRuntime.adapters ?? [],
    now: Date.now,
  });

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
      message: "You edited some skill files, so Volli left them alone.",
      detail,
    });
  };

  /**
   * The whole CLI + skills install, user-space and dialog-free (VC-52): the
   * `~/.local/bin/volli` link, best-effort cleanup of the retired admin-owned
   * `/usr/local/bin` link, the hash-guarded skill pack, and — when the login
   * shell is zsh and cannot already reach `~/.local/bin` — the managed PATH
   * block in `~/.zprofile`. Idempotent by construction: boot runs it every
   * launch, the File menu re-runs it on demand, and doctor's Fix rides it.
   * The ONLY dialog it can raise is the conflict warning for managed files the
   * user hand-edited — which is a preservation notice, not a prompt.
   */
  const installAgentToolsQuietly = async (): Promise<void> => {
    const link = await ensureUserCliLink({
      home: agentToolsHome,
      shimPath,
      managedTargets: managedSiblingShims,
    });
    if (link.state === "kept") {
      // Never clobber a name that is not ours; the CLI pane states this.
      console.warn(
        `[volli] ${userCliLinkPath(agentToolsHome)} is not Volli's (→ ${link.target ?? "a regular file"}); left alone`,
      );
    }
    const legacy = await cleanupLegacyGlobalCliLink({
      shimPath,
      managedTargets: managedSiblingShims,
    });
    if (legacy === "kept") {
      console.info(
        "[volli] legacy /usr/local/bin/volli link left in place (admin-owned; ~/.local/bin shadows it)",
      );
    }
    // The same set the wrappers are generated from, so a registered manifest's
    // declared surfaces earn it the skill pack the moment it is trusted —
    // there is no second notion here of which harnesses this host has.
    const skills = await installHarnessSkills({
      home: agentToolsHome,
      adapters: (await resolveHostAdapters()).adapters,
    });
    let conflicts = skills.conflicts;
    try {
      // PATH wiring is zsh-only (like the shell chain); the CLI pane names the
      // limitation for other shells rather than writing a profile they never read.
      if (basename(resolveShell(process.env).file) === "zsh") {
        const wired = await ensureUserBinOnPath({
          home: agentToolsHome,
          loginPath: await loginShellPath(),
        });
        conflicts = [...conflicts, ...wired.conflicts];
      }
    } finally {
      // In a `finally` so a profile-write failure (say, a symlinked ~/.zprofile
      // the managed-write engine refuses) cannot swallow the skill conflicts
      // collected above — those are preservation notices the user must see
      // regardless of what the PATH step did. The error still propagates.
      if (conflicts.length > 0) {
        await showSkillConflictWarning(conflicts);
      }
    }
  };

  /**
   * Doctor's explicit repair is the one place a stale PATH answer may be
   * discarded on purpose. The installer can write `~/.zprofile`; resetting
   * only after it finishes makes the two fresh probes describe that new shell,
   * rather than preserving the answer that justified the write.
   */
  const repairSessionEnvironment = async (): Promise<SessionEnvRepair> => {
    if (dbHandle.ok && agentToolsRemoved()) {
      // A repair is an explicit request for working tools. Lift suppression
      // before touching the filesystem, or fail instead of leaving an install
      // present on disk yet silently skipped on every later boot.
      setAppState(dbHandle.db, agentToolsRemovedKey, "false", Date.now());
    }
    await regenerateHarnessRuntime();
    await installAgentToolsQuietly();
    resetLoginShellPathCache();
    return loginPathBootstrap.repair(
      () => probeLoginShellPath(ADOPTION_PROBE),
      () => loginShellPath(),
    );
  };

  // Menu action: the same quiet installer, but loud about failure (a click
  // deserves an answer) — and it clears the removal tombstone, which is the
  // one thing that distinguishes "install again" from every boot's refresh.
  const installAgentTools = async (): Promise<void> => {
    if (dbHandle.ok) {
      try {
        setAppState(dbHandle.db, agentToolsRemovedKey, "false", Date.now());
      } catch (error) {
        dialog.showErrorBox("Agent Tools Installation Failed", errorMessage(error));
        throw error;
      }
    }
    try {
      await installAgentToolsQuietly();
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Installation Failed",
        `Installing the Volli CLI and agent skills failed: ${errorMessage(error)}`,
      );
      throw error;
    }
  };

  // Menu action: confirm, remove every harness's managed files (hand-edited
  // ones survive via the uninstall hash guard), drop the ~/.local/bin link and
  // the managed PATH block only if they are still ours, then set the removal
  // tombstone so the next boot does NOT silently reinstall what this just
  // removed. Uninstall stays explicit and loud; every failure has a dialog.
  const uninstallAgentTools = async (): Promise<void> => {
    // The PATH line is named only where one can exist: it is written for zsh
    // alone, so promising its removal on another shell would be removal copy
    // describing work this host never had.
    const managesZprofile = basename(resolveShell(process.env).file) === "zsh";
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Remove the Volli CLI and agent skills?",
      detail: `Removes the bundled skill pack and the ~/.local/bin/volli link${managesZprofile ? ", and Volli's PATH line in ~/.zprofile" : ""}. Files you edited yourself stay. Volli won't reinstall these unless you choose Install from the File menu.`,
      buttons: ["Remove", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirm.response !== 0) return;

    let removal;
    try {
      // Removal spans wider than existence: every built-in, whether or not it is
      // installed today, plus every trusted manifest — a harness the user has
      // since uninstalled still has Volli's files sitting in its dotfiles.
      removal = await uninstallAllHarnessSkills({
        home: agentToolsHome,
        adapters: [...harnessAdapters, ...(await resolveHostAdapters()).registered],
      });
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Removal Failed",
        `Removing the agent skill pack failed: ${errorMessage(error)}`,
      );
      return;
    }
    let pathRemoval: HarnessUninstallResult;
    let linkRemoved: boolean;
    let legacyOutcome: "removed" | "kept" | "absent";
    try {
      // The PATH block first (it is excised, never destroyed), then the link.
      pathRemoval = await removeUserBinPathBlock(agentToolsHome);
      linkRemoved = await removeUserCliLinkIfOurs({
        home: agentToolsHome,
        shimPath,
        managedTargets: managedSiblingShims,
      });
      // Best-effort, unprivileged: the retired admin-owned link usually
      // survives (root-owned dir) — the CLI pane reports it truthfully.
      legacyOutcome = await cleanupLegacyGlobalCliLink({
        shimPath,
        managedTargets: managedSiblingShims,
      });
    } catch (error) {
      dialog.showErrorBox(
        "Agent Tools Removal Failed",
        `Removing the volli CLI link failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (dbHandle.ok) {
      try {
        setAppState(dbHandle.db, agentToolsRemovedKey, "true", Date.now());
      } catch (error) {
        dialog.showErrorBox("Agent Tools Removal Failed", errorMessage(error));
        return;
      }
    }
    // The count spans everything this removal touched — the skill plan, the
    // PATH block, the user-space link, and (rarely) the legacy link — so the
    // summary neither undercounts the work nor claims files it kept.
    const preserved = [...removal.preserved, ...pathRemoval.preserved];
    const removedCount =
      removal.removed.length +
      pathRemoval.removed.length +
      (linkRemoved ? 1 : 0) +
      (legacyOutcome === "removed" ? 1 : 0);
    const preservedNote =
      preserved.length > 0 ? `\n\nKept, because you edited them:\n${preserved.join("\n")}` : "";
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      message: "Volli CLI and agent skills removed.",
      detail: `Removed ${removedCount} item(s).${preservedNote}`,
    });
  };

  registerAppMenu(dbHandle, { installAgentTools, uninstallAgentTools });

  // Settings → CLI (VC-52): the detection surface over the silent install, and
  // the in-app doctor. Registered before the awaited socket work below for the
  // same reason the harness-trust channels are: a channel that only exists
  // once boot settles is a channel the renderer can `invoke()` into a hang.
  // Every dep reads at CALL time — `shimPath` and the wrapper set are
  // reassigned once generation runs.
  registerCliIpcHandlers({
    status: (input) =>
      readCliStatus(
        {
          home: agentToolsHome,
          shimPath: () => shimPath,
          managedTargets: managedSiblingShims,
          socketPath: runtimePaths.socketPath,
          socketLive: () => agentSocket.live(),
          loginShellPath: () => loginShellPath(),
          // Settings speaks one extra word identify does not: which command
          // installs the scoped workspace, judged by its lockfile. Computed
          // here so `volli identify`'s env block keeps the exact field set
          // the contract published.
          sessionEnvironment: async (cwd) => ({
            ...(await readSessionEnvironment(cwd)),
            installCommand: cwd === null ? null : workspaceInstallCommand(cwd, existsSync),
          }),
          systemPathIssues: () => readSystemPathIssues(),
          wrapperCommands: () =>
            [...(agentRuntime.wrapperPaths ?? new Map<HarnessId, string>()).values()].map(
              (wrapperPath) => basename(wrapperPath),
            ),
          shellFile: resolveShell(process.env).file,
          shellChainActive: () =>
            agentRuntime.shellEnv?.["ZDOTDIR"] !== undefined &&
            existsSync(join(runtimePaths.zdotDir, ".zlogin")),
          installSuppressed: agentToolsRemoved,
        },
        input?.cwd ?? null,
      ),
    doctor: () => probeCliDoctor({ shellFile: resolveShell(process.env).file }),
    repair: async () => {
      await repairSessionEnvironment();
    },
  });

  try {
    const execute = dbHandle.ok
      ? createAgentCommandService({
          db: dbHandle.db,
          sessionEngine: sessionEngine!,
          appVersion: app.getVersion(),
          observeSession: (sessionId, lines) => ptyManager.peek(sessionId, lines),
          // The chat half of the same verb (VC-79): a peek at a structured
          // Session renders its transcript tail from these artifacts.
          readTranscriptArtifact: (reference) => transcriptArtifacts.read(reference),
          notify: (title, message) => new Notification({ title, body: message }).show(),
          // The product Session start route (VC-13): the same facade the
          // renderer's `sessions.create` RPC rides — no parallel creation
          // path. Absent when the Session runtime never came up this launch,
          // which the verb answers as retryable APP_UNREACHABLE.
          ...(sessions !== null ? { sessions } : {}),
          // Model discovery (VC-78): `model list` reads the same Model Access
          // snapshot every other surface does — never a parallel provider
          // probe, never raw provider files. The door bounds the read itself
          // (abort + race), so a hung probe cannot hang the CLI verb.
          ...(piRuntimeHost !== null
            ? {
                inspectModelAccess: (input: { signal: AbortSignal }) =>
                  piRuntimeHost.inspectModelAccess(input),
              }
            : {}),
          // `prompt baseline` (VC-66) prices the index through the SAME port a
          // real start records it through — nothing injected, so the answer is
          // the fresh-session default. Absent with the runtime, same as above.
          ...(sessionSkills !== null
            ? { skillsIndex: (projectId: string) => sessionSkills.index(projectId, []) }
            : {}),
          // The kickoff turn's delivery seam. `message.submit` resolves when
          // the TURN ends, so the door fires it detached; a refusal lands in
          // the Session's own durable state and the log.
          ...(sessionRuntime !== null
            ? {
                submitSessionMessage: async ({
                  sessionId,
                  text,
                }: {
                  sessionId: string;
                  text: string;
                }) => {
                  await sessionRuntime.command({
                    commandId: randomUUID(),
                    sessionId,
                    command: {
                      kind: "message.submit",
                      message: {
                        id: randomUUID(),
                        role: "user",
                        parts: [{ type: "text", text }],
                      },
                    },
                  });
                },
              }
            : {}),
          // The CLI door of auto-titling (VC-81): a kickoff-derived heuristic
          // title gets one model refinement behind it. Absent with the
          // runtime, which reads as pure heuristic titling.
          ...(autoTitler !== null
            ? { refineAutoTitle: (input) => void autoTitler.refine(input) }
            : {}),
          // The no-redirect rule (VC-13 decision 2): a start pushes a toast
          // notice; the toast's action is the only thing that ever opens the
          // new session's tab.
          onSessionStarted: (notice) => broadcastSessionStarted(notice),
          // Backward-move interrupt (issue #78): a socket `ticket.move` that
          // leaves the active columns Esc's the ticket's live agent sessions,
          // announced via toast exactly like the renderer's own move path.
          interruptTicketSessions: interruptTicketSessionsAnnounced,
          // A socket command that commits a planning mutation reaches the
          // renderer via this broadcast. The service reports the exact ticket it
          // resolved and touched (CONCEPT #42 — it owns the display-id→ticket
          // resolution), so a CLI `ticket comment`/`ticket move`/… lands on THAT
          // ticket's open surfaces promptly while other tickets' readers stand
          // down. Read-only commands and no-ops (e.g. a same-column move) never
          // fire it, so a stray broadcast can't slip through.
          onMutation: (change) => broadcastDataChanged(change),
          // The involuntary channel's fan-out (harness-events): every canonical
          // event a hook reports reaches every window, so a session's activity
          // state stops being guessed from PTY output alone.
          onHarnessEvent: (notice) => broadcastHarnessEvent(notice),
          // The other involuntary channel: a harness's own wrapper announced
          // that IT is what is now running in that terminal. Fired only on a
          // change, so this is never chatter.
          onSessionHarness: (notice) => broadcastSessionHarness(notice),
          // The `env` block `volli identify` prints (VC-94): the PATH main
          // adopted, its latest non-interactive provenance, the contract tools
          // resolved against it, and the workspace dependency state. It awaits
          // the one current pass — boot normally, a fresh pass after repair —
          // so the report never describes a PATH from before adoption finished
          // and is read at CALL time, never captured.
          sessionEnv: (cwd) => readSessionEnvironment(cwd),
          // What `volli doctor` cannot see from inside the shell it runs in.
          // Read at CALL time, never captured: the wrappers are regenerated
          // after this service is constructed, and again by `--fix`.
          doctorFacts: async () => ({
            binDir: runtimePaths.binDir,
            wrappers: Object.fromEntries(
              [...(agentRuntime.wrapperPaths ?? new Map<HarnessId, string>())].map(
                ([, wrapperPath]) => [basename(wrapperPath), wrapperPath],
              ),
            ),
            refused: harnessRuntimeRefused.map(({ command, resolvedPath, reason }) => ({
              command,
              resolvedPath,
              reason,
            })),
            shellInitDir: agentRuntime.shellEnv?.["ZDOTDIR"] ?? null,
            shellInitPresent: existsSync(join(runtimePaths.zdotDir, ".zlogin")),
            // Resolved through the real filesystem: `volli doctor` compares this
            // byte-for-byte against what a CLI process's own PATH walk found,
            // which follows the `~/.local/bin/volli` symlink main installs (or
            // a scratch profile's `/tmp` vs `/private/tmp` on macOS) to whatever
            // it actually points at. An unresolved comparison would call a
            // correct install "another Volli install owns the link".
            shimPath: await realpath(shimPath).catch(() => shimPath),
            liveSessionIds: ptyManager.liveSessionIds(),
            reporting: dbHandle.ok
              ? listRegisteredHarnesses(dbHandle.db).map((record) => ({
                  harnessId: record.slug,
                  declared: record.declaredEvents.length,
                  verified: record.verifiedEvents.length,
                }))
              : [],
            // Conflicts are discovered by running the installer, which `doctor`
            // deliberately does not do: a diagnostic must not write to the
            // user's dotfiles as a side effect of being asked a question.
            skillConflicts: [],
          }),
          doctorRepair: repairSessionEnvironment,
        }).execute
      : async () =>
          ({
            v: 1,
            ok: false,
            error: { code: "DB_UNAVAILABLE", message: dbHandle.error },
          }) as const;
    await agentSocket.start({
      socketPath: runtimePaths.socketPath,
      execute,
    });
    // Only the process that owns this profile's socket may publish its client
    // bundle and launcher. A rejected second instance must not redirect the
    // global link or in-app PTYs to a build that does not own the live socket.
    try {
      shimPath = await ensureVolliCliShim({
        binDir: runtimePaths.binDir,
        electronPath: process.execPath,
        bundleSourcePath: runtimePaths.cliBundleSourcePath,
        socketPath: runtimePaths.socketPath,
        userDataPath: app.getPath("userData"),
        rendererUrl: isDev ? (process.env["ELECTRON_RENDERER_URL"] ?? null) : null,
        appEntry: runtimePaths.appEntry,
      });
      // The harness wrappers go into the same bin dir, and every hook they
      // configure calls back through the shim above — so they are generated
      // only once it exists, and regenerated each boot for the same reason it
      // is: a wrapper written against an older contract must never outlive the
      // build that wrote it. A failure here costs this launch its hook events,
      // which the session header already states as the Known tier rather than
      // claiming reporting that isn't happening.
      try {
        await regenerateHarnessRuntime();
        console.info("[volli] harness runtime ready");
      } catch (error) {
        console.error("[volli] failed to generate harness wrappers:", errorMessage(error));
      }
    } catch (error) {
      console.error("[volli] failed to generate CLI shim:", errorMessage(error));
    }
  } catch (error) {
    // The bundled `volli` CLI is entirely dead for this launch with no other
    // signal — a lightweight native Notification (the same mechanism already
    // used for lifecycle notices) surfaces it instead of only a console line
    // no one but a developer will ever see.
    console.error("[volli] failed to start agent socket:", errorMessage(error));
    new Notification({
      title: "Volli CLI unavailable",
      body: "The agent socket failed to start. CLI commands won't work this launch.",
    }).show();
  }

  // Background user-space CLI + skills install (VC-52): no dialog, no admin
  // prompt, no opt-out — the CLI is core app functionality, surfaced only as
  // detection in Settings → CLI. Fire-and-forget so boot never waits on a
  // login-shell probe or dotfile writes; failures log, and the pane reads the
  // truth from disk regardless. Two suppressions only:
  //  - the File → Remove tombstone — an explicit removal must survive relaunch;
  //  - the VOLLI_SKIP_AGENT_TOOLS seam, so tests and smokes never write into a
  //    developer's real home (e2e sets it by default and the installer smokes
  //    opt back in against a VOLLI_AGENT_HOME scratch).
  // Gated on a healthy db like the consent flow it replaces: with the tombstone
  // unreadable, installing would silently undo a removal we cannot see.
  //
  // The skip seam is honored in PACKAGED builds too — deliberately. In the
  // consent era a dialog stood between a packaged smoke run and the developer's
  // real dotfiles; now nothing does, so a `VOLLI_SMOKE_APP_BINARY` run against
  // a packaged build needs this seam or it links ~/.local/bin/volli and appends
  // to the real ~/.zprofile. It is a test seam, not a user opt-out: unset in
  // every ordinary launch, undocumented, and the CLI pane still reports
  // whatever state skipping left behind. VOLLI_AGENT_HOME stays dev-only —
  // redirecting a production install's writes is a sharper knife than skipping
  // them.
  const skipAgentTools = process.env["VOLLI_SKIP_AGENT_TOOLS"] === "1";
  if (dbHandle.ok && !skipAgentTools && !agentToolsRemoved()) {
    void installAgentToolsQuietly().catch((error: unknown) => {
      console.error("[volli] background agent-tools install failed:", errorMessage(error));
    });
  }

  app.on("activate", () => {
    // On macOS it's common to re-create a window when the dock icon is
    // clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(ptyManager, currentFirstPaint());
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

registerAgentSocketWillQuit({
  lifecycle: app,
  shutdownAgentSocket,
  reportFailure: (error) => {
    console.error(
      "[volli] failed to close the agent socket during app shutdown:",
      errorMessage(error),
    );
  },
});
