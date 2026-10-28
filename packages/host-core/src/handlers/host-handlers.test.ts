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
  SESSION_READ_VERBS,
  type ActiveAddHost,
  type AddHostEvent,
  type AddHostFacts,
  type BrowserAppShortcutEvent,
  type DataChangedEvent,
  type HandlerCall,
  type ModelAccessSnapshot,
  type RemoteHostDevices,
  type RemoteHostProjects,
  type CreateRemoteProjectResult,
  type RemoteHostsSnapshot,
  type TicketEventActor,
} from "@volli/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { listProjects } from "../db/projects-repo";
import { getTicketRow, insertTicket } from "../db/tickets-repo";
import { BrowserPictureStore } from "../browser/picture-store";
import { createBoardChangeFeed } from "../board/change-feed";
import type { ProjectLiveWork } from "../project-remove";
import type { RuntimeAutomations } from "../session-runtime/automations";
import { createTicketCommand } from "../ticket-commands";
import { runGitCapturingAsync } from "../worktree/git";
import { createWorktreeReadService } from "../worktree-reads";
import { recordEnvironmentRun } from "../worktree/environment-runs";
import { ADMITTED, admittedHandlers, type HandlerPolicy } from "./handler-map";
import {
  createHostHandlers,
  SessionRuntimeUnavailableError,
  type HostHandlerCoverage,
  type HostHandlerOptions,
  type HostHandlers,
} from "./host-handlers";
import type { AccountPort } from "./account-port";
import type { RunnerAccountPort } from "./runner-account-port";
import type { CloudCheckoutPort } from "./cloud-checkout-port";
import type { BrowserShortcutsPort } from "./browser-shortcuts-port";
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
      worktreeReads: createWorktreeReadService({
        deps: () => ({ db: ctx.db, gitAsync: runGitCapturingAsync }),
      }),
      now: () => 50,
      worktree: { db: ctx.db, gitAsync: runGitCapturingAsync, blobsRoot: "" },
      ...options,
    },
  );
}

