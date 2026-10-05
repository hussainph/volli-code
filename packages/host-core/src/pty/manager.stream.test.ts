import { createTestSessionEngine } from "../testing/session-engine";
/**
 * The terminal stream contract's edges (VC-560), against a node-pty double:
 * who may attach, what a refused attach leaves untouched, and what a detach
 * releases. The real-shell half of the contract is `manager.pty.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionExecutionVenue, TerminalDataEvent } from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import type { HostClientEventSink, HostEventMap, HostEventTopic } from "../ports";
import { syncProjectRoots } from "../project-roots";
import { BATCH_MAX_CHARS } from "./output";
import { PtyManager, type PtyHost, type PtyManagerOptions } from "./manager";
import { parkConfigFromEnv } from "./park";

// Construction stays one options object whose first four fields are required
// (VC-627). These checks run in the package typecheck.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type RequiredOptionKeys = {
  [K in keyof PtyManagerOptions]-?: {} extends Pick<PtyManagerOptions, K> ? never : K;
}[keyof PtyManagerOptions];
const requiredOptionKeys: Equal<RequiredOptionKeys, "host" | "db" | "dbError" | "sessionEngine"> =
  true;
const engineStaysNullable: Equal<PtyManagerOptions["sessionEngine"], SessionEngine | null> = true;
const oneOptionsObject: Equal<ConstructorParameters<typeof PtyManager>, [PtyManagerOptions]> = true;

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn }));

let nextPid = 7000;
function makeFakePty() {
  let dataListener: ((data: string) => void) | undefined;
  nextPid += 1;
  return {
    pid: nextPid,
    process: "sh",
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
    },
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData: (data: string) => dataListener?.(data),
  };
}

function makeClient(id: string) {
  const events: Array<{ topic: HostEventTopic; payload: unknown }> = [];
  const closeListeners = new Set<() => void>();
  let closed = false;
  const sink: HostClientEventSink = {
    id,
    isClosed: () => closed,
    onceClosed: (listener) => {
      closeListeners.add(listener);
    },
    removeCloseListener: (listener) => {
      closeListeners.delete(listener);
    },
    publish<T extends HostEventTopic>(topic: T, payload: HostEventMap[T]) {
      events.push({ topic, payload });
    },
  };
  return {
    sink,
    events,
    data: () =>
      events
        .filter((event) => event.topic === "terminal-data")
        .map((event) => (event.payload as TerminalDataEvent).data),
    disconnect() {
      closed = true;
      for (const listener of closeListeners) {
        closeListeners.delete(listener);
        listener();
      }
    },
    hooks: () => closeListeners.size,
  };
}

let testDb: TestDb;
let root: string;
let manager: PtyManager;

beforeEach(async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  testDb = openTestDb();
  root = await realpath(mkdtempSync(join(tmpdir(), "volli-pty-stream-")));
  insertProject(testDb.db, testProject({ id: "w", path: root }));
  syncProjectRoots([root]);
  const host: PtyHost = {
    events: { publish: () => {} },
    worktreeDeps: () => {
      throw new Error("a Board Session never asks for a worktree");
    },
    ensureHarnessWorkspaceFiles: async () => ({ refused: [] }),
  };
  manager = new PtyManager({
    host,
    db: testDb.db,
    dbError: "",
    sessionEngine: createTestSessionEngine(testDb.db),
    parkConfig: parkConfigFromEnv({ VOLLI_PARK_DISABLE: "1" }, process.platform),
  });
});

afterEach(() => {
  syncProjectRoots([]);
  testDb.cleanup();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  spawn.mockReset();
});

async function start(client: ReturnType<typeof makeClient>, onDisconnect?: "close" | "detach") {
  const pty = makeFakePty();
  spawn.mockReturnValueOnce(pty);
  const created = await manager.create(
    client.sink,
    { workspaceId: "w", cwd: root, cols: 80, rows: 24 },
    onDisconnect,
  );
  if (!created.ok) throw new Error(created.error);
  return { sessionId: created.sessionId, pty };
}

const SIZE = { cols: 120, rows: 40, onDisconnect: "detach" } as const;

describe("attach (VC-560)", () => {
  it("refuses an unknown session", () => {
    expect(manager.attach(makeClient("c").sink, "nope", SIZE)).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it("refuses a session another client holds, leaving the holder's stream untouched", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);

    expect(manager.attach(makeClient("other").sink, sessionId, SIZE)).toEqual({
      ok: false,
      error: "Terminal is attached to another client",
    });
    expect(pty.resize).not.toHaveBeenCalled();
    expect(manager.write(holder.sink, sessionId, "x")).toEqual({ ok: true });
  });

  it("refuses a client that disconnected before it could attach", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);
    manager.detach(holder.sink, sessionId);

    const gone = makeClient("gone");
    gone.disconnect();
    expect(manager.attach(gone.sink, sessionId, SIZE)).toEqual({
      ok: false,
      error: "Client disconnected before the terminal could attach",
    });
    expect(pty.resize).not.toHaveBeenCalled();
    expect(gone.hooks()).toBe(0);
  });

  it("refuses when the PTY cannot take the client's size, and stays detached", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);
    manager.detach(holder.sink, sessionId);
    pty.resize.mockImplementationOnce(() => {
      throw new Error("ioctl failed");
    });

    const next = makeClient("next");
    expect(manager.attach(next.sink, sessionId, SIZE)).toEqual({
      ok: false,
      error: "ioctl failed",
    });
    expect(next.hooks()).toBe(0);
    expect(manager.write(next.sink, sessionId, "x")).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it("lets the holder attach again as a fresh attachment with a resync, never re-running input", async () => {
    vi.useFakeTimers();
    try {
      const holder = makeClient("holder");
      const { sessionId, pty } = await start(holder);
      pty.emitData("hello ");
      vi.advanceTimersByTime(8);
      pty.write.mockClear();

      expect(manager.attach(holder.sink, sessionId, SIZE)).toEqual({ ok: true });
      expect(pty.resize).toHaveBeenCalledWith(120, 40);
      expect(holder.data()).toEqual(["hello ", "hello "]);
      // Still exactly one close hook: the first attachment's was removed.
      expect(holder.hooks()).toBe(1);
      expect(pty.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("detach (VC-560)", () => {
  it("is owner-only, answering a stranger as it answers an unknown id", async () => {
    const holder = makeClient("holder");
    const { sessionId } = await start(holder);
    const refusal = { ok: false, error: "Unknown terminal session" };
    expect(manager.detach(makeClient("stranger").sink, sessionId)).toEqual(refusal);
    expect(manager.detach(holder.sink, "nope")).toEqual(refusal);
  });

  it("delivers the pending batch, then releases the pty a departed client held paused", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);
    // A full batch flushes at once, putting the client over the high watermark.
    pty.emitData("x".repeat(BATCH_MAX_CHARS));
    pty.emitData("tail");
    // Over the high watermark and never acked: the client is holding the pty.
    expect(pty.pause).toHaveBeenCalledOnce();

    expect(manager.detach(holder.sink, sessionId)).toEqual({ ok: true });
    expect(holder.data().at(-1)).toBe("tail");
    expect(pty.resume).toHaveBeenCalledOnce();
    expect(holder.hooks()).toBe(0);
  });

  it("sends nothing while detached, and the next attach resyncs what it missed", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);
    manager.detach(holder.sink, sessionId);
    pty.emitData("unseen");

    const next = makeClient("next");
    manager.attach(next.sink, sessionId, SIZE);
    expect(holder.data()).not.toContain("unseen");
    expect(next.data()).toEqual(["unseen"]);
  });

  it("leaves a later holder alone when an earlier client's connection drops", async () => {
    const first = makeClient("first");
    const { sessionId } = await start(first, "close");
    manager.detach(first.sink, sessionId);
    const second = makeClient("second");
    manager.attach(second.sink, sessionId, SIZE);

    // The first client's hook was removed on detach: its disconnect kills nothing.
    first.disconnect();
    expect(manager.write(second.sink, sessionId, "x")).toEqual({ ok: true });

    // The second's policy is detach: dropping leaves the terminal for a third.
    second.disconnect();
    expect(manager.peek(sessionId, 1)).toBeDefined();
    expect(manager.attach(makeClient("third").sink, sessionId, SIZE)).toEqual({ ok: true });
  });
});

describe("a stale disconnect hook (VC-560)", () => {
  it("cannot close a terminal another client attached to after its own detach", async () => {
    const first = makeClient("first");
    const { sessionId, pty } = await start(first, "close");
    // Capture the hook as an emitter would have already queued it.
    let queued: (() => void) | undefined;
    const register = first.sink.onceClosed.bind(first.sink);
    first.sink.onceClosed = (listener) => {
      queued = listener;
      register(listener);
    };
    manager.detach(first.sink, sessionId);
    manager.attach(first.sink, sessionId, { ...SIZE, onDisconnect: "close" });
    const firstHook = queued;
    manager.detach(first.sink, sessionId);
    const second = makeClient("second");
    manager.attach(second.sink, sessionId, SIZE);

    firstHook?.();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(manager.write(second.sink, sessionId, "x")).toEqual({ ok: true });
  });
});

describe("ownership by client id (VC-509, VC-560)", () => {
  it("filters busy sessions by the caller's id, and leaves a detached one to the whole-host gate", async () => {
    const holder = makeClient("holder");
    const { sessionId, pty } = await start(holder);
    pty.process = "node";

    expect(manager.busySessions({ id: "holder" })).toEqual([{ sessionId, process: "node" }]);
    expect(manager.busySessions({ id: "other" })).toEqual([]);
    manager.detach(holder.sink, sessionId);
    expect(manager.busySessions({ id: "holder" })).toEqual([]);
    expect(manager.busySessions()).toEqual([{ sessionId, process: "node" }]);
  });
});

describe("construction options (VC-627)", () => {
  it("keeps the type-level construction shape", () => {
    expect([requiredOptionKeys, engineStaysNullable, oneOptionsObject]).toEqual([true, true, true]);
  });

  it("builds a degraded supervisor from the four required fields alone", async () => {
    const degraded = new PtyManager({
      host: {
        events: { publish: () => {} },
        worktreeDeps: () => {
          throw new Error("a degraded supervisor never asks for a worktree");
        },
        ensureHarnessWorkspaceFiles: async () => ({ refused: [] }),
      },
      db: null,
      dbError: "database failed to open",
      sessionEngine: null,
    });
    expect(
      await degraded.create(makeClient("d").sink, {
        workspaceId: "w",
        cwd: root,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ ok: false, error: "database failed to open" });
    expect(spawn).not.toHaveBeenCalled();
  });

  async function venueOf(
    hostVenue: SessionExecutionVenue | undefined,
    venue?: SessionExecutionVenue,
  ) {
    const host: PtyHost = {
      ...(hostVenue === undefined ? {} : { venue: hostVenue }),
      events: { publish: () => {} },
      worktreeDeps: () => {
        throw new Error("a Board Session never asks for a worktree");
      },
      ensureHarnessWorkspaceFiles: async () => ({ refused: [] }),
    };
    const engine = createTestSessionEngine(testDb.db);
    const built = new PtyManager({
      host,
      db: testDb.db,
      dbError: "",
      sessionEngine: engine,
      parkConfig: parkConfigFromEnv({ VOLLI_PARK_DISABLE: "1" }, process.platform),
      ...(venue === undefined ? {} : { venue }),
    });
    spawn.mockReturnValueOnce(makeFakePty());
    const created = await built.create(makeClient("v").sink, {
      workspaceId: "w",
      cwd: root,
      cols: 80,
      rows: 24,
    });
    if (!created.ok) throw new Error(created.error);
    const projection = await engine.getSession({ sessionId: created.sessionId });
    const events = await engine.listEvents({ sessionId: created.sessionId });
    built.killAll();
    return {
      attachment: projection!.attachments[0]!.venue,
      events: [...new Set(events.map((event) => event.provenance.venue?.id))],
    };
  }

  it("records an explicit venue option over the host's", async () => {
    expect(await venueOf({ id: "host", kind: "remote" }, { id: "option", kind: "remote" })).toEqual(
      { attachment: { id: "option", kind: "remote" }, events: ["option"] },
    );
  });

  it("falls back to the host's venue, then to local", async () => {
    expect(await venueOf({ id: "host", kind: "remote" })).toEqual({
      attachment: { id: "host", kind: "remote" },
      events: ["host"],
    });
    expect(await venueOf(undefined)).toEqual({
      attachment: { id: "local", kind: "local" },
      events: ["local"],
    });
  });
});
