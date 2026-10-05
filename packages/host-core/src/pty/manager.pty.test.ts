import { createTestSessionEngine } from "../testing/session-engine";
/**
 * The terminal supervisor against a REAL node-pty under plain Node (VC-560).
 *
 * This is the file that proves the supervisor runs without Electron: CI's
 * Linux `Test (packages)` lane loads node-pty's Node build here and drives a
 * real shell through the stream contract in the README — create, detach
 * without killing, attach with a resync, resize ownership, no input replay,
 * and explicit close vs a disconnect's close-or-detach policy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpawnLedgerPort, TerminalDataEvent } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import type { HostClientEventSink, HostEventMap, HostEventTopic } from "../ports";
import { syncProjectRoots } from "../project-roots";
import { worktreeDeps } from "../worktree-runtime";
import { PtyManager, type PtyHost } from "./manager";
import { parkConfigFromEnv } from "./park";

/** A client connection: what it was sent, and a disconnect the test pulls. */
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
    /** Everything this client was sent on its terminal stream, joined. */
    output: () =>
      events
        .filter((event) => event.topic === "terminal-data")
        .map((event) => (event.payload as TerminalDataEvent).data)
        .join(""),
    disconnect() {
      closed = true;
      for (const listener of closeListeners) {
        closeListeners.delete(listener);
        listener();
      }
    },
    hasCloseHook: () => closeListeners.size > 0,
  };
}

