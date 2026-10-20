import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { AgentRequest } from "@volli/shared";
import {
  createHostAgentCommands,
  createHostAgentSocket,
  createHostAgentToolDoor,
  createHostAgentWatches,
  type HostAgentCommandOptions,
  type HostAgentToolDoorOptions,
  type HostAgentWatchesOptions,
} from "./agent-services";
import { createAgentCommandService } from "./agent-commands";
import { sealTestHandlers, testHostHandlers } from "./testing/host-handlers";
import { createAgentSocketLifecycle } from "./agent-socket";
import { createAgentToolDoor } from "./agent-tool-door";
import { createWatches } from "./watches";
import { subscribeTicketWake } from "./ticket-wake";
import { HEADLESS_ATTENTION } from "./ports";
import { openTestDb, testProject, testSession } from "./db/test-helpers";
import { insertProject } from "./db/projects-repo";
import { createTestSessionEngine } from "./testing/session-engine";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";

vi.mock("./agent-commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-commands")>();
  return { ...actual, createAgentCommandService: vi.fn(actual.createAgentCommandService) };
});
vi.mock("./agent-socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-socket")>();
  return { ...actual, createAgentSocketLifecycle: vi.fn(actual.createAgentSocketLifecycle) };
});
vi.mock("./agent-tool-door", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-tool-door")>();
  return { ...actual, createAgentToolDoor: vi.fn(actual.createAgentToolDoor) };
});
vi.mock("./watches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./watches")>();
  return { ...actual, createWatches: vi.fn(actual.createWatches) };
});

