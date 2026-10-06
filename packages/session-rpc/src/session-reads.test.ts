// The socket's Session reads and the welcome, as router procedures (VC-663).
import type { HostActor, HostWelcome } from "@volli/host-protocol";
import type { SessionRuntime } from "@volli/session-engine";
import { makeAgentError, type AgentResponse } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { LOCAL_DESKTOP_CALLER, type RouterCaller } from "./catalog";
import { createSessionRouter, RpcDiagnosticLog, type SessionRouterContext } from "./index";
import type { ReadSessionVerb } from "./session-reads";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";

const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };
const network = (actor: HostActor): RouterCaller => ({ actor, current: () => true });

function router(caller: RouterCaller, extra: Partial<SessionRouterContext> = {}) {
  const context: SessionRouterContext = {
    caller,
    runtime: {} as SessionRuntime,
    diagnostics: new RpcDiagnosticLog(),
    ...extra,
  };
  return createSessionRouter().createCaller(context);
}

function answering(response: AgentResponse) {
  return vi.fn<ReadSessionVerb>(async () => response);
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the router to refuse this call");
}

describe("the Session reads (D4)", () => {
  it("runs each read through the port, forced to the named Workspace, and validates the answer", async () => {
    const row = { id: "a1b2c3d4", status: "working", ageMs: 10, ticket: null };
    const read = vi.fn<ReadSessionVerb>(async (verb) => ({
      v: 1,
      ok: true,
      data: verb === "session.list" ? { sessions: [row], hidden: 2 } : row,
    }));
    const caller = router(network(device), { readSessionVerb: read });
    expect(
      await caller.session.list({ projectId: WORKSPACE, all: true, state: ["working"] }),
    ).toStrictEqual({ sessions: [row], hidden: 2 });
    expect(await caller.session.show({ projectId: WORKSPACE, session: "a1b2c3d4" })).toStrictEqual(
      row,
    );
    await caller.session.peek({ projectId: WORKSPACE, session: "a1b2c3d4", lines: 5 });
    await caller.session.peek({ projectId: WORKSPACE, session: "a1b2c3d4" });
    await caller.session.answer({ projectId: WORKSPACE, session: "a1b2c3d4" });
    expect(read.mock.calls).toStrictEqual([
      ["session.list", WORKSPACE, { all: true, state: ["working"] }],
      ["session.show", WORKSPACE, { id: "a1b2c3d4" }],
      ["session.peek", WORKSPACE, { id: "a1b2c3d4", lines: 5 }],
      ["session.peek", WORKSPACE, { id: "a1b2c3d4" }],
      ["session.answer", WORKSPACE, { id: "a1b2c3d4" }],
    ]);
  });

  it("refuses another Workspace before the port is asked, exactly as a Session it cannot find", async () => {
    const read = answering({
      v: 1,
      ok: false,
      error: makeAgentError("SESSION_NOT_FOUND", "No session matches ffffffff."),
    });
    const caller = router(network(device), { readSessionVerb: read });
    const foreign = await refusal(caller.session.list({ projectId: OTHER_WORKSPACE }));
    expect(read).not.toHaveBeenCalled();
    const absent = await refusal(
      caller.session.show({ projectId: WORKSPACE, session: "ffffffff" }),
    );
    for (const error of [foreign, absent]) {
      expect(error).toMatchObject({
        code: "NOT_FOUND",
        reason: "workspace-unknown",
        message: "Not found in this Workspace.",
      });
    }
  });

  it("answers a caller's mistake as BAD_REQUEST, and anything else as the host's failure", async () => {
    for (const [code, expected] of [
      ["AMBIGUOUS_CONTEXT", "BAD_REQUEST"],
      ["INVALID_REQUEST", "BAD_REQUEST"],
      ["DB_UNAVAILABLE", "INTERNAL_SERVER_ERROR"],
    ] as const) {
      const caller = router(network(device), {
        readSessionVerb: answering({
          v: 1,
          ok: false,
          error: makeAgentError(code, `said ${code}`),
        }),
      });
      expect(
        await refusal(caller.session.answer({ projectId: WORKSPACE, session: "a1b2c3d4" })),
      ).toMatchObject({ code: expected, message: `said ${code}` });
    }
  });

  it("refuses an answer that is not JSON, rather than send it", async () => {
    const caller = router(network(device), {
      readSessionVerb: answering({
        v: 1,
        ok: true,
        data: { sessions: [{ at: () => 1 }], hidden: 0 },
      }),
    });
    expect(await refusal(caller.session.list({ projectId: WORKSPACE }))).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("is the person's on the WebSocket, and unavailable where no port is wired", async () => {
    const read = answering({ v: 1, ok: true, data: {} });
    const agent = network({ kind: "session", sessionId: "agent", workspaceId: WORKSPACE });
    expect(
      await refusal(
        router(agent, { readSessionVerb: read }).session.list({ projectId: WORKSPACE }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(read).not.toHaveBeenCalled();
    expect(
      await refusal(router(LOCAL_DESKTOP_CALLER).session.list({ projectId: WORKSPACE })),
    ).toMatchObject({ code: "NOT_IMPLEMENTED", reason: "operation-unavailable" });
  });

  it("refuses an input outside the grammar before anything is read", async () => {
    const read = answering({ v: 1, ok: true, data: {} });
    const caller = router(network(device), { readSessionVerb: read });
    for (const call of [
      caller.session.list({ projectId: WORKSPACE, state: [] }),
      caller.session.peek({ projectId: WORKSPACE, session: "a1b2c3d4", lines: 0 }),
      caller.session.show({ projectId: WORKSPACE, session: "x".repeat(129) }),
    ]) {
      expect(await refusal(call)).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe("protocol.welcome", () => {
  const welcome: HostWelcome = {
    protocolVersion: 1,
    host: { id: HOST, version: "test" },
    workspace: { id: WORKSPACE, epoch: 0 },
    actor: device,
    features: ["sessions"],
    proof: null,
  };

  it("answers the negotiated welcome to any authenticated caller, a Session's included", async () => {
    expect(await router(network(device), { welcome }).protocol.welcome()).toStrictEqual(welcome);
    const agent = network({ kind: "session", sessionId: "agent", workspaceId: WORKSPACE });
    await expect(router(agent, { welcome }).protocol.welcome()).resolves.toBeDefined();
  });

  it("is unavailable on a door that negotiated none", async () => {
    expect(await refusal(router(LOCAL_DESKTOP_CALLER).protocol.welcome())).toMatchObject({
      code: "NOT_IMPLEMENTED",
      reason: "operation-unavailable",
    });
  });
});
