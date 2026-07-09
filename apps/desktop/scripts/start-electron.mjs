import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

const mainEntry = NodePath.resolve(desktopDir, "dist-electron/main.cjs");
if (!NodeFS.existsSync(mainEntry)) {
  console.error("[volli] dist-electron/main.cjs is missing — run `pnpm run build` first.");
  process.exit(1);
}

// The electron package's module export IS the absolute binary path string —
// require() also fetches the ~100MB binary on first use if it is missing.
const electronBinary = require("electron");

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// A stray ELECTRON_RENDERER_URL would make the (unpackaged) built app load the
// dev server instead of dist/index.html — `start` never wants the dev URL.
delete childEnv.ELECTRON_RENDERER_URL;

// Shorter than dev.mjs's 1.5s escalation so a stuck Electron is SIGKILLed
// promptly when this script itself is signaled to stop.
const forcedShutdownTimeoutMs = 1_200;

let shuttingDown = false;

const child = NodeChildProcess.spawn(electronBinary, ["dist-electron/main.cjs"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
  detached: true,
});

function childIsAlive() {
  return child.exitCode === null && child.signalCode === null;
}

// Electron (and the helper processes it spawns) lives in its own process
// group, so shutdown signals the whole tree with one kill(-pid) — the same
// model dev.mjs / dev-electron.mjs use for their children.
function killChildGroup(signal) {
  if (typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (!childIsAlive()) {
    return;
  }

  killChildGroup("SIGTERM");
  const timer = setTimeout(() => {
    killChildGroup("SIGKILL");
  }, forcedShutdownTimeoutMs);
  timer.unref();
}

child.on("error", (error) => {
  console.error("[volli] failed to spawn Electron:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

// Installed so a programmatic kill of this script (or a closed terminal,
// which sends SIGHUP) tears down the Electron child's process group instead
// of orphaning it — matching dev.mjs / dev-electron.mjs.
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGHUP", shutdown);