it("uses the same event bus and attention delivery for socket commands without a client", async () => {
  const ctx = openTestDb();
  try {
    const project = testProject({ path: "/repo/headless" });
    insertProject(ctx.db, project);
    const session = testSession(project.id, null);
    insertSession(ctx.db, session);
    const tokens = createSessionTokenRegistry();
    const token = tokens.mint({ sessionId: session.id, attachmentId: "attachment" });
    const publish = vi.fn();
    const deliver = vi.fn(HEADLESS_ATTENTION.deliver);
    // A JavaScript caller cannot reroute what the host owns.
    const rogue = { onMutation: vi.fn(), notify: vi.fn() };
    const commands = createHostAgentCommands(
      { events: { publish }, attention: { ...HEADLESS_ATTENTION, deliver } },
      {
        handlers: testHostHandlers({ db: ctx.db }),
        db: ctx.db,
        sessionEngine: createTestSessionEngine(ctx.db),
        appVersion: "0.2.1",
        verifySessionToken: tokens.verify,
        ...(rogue as object),
      },
    );
    const context: AgentRequest["ctx"] = {
      cwd: project.path,
      env: { session: session.id, token },
    };
    await expect(
      commands.execute({
        v: 1,
        cmd: "ticket.create",
        args: { title: "Headless ticket" },
        ctx: context,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(publish).toHaveBeenCalledWith("data-changed", {
      projectId: project.id,
      ticketId: expect.any(String),
      kind: "ticket",
    });
    await expect(
      commands.execute({
        v: 1,
        cmd: "notify",
        args: { title: "Agent", message: "Needs input" },
        ctx: context,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      producer: "agent-notify",
      title: "Agent",
      body: "Needs input",
      target: null,
    });
    expect(rogue.onMutation).not.toHaveBeenCalled();
    expect(rogue.notify).not.toHaveBeenCalled();
  } finally {
    ctx.cleanup();
  }
});

it("keeps event and attention routing out of every caller's options", () => {
  for (const owned of [
    "notify",
    "onMutation",
    "onSessionStarted",
    "onHarnessEvent",
    "onSessionHarness",
  ] as const) {
    expectTypeOf<HostAgentCommandOptions>().not.toHaveProperty(owned);
  }
  expectTypeOf<HostAgentToolDoorOptions>().not.toHaveProperty("onMutation");
  expectTypeOf<HostAgentToolDoorOptions>().not.toHaveProperty("onSessionStarted");
  expectTypeOf<HostAgentWatchesOptions>().not.toHaveProperty("subscribeTicketWake");
});

it("requires the host's handler map at both the typed and JavaScript doors", () => {
  expectTypeOf<undefined>().not.toExtend<HostAgentCommandOptions["handlers"]>();
  expect(() =>
    createHostAgentCommands(
      { events: { publish: vi.fn() }, attention: HEADLESS_ATTENTION },
      {} as HostAgentCommandOptions,
    ),
  ).toThrow("The host's handler map is required.");
});

it("owns no shutdown step for the verb door: the socket lifecycle drains requests", () => {
  const commands = createHostAgentCommands(
    { events: { publish: vi.fn() }, attention: HEADLESS_ATTENTION },
    {
      handlers: sealTestHandlers({ "ticket.move": vi.fn() }),
    } as unknown as HostAgentCommandOptions,
  );
  // The WebSocket's Session reads (VC-663, D4) are the same verbs, Workspace-scoped: still no close.
  expect(Object.keys(commands)).toEqual(["execute", "executeInWorkspace"]);
});

it("publishes Session starts and harness notices from the verb door on the host bus", () => {
  const publish = vi.fn();
  createHostAgentCommands({ events: { publish }, attention: HEADLESS_ATTENTION }, {
    handlers: sealTestHandlers({ "ticket.move": vi.fn() }),
  } as unknown as HostAgentCommandOptions);
  const ports = vi.mocked(createAgentCommandService).mock.lastCall![0];
  const started = { sessionId: "s" } as unknown as Parameters<
    NonNullable<typeof ports.onSessionStarted>
  >[0];
  const harness = { sessionId: "s" } as unknown as Parameters<
    NonNullable<typeof ports.onHarnessEvent>
  >[0];
  const attached = { sessionId: "s" } as unknown as Parameters<
    NonNullable<typeof ports.onSessionHarness>
  >[0];
  ports.onSessionStarted!(started);
  ports.onHarnessEvent!(harness);
  ports.onSessionHarness!(attached);
  expect(publish.mock.calls).toEqual([
    ["session-started", started],
    ["harness-event", harness],
    ["session-harness", attached],
  ]);
});

it("routes tool-door mutations and Session starts to the host event bus", () => {
  const publish = vi.fn();
  const rogue = { onMutation: vi.fn(), onSessionStarted: vi.fn() };
  const options = { now: () => 1, ...rogue } as unknown as HostAgentToolDoorOptions;
  const door = createHostAgentToolDoor({ events: { publish } }, options);
  expect(door).toBeTypeOf("function");
  const ports = vi.mocked(createAgentToolDoor).mock.lastCall![0];
  expect(ports.now!()).toBe(1);
  const change = { projectId: "p", ticketId: "t", kind: "session" } as const;
  ports.onMutation!(change);
  const notice = { sessionId: "s" } as unknown as Parameters<
    NonNullable<typeof ports.onSessionStarted>
  >[0];
  ports.onSessionStarted!(notice);
  expect(publish.mock.calls).toEqual([
    ["data-changed", change],
    ["session-started", notice],
  ]);
  expect(rogue.onMutation).not.toHaveBeenCalled();
  expect(rogue.onSessionStarted).not.toHaveBeenCalled();
});

it("builds watches over the process ticket-wake bus and releases both buses on dispose", () => {
  const unsubscribeSessions = vi.fn();
  const subscribeSessionWake = vi.fn(() => unsubscribeSessions);
  const rogueTicketWake = vi.fn(() => () => {});
  const watches = createHostAgentWatches({
    subscribeSessionWake,
    runtime: { command: vi.fn(), subscribe: vi.fn(), projection: vi.fn() },
    sessionEngine: { listEvents: vi.fn() },
    readComment: () => null,
    subscribeTicketWake: rogueTicketWake,
  } as unknown as HostAgentWatchesOptions);
  const ports = vi.mocked(createWatches).mock.lastCall![0];
  expect(ports.subscribeTicketWake).toBe(subscribeTicketWake);
  expect(rogueTicketWake).not.toHaveBeenCalled();
  expect(subscribeSessionWake).toHaveBeenCalledOnce();
  watches.dispose();
  expect(unsubscribeSessions).toHaveBeenCalledOnce();
});

it("owns the socket before database construction and tolerates shutdown before start", async () => {
  const socket = createHostAgentSocket();
  expect(socket.live()).toBe(false);
  await socket.shutdown();
  expect(socket.live()).toBe(false);
});

it("reports a socket close failure in words rather than throwing it", () => {
  createHostAgentSocket();
  const lifecycle = vi.mocked(createAgentSocketLifecycle).mock.lastCall![0];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    lifecycle.reportFailure(new Error("EBUSY"));
    expect(error).toHaveBeenCalledExactlyOnceWith("[agent-socket] failed to close agent socket", {
      error: expect.objectContaining({ name: "Error", message: "EBUSY" }),
    });
  } finally {
    error.mockRestore();
  }
});
