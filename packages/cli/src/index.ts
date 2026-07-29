#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import type { AgentRequest } from "@volli/shared";

import { requestAgent } from "./client";
import { runHook } from "./hook";
import { runCli } from "./run";
import { launchApp, requireLaunchSocketPath } from "./runtime";

const env = process.env;
const socketPath = env.VOLLI_SOCKET;

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
 * The hook payload, for harnesses that write it to stdin. Bounded rather than
 * read to EOF: a harness that opens the pipe and never closes it would
 * otherwise hang the hook until the harness's own timeout kills it, which the
 * user sees as a hook error. An empty payload only costs the session id
 * correlation, which most events don't carry anyway.
 */
function readStdinPayload(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, 1500);
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
  if (process.argv[2] === "hook") {
    process.exitCode = await runHook(process.argv.slice(3), {
      env,
      cwd: process.cwd(),
      readStdin: readStdinPayload,
      request: (path, request, options) =>
        requestAgent(path, request, { timeoutMs: options?.timeoutMs ?? 10_000 }),
    });
    return;
  }
  const exitCode = await runCli(process.argv.slice(2), {
    env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readText: (path) => readFile(path, "utf8"),
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

void main();