it("serves saved Session pictures in bounded chunks and names absence without changing the transcript", async () => {
  const pictures = new BrowserPictureStore({ createId: () => "picture", now: () => 0 });
  const id = pictures.put({
    tabId: "code",
    generation: 0,
    ownerSessionId: "session",
    mime: "image/png",
    bytes: Buffer.from("picture bytes"),
    persist: false,
  });
  const map = handlers({ pictures });
  expect(await map["session.picture"]({ sessionId: "session", pictureId: id }, USER)).toEqual({
    data: Buffer.from("picture bytes").toString("base64"),
    mimeType: "image/png",
    nextOffset: null,
  });
  expect(await map["session.picture"]({ sessionId: "other", pictureId: id }, USER)).toEqual({
    data: null,
    mimeType: null,
    nextOffset: null,
  });
  expect(
    await handlers()["session.picture"]({ sessionId: "session", pictureId: id }, USER),
  ).toEqual({ data: null, mimeType: null, nextOffset: null });
});

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
  // The view lists every key, the agent doors' own included: those are
  // served by the doors (VC-923) and answer unavailable here, unserved.
  it("has a handler for every key, and no other", () => {
    expectTypeOf<HostHandlerCoverage>().toEqualTypeOf<never>();
    expect(Object.keys(handlers()).toSorted()).toEqual([...HOST_HANDLER_KEYS].toSorted());
  });

  it("forwards a composition's optional entity id source to the board map", async () => {
    const newId = vi.fn(() => "composition-ticket");
    const map = handlers({ newId });
    const { ticket: createdTicket } = await map["board.createTicket"](
      {
        projectId: PROJECT,
        commandId: "composition-create",
        status: "todo",
        title: "Composition id",
        body: "",
        labels: [],
        priority: "medium",
      },
      USER,
    );
    expect(createdTicket.id).toBe("composition-ticket");
    expect(newId).toHaveBeenCalledOnce();
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
    // The Session reads answer as before until the agent command service
    // serves them (VC-894): the map is sealed without them.
    expect(
      await unavailable(() => empty["session.list"]({ workspaceId: PROJECT, args: {} }, USER)),
    ).toBe("Session reads are unavailable on this transport");
    // A host that keeps no recent log says so (VC-699).
    expect(await unavailable(() => empty["logs.tail"]({}, USER))).toBe(
      "This host keeps no log to read",
    );
    // A launch with no Session Engine lists no Sessions (VC-713).
    expect(await unavailable(() => empty["session.listing"]({ projectId: PROJECT }, USER))).toBe(
      "The Session listing is unavailable on this host",
    );
    expect(
      await unavailable(() => empty["session.listingForTicket"]({ ticketId: "t" }, USER)),
    ).toBe("The Session listing is unavailable on this host");
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
      await map["hostSignIns.answer"](
        { hostId: "h", providerId: "p", promptId: "q", value: "" },
        USER,
      ),
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

describe("the Workspace link relay (VC-711)", () => {
  const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

  it("answers unavailable without the port, a stream included", async () => {
    const empty = handlers();
    const quiet = { emit() {}, fail() {} };
    for (const call of [
      () => empty["hostLink.query"]({ workspaceId: WORKSPACE, path: "board.snapshot" }, USER),
      () => empty["hostLink.mutate"]({ workspaceId: WORKSPACE, path: "board.setPriority" }, USER),
      () =>
        empty["hostLink.subscribe"]({ workspaceId: WORKSPACE, path: "board.changes" }, USER, quiet),
    ]) {
      expect(await unavailable(call)).toBe("Remote projects are unavailable on this host");
    }
  });

  it("passes each call through the port once, a stream's events into its sink", async () => {
    const stop = vi.fn();
    const port = {
      query: vi.fn(async () => ({ answered: "query" })),
      mutate: vi.fn(async () => ({ answered: "mutate" })),
      subscribe: vi.fn(
        async (
          _workspaceId: string,
          _path: string,
          _input: unknown,
          listener: (event: unknown) => void,
          _options?: { lastEventId?: string },
        ) => {
          listener({ kind: "data", data: 1, id: "1" });
          listener({ kind: "complete" });
          return stop;
        },
      ),
    };
    const map = handlers({ hostLinkRelay: port });
    expect(
      await map["hostLink.query"](
        { workspaceId: WORKSPACE, path: "board.snapshot", input: { projectId: "p" } },
        USER,
      ),
    ).toEqual({ answered: "query" });
    expect(
      await map["hostLink.mutate"]({ workspaceId: WORKSPACE, path: "board.setPriority" }, USER),
    ).toEqual({ answered: "mutate" });
    const emitted: unknown[] = [];
    const into = { emit: (event: unknown) => void emitted.push(event), fail() {} };
    expect(
      await map["hostLink.subscribe"](
        { workspaceId: WORKSPACE, path: "board.changes", input: {}, lastEventId: "9" },
        USER,
        into,
      ),
    ).toBe(stop);
    await map["hostLink.subscribe"]({ workspaceId: WORKSPACE, path: "logs.follow" }, USER, into);
    expect(emitted).toEqual([
      { kind: "data", data: 1, id: "1" },
      { kind: "complete" },
      { kind: "data", data: 1, id: "1" },
      { kind: "complete" },
    ]);
    expect(port.query).toHaveBeenCalledWith(WORKSPACE, "board.snapshot", { projectId: "p" });
    expect(port.mutate).toHaveBeenCalledWith(WORKSPACE, "board.setPriority", undefined);
    expect(port.subscribe.mock.calls.map((call) => [call[1], call[2], call[4]])).toEqual([
      ["board.changes", {}, { lastEventId: "9" }],
      ["logs.follow", undefined, {}],
    ]);
  });
});

describe("the HOST relay (VC-722)", () => {
  const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

  it("answers unavailable without the port, a stream included", async () => {
    for (const hostScopeRelay of [undefined, null]) {
      const empty = handlers({ hostScopeRelay });
      const quiet = { emit() {}, fail() {} };
      for (const call of [
        () => empty["hostScope.query"]({ hostId: HOST, path: "workspaces.list" }, USER),
        () => empty["hostScope.mutate"]({ hostId: HOST, path: "workspaces.create" }, USER),
        () => empty["hostScope.subscribe"]({ hostId: HOST, path: "logs.follow" }, USER, quiet),
      ]) {
        expect(await unavailable(call)).toBe("Remote host operations are unavailable on this host");
      }
    }
  });

  it("passes each call through the port once, a stream's events into its sink", async () => {
    const stop = vi.fn();
    const port = {
      query: vi.fn(async () => ({ answered: "query" })),
      mutate: vi.fn(async () => ({ answered: "mutate" })),
      subscribe: vi.fn(
        async (
          _hostId: string,
          _path: string,
          _input: unknown,
          _lastEventId: string | undefined,
          listener: (event: unknown) => void | Promise<void>,
        ) => {
          listener({ kind: "data", data: 1, id: "1" });
          listener({ kind: "complete" });
          return stop;
        },
      ),
    };
    const map = handlers({ hostScopeRelay: port });
    expect(
      await map["hostScope.query"](
        { hostId: HOST, path: "workspaces.list", input: { projectId: "p" } },
        USER,
      ),
    ).toEqual({ answered: "query" });
    expect(
      await map["hostScope.mutate"]({ hostId: HOST, path: "workspaces.create" }, USER),
    ).toEqual({ answered: "mutate" });
    const emitted: unknown[] = [];
    const into = { emit: (event: unknown) => void emitted.push(event), fail() {} };
    expect(
      await map["hostScope.subscribe"](
        { hostId: HOST, path: "logs.follow", input: {}, lastEventId: "9" },
        USER,
        into,
      ),
    ).toBe(stop);
    await map["hostScope.subscribe"]({ hostId: HOST, path: "logs.follow" }, USER, into);
    expect(emitted).toEqual([
      { kind: "data", data: 1, id: "1" },
      { kind: "complete" },
      { kind: "data", data: 1, id: "1" },
      { kind: "complete" },
    ]);
    expect(port.query).toHaveBeenCalledOnce();
    expect(port.mutate).toHaveBeenCalledOnce();
    expect(port.query).toHaveBeenCalledWith(HOST, "workspaces.list", { projectId: "p" });
    expect(port.mutate).toHaveBeenCalledWith(HOST, "workspaces.create", undefined);
    expect(port.subscribe.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ["logs.follow", {}, "9"],
      ["logs.follow", undefined, undefined],
    ]);
  });

  it("accepts a synchronous stop and preserves sink backpressure", async () => {
    const stop = vi.fn();
    const pending = Promise.withResolvers<void>();
    const emit = vi.fn(() => pending.promise);
    let delivery: void | Promise<void>;
    const map = handlers({
      hostScopeRelay: {
        query: async () => null,
        mutate: async () => null,
        subscribe: (_hostId, _path, _input, _lastEventId, listener) => {
          delivery = listener({ kind: "started" });
          return stop;
        },
      },
    });
    expect(
      await map["hostScope.subscribe"]({ hostId: HOST, path: "logs.follow" }, USER, {
        emit,
        fail() {},
      }),
    ).toBe(stop);
    expect(delivery!).toBe(pending.promise);
    pending.resolve();
    await delivery!;
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

  // The reads' ports are the agent command service's, which serves them
  // (VC-894, `agent-dispatch/verbs.ts`): the map is sealed without them, and
  // a router reaching one before the service exists hears the unavailable
  // words the sealed entry always answered, unchanged on the wire.
  it("leaves the Session reads for the agent command service to serve (VC-894)", async () => {
    const map = handlers();
    for (const verb of SESSION_READ_VERBS) {
      expect(await unavailable(() => map[verb]({ workspaceId: PROJECT, args: {} }, USER))).toBe(
        "Session reads are unavailable on this transport",
      );
    }
  });

  // The one start both agent doors reach (VC-923): the facade, the kickoff,
  // the title and the start notice are the map's, and the actor is the call's.
  describe("session.start", () => {
    const READY = {
      sessionId: "abcdef12-started",
      state: "ready" as const,
      receipt: null,
      throughSequence: 2,
      model: { providerId: "test", modelId: "m", reasoningLevel: "off" as const },
    };

    function ticketed() {
      insertTicket(ctx.db, testTicket(PROJECT, { id: "ticket-one", ticketNumber: 1 }));
    }

    it("starts the Session, sends its kickoff and announces it, as the call's actor", async () => {
      ticketed();
      const start = vi.fn(async () => READY);
      const submitSessionMessage = vi.fn(async () => {});
      const refineAutoTitle = vi.fn();
      const map = handlers({
        sessions: { create: vi.fn(), attach: vi.fn(), start },
        submitSessionMessage,
        refineAutoTitle,
      });
      const caller = {
        actor: { kind: "session", sessionId: "caller", ticketId: "ticket-one" },
      } as const;
      const started = await map["session.start"](
        { operationId: "op", projectId: PROJECT, ticketId: "ticket-one", message: "Fix it" },
        caller,
      );
      expect(started).toMatchObject({
        sessionId: READY.sessionId,
        ticketDisplayId: "VC-1",
        state: "ready",
        title: "Fix it",
      });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: "op",
          projectId: PROJECT,
          ticketId: "ticket-one",
          role: "ticket",
          actor: caller.actor,
        }),
      );
      expect(submitSessionMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: READY.sessionId, text: "Fix it" }),
      );
      expect(refineAutoTitle).toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith("data-changed", {
        ticketId: "ticket-one",
        projectId: PROJECT,
        kind: "session",
      });
      expect(publish).toHaveBeenCalledWith(
        "session-started",
        expect.objectContaining({ sessionId: READY.sessionId, actorTicket: "VC-1" }),
      );
      // Once each: the map's start is the only one that announces.
      expect(publish.mock.calls.map(([topic]) => topic)).toEqual([
        "data-changed",
        "session-started",
      ]);
    });

    it("answers unavailable with no Sessions facade, and refuses a ticket outside its project", async () => {
      ticketed();
      insertProject(ctx.db, testProject({ id: "elsewhere", ticketPrefix: "EL" }));
      const input = { operationId: "op", projectId: PROJECT, ticketId: "ticket-one" };
      const error = await Promise.resolve()
        .then(() => handlers()["session.start"](input, USER))
        .catch((thrown: unknown) => thrown);
      expect(isOperationUnavailable(error)).toBe(true);
      // The start's own unavailable, which each agent door words in its own vocabulary.
      expect(error).toBeInstanceOf(SessionRuntimeUnavailableError);
      const start = vi.fn(async () => READY);
      const map = handlers({ sessions: { create: vi.fn(), attach: vi.fn(), start } });
      for (const wrong of [
        { ...input, ticketId: "no-such-ticket" },
        { ...input, projectId: "no-such-project" },
        { ...input, projectId: "elsewhere" },
      ]) {
        await expect(
          Promise.resolve().then(() => map["session.start"](wrong, USER)),
        ).rejects.toThrow(`No ticket ${wrong.ticketId} in project ${wrong.projectId}.`);
      }
      expect(start).not.toHaveBeenCalled();
    });
  });

  it("states the Role a person's choice of ticket implies", async () => {
    const create = vi.fn(async (_input: { role: string }) => ({
      sessionId: "s",
      model: {} as never,
    }));
    const map = handlers({ sessions: { create, attach: vi.fn(), start: vi.fn() } });
    const input = { operationId: "op", projectId: PROJECT, title: null };
    await map["sessions.create"]({ ...input, ticketId: "t" }, USER);
    await map["sessions.create"]({ ...input, ticketId: null }, USER);
    expect(create.mock.calls.map(([call]) => call.role)).toEqual(["ticket", "project"]);
  });

  it("resumes an Automation's delivery after a ready attach, and only then", async () => {
    const attach = vi.fn(async () => ({ state: "ready" }) as never);
    const ready = handlers({ sessions: { create: vi.fn(), attach, start: vi.fn() } });
    await ready["sessions.attach"]({ operationId: "op", sessionId: "s" }, USER);
    expect(resumeDeliveryForSession).toHaveBeenCalledExactlyOnceWith("s");

    resumeDeliveryForSession.mockClear();
    for (const kind of ["idle", "degraded"] as const) {
      await handlers({
        sessions: { create: vi.fn(), attach, start: vi.fn() },
        automations: automations(kind),
      })["sessions.attach"]({ operationId: "op", sessionId: "s" }, USER);
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

  // VC-796: the order itself is `../project-remove`'s; here, that the map
  // runs it against this host's feed and bus, and refuses without live work.
  it("removes a project after its live work stops, ends its feed and tells every window", async () => {
    insertProject(ctx.db, testProject({ id: "second", ticketPrefix: "SE" }));
    const boardFeed = createBoardChangeFeed();
    boardFeed.cursor(PROJECT);
    const stopped: string[] = [];
    const projectLiveWork: ProjectLiveWork = {
      releaseBindings: async () => {
        stopped.push("bindings");
        return { stillOpen: [] };
      },
      disposeShells: () => stopped.push("shells"),
      killTerminals: () => stopped.push("terminals"),
      closeBrowserTabs: () => stopped.push("tabs"),
      mcp: null,
    };

    expect(
      await handlers({ boardFeed, projectLiveWork })["project.remove"](
        { projectId: PROJECT },
        WINDOW,
      ),
    ).toBeNull();

    expect(stopped).toEqual(["bindings", "shells", "terminals", "tabs"]);
    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual(["second"]);
    // Detached at the host's clock, not deleted (VC-822).
    expect(ctx.db.prepare("SELECT removed_at FROM projects WHERE id = ?").get(PROJECT)).toEqual({
      removed_at: 50,
    });
    expect(boardFeed.size).toBe(0);
    expect(publish.mock.calls).toEqual([["data-changed", {}]]);
  });

  it("refuses to remove a project on a host that cannot stop its live work", async () => {
    expect(
      await unavailable(() => handlers()["project.remove"]({ projectId: PROJECT }, WINDOW)),
    ).toBe("Removing a project is unavailable on this host");
    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual([PROJECT]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reads the host's trim settings, defaults included", async () => {
    expect(await handlers()["worktree.trimSettings"](undefined, WINDOW)).toMatchObject({
      trimOnFinish: expect.any(Boolean),
      keepPatterns: expect.any(Array),
    });
  });

  // VC-584: the setup gate's state and a person's answers, served off the
  // ticket's working copy on this runner.
  describe("environment setup", () => {
    let home: string;
    const worktreePath = "/wt/VC-7";
    const map = (recipes = true) =>
      handlers({
        worktree: { db: ctx.db, gitAsync: runGitCapturingAsync, blobsRoot: "", home },
        environmentRecipes: () => recipes,
      });
    const fail = () =>
      recordEnvironmentRun(
        { home },
        worktreePath,
        {
          script: "setup",
          source: "repo",
          scriptSha: "sha",
          reason: "new-working-copy",
          runnerKind: "mac",
          ticketId: "wt-ticket",
          startedAt: 1,
        },
        { endedAt: 2, outcome: "failed", exitCode: 1, summary: "it broke.", tail: "out" },
      );

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "volli-handlers-setup-"));
      insertTicket(
        ctx.db,
        testTicket(PROJECT, { id: "wt-ticket", usesWorktree: true, worktreePath }),
      );
      insertTicket(
        ctx.db,
        testTicket(PROJECT, { id: "plain-ticket", ticketNumber: 99, usesWorktree: false }),
      );
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("has no gate to show or answer while recipes are off", async () => {
      fail();
      expect(await map(false)["worktree.setupStatus"]({ ticketId: "wt-ticket" }, WINDOW)).toEqual({
        kind: "none",
      });
      expect(
        await unavailable(() =>
          map(false)["worktree.answerSetup"]({ ticketId: "wt-ticket", answer: "retry" }, WINDOW),
        ),
      ).toBe("Environment setup is off on this host");
      expect(await handlers()["worktree.setupStatus"]({ ticketId: "wt-ticket" }, WINDOW)).toEqual({
        kind: "none",
      });
    });

    it("answers none for a ticket with no working copy, and refuses an unknown one", async () => {
      expect(await map()["worktree.setupStatus"]({ ticketId: "plain-ticket" }, WINDOW)).toEqual({
        kind: "none",
      });
      expect(
        await map()["worktree.answerSetup"]({ ticketId: "plain-ticket", answer: "retry" }, WINDOW),
      ).toEqual({ kind: "none" });
      await expect(
        Promise.resolve().then(() => map()["worktree.setupStatus"]({ ticketId: "nope" }, WINDOW)),
      ).rejects.toThrow("Unknown ticket");
    });

    it("reads a failed setup without its runner-side ids, then answers it", async () => {
      expect(await map()["worktree.setupStatus"]({ ticketId: "wt-ticket" }, WINDOW)).toEqual({
        kind: "none",
      });
      fail();
      const run = { source: "repo", summary: "it broke.", exitCode: 1, endedAt: 2, tail: "out" };
      expect(await map()["worktree.setupStatus"]({ ticketId: "wt-ticket" }, WINDOW)).toEqual({
        kind: "failed",
        run,
      });

      expect(
        await map()["worktree.answerSetup"](
          { ticketId: "wt-ticket", answer: "start-anyway" },
          WINDOW,
        ),
      ).toEqual({ kind: "started-anyway", run });
      expect(
        await map()["worktree.answerSetup"]({ ticketId: "wt-ticket", answer: "retry" }, WINDOW),
      ).toEqual({ kind: "pending" });
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
  const DEVICES: RemoteHostDevices = {
    hostId: HOST,
    devices: [
      {
        deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
        name: "Alice's Mac",
        fingerprint: "SHA256:mac",
        enrolledAt: "2026-10-06T00:00:00.000Z",
        via: "ssh",
        revokedAt: null,
        thisMac: true,
      },
    ],
  };

  const FACTS: AddHostFacts = {
    user: "you",
    os: "linux",
    system: "Ubuntu 24.04.1 LTS",
    arch: "x86-64",
    memoryBytes: null,
    version: null,
    keepsRunning: null,
    alreadyPaired: false,
  };

  /** The add flows main still owns (VC-720): exactly what `hostAdd.active` answers. */
  const ACTIVE: readonly ActiveAddHost[] = [
    { flowId: FLOW, target: "you@box", name: "you@box", status: "question" },
  ];

  const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const PROJECTS: RemoteHostProjects = {
    hostId: HOST,
    projects: [{ id: WORKSPACE, name: "Acme", prefix: "AC", path: "/srv/volli/acme", tickets: 0 }],
    adds: { kind: "ready" },
  };
  const CREATED: CreateRemoteProjectResult = {
    ok: true,
    created: true,
    project: PROJECTS.projects[0]!,
  };

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
      rename: vi.fn(),
      devices: vi.fn(async () => DEVICES),
      addFacts: vi.fn(() => FACTS),
      activeAdds: vi.fn(() => ACTIVE),
      projects: vi.fn(async () => PROJECTS),
      createProject: vi.fn(async () => CREATED),
      openWorkspace: vi.fn(),
      closeWorkspace: vi.fn(),
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
        () => map["hosts.rename"]({ hostId: HOST, name: "Box" }, WINDOW),
        () => map["hosts.devices"]({ hostId: HOST }, WINDOW),
        () => map["hostAdd.facts"]({ flowId: FLOW }, WINDOW),
        () => map["hostAdd.active"](undefined, WINDOW),
        () => map["hosts.projects"]({ hostId: HOST }, WINDOW),
        () => map["hosts.createProject"]({ hostId: HOST, path: "/a" }, WINDOW),
        () => map["hosts.openWorkspace"]({ hostId: HOST, workspaceId: WORKSPACE }, WINDOW),
        () => map["hosts.closeWorkspace"]({ hostId: HOST, workspaceId: WORKSPACE }, WINDOW),
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
    expect(await map["hosts.rename"]({ hostId: HOST, name: "Build box" }, WINDOW)).toBeNull();
    expect(await map["hosts.devices"]({ hostId: HOST }, WINDOW)).toBe(DEVICES);
    expect(await map["hostAdd.facts"]({ flowId: FLOW }, WINDOW)).toBe(FACTS);
    expect(await map["hostAdd.active"](undefined, WINDOW)).toBe(ACTIVE);
    expect(await map["hosts.projects"]({ hostId: HOST }, WINDOW)).toBe(PROJECTS);
    const create = { hostId: HOST, gitUrl: "https://github.com/me/acme", name: "Acme" };
    expect(await map["hosts.createProject"](create, WINDOW)).toBe(CREATED);
    const workspace = { hostId: HOST, workspaceId: WORKSPACE };
    expect(await map["hosts.openWorkspace"](workspace, WINDOW)).toBeNull();
    expect(await map["hosts.closeWorkspace"](workspace, WINDOW)).toBeNull();

    expect(remote.projects).toHaveBeenCalledWith(HOST);
    expect(remote.createProject).toHaveBeenCalledWith(create);
    expect(remote.openWorkspace).toHaveBeenCalledWith(HOST, WORKSPACE);
    expect(remote.closeWorkspace).toHaveBeenCalledWith(HOST, WORKSPACE);
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
    expect(remote.rename).toHaveBeenCalledWith(HOST, "Build box");
    expect(remote.devices).toHaveBeenCalledWith(HOST);
    expect(remote.addFacts).toHaveBeenCalledWith(FLOW);
    expect(remote.activeAdds).toHaveBeenCalledWith();
  });

  it("never lets a create's sudo password out in an error (VC-710)", async () => {
    const secret = "hunter2-create-secret";
    const { remote } = port({
      createProject: vi.fn(async () => {
        throw new Error(`sudo said ${secret}`);
      }),
    });
    const map = handlers({ remoteHosts: remote });
    const input = { hostId: HOST, gitUrl: "https://github.com/me/acme", sudoPassword: secret };
    await expect(map["hosts.createProject"](input, WINDOW)).rejects.toThrow("sudo said [redacted]");
    const plain = port({
      createProject: vi.fn(async () => {
        throw new Error("no such host");
      }),
    });
    await expect(
      handlers({ remoteHosts: plain.remote })["hosts.createProject"](
        { hostId: HOST, path: "/a" },
        WINDOW,
      ),
    ).rejects.toThrow("no such host");
  });

  // The registry's own refusals (an unknown host, a bad label, a host it could
  // not reach) travel as it threw them, exactly as `hosts.forget`'s do.
  it("passes a rename's or a device list's failure on as the registry threw it", async () => {
    const refusal = Object.assign(new Error("box didn't list its devices."), {
      code: "devices-unavailable",
    });
    const map = handlers({
      remoteHosts: port({
        rename: () => {
          throw refusal;
        },
        devices: async () => {
          throw refusal;
        },
      }).remote,
    });
    await expect(map["hosts.rename"]({ hostId: HOST, name: "Box" }, WINDOW)).rejects.toBe(refusal);
    await expect(map["hosts.devices"]({ hostId: HOST }, WINDOW)).rejects.toBe(refusal);
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

describe("the Session listing (VC-713)", () => {
  it("answers a project's and a ticket's rows from the sources it was given, bounded", async () => {
    ticket("t1");
    const listSessions = vi.fn(async () => []);
    const map = handlers({
      sessionListing: { db: ctx.db, listSessions, liveAttachmentIds: () => new Set() },
    });
    expect(await map["session.listing"]({ projectId: PROJECT }, USER)).toEqual({
      sessions: [],
      omitted: 0,
    });
    expect(listSessions).toHaveBeenLastCalledWith({ projectId: PROJECT, scope: "all" });
    expect(await map["session.listingForTicket"]({ ticketId: "t1" }, USER)).toEqual({
      sessions: [],
      omitted: 0,
    });
    expect(listSessions).toHaveBeenLastCalledWith({
      projectId: PROJECT,
      scope: "ticket",
      ticketId: "t1",
    });
  });
});

describe("host-scope projects at the one handler map", () => {
  const command = {
    commandId: "a0000000-0000-4000-8000-000000000001",
    source: { path: "/work/project" },
  };
  it("answers unavailable where the host does not compose project management", async () => {
    const map = handlers();
    expect(await unavailable(() => map["workspaces.list"](undefined, USER))).toBe(
      "Project management is not available on this host",
    );
    expect(await unavailable(() => map["workspaces.create"](command, USER))).toBe(
      "Project management is not available on this host",
    );
  });
  it("projects exactly to the host-owned service", async () => {
    const row = {
      id: command.commandId,
      name: "Project",
      path: "/work/project",
      gitRemoteUrl: null,
    };
    const result = { ok: true as const, workspace: row };
    const workspaces = {
      list: vi.fn(() => ({ workspaces: [row], omitted: 0 })),
      create: vi.fn(async () => result),
    };
    const map = handlers({ workspaces });
    expect(await map["workspaces.list"](undefined, USER)).toEqual({
      workspaces: [row],
      omitted: 0,
    });
    expect(await map["workspaces.create"](command, USER)).toBe(result);
    expect(workspaces.list).toHaveBeenCalledWith();
    expect(workspaces.create).toHaveBeenCalledWith(command);
  });
});

describe("moving a foreground command", () => {
  const input = { sessionId: "session-1", toolCallId: "bash-1" };
  it("names both ids to the owning host and returns its shell id", async () => {
    const moveForeground = vi.fn(() => ({ shellId: "shell-1" }));
    expect(
      await handlers({ backgroundShells: { moveForeground } })["shells.moveToBackground"](
        input,
        WINDOW,
      ),
    ).toEqual({ shellId: "shell-1" });
    expect(moveForeground).toHaveBeenCalledWith(input.sessionId, input.toolCallId);
  });
  it("refuses an absent or null port and preserves the host's refusal", async () => {
    for (const backgroundShells of [undefined, null]) {
      expect(
        await unavailable(() =>
          handlers(backgroundShells === undefined ? {} : { backgroundShells })[
            "shells.moveToBackground"
          ](input, WINDOW),
        ),
      ).toBe("Moving commands to the background is unavailable on this host");
    }
    const failure = new Error("This command already exited");
    expect(() =>
      handlers({
        backgroundShells: {
          moveForeground() {
            throw failure;
          },
        },
      })["shells.moveToBackground"](input, WINDOW),
    ).toThrow(failure);
  });
});

// Browser page shortcuts (VC-301): desktop main's Browser Tab host, through
// its port; absent everywhere else.
describe("Browser page shortcuts", () => {
  const EVENT: BrowserAppShortcutEvent = { tabId: "opaque-1", shortcut: { kind: "close-tab" } };

  it("answers unavailable for both keys on a host with no Browser Tabs (hostd)", async () => {
    for (const map of [handlers(), handlers({ browserShortcuts: null })]) {
      const calls: (() => unknown)[] = [
        () => map["browserShortcuts.subscribe"](undefined, WINDOW, sink()),
        () => map["browserShortcuts.focusPage"]({ tabId: "opaque-1" }, WINDOW),
      ];
      for (const call of calls) {
        expect(await unavailable(call)).toBe("Browser Tab shortcuts are unavailable on this host");
      }
    }
  });

  it("feeds the window every shortcut a page hands back, and answers the port's unsubscribe", async () => {
    const unsubscribe = vi.fn();
    const port = {
      subscribe: vi.fn((listener: (event: BrowserAppShortcutEvent) => void) => {
        listener(EVENT);
        return unsubscribe;
      }),
      focusPage: vi.fn(),
    } satisfies BrowserShortcutsPort;
    const map = handlers({ browserShortcuts: port });
    const shortcuts = sink();

    expect(await map["browserShortcuts.subscribe"](undefined, WINDOW, shortcuts)).toBe(unsubscribe);
    expect(shortcuts.emit).toHaveBeenCalledWith(EVENT);

    expect(await map["browserShortcuts.focusPage"]({ tabId: "opaque-1" }, WINDOW)).toBeNull();
    expect(port.focusPage).toHaveBeenCalledWith("opaque-1");
  });
});

// The Volli Cloud account (VC-884): desktop main's account service, through
// its port; absent everywhere else.
describe("the Volli Cloud account", () => {
  const SNAPSHOT = {
    state: "signed-out",
    provider: "dev",
    signingInWith: null,
    account: null,
    failure: null,
  } as const;

  const everyCall = (map: ReturnType<typeof handlers>): (() => unknown)[] => [
    () => map["account.snapshot"](undefined, WINDOW),
    () => map["account.subscribe"](undefined, WINDOW, sink()),
    () => map["account.signIn"]({ connection: "github" }, WINDOW),
    () => map["account.cancelSignIn"](undefined, WINDOW),
    () => map["account.signOut"](undefined, WINDOW),
    () => map["account.requestDeletion"](undefined, WINDOW),
    () => map["account.cancelDeletion"](undefined, WINDOW),
    () => map["account.accessToken"]({ force: false }, WINDOW),
    () => map["cloud.launch"](undefined, WINDOW),
    () => map["cloud.relaunch"](undefined, WINDOW),
    () => map["cloud.reportUnsavedWrites"]({ count: 1 }, WINDOW),
    () => map["cloud.saveSnapshot"]({ text: "{}" }, WINDOW),
    () => map["cloud.readSnapshot"](undefined, WINDOW),
    () => map["account.githubSubscribe"](undefined, WINDOW, sink()),
    () => map["account.githubConnect"](undefined, WINDOW),
    () => map["account.githubInstall"](undefined, WINDOW),
    () => map["account.githubCancel"](undefined, WINDOW),
    () => map["account.githubDisconnect"](undefined, WINDOW),
  ];

  it("answers unavailable for every key on a host with no account service (hostd)", async () => {
    for (const map of [handlers(), handlers({ account: null })]) {
      for (const call of everyCall(map)) {
        expect(await unavailable(call)).toBe("Accounts are unavailable on this host");
      }
    }
  });

  it("forwards each command to the port and feeds the window every snapshot", async () => {
    const unsubscribe = vi.fn();
    const port = {
      snapshot: vi.fn(() => SNAPSHOT),
      subscribe: vi.fn((listener: (snapshot: typeof SNAPSHOT) => void) => {
        listener(SNAPSHOT);
        return unsubscribe;
      }),
      signIn: vi.fn(),
      cancelSignIn: vi.fn(),
      signOut: vi.fn(),
      requestDeletion: vi.fn(async () => {}),
      cancelDeletion: vi.fn(),
      accessToken: vi.fn(async () => ({ kind: "token" as const, token: "jwt", expiresAt: 9 })),
      launch: vi.fn(() => ({ store: "local" as const })),
      relaunch: vi.fn(),
      reportUnsavedWrites: vi.fn(),
      saveSnapshot: vi.fn(),
      readSnapshot: vi.fn(() => "{}"),
      github: {
        subscribe: vi.fn(() => () => {}),
        connect: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
        disconnect: vi.fn(),
      },
    } satisfies AccountPort;
    const map = handlers({ account: port });
    const snapshots = sink();

    expect(await map["account.snapshot"](undefined, WINDOW)).toEqual(SNAPSHOT);
    expect(await map["account.subscribe"](undefined, WINDOW, snapshots)).toBe(unsubscribe);
    expect(snapshots.emit).toHaveBeenCalledWith(SNAPSHOT);
    expect(await map["account.signIn"]({ connection: "google" }, WINDOW)).toBeNull();
    expect(port.signIn).toHaveBeenCalledWith("google");
    await map["account.signIn"](
      { connection: "github", inviteCode: "preview-code-123456" },
      WINDOW,
    );
    expect(port.signIn).toHaveBeenCalledWith("github", "preview-code-123456");
    await map["account.signIn"](
      { connection: "github", acceptedAgreementVersion: "current-version" },
      WINDOW,
    );
    expect(port.signIn).toHaveBeenCalledWith("github", undefined, "current-version");
    for (const key of [
      "account.cancelSignIn",
      "account.signOut",
      "account.requestDeletion",
      "account.cancelDeletion",
    ] as const) {
      expect(await map[key](undefined, WINDOW)).toBeNull();
    }
    for (const method of [
      "cancelSignIn",
      "signOut",
      "requestDeletion",
      "cancelDeletion",
    ] as const) {
      expect(port[method]).toHaveBeenCalledOnce();
    }
    expect(await map["account.accessToken"]({ force: true }, WINDOW)).toEqual({
      kind: "token",
      token: "jwt",
      expiresAt: 9,
    });
    expect(port.accessToken).toHaveBeenCalledWith(true);
    expect(await map["cloud.launch"](undefined, WINDOW)).toEqual({ store: "local" });
    expect(await map["cloud.relaunch"](undefined, WINDOW)).toBeNull();
    expect(port.relaunch).toHaveBeenCalledOnce();
    expect(await map["cloud.reportUnsavedWrites"]({ count: 2 }, WINDOW)).toBeNull();
    expect(port.reportUnsavedWrites).toHaveBeenCalledWith(2);
    expect(await map["cloud.saveSnapshot"]({ text: '{"v":1}' }, WINDOW)).toBeNull();
    expect(port.saveSnapshot).toHaveBeenCalledWith('{"v":1}');
    expect(await map["cloud.readSnapshot"](undefined, WINDOW)).toEqual({ text: "{}" });
  });

  it("forwards the GitHub half to the port's own and feeds the window its snapshots", async () => {
    const GITHUB = {
      state: "ready",
      connection: { status: "active", login: "dana", name: null },
      installations: [],
      waiting: null,
      requested: false,
      failure: null,
    } as const;
    const unsubscribe = vi.fn();
    const github = {
      subscribe: vi.fn((listener: (snapshot: typeof GITHUB) => void) => {
        listener(GITHUB);
        return unsubscribe;
      }),
      connect: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
      cancel: vi.fn(),
      disconnect: vi.fn(async () => {}),
    };
    const port = {
      snapshot: vi.fn(() => SNAPSHOT),
      subscribe: vi.fn(() => () => {}),
      signIn: vi.fn(),
      cancelSignIn: vi.fn(),
      signOut: vi.fn(),
      requestDeletion: vi.fn(),
      cancelDeletion: vi.fn(),
      accessToken: vi.fn(async () => ({ kind: "signed-out" as const })),
      launch: vi.fn(() => ({ store: "local" as const })),
      relaunch: vi.fn(),
      reportUnsavedWrites: vi.fn(),
      saveSnapshot: vi.fn(),
      readSnapshot: vi.fn(() => null),
      github,
    } satisfies AccountPort;
    const map = handlers({ account: port });
    const snapshots = sink();

    expect(await map["account.githubSubscribe"](undefined, WINDOW, snapshots)).toBe(unsubscribe);
    expect(snapshots.emit).toHaveBeenCalledWith(GITHUB);
    for (const key of [
      "account.githubConnect",
      "account.githubInstall",
      "account.githubCancel",
      "account.githubDisconnect",
    ] as const) {
      expect(await map[key](undefined, WINDOW)).toBeNull();
    }
    for (const method of ["connect", "install", "cancel", "disconnect"] as const) {
      expect(github[method]).toHaveBeenCalledOnce();
    }
  });
});

// This Mac as a runner (VC-895): desktop main's Mac runner, through its port;
// absent everywhere else.
describe("this Mac as a runner", () => {
  const SNAPSHOT = {
    state: "online",
    runnerId: "runner-1",
    runnerName: "Dana's MacBook",
    since: 1_700_000_000_000,
    waitingFacts: 0,
    problem: null,
    message: null,
  } as const;

  const everyCall = (map: ReturnType<typeof handlers>): (() => unknown)[] => [
    () => map["runners.thisMac"](undefined, WINDOW),
    () => map["runners.subscribeThisMac"](undefined, WINDOW, sink()),
    () => map["runners.addThisMac"](undefined, WINDOW),
    () => map["runners.removeThisMac"](undefined, WINDOW),
  ];

  it("answers unavailable for every key on a host with no Mac runner (hostd)", async () => {
    for (const map of [handlers(), handlers({ runners: null })]) {
      for (const call of everyCall(map)) {
        expect(await unavailable(call)).toBe("Runners are unavailable on this host");
      }
    }
  });

  it("forwards each command to the port and feeds the window every snapshot", async () => {
    const unsubscribe = vi.fn();
    const port = {
      thisMac: vi.fn(() => SNAPSHOT),
      subscribeThisMac: vi.fn((listener: (snapshot: typeof SNAPSHOT) => void) => {
        listener(SNAPSHOT);
        return unsubscribe;
      }),
      addThisMac: vi.fn(async () => {}),
      removeThisMac: vi.fn(),
    } satisfies RunnerAccountPort;
    const map = handlers({ runners: port });
    const snapshots = sink();

    expect(await map["runners.thisMac"](undefined, WINDOW)).toEqual(SNAPSHOT);
    expect(await map["runners.subscribeThisMac"](undefined, WINDOW, snapshots)).toBe(unsubscribe);
    expect(snapshots.emit).toHaveBeenCalledWith(SNAPSHOT);
    expect(await map["runners.addThisMac"](undefined, WINDOW)).toBeNull();
    expect(port.addThisMac).toHaveBeenCalledOnce();
    expect(await map["runners.removeThisMac"](undefined, WINDOW)).toBeNull();
    expect(port.removeThisMac).toHaveBeenCalledOnce();
  });
});

// A cloud project's folder on this Mac (VC-895 N2-3): desktop main, through
// its port; absent everywhere else.
describe("a cloud project's folder on this Mac", () => {
  const CLOUD_PROJECT = "11111111-1111-4111-8111-111111111111";

  it("answers unavailable for every key on a host with no project folders (hostd)", async () => {
    for (const map of [handlers(), handlers({ checkouts: null })]) {
      for (const call of [
        () => map["checkouts.status"]({ projectId: CLOUD_PROJECT }, WINDOW),
        () => map["checkouts.chooseFolder"]({ projectId: CLOUD_PROJECT }, WINDOW),
      ]) {
        expect(await unavailable(call)).toBe("Project folders are unavailable on this host");
      }
    }
  });

  it("forwards the project to the port and answers its path-free result", async () => {
    const port = {
      status: vi.fn(() => ({ state: "missing" as const })),
      chooseFolder: vi.fn(async () => ({
        outcome: "chosen" as const,
        projectRepoId: CLOUD_PROJECT,
      })),
    } satisfies CloudCheckoutPort;
    const map = handlers({ checkouts: port });

    expect(await map["checkouts.status"]({ projectId: CLOUD_PROJECT }, WINDOW)).toEqual({
      state: "missing",
    });
    expect(port.status).toHaveBeenCalledWith(CLOUD_PROJECT);
    expect(await map["checkouts.chooseFolder"]({ projectId: CLOUD_PROJECT }, WINDOW)).toEqual({
      outcome: "chosen",
      projectRepoId: CLOUD_PROJECT,
    });
    expect(port.chooseFolder).toHaveBeenCalledWith(CLOUD_PROJECT);
  });
});

describe("local profile backup commands", () => {
  it("reports unavailable without a composed service", async () => {
    const map = handlers();
    for (const call of [
      () => map["backups.status"](undefined, WINDOW),
      () => map["backups.run"]({ expectedRevision: "history-revision" }, WINDOW),
      () => map["backups.reveal"](undefined, WINDOW),
    ])
      expect(await unavailable(call)).toBe("Local backups are unavailable.");
  });
  it("delegates reads, coalesced backup intent and Finder to the machine service", async () => {
    const status = { revision: "history-revision", running: false, lastBackup: null, notice: null };
    const backups = {
      status: vi.fn(async () => status),
      run: vi.fn(async () => status),
      reveal: vi.fn(async () => {}),
    };
    const map = handlers({ backups });
    expect(await map["backups.status"](undefined, WINDOW)).toEqual(status);
    expect(await map["backups.run"]({ expectedRevision: "history-revision" }, WINDOW)).toEqual(
      status,
    );
    expect(await map["backups.reveal"](undefined, WINDOW)).toBeNull();
    expect(backups.status).toHaveBeenCalledOnce();
    expect(backups.run).toHaveBeenCalledWith("history-revision");
    expect(backups.reveal).toHaveBeenCalledOnce();
  });
});
