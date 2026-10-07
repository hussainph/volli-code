import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron";
import { autoUpdater } from "electron-updater";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BLOB_URL_SCHEME,
  CHAT_DRAFTS_APP_STATE_KEY,
  chatDraftAttachmentHashes,
  diffManagedContent,
  displayTicketId,
  errorMessage,
  getHarnessAdapter,
  harnessAdapters,
  globalSkillsDir,
  draftAttachmentHashes,
  makeAgentError,
  memoizedPathExists,
  DEFAULT_CODE_MODE_POLICY,
  resolveShell,
  ticketBranchName,
  NEW_TICKET_DRAFT_APP_STATE_KEY,
  VOLLI_USER_ZDOTDIR_ENV,
  workspaceInstallCommand,
} from "@volli/shared";
import type { SessionEnvRepair } from "@volli/shared";
import type { HarnessAdapter, HarnessId, ResolvedAppearance } from "@volli/shared";
import type {
  BrowserTabStateEvent,
  BackgroundShellStateEvent,
  FirstPaintHint,
  VolliIpcChannel,
  VolliIpcEvent,
} from "../ipc/contract";
import {
  type HarnessUninstallResult,
  type ManagedConflict,
  createHostAgentCommands,
  acquireVolliAppProfile,
  ensureVolliCliShim,
  volliRuntimePaths,
  decideRegisteredHarnesses,
  scanHarnessManifests,
  trustedHarnessAdapters,
  createHostAgentSocket,
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
} from "@volli/host-core/agents";
import {
  hostMcpDispatch,
  hostCodeMode,
  codeModeSandboxAssets,
  AgentObservability,
  describeWebSealing,
} from "@volli/host-core/integrations";
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
import {
  applyQuietAppPolicy,
  hideDockForMenuBar,
  showDockAfterMenuBar,
  quietWindowPolicy,
  revealWindow,
  sealQuietAppActivation,
  createDatabaseRecovery,
  SpawnLedger,
  startOrphanScan,
  createLoginPathBootstrap,
  ADOPTION_PROBE,
  loginShellPath,
  probeLoginShellPath,
  resetLoginShellPathCache,
} from "@volli/host-core/maintenance";
import type { DbHandle } from "./data-ipc";
import { createDesktopBusyWorktreeSites } from "./worktree-activity";
import { registerDataIpcHandlers } from "./data-ipc";
import {
  createHostCore,
  defaultDatabasePath,
  logTransactionViolation,
  throwTransactionViolation,
  type HostCorePorts,
  isLiveHost,
} from "@volli/host-core";
import { createElectronClientCapabilities } from "./client-capabilities";
import {
  getProjectById,
  getTicket,
  getTicketRow,
  listProjects,
  listRegisteredHarnesses,
  getFirstPaintHint,
  getGlobalAppearance,
  getGlobalCanvas,
  getAllAppState,
  setAppState,
  getBlob,
} from "@volli/host-core/db";
import {
  createSessionConcurrencyEnvReader,
  type SessionConcurrencyEnvReader,
  createSessionTokenRegistry,
  NO_LIVE_WORK,
} from "@volli/host-core/sessions";
import { registerNotificationIpcHandlers } from "./notifications/ipc";
import { createNotificationRuntime } from "./notifications/runtime";
import {
  repackLegacyTranscriptArtifacts,
  ModelAccessSignInService,
  createRuntimeAssembly,
  type RuntimeAssemblyOptions,
  createRuntimeContextResolver,
  createConnectivityPort,
  createSessionRuntimeLifecycle,
  SessionRuntimeClosingError,
  type RecoveredSessionServices,
  createRuntimeAutomations,
  recoveredSessionClientPorts,
  recoveredSessionCommandPorts,
  createRuntimeSessionFacade,
  recoveredRuntimeSessionServices,
  recoveredSessionAutomationPorts,
  type RuntimeSessionFacade,
  createTicketSessionDelegationStore,
  readCodeModePolicy,
  buildSessionEnvReport,
  BackgroundShellHost,
  type BackgroundShellNotice,
  createAttachmentIdentities,
} from "@volli/host-core/session-runtime";
import type { OpenNativeBinding } from "@volli/session-engine";
import {
  admittedHandlers,
  createHostHandlers,
  ROUTER_POLICY,
  type HostHandlerMap,
} from "@volli/host-core/handlers";
import { registerDatabaseRecoveryIpcHandlers } from "./database-recovery-ipc";
import { createDesktopHostRuntime, prepareDesktopQuit } from "./host-runtime";
import {
  createHostFileServices,
  collectUnlinkedBlobs,
  blobProtocolResponse,
  blobsRoot,
} from "@volli/host-core/files";
import { registerModelAccessIpcHandlers } from "./model-access/ipc";
import { registerPiSessionOrphanIpcHandlers } from "./pi-session-orphans-ipc";
import { installationId } from "./installation-id";
import { AGENT_TOOLS_REMOVED_APP_STATE_KEY } from "./agent-tools-state";
import { registerWebAccessIpcHandlers } from "./web/ipc";
import { registerDecisionModelIpcHandlers } from "./decision/ipc";
import { registerAgentObservabilityIpcHandlers } from "./observability/ipc";
import { migrateLegacySafeStorageSecrets } from "./web/legacy-safe-storage";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  keychainCredentialKeyring,
  SecretStore,
  SecretService,
  retiresSessionSecrets,
} from "@volli/host-core/secrets";
import { observeKeychainUse, webSealingLifecycle } from "./web/sealing-lifecycle";
import { keychainSecretCodec } from "./secrets/codec";
import { installHarnessGuard } from "./harness/keychain-guard";
import { harnessSecretPorts } from "./harness/secret-ports";
import { registerSecretIpc } from "./secrets/ipc";
import { registerAutomationIpcHandlers } from "./automations/ipc";
import {
  registerDegradedSessionRpcIpcHandlers,
  registerSessionRpcIpcHandlers,
} from "./session-rpc-ipc";
import { piSignIn } from "@volli/agent-runtime";
import {
  ExperimentalSettings,
  installExperimentalSettings,
  isExperimentEnabled,
  readExperiments,
  setExperiment,
} from "./experiments";
import {
  BROWSER_CLOSED_FOR_MENU_BAR,
  createMenuBarHost,
  menuBarSmokeSettleMs,
  type MenuBarHost,
} from "./menu-bar-host";
import {
  confirmCloseAgentTabs,
  confirmMenuBarQuit,
  electronMenuBarPower,
  electronMenuBarTray,
} from "./menu-bar-electron";
import {
  createClientStateFlush,
  MENU_BAR_FLUSH_OVERDUE_MS,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
} from "./client-state-flush";
import { registerGhosttyConfigIpc } from "./ghostty-config";
import { registerIpcHandlers } from "./ipc";
import { registerAppMenu } from "./menu";
import { confirmDestructiveClose, prepareTerminalQuit, registerTerminalIpcHandlers } from "./pty";
import { ensureHarnessWorkspaceFiles } from "./harness-workspace";
import { clientEventSink } from "./client-event-sink";
import type { AgentRuntimeEnvironment, PtyManager } from "@volli/host-core/pty";
import { registerThemeIpcHandlers } from "./theme-ipc";
import { defaultFsDeps } from "./fs-deps";
import { firstPaintArguments, resolveFirstPaint } from "./window-theme";
import { registerFileIpcHandlers } from "./volli-fs-ipc";
import {
  broadcastSessionsInterrupted,
  broadcastSystemAppearance,
  broadcastUpdateState,
  tapDataChanged,
  windowEventBus,
} from "./broadcast";
import { createBoardChangeFeed, subscribeTicketWake } from "@volli/host-core/board";
import { installDownloadedUpdate, registerUpdateIpcHandlers } from "./update-ipc";
import {
  countOpenAgentTurns,
  reconcileInterruptedCleanups,
  releaseAgentSites as releaseWorktreeAgentSites,
  type AgentSiteReleaseReport,
  orphanCleanupEngine,
} from "@volli/host-core/worktree";
import { registerHarnessIpcHandlers } from "./harness-ipc";
import { ensureHarnessRuntime, harnessLaunchArgv } from "./harness-runtime";
import {
  installSmokeBootCapture,
  isSmokeBootCapture,
  WRAPPER_FAILURE_MESSAGE,
  WRAPPER_READY_MESSAGE,
} from "./bare-path-boot-capture";
import type { RefusedWrapper } from "./harness-runtime";
import { ensureShellInit } from "./shell-init";
import { registerAgentSocketWillQuit } from "./agent-socket-quit";
import { systemPathIssues as readSystemPathIssues } from "./system-path-diagnostics";
import { registerCliIpcHandlers } from "./cli-ipc";
import { registerSupportIpcHandlers } from "./support-info";
import { probeCliDoctor } from "./cli-doctor";
import { readCliStatus } from "./cli-status";
import {
  readAllowPrerelease,
  readUpdateChannel,
  startAutoUpdate,
  writeUpdateChannel,
} from "./auto-update";
import {
  PACKAGED_RENDERER_CURSOR_URL,
  PACKAGED_RENDERER_ENTRY_URL,
  PACKAGED_RENDERER_HOST,
  PACKAGED_RENDERER_PROTOCOL,
  PACKAGED_RENDERER_SCHEME,
  resolvePackagedRendererAsset,
} from "./app-protocol";
import {
  BROWSER_DEFAULT_BOUNDS,
  browserAgentPort,
  browserPictureDisk,
  browserPicturesRoot,
  BrowserPictureStore,
  browserTraceDisk,
  browserTracesRoot,
  BrowserTraceStore,
} from "@volli/host-core/browser";
import { BrowserTabHost } from "./browser/tab-host";
import { registerOrphanProcessIpcHandlers } from "./process/ipc";
import { registerBackgroundShellIpcHandlers } from "./shell/ipc";
import { registerBrowserTabIpcHandlers } from "./browser/ipc";
import { holdNoticeMessage, relayHoldNotices } from "./browser/hold-notices";
import {
  CURSOR_OVERLAY_PARTITION,
  createCursorOverlay,
  type CursorOverlay,
} from "./browser/cursor-overlay";
import { closeHeadlessTabsOnTicketArchive } from "./browser/lifecycle";
import { hostLogger } from "@volli/host-core/log";
import { exitAfterLogFlush, logPowerTransitions, startDesktopLog } from "./log/desktop-log";
import { registerRendererLogForwarding } from "./log/renderer-log";
import { parkBrowserPlanesOnRendererReset } from "./browser/plane-reset";

// Harness mode (VC-703): inert unless VOLLI_HARNESS=1, which only
// `volli-drive` sets. When on, the boot is refused unless every home-derived
// path sits in the instance's scratch root (and the build is a dev build);
// every safeStorage method becomes a trap that fails the run, Chromium is told
// to use a mock keychain, the secret ports below seal with per-instance key
// files instead, and shell.openExternal & co. only record. First, before
// anything else in this module can reach safeStorage or the shell, or the
// command line is frozen at ready.
const harnessGuard = installHarnessGuard({ env: process.env, app, safeStorage, shell });
const harnessPorts = harnessGuard.active ? harnessSecretPorts(harnessGuard.paths) : null;

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

