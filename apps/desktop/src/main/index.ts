import { app, BrowserWindow, session } from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage, ticketBranchName } from "@volli/shared";
import type { VolliIpcEvent } from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { registerDataIpcHandlers } from "./data-ipc";
import { openVolliDb } from "./db";
import { registerGhosttyConfigIpc } from "./ghostty-config";
import { registerIpcHandlers } from "./ipc";
import { registerAppMenu } from "./menu";
import { registerTerminalIpcHandlers } from "./pty";
import { registerArtifactIpcHandlers } from "./volli-fs";

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

function createWindow(): void {
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

  // In dev, scripts/dev.mjs injects ELECTRON_RENDERER_URL and runs the Vite dev
  // server there for HMR. In production, load the built renderer from disk.
  // DevTools is not auto-opened — toggle it with ⌥⌘I when needed.
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  if (isDev) {
    // Dev smoke-check that vp pack bundled the workspace TS source (@volli/shared)
    // into main.cjs via deps.alwaysBundle rather than leaving an unresolved
    // runtime require(). Gated to dev so it never prints on a production boot.
    console.log("[volli] shared wiring OK:", ticketBranchName("VC-0", "monorepo migration"));
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

  // Standard macOS menu, but with the View-menu zoom roles replaced by
  // renderer-driven CSS zoom (see menu.ts for the rationale).
  registerAppMenu();
  registerIpcHandlers();
  // Boots the PTY multiplexer and its before-quit teardown (kills all PTYs).
  registerTerminalIpcHandlers();
  // Ghostty config read + live-reload watch, feeding restty's appearance.
  registerGhosttyConfigIpc();

  // Open (creating + migrating if needed) the SQLite db before the window
  // exists, so the renderer's boot-time volli:data-bootstrap call always has
  // somewhere to land. VOLLI_DB_PATH overrides the path (dev/tests/e2e);
  // otherwise it's <userData>/volli.db, made possible sharing one userData
  // dir across dev/packaged by the app.setName call above. Failure here must
  // never crash main or leave invoke() hanging: register every data IPC
  // channel with a typed { ok: false, error } response instead, so the
  // renderer can surface the failure like any other failed mutation.
  const dbPath = process.env["VOLLI_DB_PATH"] ?? join(app.getPath("userData"), "volli.db");
  let dbHandle: DbHandle;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    dbHandle = { ok: true, db: openVolliDb(dbPath) };
  } catch (error) {
    dbHandle = { ok: false, error: errorMessage(error) };
    console.error("[volli] failed to open database:", dbHandle.error);
  }
  registerDataIpcHandlers(dbHandle);
  // `.volli` artifacts fs plumbing (list/read/write/create/promote/watch);
  // same degraded-DB stance as registerDataIpcHandlers.
  registerArtifactIpcHandlers(dbHandle);

  createWindow();

  app.on("activate", () => {
    // On macOS it's common to re-create a window when the dock icon is
    // clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
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
