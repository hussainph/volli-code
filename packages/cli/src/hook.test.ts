import { describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { runHook, SHORTEST_DECLARED_HOOK_TIMEOUT_MS } from "./hook";
import type { HookDependencies } from "./hook";

interface Recorded {
  requests: AgentRequest[];
  stdinReads: number;
  /** Every budget the hook handed out, stdin's first and the request's second. */
  budgets: number[];
}

function deps(overrides: Partial<Parameters<typeof runHook>[1]> = {}) {
  const recorded: Recorded = { requests: [], stdinReads: 0, budgets: [] };
  const dependencies: Parameters<typeof runHook>[1] = {
    env: { VOLLI_SESSION: "session-7", VOLLI_SOCKET: "/profiles/volli.sock" },
    cwd: () => "/work/volli",
    elapsedMs: () => 0,
    now: () => 1_700_000_000_000,
    readStdin: async (timeoutMs) => {
      recorded.stdinReads += 1;
      recorded.budgets.push(timeoutMs);
      return "";
    },
    request: async (_socketPath, request, options) => {
      recorded.requests.push(request);
      recorded.budgets.push(options?.timeoutMs ?? 0);
      return { v: 1, ok: true, data: {} };
    },
    ...overrides,
  };
  return { recorded, dependencies };
}

describe("runHook", () => {
  it("costs a harness running outside Volli nothing at all", async () => {
    const { recorded, dependencies } = deps({ env: {} });

    await expect(runHook(["claude-code", "session.started"], dependencies)).resolves.toBe(0);

    expect(recorded.requests).toEqual([]);
    expect(recorded.stdinReads).toBe(0);
  });

  it("forwards the event, and the harness session id the payload names", async () => {
    const { recorded, dependencies } = deps({
      readStdin: async () => JSON.stringify({ session_id: "cc-uuid", hook_event_name: "Stop" }),
    });

    await runHook(["claude-code", "turn.completed", "--socket", "/sock"], dependencies);

    expect(recorded.requests).toEqual([
      {
        v: 1,
        cmd: "hook",
        args: {
          harness: "claude-code",
          event: "turn.completed",
          firedAt: 1_700_000_000_000,
          harnessSessionId: "cc-uuid",
        },
        ctx: { cwd: "/work/volli", env: { socket: "/sock", session: "session-7" } },
      },
    ]);
  });

  // VC-163: `hook` is coordination tier, so a hook fired from inside a Session
  // authenticates with the token that Session's attachment holds. The hook
  // process is a descendant of that attachment, so it inherits it.
  it("carries the session token a hook inherits from its attachment", async () => {
    const { recorded, dependencies } = deps({
      env: {
        VOLLI_SESSION: "session-7",
        VOLLI_SOCKET: "/profiles/volli.sock",
        VOLLI_SESSION_TOKEN: "tok-abc",
      },
    });

    await runHook(["claude-code", "turn.started"], dependencies);

    expect(recorded.requests[0]?.ctx.env).toMatchObject({
      session: "session-7",
      token: "tok-abc",
    });
  });

  it("takes the payload off argv for a harness that hands it there", async () => {
    const { recorded, dependencies } = deps();

    // codex's legacy `notify` key appends its JSON to argv and passes no
    // --socket, so the session's own VOLLI_SOCKET is the fallback.
    await runHook(
      ["codex", "turn.completed", JSON.stringify({ "thread-id": "codex-thread" })],
      dependencies,
    );

    expect(recorded.stdinReads).toBe(0);
    expect(recorded.requests[0]).toMatchObject({
      args: { harness: "codex", event: "turn.completed", harnessSessionId: "codex-thread" },
      ctx: { env: { socket: "/profiles/volli.sock" } },
    });
  });

  it("reports an event whose payload names no session id at all", async () => {
    // Most events carry none, and a payload can be anything a harness felt
    // like sending — the event still gets reported either way.
    const payloads = ["not json at all", '{"hook_event_name":"Stop"}', "null", "[1,2]", '{"a":1}'];

    for (const payload of payloads) {
      const { recorded, dependencies } = deps({ readStdin: async () => payload });
      await runHook(["cursor", "turn.started"], dependencies);
      expect(recorded.requests[0]?.args).toEqual({
        harness: "cursor",
        event: "turn.started",
        firedAt: 1_700_000_000_000,
      });
    }
  });

  it("survives a dead Volli without the harness ever learning", async () => {
    const failures: HookDependencies[] = [
      { request: () => Promise.reject(new Error("ECONNREFUSED")) },
      { request: () => Promise.reject(new Error("timed out")) },
      { readStdin: () => Promise.reject(new Error("stdin closed")) },
    ].map((override) => deps(override).dependencies);

    for (const dependencies of failures) {
      await expect(runHook(["claude-code", "input.needed"], dependencies)).resolves.toBe(0);
    }
  });

  it("stays quiet when it cannot tell what fired, or where to report it", async () => {
    const cases: [string[], Partial<HookDependencies>][] = [
      [["claude-code"], {}],
      [[], {}],
      [["claude-code", "input.needed", "--socket"], {}],
      [["claude-code", "input.needed"], { env: { VOLLI_SESSION: "session-7" } }],
      [["claude-code", "input.needed"], { env: { VOLLI_SESSION: "session-7", VOLLI_SOCKET: "" } }],
    ];

    for (const [argv, override] of cases) {
      const { recorded, dependencies } = deps(override);
      await expect(runHook(argv, dependencies)).resolves.toBe(0);
      expect(recorded.requests).toEqual([]);
    }
  });

  it("still reports when the directory it fired in has been deleted under it", async () => {
    const { recorded, dependencies } = deps({
      cwd: () => {
        throw Object.assign(new Error("uv_cwd ENOENT"), { code: "ENOENT" });
      },
    });

    // A worktree removed under a live PTY takes `process.cwd()` with it. The
    // session id is the addressing, so the event still resolves — dropping it
    // over a field the door does not read would lose the report that matters.
    await expect(runHook(["claude-code", "input.needed"], dependencies)).resolves.toBe(0);
    expect(recorded.requests[0]?.ctx.cwd).toBe("");
  });

  it("fits its whole budget, process boot included, inside the shortest declared timeout", async () => {
    const { recorded, dependencies } = deps({ elapsedMs: () => 250 });

    await runHook(["claude-code", "input.needed"], dependencies);

    // Reading stdin and reaching the socket are two spends against one budget,
    // and the budget starts when the process did — the harness is already
    // counting during `ELECTRON_RUN_AS_NODE` boot.
    const total = 250 + recorded.budgets.reduce((sum, budget) => sum + budget, 0);
    expect(recorded.budgets).toHaveLength(2);
    expect(total).toBeLessThan(SHORTEST_DECLARED_HOOK_TIMEOUT_MS);
  });

  it("stamps when this process started, not when it got around to sending", async () => {
    // The whole worth of the stamp is that it predates the boot, the stdin read
    // and the connect — the variable latency that reorders two hooks fired a
    // millisecond apart. A send-time stamp would carry the same lie main's
    // arrival clock already carries, and buy nothing.
    const { recorded, dependencies } = deps({
      elapsedMs: () => 250,
      now: () => 1_700_000_000_250,
    });

    await runHook(["claude-code", "input.needed"], dependencies);

    expect(recorded.requests[0]?.args["firedAt"]).toBe(1_700_000_000_000);
  });

  it("charges a slow boot to itself rather than to the harness's patience", async () => {
    const { recorded, dependencies } = deps({ elapsedMs: () => 2000 });

    await runHook(["claude-code", "input.needed"], dependencies);

    const quick = deps({ elapsedMs: () => 0 });
    await runHook(["claude-code", "input.needed"], quick.dependencies);
    expect(recorded.budgets[1]).toBeLessThan(quick.recorded.budgets[1] ?? 0);
  });

  it("gives up silently once the budget is gone, rather than reporting late", async () => {
    // A harness that took longer to start us than the whole budget allows: a
    // report now would land after it had already given up on us.
    const { recorded, dependencies } = deps({ elapsedMs: () => 60_000 });

    await expect(runHook(["claude-code", "input.needed"], dependencies)).resolves.toBe(0);
    expect(recorded.requests).toEqual([]);
    expect(recorded.stdinReads).toBe(0);
  });

  it("skips a report the stdin read has already outlasted", async () => {
    let elapsed = 0;
    const { recorded, dependencies } = deps({
      elapsedMs: () => elapsed,
      readStdin: async () => {
        // A harness that held the pipe open for the whole read: whatever it
        // finally said, there is no budget left to say it in.
        elapsed = 60_000;
        return "";
      },
    });

    await expect(runHook(["claude-code", "input.needed"], dependencies)).resolves.toBe(0);
    expect(recorded.requests).toEqual([]);
  });

  it("ignores a flag it does not know rather than refusing to report", async () => {
    const { recorded, dependencies } = deps();

    await runHook(["claude-code", "input.needed", "--verbose", "--socket", "/sock"], dependencies);

    expect(recorded.requests[0]?.ctx.env.socket).toBe("/sock");
  });
});
