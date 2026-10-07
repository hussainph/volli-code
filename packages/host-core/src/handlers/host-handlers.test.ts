/**
 * The host's one handler map (VC-668): total over the catalog, and each entry
 * the whole command, with the behaviour composition roots used to write
 * around a low-level call.
 */
import type { SessionRuntime } from "@volli/session-engine";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  HOST_HANDLER_KEYS,
  isOperationUnavailable,
  OperationUnavailableError,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  type AddHostEvent,
  type DataChangedEvent,
  type HandlerCall,
  type ModelAccessSnapshot,
  type RemoteHostsSnapshot,
  type TicketEventActor,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { listProjects } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import type { RuntimeAutomations } from "../session-runtime/automations";
import { createTicketCommand } from "../ticket-commands";
import { runGitCapturing, runGitCapturingAsync } from "../worktree/git";
import { ADMITTED, admittedHandlers, type HandlerPolicy } from "./handler-map";
import {
  createHostHandlers,
  type HostHandlerCoverage,
  type HostHandlerOptions,
  type HostHandlers,
} from "./host-handlers";
import type { RemoteHostsPort } from "./remote-hosts-port";

vi.mock("../session-runtime/model-access-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-runtime/model-access-preferences")>()),
  reconcileModelAccessPreferences: vi.fn(),
  assertDefaultModelAvailable: vi.fn(),
}));
const preferences = await import("../session-runtime/model-access-preferences");

const USER: HandlerCall = { actor: { kind: "user" } };
const WINDOW: HandlerCall = { actor: { kind: "user" }, origin: "desktop-window" };
const PROJECT = "project";

let ctx: TestDb;
let publish: ReturnType<typeof vi.fn>;
let deliver: ReturnType<typeof vi.fn>;
let noteDeliberateMove: ReturnType<typeof vi.fn>;
let resumeDeliveryForSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: PROJECT, ticketPrefix: "VC" }));
  publish = vi.fn();
  deliver = vi.fn(() => ({ delivered: true }));
  noteDeliberateMove = vi.fn();
  resumeDeliveryForSession = vi.fn(async () => {});
});

afterEach(() => {
  ctx.cleanup();
  vi.clearAllMocks();
});

function automations(kind: "ready" | "idle" | "degraded" = "ready"): RuntimeAutomations {
  if (kind === "degraded") return { kind: "degraded" } as RuntimeAutomations;
  return {
    kind: "live",
    execution:
      kind === "idle"
        ? { kind: "idle" }
        : {
            kind: "ready",
            runner: { resumeDeliveryForSession },
            pendingArmedRuns: { noteDeliberateMove },
          },
  } as unknown as RuntimeAutomations;
}

/** Admits everything: these cases are about what each handler does, not who may call it. */
const OPEN: HandlerPolicy = { door: "test", admit: () => ADMITTED };

function handlers(options: Partial<HostHandlerOptions> = {}): HostHandlers {
  return admittedHandlers(sealedMap(options), OPEN);
}

function sealedMap(options: Partial<HostHandlerOptions> = {}) {
  return createHostHandlers(
    {
      events: { publish },
      attention: { deliver, focusedSessionIds: () => new Set() },
    } as never,
    {
      db: ctx.db,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: automations(),
      busyWorktreeSites: async () => [],
      now: () => 50,
      worktree: { db: ctx.db, git: runGitCapturing, gitAsync: runGitCapturingAsync, blobsRoot: "" },
      ...options,
    },
  );
}