/** Waits for `predicate`, polling; a real shell answers in milliseconds, CI in more. */
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** A ledger that remembers each shell's pid and when the supervisor saw it exit. */
function makeLedger() {
  const pids: number[] = [];
  const exited = new Set<number>();
  const ledger: SpawnLedgerPort = {
    recordSpawn: (row) => {
      pids.push(row.pid);
      return String(pids.length - 1);
    },
    markExited: (id) => {
      exited.add(Number(id));
    },
  };
  return { ledger, pids, exited };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let testDb: TestDb;
let root: string;
let dataDir: string;
let manager: PtyManager;
let ledger: ReturnType<typeof makeLedger>;

beforeEach(async () => {
  // A plain POSIX login shell, so the assertions do not depend on the
  // machine's own zsh or bash configuration.
  vi.stubEnv("SHELL", "/bin/sh");
  vi.stubEnv("PS1", "$ ");
  testDb = openTestDb();
  root = await realpath(mkdtempSync(join(tmpdir(), "volli-pty-node-")));
  dataDir = mkdtempSync(join(tmpdir(), "volli-pty-data-"));
  insertProject(testDb.db, testProject({ id: "w", path: root }));
  syncProjectRoots([root]);
  ledger = makeLedger();
  const events = { publish: () => {} };
  const host: PtyHost = {
    events,
    worktreeDeps: (db) => worktreeDeps(db, { events }, { dataDir }),
    ensureHarnessWorkspaceFiles: async () => ({ refused: [] }),
  };
  manager = new PtyManager(
    host,
    testDb.db,
    "",
    createTestSessionEngine(testDb.db),
    undefined,
    parkConfigFromEnv({ VOLLI_PARK_DISABLE: "1" }, process.platform),
    null,
    "",
    ledger.ledger,
  );
});

afterEach(async () => {
  manager.killAll();
  // Let every shell's exit reach the ledger before the database closes under it.
  await until(() => ledger.exited.size === ledger.pids.length, "every shell to exit");
  await new Promise((done) => setTimeout(done, 50));
  syncProjectRoots([]);
  testDb.cleanup();
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start(client: ReturnType<typeof makeClient>, onDisconnect?: "close" | "detach") {
  const created = await manager.create(
    client.sink,
    { workspaceId: "w", cwd: root, cols: 80, rows: 24 },
    onDisconnect,
  );
  if (!created.ok) throw new Error(created.error);
  return created.sessionId;
}

describe("terminal supervisor on node-pty under plain Node (VC-560)", () => {
  it("detaches without killing, and an attach resyncs the retained output without replaying input", async () => {
    const first = makeClient("first");
    const sessionId = await start(first);
    const pid = ledger.pids[0];
    if (pid === undefined) throw new Error("no shell was recorded");

    // `$((…))` makes the output differ from the echoed input line.
    expect(
      manager.write(first.sink, sessionId, "echo first-$((1+1)); sleep 0.5; echo later-$((2+2))\r"),
    ).toEqual({ ok: true });
    await until(() => first.output().includes("first-2"), "the first command's output");

    expect(manager.detach(first.sink, sessionId)).toEqual({ ok: true });
    expect(first.hasCloseHook()).toBe(false);
    // Detached: nobody owns it, and the process is running.
    expect(manager.write(first.sink, sessionId, "echo nope\r")).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
    expect(isAlive(pid)).toBe(true);

    // Output produced while detached lands in the retained tail, not with the old client.
    await until(
      () => manager.peek(sessionId, 50)?.output.includes("later-4") === true,
      "output produced while detached",
    );
    expect(first.output()).not.toContain("later-4");

    const second = makeClient("second");
    expect(
      manager.attach(second.sink, sessionId, { cols: 100, rows: 30, onDisconnect: "detach" }),
    ).toEqual({ ok: true });
    // The attachment opens with the resync: one batch holding both commands' output.
    const opening = second.events[0];
    expect(opening?.topic).toBe("terminal-data");
    const resync = (opening?.payload as TerminalDataEvent | undefined)?.data ?? "";
    expect(resync).toContain("first-2");
    expect(resync).toContain("later-4");
    expect(second.events[1]).toEqual({
      topic: "terminal-park-state",
      payload: { sessionId, parked: false, keepAwake: false },
    });

    // The attaching client's size is the PTY's now.
    expect(manager.write(second.sink, sessionId, "stty size; echo done-$((3+3))\r")).toEqual({
      ok: true,
    });
    await until(() => second.output().includes("done-6"), "the second client's command");
    expect(second.output()).toContain("30 100");
    // Nothing was replayed into the shell: the first command ran exactly once.
    const tail = manager.peek(sessionId, 200)?.output ?? "";
    expect(tail.split("first-2").length - 1).toBe(1);
  });

  it("keeps a detach-policy client's terminal running across its disconnect", async () => {
    const owner = makeClient("owner");
    const sessionId = await start(owner, "detach");
    const pid = ledger.pids[0] ?? -1;

    owner.disconnect();
    expect(manager.peek(sessionId, 1)).toBeDefined();
    expect(isAlive(pid)).toBe(true);

    // The next client can take it, and an explicit close kills it.
    const next = makeClient("next");
    expect(
      manager.attach(next.sink, sessionId, { cols: 80, rows: 24, onDisconnect: "close" }),
    ).toEqual({ ok: true });
    expect(manager.kill(next.sink, sessionId)).toEqual({ ok: true });
    await until(() => ledger.exited.has(0), "the shell to exit after an explicit close");
    expect(manager.peek(sessionId, 1)).toBeUndefined();
  });

  it("kills a close-policy client's terminal when it disconnects, as a desktop window's", async () => {
    const window = makeClient("window");
    const sessionId = await start(window);

    window.disconnect();
    expect(manager.peek(sessionId, 1)).toBeUndefined();
    await until(() => ledger.exited.has(0), "the shell to exit after its window closed");
  });

  it("delivers a large final output and UTF-8 tail before exit", async () => {
    const owner = makeClient("owner");
    const sessionId = await start(owner);
    const publish = owner.sink.publish.bind(owner.sink);
    owner.sink.publish = (topic, payload) => {
      publish(topic, payload);
      if (topic === "terminal-data") {
        const data = payload as TerminalDataEvent;
        // Model a consuming client, after the pipeline has accounted its send.
        queueMicrotask(() => manager.ack(owner.sink, sessionId, data.data.length));
      }
    };
    manager.write(
      owner.sink,
      sessionId,
      "printf '%0200000d' 0; printf '\\342\\230\\203-%s\\n' $((4+4)); exit 3\r",
    );
    await until(
      () => owner.events.some((event) => event.topic === "terminal-exit"),
      "the exit event",
    );
    const exitIndex = owner.events.findIndex((event) => event.topic === "terminal-exit");
    const output = owner.events
      .slice(0, exitIndex)
      .filter((event) => event.topic === "terminal-data")
      .map((event) => (event.payload as TerminalDataEvent).data)
      .join("");
    expect(output).toContain("0".repeat(200_000));
    expect(output).toContain("☃-8");
    expect(owner.events[exitIndex]?.payload).toEqual({ sessionId, exitCode: 3 });
    expect(owner.events.slice(exitIndex + 1).some((event) => event.topic === "terminal-data")).toBe(
      false,
    );
  });

  it("delivers the shell's exit to the attached client after its final output", async () => {
    const owner = makeClient("owner");
    const sessionId = await start(owner);
    manager.write(owner.sink, sessionId, "echo bye-$((4+4)); exit 3\r");

    await until(
      () => owner.events.some((event) => event.topic === "terminal-exit"),
      "the exit event",
    );
    const exitIndex = owner.events.findIndex((event) => event.topic === "terminal-exit");
    expect(owner.events[exitIndex]?.payload).toEqual({ sessionId, exitCode: 3 });
    expect(
      owner.events
        .slice(0, exitIndex)
        .filter((event) => event.topic === "terminal-data")
        .map((event) => (event.payload as TerminalDataEvent).data)
        .join(""),
    ).toContain("bye-8");
    expect(owner.hasCloseHook()).toBe(false);
  });
});
