#!/usr/bin/env node
/**
 * Runs `deploy.ts` (the self-checked deploy) with the pinned `convex` CLI.
 *
 *   CONVEX_DEPLOY_KEY=prod:… pnpm -C convex deploy:checked
 *   pnpm -C convex with-backend -- node scripts/deploy.mjs --test   # the throwaway backend
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deployChecked } from "./deploy.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageDir, "package.json"));
const cli = join(dirname(require.resolve("convex/package.json")), "bin/main.js");

/** @type {import("./deploy.ts").ConvexCli} */
const convex = (args, env, capture) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: packageDir,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.once("error", reject);
    // `close`, not `exit`: only then has the captured stdout fully drained.
    child.once("close", (code) => done({ code: code ?? 1, stdout }));
  });

process.exit(
  await deployChecked(process.argv.slice(2), process.env, convex, (line) =>
    console.error(`[convex-deploy] ${line}`),
  ),
);