async function unavailable(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(isOperationUnavailable(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected the handler to answer unavailable");
}

function ticket(id: string, status: "todo" | "doing" | "done" = "todo") {
  return createTicketCommand(
    ctx.db,
    { id, projectId: PROJECT, title: id, status },
    { now: 1, actor: { kind: "user" } },
  );
}

describe("the map", () => {
  it("has a handler for every catalog key, and no other", () => {
    expectTypeOf<HostHandlerCoverage>().toEqualTypeOf<never>();
    expect(Object.keys(handlers()).toSorted()).toEqual([...HOST_HANDLER_KEYS].toSorted());
  });

  it("refuses to build without the busy-worktree guard, for a JavaScript caller too", () => {
    expect(() => handlers({ busyWorktreeSites: undefined as never })).toThrow(
      "The busy-worktree supplier is required.",
    );
  });

  it("answers unavailable for every service this host lacks, with the client's message", async () => {
    const empty = handlers({ db: null });
    expect(await unavailable(() => empty["sessions.create"]({} as never, USER))).toBe(
      "Sessions are unavailable on this transport",
    );
    expect(await unavailable(() => empty["settings.experiments"](undefined, USER))).toBe(
      "Experimental settings are unavailable on this transport",
    );
    expect(await unavailable(() => empty["modelAccess.inspect"]({}, USER))).toBe(
      "Model Access is unavailable on this transport",
    );
    expect(await unavailable(() => empty["modelAccess.defaults"](undefined, USER))).toBe(
      "Model Access preferences are unavailable on this transport",
    );
    expect(await unavailable(() => empty["session.snapshot"]({ sessionId: "s" }, USER))).toBe(
      "The Session runtime is unavailable on this host",
    );
    expect(
      await unavailable(() =>
        empty["ticket.move"]({ projectId: PROJECT, ticketId: "t", toStatus: "done" }, USER),
      ),
    ).toBe("The board is unavailable: the database did not open");
    expect(await unavailable(() => empty["project.reorder"]({ orderedIds: [] }, WINDOW))).toBe(
      "The board is unavailable: the database did not open",
    );
    expect(await unavailable(() => empty["worktree.trimSettings"](undefined, WINDOW))).toBe(
      "The board is unavailable: the database did not open",
    );
    // The desktop serves the socket's Session reads over no network door.
    expect(
      await unavailable(() => empty["session.list"]({ workspaceId: PROJECT, args: {} }, USER)),
    ).toBe("Session reads are unavailable on this transport");
    // A host that keeps no recent log says so (VC-699).
    expect(await unavailable(() => empty["logs.tail"]({}, USER))).toBe(
      "This host keeps no log to read",
    );
    // A default needs Model Access as well as the database.
    expect(
      await unavailable(() =>
        handlers()["modelAccess.setDefault"]({ purpose: "ticket", selection: null }, USER),
      ),
    ).toBe("Model Access preferences are unavailable on this transport");
  });
});

describe("sign-ins on a host (VC-702)", () => {
  it("answers unavailable where no network door serves them, and delegates each key once", async () => {
    const empty = handlers();
    expect(await unavailable(() => empty["signIns.status"](undefined, USER))).toBe(
      "Sign-ins are unavailable on this host",
    );
    expect(
      await unavailable(() =>
        empty["signIns.subscribe"]({ flowId: "f" }, USER, { emit() {}, fail() {} }),
      ),
    ).toBe("Sign-ins are unavailable on this host");
    const reached: [string, unknown, unknown][] = [];
    const service = (method: string) =>
      vi.fn((input: unknown, call?: unknown) => {
        reached.push([method, input, call]);
        return method === "subscribe" ? Promise.resolve(() => {}) : `${method}-answer`;
      });
    const signIns = {
      status: service("status"),
      setApiKey: service("setApiKey"),
      signOut: service("signOut"),
      start: service("start"),
      subscribe: service("subscribe"),
      answer: service("answer"),
      cancel: service("cancel"),
      setGitCredential: service("setGitCredential"),
      clearGitCredential: service("clearGitCredential"),
      deliverCallback: service("deliverCallback"),
    };
    const map = handlers({ signIns: signIns as never });
    const flow = { flowId: "f" };
    expect(await map["signIns.status"](undefined, USER)).toBe("status-answer");
    await map["signIns.setApiKey"]({ providerId: "p", key: "k" }, USER);
    await map["signIns.signOut"]({ providerId: "p" }, USER);
    await map["signIns.start"]({ providerId: "p" }, USER);
    await map["signIns.subscribe"](flow, USER, { emit() {}, fail() {} });
    await map["signIns.answer"]({ ...flow, promptId: "q", value: "v" }, USER);
    await map["signIns.cancel"](flow, USER);
    await map["signIns.setGitCredential"]({ host: "h", username: "u", password: "p" }, USER);
    await map["signIns.clearGitCredential"]({ host: "h" }, USER);
    await map["auth.callback.deliver"]({ ...flow, pathAndQuery: "/cb" }, USER);
    expect(reached.map(([method]) => method)).toEqual([
      "status",
      "setApiKey",
      "signOut",
      "start",
      "subscribe",
      "answer",
      "cancel",
      "setGitCredential",
      "clearGitCredential",
      "deliverCallback",
    ]);
    // The flow operations are handed the call: its connection owns the flow.
    for (const [method, , call] of reached) {
      if (["start", "subscribe", "answer", "cancel", "deliverCallback"].includes(method)) {
        expect(call).toBe(USER);
      }
    }
  });
});

describe("sign-ins on a remote host, from this desktop (VC-702 PR 2)", () => {
  it("answers unavailable without the port, and passes each key through it once", async () => {
    const empty = handlers();
    expect(await unavailable(() => empty["hostSignIns.status"]({ hostId: "h" }, USER))).toBe(
      "Remote host sign-ins are unavailable on this host",
    );
    const reached: string[] = [];
    const port = {
      status: vi.fn(() => (reached.push("status"), "status")),
      macKeys: vi.fn(() => (reached.push("macKeys"), ["openrouter"])),
      sendFromThisMac: vi.fn(() => (reached.push("send"), { ok: true })),
      setApiKey: vi.fn(() => (reached.push("setApiKey"), "status")),
      setGitCredential: vi.fn(() => (reached.push("setGit"), "status")),
      run: vi.fn(async (_host: string, _provider: string, listener: (event: unknown) => void) => {
        reached.push("run");
        await listener({ kind: "done" });
        return () => {};
      }),
      answer: vi.fn(() => void reached.push("answer")),
      cancel: vi.fn(() => void reached.push("cancel")),
    };
    const map = handlers({ remoteSignIns: port as never });
    expect(await map["hostSignIns.status"]({ hostId: "h" }, USER)).toBe("status");
    expect(await map["hostSignIns.macKeys"](undefined, USER)).toEqual(["openrouter"]);
    await map["hostSignIns.sendFromThisMac"](
      { hostId: "h", providerId: "p", confirmed: true },
      USER,
    );
    await map["hostSignIns.setApiKey"]({ hostId: "h", providerId: "p", key: "k" }, USER);
    await map["hostSignIns.setGitCredential"](
      { hostId: "h", host: "github.com", username: "u", password: "t" },
      USER,
    );
    const emitted: unknown[] = [];
    await map["hostSignIns.run"]({ hostId: "h", providerId: "p" }, USER, {
      emit: (event) => void emitted.push(event),
      fail() {},
    });
    expect(emitted).toEqual([{ kind: "done" }]);
    expect(
      await map["hostSignIns.answer"]({ hostId: "h", providerId: "p", promptId: "q", value: "" }, USER),
    ).toBeNull();
    expect(await map["hostSignIns.cancel"]({ hostId: "h", providerId: "p" }, USER)).toBeNull();
    expect(reached).toEqual([
      "status",
      "macKeys",
      "send",
      "setApiKey",
      "setGit",
      "run",
      "answer",
      "cancel",
    ]);
    expect(port.setGitCredential).toHaveBeenCalledWith("h", {
      host: "github.com",
      username: "u",
      password: "t",
    });
  });

  it("never lets a failure echo the key, token or answer it was given", async () => {
    const secret = "sk-THE-SECRET-VALUE-0123456789";
    const echo = () => {
      throw new Error(`rejected ${secret}`);
    };
    const map = handlers({
      remoteSignIns: { setApiKey: echo, setGitCredential: echo, answer: echo } as never,
    });
    for (const call of [
      () => map["hostSignIns.setApiKey"]({ hostId: "h", providerId: "p", key: secret }, USER),
      () =>
        map["hostSignIns.setGitCredential"](
          { hostId: "h", host: "github.com", username: "u", password: secret },
          USER,
        ),
      () =>
        map["hostSignIns.answer"](
          { hostId: "h", providerId: "p", promptId: "q", value: secret },
          USER,
        ),
    ]) {
      await expect(Promise.resolve().then(call)).rejects.toThrow("rejected [redacted]");
    }
  });
});

describe("Session commands", () => {
  it("passes each runtime command through, fixing what a person's door may say", async () => {
    const runtime = {
      snapshot: vi.fn(async () => "snapshot"),
      history: vi.fn(async () => "history"),
      projection: vi.fn(async () => "projection"),
      subscribe: vi.fn(async (_input, listener, onFailure) => {
        await listener("emission");
        onFailure?.("failure");
        return () => {};
      }),
      command: vi.fn(async () => "result"),
      cancelInteraction: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
    } as unknown as SessionRuntime;
    const map = handlers({ runtime });
    await expect(map["session.snapshot"]({ sessionId: "s" }, USER)).resolves.toBe("snapshot");
    await expect(map["session.history"]({ sessionId: "s", before: 2 }, USER)).resolves.toBe(
      "history",
    );
    await expect(map["session.projection"]({ sessionId: "s" }, USER)).resolves.toBe("projection");
    const emit = vi.fn();
    const fail = vi.fn();
    await map["session.subscribe"]({ sessionId: "s", afterSequence: 3 }, USER, { emit, fail });
    await map["session.subscribeQueue"]({ sessionId: "s", afterSequence: 3 }, USER, { emit, fail });
    expect(runtime.subscribe).toHaveBeenCalledWith(
      { sessionId: "s", afterSequence: 3 },
      expect.any(Function),
      expect.any(Function),
    );
    expect(emit).toHaveBeenCalledWith("emission");
    expect(fail).toHaveBeenCalledWith("failure");
    await expect(map["session.command"]({} as never, USER)).resolves.toBe("result");
    await map["session.cancelQueued"](
      { commandId: "cancel", sessionId: "s", messageId: "m" },
      USER,
    );
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "cancel",
      sessionId: "s",
      command: { kind: "message.cancel", messageId: "m" },
    });
    const message = {
      id: "m",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "edited" }],
    };
    await map["session.editQueued"](
      { commandId: "edit", sessionId: "s", messageId: "m", message },
      USER,
    );
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "edit",
      sessionId: "s",
      command: { kind: "message.edit", messageId: "m", message },
    });
    // A Client that read the queue at a revision passes it through unchanged.
    await map["session.cancelQueued"](
      { commandId: "cancel-at", sessionId: "s", messageId: "m", expectedRevision: 4 },
      USER,
    );
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "cancel-at",
      sessionId: "s",
      command: { kind: "message.cancel", messageId: "m", expectedRevision: 4 },
    });
    await map["session.editQueued"](
      { commandId: "edit-at", sessionId: "s", messageId: "m", message, expectedRevision: 0 },
      USER,
    );
    expect(runtime.command).toHaveBeenCalledWith({
      commandId: "edit-at",
      sessionId: "s",
      command: { kind: "message.edit", messageId: "m", message, expectedRevision: 0 },
    });
    await map["session.cancelInteraction"]({ sessionId: "s", interactionId: "i" }, USER);
    expect(runtime.cancelInteraction).toHaveBeenCalledWith({
      sessionId: "s",
      interactionId: "i",
      reason: "abandoned",
      origin: { kind: "user" },
    });
    await map["session.reconcile"]({ sessionId: "s", attachmentId: "a" }, USER);
    expect(runtime.reconcile).toHaveBeenCalledWith({ sessionId: "s", attachmentId: "a" });
    // A bounded door's cancellation reaches the runtime with the subscription.
    const signal = new AbortController().signal;
    await map["session.subscribe"]({ sessionId: "s", afterSequence: 0, signal }, USER, {
      emit,
      fail,
    });
    expect(runtime.subscribe).toHaveBeenLastCalledWith(
      { sessionId: "s", afterSequence: 0, signal },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("runs the socket's Session reads Workspace-scoped, through the port it was given (VC-663)", async () => {
    const answer = { v: 1, ok: true, data: { sessions: [], hidden: 0 } } as const;
    const sessionReads = vi.fn(async () => answer);
    const map = handlers({ sessionReads });
    for (const verb of [
      "session.list",
      "session.show",
      "session.peek",
      "session.answer",
    ] as const) {
      await expect(map[verb]({ workspaceId: PROJECT, args: { id: "a1" } }, USER)).resolves.toBe(
        answer,
      );
    }
    expect(sessionReads.mock.calls).toEqual([
      ["session.list", PROJECT, { id: "a1" }],
      ["session.show", PROJECT, { id: "a1" }],
      ["session.peek", PROJECT, { id: "a1" }],
      ["session.answer", PROJECT, { id: "a1" }],
    ]);
  });

  it("states the Role a person's choice of ticket implies", async () => {
    const create = vi.fn(async (_input: { role: string }) => ({
      sessionId: "s",
      model: {} as never,
    }));
    const map = handlers({ sessions: { create, attach: vi.fn() } });
    const input = { operationId: "op", projectId: PROJECT, title: null };
    await map["sessions.create"]({ ...input, ticketId: "t" }, USER);
    await map["sessions.create"]({ ...input, ticketId: null }, USER);
    expect(create.mock.calls.map(([call]) => call.role)).toEqual(["ticket", "project"]);
  });

  it("resumes an Automation's delivery after a ready attach, and only then", async () => {
    const attach = vi.fn(async () => ({ state: "ready" }) as never);
    const ready = handlers({ sessions: { create: vi.fn(), attach } });
    await ready["sessions.attach"]({ operationId: "op", sessionId: "s" }, USER);
    expect(resumeDeliveryForSession).toHaveBeenCalledExactlyOnceWith("s");

    resumeDeliveryForSession.mockClear();
    for (const kind of ["idle", "degraded"] as const) {
      await handlers({ sessions: { create: vi.fn(), attach }, automations: automations(kind) })[
        "sessions.attach"
      ]({ operationId: "op", sessionId: "s" }, USER);
    }
    attach.mockResolvedValueOnce({ state: "starting" } as never);
    await ready["sessions.attach"]({ operationId: "op", sessionId: "s" }, USER);
    expect(resumeDeliveryForSession).not.toHaveBeenCalled();
  });
});

