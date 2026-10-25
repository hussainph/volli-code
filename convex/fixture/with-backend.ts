#!/usr/bin/env node
/**
 * Run one command against a throwaway pinned backend, then stop it.
 *
 *   node fixture/with-backend.ts -- convex codegen --typecheck disable
 *   node fixture/with-backend.ts --deploy -- node my-probe.mjs
 *
 * `convex …` runs this package's pinned CLI, aimed at the backend (see
 * `runConvexCli`). Any other command runs as given, with
 * `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY` and
 * `VOLLI_CONVEX_URL` / `VOLLI_CONVEX_SITE_URL` set and every cloud deployment
 * pointer blanked. `--deploy` first pushes `functions/` with the test issuer
 * trusted, and hands such a command its signing key as
 * `VOLLI_CONVEX_TEST_PRIVATE_KEY`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

import {
  assertConvexNpmPinned,
  deployForTests,
  exitStatus,
  runConvexCli,
  startBackend,
  type RunningBackend,
} from "./backend.ts";
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

const log = (line: string) => console.error(`[convex-fixture] ${line}`);
let backend: RunningBackend | undefined;
let child: ChildProcess | undefined;
let finishing: Promise<never> | undefined;

/** Stop the backend exactly once, whoever asks first, and exit only after it is down. */
function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    if (backend) {
      await backend.stop();
      log("backend stopped");
    }
    process.exit(code);
  })();
  return finishing;
}

// Installed before the backend starts, so a signal during startup still stops it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    child?.kill(signal);
    void finish(128 + constants.signals[signal]);
  });
}

try {
  assertConvexNpmPinned();
  backend = await startBackend({ log });
  log(`backend ${backend.url} (pid ${backend.pid})`);
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
      child = spawn(command[0] as string, command.slice(1), { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => done(exitStatus(exitCode, signal)));
    });
  }
  await finish(code);
} catch (error) {
  console.error(error);
  await finish(1);
}
