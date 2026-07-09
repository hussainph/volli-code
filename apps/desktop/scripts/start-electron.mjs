import * as NodeChildProcess from "node:child_process";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ensureElectron } from "./ensure-electron.mjs";

const scriptDir = NodePath.dirname(fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

ensureElectron();
const electronBinary = require("electron");

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// A stray ELECTRON_RENDERER_URL would make the (unpackaged) built app load the
// dev server instead of dist/index.html — `start` never wants the dev URL.
delete childEnv.ELECTRON_RENDERER_URL;

const child = NodeChildProcess.spawn(electronBinary, ["dist-electron/main.cjs"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
