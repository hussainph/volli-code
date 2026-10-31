import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

/** The release line the runner reports, as desktop and hostd report their own. */
const releaseVersion = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as { version: string }
).version;

/**
 * The Volli Cloud deployment a release links to: the same public release
 * inputs desktop's packaged config reads (`VOLLI_BUILD_CONVEX_URL` and
 * `VOLLI_BUILD_CONVEX_SITE_URL`), both or neither. Neither is a development
 * build, which links only with `--server`. Checked again at runtime
 * (`src/link/deployment.ts`), so a malformed value refuses to link rather
 * than ship half-wired.
 */
function buildDeployment(env: NodeJS.ProcessEnv): { url: string; siteUrl: string } | null {
  const url = env["VOLLI_BUILD_CONVEX_URL"]?.trim() ?? "";
  const siteUrl = env["VOLLI_BUILD_CONVEX_SITE_URL"]?.trim() ?? "";
  if (url === "" && siteUrl === "") return null;
  if (url === "" || siteUrl === "") {
    throw new Error(
      "Set both or neither of VOLLI_BUILD_CONVEX_URL and VOLLI_BUILD_CONVEX_SITE_URL",
    );
  }
  return { url, siteUrl };
}

// Tests never see the machine's release inputs: they pin a deployment of their own.
const testing = process.env["VITEST"] !== undefined;
const define = {
  __VOLLI_RUNNER_VERSION__: JSON.stringify(releaseVersion),
  __VOLLI_RUNNER_BUILD_DEPLOYMENT__: JSON.stringify(
    testing
      ? {
          url: "https://baked-deployment.convex.cloud",
          siteUrl: "https://baked-deployment.convex.site",
        }
      : buildDeployment(process.env),
  ),
};

export default defineConfig({
  define,
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    // Plain Node: the runner runs on a Linux box, never in Electron.
    environment: "node",
    // The runner's own tests only: `e2e/` is the BYO acceptance lane's
    // harness, `node:test` files that ci-extended runs under plain Node.
    include: ["src/**/*.test.ts"],
    coverage: {
      // `main.ts` is the process shell (argv, signals, exit codes, the live
      // ports); everything it calls is gated here.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/main.ts", "src/testing/**"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  // One CommonJS file holding the runner, every @volli package and their
  // pure-JS dependencies; natives listed under `dependencies` stay external
  // and ship beside it in node_modules.
  pack: {
    define,
    entry: { runner: "src/main.ts" },
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
