import { describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { runCli } from "./run";
import { AgentClientError } from "./client";

describe("runCli", () => {
  it("sends parsed context once and writes the JSON response to stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: AgentRequest[] = [];

    const exitCode = await runCli(["project", "list", "--json"], {
      env: {
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION: "session-7",
        VOLLI_TICKET: "VC-12",
      },
      cwd: "/work/volli",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      tty: false,
      readText: async () => "",
      request: async (socketPath, request) => {
        expect(socketPath).toBe("/profiles/volli.sock");
        requests.push(request);
        return { v: 1, ok: true, data: { projects: [{ name: "Volli Code" }] } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(['{"projects":[{"name":"Volli Code"}]}\n']);
    expect(requests).toEqual([
      {
        v: 1,
        cmd: "project.list",
        args: {},
        ctx: {
          cwd: "/work/volli",
          env: {
            socket: "/profiles/volli.sock",
            session: "session-7",
            ticket: "VC-12",
          },
        },
      },
    ]);
  });

  it("identifies environment context in degraded mode when the app is down", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["identify", "--json"], {
      env: {
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION: "session-7",
        VOLLI_TICKET: "VC-12",
      },
      cwd: "/work/volli",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      tty: false,
      readText: async () => "",
      request: async () => {
        throw new AgentClientError("APP_UNREACHABLE", "not running");
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      '{"project":null,"ticket":"VC-12","session":"session-7","worktreePath":"/work/volli","socket":"/profiles/volli.sock","appVersion":null,"degraded":true}\n',
    ]);
  });
});
