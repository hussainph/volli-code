#!/usr/bin/env node
/**
 * Run one command against a throwaway pinned backend, then stop it.
 *
 *   node fixture/with-backend.ts -- convex codegen --typecheck disable
 *   node fixture/with-backend.ts --deploy -- node my-probe.mjs
 *
 * `convex …` runs this package's pinned CLI. Any other command runs as given.
 * The command sees `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY`
 * (what the CLI reads) and `VOLLI_CONVEX_URL` / `VOLLI_CONVEX_SITE_URL`, with
 * every cloud deployment variable removed. `--deploy` first pushes
 * `functions/` with the test issuer trusted, and hands the command its signing
 * key as `VOLLI_CONVEX_TEST_PRIVATE_KEY`.
 */

import { spawn } from "node:child_process";

import { assertConvexNpmPinned, deployForTests, runConvexCli, startBackend } from "./backend.ts";
import { createTestIssuer } from "./jwt.ts";

// Leading `--flags` belong to this script; a `--` (which pnpm may or may not
// pass through) or the first other word starts the command.
const argv = process.argv.slice(2);
const flags: string[] = [];
let index = 0;
for (; index < argv.length && argv[index]?.startsWith("--"); index += 1) {
  if (argv[index] === "--") {
    index += 1;
    break;
  }
  flags.push(argv[index] as string);
}
const command = argv.slice(index);
const unknown = flags.filter((flag) => flag !== "--deploy");
if (command.length === 0 || unknown.length > 0) {
  console.error("usage: with-backend.ts [--deploy] [--] <command…>");
  process.exit(2);
}

assertConvexNpmPinned();
const log = (line: string) => console.error(`[convex-fixture] ${line}`);
const backend = await startBackend({ log });
log(`backend ${backend.url} (pid ${backend.pid})`);

let stopping = false;
async function finish(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    await backend.stop();
    log("backend stopped");
  }
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void finish(130));
}

try {
  const env: NodeJS.ProcessEnv = {
    ...backend.cliEnv(),
    VOLLI_CONVEX_URL: backend.url,
    VOLLI_CONVEX_SITE_URL: backend.siteUrl,
  };
  if (flags.includes("--deploy")) {
    Object.assign(env, await deployForTests(backend, createTestIssuer()));
    log("functions deployed");
  }

  let code: number;
  if (command[0] === "convex") {
    code = (await runConvexCli(backend, command.slice(1), { stdio: "inherit" })).code;
  } else {
    code = await new Promise<number>((done, reject) => {
      const child = spawn(command[0] as string, command.slice(1), {
        env,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => done(exitCode ?? (signal ? 128 : 1)));
    });
  }
  await finish(code);
} catch (error) {
  console.error(error);
  await finish(1);
}