describe("host settings", () => {
  it("reads and writes experiments through the host's settings", async () => {
    const snapshot = { cloud: { enabled: false, source: "default" } } as never;
    const set = vi.fn(() => snapshot);
    const map = handlers({ experiments: { snapshot: () => snapshot, set } });
    expect(await map["settings.experiments"](undefined, USER)).toBe(snapshot);
    await map["settings.setExperiment"]({ id: "cloud", enabled: true }, USER);
    expect(set).toHaveBeenCalledWith("cloud", true);
  });

  it("reconciles stored preferences after a refresh, and only a refresh", async () => {
    const access = { models: [] } as unknown as ModelAccessSnapshot;
    const inspectModelAccess = vi.fn(async () => access);
    await handlers({ modelAccess: { inspectModelAccess } })["modelAccess.inspect"]({}, USER);
    expect(preferences.reconcileModelAccessPreferences).not.toHaveBeenCalled();
    await handlers({ modelAccess: { inspectModelAccess } })["modelAccess.inspect"](
      { refresh: true },
      USER,
    );
    expect(preferences.reconcileModelAccessPreferences).toHaveBeenCalledWith(ctx.db, access, 50);
    vi.mocked(preferences.reconcileModelAccessPreferences).mockClear();
    await handlers({ db: null, modelAccess: { inspectModelAccess } })["modelAccess.inspect"](
      { refresh: true },
      USER,
    );
    expect(preferences.reconcileModelAccessPreferences).not.toHaveBeenCalled();
  });

  it("checks a default is runnable before saving it, and clears one without asking", async () => {
    const access = { models: [] } as unknown as ModelAccessSnapshot;
    const map = handlers({ modelAccess: { inspectModelAccess: async () => access } });
    const selection = { providerId: "p", modelId: "m", reasoningLevel: "medium" } as const;
    await expect(
      map["modelAccess.setDefault"]({ purpose: "ticket", selection }, USER),
    ).resolves.toMatchObject({ ticket: selection });
    expect(preferences.assertDefaultModelAvailable).toHaveBeenCalledWith(
      access,
      selection,
      "ticket",
    );
    vi.mocked(preferences.assertDefaultModelAvailable).mockClear();
    await expect(
      map["modelAccess.setDefault"]({ purpose: "ticket", selection: null }, USER),
    ).resolves.toMatchObject({ ticket: null });
    expect(preferences.assertDefaultModelAvailable).not.toHaveBeenCalled();
    expect(await map["modelAccess.defaults"](undefined, USER)).toEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
  });

  it("round-trips every stored preference", async () => {
    const map = handlers();
    const hidden = [{ providerId: "p", modelId: "m" }];
    await map["modelAccess.setHiddenModels"](hidden, USER);
    expect(await map["modelAccess.hiddenModels"](undefined, USER)).toEqual(hidden);
    const compaction = { autoCompaction: false };
    expect(await map["modelAccess.setCompactionPolicy"](compaction, USER)).toEqual(compaction);
    expect(await map["modelAccess.compactionPolicy"](undefined, USER)).toEqual(compaction);
    const codeMode = { enabled: true, models: {} };
    expect(await map["modelAccess.setCodeModePolicy"](codeMode, USER)).toEqual(codeMode);
    expect(await map["modelAccess.codeModePolicy"](undefined, USER)).toEqual(codeMode);
    expect(await map["modelAccess.setPickerView"]("all", USER)).toBe("all");
    expect(await map["modelAccess.pickerView"](undefined, USER)).toBe("all");
  });
});

