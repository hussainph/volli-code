#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import type { AgentRequest } from "@volli/shared";

import { requestAgent } from "./client";
import { runHook } from "./hook";
import { observeEnvironment } from "./doctor";
import { runCli } from "./run";
import { launchApp, requireLaunchSocketPath } from "./runtime";

const env = process.env;
const socketPath = env.VOLLI_SOCKET;

/**
 * Whether this process is a fired hook rather than a typed command. It decides
 * what a failure is allowed to look like: a harness reads a hook's exit code as
 * a decision (Claude Code takes 2 as "block this action") and its stdout as a
 * reply, so a hook exits 0 in silence however badly it went — a dead Volli must
 * never be able to wedge or mislead a live agent.
 */
const isHookInvocation = process.argv[2] === "hook";

if (isHookInvocation) {
  // The outermost guard, and the only one that catches what no `try` encloses:
  // a throw from a stray timer, an unhandled rejection, a crash in something we
  // called. Silent on both streams, and 0 by leaving the exit code alone.
  process.on("uncaughtException", () => {});
  process.on("unhandledRejection", () => {});
}

function detachedSpawn(executable: string, args: string[], childEnv: NodeJS.ProcessEnv): void {
  const child = spawn(executable, args, {
    detached: true,
    env: childEnv,
    stdio: "ignore",
  });
  child.unref();
}

async function probe(path: string): Promise<void> {
  const request: AgentRequest = {
    v: 1,
    cmd: "identify",
    args: {},
    ctx: {
      cwd: process.cwd(),
      env: {
        ...(env.VOLLI_SOCKET ? { socket: env.VOLLI_SOCKET } : {}),
        ...(env.VOLLI_SESSION ? { session: env.VOLLI_SESSION } : {}),
        ...(env.VOLLI_TICKET ? { ticket: env.VOLLI_TICKET } : {}),
      },
    },
  };
  await requestAgent(path, request, { timeoutMs: 500 });
}

/**
 * The hook payload, for harnesses that write it to stdin. Bounded by the share
 * of the invocation's budget the caller allots it rather than read to EOF: a
 * harness that opens the pipe and never closes it would otherwise hang the hook
 * until the harness's own timeout kills it, which the user sees as a hook error.
 * An empty payload only costs the session id correlation, which most events
 * don't carry anyway.
 */
function readStdinPayload(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
  });
}

async function main(): Promise<void> {
  // `volli hook` is dispatched before the CLI proper: it is fired by a harness
  // hook rather than typed, it must cost a harness running outside Volli
  // nothing, and it never renders anything for a reader — so it has no business
  // reaching the argument parser, the renderer, or the help system.
  //
  // Nothing the invocation needs is resolved outside this guard, `process.cwd()`
  // least of all: a session's worktree can be removed under a live PTY, and
  // reading the working directory then throws ENOENT before the hook has had a
  // chance to report anything.
  if (isHookInvocation) {
    try {
      await runHook(process.argv.slice(3), {
        env,
        cwd: () => process.cwd(),
        // Boot counts: the harness started its own clock before this process
        // existed, and `process.uptime()` is the only place that time is legible.
        elapsedMs: () => Math.round(process.uptime() * 1000),
        readStdin: readStdinPayload,
        request: (path, request, options) =>
          requestAgent(path, request, { timeoutMs: options?.timeoutMs ?? 10_000 }),
      });
    } catch {
      // Silent on stdout and stderr alike, exiting 0 by leaving the code alone.
    }
    return;
  }
  const exitCode = await runCli(process.argv.slice(2), {
    env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readText: (path) => readFile(path, "utf8"),
    // Measured here, in the environment under test — see `doctor.ts`.
    observe: () => observeEnvironment(),
    request: (path, request) => requestAgent(path, request, { timeoutMs: 10_000 }),
    launch: (timeoutMs) => {
      return launchApp(
        {
          socketPath: requireLaunchSocketPath(socketPath),
          executable: env.VOLLI_APP_EXECUTABLE ?? process.execPath,
          appEntry: env.VOLLI_APP_ENTRY,
          userDataPath: env.VOLLI_APP_USER_DATA,
          rendererUrl: env.VOLLI_APP_RENDERER_URL,
          timeoutMs,
          env,
        },
        {
          probe,
          spawnDetached: detachedSpawn,
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: Date.now,
        },
      );
    },
  });
  process.exitCode = exitCode;
}

// A rejection escaping here used to reach Node as an unhandled one: exit 1 and a
// stack on stderr, which for a hook is the two things it may never emit. A typed
// command still reports itself and fails, just in one legible line.
void main().catch((error: unknown) => {
  if (isHookInvocation) return;
  process.exitCode = 1;
  process.stderr.write(`volli: ${error instanceof Error ? error.message : String(error)}\n`);
});
