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

  it("honors --json for local help without contacting the app", async () => {
    const stdout: string[] = [];
    let requested = false;

    const exitCode = await runCli(["help", "exit-codes", "--json"], {
      env: {},
      cwd: "/work/volli",
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
      readText: async () => "",
      request: async () => {
        requested = true;
        throw new Error("not reached");
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    expect(requested).toBe(false);
    expect(stdout).toEqual([
      '{"help":"Exit codes: 0 ok; 1 failure; 2 usage; 3 app unreachable."}\n',
    ]);
  });

  it("renders every local help topic and reports parser usage failures", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      env: {},
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      readText: async () => "",
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async () => ({ alreadyRunning: true }),
    };

    for (const topic of ["json", "addressing", "orchestration", "unknown"]) {
      expect(await runCli(["help", topic], dependencies)).toBe(0);
    }
    expect(await runCli([], dependencies)).toBe(2);
    expect(output).toHaveLength(4);
    expect(errors).toEqual(["error[USAGE] Expected a Volli command\n"]);
  });

  it("launches explicitly with default/overridden timeouts and maps launch failures", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const timeouts: number[] = [];
    const base = {
      env: {},
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      readText: async () => "",
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async (timeout: number) => {
        timeouts.push(timeout);
        return { alreadyRunning: timeouts.length === 1 };
      },
    };
    expect(await runCli(["app", "launch"], base)).toBe(0);
    expect(await runCli(["app", "launch", "--timeout", "2", "--json"], base)).toBe(0);
    expect(timeouts).toEqual([15_000, 2_000]);

    for (const thrown of [
      new AgentClientError("TIMEOUT", "late"),
      new Error("broken"),
      "unknown failure",
    ]) {
      expect(
        await runCli(["app", "launch"], {
          ...base,
          launch: async () => {
            throw thrown;
          },
        }),
      ).toBe(1);
    }
    expect(errors).toEqual([
      "error[TIMEOUT] late\n",
      "error[MUTATION_FAILED] broken\n",
      "error[MUTATION_FAILED] unknown failure\n",
    ]);
  });

  it("degrades identify without a socket and rejects other commands with exit 3", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      env: {},
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      readText: async () => "",
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async () => ({ alreadyRunning: true }),
    };
    expect(await runCli(["identify"], dependencies)).toBe(0);
    expect(await runCli(["board"], dependencies)).toBe(3);
    expect(output[0]).toContain("worktreePath  /work");
    expect(errors[0]).toContain("error[APP_UNREACHABLE]");
  });

  it("maps server failures and thrown client failures without writing stdout", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const base = {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
      readText: async () => "",
      launch: async () => ({ alreadyRunning: true }),
    };
    expect(
      await runCli(["board"], {
        ...base,
        request: async () => ({
          v: 1,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "bad" },
        }),
      }),
    ).toBe(2);
    expect(
      await runCli(["board"], {
        ...base,
        request: async () => {
          throw new AgentClientError("APP_UNREACHABLE", "down");
        },
      }),
    ).toBe(3);
    expect(
      await runCli(["identify"], {
        ...base,
        request: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "error[INVALID_REQUEST] bad\n",
      "error[APP_UNREACHABLE] down\n",
      "error[MUTATION_FAILED] boom\n",
    ]);
  });

  it("sends a minimal context when optional env values are absent", async () => {
    const requests: AgentRequest[] = [];
    expect(
      await runCli(["project", "list"], {
        env: { VOLLI_SOCKET: "/socket", NO_COLOR: "1" },
        cwd: "/work",
        stdout: () => undefined,
        stderr: () => undefined,
        readText: async () => "",
        request: async (_socket, request) => {
          requests.push(request);
          return { v: 1, ok: true, data: { projects: [] } };
        },
        launch: async () => ({ alreadyRunning: true }),
      }),
    ).toBe(0);
    expect(requests[0]?.ctx.env).toEqual({ socket: "/socket" });
    await runCli(["project", "list"], {
      env: { VOLLI_SOCKET: "" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { projects: [] } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });
    expect(requests[1]?.ctx.env).toEqual({});
  });
});
