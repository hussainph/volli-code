import * as NodeChildProcess from "node:child_process";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ensureElectron } from "./ensure-electron.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

// Runs as the pack config's onSuccess command: tsdown tree-kills the previous
// run and re-runs this script after EVERY successful rebuild of main+preload,
// so there is no restart machinery here — wait for the renderer dev server,
// spawn Electron once, exit when it exits. A normal in-app quit just ends this
// run; `vp pack --watch` stays alive and relaunches Electron on the next
// rebuild.

const scriptDir = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

const rendererUrl = process.env.ELECTRON_RENDERER_URL?.trim();
if (!rendererUrl) {
  throw new Error("ELECTRON_RENDERER_URL is required for desktop development.");
}

const rendererServer = new URL(rendererUrl);
const port = Number.parseInt(rendererServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`ELECTRON_RENDERER_URL must include an explicit port: ${rendererUrl}`);
}

// Shorter than dev.mjs's 1.5s escalation so a stuck Electron is SIGKILLed by
// this script before dev.mjs SIGKILLs this script (which would orphan it).
const forcedShutdownTimeoutMs = 1_200;

let app = null;
let shuttingDown = false;

function appIsAlive() {
  return app !== null && app.exitCode === null && app.signalCode === null;
}

// Electron (and the helper processes it spawns) lives in its own process
// group, so shutdown signals the whole tree with one kill(-pid) — the same
// model dev.mjs uses for its children.
function killAppGroup(signal) {
  if (app === null || typeof app.pid !== "number") {
    return;
  }
  try {
    process.kill(-app.pid, signal);
  } catch {
    app.kill(signal);
  }
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (!appIsAlive()) {
    process.exit(exitCode);
  }

  killAppGroup("SIGTERM");
  const timer = setTimeout(() => {
    killAppGroup("SIGKILL");
  }, forcedShutdownTimeoutMs);
  timer.unref();

  app.once("exit", () => {
    clearTimeout(timer);
    process.exit(exitCode);
  });
}

// Installed before the wait so tsdown's tree-kill (rebuild/Ctrl-C) can abort a
// launch that is still waiting on the dev server.
process.once("SIGINT", () => {
  shutdown(130);
});
process.once("SIGTERM", () => {
  shutdown(143);
});
process.once("SIGHUP", () => {
  shutdown(129);
});

await waitForResources({
  baseDir: desktopDir,
  files: ["dist-electron/main.cjs", "dist-electron/preload.cjs"],
  tcpHost: rendererServer.hostname,
  tcpPort: port,
});

if (!shuttingDown) {
  // Ensure the Electron binary is present, then resolve it. The electron
  // package's module export IS the absolute binary path string.
  ensureElectron();
  const electronBinary = require("electron");

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  app = NodeChildProcess.spawn(electronBinary, ["dist-electron/main.cjs"], {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
    detached: true,
  });

  app.once("error", (error) => {
    console.error("[volli] failed to spawn Electron:", error);
    if (!shuttingDown) {
      shuttingDown = true;
      process.exit(1);
    }
  });

  app.once("exit", (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      process.exit(signal ? 1 : (code ?? 0));
    }
  });
}