// The desktop-only tier (VC-608): the bodies `volli:project-reorder` and
// `volli:worktree-trim-settings-get` had, moved into the map unchanged.
describe("desktop-only commands", () => {
  it("puts the rail's projects in the order given", async () => {
    insertProject(ctx.db, testProject({ id: "second", ticketPrefix: "SE" }));
    expect(await handlers()["project.reorder"]({ orderedIds: ["second", PROJECT] }, WINDOW)).toBe(
      null,
    );
    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual(["second", PROJECT]);
  });

  it("reads the host's trim settings, defaults included", async () => {
    expect(await handlers()["worktree.trimSettings"](undefined, WINDOW)).toMatchObject({
      trimOnFinish: expect.any(Boolean),
      keepPatterns: expect.any(Array),
    });
  });
});

/** A subscription's sink that records what it is fed. */
function sink() {
  return { emit: vi.fn(), fail: vi.fn() };
}

// Remote hosts (VC-700 PR 2): desktop main's registry, through its port;
// absent everywhere else.
describe("remote hosts commands", () => {
  const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const FLOW = "flow-1";
  const SNAPSHOT: RemoteHostsSnapshot = { v: 1, hosts: [], projects: {}, readOnly: null };
  const EVENT: AddHostEvent = {
    kind: "log",
    flowId: FLOW,
    line: { at: "2026-10-06T00:00:00.000Z", level: "info", message: "probe", fields: {} },
  };
  const PASSWORD = "hunter2-sudo";

  function port(overrides: Partial<RemoteHostsPort> = {}) {
    const unsubscribe = vi.fn();
    const remote = {
      snapshot: vi.fn(() => SNAPSHOT),
      subscribe: vi.fn(async (listener: (snapshot: RemoteHostsSnapshot) => unknown) => {
        await listener(SNAPSHOT);
        return unsubscribe;
      }),
      retry: vi.fn(),
      updateHost: vi.fn(async () => {}),
      cancelScheduledUpdate: vi.fn(),
      signIn: vi.fn(),
      forget: vi.fn(),
      startAdd: vi.fn(async () => ({ flowId: FLOW, extra: "not on the wire" })),
      subscribeAdd: vi.fn((_flowId: string, listener: (event: AddHostEvent) => unknown) => {
        void listener(EVENT);
        return unsubscribe;
      }),
      answerAdd: vi.fn(),
      sudoPassword: vi.fn(),
      retryAdd: vi.fn(),
      cancelAdd: vi.fn(),
      ...overrides,
    } satisfies RemoteHostsPort;
    return { remote, unsubscribe };
  }

  it("answers unavailable for every key on a host with no registry (hostd)", async () => {
    for (const map of [handlers(), handlers({ remoteHosts: null })]) {
      const calls: (() => unknown)[] = [
        () => map["hosts.snapshot"](undefined, WINDOW),
        () => map["hosts.subscribe"](undefined, WINDOW, sink()),
        () => map["hosts.retry"]({ hostId: HOST }, WINDOW),
        () => map["hosts.updateHost"]({ hostId: HOST, when: "now" }, WINDOW),
        () => map["hosts.cancelScheduledUpdate"]({ hostId: HOST }, WINDOW),
        () => map["hosts.signIn"]({ hostId: HOST, providerId: "anthropic" }, WINDOW),
        () => map["hosts.forget"]({ hostId: HOST }, WINDOW),
        () => map["hostAdd.start"]({ target: "you@box" }, WINDOW),
        () => map["hostAdd.subscribe"]({ flowId: FLOW }, WINDOW, sink()),
        () =>
          map["hostAdd.answer"](
            { flowId: FLOW, questionId: "q1", answer: { kind: "adopt" } },
            WINDOW,
          ),
        () =>
          map["hostAdd.sudoPassword"](
            { flowId: FLOW, questionId: "q1", password: PASSWORD },
            WINDOW,
          ),
        () => map["hostAdd.retry"]({ flowId: FLOW }, WINDOW),
        () => map["hostAdd.cancel"]({ flowId: FLOW }, WINDOW),
      ];
      for (const call of calls) {
        expect(await unavailable(call)).toBe("Remote hosts are unavailable on this host");
      }
    }
  });

  it("passes each command to the registry, answering null for an effect", async () => {
    const { remote } = port();
    const map = handlers({ remoteHosts: remote });
    expect(await map["hosts.snapshot"](undefined, WINDOW)).toBe(SNAPSHOT);
    expect(await map["hosts.retry"]({ hostId: HOST }, WINDOW)).toBeNull();
    expect(await map["hosts.updateHost"]({ hostId: HOST, when: "when-idle" }, WINDOW)).toBeNull();
    expect(await map["hosts.cancelScheduledUpdate"]({ hostId: HOST }, WINDOW)).toBeNull();
    expect(await map["hosts.signIn"]({ hostId: HOST, providerId: "anthropic" }, WINDOW)).toBeNull();
    expect(await map["hosts.forget"]({ hostId: HOST }, WINDOW)).toBeNull();
    // Only the flow's id crosses: nothing else the registry answered.
    expect(await map["hostAdd.start"]({ target: "you@box", name: "Box" }, WINDOW)).toEqual({
      flowId: FLOW,
    });
    expect(
      await map["hostAdd.answer"](
        { flowId: FLOW, questionId: "q1", answer: { kind: "accept-host-key" } },
        WINDOW,
      ),
    ).toBeNull();
    expect(
      await map["hostAdd.sudoPassword"](
        { flowId: FLOW, questionId: "q1", password: PASSWORD },
        WINDOW,
      ),
    ).toBeNull();
    expect(await map["hostAdd.retry"]({ flowId: FLOW, from: "install" }, WINDOW)).toBeNull();
    expect(await map["hostAdd.retry"]({ flowId: FLOW }, WINDOW)).toBeNull();
    expect(await map["hostAdd.cancel"]({ flowId: FLOW }, WINDOW)).toBeNull();

    expect(remote.retry).toHaveBeenCalledWith(HOST);
    expect(remote.updateHost).toHaveBeenCalledWith(HOST, "when-idle");
    expect(remote.cancelScheduledUpdate).toHaveBeenCalledWith(HOST);
    expect(remote.signIn).toHaveBeenCalledWith(HOST, "anthropic");
    expect(remote.forget).toHaveBeenCalledWith(HOST);
    expect(remote.startAdd).toHaveBeenCalledWith({ target: "you@box", name: "Box" });
    expect(remote.answerAdd).toHaveBeenCalledWith(FLOW, "q1", { kind: "accept-host-key" });
    expect(remote.sudoPassword).toHaveBeenCalledWith(FLOW, "q1", PASSWORD);
    expect(remote.retryAdd).toHaveBeenNthCalledWith(1, FLOW, "install");
    expect(remote.retryAdd).toHaveBeenNthCalledWith(2, FLOW, undefined);
    expect(remote.cancelAdd).toHaveBeenCalledWith(FLOW);
  });

  it("feeds each subscription's sink, and answers the registry's unsubscribe", async () => {
    const { remote, unsubscribe } = port();
    const map = handlers({ remoteHosts: remote });
    const hosts = sink();
    expect(await map["hosts.subscribe"](undefined, WINDOW, hosts)).toBe(unsubscribe);
    expect(hosts.emit).toHaveBeenCalledWith(SNAPSHOT);
    const flow = sink();
    expect(await map["hostAdd.subscribe"]({ flowId: FLOW }, WINDOW, flow)).toBe(unsubscribe);
    expect(remote.subscribeAdd).toHaveBeenCalledWith(FLOW, expect.any(Function));
    expect(flow.emit).toHaveBeenCalledWith(EVENT);
  });

  // v1 refuses an update and a sign-in: the port throws the shared brand, and
  // every door says `operation-unavailable` with its text.
  it("keeps the registry's own unavailable answer, message and all", async () => {
    const { remote } = port({
      updateHost: () => {
        throw new OperationUnavailableError(REMOTE_HOST_UPDATE_UNAVAILABLE);
      },
    });
    expect(
      await unavailable(() =>
        handlers({ remoteHosts: remote })["hosts.updateHost"](
          { hostId: HOST, when: "now" },
          WINDOW,
        ),
      ),
    ).toBe(REMOTE_HOST_UPDATE_UNAVAILABLE);
  });

  // The sudo password is write-only: an error that names it never leaves the
  // map with it, whichever kind of error it was.
  it("scrubs the sudo password from any error the registry answers", async () => {
    const failing = (error: unknown) =>
      handlers({
        remoteHosts: port({
          sudoPassword: () => {
            throw error;
          },
        }).remote,
      })["hostAdd.sudoPassword"]({ flowId: FLOW, questionId: "q1", password: PASSWORD }, WINDOW);

    const plain = await Promise.resolve(failing(new Error(`sudo refused ${PASSWORD}!`))).catch(
      (error: unknown) => error,
    );
    expect(plain).toBeInstanceOf(Error);
    expect(isOperationUnavailable(plain)).toBe(false);
    expect((plain as Error).message).toBe("sudo refused [redacted]!");
    expect(JSON.stringify(plain) + String((plain as Error).stack)).not.toContain(PASSWORD);

    expect(
      await unavailable(() =>
        failing(new OperationUnavailableError(`${PASSWORD} no cloud ${PASSWORD}`)),
      ),
    ).toBe("[redacted] no cloud [redacted]");

    // An error that does not carry it, or is no Error at all, passes as thrown.
    const clean = new Error("The flow has ended.");
    await expect(failing(clean)).rejects.toBe(clean);
    await expect(failing("string failure")).rejects.toBe("string failure");
    // An empty password names nothing to scrub.
    const empty = handlers({
      remoteHosts: port({
        sudoPassword: () => {
          throw clean;
        },
      }).remote,
    });
    await expect(
      empty["hostAdd.sudoPassword"]({ flowId: FLOW, questionId: "q1", password: "" }, WINDOW),
    ).rejects.toBe(clean);
  });
});

