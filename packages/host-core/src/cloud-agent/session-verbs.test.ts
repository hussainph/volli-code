import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  LOCAL_RUNNER,
  shortSessionId,
  type RuntimeSessionIdentity,
  type RuntimeVerbCall,
} from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import { createAgentBackend } from "./agent-backend";
import { createCloudFunctionsClient } from "./functions-client";
import { createCloudSessionVerbs } from "./session-verbs";
import { createAgentCommandService } from "../agent-commands";
import { testHostHandlers } from "../testing/host-handlers";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const CALLER = "c0000000-0000-4000-8000-000000000001";
const LOCAL = "10000000-0000-4000-8000-000000000001";
const REMOTE = "20000000-0000-4000-8000-000000000001";
const identity = {
  sessionId: CALLER,
  projectId: PROJECT,
  ticketId: null,
  role: "project",
} as RuntimeSessionIdentity;
let db: TestDb | undefined;
let server: Server | undefined;
afterEach(async () => {
  db?.cleanup();
  db = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function fixture() {
  db = openTestDb();
  insertProject(db.db, testProject({ id: PROJECT }));
  const engine = createTestSessionEngine(db.db);
  for (const id of [CALLER, LOCAL])
    await engine.createSession({
      requestedSessionId: id,
      commandId: `create-${id}`,
      projectId: PROJECT,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Local",
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: LOCAL_RUNNER },
    });
  const calls: {
    kind: string;
    path: string;
    args: Record<string, unknown>;
    auth: string | undefined;
  }[] = [];
  const remote = {
    id: REMOTE,
    projectId: PROJECT,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    ownerUserId: "owner",
    title: "Remote",
    status: "open",
    stopped: null,
    signal: null,
    turnActive: false,
    visibility: "private",
    createdAt: 100,
    lastActivityAt: 100,
    listing: { activity: "idle", waitingOn: null, liveness: "detached", bornTicketless: true },
  };
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body) as { path: string; args: Record<string, unknown> };
    calls.push({ ...wire, kind: req.url!, auth: req.headers.authorization });
    let value: unknown;
    if (wire.path === "agentTokens:mint")
      value = { token: "agent-token", serverTime: Date.now(), expiresAt: Date.now() + 900_000 };
    else if (wire.path === "projects:listForActor")
      value = {
        projects: [{ id: PROJECT, name: "Volli", ticketPrefix: "VC", archivedAt: null }],
        current: PROJECT,
      };
    else if (wire.path === "sessions:list")
      value = { page: [remote], isDone: true, continueCursor: "" };
    else if (wire.path === "sessions:snapshot")
      value = { session: remote, state: null, foldedThrough: 0, catchingUp: false };
    else if (wire.path === "sessions:command")
      value = {
        commandId: wire.args["commandId"],
        status: "queued",
        receipt: null,
        runner: { name: "Other Mac" },
      };
    else if (wire.path === "board:resolveTicketKey")
      value = { ticketId: "ticket", projectId: PROJECT };
    else throw new Error(`Unexpected ${wire.path}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", value }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  let connected = true;
  const backend = createAgentBackend({
    functions: createCloudFunctionsClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }),
    runnerToken: async () => "runner-token",
    connected: () => connected,
  });
  const notify = vi.fn(async () => ({ displayName: "Alice" }));
  const verbs = createCloudSessionVerbs({
    backend,
    engine,
    projectIds: () => [PROJECT],
    claimedHere: (id) => id === LOCAL || id === CALLER,
    notify,
  });
  const tool = (
    verb: RuntimeVerbCall["verb"],
    input: Record<string, unknown>,
    call = "call-1",
    caller = identity,
  ) => verbs.tool(caller, { verb, input, toolCallId: call });
  return {
    verbs,
    tool,
    calls,
    notify,
    engine,
    offline: () => {
      connected = false;
    },
  };
}

describe("cloud Session target routing", () => {
  it("records its own done signal offline through the actual socket command service", async () => {
    const f = await fixture();
    f.offline();
    const service = createAgentCommandService({
      db: db!.db,
      appVersion: "test",
      handlers: testHostHandlers({ db: db!.db }),
      sessionEngine: f.engine,
      cloudSessionVerbs: f.verbs,
      verifySessionToken: () => CALLER,
    });
    expect(
      await service.execute({
        v: 1,
        cmd: "session.done",
        args: { reason: "Finished offline" },
        ctx: { cwd: "/", env: { session: CALLER, token: "attachment-token" } },
      }),
    ).toMatchObject({ ok: true, data: { signal: "done", recorded: true } });
    expect(
      (await f.engine.listEvents({ sessionId: CALLER })).some(
        (event) => event.payload.kind === "session.signaled",
      ),
    ).toBe(true);
    expect(f.calls).toEqual([]);
  });
  it("keeps local send/stop/read entirely on the ledger while offline", async () => {
    const f = await fixture();
    f.offline();
    expect(
      await f.tool("session.send", { session: shortSessionId(LOCAL), message: "Here" }),
    ).toBeNull();
    expect(await f.tool("session.stop", { session: shortSessionId(LOCAL) })).toBeNull();
    expect(
      await f.verbs.socket({
        sessionId: CALLER,
        request: {
          v: 1,
          cmd: "session.show",
          args: { id: shortSessionId(LOCAL) },
          ctx: { cwd: "/", env: {} },
        },
      }),
    ).toBeNull();
    expect(f.calls).toEqual([]);
    expect(
      (await f.tool("session.send", { session: shortSessionId(REMOTE), message: "There" }))?.text,
    ).toContain("needs a connection");
    expect(f.calls).toEqual([]);
  });
  it("queues remote sends and stops under the Agent token with replay-stable ids", async () => {
    const f = await fixture();
    const input = { session: shortSessionId(REMOTE), message: "Direction" };
    expect((await f.tool("session.send", input))?.text).toContain("Queued steering");
    await f.tool("session.send", input);
    await f.tool("session.stop", { session: shortSessionId(REMOTE), reason: "Finished" }, "stop-1");
    const commands = f.calls.filter((c) => c.path === "sessions:command");
    expect(commands).toHaveLength(3);
    expect(commands[0]!.auth).toBe("Bearer agent-token");
    expect(commands[0]!.args).toEqual(commands[1]!.args);
    expect(commands[0]!.args["commandId"]).toBe(`${CALLER}:call-1`);
    const artifact = JSON.parse(commands[0]!.args["artifact"] as string);
    expect(artifact.message.parts[0].text).toContain("Steering from supervising Session");
    expect(JSON.parse(commands[2]!.args["intent"] as string)).toEqual({
      kind: "session.stop",
      by: { kind: "session", sessionId: CALLER },
      reason: "Finished",
    });
    expect(
      (
        await f.tool("session.send", input, "ticket", {
          ...identity,
          role: "ticket",
          ticketId: "t",
        })
      )?.text,
    ).toContain("only its own subagents");
    expect(f.calls.filter((c) => c.path === "sessions:command")).toHaveLength(3);
  });
  it("refuses unavailable cloud workflows instead of substituting local behavior", async () => {
    const f = await fixture();
    for (const verb of ["watch", "ticket.await", "session.await", "automation.run"] as const)
      expect((await f.tool(verb, {}))?.text).toContain("refused");
    expect((await f.tool("session.start", { ticket: "VC-1", env: "Other Mac" }))?.text).toContain(
      "Omit env",
    );
    expect(f.calls).toEqual([]);
  });
  it("queues notify for the authenticated owner and refuses a bare socket claim", async () => {
    const f = await fixture();
    const request = {
      v: 1 as const,
      cmd: "notify" as const,
      args: { title: "Build", message: "Finished" },
      ctx: { cwd: "/", env: {} },
    };
    expect(await f.verbs.socket({ sessionId: CALLER, request })).toMatchObject({
      ok: true,
      data: { notified: true, queuedFor: "Alice" },
    });
    expect(f.notify).toHaveBeenCalledWith(CALLER, {
      notifyId: expect.any(String),
      title: "Build",
      detail: "Finished",
    });
    expect(await f.verbs.socket({ sessionId: null, request })).toMatchObject({
      ok: false,
      error: { code: "SIGN_IN_REQUIRED" },
    });
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
});
