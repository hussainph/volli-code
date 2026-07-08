import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

// electron@43 ships NO lifecycle install scripts: it fetches its ~100MB binary
// lazily on first `require('electron')`. electron-vite used to trigger that;
// under the vp monorepo this script is the single, deterministic place that
// guarantees the binary exists before we ever spawn it.

const require = createRequire(import.meta.url);

function electronPackageDir() {
  return NodePath.dirname(require.resolve("electron/package.json"));
}

/**
 * Returns the absolute path to the installed Electron binary, or `null` when it
 * has not been fetched yet. The binary is present iff `path.txt` exists AND the
 * file it points at (relative to `<electron>/dist`) exists on disk.
 */
function resolveInstalledBinary() {
  const electronDir = electronPackageDir();
  const pathTxt = NodePath.join(electronDir, "path.txt");
  if (!NodeFS.existsSync(pathTxt)) {
    return null;
  }

  const relativeBinary = NodeFS.readFileSync(pathTxt, "utf-8").split(/\r?\n/)[0].trim();
  if (!relativeBinary) {
    return null;
  }

  const binary = NodePath.join(electronDir, "dist", relativeBinary);
  return NodeFS.existsSync(binary) ? binary : null;
}

export function ensureElectron() {
  const existing = resolveInstalledBinary();
  if (existing) {
    return existing;
  }

  const electronDir = electronPackageDir();
  const installScript = NodePath.join(electronDir, "install.js");
  const result = NodeChildProcess.spawnSync(process.execPath, [installScript], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Electron install.js exited abnormally (status ${result.status ?? "null"}, signal ${
        result.signal ?? "null"
      }).`,
    );
  }

  const installed = resolveInstalledBinary();
  if (!installed) {
    throw new Error(
      "Electron binary is still missing after running install.js — delete node_modules/electron and reinstall.",
    );
  }

  return installed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const binary = ensureElectron();
  console.log(`[volli] electron binary ready: ${binary}`);
}
