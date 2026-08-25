import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_ERROR_CODES,
  buildMutationPlan,
  makeAgentError,
  MUTATION_PLAN_CONTRACT,
  verbEntry,
} from "@volli/shared";
import type { AgentRequest, AgentResponse, VerbEntry } from "@volli/shared";

import { renderParseRefusal, runCli, teachingErrorForParseResult } from "./run";
import { AgentClientError } from "./client";

/** One `volli help` against an app whose optional read answers as scripted. */
const helpWith = async (
  helpRequest: (socket: string, request: AgentRequest) => Promise<AgentResponse>,
  session: string | null = "session-1",
): Promise<string> => {
  const output: string[] = [];
  const code = await runCli(["help"], {
    env: {
      VOLLI_SOCKET: "/socket",
      VOLLI_TICKET: "VC-9",
      ...(session === null ? {} : { VOLLI_SESSION: session }),
    },
    cwd: "/work",
    stdout: (text) => output.push(text),
    stderr: () => undefined,
    readText: async () => "",
    observe: async () => ({}),
    request: async () => {
      throw new Error("static help must not use the command transport");
    },
    helpRequest,
    launch: async () => ({ alreadyRunning: true }),
  });
  expect(code).toBe(0);
  return output.join("");
};

/** One `--dry-run` attempt against an app whose identify answers as scripted. */
const previewAgainst = async (
  identifyData: unknown,
): Promise<{ code: number; stderr: string; commands: string[] }> => {
  const stderr: string[] = [];
  const requests: AgentRequest[] = [];
  const code = await runCli(["ticket", "comment", "VC-1", "-m", "hi", "--dry-run"], {
    env: { VOLLI_SOCKET: "/socket" },
    cwd: "/work",
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    readText: async () => "",
    observe: async () => ({}),
    request: async (_socket, request) => {
      requests.push(request);
      return { v: 1, ok: true, data: identifyData };
    },
    launch: async () => ({ alreadyRunning: true }),
  });
  return { code, stderr: stderr.join(""), commands: requests.map((request) => request.cmd) };
};