// Capture smoke boot output before any readiness work, in built AND packaged
// launches. Ordinary launches have no capture env var and do no extra work.
installSmokeBootCapture(process.env, app, process.stdout, process.stderr);

// Packed-app smokes need the real compositor, but not the native app activation
// that a normal Volli launch owns. This env-only seam is deliberately resolved
// before the profile lock or any BrowserWindow: packaged binaries honour it too,
// the app never reaches the Dock/frontmost state, and every later window reads
// the same frozen policy.
const nativeWindowPolicy = quietWindowPolicy(process.env, process.platform);
applyQuietAppPolicy(app, nativeWindowPolicy);

const isDev = !app.isPackaged;
const agentSocket = createHostAgentSocket();
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
// One structured, correlated log for main, the in-process host and the
// renderer (VC-699): rotating JSON lines in this profile's own log directory.
// Only the instance that owns the profile writes there.
const desktopLog = ownsAppProfile
  ? startDesktopLog({
      userData: app.getPath("userData"),
      dev: isDev,
      env: process.env,
      // A smoke's captured boot reads main's lines off the terminal in any build.
      terminal: isDev || isSmokeBootCapture(process.env),
    })
  : null;
/** `app`, whose `exit` writes the log's tail first: every accepted quit ends in it. */
const quittingApp = desktopLog === null ? app : exitAfterLogFlush(app, desktopLog);
/** Electron main's own composition lines; the areas below log under their own names. */
const log = hostLogger("desktop");
const repackLog = hostLogger("transcript-repack");
const worktreeLog = hostLogger("worktree");
/**
 * Brings a window back for a launch that found none (VC-577). Bound once the
 * window factory exists; until then a second launch has nothing to open.
 */
let revealWindowForLaunch: (() => void) | null = null;
if (ownsAppProfile) {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      // Flag off: today's early return. Flag on: a menu-bar host (or one whose
      // every window was closed) answers a second launch with a window.
      if (isExperimentEnabled("cloud")) revealWindowForLaunch?.();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    revealWindow(mainWindow, nativeWindowPolicy);
    sealQuietAppActivation(app, nativeWindowPolicy);
    // show() normally gives focus on its own; preserve the explicit focus from
    // this second-instance path without letting a quiet smoke take it.
    if (!nativeWindowPolicy.enabled) mainWindow.focus();
  });
}

// The app-owned directory exposed by volli-app://bundle/. The protocol resolver
// below is exact-host and containment checked: it cannot serve project files or
// anything else from the local filesystem.
const PACKAGED_RENDERER_ROOT = join(__dirname, "../dist");

function noQuitAction(): void {}

function noOpenNativeBindings(): readonly OpenNativeBinding[] {
  return [];
}

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

function publishBackgroundShellEvent(event: BackgroundShellStateEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send("volli:shell-state" satisfies VolliIpcEvent, event);
  }
}

