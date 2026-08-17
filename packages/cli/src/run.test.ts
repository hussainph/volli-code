import { describe, expect, it } from "vite-plus/test";

import { AGENT_ERROR_CODES } from "@volli/shared";
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
      observe: async () => ({}),
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

  it("carries session start's overrides over the socket and prints the short id line", async () => {
    const stdout: string[] = [];
    const requests: AgentRequest[] = [];

    const exitCode = await runCli(
      [
        "session",
        "start",
        "VC-4",
        "-m",
        "Fix the flaky test",
        "--title",
        "Validate VC-4",
        "--model",
        "openai-codex/gpt-5.2",
        "--reasoning",
        "high",
      ],
      {
        env: { VOLLI_SOCKET: "/profiles/volli.sock" },
        cwd: "/work/volli",
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        readText: async () => "",
        observe: async () => ({}),
        request: async (_socketPath, request) => {
          requests.push(request);
          return {
            v: 1,
            ok: true,
            data: {
              session: "abcdef12",
              ticket: "VC-4",
              state: "ready",
              model: "openai-codex/gpt-5.2",
              reasoning: "high",
            },
          };
        },
        launch: async () => ({ alreadyRunning: true }),
      },
    );

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        cmd: "session.start",
        args: {
          id: "VC-4",
          message: "Fix the flaky test",
          title: "Validate VC-4",
          model: { providerId: "openai-codex", modelId: "gpt-5.2" },
          reasoning: "high",
        },
      }),
    ]);
    expect(stdout).toEqual(["abcdef12  VC-4  ready  openai-codex/gpt-5.2 high\n"]);
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
      observe: async () => ({}),
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
      observe: async () => ({}),
      request: async () => {
        requested = true;
        throw new Error("not reached");
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    expect(requested).toBe(false);
    expect(stdout).toHaveLength(1);
    const { help } = JSON.parse(stdout[0]!) as { help: string };
    expect(help).toContain("0 ok; 1 failure; 2 usage; 3 app unreachable");
    for (const code of AGENT_ERROR_CODES) expect(help).toContain(code);
  });

  it("documents every published error code's exit class in volli help exit-codes", async () => {
    const output: string[] = [];
    await runCli(["help", "exit-codes"], {
      env: {},
      cwd: "/work",
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async () => ({ alreadyRunning: true }),
    });

    const text = output.join("");
    // A stable machine-matchable code (decision 6) paired with its exit
    // class — spot-check one of each class so the table format itself is
    // covered, not just the vocabulary's presence.
    expect(text).toContain("USAGE");
    expect(text).toContain("2 usage");
    expect(text).toContain("APP_UNREACHABLE");
    expect(text).toContain("3 app unreachable");
    expect(text).toContain("BODY_MATCH_FAILED");
    expect(text).toContain("1 failure");
    for (const code of AGENT_ERROR_CODES) expect(text).toContain(code);
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
      observe: async () => ({}),
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async () => ({ alreadyRunning: true }),
    };

    for (const topic of ["json", "addressing", "orchestration", "unknown"]) {
      expect(await runCli(["help", topic], dependencies)).toBe(0);
    }
    expect(output).toHaveLength(4);
    expect(output[0]).toContain("structured JSON");
    expect(output[1]).toContain("Context ladder");
    expect(output[2]).toContain("Read before writing");
    // An unknown topic falls back to the full compact reference, not an error.
    expect(output[3]).toContain("self-documenting planning CLI");

    // A malformed (non-empty) command surfaces the parser's usage error, exit 2.
    expect(await runCli(["ticket", "move", "VC-1"], dependencies)).toBe(2);
    expect(errors).toEqual(["error[USAGE] ticket move requires --to\n"]);

    // Bare `volli` prints the complete reference to stderr and exits 2 (usage).
    expect(await runCli([], dependencies)).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("self-documenting planning CLI");
    expect(errors[1]).toContain("volli help <command> for detail");
  });

  it("routes command and --help help through renderHelp, with --json wrapping", async () => {
    const output: string[] = [];
    const dependencies = {
      env: {},
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async () => ({ v: 1, ok: true, data: {} }) as const,
      launch: async () => ({ alreadyRunning: true }),
    };
    // `help <command>` renders that command's detail.
    expect(await runCli(["help", "ticket", "create"], dependencies)).toBe(0);
    expect(output[0]).toContain("Usage: volli ticket create --title <text> [options]");
    // A `--help` flag anywhere is equivalent to `help <command prefix>`, exit 0.
    expect(await runCli(["ticket", "move", "VC-1", "--help"], dependencies)).toBe(0);
    expect(output[1]).toContain("ticket move — Move a ticket to another column.");
    // `--json` wraps the same reference text as { help }.
    expect(await runCli(["help", "board", "--json"], dependencies)).toBe(0);
    const { help } = JSON.parse(output[2]!) as { help: string };
    expect(help).toContain("board — Show a project's board");
    expect(help.endsWith("\n")).toBe(false);
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
      observe: async () => ({}),
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
      observe: async () => ({}),
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
      observe: async () => ({}),
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
        observe: async () => ({}),
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
      observe: async () => ({}),
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { projects: [] } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });
    expect(requests[1]?.ctx.env).toEqual({});
  });
});

