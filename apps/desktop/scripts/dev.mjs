import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ensureElectron } from "./ensure-electron.mjs";

const scriptDir = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(scriptDir, "..");

// The renderer dev server. `vp pack --watch` rebuilds main/preload and, via the
// config's env-gated onSuccess, launches Electron pointed at this URL.
const rendererUrl = "http://localhost:5173";
const forcedShutdownTimeoutMs = 1_500;

// Fetch the Electron binary up front so neither watcher stalls on first launch.
ensureElectron();

function resolveVpBinary() {
  const local = NodePath.join(desktopDir, "node_modules", ".bin", "vp");
  return NodeFS.existsSync(local) ? local : "vp";
}

const vpBinary = resolveVpBinary();

let shuttingDown = false;
let firstExitCode = null;
const children = [];

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

// The vp bin is a wrapper that spawns node grandchildren (pack-bin.js, the dev
// server, dev-electron, Electron itself). Killing only the direct child orphans
// that whole tree, so each child gets its own process group (detached) and
// shutdown signals the group via kill(-pid).
function killGroup(child, signal) {
  if (typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function spawnChild(args, extraEnv) {
  const child = NodeChildProcess.spawn(vpBinary, args, {
    cwd: desktopDir,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    detached: true,
  });

  children.push(child);

  child.once("error", (error) => {
    console.error(`[volli] failed to spawn \`${vpBinary} ${args.join(" ")}\`:`, error);
    if (firstExitCode === null) {
      firstExitCode = 1;
    }
    void shutdown();
  });

  child.once("exit", (code, signal) => {
    if (firstExitCode === null) {
      firstExitCode = signal ? 1 : (code ?? 0);
    }
    void shutdown();
  });

  return child;
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    if (isAlive(child)) {
      killGroup(child, "SIGTERM");
    }
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const child of children) {
        if (isAlive(child)) {
          killGroup(child, "SIGKILL");
        }
      }
      resolve();
    }, forcedShutdownTimeoutMs);
    timer.unref();

    let remaining = children.filter(isAlive).length;
    if (remaining === 0) {
      clearTimeout(timer);
      resolve();
      return;
    }

    for (const child of children) {
      if (!isAlive(child)) {
        continue;
      }
      child.once("exit", () => {
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });

  process.exit(firstExitCode ?? 0);
}

spawnChild(["dev"], {});
spawnChild(["pack", "--watch"], {
  VOLLI_DESKTOP_DEV: "1",
  ELECTRON_RENDERER_URL: rendererUrl,
});

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
// Closing the terminal sends SIGHUP here but not to the detached children —
// without this handler the whole dev tree (Vite, pack watcher, Electron)
// leaks, and the orphaned Vite server keeps port 5173 (strictPort) busy.
process.once("SIGHUP", () => {
  void shutdown();
});
