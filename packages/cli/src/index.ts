#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import type { AgentRequest } from "@volli/shared";

import { requestAgent } from "./client";
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

async function main(): Promise<void> {
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
