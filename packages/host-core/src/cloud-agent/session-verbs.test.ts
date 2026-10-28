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
import { agentToolCommandId } from "../cloud-runner/derived-id";
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
  let commandStatus = "queued";
  let dropCommand = false;
  let automations: { id: string; name: string }[] = [
    { id: "a1000000-0000-4000-8000-000000000001", name: "Nightly sweep" },
  ];
  let ticketProject = PROJECT;
  let runner = { id: "r1000000-0000-4000-8000-000000000001", name: "Dana's Mac", status: "online" };
  let runMissing = false;
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
      value = {
        page: [remote, { ...remote, id: CALLER, title: "Caller" }],
        isDone: true,
        continueCursor: "",
      };
    else if (wire.path === "sessions:snapshot")
      value = { session: remote, state: null, foldedThrough: 0, catchingUp: false };
    else if (wire.path === "sessions:command") {
      if (dropCommand) {
        res.destroy();
        return;
      }
      value = {
        commandId: wire.args["commandId"],
        status: commandStatus,
        receipt: null,
        runner: { name: "Other Mac" },
      };
    } else if (wire.path === "board:resolveTicketKey")
      value = {
        ticketId: "71000000-0000-4000-8000-000000000001",
        projectId: ticketProject,
        key: "VC-1",
      };
    else if (wire.path === "automations:list") value = automations;
    else if (wire.path === "automations:run") {
      if (runMissing) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "error",
            errorMessage: "Could not find public function for 'automations:run'.",
          }),
        );
        return;
      }
      value = { runId: "run-1", sessionId: "51000000-0000-4000-8000-000000000001", runner };
    } else if (wire.path === "watches:watch") value = { watchId: "watch-id" };
    else if (wire.path === "watches:unwatch") value = { ended: 1 };
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
    commandStatus: (value: string) => {
      commandStatus = value;
    },
    dropCommand: () => {
      dropCommand = true;
    },
    automations: (value: typeof automations) => {
      automations = value;
    },
    ticketProject: (value: string) => {
      ticketProject = value;
    },
    runner: (value: typeof runner) => {
      runner = value;
    },
    runMissing: () => {
      runMissing = true;
    },
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
    ).toContain("Queued steering"); // Durable caller role is project, despite the stale runtime label.
    expect(f.calls.filter((c) => c.path === "sessions:command")).toHaveLength(4);
  });
  it("reports a terminal replay and a lost stop reply honestly", async () => {
    const f = await fixture();
    f.commandStatus("failed");
    expect((await f.tool("session.stop", { session: shortSessionId(REMOTE) }))?.text).toContain(
      "is failed",
    );
    f.commandStatus("done");
    expect((await f.tool("session.stop", { session: shortSessionId(REMOTE) }))?.text).toContain(
      "no second command was queued",
    );
    f.dropCommand();
    expect(
      (await f.tool("session.stop", { session: shortSessionId(REMOTE) }, "lost-stop"))?.text,
    ).toContain("may have landed");
    expect(
      f.calls.filter(
        (c) => c.path === "sessions:command" && c.args["commandId"] === `${CALLER}:lost-stop`,
      ),
    ).toHaveLength(1);
  });
  it("routes durable watch/unwatch and frozen awaits through the Agent token", async () => {
    const f = await fixture();
    const input = { sessions: shortSessionId(REMOTE), tickets: "VC-1" };
    expect((await f.tool("watch", input, "watch-1"))?.text).toContain("Watching");
    expect((await f.tool("watch", input, "watch-1"))?.text).toContain("Watching");
    const arms = f.calls.filter((call) => call.path === "watches:watch");
    expect(arms).toHaveLength(4);
    expect(arms[0]!.args).toEqual(arms[2]!.args);
    expect(arms[0]!.auth).toBe("Bearer agent-token");
    expect(
      (
        await f.tool(
          "session.await",
          { sessions: shortSessionId(REMOTE), for: "verdict" },
          "legacy-1",
        )
      )?.text,
    ).toContain("retired await");
    expect(f.calls.findLast((call) => call.path === "watches:watch")!.args["kinds"]).toEqual([
      "verdict",
    ]);
    expect(
      (await f.tool("watch", { sessions: shortSessionId(REMOTE), action: "unwatch" }))?.details,
    ).toMatchObject({ ended: 1 });
    expect((await f.tool("watch", { sessions: shortSessionId(CALLER) }))?.text).toContain(
      "cannot watch itself",
    );
    f.offline();
    expect((await f.tool("watch", { sessions: shortSessionId(REMOTE) }))?.text).toContain(
      "connection",
    );
  });
  it("queues automation.run in Volli Cloud under a command id derived from the tool call", async () => {
    const f = await fixture();
    const result = await f.tool("automation.run", { automation: "nightly SWEEP", ticket: "VC-1" });
    expect(result?.text).toContain(
      'Queued "Nightly sweep" on VC-1 as Session 51000000 on Dana\'s Mac.',
    );
    expect(result?.text).toContain("watches the Run's Session");
    const run = f.calls.find((call) => call.path === "automations:run");
    expect(run?.args).toEqual({
      commandId: agentToolCommandId(CALLER, "call-1"),
      automationId: "a1000000-0000-4000-8000-000000000001",
      ticketId: "71000000-0000-4000-8000-000000000001",
    });
    // Under the Session's Agent token, never the runner's own.
    expect(run?.auth).toBe("Bearer agent-token");
    expect(f.calls.find((call) => call.path === "automations:list")?.args).toEqual({
      projectId: PROJECT,
    });
    // A Run waiting for an asleep runner says so.
    f.runner({ id: "r1", name: "Dana's Mac", status: "asleep" });
    expect(
      (await f.tool("automation.run", { automation: "Nightly sweep", ticket: "VC-1" }, "call-2"))
        ?.text,
    ).toContain("on Dana's Mac (asleep; it starts when that runner is back).");
  });
  it("answers automation.run's refusals without queuing a Run", async () => {
    const f = await fixture();
    expect((await f.tool("automation.run", { ticket: "VC-1" }))?.text).toContain(
      "automation must be the name",
    );
    expect((await f.tool("automation.run", { automation: "Nightly sweep" }))?.text).toContain(
      "ticket must be a Ticket display id",
    );
    expect(
      (await f.tool("automation.run", { automation: "Weekly", ticket: "VC-1" }))?.text,
    ).toContain('This project lists: "Nightly sweep".');
    f.automations([
      { id: "a1", name: "Sweep" },
      { id: "a2", name: "sweep " },
    ]);
    expect(
      (await f.tool("automation.run", { automation: "sweep", ticket: "VC-1" }))?.text,
    ).toContain("more than one Automation");
    f.automations([]);
    expect(
      (await f.tool("automation.run", { automation: "Sweep", ticket: "VC-1" }))?.text,
    ).toContain("lists none at all");
    f.automations([{ id: "a1", name: "Sweep" }]);
    f.ticketProject("b0000000-0000-4000-8000-000000000001");
    expect((await f.tool("automation.run", { automation: "Sweep", ticket: "VC-1" }))?.text).toBe(
      "Volli refused: No Ticket VC-1 in this project, so nothing was started.",
    );
    expect(f.calls.some((call) => call.path === "automations:run")).toBe(false);
    f.ticketProject(PROJECT);
    f.runMissing();
    expect((await f.tool("automation.run", { automation: "Sweep", ticket: "VC-1" }))?.text).toBe(
      "Volli refused: Volli Cloud cannot run Automations yet, so nothing was started.",
    );
    f.offline();
    expect(
      (await f.tool("automation.run", { automation: "Sweep", ticket: "VC-1" }))?.text,
    ).toContain("offline");
  });
  it("refuses unavailable cloud workflows instead of substituting local behavior", async () => {
    const f = await fixture();
    for (const verb of ["watch", "ticket.await", "session.await"] as const)
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
      data: { queued: true, queuedFor: "Alice" },
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