describe("ticket.move, the whole command", () => {
  const SESSION: TicketEventActor = { kind: "session", sessionId: "s-1", ticketId: null };

  function changes(): Omit<DataChangedEvent, "entity">[] {
    return publish.mock.calls
      .filter(([topic]) => topic === "data-changed")
      .map(([, change]) => change as Omit<DataChangedEvent, "entity">);
  }

  it("moves, records the armed arrival, and publishes the change for any other caller", async () => {
    ticket("t-1");
    const moved = await handlers()["ticket.move"](
      { projectId: PROJECT, ticketId: "t-1", toStatus: "doing" },
      USER,
    );
    expect(moved.find(({ id }) => id === "t-1")?.status).toBe("doing");
    expect(getTicketRow(ctx.db, "t-1")?.updated_at).toBe(50);
    expect(noteDeliberateMove).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "t-1", from: "todo", to: "doing" }),
    );
    expect(changes()).toEqual([{ projectId: PROJECT, ticketId: "t-1", kind: "ticket" }]);
    // A person's move into Doing is silent: only a non-user arrival notifies.
    expect(deliver).not.toHaveBeenCalled();
  });

  it("echoes no board change to the desktop window, which holds it in the reply", async () => {
    ticket("t-1");
    await handlers()["ticket.move"](
      { projectId: PROJECT, ticketId: "t-1", toStatus: "doing" },
      WINDOW,
    );
    expect(changes()).toEqual([]);
    expect(noteDeliberateMove).toHaveBeenCalledTimes(1);
  });

  it("notifies a Session's arrival into Doing, and records no arrival without a live runner", async () => {
    ticket("t-1");
    await handlers({ automations: automations("idle") })["ticket.move"](
      { projectId: PROJECT, ticketId: "t-1", toStatus: "doing" },
      { actor: SESSION },
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ producer: "ticket-moved-to-doing" }),
    );
    expect(noteDeliberateMove).not.toHaveBeenCalled();
    ticket("t-2");
    await handlers({ automations: automations("degraded") })["ticket.move"](
      { projectId: PROJECT, ticketId: "t-2", toStatus: "doing" },
      USER,
    );
    expect(noteDeliberateMove).not.toHaveBeenCalled();
  });

  it("interrupts a backward move's live Sessions, and uses the host's own worktree bundle by default", async () => {
    ticket("t-1", "doing");
    const interruptTicketSessions = vi.fn(() => ["s-1"]);
    // The host's clock, and its own worktree bundle, when the root states neither.
    const map = handlers({ interruptTicketSessions, worktree: undefined, now: undefined });
    await map["ticket.move"]({ projectId: PROJECT, ticketId: "t-1", toStatus: "todo" }, USER);
    expect(interruptTicketSessions).toHaveBeenCalledWith("t-1");
  });
});

describe("the host's log (VC-699)", () => {
  it("reads a page and follows the ring a host keeps", async () => {
    const { createLogRing } = await import("../log/ring");
    const ring = createLogRing();
    const record = {
      ts: "2026-10-07T00:00:00.000Z",
      level: "info",
      component: "c",
      msg: "m",
    } as const;
    ring.write(record, JSON.stringify(record));
    const map = handlers({ logs: ring });
    const page = await map["logs.tail"]({ limit: 5 }, USER);
    expect(page.entries.map(({ record: { msg } }) => msg)).toEqual(["m"]);
    const emitted: unknown[] = [];
    const stop = await map["logs.follow"]({ after: page.cursor }, USER, {
      emit: (batch) => {
        emitted.push(batch);
      },
      fail: () => undefined,
    });
    ring.write({ ...record, msg: "next" }, "{}");
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toMatchObject([{ entries: [{ record: { msg: "next" } }], gap: false }]);
    stop();
  });
});
