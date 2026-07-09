import { app, BrowserWindow } from "electron";
import { join } from "path";
import { ticketBranchName } from "@volli/shared";

const isDev = !app.isPackaged;

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Keeps the window above the sidebar's 768px mobile breakpoint so the
    // shadcn sidebar never swaps into its Sheet (mobile drawer) mode.
    minWidth: 940,
    minHeight: 600,
    show: false,
    // Slack-style chrome: no title bar, traffic lights floating over the
    // renderer's project rail. The rail paints its own drag region
    // (.app-region-drag in globals.css).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
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

  // In dev, scripts/dev.mjs injects ELECTRON_RENDERER_URL and runs the Vite dev
  // server there for HMR. In production, load the built renderer from disk.
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  // Proves vp pack bundled the workspace TS source (@volli/shared) into main.cjs
  // via deps.alwaysBundle, rather than leaving an unresolved runtime require().
  console.log("[volli] shared wiring OK:", ticketBranchName("VC-0", "monorepo migration"));

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