describe("runCli", () => {
  it("teaches whether a resolved Role carries a tool reached through the wrong door", () => {
    const parsed = {
      ok: false as const,
      code: "WRONG_DOOR" as const,
      verb: "session.start",
      message:
        "volli session start exists on the Agent Tool Surface as session.start; the Agent CLI does not execute it.",
    };
    const toolOnly: VerbEntry = {
      key: "session.start",
      accessModes: ["tool"],
      actor: "role",
      handler: { site: "main", id: "session.start" },
      listed: true,
      referenceOrder: 1,
      group: "Session",
      summary: "Start a Session.",
      options: [],
    };
    const lookup = () => toolOnly;
    const carried = teachingErrorForParseResult(
      parsed,
      {
        appVersion: "0.1.1",
        surface: { sessionId: "s1", role: "project", tools: ["session.start"] },
        surfaceUnknownReason: null,
      },
      lookup,
    );
    expect(carried).toMatchObject({
      code: "WRONG_DOOR",
      reason: expect.stringContaining("project Role's frozen bundle carries session.start"),
      next: expect.stringContaining("named session.start tool"),
    });

    const absent = teachingErrorForParseResult(
      parsed,
      {
        appVersion: "0.1.1",
        surface: { sessionId: "s2", role: "ticket", tools: [] },
        surfaceUnknownReason: null,
      },
      lookup,
    );
    expect(absent).toMatchObject({
      code: "WRONG_DOOR",
      reason: expect.stringContaining("ticket Role's frozen bundle does not carry session.start"),
      next: expect.stringContaining("do not bypass the refusal"),
    });

    const unknown = teachingErrorForParseResult(
      parsed,
      {
        appVersion: null,
        surface: null,
        surfaceUnknownReason: "the app is stopped",
      },
      lookup,
    );
    expect(unknown.reason).toContain("Role availability is unknown because the app is stopped");

    // A wrong door whose declared entry is not a tool teaches without Role
    // claims: there is no bundle that could carry it.
    const undeclared = teachingErrorForParseResult(parsed, null, () => undefined);
    expect(undeclared).toEqual(makeAgentError("WRONG_DOOR", parsed.message));

    // Without a runtime at all, the refusal names the missing Session honestly.
    const outside = teachingErrorForParseResult(parsed, null, lookup);
    expect(outside.reason).toContain("Role availability is unknown outside a resolved Session");
  });

  it("renders a wrong door through the optional Role read and every other parse error locally", async () => {
    const stderr: string[] = [];
    let helpReads = 0;
    const dependencies = {
      env: {},
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text: string) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async () => {
        throw new Error("a parse refusal must not use the command transport");
      },
      helpRequest: async () => {
        helpReads += 1;
        throw new Error("no socket");
      },
      launch: async () => ({ alreadyRunning: true }),
    };
    const wrongDoor = {
      ok: false as const,
      code: "WRONG_DOOR" as const,
      verb: "session.start",
      message: "volli session start exists on the Agent Tool Surface as session.start.",
    };
    expect(await renderParseRefusal(wrongDoor, ["session", "start", "--json"], dependencies)).toBe(
      2,
    );
    expect(stderr[0]).toContain('"code":"WRONG_DOOR"');

    const usage = {
      ok: false as const,
      code: "USAGE" as const,
      message: "ticket comment requires -m or --file",
    };
    expect(await renderParseRefusal(usage, ["ticket", "comment"], dependencies)).toBe(2);
    expect(stderr[1]).toContain("error[USAGE]");
    // With no VOLLI_SOCKET, even the wrong door's optional read degraded
    // statically before any transport use — and the usage error never asked.
    expect(helpReads).toBe(0);
  });

  it("degrades the optional help read honestly for each way it can fail", async () => {
    // The app answered, but with a frozen surface help cannot trust — whether
    // malformed, missing, nulled, or the wrong shape entirely.
    for (const agentSurface of [{ role: "admin", tools: [1] }, undefined, null, []]) {
      const malformed = await helpWith(async () => ({
        v: 1,
        ok: true,
        data: { appVersion: "0.1.1", ...(agentSurface === undefined ? {} : { agentSurface }) },
      }));
      expect(malformed).toContain(
        "unknown (the running app did not return this Session's frozen Agent Tool Surface)",
      );
    }

    // The app refused the read — with this build's structured refusal, or a
    // pre-VC-91 envelope that carries only a code and message.
    const refused = await helpWith(async () => ({
      v: 1,
      ok: false,
      error: makeAgentError("DB_UNAVAILABLE", "Database failed to open."),
    }));
    expect(refused).toContain("unknown (DB_UNAVAILABLE: Database failed to open.)");
    const legacyRefusal = await helpWith(
      async () =>
        ({
          v: 1,
          ok: false,
          error: { code: "DB_UNAVAILABLE", message: "Database failed to open." },
        }) as AgentResponse,
    );
    expect(legacyRefusal).toContain("unknown (DB_UNAVAILABLE: Database failed to open.)");

    // A Session without a socket cannot read its bundle and says so.
    const socketless: string[] = [];
    expect(
      await runCli(["help"], {
        env: { VOLLI_SESSION: "session-1" },
        cwd: "/work",
        stdout: (text) => socketless.push(text),
        stderr: () => undefined,
        readText: async () => "",
        observe: async () => ({}),
        request: async () => {
          throw new Error("static help must not use the command transport");
        },
        launch: async () => ({ alreadyRunning: true }),
      }),
    ).toBe(0);
    expect(socketless.join("")).toContain(
      "unknown (VOLLI_SOCKET is absent, so the frozen bundle cannot be read)",
    );

    // The read itself failed in transit.
    const failed = await helpWith(async () => {
      throw new Error("socket vanished");
    });
    expect(failed).toContain("unknown (the optional app read failed: socket vanished)");

    // Outside a Session, the same failures stay silent about Roles: there is
    // no bundle to be unknown about, whatever the app answered.
    for (const sessionless of [
      await helpWith(async () => ({ v: 1, ok: true, data: 5 }) as const, null),
      await helpWith(
        async () => ({
          v: 1,
          ok: false,
          error: makeAgentError("DB_UNAVAILABLE", "Database failed to open."),
        }),
        null,
      ),
      await helpWith(async () => {
        throw new Error("socket vanished");
      }, null),
    ]) {
      expect(sessionless).toContain(
        "Session Role availability: not claimed outside a resolved Session.",
      );
    }
  });

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

  // VC-163's acceptance, end to end through the real parser: `volli session
  // start` refuses with the wrong-door error AND STARTS NOTHING. The second
  // half is the one worth a test — a refusal that had already sent the command
  // would be a message, not a door.
  it("refuses session start at the wrong door and sends no start over the socket", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: AgentRequest[] = [];

    const exitCode = await runCli(
      ["session", "start", "VC-4", "-m", "Fix the flaky test", "--model", "openai-codex/gpt-5.2"],
      {
        env: { VOLLI_SOCKET: "/profiles/volli.sock", VOLLI_SESSION: "session-7" },
        cwd: "/work/volli",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        readText: async () => "",
        observe: async () => ({}),
        request: async (_socketPath, request) => {
          requests.push(request);
          return { v: 1, ok: true, data: { appVersion: "0.1.1" } };
        },
        launch: async () => ({ alreadyRunning: true }),
      },
    );

    // Exit 2 is the usage class: the caller must change what it typed.
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(
      "volli session start exists on the Agent Tool Surface as session.start",
    );
    // The only thing that reached the socket is the OPTIONAL Role read the
    // teaching error uses to say whether this Session's bundle carries the
    // verb. No `session.start` was sent, with or without its overrides.
    expect(requests.map((request) => request.cmd)).toEqual(["identify"]);
  });

  it("refuses ticket archive as app-only, and sends nothing at all", async () => {
    const stderr: string[] = [];
    const requests: AgentRequest[] = [];

    const exitCode = await runCli(["ticket", "archive", "VC-4"], {
      env: { VOLLI_SOCKET: "/profiles/volli.sock" },
      cwd: "/work/volli",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socketPath, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { appVersion: "0.1.1" } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      "volli ticket archive exists in the app only; no agent surface executes it.",
    );
    // Not even the Role read: with no `tool` access mode there is no bundle
    // membership to report, so the refusal is answered entirely locally and
    // nothing at all reaches the socket.
    expect(requests).toEqual([]);
  });

  // VC-163: the CLI is the transport for a Session's authentication. If it
  // drops `VOLLI_SESSION_TOKEN` on the floor, every Session in the product
  // becomes an unauthenticated caller that may read and may not write — a
  // failure that would look like a policy bug rather than a plumbing one.
  it("carries the session token from the environment onto the wire", async () => {
    const requests: AgentRequest[] = [];

    await runCli(["ticket", "comment", "VC-4", "-m", "Working"], {
      env: {
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION: "session-7",
        VOLLI_SESSION_TOKEN: "tok-abc",
      },
      cwd: "/work/volli",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socketPath, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { comment: { ticket: "VC-4" } } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(requests[0]?.ctx.env).toEqual({
      socket: "/profiles/volli.sock",
      session: "session-7",
      token: "tok-abc",
    });
  });

  // The optional Role read a wrong door pays for is a socket call like any
  // other, so it authenticates like one — otherwise a Session asking which
  // tools it holds would ask as a stranger.
  it("carries the session token on the wrong-door Role read too", async () => {
    const helpRequests: AgentRequest[] = [];

    await runCli(["session", "start", "VC-4"], {
      env: {
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION: "session-7",
        VOLLI_SESSION_TOKEN: "tok-abc",
        VOLLI_TICKET: "VC-4",
      },
      cwd: "/work/volli",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async () => {
        throw new Error("a parse refusal must not use the command transport");
      },
      helpRequest: async (_socketPath, request) => {
        helpRequests.push(request);
        return { v: 1, ok: true, data: { appVersion: "0.1.1" } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(helpRequests[0]?.ctx.env).toEqual({
      socket: "/profiles/volli.sock",
      session: "session-7",
      token: "tok-abc",
      ticket: "VC-4",
    });
  });

  // Absent and empty must stay distinguishable all the way to the door: an
  // exported-but-blank token is what a caller supplies, not what Volli mints.
  it("sends no token field at all when the environment carries none", async () => {
    const requests: AgentRequest[] = [];

    await runCli(["board"], {
      env: { VOLLI_SOCKET: "/profiles/volli.sock", VOLLI_SESSION_TOKEN: "" },
      cwd: "/work/volli",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socketPath, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { columns: {} } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(requests[0]?.ctx.env).not.toHaveProperty("token");
  });

  it("identifies environment context in degraded mode when the app is down", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["identify", "--json"], {
      env: {
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION: "session-7",
        VOLLI_TICKET: "VC-12",
        PATH: "/opt/homebrew/bin:/usr/bin",
      },
      cwd: "/work/volli",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      // The degraded env block reuses the doctor observation's resolutions:
      // measured here, in the environment under test, never reconstructed.
      observe: async () => ({
        resolved: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: null,
          pnpm: null,
        },
      }),
      // A bare manifest, no lockfile and no repository: node and npm are
      // implied, and nothing implies git, pnpm or gh (VC-157).
      pathExists: (path) => path === "/work/volli/package.json",
      request: async () => {
        throw new AgentClientError("APP_UNREACHABLE", "not running");
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      '{"project":null,"ticket":"VC-12","session":"session-7","worktreePath":"/work/volli","socket":"/profiles/volli.sock","appVersion":null,"env":{"path":"/opt/homebrew/bin:/usr/bin","provenance":null,"interactiveProvenance":null,"tools":{"git":"/usr/bin/git","gh":"/opt/homebrew/bin/gh","node":null,"npm":null,"pnpm":null,"yarn":null,"bun":null},"requiredTools":["node","npm"],"dependencies":"absent"},"degraded":true}\n',
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

  it("adds the live app identity and exact frozen Session surface when the optional help read succeeds", async () => {
    const output: string[] = [];
    const requests: AgentRequest[] = [];
    const dependencies = {
      env: { VOLLI_SOCKET: "/socket", VOLLI_SESSION: "session-full-id" },
      cwd: "/work",
      stdout: (text: string) => output.push(text),
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socket: string, request: AgentRequest) => {
        requests.push(request);
        return {
          v: 1 as const,
          ok: true as const,
          data: {
            appVersion: "0.1.1",
            agentSurface: { role: "ticket", tools: ["read", "edit", "ask_user"] },
          },
        };
      },
      launch: async () => ({ alreadyRunning: true }),
    };

    expect(await runCli(["help"], dependencies)).toBe(0);
    expect(await runCli(["help", "changes"], dependencies)).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.cmd === "identify")).toBe(true);
    expect(output[0]).toContain("Resolved Session Role: ticket");
    expect(output[0]).toContain("Frozen Agent Tool Surface: read, edit, ask_user");
    expect(output[1]).toContain("Running app: 0.1.1");
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

    for (const topic of ["concepts", "changes", "json", "addressing", "orchestration"]) {
      expect(await runCli(["help", topic], dependencies)).toBe(0);
    }
    expect(output).toHaveLength(5);
    expect(output[0]).toContain("durable identity");
    expect(output[1]).toContain("Bundle identity");
    expect(output[2]).toContain("structured JSON");
    expect(output[3]).toContain("Context ladder");
    expect(output[4]).toContain("Read before writing");

    expect(await runCli(["help", "unknown"], dependencies)).toBe(2);
    expect(errors[0]).toContain("error[USAGE] Unknown help path");
    expect(errors[0]).toContain("Next: Run `volli help`");

    // A malformed (non-empty) command surfaces the parser's usage error, exit 2.
    expect(await runCli(["ticket", "move", "VC-1"], dependencies)).toBe(2);
    expect(errors[1]).toBe(
      "error[USAGE] ticket move requires --to Next: Run `volli help <command>` and retry with the documented arguments.\n",
    );

    // Bare `volli` prints the complete reference to stderr and exits 2 (usage).
    expect(await runCli([], dependencies)).toBe(2);
    expect(errors).toHaveLength(3);
    expect(errors[2]).toContain("self-documenting planning CLI");
    expect(errors[2]).toContain("volli help <command> for detail");
  });

  it("renders parser refusals as structured JSON with stable code, reason, and nullable next", async () => {
    const errors: string[] = [];
    const exitCode = await runCli(["ticket", "move", "VC-1", "--json"], {
      env: {},
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async () => ({ v: 1, ok: true, data: {} }),
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(errors[0]!)).toEqual({
      error: {
        code: "USAGE",
        message: "ticket move requires --to",
        reason: "ticket move requires --to",
        next: "Run `volli help <command>` and retry with the documented arguments.",
      },
    });

    expect(
      await runCli(["board", "--json"], {
        env: { VOLLI_SOCKET: "/socket" },
        cwd: "/work",
        stdout: () => undefined,
        stderr: (text) => errors.push(text),
        readText: async () => "",
        observe: async () => ({}),
        request: async () => ({
          v: 1,
          ok: false,
          error: makeAgentError("MUTATION_FAILED", "SQLite returned no receipt."),
        }),
        launch: async () => ({ alreadyRunning: true }),
      }),
    ).toBe(1);
    expect(JSON.parse(errors[1]!)).toEqual({
      error: {
        code: "MUTATION_FAILED",
        message: "SQLite returned no receipt.",
        reason:
          "SQLite returned no receipt. Volli lacks enough durable outcome evidence to name a safe retry.",
        next: null,
      },
    });
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
    expect(errors[0]).toContain("error[TIMEOUT] late Next:");
    expect(errors[1]).toContain(
      "error[MUTATION_FAILED] broken Volli lacks enough durable outcome evidence",
    );
    expect(errors[2]).toContain(
      "error[MUTATION_FAILED] unknown failure Volli lacks enough durable outcome evidence",
    );
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

  // The one command that must answer without the app may not fail because the
  // observation did: a degraded env block of unknowns is still an answer.
  it("answers a degraded identify even when the observation rejects", async () => {
    const output: string[] = [];
    const exitCode = await runCli(["identify", "--json"], {
      env: { PATH: "/usr/bin" },
      cwd: "/work",
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => Promise.reject(new Error("environment gone")),
      request: async () => ({ v: 1, ok: true, data: {} }),
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(exitCode).toBe(0);
    // Both provenance fields null, and neither of them `pending`: a CLI with no
    // app to ask never ran a pass, which is not the same fact as a pass that
    // has yet to land.
    expect(output[0]).toContain(
      '"env":{"path":"/usr/bin","provenance":null,"interactiveProvenance":null,"tools":{"git":null,"gh":null,"node":null,"npm":null,"pnpm":null,"yarn":null,"bun":null}',
    );
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
          error: makeAgentError("INVALID_REQUEST", "bad"),
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
    expect(errors[0]).toContain("error[INVALID_REQUEST] bad Next:");
    expect(errors[1]).toContain("error[APP_UNREACHABLE] down Next:");
    expect(errors[2]).toContain(
      "error[MUTATION_FAILED] boom Volli lacks enough durable outcome evidence",
    );
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

  // Which tools may be FAULTS is a fact about the directory this process
  // stands in, so it is measured here beside every other observation — main
  // cannot see the caller's workspace and must not guess at it (VC-157).
  it("sends the tools this workspace implies, judged by its own lockfile", async () => {
    const requests: AgentRequest[] = [];
    const present = new Set(["/work/.git", "/work/package.json", "/work/yarn.lock"]);
    const code = await runCli(["doctor"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => ({ pathEntries: ["/ud/bin"], resolved: {} }),
      pathExists: (path) => present.has(path),
      request: async (_socket, request) => {
        requests.push(request);
        return { v: 1, ok: true, data: { checks: [], summary: "All 0 checks passed." } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(0);
    expect(requests[0]?.args["requiredTools"]).toEqual(["git", "node", "yarn"]);
  });

  // A preview that validated different input than the real call would is not a
  // preview of it. The file is read (a read), folded into the same argument the
  // real request carries, and only then previewed.
  it("previews the body a file-sourced write would really send", async () => {
    const requests: AgentRequest[] = [];
    const plan = buildMutationPlan(verbEntry("ticket.create")!, {
      kind: "project",
      id: "VC",
      label: "Volli Code (VC)",
    });
    const argv = ["ticket", "create", "--title", "T", "--body-file", "/tmp/b", "--dry-run"];
    const code = await runCli(argv, {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async (path) => `body from ${path}`,
      observe: async () => ({}),
      request: async (_socket, request) => {
        requests.push(request);
        if (request.cmd === "identify") {
          return { v: 1, ok: true, data: { previewContract: MUTATION_PLAN_CONTRACT } };
        }
        return { v: 1, ok: true, data: plan };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    // The preview flag has to survive materialization, or the read would have
    // turned the preview into the write it was previewing.
    expect(code).toBe(0);
    const preview = requests.find((request) => request.cmd === "ticket.create");
    expect(preview?.args).toEqual({
      title: "T",
      body: "body from /tmp/b",
      dryRun: true,
    });
  });

  it("keeps doctor --fix preview free of local observation and a second request", async () => {
    const requests: AgentRequest[] = [];
    let observed = false;
    const plan = buildMutationPlan(verbEntry("doctor")!, {
      kind: "integration",
      id: null,
      label: "Volli-managed harness integration for future Sessions",
    });
    const code = await runCli(["doctor", "--fix", "--dry-run", "--json"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: async () => "",
      observe: async () => {
        observed = true;
        throw new Error("preview must not inspect files");
      },
      request: async (_socket, request) => {
        requests.push(request);
        if (request.cmd === "identify") {
          return { v: 1, ok: true, data: { previewContract: MUTATION_PLAN_CONTRACT } };
        }
        return { v: 1, ok: true, data: plan };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(0);
    expect(observed).toBe(false);
    // The read-only preflight travels first; the preview itself is one request.
    expect(requests.map((request) => request.cmd)).toEqual(["identify", "doctor"]);
    // It asks the capability question and nothing else. A context-shaped
    // identify resolves a Project, so `doctor --fix --dry-run` run outside a
    // registered directory would be refused with PROJECT_REQUIRED while the
    // real repair succeeded.
    expect(requests[0]?.args).toEqual({ capabilities: true });
    expect(requests[1]?.args).toEqual({ fix: true, dryRun: true });
  });

  // An app that predates the preview contract ignores the unknown dryRun
  // argument and executes the real write — the one outcome a preview promises
  // can never happen — so the CLI refuses before anything mutable is sent.
  it("refuses --dry-run up front when the running app does not declare the preview contract", async () => {
    const versioned = await previewAgainst({ appVersion: "0.1.1" });
    expect(versioned.code).toBe(1);
    expect(versioned.commands).toEqual(["identify"]);
    expect(versioned.stderr).toContain("error[SOCKET_PROTOCOL]");
    expect(versioned.stderr).toContain(
      "The running app 0.1.1 does not declare the side-effect preview contract",
    );
    expect(versioned.stderr).toContain("volli help changes");

    // A malformed identify answer is the same refusal, without inventing a version.
    const malformed = await previewAgainst(123);
    expect(malformed.code).toBe(1);
    expect(malformed.commands).toEqual(["identify"]);
    expect(malformed.stderr).toContain(
      "The running app does not declare the side-effect preview contract",
    );
  });

  it("surfaces the preflight identify refusal instead of sending the preview", async () => {
    const stderr: string[] = [];
    const requests: AgentRequest[] = [];
    const code = await runCli(["notify", "-m", "ready", "--dry-run"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socket, request) => {
        requests.push(request);
        return {
          v: 1,
          ok: false,
          error: makeAgentError("DB_UNAVAILABLE", "Database failed to open."),
        };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(1);
    expect(requests.map((request) => request.cmd)).toEqual(["identify"]);
    expect(stderr.join("")).toContain("error[DB_UNAVAILABLE]");
  });

  // Behind the preflight, a success that is not the shared plan means the app
  // may have run the real write; rendering it as a preview would launder that.
  it("never renders a non-plan answer to --dry-run as a preview success", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["ticket", "comment", "VC-1", "-m", "hi", "--dry-run"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socket, request) => {
        if (request.cmd === "identify") {
          return { v: 1, ok: true, data: { previewContract: MUTATION_PLAN_CONTRACT } };
        }
        return { v: 1, ok: true, data: { comment: { id: "c-1" } } };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("error[SOCKET_PROTOCOL]");
    expect(stderr.join("")).toContain("durable state may have changed");
    expect(stderr.join("")).toContain("none is safe from this evidence");
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
            ...(request.args["fix"] === true
              ? {
                  pathRepair: {
                    path: "/ud/bin:/opt/homebrew/bin:/usr/bin",
                    provenance: "adopted",
                    added: ["/opt/homebrew/bin"],
                    interactiveProvenance: "already-complete",
                    interactiveAdded: [],
                  },
                }
              : {}),
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
    expect(stdout.join("")).toContain("Session PATH repair");
    expect(stdout.join("")).toContain("env.added  /opt/homebrew/bin");
    expect(stdout.join("")).toContain("All 1 checks passed.");
  });

  it("surfaces a failed re-check after a successful repair", async () => {
    const stderr: string[] = [];
    let requests = 0;
    const code = await runCli(["doctor", "--fix"], {
      env: { VOLLI_SOCKET: "/socket" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({ pathEntries: [], resolved: {} }),
      request: async () => {
        requests += 1;
        return requests === 1
          ? { v: 1, ok: true as const, data: { checks: [], summary: "All 0 checks passed." } }
          : {
              v: 1,
              ok: false as const,
              error: makeAgentError("MUTATION_FAILED", "Re-check failed"),
            };
      },
      launch: async () => ({ alreadyRunning: true }),
    });

    expect(code).toBe(1);
    expect(requests).toBe(2);
    expect(stderr.join("")).toContain("Re-check failed");
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
          error: makeAgentError("MUTATION_FAILED", "Repair failed: disk is full"),
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