function publishBrowserTabEvent(event: BrowserTabStateEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send("volli:browser-tab-state" satisfies VolliIpcEvent, event);
  }
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
    // A quiet macOS smoke window must be incapable of becoming key. Playwright
    // focus emulation still gives its page document focus and CDP input.
    focusable: nativeWindowPolicy.focusable,
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
      // Smoke windows stay displayed for screenshots/WebGPU but can be fully
      // covered by the person's work or by another concurrent smoke. Keep the
      // compositor and timers at foreground pace in that env-only mode.
      backgroundThrottling: nativeWindowPolicy.backgroundThrottling,
      // Electron 20+ already defaults this on; explicit so it can't silently
      // regress. Safe: the preload only imports `electron` (contextBridge,
      // ipcRenderer) plus type-only @volli/shared imports — no Node builtins.
      sandbox: true,
    },
  });
  clearUnsavedDocumentsOnWindowClosed(mainWindow);

  mainWindow.on("ready-to-show", () => {
    revealWindow(mainWindow, nativeWindowPolicy);
    // Accessory apps may still be activated programmatically. Once the smoke's
    // one compositor window exists and is visible, prohibit activation for the
    // rest of this process; the window keeps painting and receiving CDP input.
    sealQuietAppActivation(app, nativeWindowPolicy);
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
    const busy = ptyManager.busySessions(clientEventSink(mainWindow.webContents));
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

const appStartup = app.whenReady().then(async () => {
  if (!ownsAppProfile) return;
  // Started here, awaited nowhere near here: a Finder/Dock launch hands main
  // launchd's bare PATH, and the only fix is asking the user's own login
  // shell what it would have exported. That costs a shell spawn (~4s worst
  // case) — started now so it runs alongside the db open, migrations and IPC
  // registration below rather than in front of them. Its result is observed
  // only after the first window loads, or by a Pi execution environment that
  // genuinely needs it first.
  const loginShellPathAttempt = probeLoginShellPath(ADOPTION_PROBE);
  logPowerTransitions(powerMonitor);
  registerRendererLogForwarding(ipcMain);
  const serveRendererAsset = (request: Request): Promise<Response> | Response => {
    const assetPath = resolvePackagedRendererAsset(request.url, PACKAGED_RENDERER_ROOT);
    if (assetPath === null) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  };
  protocol.handle(PACKAGED_RENDERER_SCHEME, serveRendererAsset);
  // The Session cursor overlay (VC-239) runs under its own partition, and a
  // partition has its own protocol table: without this line the packaged
  // overlay page would 404 on the very scheme the app renderer loads from.
  // Same resolver, same read-only root, no wider reach.
  session
    .fromPartition(CURSOR_OVERLAY_PARTITION)
    .protocol.handle(PACKAGED_RENDERER_SCHEME, serveRendererAsset);

  if (isDev) {
    // Dev smoke-check that vp pack bundled the workspace TS source (@volli/shared)
    // into main.cjs via deps.alwaysBundle rather than leaving an unresolved
    // runtime require(). Gated to dev so it never prints on a production boot.
    log.debug("shared wiring ok", { branch: ticketBranchName("VC-0", "monorepo migration") });
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
  //  - local-fonts: the Terminal settings font picker enumerates the user's
  //    installed families through the Local Font Access API (issue #18), so
  //    the ghostty-config font chain can be offered as real choices.
  //  - clipboard-read / clipboard-sanitized-write: terminal copy/paste and
  //    OSC 52 (status quo under the old default-grant; a ghostty-style
  //    clipboard-read=ask policy would need a per-request prompt this app
  //    does not have a surface for yet).
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
  const dbPath = dbOverride ?? defaultDatabasePath(app.getPath("userData"));
  // Log the resolved db up front: a `pnpm dev` boot lands on the empty
  // `Volli Code-dev/volli.db` while your real data sits in the packaged app's
  // `Volli Code/volli.db`. Without this line an empty dev UI is
  // indistinguishable from a broken data pointer — surface which db is live.
  const dbSource = dbOverride === undefined ? "userData" : "VOLLI_DB_PATH";
  log.info("database resolved", {
    mode: isDev ? "dev" : "packaged",
    source: dbSource,
    path: dbPath,
  });
  // The host's persistence comes out of host-core (VC-553): this file only
  // states the policy. Packaged builds log a transaction-ownership violation;
  // dev and tests throw (VC-551) — chosen from `app.isPackaged`, never NODE_ENV.
  // The notification registry is installed below. Session construction only
  // captures these adapters; it never calls them at boot. The runtime's open
  // bindings and scheduled resume are host-core's own wiring (VC-632).
  // The Electron adapters for host-core's ports (VC-554). Code still composed
  // below reads power, connectivity and the client through them too.
  const hostPorts: HostCorePorts = {
    log: hostLogger("host-core"),
    events: windowEventBus,
    attention: {
      deliver: (request) => notifications.deliver(request),
      focusedSessionIds: () => notifications.focusedSessionIds(),
    },
    power: powerMonitor,
    connectivity: createConnectivityPort({ net, powerMonitor }),
    client: createElectronClientCapabilities(),
    trash: { trashItem: (path) => shell.trashItem(path) },
  };
  let ptyManagerRef: PtyManager | undefined;
  // Capture-only wrapper: successful keychain use is observed by all host-owned secrets.
  const keychainUse = observeKeychainUse(safeStorage);
  const hostCore = createHostCore(hostPorts, {
    dataDir: app.getPath("userData"),
    stopPolicy: "desktop-quit",
    databasePath: dbPath,
    onTransactionViolation: app.isPackaged ? logTransactionViolation : throwTransactionViolation,
    devDiagnostics: isDev,
    secretKey: harnessPorts?.secretKey ?? keychainSecretCodec(keychainUse.keychain),
    webKeySealing: {
      keyring:
        harnessPorts?.keyring ??
        keychainCredentialKeyring({
          path: join(dirname(dbPath), CREDENTIAL_KEYCHAIN_KEY_FILE_NAME),
          keychain: safeStorage,
          inventoryPath: join(dirname(dbPath), CREDENTIAL_INVENTORY_FILE_NAME),
        }),
      // A key file never prompts, so harness mode may always unlock it.
      mayUnlockUnattended: harnessPorts === null ? keychainUse.used : () => true,
      onResult: (result) =>
        log.info("web search keys sealed", { outcome: describeWebSealing(result) }),
    },
    terminal: () => ({
      host: {
        events: hostPorts.events,
        worktreeDeps: () => {
          if (liveHost === undefined) throw new Error("The database is unavailable.");
          return liveHost.worktreeDeps;
        },
        ensureHarnessWorkspaceFiles,
      },
      agentRuntime,
      concurrencyEnvReader,
    }),
    processReaders: {
      liveSessionIds: () => sessionTokens.liveSessionIds(),
      openTerminalCwds: () => ptyManagerRef?.liveSessionCwds() ?? [],
    },
    reclaim: {
      busyWorktreeSites: (target) => busyWorktreeSites(target),
      releaseAgentSites: (target) => releaseAgentSites(target),
    },
  });
  const liveHost = isLiveHost(hostCore) ? hostCore : undefined;
  const dbHandle: DbHandle = hostCore.database;
  registerDatabaseRecoveryIpcHandlers({
    recovery: createDatabaseRecovery({ dbPath, dataDir: app.getPath("userData") }),
    degraded: !dbHandle.ok,
    // A database from a newer Volli gets its own recovery screen (VC-602).
    fault:
      !isLiveHost(hostCore) && hostCore.databaseFailure.kind === "newer-version"
        ? "newer-version"
        : "unreadable",
    restart: () => {
      // Let the IPC reply paint success before restarting the entire service
      // graph; degraded handlers must not be replaced with partially live ones.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 750);
    },
    quit: () => setTimeout(() => app.quit(), 0),
  });
  const watchedDb = dbHandle.ok === true ? dbHandle.db : null;
  installExperimentalSettings(
    new ExperimentalSettings(watchedDb, process.env["VOLLI_EXPERIMENTAL"]),
  );
  const sessionWakeBus = liveHost?.sessionWakeBus ?? null;
  const sessionReadWatch = liveHost?.sessionReadWatch ?? null;
  const sessionEngine = liveHost?.sessionEngine ?? null;
  // The ONE notification door (VC-295). Every native alert this process posts —
  // this file's five, the retention watch's three — goes through `deliver`,
  // which is what makes "no alert escapes the preferences" structural rather
  // than a convention. Built here, right after the database handle is known,
  // because host-core's run-attention adapter is the first thing that needs it; the
  // window opener is bound later, when the window factory exists.
  //
  // Deliberately built even for a degraded database: with no stored
  // preferences the all-on default applies, so a broken db costs the app its
  // settings, never its voice.
  const notifications = createNotificationRuntime({ db: watchedDb });
  // A1: a Session that BECOMES in front of a focused window is read — the
  // renderer's active target changed to it, or its window took focus while
  // already showing it. Without this, returning to a window that has a finished
  // chat on screen keeps its dot until the person navigates away and back.
  if (sessionReadWatch !== null) {
    notifications.onFocusedSessionsChanged((sessionIds) =>
      sessionReadWatch.observeFocused(sessionIds),
    );
  }
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
    log: hostLogger("login-path").info,
  });
  /**
   * The same Session-environment measurement for agents, Settings, and project
   * onboarding. `null` means the caller has no project root — it must not turn
   * main's own cwd into a pretend workspace dependency answer.
   */
  const readSessionEnvironment = async (
    cwd: string | null,
    projectRoot: string | null,
    pathExists?: (path: string) => boolean,
  ) => {
    const outcome = await loginPathBootstrap.apply();
    const interactiveProvenance = loginPathBootstrap.interactiveProvenance();
    const reportInput = {
      // Read after apply: the bootstrap is the one writer that puts binDir
      // first even when the login shell could not be reached.
      path: process.env.PATH ?? "",
      provenance: outcome.kind,
      interactiveProvenance,
      // A caller with a further workspace question of its own passes its memo
      // in, so the whole read stats each path once (Settings, below).
      ...(pathExists === undefined ? {} : { pathExists }),
    };
    // A host-wide read has no project dependency fact to infer from main's own
    // cwd. Scoped reads carry both where the caller stands and the outer
    // project boundary; constructing the two shapes separately keeps that
    // all-or-nothing contract visible to TypeScript.
    const report = await buildSessionEnvReport(
      cwd === null || projectRoot === null ? reportInput : { ...reportInput, cwd, projectRoot },
    );
    // `SessionEnvReport` also serves a standalone CLI fallback, where those
    // fields can be unknown. Main just ran both passes, so Settings can retain
    // their concrete facts instead of widening them to that fallback shape.
    return { ...report, provenance: outcome.kind, interactiveProvenance };
  };
  // The Pi-backed Agent Runtime is the structured product's one target
  // executor, for Ticket Sessions and ticketless Board chats alike. Model
  // access and selection come from this Pi host.
  // Pi's providers and the credential store behind them, built once here so
  // signing in and running a Session share one collection. Two would be two
  // write chains over one `auth.json` — safe, since the store's lock is
  // cross-process and already survives the `pi` CLI writing alongside us, but
  // it would also mean a credential written by the login flow sat behind a
  // catalog the runtime had no reason to re-read.
  const piModelAccess = liveHost?.runtimeServices.modelAccess ?? null;
  // Decision models (VC-478): the host decision service every feature that
  // asks a classifier goes through, the `classify` tool's per-Session port,
  // and the Settings owner. Built over the same Pi collection as chat, so a
  // cloud classifier's key is the one a person signed in with under Model
  // Access. Its usage is billed into the Session it was asked for, as
  // `usage.recorded` with cause `decision` and the purpose in the provenance.
  const desktopDecisions = liveHost?.runtimeServices.decisions ?? null;
  // Web Access: the BYO search provider, and the one credential Volli stores
  // itself. Before anything can read one, the keys that predate migration 023
  // are carried out of `safeStorage` — the app's one remaining keychain call,
  // and a no-op `SELECT` on every profile that has already made the trip. It
  // runs here, ahead of the stores, so no Session and no Settings open can see
  // a key half-moved. Counts only in the log: how many rows moved is not a fact
  // about any key.
  // Whether this launch has used the keychain successfully yet (VC-643): the
  // web keys' unattended launch reconcile may fetch its own key only then.
  // Harness mode has no keychain to carry anything out of: the migration is
  // skipped rather than left to trip the guard on a copied profile.
  if (dbHandle.ok && harnessPorts === null) {
    const moved = migrateLegacySafeStorageSecrets(dbHandle.db);
    if (moved.carried > 0) keychainUse.markUsed();
    if (moved.carried + moved.dropped + moved.deferred > 0) {
      log.info("web search keys moved out of the os keychain", {
        carried: moved.carried,
        dropped: moved.dropped,
        deferred: moved.deferred,
      });
    }
  }
  // Per-Session control grants live beside VC-44's app-owned policy data. The
  // store is intentionally constructed before any Session surface: it resolves
  // birth grants and the door later consumes the exact durable record.
  const sessionDelegation = dbHandle.ok ? createTicketSessionDelegationStore(dbHandle.db) : null;
  // MCP credentials (VC-470): one user-only file beside the database, never
  // the database itself, and never the keychain — see `mcp/credential-store.ts`.
  // Beside `dbPath` rather than under `userData` so a smoke run on its own
  // VOLLI_DB_PATH cannot read or write a real profile's tokens.
  // Lazy: no keychain access until a stored secret is used or a person saves one.
  // Session-only storage never needs the keychain. No plaintext fallback.
  const secrets = new SecretService(
    liveHost?.secretStore ??
      new SecretStore(
        join(dirname(dbPath), "session-secrets.enc"),
        harnessPorts?.secretKey ?? keychainSecretCodec(keychainUse.keychain),
      ),
  );
  sessionWakeBus?.subscribe(({ event }) => {
    if (retiresSessionSecrets(event.payload)) void secrets.endSession(event.sessionId);
  });
  registerSecretIpc(secrets, (sender) => {
    const url = sender.getURL();
    const renderer = isDev ? process.env["ELECTRON_RENDERER_URL"] : PACKAGED_RENDERER_ENTRY_URL;
    if (renderer === undefined || !URL.canParse(renderer) || !URL.canParse(url)) return false;
    const actual = new URL(url);
    const expected = new URL(renderer);
    actual.hash = "";
    expected.hash = "";
    return actual.href === expected.href;
  });
  const mcpSettings = liveHost?.runtimeServices.mcp ?? null;
  // How MCP calls are dispatched and bounded (VC-454): the developer-only
  // parallel-read opt-in, read once from an unpackaged build's environment
  // (no setting, no UI), and one per-server bound every Session shares.
  const mcpDispatch = hostMcpDispatch({
    env: process.env,
    packaged: !isDev,
    log: hostLogger("mcp").warn,
  });
  // Code Mode (VC-471): the stored setting, read at each birth, which an
  // unpackaged build's environment can override like the parallel-read opt-in
  // above. It decides only what NEW Sessions are born with; a Session's own
  // record decides the rest.
  // Where Code Mode's sandbox worker and WebAssembly are (VC-471): the
  // workspace's installed copy unpackaged, and the copy electron-builder
  // unpacks beside app.asar when packaged. Located once, at boot: a launch
  // that cannot find them offers no Session Code Mode at all.
  const codeModeSandbox = codeModeSandboxAssets({
    packaged: app.isPackaged,
    appPath: () => app.getAppPath(),
    resourcesPath: () => process.resourcesPath,
    log: hostLogger("codemode").warn,
  });
  const codeMode = hostCodeMode({
    env: process.env,
    packaged: !isDev,
    log: hostLogger("codemode").warn,
    policy: () => (dbHandle.ok ? readCodeModePolicy(dbHandle.db) : DEFAULT_CODE_MODE_POLICY),
    sandboxAvailable: codeModeSandbox.codeModeSandbox !== undefined,
  });
  // Web search keys' sealed mirror (VC-643): host-owned with the keyring
  // captured above. Unattended reconcile waits for first paint and successful
  // keychain use; accepted quit stops it without awaiting keychain work.
  const webAccess = liveHost?.runtimeServices.webAccess ?? null;
  const webSealing = webSealingLifecycle(webAccess);
  /** The cursor overlay is a desktop-only port, constructed beside the window. */
  let cursorOverlayRef: CursorOverlay | null = null;
  // Agent observability (VC-119): the opt-in export switch, and the sink the
  // runtime holds whether or not it is on. Constructed here because this is the
  // only process allowed to initialize OpenTelemetry — never the renderer, and
  // never a process a model's tools can see. `start()` brings a stored
  // opt-in into effect; a profile that never asked for one builds no exporter
  // at all and the runtime keeps the no-op sink.
  const agentObservability = dbHandle.ok
    ? new AgentObservability({ db: dbHandle.db, serviceVersion: app.getVersion() })
    : null;
  agentObservability?.start();
  /**
   * The spawn ledger (VC-341): every child Volli starts on a Session's behalf,
   * recorded at spawn so that a sweep after a crash — or after a Session ended
   * without its processes noticing — can say whose a running process is
   * without guessing from its command line. One instance, shared by every
   * spawn door, and a no-op when the database never opened.
   */
  const spawnLedger = liveHost?.maintenance.spawnLedger ?? new SpawnLedger(null);
  /**
   * The one place both halves of the session-token seam are known (VC-163).
   *
   * Minting belongs to whatever spawns an attachment — the PTY manager and the
   * Pi execution environment — and verifying belongs to the agent socket. Only
   * this composition root sees both, which is why the registry is created here
   * and passed to each side as a narrow function rather than imported by them.
   *
   * Process-lived, like the attachments it issues for: see `session-tokens.ts`
   * for why that lifetime is the design rather than a limitation.
   */
  const sessionTokens = createSessionTokenRegistry();
  /**
   * The identity one attachment's commands run under, built once and shared
   * by the execute tool's environment and the background shell port
   * (VC-270). One mint per attachment is the whole point: a second mint
   * would retire the token the execute tool had already exported.
   */
  const attachmentIdentities = createAttachmentIdentities({
    mint: sessionTokens.mint,
    revoke: sessionTokens.revoke,
    ticketDisplayIdOf: (ticketId) => {
      if (!dbHandle.ok) return null;
      const ticket = getTicket(dbHandle.db, ticketId);
      const ticketProject = ticket ? getProjectById(dbHandle.db, ticket.projectId) : null;
      return ticket && ticketProject
        ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
        : null;
    },
  });
  /**
   * Every background shell a Session started (VC-270). Electron-free, so it
   * is built here beside the tokens rather than in the ready path; its
   * renderer doors are registered there, once a window can receive them.
   */
  // Where a background shell's exit or match is steered into the Session that
  // started it (VC-495): the same delivery path a watch notice rides. Composed
  // below, once the Session runtime exists; a shell that speaks before then, or
  // in a build with no runtime, has nobody to tell.
  let relayShellNotice: ((notice: BackgroundShellNotice) => void) | null = null;
  const backgroundShells = new BackgroundShellHost({
    redactOutput: (text) => secrets.store.redact(text),
    redactNoticeOutput: (text) => secrets.store.redactPartial(text),
    onNotice: (notice) => relayShellNotice?.(notice),
    // The host's live work counts running shells (VC-577) off the same feed
    // the renderer gets, so the two can never disagree about one shell.
    publishState: (started) => {
      liveHost?.liveWork.observeShell(started);
      publishBackgroundShellEvent({ shell: started });
    },
    publishRemoved: (removedShellId) => {
      liveHost?.liveWork.forgetShell(removedShellId);
      publishBackgroundShellEvent({ removedShellId });
    },
    // One row per started shell (VC-341). A background shell is the door a
    // model most often uses to start a dev server, and the one whose child can
    // outlive both the Session and this launch.
    ledger: spawnLedger,
  });

  /**
   * This process's ONE reader of who is working (VC-403).
   *
   * Every door that starts something asks the same question about the same
   * machine — a structured attachment, a background shell, a terminal — so
   * they share one reader rather than each keeping its own. Two readers would
   * be two answers about one machine for as long as their windows disagreed.
   *
   * Behind it, `listAttachedSessions` reads only the Sessions holding an open
   * attachment instead of folding every Session of every project, so an
   * uncached start no longer waits on the fleet; the reader's short memo is
   * now only there to collapse a burst.
   *
   * `null` when there is no Session Engine to ask, which leaves every
   * toolchain on its own default rather than blocking a Session.
   */
  const concurrencyEnvReader: SessionConcurrencyEnvReader | null =
    sessionEngine === null
      ? null
      : createSessionConcurrencyEnvReader({
          listAttachedSessions: () => sessionEngine.listAttachedSessions(),
        });

  /**
   * One structured Session's share of the machine (VC-339), in the variables
   * `cargo`, `make`, `cmake`, `go`, `pytest`, gradle and vitest already read —
   * the same budget a spawned PTY gets in `pty/manager.ts`, so a Session's
   * builds self-limit whichever door they run through.
   *
   * `process.env` is the no-clobber reference: a value the user exported in
   * their own shell is never overwritten. Answers `{}` when there is no
   * database to count the fleet with, which leaves every toolchain on its own
   * default rather than blocking the Session.
   */
  const sessionConcurrencyEnvFor = async (sessionId: string): Promise<Record<string, string>> => {
    if (concurrencyEnvReader === null) return {};
    return concurrencyEnvReader({ excludeSessionId: sessionId, environment: process.env });
  };

  // Remote pages live in main-owned WebContentsViews, never in the privileged
  // app renderer. The host receives every Electron surface explicitly so its
  // registry and security policy stay testable without Electron globals.
  //
  // Constructed before attachment assembly (VC-367); no tab/window opens here.
  // Its backend is an input, never a late-bound browserTabsRef.
  // The pictures a transcript card shows (VC-238): live captures bounded in
  // memory, model-requested screenshots also on disk under userData — never
  // the Blob store, whose Session links become the next turn's input.
  const browserPictures = new BrowserPictureStore({
    createId: randomUUID,
    now: Date.now,
    persist: browserPictureDisk(browserPicturesRoot(app.getPath("userData"))),
  });
  const browserTabs = new BrowserTabHost({
    createId: randomUUID,
    createView: (options) => new WebContentsView(options),
    fromPartition: (partition) => session.fromPartition(partition),
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    // The off-screen stage every tab waits in until a person shows it (VC-278).
    // A tab nobody has revealed still needs a window to hold its compositor
    // surface, or its clicks land nowhere and its screenshots never answer.
    //
    // A BaseWindow, deliberately: it holds views but has no webContents, so it
    // never joins `BrowserWindow.getAllWindows()` — the list `getWindow` below
    // picks the app window out of, and that `activate` counts before
    // re-creating one. `show: false` is load-bearing and must stay: showing
    // this would put an agent's page on screen with nothing in the UI claiming
    // to have shown it.
    createStageWindow: () =>
      new BaseWindow({
        show: false,
        width: BROWSER_DEFAULT_BOUNDS.width,
        height: BROWSER_DEFAULT_BOUNDS.height,
        skipTaskbar: true,
        focusable: false,
      }),
    publishState: (tab) => publishBrowserTabEvent({ tab }),
    publishClosed: (closedTabId) => publishBrowserTabEvent({ closedTabId }),
    pictures: browserPictures,
    // A Session's steps in its own tabs, kept for the person to replay after
    // the live set has moved on (VC-453) — its own directory, never a Blob.
    traces: new BrowserTraceStore({
      createId: randomUUID,
      now: Date.now,
      frameOf: (pictureId) => browserPictures.copyOf(pictureId),
      persist: browserTraceDisk(browserTracesRoot(app.getPath("userData"))),
    }),
    // The holder's name for the pill and the cursor label (VC-239), from the
    // Session's own projection. A launch with no runtime has no Sessions to
    // hold a tab, so the placeholder is never what a person sees.
    sessionName: async (sessionId: string) =>
      (await sessionRuntime?.projection({ sessionId }))?.projection.session.title ?? null,
  });
  const runtimeInputs: Omit<RuntimeAssemblyOptions, "resolveRuntimeContext"> = {
    dbHandle,
    sessionEngine,
    dataDir: hostCore.dataDir,
    binDir: runtimePaths.binDir,
    venue: { id: "local", kind: "local" },
    hostPorts,
    modelAccess: piModelAccess,
    decisions: desktopDecisions,
    webAccess,
    mcpSettings,
    mcpDispatch,
    codeMode,
    ...codeModeSandbox,
    observability: agentObservability,
    delegation: sessionDelegation,
    secrets,
    attachmentIdentities,
    shells: backgroundShells,
    browser: { backend: browserTabs, cursorFor: (tabId) => cursorOverlayRef?.driverFor(tabId) },
    askUser: true,
    requestSecret: true,
    beforeExecution: () => loginPathBootstrap.apply(),
    concurrencyEnvFor: sessionConcurrencyEnvFor,
    // Inert assembly captures this cycle; no verb runs before the facade and
    // lifecycle below exist. Every acquisition must still pass ready().
    callVerb: async (caller, request, signal, budgetAsk) => {
      const door = runtimeSessionAgents.toolDoor(await runtimeLifecycle.ready());
      if (door === null) throw new Error("This launch has no Volli verb handlers.");
      signal.throwIfAborted();
      return door(caller, request, signal, budgetAsk);
    },
  };
  const assembledRuntime: ReturnType<typeof createRuntimeAssembly> =
    dbHandle.ok &&
    piModelAccess !== null &&
    sessionDelegation !== null &&
    webAccess !== null &&
    sessionEngine !== null
      ? createRuntimeAssembly({
          ...runtimeInputs,
          resolveRuntimeContext: createRuntimeContextResolver({
            db: dbHandle.db,
            sessionEngine,
            venue: runtimeInputs.venue,
            mcpDispatch,
            waitForBirth: (sessionId) => preparedSessionFacade.waitForBirth(sessionId),
            toolSurface: () => sessionToolSurface,
          }),
        })
      : createRuntimeAssembly({ ...runtimeInputs, resolveRuntimeContext: async () => null });
  const {
    sessionToolSurface,
    piRuntimeHost,
    sessionRuntime,
    piSessionsDirectory,
    transcriptArtifacts,
  } = assembledRuntime;
  const listOpenNativeBindings =
    sessionRuntime === null ? noOpenNativeBindings : () => sessionRuntime.openNativeBindings();
  const sessionDb = dbHandle.ok ? dbHandle.db : null;
  /**
   * The board's change feeds (VC-565): its handlers stamp their rows, and
   * every other writer's `data-changed` on the window bus is stamped too, so
   * a Client following the feed (the renderer with `cloud` on) misses none.
   * With the flag off nothing subscribes, and the windows hear exactly what
   * they heard before.
   */
  const boardFeed = createBoardChangeFeed({
    projectOfTicket: (ticketId) =>
      sessionDb === null ? undefined : getTicketRow(sessionDb, ticketId)?.project_id,
    workspaces: () => (sessionDb === null ? [] : listProjects(sessionDb).map(({ id }) => id)),
  });
  tapDataChanged((change) => boardFeed.noteDataChanged(change));
  const runtimeAutomations = createRuntimeAutomations({
    host: hostCore,
    events: hostPorts.events,
    piRuntimeHost,
    homeDir: fsDeps.homeDir,
    log: hostLogger("automations"),
  });
  const preparedSessionFacade = createRuntimeSessionFacade({
    host: hostCore,
    assembly: assembledRuntime,
    homeDir: fsDeps.homeDir,
    venue: runtimeInputs.venue,
    events: hostPorts.events,
    decisions: desktopDecisions,
    delegation: sessionDelegation,
  });
  let sessionRpc: ReturnType<typeof registerSessionRpcIpcHandlers> | null = null;
  // The terminal ref declared before host construction is filled later; the
  // interrupt and the worktree guards below read it lazily, after boot.
  // The ONE interrupt entry the host's `ticket.move` handler takes, whichever
  // door moved the ticket (renderer IPC, socket, router): Escs the ticket's live agent sessions
  // and, when any were actually interrupted, announces it to every window
  // (issue #78 — automation de-escalates, but never silently). Lazy through
  // the ref: registration below runs before the PtyManager is built, but the
  // seam only ever fires at invoke time, long after boot.
  const interruptTicketSessionsAnnounced = async (ticketId: string): Promise<string[]> => {
    let sessionIds: string[] = [];
    try {
      sessionIds = (await ptyManagerRef?.interruptTicketSessions(ticketId)) ?? [];
    } catch (error) {
      log.error("failed to interrupt ticket", { ticketId, error });
    }
    if (sessionIds.length > 0) broadcastSessionsInterrupted(ticketId, sessionIds);
    return sessionIds;
  };
  /**
   * Where work is genuinely in flight in `target` right now, for the
   * destructive worktree guards. The execution surfaces answer differently ON PURPOSE.
   *
   * A live PTY holds its cwd whatever it is doing: a shell whose directory was
   * deleted underneath it is broken whether or not anything was running in it.
   * Every live cwd is reported, unfiltered, and the guard does the containment.
   * Background shells hold theirs between turns too, including while an ended
   * attachment's shells are still terminating; only process exit clears them.
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
  const busyWorktreeSites = createDesktopBusyWorktreeSites({
    terminalCwds: () => ptyManagerRef?.liveSessionCwds() ?? [],
    shells: backgroundShells,
    runtime: () => sessionRuntime,
    onUnreadable: (sessionId, error) => {
      log.warn("could not read session", { sessionId, error });
    },
  });
  /**
   * The host's one handler map (VC-668), built once from the recovered
   * services and handed to every door: the Session RPC bridge, the
   * `volli:ticket-move` channel and the agent socket each project it, under
   * that door's own policy (the map is sealed: no door can call it without
   * one). What
   * this root used to write around each call (reconciling preferences on a
   * refresh, the availability check before a default, the Role a ticket
   * implies, resuming an Automation's delivery after attach, a deliberate
   * move's armed arrival) is the handler's now.
   */
  let hostHandlers: HostHandlerMap | undefined;
  const createHandlers = (
    ready: RecoveredSessionServices<RuntimeSessionFacade>,
  ): HostHandlerMap => {
    const { runtime, sessions } = recoveredRuntimeSessionServices(ready);
    return createHostHandlers(hostPorts, {
      db: sessionDb,
      dataDir: hostCore.dataDir,
      runtime,
      sessions,
      modelAccess: piRuntimeHost,
      experiments: { snapshot: readExperiments, set: setExperiment },
      automations: runtimeAutomations,
      busyWorktreeSites,
      interruptTicketSessions: interruptTicketSessionsAnnounced,
      ...(liveHost === undefined ? {} : { detachedWork: liveHost.detachedWork }),
      // This Mac's recent log (VC-699): main's, the in-process host's and the
      // renderer's lines, which the dev log viewer reads through `host.logs`.
      logs: desktopLog?.ring ?? null,
      boardFeed,
      ticketSignals:
        sessionEngine === null
          ? null
          : (projectId) => sessionEngine.listLatestTicketSignals({ projectId }),
      // Archiving or deleting a ticket drops its Sessions' saved tool output (VC-469).
      piSessionsDirectory,
    });
  };
  /** Built once, at the first door that needs it; every later door gets the same object. */
  const handlersFor = (ready: RecoveredSessionServices<RuntimeSessionFacade>): HostHandlerMap =>
    (hostHandlers ??= createHandlers(ready));
  const runtimeSessionAgents = preparedSessionFacade.agents({
    host: hostCore,
    delegation: sessionDelegation,
    automations: runtimeAutomations,
    mcpSettings,
    events: hostPorts.events,
    log: hostLogger("session-agents"),
  });
  // No runtime, no bridge — but the channels are still claimed, answering
  // every request with the reason the runtime is down (in practice: the
  // database open recorded above, Node-ABI classification included). Left
  // unregistered, the renderer's Model Access page would toast Electron's
  // nameless "No handler registered" instead of the actual problem (VC-76).
  if (sessionRuntime === null) {
    // `dbHandle.error` is already a complete sentence naming the failure (see
    // db-open-failure.ts's CONTRACT), so it is passed through rather than
    // wrapped — a second "the local database failed to open" in front of it read
    // as two restatements of one fact to the user (VC-160).
    registerDegradedSessionRpcIpcHandlers(
      dbHandle.ok ? "The agent runtime is unavailable." : dbHandle.error,
    );
  }
  // Signing in is a Model Access task, not a Session one, so it gets its own
  // surface rather than a Session RPC namespace — see the contract in
  // `@volli/shared`'s VolliModelAccessIpcContract for why a channel that can
  // carry an API key stays off the instrumented, log-tapped one.
  registerModelAccessIpcHandlers(
    piModelAccess === null
      ? null
      : new ModelAccessSignInService({
          // Sign in with ChatGPT names this installation to OpenAI (Pi 0.99).
          pi: piSignIn(piModelAccess.models, {
            deviceId: () => {
              if (!dbHandle.ok) throw new Error("The local database is unavailable.");
              return installationId(dbHandle.db);
            },
          }),
        }),
    // When the runtime is down because the database never opened, the sign-in
    // surface must answer with the recorded (already-classified) reason — a
    // Node-ABI failure names the incompatibility, not a generic "unavailable"
    // (VC-76).
    dbHandle.ok ? undefined : `Sign-in is unavailable. ${dbHandle.error}`,
  );
  // The Web Access surface, on its own door beside sign-in and for the same
  // reason: one of its arguments is an API key.
  registerWebAccessIpcHandlers(
    webAccess,
    dbHandle.ok ? undefined : `Web access settings are unavailable. ${dbHandle.error}`,
  );
  // Decision models (VC-478): the setting, the cloud catalog with each
  // provider's sign-in state, and the connection test. No key crosses it.
  registerDecisionModelIpcHandlers(
    desktopDecisions,
    dbHandle.ok ? undefined : `Decision models are unavailable. ${dbHandle.error}`,
  );
  // Agent telemetry export (VC-119): its own door beside Web Access, because the
  // instrumented Session RPC wire is not where a switch governing
  // instrumentation belongs.
  registerAgentObservabilityIpcHandlers(
    agentObservability,
    dbHandle.ok
      ? undefined
      : `Agent telemetry settings are unavailable — the local database failed to open: ${dbHandle.error}`,
  );
  // Settings → Notifications (VC-295), and the second half of a notification
  // click. Its own door rather than the generic `app_state` write, so the
  // category vocabulary is validated in one place (docs/BOUNDARIES.md rule 5).
  registerNotificationIpcHandlers({
    settings: notifications.settings,
    takePendingActivation: () => notifications.takePendingActivation(),
    // A renderer asking for the parked click is a renderer that has just
    // subscribed to them (VC-295 round 2): until then main parks rather than
    // pushes, because a window exists long before anything inside it listens.
    markRendererReady: (sender) => {
      const window = BrowserWindow.fromWebContents(sender);
      if (window !== null) notifications.markRendererReady(window.id);
    },
    ...(dbHandle.ok
      ? {}
      : {
          unavailableReason: `Notification settings are unavailable — the local database failed to open: ${dbHandle.error}`,
        }),
  });
  // What each window is showing, for the focused-target rule. A `send`: it
  // flips on every navigation, needs no reply, and main's copy is advisory —
  // a report that never arrives costs one duplicate alert.
  ipcMain.on(
    "volli:notification-active-target" satisfies VolliIpcChannel,
    (event, ...args: unknown[]): void => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null) return;
      notifications.reportActiveTarget(window.id, args[0]);
    },
  );
  let terminalQuit: (event: { preventDefault(): void }) => void = noQuitAction;
  let unsavedQuit: (event: { preventDefault(): void }) => void = noQuitAction;
  let abortRepack = noQuitAction;
  /** Flag on, system shutdown (VC-577): what the two confirms would have torn down, unasked. */
  let systemShutdownTeardown = noQuitAction;
  /**
   * The flag-on shutdown's draft flush (VC-577), joined into the accepted
   * quit's host shutdown below so `app.exit` waits for it — bounded, so
   * power-off is never stalled. Resolved unless a shutdown teardown ran.
   */
  let systemShutdownFlush: Promise<unknown> = Promise.resolve();
  let hostClosing = false;
  /** Menu-bar mode (VC-577). Built once the window factory and updater exist. */
  let menuBarHost: MenuBarHost | null = null;
  const prepareHostQuit = (event: { preventDefault(): void }) => {
    // Flag off: the former listener order, including the two unconditional
    // stops on a refused attempt. Only the quit trigger is registered. Flag
    // on: the menu-bar branch decides after the confirms, and a host already
    // stopping is never offered it.
    prepareDesktopQuit(event, {
      stopAutomations: runtimeAutomations.stop,
      unsavedQuit,
      terminalQuit,
      abortRepack,
      ...(menuBarHost !== null && !hostClosing && isExperimentEnabled("cloud")
        ? { menuBar: menuBarHost, systemShutdownTeardown }
        : {}),
    });
  };
  const runtimeLifecycle = createSessionRuntimeLifecycle({
    host: hostCore,
    ports: hostPorts,
    runtime: sessionRuntime,
    rpc: () => sessionRpc,
    observability: agentObservability,
    delegation: sessionDelegation,
    delegationsFor: runtimeSessionAgents.recoveryDelegationsFor,
    services: () => preparedSessionFacade,
    stopProducers: () => {
      hostClosing = true;
      runtimeAutomations.stop();
      runtimeSessionAgents.stop();
    },
    installQuitHold: () =>
      registerAcceptedQuitCoordinator({
        lifecycle: quittingApp,
        shutdownNativeSessions: async () => {
          await Promise.all([hostCore.stop("quit"), systemShutdownFlush]);
        },
        shutdownAgentSocket: async () => {},
        prepareQuit: (event) => prepareHostQuit(event),
        stopBackgroundWork: () => webSealing.stop(),
        onShutdownDeadline: (deadlineMs) =>
          hostCore.warnIfFollowUpCleanCloseSkipped(
            `quit: shutdown deadline expired after ${deadlineMs}ms`,
          ),
        reportFailure: (error) => log.error("failed to coordinate app shutdown", { error }),
      }),
  });
  relayShellNotice = runtimeLifecycle.relayShellNotice;
  const desktopRuntime = createDesktopHostRuntime({
    host: hostCore,
    lifecycle: runtimeLifecycle,
    bindReady: (ready) => {
      sessionRpc = createSessionRpc(ready, handlersFor(ready));
      runtimeSessionAgents.toolDoor(ready);
    },
    stopProducers: () => {
      hostClosing = true;
      runtimeAutomations.stop();
      runtimeSessionAgents.stop();
      ptyManagerRef?.stopParkSweep();
    },
    closeSocket: shutdownAgentSocket,
  });
  const readyRuntimeServices = await desktopRuntime.start();
  // Reclaim attachment bytes nothing points at any more (VC-50) — a detached
  // file, or an abandoned new-Ticket composer draft, which attaches eagerly and
  // so leaves an unlinked Blob whenever a draft is thrown away. Housekeeping, so
  // it runs at boot rather than on the user's turn, and a failure is logged
  // rather than raised: garbage left behind is a disk cost, never a broken app.
  //
  // EXCEPT what a still-stored new-Ticket or provisional-chat Draft names
  // (VC-137/VC-358): each persists its attachment strip like it persists the
  // words, so those Blobs are waiting for an owner, not garbage. Reading the
  // raw app_state rows here — the renderer owns those envelope shapes, and the
  // shared readers are defensive enough that malformed state can at worst leak
  // bytes until the Draft is fixed or cleared.
  if (dbHandle.ok) {
    try {
      const appState = getAllAppState(dbHandle.db);
      const retained = new Set([
        ...draftAttachmentHashes(appState[NEW_TICKET_DRAFT_APP_STATE_KEY]),
        ...chatDraftAttachmentHashes(appState[CHAT_DRAFTS_APP_STATE_KEY]),
      ]);
      const { collected } = collectUnlinkedBlobs(
        dbHandle.db,
        blobsRoot(app.getPath("userData")),
        retained,
      );
      if (collected.length > 0) {
        log.info("collected unreferenced attachments", { count: collected.length });
      }
    } catch (error) {
      log.error("failed to collect unreferenced attachments", { error });
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
      log.warn("failed to read the stored canvas", { error });
      return resolveFirstPaint(blank);
    }
  };
  // The one answer to "what mode is the app in?" that main has, shared by the
  // window edge and by every ghostty chain read — a `theme = light:X,dark:Y`
  // pair resolves to a different half in each.
  const currentAppearance = (): ResolvedAppearance => currentFirstPaint().appearance;
  // Ghostty config read + live-reload watch, feeding the terminal appearance. The
  // `userData` root is where Volli's own ghostty OVERLAY files live (decision
  // #67). Registered after the db opens because the chain read needs the
  // resolved mode, which lives in `app_state`.
  registerGhosttyConfigIpc(fsDeps, currentAppearance);
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
        log.error("could not release session from directory", { sessionId, directory, error });
      },
    });
    for (const sessionId of report.stillOpen) {
      log.error("session is still bound to a directory being deleted", { sessionId, directory });
    }
    return report;
  };
  // Standard macOS menu, but with the View-menu zoom roles replaced by
  // renderer-driven CSS zoom (see menu.ts for the rationale). Registered here
  // (rather than up with the other pre-window setup) because File > Export
  // Database needs `dbHandle`, which doesn't exist yet at that point.
  registerDataIpcHandlers(dbHandle, {
    ...recoveredSessionClientPorts(readyRuntimeServices),
    listOpenNativeBindings,
    ...(liveHost === undefined
      ? {}
      : { detachedWork: liveHost.detachedWork, maintenance: liveHost.maintenance }),
    busyWorktreeSites,
    releaseAgentSites,
    // `volli:ticket-move` projects the host's move: its backward-move
    // interrupt and armed arrival (an Option-drag choice included) are the
    // handler's, exactly as they are for the socket's.
    handlers: handlersFor(readyRuntimeServices),
    // Where attachment bytes live (VC-50) — the same root the volli-blob:
    // protocol serves from and materialization copies out of.
    blobsRoot: blobsRoot(app.getPath("userData")),
    mcpSettings: mcpSettings ?? undefined,
    // Archiving or deleting a ticket drops its Sessions' saved tool output (VC-469).
    piSessionsDirectory,
    // A removed Workspace's board feed is released, its followers told to resnapshot.
    onProjectRemoved: (projectId) => boardFeed.dispose(projectId),
  });
  // Pi sidecar cleanup is a separate, explicit surface: registration performs
  // no scan and no deletion. The read-only inventory must run before its
  // confirmed reclaim can name any main-owned item ids.
  registerPiSessionOrphanIpcHandlers(dbHandle, piSessionsDirectory);
  // The orphan PROCESS sweep (VC-341), the same explicit shape one directory
  // over: registration scans nothing and signals nothing. Its liveness inputs
  // are read at CALL time — a Session that ends between two scans has to change
  // the answer — and the terminal manager is reached through the ref the
  // worktree guards already use, because this registration runs before it
  // exists.
  const orphanProcesses = liveHost?.maintenance.orphanProcesses ?? null;
  registerOrphanProcessIpcHandlers(dbHandle, orphanProcesses);
  // Global-artifacts + @file fs plumbing (file index/read/write, artifact
  // create, reveal, per-tab watch) plus the composer `/` picker's prompt
  // templates; same degraded-DB stance as registerDataIpcHandlers.
  registerFileIpcHandlers(
    dbHandle,
    {
      globalCommandsDir: join(fsDeps.userDataDir, "commands"),
      globalSkillsDir: globalSkillsDir(fsDeps.homeDir),
    },
    liveHost?.fileServices ?? createHostFileServices(hostPorts),
  );
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
  // Keep the host's former boot point. Nothing schedules before runtime recovery.
  runtimeAutomations.start(recoveredSessionAutomationPorts(readyRuntimeServices));
  const automationExecution =
    runtimeAutomations.kind === "live" ? runtimeAutomations.execution : { kind: "idle" as const };
  registerAutomationIpcHandlers(dbHandle, {
    service: runtimeAutomations.kind === "live" ? runtimeAutomations.service : null,
    runner: automationExecution.kind === "ready" ? automationExecution.runner : null,
    ...(automationExecution.kind === "idle"
      ? {}
      : { pendingArmedRuns: automationExecution.pendingArmedRuns }),
  });
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
    mintSessionToken: sessionTokens.mint,
    revokeSessionToken: sessionTokens.revoke,
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
  unsavedQuit = (event) => {
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
  };

  // The terminal door takes the same reader the structured door uses (VC-403):
  // one question about one machine, asked once.
  const ptyManager = registerTerminalIpcHandlers(
    dbHandle,
    sessionEngine,
    agentRuntime,
    concurrencyEnvReader,
    {
      ...(liveHost?.terminals.kind === "available" ? { manager: liveHost.terminals.manager } : {}),
      registerQuitGate: false,
    },
  );
  ptyManagerRef = ptyManager;
  terminalQuit = (event) => prepareTerminalQuit(ptyManager, event);
  // Flag on, logout/restart/shutdown (VC-577): the terminal confirm's killAll
  // and the windows' draft flush, with nothing that could refuse power-off.
  systemShutdownTeardown = () => {
    ptyManager.killAll();
    // Every window, a hidden menu-bar one included; joined by the accepted
    // quit's shutdown above, never longer than the bound.
    systemShutdownFlush = flushWindowState(
      BrowserWindow.getAllWindows(),
      SHUTDOWN_FLUSH_TIMEOUT_MS,
    );
  };
  registerBrowserTabIpcHandlers(browserTabs);
  registerBackgroundShellIpcHandlers(backgroundShells);
  // An archived Ticket's headless agent tabs have no one left to drive them
  // and nobody who can see them (VC-238 §6). Shown tabs are the person's.
  closeHeadlessTabsOnTicketArchive(browserTabs, subscribeTicketWake);
  // A smoke cannot take a model turn for $0, so the headless-tab lane opens a
  // Session tab through this door instead (`e2e/browser-headless-smoke.mjs`).
  // Two locks, not one: an unpackaged build AND the smoke's own flag. The flag
  // alone would ship a door that hands the whole tab host to anything that can
  // set an environment variable on a packaged app, which is a wider grant than
  // any test is worth. Smokes run the built-but-unpackaged app, so this is the
  // same door for them and no door at all for a release.
  if (isDev && process.env["VOLLI_SMOKE_BROWSER_HOST"] === "1") {
    (globalThis as { volliBrowserHost?: BrowserTabHost }).volliBrowserHost = browserTabs;
  }
  // The Session cursor overlay (VC-239): one small transparent view over the
  // on-screen Browser Tab, loading the app's own cursor page under its own
  // partition and five-verb preload — never the app bridge, and never inside
  // the page it sits over. Built lazily by the overlay on the first cursor.
  const cursorPageUrl =
    isDev && process.env["ELECTRON_RENDERER_URL"]
      ? new URL("/cursor.html", process.env["ELECTRON_RENDERER_URL"]).toString()
      : PACKAGED_RENDERER_CURSOR_URL;
  const cursorOverlay = createCursorOverlay({
    host: browserTabs,
    ipc: ipcMain,
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: join(__dirname, "cursor-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          transparent: true,
          session: session.fromPartition(CURSOR_OVERLAY_PARTITION),
        },
      });
      view.setBackgroundColor("#00000000");
      void view.webContents.loadURL(cursorPageUrl).catch((error: unknown) => {
        log.error("could not load the session cursor page", { error });
      });
      return view;
    },
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    // macOS is the one platform Electron reads the setting on; elsewhere the
    // cursor moves, which is the default a person who never asked expects.
    prefersReducedMotion: () =>
      process.platform === "darwin" &&
      systemPreferences.getAnimationSettings().prefersReducedMotion,
  });
  cursorOverlayRef = cursorOverlay;
  // A smoke seam (VC-239), unset in every ordinary launch: `browser-tab-smoke.mjs`
  // starts no Session and takes no model turn, yet has to prove a hold and a
  // visible cursor. It builds the SAME port the adapter builds — one factory,
  // `browserAgentPort`, so the two cannot drift — in a Session's name it
  // invents, and drives a tab exactly as a Session would. Gated on the
  // variable AND on an unpackaged app, like the other dev-only doors: a
  // shipped build exposes nothing whatever its environment says.
  if (isDev && process.env["VOLLI_BROWSER_PROBE"] === "1") {
    (globalThis as { volliBrowserProbe?: unknown }).volliBrowserProbe = {
      port: (scope: { projectId: string; ticketId: string | null }, sessionId: string) =>
        browserAgentPort({
          backend: browserTabs,
          scope,
          session: { sessionId, attachmentId: `${sessionId}:probe` },
          cursorFor: (tabId) => cursorOverlay.driverFor(tabId),
        }),
      heldBy: (tabId: string) => browserTabs.heldBy(tabId),
    };
  }
  // Takeover and ask-to-leave reach the holding Session in-band, as one-line
  // steers into its live turn (VC-239) — the same door supervision uses, so
  // the Session does not have to learn a takeover by failing on it.
  if (sessionRuntime !== null) {
    relayHoldNotices(browserTabs, {
      // The notice rides as a marked user message (VC-330): the metadata is
      // what lets the chat draw Volli's line as its own quiet row rather
      // than a bubble in the person's voice.
      steer: async (notice) => {
        const commandId = randomUUID();
        const delivered = await sessionRuntime.command({
          commandId,
          sessionId: notice.sessionId,
          origin: { kind: "volli", reason: "browser-notice" },
          command: {
            kind: "message.submit",
            delivery: "steer",
            message: holdNoticeMessage(notice, `${commandId}:message`),
          },
        });
        const status = delivered.receipt?.status;
        if (status !== "accepted" && status !== "completed") {
          throw new Error(delivered.receipt?.detail ?? `delivery ${status ?? "unknown"}`);
        }
      },
      log: hostLogger("browser").error,
    });
  }
  // Menu-bar entry's flush-and-ack barrier (VC-577): windows it is about to
  // destroy are hidden and no longer count as open, so a reopen during the
  // (bounded) flush builds a fresh window instead of finding a doomed one.
  const retiringWindows = new WeakSet<BrowserWindow>();
  const liveWindows = (): BrowserWindow[] =>
    BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !retiringWindows.has(window),
    );
  const clientStateFlush = createClientStateFlush({ newRequestId: () => randomUUID() });
  ipcMain.on(
    "volli:client-state-flushed" satisfies VolliIpcChannel,
    (_event, ...args: unknown[]): void => {
      clientStateFlush.acknowledge(args[0]);
    },
  );
  const flushWindowState = (
    windows: readonly BrowserWindow[],
    timeoutMs: number,
    onAcked?: (window: BrowserWindow) => void,
  ) =>
    clientStateFlush.flush(
      windows.map((window) => ({
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        requestFlush: (requestId: string) =>
          window.webContents.send("volli:client-state-flush" satisfies VolliIpcEvent, requestId),
        ...(onAcked === undefined ? {} : { onAcked: () => onAcked(window) }),
      })),
      timeoutMs,
    );
  const createOwnedWindow = (): BrowserWindow => {
    const window = createWindow(ptyManager, currentFirstPaint());
    // Browser Tabs are live machine resources, not durable documents. Once the
    // app window that can place them closes, keeping invisible remote pages
    // running would leave network/timers with no reachable owner.
    window.once("closed", () => browserTabs.closeAll());
    // And a closed window is showing nothing: its last reported target must not
    // linger and suppress an alert nobody can see (VC-295).
    const windowId = window.id;
    window.once("closed", () => notifications.forgetWindow(windowId));
    // A page that reloads, navigates, or crashes takes its click subscription
    // and its reported target with it, while the window id lives on. Drop
    // both, so the next click parks for the fresh page instead of being pushed
    // into one that no longer listens. Same-document navigations (a hash
    // change) keep the page and are skipped.
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) notifications.forgetRenderer(windowId);
    });
    window.webContents.on("render-process-gone", () => notifications.forgetRenderer(windowId));
    // A committed page reset strands any Browser plane the old page had put on
    // screen (VC-424): a native view is the window's child, not the page's, so
    // it goes on compositing over a fresh app UI that cannot hide a tab it has
    // never heard of. Its own events, not the two above — a plane must not come
    // off for a navigation that never commits. Parking is per window, and the
    // tabs, their holds and their engines all survive it: a pane in the new
    // page shows them again.
    parkBrowserPlanesOnRendererReset({
      host: browserTabs,
      window,
      contents: window.webContents,
      log: hostLogger("browser").error,
    });
    return window;
  };
  // A notification clicked with every window closed asks for one (macOS keeps
  // the app alive), and the renderer collects the parked target as it
  // subscribes. Bound here because this is where the factory exists.
  notifications.bindWindowOpener(() => {
    // Through the menu-bar host once it exists, so a click on a windowless
    // host also brings the Dock icon back (VC-577). Outside menu-bar mode its
    // reveal is exactly this line's former body.
    if (menuBarHost !== null) menuBarHost.reveal();
    else if (BrowserWindow.getAllWindows().length === 0) createOwnedWindow();
  });
  const mainWindow = createOwnedWindow();
  const transcriptRepackAbort = new AbortController();
  abortRepack = () => transcriptRepackAbort.abort();
  mainWindow.webContents.once("did-finish-load", () => {
    // Transcript repack is migration-by-sibling rather than an in-place
    // rewrite. Give first paint five seconds of quiet, then process only small
    // batches with a pause between them. Every individual failure is kept for
    // the next launch, with its legacy bytes untouched.
    const repackDelay = setTimeout(() => {
      if (hostClosing) return;
      const repack = repackLegacyTranscriptArtifacts(transcriptArtifacts, {
        batchSize: 25,
        signal: transcriptRepackAbort.signal,
        shouldBackOff: async () => {
          if (sessionRuntime === null) return false;
          const sessionIds = new Set(
            sessionRuntime.openNativeBindings().map((binding) => binding.sessionId),
          );
          for (const sessionId of sessionIds) {
            if ((await sessionRuntime.projection({ sessionId })).projection.turnActive) return true;
          }
          return false;
        },
        onError: (name, error) => {
          repackLog.error("transcript kept unpacked", { name, error });
        },
      })
        .then((report) => {
          repackLog.info("transcript repack finished", {
            scanned: report.scanned,
            repacked: report.repacked,
            skipped: report.skipped,
          });
        })
        .catch((error) => {
          repackLog.error("transcript repack scan failed", { error });
        });
      liveHost?.detachedWork.track(repack);
    }, 5_000);
    repackDelay.unref();

    // The probe converts shell failure to a kept outcome. Keep an explicit
    // rejection handler here too so an unexpected mutation/logging failure
    // can never become an unhandled rejection from this fire-and-forget path.
    void loginPathBootstrap.apply().catch((error) => {
      log.error("failed to apply login PATH", { error });
    });
    // The second, INTERACTIVE pass (VC-94's A3), which is what recovers the
    // directories a user's `.zshrc` exports — nvm, bun, rbenv, pyenv, mise.
    // Here rather than on the boot path because an rc file may prompt, and a
    // prompt before the first window is a hang nobody can answer; here rather
    // than awaited because nothing may wait on it. If it wedges for its whole
    // timeout, the app is exactly as usable as it was before this existed.
    void loginPathBootstrap.applyInteractive().catch((error) => {
      log.error("failed to apply interactive login PATH", { error });
    });
    // Web search keys' sealed mirror (VC-643): rebuilt from the database on
    // every launch, deletes included. Like the repack above, it waits out
    // first paint and boot. Cancelled, with anything it started, the moment a
    // quit is accepted (`stopBackgroundWork` above). Never rejects; the
    // outcome is logged above.
    webSealing.afterFirstPaint();
  });

  // Startup orphan SCAN (VC-284). This used to be a destructive sweep: launching
  // the app pruned git metadata and deleted every clean orphan past the
  // retention window, with no confirmation and nothing on screen that had asked.
  // Starting an app is not consent to delete, so a launch now only LOOKS — the
  // report it produces is what Settings → Storage lists, and removing anything
  // takes an explicit, confirmed cleanup through volli:worktree-orphan-cleanup.
  // Deferred to did-finish-load so it never competes with first paint; a scan
  // failure is logged, not thrown.
  //
  // The reconcile beside it closes the other half: a cleanup the app did not
  // live long enough to finish is stamped interrupted here, so Storage can show
  // what completed and what was never attempted instead of re-offering both.
  if (liveHost !== undefined) {
    const db = liveHost.database.db;
    mainWindow.webContents.once("did-finish-load", () => {
      // Each announced-but-unsettled item is asked of git and disk before the
      // run is stamped, so an already-removed folder is recorded as removed
      // rather than described as work nobody attempted (review C3). Read-only,
      // and never fatal to a launch.
      if (hostClosing) return;
      const reconcile = reconcileInterruptedCleanups({
        worktree: liveHost.worktreeDeps,
        engine: orphanCleanupEngine(db),
      })
        .then((runs) => {
          for (const run of runs) {
            const done = run.items.filter((item) => item.state === "completed").length;
            worktreeLog.info("cleanup was interrupted", {
              runId: run.id,
              completed: done,
              items: run.items.length,
            });
          }
        })
        .catch((error) => {
          worktreeLog.error("cleanup history unreadable", { error });
        });
      liveHost.detachedWork.track(reconcile);
      const scan = startOrphanScan(liveHost.worktreeDeps, { busyWorktreeSites })
        .then((report) => {
          worktreeLog.info("orphan scan finished", {
            prunable: report.prunable.length,
            removable: report.removable.length,
            keptRecent: report.keptRecent.length,
            dirty: report.dirty.length,
          });
        })
        .catch((error) => {
          worktreeLog.error("orphan scan failed", { error });
        });
      liveHost.detachedWork.track(scan);
    });

    // Retention merge-watch (CONCEPT #16, issue #76): the background 60s poll of
    // each worktree ticket's PR, plus an on-focus trigger for immediacy. Started
    // after first paint so it never competes with boot; a background read
    // failure is silent (a read is not a mutation). Main-process focus detection
    // is the established pattern (park/quit gates live here, not the renderer).
    // The reclaim seams (VC-113) are handed over here because this is the only
    // scope that can answer them — the same two the destructive IPC guards use,
    // so an automatic removal refuses everything a manual one would.
    // Construct the shared retention watch at its former boot point; both
    // maintenance loops still start only after the first window paints.
    void liveHost.maintenance.retention;
    mainWindow.webContents.once("did-finish-load", () => liveHost.maintenance.start());
    app.on("browser-window-focus", () => liveHost.maintenance.triggerRetention());
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
    notify: (request) => notifications.deliver(request),
    log: hostLogger("auto-update").info,
    onStateChange: (state) => {
      broadcastUpdateState(state);
      // The Tray's "Install Update When Idle" follows the staged update.
      menuBarHost?.refresh();
    },
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
            log.warn("could not read session", { sessionId, error });
          }),
    unsavedDrafts: unsavedDocumentNames,
    // Flag on (VC-577): the same synchronous read the Tray and the quit
    // verdict use, shells included. Flag off: null, and today's count above.
    liveWork: () =>
      isExperimentEnabled("cloud") && liveHost !== undefined ? liveHost.liveWork.current() : null,
    beginInstall: beginAcceptedUpdateInstall,
    abandonInstall: abandonAcceptedUpdateInstall,
    // Absent on a broken db, which is the one case this whole registration is
    // deliberately outside `dbHandle.ok` for: the install path must survive it,
    // and a channel setting with nowhere to persist says so rather than
    // pretending. VC-111 — retires the hand-run `sqlite3` INSERT.
    channel: dbHandle.ok
      ? {
          read: () => readUpdateChannel(dbHandle.db),
          // The updater rides along so entering canary widens the RUNNING
          // process too — "Check now" right after switching must actually
          // see prereleases. One-way; see `writeUpdateChannel`.
          write: (channel) => writeUpdateChannel(dbHandle.db, channel, Date.now(), autoUpdater),
        }
      : undefined,
  });

  // Menu-bar mode (VC-577, D-A2 (b)): with the `cloud` flag on, ⌘Q over live
  // host work keeps this process running as the Mac's host, windowless and
  // Dock-less, with a Tray. Built for every launch so reopening goes through
  // one door; with the flag off nothing ever enters the mode, and its reveal
  // is exactly "open a window if none exists".
  const smokeSettleMs = menuBarSmokeSettleMs(isDev, process.env);
  const menuBar = createMenuBarHost({
    // The mechanics smoke's longer settle (VC-709); a release never has one.
    ...(smokeSettleMs === undefined ? {} : { settleMs: smokeSettleMs }),
    // Read from the host, never a renderer. A degraded host runs nothing.
    liveWork: liveHost?.liveWork ?? {
      current: () => NO_LIVE_WORK,
      subscribe: () => () => {},
      tryBeginIdleExit: () => true,
      abandonIdleExit: () => {},
    },
    browserTabs: {
      sessionTabCount: () => browserTabs.sessionTabCount(),
      closeForMenuBar: () => browserTabs.closeAllForAgents(BROWSER_CLOSED_FOR_MENU_BAR),
      reopen: () => browserTabs.reopenForAgents(),
    },
    confirmCloseAgentTabs,
    windows: {
      count: () => liveWindows().length,
      // `destroy`, not `close`: the quit's own unsaved-drafts and terminal
      // confirms already answered, and a window `close` would ask again.
      // `destroy` skips `beforeunload`, so each renderer is asked to flush
      // its pending drafts first, and each window is destroyed only from its
      // own ack. Hidden at once, so the person sees the quit take effect.
      // Menu-bar entry is not power-off: a window that has not acked is never
      // destroyed — past the overdue mark it is logged and stays hidden until
      // a reveal reuses it or a real quit tears it down.
      closeAll: () => {
        const closing = liveWindows();
        for (const window of closing) {
          retiringWindows.add(window);
          window.hide();
        }
        void flushWindowState(closing, MENU_BAR_FLUSH_OVERDUE_MS, (window) => {
          // A reveal that reused this window took it back: keep it.
          if (!retiringWindows.has(window) || window.isDestroyed()) return;
          retiringWindows.delete(window);
          window.destroy();
        }).then(({ unanswered }) => {
          if (unanswered > 0) {
            hostLogger("menu-bar").warn("windows still saving drafts; kept hidden, not destroyed", {
              unanswered,
            });
          }
        });
      },
      // A hidden window still waiting on its flush is reused rather than
      // duplicated: its renderer, and its unsaved drafts, are still there.
      open: () => {
        const retained = BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && retiringWindows.has(window),
        );
        if (retained === undefined) {
          createOwnedWindow();
          return;
        }
        retiringWindows.delete(retained);
        revealWindow(retained, nativeWindowPolicy);
      },
    },
    dock: {
      hide: () => hideDockForMenuBar(app, nativeWindowPolicy),
      show: () => showDockAfterMenuBar(app, nativeWindowPolicy),
    },
    tray: electronMenuBarTray((item) => {
      if (item === "open") menuBar.reveal({ focus: true });
      else if (item === "quit") menuBar.quitFromTray();
      else if (item === "install-when-idle") menuBar.toggleInstallWhenIdle();
    }),
    power: electronMenuBarPower(),
    update: {
      ready: () => autoUpdate.state().phase === "downloaded",
      installInFlight: updateInstallQuitInFlight,
      install: () => {
        const started = installDownloadedUpdate({
          update: autoUpdate,
          beginInstall: beginAcceptedUpdateInstall,
          abandonInstall: abandonAcceptedUpdateInstall,
        });
        if (!started.ok) {
          hostLogger("menu-bar").error("update install failed", { error: started.error });
        }
        return started.ok;
      },
    },
    confirmQuit: confirmMenuBarQuit,
    quit: () => app.quit(),
    focusApp: () => {
      if (!nativeWindowPolicy.enabled) app.focus({ steal: true });
    },
  });
  menuBarHost = menuBar;
  revealWindowForLaunch = () => menuBar.reveal({ focus: true });
  // The menu-bar smokes' seam (`e2e/menu-bar-*-smoke.mjs`): a CI runner has no
  // model to keep a turn live, so the mechanics smoke enters the mode through
  // the controller itself. Two locks, as with the browser host above: an
  // unpackaged build AND the smoke's own flag — never a door on a release.
  if (isDev && process.env["VOLLI_SMOKE_MENU_BAR_HOST"] === "1") {
    (globalThis as { volliMenuBarHost?: MenuBarHost }).volliMenuBarHost = menuBar;
  }
  // Logout, restart and shutdown (`NSWorkspaceWillPowerOffNotification`)
  // arrive here BEFORE macOS asks the app to quit: the quit that follows must
  // not be refused, or Volli would cancel the person's logout. Never
  // preventDefault: that would delay the system instead.
  powerMonitor.on("shutdown", () => menuBar.noteSystemShutdown());

  let shimPath = join(runtimePaths.binDir, "volli");

  // The File → Remove tombstone (VC-52). Install is background and has no
  // opt-out, so an EXPLICIT removal must leave something behind that the next
  // boot honors — otherwise File → Remove would be silently undone at relaunch.
  // Cleared by File → Install. The old consent key (`volli:agent-tools-consent`)
  // is deliberately ignored: "deferred" was a first-boot dialog answer that
  // latched forever, which is the failure this ticket removes.
  const agentToolsRemoved = (): boolean =>
    dbHandle.ok && getAllAppState(dbHandle.db)[AGENT_TOOLS_REMOVED_APP_STATE_KEY] === "true";

  // The skill installer targets the real OS home via app.getPath("home"), which
  // on macOS ignores $HOME — so a
  // headless installer-idempotency e2e cannot redirect it into a throwaway
  // profile. VOLLI_AGENT_HOME overrides the install/refresh/uninstall home for
  // exactly that. Unset in production, so the real home is used unchanged.
  // Harness mode makes the contained scratch home authoritative (VC-703): the
  // boot was refused above unless it sits inside the instance's scratch root.
  const agentToolsHome = harnessGuard.active
    ? harnessGuard.containment.agentHome
    : ((isDev ? process.env["VOLLI_AGENT_HOME"] : undefined) ?? app.getPath("home"));
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
      log.warn("cli link is not volli's; left alone", {
        path: userCliLinkPath(agentToolsHome),
        target: link.target ?? "a regular file",
      });
    }
    const legacy = await cleanupLegacyGlobalCliLink({
      shimPath,
      managedTargets: managedSiblingShims,
    });
    if (legacy === "kept") {
      log.info(
        "legacy /usr/local/bin/volli link left in place (admin-owned; ~/.local/bin shadows it)",
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
      setAppState(dbHandle.db, AGENT_TOOLS_REMOVED_APP_STATE_KEY, "false", Date.now());
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
        setAppState(dbHandle.db, AGENT_TOOLS_REMOVED_APP_STATE_KEY, "false", Date.now());
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
        setAppState(dbHandle.db, AGENT_TOOLS_REMOVED_APP_STATE_KEY, "true", Date.now());
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
          sessionEnvironment: async (cwd) => {
            // The install command reads the same lockfile the requirements
            // did, so both share one memo: the walk happens once, and the
            // command a user is told to run cannot name a different manager
            // than the tool they were told to have.
            const pathExists = memoizedPathExists(existsSync);
            return {
              ...(await readSessionEnvironment(cwd, cwd, pathExists)),
              installCommand: cwd === null ? null : workspaceInstallCommand(cwd, cwd, pathExists),
            };
          },
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
    // The probe runs IN the scoped project: `volli doctor` judges which
    // tools are required from its own cwd (VC-157), and main's cwd is `/`
    // under launchd — which would imply no project and quietly pass a
    // genuinely missing `git`.
    doctor: (cwd) => probeCliDoctor({ shellFile: resolveShell(process.env).file, cwd }),
    repair: async () => {
      await repairSessionEnvironment();
    },
  });

  // About's support metadata (VC-293): the build, release line, OS and schema
  // version a report has to name. Registered beside the CLI surface and, like
  // it, OUTSIDE `dbHandle.ok` — a profile that would not open is exactly the
  // launch whose report matters, and the handler answers unavailable rather
  // than vanishing or presenting partial metadata. Every dep reads at CALL time.
  registerSupportIpcHandlers({
    appVersion: () => app.getVersion(),
    database: () => (dbHandle.ok ? dbHandle.db : null),
    platform: process.platform,
    arch: process.arch,
  });

  try {
    const execute =
      liveHost !== undefined
        ? createHostAgentCommands(hostPorts, {
            db: liveHost.database.db,
            appVersion: app.getVersion(),
            // The verifying half of the same registry the attachments mint from.
            // Without it every socket caller is unauthenticated by default, which
            // is the fail-closed direction (VC-163).
            verifySessionToken: sessionTokens.verify,
            observeSession: (sessionId, lines) => ptyManager.peek(sessionId, lines),
            ...recoveredSessionCommandPorts(readyRuntimeServices),
            // The same map the renderer's channel projects: an explicit
            // `volli ticket move` is the other Deliberate-move door, with the
            // same interrupt and the same main-owned pending arrival (VC-668).
            handlers: handlersFor(readyRuntimeServices),
            // The `env` block `volli identify` prints (VC-94): the PATH main
            // adopted, its latest non-interactive provenance, the measured tools
            // resolved against it (and which of them this workspace implies),
            // and the workspace dependency state. It awaits
            // the one current pass — boot normally, a fresh pass after repair —
            // so the report never describes a PATH from before adoption finished
            // and is read at CALL time, never captured.
            sessionEnv: (cwd, projectRoot) => readSessionEnvironment(cwd, projectRoot),
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
              // A writing caller is live exactly while its attachment token is
              // valid at the socket door. PTY membership excludes structured
              // attachments, so it cannot answer this diagnostic truthfully.
              liveSessionIds: sessionTokens.liveSessionIds(),
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
              // The orphan process count (VC-341). Read from the latest sweep
              // when it is recent enough to still be true, and swept afresh
              // otherwise: `doctor` may cost a `ps` and an `lsof`, but two
              // doctors in a row must not cost two. A launch with no sweep
              // leaves this undefined, which the check reports as unknown
              // rather than as a healthy zero.
              ...(orphanProcesses === null
                ? {}
                : {
                    orphanProcesses: await orphanProcesses
                      .freshInventory()
                      .then((inventory) => ({
                        total: inventory.candidates.length,
                        reapable: inventory.reapableCount,
                      }))
                      .catch(() => undefined),
                  }),
            }),
            doctorRepair: repairSessionEnvironment,
          }).execute
        : async () =>
            ({
              v: 1,
              ok: false,
              error: makeAgentError(
                "DB_UNAVAILABLE",
                hostCore.database.ok ? "The database is unavailable." : hostCore.database.error,
              ),
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
        log.info(WRAPPER_READY_MESSAGE);
      } catch (error) {
        log.error(WRAPPER_FAILURE_MESSAGE, { error });
      }
    } catch (error) {
      log.error("failed to generate CLI shim", { error });
    }
  } catch (error) {
    // The bundled `volli` CLI is entirely dead for this launch with no other
    // signal — a lightweight native Notification (the same mechanism already
    // used for lifecycle notices) surfaces it instead of only a console line
    // no one but a developer will ever see.
    log.error("failed to start agent socket", { error });
    // Operational (VC-295): a fault about Volli itself, whose only alternative
    // is a console line, so no preference is consulted and there is nothing to
    // open — the CLI is what is broken, not a screen.
    notifications.deliver({
      producer: "cli-socket-failed",
      title: "Volli CLI unavailable",
      body: "The agent socket failed to start. CLI commands won't work this launch.",
      target: null,
    });
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
      log.error("background agent-tools install failed", { error });
    });
  }

  app.on("activate", () => {
    // An activation means a noted logout did not happen (VC-577): the next
    // ⌘Q keeps its turns again. Inert with the flag off — only the flag-on
    // quit branch reads that latch.
    menuBar.noteActivated();
    // On macOS it's common to re-create a window when the dock icon is
    // clicked and there are no other windows open. A menu-bar host (VC-577)
    // also leaves menu-bar mode and shows its Dock icon again; otherwise the
    // reveal is exactly this re-creation. A window menu-bar entry hid while
    // its drafts flush does not count as open (flag off: there is none).
    if (liveWindows().length === 0) {
      menuBar.reveal();
    }
  });
});
void appStartup.catch((error: unknown) => {
  if (error instanceof SessionRuntimeClosingError) return;
  log.error("failed to finish app startup", { error });
});

app.on("window-all-closed", () => {
  // On macOS it's common for applications to stay active until the user
  // quits explicitly with Cmd + Q.
  if (process.platform !== "darwin") {
    app.quit();
  }
});

registerAgentSocketWillQuit({
  lifecycle: quittingApp,
  shutdownAgentSocket,
  reportFailure: (error) => {
    log.error("failed to close the agent socket during app shutdown", { error });
  },
});

/** No runtime, no bridge: the degraded Session RPC handlers answer instead. */
function createSessionRpc(
  ready: RecoveredSessionServices<RuntimeSessionFacade>,
  handlers: HostHandlerMap,
): ReturnType<typeof registerSessionRpcIpcHandlers> | null {
  return recoveredRuntimeSessionServices(ready).runtime === null
    ? null
    : // The router's projection of the map: its policy at the map, then the handler.
      registerSessionRpcIpcHandlers({ handlers: admittedHandlers(handlers, ROUTER_POLICY) });
}