describe("runCli — doctor", () => {
  // The observation is the command's whole evidence; main must receive it
  // rather than reconstruct it.
  it("sends what this process observed of its own environment", async () => {
    const requests: AgentRequest[] = [];
    const code = await runCli(["doctor"], {
      env: { VOLLI_SOCKET: "/socket", VOLLI_SESSION: "s-1" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({ pathEntries: ["/ud/bin"], resolved: { claude: "/ud/bin/claude" } }),
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { checks: [], summary: "All 0 checks passed." } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(0);
    expect(requests[0]?.args["pathEntries"]).toEqual(["/ud/bin"]);
    expect(requests[0]?.args["resolved"]).toEqual({ claude: "/ud/bin/claude" });
    expect(requests[0]?.ctx.env.session).toBe("s-1");
  });

  // The observation travels with the request, so the one that arrived WITH the
  // repair describes the world the repair was about to change. Rendering the
  // checks against it told a user who had just run `--fix` to run `--fix`.
  it("re-observes after a repair and reports the world the repair left behind", async () => {
    const stdout: string[] = [];
    const requests: AgentRequest[] = [];
    let observations = 0;

    const code = await runCli(["doctor", "--fix"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => {
        observations += 1;
        return {
          pathEntries: ["/ud/bin"],
          resolved: { claude: observations === 1 ? null : "/ud/bin/claude" },
        };
      },
      request: async (_socket, request) => {
        requests.push(request);
        const repaired = request.args["resolved"] as Record<string, string | null>;
        return {
          v: 1,
          ok: true,
          data: {
            checks: [],
            summary: repaired["claude"] === null ? "1 failed of 1 checks." : "All 1 checks passed.",
          },
        };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(0);
    expect(observations).toBe(2);
    expect(requests[0]?.args["fix"]).toBe(true);
    // Repairing twice is work the user did not ask for, and the second run
    // would be measuring its own side effects.
    expect(requests[1]).toBeDefined();
    expect(requests[1]?.args).not.toHaveProperty("fix");
    expect(requests[1]?.args["resolved"]).toEqual({ claude: "/ud/bin/claude" });
    expect(stdout.join("")).toContain("All 1 checks passed.");
  });

  it("does not re-check a doctor run that was not asked to repair", async () => {
    const requests: AgentRequest[] = [];
    await runCli(["doctor"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({ pathEntries: [], resolved: {} }),
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { checks: [], summary: "All 0 checks passed." } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });
    expect(requests).toHaveLength(1);
  });

  // A repair that main refused is the whole answer; a re-check would print a
  // report over the top of the error that explains it.
  it("does not re-check when the repair itself failed", async () => {
    const requests: AgentRequest[] = [];
    const stderr: string[] = [];
    const code = await runCli(["doctor", "--fix"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({ pathEntries: [], resolved: {} }),
      request: async (_socket, request) => {
        requests.push(request);
        return {
          v: 1,
          ok: false,
          error: { code: "MUTATION_FAILED", message: "Repair failed: disk is full" },
        };
      },
      launch: async () => ({ alreadyRunning: true }),
    });
    expect(code).toBe(1);
    expect(requests).toHaveLength(1);
    expect(stderr.join("")).toContain("Repair failed: disk is full");
  });

  it("does not attach an observation to any other command", async () => {
    const requests: AgentRequest[] = [];
    await runCli(["board"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({ pathEntries: ["/ud/bin"] }),
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: {} };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(requests[0]?.args["pathEntries"]).toBeUndefined();
  });
});
