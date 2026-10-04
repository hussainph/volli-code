import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

/** The release line hostd reports as its `appVersion`, as desktop reports its own. */
const releaseVersion = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as { version: string }
).version;
const define = { __VOLLI_HOSTD_VERSION__: JSON.stringify(releaseVersion) };

export default defineConfig({
  define,
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    // Plain Node: hostd runs in the Linux host lane, never in Electron.
    environment: "node",
    coverage: {
      // Boot and composition are gated whole. `main.ts` is the process shell
      // (argv, signals, exit codes); CI's artifact job boots the real binary
      // and drives it, which is that file's test.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/main.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  // One CommonJS file holding hostd, every @volli package and their pure-JS
  // dependencies. The natives this package lists under `dependencies`
  // (better-sqlite3, node-pty, sharp, @vscode/ripgrep) stay external and are
  // shipped beside it in node_modules by scripts/package.mjs. See README.md,
  // "Packaging".
  pack: {
    define,
    entry: { hostd: "src/main.ts" },
    format: "cjs",
    platform: "node",
    target: "node24",
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    clean: true,
    dts: false,
    deps: { onlyBundle: false },
  },
});
