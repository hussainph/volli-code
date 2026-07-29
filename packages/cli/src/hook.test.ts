import { describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { runHook } from "./hook";
import type { HookDependencies } from "./hook";

interface Recorded {
  requests: AgentRequest[];
  stdinReads: number;
}

function deps(overrides: Partial<Parameters<typeof runHook>[1]> = {}) {
  const recorded: Recorded = { requests: [], stdinReads: 0 };
  const dependencies: Parameters<typeof runHook>[1] = {
    env: { VOLLI_SESSION: "session-7", VOLLI_SOCKET: "/profiles/volli.sock" },
    cwd: "/work/volli",
    readStdin: async () => {
      recorded.stdinReads += 1;
      return "";
    },
    request: async (_socketPath, request) => {
      recorded.requests.push(request);
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
          harnessSessionId: "cc-uuid",
        },
        ctx: { cwd: "/work/volli", env: { socket: "/sock", session: "session-7" } },
      },
    ]);
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
      expect(recorded.requests[0]?.args).toEqual({ harness: "cursor", event: "turn.started" });
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

  it("ignores a flag it does not know rather than refusing to report", async () => {
    const { recorded, dependencies } = deps();

    await runHook(["claude-code", "input.needed", "--verbose", "--socket", "/sock"], dependencies);

    expect(recorded.requests[0]?.ctx.env.socket).toBe("/sock");
  });
});
